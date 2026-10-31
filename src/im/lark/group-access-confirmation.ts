import { randomUUID } from 'node:crypto';
import { getBot, getOwnerOpenId, findOncallChat } from '../../bot-registry.js';
import { config } from '../../config.js';
import { addAllowedChatGroup } from '../../services/grant-store.js';
import { GroupAccessRequestStore, type GroupAccessRequest } from '../../services/group-access-request-store.js';
import { isInChat } from '../../services/groups-store.js';
import { getChatName, sendUserMessage } from './client.js';
import { isBotAdmin } from './grant-owner.js';
import { logger } from '../../utils/logger.js';

const DENY_COOLDOWN_MS = 10 * 60_000;
export const GROUP_ACCESS_APPROVE = 'group_access_approve';
export const GROUP_ACCESS_DENY = 'group_access_deny';
const escape = (value: string) => value.replace(/[&<>*_~`\[\]\\]/g, c => `&#${c.charCodeAt(0)};`);
const store = () => new GroupAccessRequestStore(config.session.dataDir);
const groupOpen = (appId: string, chatId: string) =>
  getBot(appId).config.allowedChatGroups?.includes(chatId) === true || !!findOncallChat(appId, chatId);

/** Blue decision card, one primary action, explicit durable group scope. */
export function buildGroupAccessCard(request: GroupAccessRequest, outcome?: 'approved' | 'denied'): string {
  const approved = outcome === 'approved';
  const title = outcome ? (approved ? '已开放全群使用' : '暂不开放全群') : '是否开放全群使用？';
  const color = outcome ? (approved ? 'green' : 'grey') : 'blue';
  const button = (action: string, label: string, primary: boolean) => ({
    tag: 'button', text: { tag: 'plain_text', content: label },
    type: primary ? 'primary_filled' : 'default', width: 'fill',
    behaviors: [{ type: 'callback', value: { action, chat_id: request.chatId, nonce: request.nonce } }],
  });
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true, enable_forward: false, width_mode: 'default' },
    header: { template: color, title: { tag: 'plain_text', content: title },
      subtitle: { tag: 'plain_text', content: request.reason === 'joined' ? '我已加入这个群' : '群内有人 @ 我请求使用' },
      icon: { tag: 'standard_icon', token: 'chat_outlined' } },
    body: { direction: 'vertical', padding: '12px', vertical_spacing: 'large', elements: [
      { tag: 'markdown', content: `**${escape(request.chatName)}**` },
      { tag: 'column_set', flex_mode: 'none', background_style: 'grey-50', padding: '12px', columns: [
        { tag: 'column', width: 'weighted', weight: 1, elements: [
          { tag: 'markdown', content: outcome === 'denied' ? '当前群保持原有授权范围。' : '使用范围：此群所有成员\n授权时效：长期有效，不限对话次数\n管理权限：仍由你和已有管理员持有' },
        ] },
      ] },
      ...(!outcome ? [{ tag: 'column_set', flex_mode: 'none', horizontal_spacing: 'medium', columns: [
        { tag: 'column', width: 'weighted', weight: 1, elements: [button(GROUP_ACCESS_APPROVE, '确认开放全群', true)] },
        { tag: 'column', width: 'weighted', weight: 1, elements: [button(GROUP_ACCESS_DENY, '暂不开放', false)] },
      ] }] : []),
      { tag: 'markdown', text_size: 'notation', content: outcome ? '本次确认已处理。' : '仅你可以确认；这张卡片长期有效，直到你处理。' },
    ] },
  });
}

/** Invoked only by the bot-added event or a rejected, explicitly addressed human group message. */
export async function requestGroupAccessConfirmation(
  appId: string, chatId: string, reason: 'joined' | 'mention', messageData?: unknown,
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
    let request = old?.state === 'pending' && old.ownerOpenId === owner ? old : undefined;
    if (!request) {
      request = { version: 1, appId, chatId, ownerOpenId: owner, nonce: randomUUID(),
        chatName: await getChatName(appId, chatId) ?? '新群聊', reason, state: 'pending', createdAt: Date.now() };
    }
    if (reason === 'mention' && request.messageData === undefined) request.messageData = messageData;
    // Persist before sending; retry an uncertain send with the same provider UUID.
    save(request);
    if (request.messageId) return;
    request.messageId = await sendUserMessage(appId, owner, buildGroupAccessCard(request), 'interactive', request.nonce);
    save(request);
    logger.info(`[group-access:${appId}] confirmation delivered privately for ${chatId}`);
  });
}

export function isGroupAccessAction(action: unknown): boolean {
  return action === GROUP_ACCESS_APPROVE || action === GROUP_ACCESS_DENY;
}

/** Card scope comes from the durable record, never a client-supplied target list. */
export async function handleGroupAccessAction(
  appId: string, value: { action?: unknown; chat_id?: unknown; nonce?: unknown },
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
      if (request.state === 'approved' && !groupOpen(appId, request.chatId)) return error('该群授权已撤销，请使用新的确认卡。');
      return JSON.parse(buildGroupAccessCard(request, request.state));
    }
    if (value.action === GROUP_ACCESS_DENY) {
      if (request.state === 'approving') return error('授权正在提交，请稍后确认结果。');
      request.state = 'denied'; request.decidedAt = Date.now(); delete request.messageData; save(request);
      return JSON.parse(buildGroupAccessCard(request, 'denied'));
    }
    if (!(await isInChat(appId, request.chatId))) return error('我已不在这个群中，未开放权限。');
    if (getOwnerOpenId(appId) !== owner || !isBotAdmin(appId, operatorOpenId)
      || getBot(appId).config.groupAccessConfirmation !== true) return error('授权配置已变化，未开放权限。');
    // Serialize approve/deny and survive a crash between the idempotent grant and receipt.
    request.state = 'approving'; save(request);
    const grant = await addAllowedChatGroup(appId, request.chatId);
    if (!grant.ok) { request.state = 'pending'; save(request); return error('授权保存失败，请稍后点击原卡重试。'); }
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
