import { randomUUID } from 'node:crypto';
import { getBot, getOwnerOpenId, findOncallChat } from '../../bot-registry.js';
import { config } from '../../config.js';
import { addAllowedChatGroup, addChatGrant, chatQuotaKey } from '../../services/grant-store.js';
import { GroupAccessRequestStore, type GroupAccessRequest } from '../../services/group-access-request-store.js';
import { isInChat } from '../../services/groups-store.js';
import { getChatName, getUserProfile, sendUserMessage, updateMessage } from './client.js';
import { chatAppLink, normalizeBrand } from './lark-hosts.js';
import { isBotAdmin } from './grant-owner.js';
import { logger } from '../../utils/logger.js';

const DENY_COOLDOWN_MS = 10 * 60_000;
export const GROUP_ACCESS_APPROVE = 'group_access_approve';
export const GROUP_ACCESS_DENY = 'group_access_deny';
export const GROUP_ACCESS_APPROVE_PERSON = 'group_access_approve_person';
const escape = (value: string) => value.replace(/[&<>*_~`\[\]\\]/g, c => `&#${c.charCodeAt(0)};`);
const store = () => new GroupAccessRequestStore(config.session.dataDir);
const groupOpen = (appId: string, chatId: string) =>
  getBot(appId).config.allowedChatGroups?.includes(chatId) === true || !!findOncallChat(appId, chatId);
const personGrantActive = (request: GroupAccessRequest) => {
  const c = getBot(request.appId).config, id = request.requester?.openId;
  if (!id || !c.chatGrants?.[request.chatId]?.includes(id)) return false;
  const key = chatQuotaKey(request.chatId, id), expiry = c.grantExpiryState?.[key]?.expiresAt;
  const quota = c.quotaState?.[key];
  return (expiry === undefined || expiry > Date.now()) && (!quota || quota.used < quota.limit);
};

function humanRequester(data: any, chatId: string): { openId: string; name?: string; messageId: string } | undefined {
  const event = data?.event ?? data, message = event?.message, sender = event?.sender;
  const openId = sender?.sender_id?.open_id;
  if (sender?.sender_type !== 'user' || typeof openId !== 'string' || !/^ou_[\w-]+$/.test(openId)
    || message?.chat_id !== chatId || typeof message?.message_id !== 'string') return;
  const mentionName = message.mentions?.find((m: any) => (m.id?.open_id ?? m.id) === openId)?.name;
  return { openId, messageId: message.message_id, name: sender.name ?? sender.sender_name ?? mentionName };
}

/** Blue decision card, one primary action, explicit durable group scope. */
export function buildGroupAccessCard(request: GroupAccessRequest, outcome?: 'approved' | 'denied'): string {
  const approved = outcome === 'approved';
  const person = request.approvalScope === 'person';
  const title = outcome ? (approved ? (person ? '已开放给此人' : '已开放全群使用') : '暂不开放') : '确认使用授权';
  const color = outcome ? (approved ? 'green' : 'grey') : 'blue';
  const button = (action: string, label: string, primary: boolean) => ({
    tag: 'button', text: { tag: 'plain_text', content: label },
    type: primary ? 'primary_filled' : 'default', width: 'fill',
    behaviors: [{ type: 'callback', value: { action, chat_id: request.chatId, nonce: request.nonce,
      ...(action === GROUP_ACCESS_APPROVE_PERSON ? { requester_open_id: request.requester!.openId } : {}) } }],
  });
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true, enable_forward: false, width_mode: 'default' },
    header: { template: color, title: { tag: 'plain_text', content: title },
      subtitle: { tag: 'plain_text', content: request.reason === 'joined' ? '我已加入这个群' : '群内有人 @ 我请求使用' },
      icon: { tag: 'standard_icon', token: 'chat_outlined' } },
    body: { direction: 'vertical', padding: '12px', vertical_spacing: 'large', elements: [
      { tag: 'markdown', content: `**[${escape(request.chatName)}](${chatAppLink(request.chatId, normalizeBrand(getBot(request.appId).config.brand))})**` },
      { tag: 'column_set', flex_mode: 'none', background_style: 'grey-50', columns: [
        { tag: 'column', width: 'weighted', weight: 1, padding: '12px', elements: [
          ...(request.requester ? [{ tag: 'markdown', content: '触发 @ 的人' },
            { tag: 'person', user_id: request.requester.openId, show_name: true, show_avatar: true, size: 'small' }] : []),
          { tag: 'markdown', content: outcome === 'denied' ? '当前群保持原有授权范围。' :
            `使用范围：${approved ? (person ? `仅${escape(request.requester?.name ?? '此人')}在本群使用` : '此群所有成员') : (request.requester ? '请选择仅此人或全群' : '此群所有成员')}\n授权时效：长期有效，不限对话次数\n管理权限：仍由你和已有管理员持有` },
        ] },
      ] },
      ...(!outcome ? [{ tag: 'column_set', flex_mode: 'none', horizontal_spacing: 'medium', columns: [
        ...(request.requester ? [{ tag: 'column', width: 'weighted', weight: 1,
          elements: [button(GROUP_ACCESS_APPROVE_PERSON, '仅开放给此人', true)] }] : []),
        { tag: 'column', width: 'weighted', weight: 1, elements: [button(GROUP_ACCESS_APPROVE, '确认开放全群', !request.requester)] },
        { tag: 'column', width: 'weighted', weight: 1, elements: [button(GROUP_ACCESS_DENY, '暂不开放', false)] },
      ] }] : []),
      { tag: 'markdown', text_size: 'notation', content: outcome ? '本次确认已处理。' : '仅你可以确认；这张卡片长期有效，直到你处理。' },
    ] },
  });
}

/** Invoked only by the bot-added event or a rejected, explicitly addressed human group message. */
export async function requestGroupAccessConfirmation(
  appId: string, chatId: string, reason: 'joined' | 'mention', messageData?: unknown,
  options?: { replay?: boolean; refreshCard?: boolean },
): Promise<void> {
  if (getBot(appId).config.groupAccessConfirmation !== true || groupOpen(appId, chatId)) return;
  const owner = getOwnerOpenId(appId);
  if (!owner || !isBotAdmin(appId, owner)) {
    logger.warn(`[group-access:${appId}] owner unavailable; no group fallback`);
    return;
  }
  await store().transact(appId, chatId, async (old, save) => {
    if (groupOpen(appId, chatId)) return;
    if (old?.state === 'approving') return;
    if (old?.state === 'denied' && Date.now() - (old.decidedAt ?? old.createdAt) < DENY_COOLDOWN_MS) return;
    const incoming = humanRequester(messageData, chatId);
    if (old?.state === 'approved' && old.approvalScope === 'person'
      && incoming?.openId === old.requester?.openId && personGrantActive(old)) return;
    let request = old?.state === 'pending' && old.ownerOpenId === owner ? old : undefined;
    if (!request) {
      request = { version: 1, appId, chatId, ownerOpenId: owner, nonce: randomUUID(),
        chatName: await getChatName(appId, chatId) ?? '新群聊', reason, state: 'pending', createdAt: Date.now() };
    }
    if (reason === 'mention') {
      // Keep the first waiting applicant fixed. An earlier owner/join card can
      // acquire its first unauthorised applicant without replaying owner work.
      if (!request.requester || (request.messageData === undefined && options?.replay !== false)) {
        const candidate = humanRequester(request.messageData, chatId) ?? incoming;
        if (candidate && candidate.openId !== request.requester?.openId) {
          const profile = await getUserProfile(appId, candidate.openId).catch(() => null);
          request.requester = { ...candidate, name: profile?.name ?? candidate.name ?? '此人' };
        }
      }
      if (request.messageData === undefined && options?.replay !== false) request.messageData = messageData;
    }
    // Persist before sending; retry an uncertain send with the same provider UUID.
    save(request);
    if (request.messageId) {
      const card = buildGroupAccessCard(request);
      if (options?.refreshCard || request.requester?.openId !== request.deliveredRequesterOpenId) {
        await updateMessage(appId, request.messageId, card);
        request.deliveredRequesterOpenId = request.requester?.openId; save(request);
      }
      return;
    }
    request.messageId = await sendUserMessage(appId, owner, buildGroupAccessCard(request), 'interactive', request.nonce);
    request.deliveredRequesterOpenId = request.requester?.openId;
    save(request);
    logger.info(`[group-access:${appId}] confirmation delivered privately for ${chatId}`);
  });
}

export function isGroupAccessAction(action: unknown): boolean {
  return action === GROUP_ACCESS_APPROVE || action === GROUP_ACCESS_DENY || action === GROUP_ACCESS_APPROVE_PERSON;
}

/** Card scope comes from the durable record, never a client-supplied target list. */
export async function handleGroupAccessAction(
  appId: string, value: { action?: unknown; chat_id?: unknown; nonce?: unknown; requester_open_id?: unknown },
  operatorOpenId: string | undefined, cardMessageId: string | undefined,
  replay?: (data: any, appId: string) => void | Promise<void>,
): Promise<any> {
  const error = (content: string) => ({ toast: { type: 'error', content } });
  if (getBot(appId).config.groupAccessConfirmation !== true) return error('全群确认策略已关闭。');
  const owner = getOwnerOpenId(appId);
  if (!operatorOpenId || operatorOpenId !== owner || !isBotAdmin(appId, operatorOpenId)) return error('仅你可以处理这张确认卡。');
  if (typeof value.chat_id !== 'string' || !/^oc_[\w-]+$/.test(value.chat_id)
    || typeof value.nonce !== 'string' || !cardMessageId || !isGroupAccessAction(value.action)) return error('确认卡无效。');
  let pendingReplay: unknown;
  const result = await store().transact(appId, value.chat_id, async (request, save) => {
    if (!request || request.nonce !== value.nonce || request.ownerOpenId !== owner || request.messageId !== cardMessageId) return error('确认卡已失效或不属于当前群。');
    if (request.state === 'approved' || request.state === 'denied') {
      if (request.state === 'approved' && !(request.approvalScope === 'person' ? personGrantActive(request) : groupOpen(appId, request.chatId))) return error('该授权已撤销，请使用新的确认卡。');
      return JSON.parse(buildGroupAccessCard(request, request.state));
    }
    if (value.action === GROUP_ACCESS_DENY) {
      if (request.state === 'approving') return error('授权正在提交，请稍后确认结果。');
      request.state = 'denied'; request.decidedAt = Date.now(); delete request.messageData; save(request);
      return JSON.parse(buildGroupAccessCard(request, 'denied'));
    }
    if (!(await isInChat(appId, request.chatId))) return error('我已不在这个群中，未开放权限。');
    const scope = value.action === GROUP_ACCESS_APPROVE_PERSON ? 'person' : 'group';
    if (scope === 'person' && (!request.requester || value.requester_open_id !== request.requester.openId
      || getBot(appId).resolvedBlockedUsers.includes(request.requester.openId))) return error('申请人已变化或不可授权，请使用最新确认卡。');
    if (request.state === 'approving' && (request.approvalScope ?? 'group') !== scope) return error('另一种授权正在提交，请稍后确认结果。');
    if (getOwnerOpenId(appId) !== owner || !isBotAdmin(appId, operatorOpenId)
      || getBot(appId).config.groupAccessConfirmation !== true) return error('授权配置已变化，未开放权限。');
    // Serialize approve/deny and survive a crash between the idempotent grant and receipt.
    request.state = 'approving'; request.approvalScope = scope; save(request);
    const grant = scope === 'person'
      ? await addChatGrant(appId, request.chatId, request.requester!.openId)
      : await addAllowedChatGroup(appId, request.chatId);
    if (!grant.ok) { request.state = 'pending'; delete request.approvalScope; save(request); return error('授权保存失败，请稍后点击原卡重试。'); }
    request.state = 'approved'; request.decidedAt = Date.now();
    if (request.messageData !== undefined && !request.replayClaimed) {
      pendingReplay = request.messageData; request.replayClaimed = true;
    }
    delete request.messageData; save(request);
    return JSON.parse(buildGroupAccessCard(request, 'approved'));
  });
  if (pendingReplay !== undefined && replay) {
    void Promise.resolve().then(() => replay(pendingReplay, appId))
      .catch(err => logger.warn(`[group-access:${appId}] original request replay failed: ${String(err)}`));
  }
  return result;
}
