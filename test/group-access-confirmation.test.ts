import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;
vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class {} }));
vi.mock('../src/config.js', async original => {
  const actual = await original<typeof import('../src/config.js')>();
  return { ...actual, config: { ...actual.config, session: {
    ...actual.config.session, get dataDir() { return tempDir; },
  } } };
});
vi.mock('../src/im/lark/client.js', async original => {
  const actual = await original<typeof import('../src/im/lark/client.js')>();
  return { ...actual, sendUserMessage: vi.fn(async () => 'om_private_card'),
    getUserProfile: vi.fn(async () => ({ name: '申请人' })), updateMessage: vi.fn(async () => undefined),
    getChatName: vi.fn(async () => '测试协作群'), replyMessage: vi.fn(async () => 'om_public'),
    sendMessage: vi.fn(async () => 'om_public') };
});
vi.mock('../src/services/groups-store.js', async original => ({
  ...await original<typeof import('../src/services/groups-store.js')>(), isInChat: vi.fn(async () => true),
}));
vi.mock('../src/services/grant-store.js', async original => {
  const actual = await original<typeof import('../src/services/grant-store.js')>();
  return { ...actual, addAllowedChatGroup: vi.fn(actual.addAllowedChatGroup), addChatGrant: vi.fn(actual.addChatGrant) };
});

import { loadBotConfigs, registerBot, getBot, __testOnly_resetBotRegistry } from '../src/bot-registry.js';
import { sendUserMessage, sendMessage, replyMessage, updateMessage } from '../src/im/lark/client.js';
import { isInChat } from '../src/services/groups-store.js';
import { addAllowedChatGroup, addChatGrant, chatQuotaKey } from '../src/services/grant-store.js';
import { GroupAccessRequestStore } from '../src/services/group-access-request-store.js';
import { requestGroupAccessConfirmation, handleGroupAccessAction, buildGroupAccessCard, dismissWhitelistSelfRequest, GROUP_ACCESS_APPROVE, GROUP_ACCESS_DENY, GROUP_ACCESS_APPROVE_PERSON } from '../src/im/lark/group-access-confirmation.js';
import { maybeSendGrantRequestCard, canTalk, canOperate } from '../src/im/lark/event-dispatcher.js';
import { handleCardAction } from '../src/im/lark/card-handler.js';

const APP = 'cli_groupaccess', PEER = 'cli_peer', GROUP = 'oc_group', OWNER = 'ou_owner';
const privateId = 'om_private_card';
const store = () => new GroupAccessRequestStore(tempDir);
const current = () => store().read(APP, GROUP)!;
const value = (action = GROUP_ACCESS_APPROVE) => ({ action, chat_id: GROUP, nonce: current().nonce });
const groupMessage = (id: string) => ({ message_id: id, chat_id: GROUP, chat_type: 'group', mentions: [] });
const humanEvent = (openId = 'ou_guest') => ({ sender: { sender_type: 'user', sender_id: { open_id: openId } }, message: groupMessage('om_waiting') });
const personValue = () => ({ ...value(GROUP_ACCESS_APPROVE_PERSON), requester_open_id: current().requester!.openId });

beforeEach(() => {
  vi.clearAllMocks(); __testOnly_resetBotRegistry();
  tempDir = mkdtempSync(join(tmpdir(), 'botmux-group-access-'));
  process.env.BOTS_CONFIG = join(tempDir, 'bots.json');
  writeFileSync(process.env.BOTS_CONFIG, JSON.stringify([APP, PEER].map(app => ({
    larkAppId: app, larkAppSecret: 'test', cliId: 'traex', allowedUsers: [OWNER],
    groupAccessConfirmation: true, autoGrantRequestCards: false,
  }))));
  for (const c of loadBotConfigs()) {
    const b = registerBot(c); b.resolvedAllowedUsers = [OWNER]; b.resolvedBlockedUsers = [];
  }
  vi.mocked(sendUserMessage).mockResolvedValue(privateId);
  vi.mocked(isInChat).mockResolvedValue(true);
});
afterEach(() => { delete process.env.BOTS_CONFIG; vi.restoreAllMocks(); rmSync(tempDir, { recursive: true, force: true }); });

describe('owner-private whole-group confirmation', () => {
  it.each([undefined, 'approved', 'denied', 'dismissed'] as const)('uses supported Feishu layout fields for outcome %s', outcome => {
    const card = JSON.parse(buildGroupAccessCard({ version: 1, appId: APP, chatId: GROUP,
      ownerOpenId: OWNER, nonce: 'persisted_nonce', chatName: '测试协作群', reason: 'mention',
      state: 'pending', createdAt: Date.now() }, outcome));
    // Feishu rejects the entire card with 230099 / 200621 when a column_set
    // carries padding. Check every state, including the callback replacement.
    const parse = (node: any): void => {
      if (!node || typeof node !== 'object') return;
      if (node.tag === 'column_set' && 'padding' in node) {
        throw new Error('200621: unknown property padding on column_set');
      }
      for (const child of Object.values(node)) parse(child);
    };
    expect(() => parse(card)).not.toThrow();
  });

  it('bot join creates a private card without opening the group', async () => {
    await requestGroupAccessConfirmation(APP, GROUP, 'joined');
    expect(sendUserMessage).toHaveBeenCalledWith(APP, OWNER, expect.any(String), 'interactive', current().nonce);
    expect(getBot(APP).config.allowedChatGroups).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled(); expect(replyMessage).not.toHaveBeenCalled();
    const card = JSON.parse(vi.mocked(sendUserMessage).mock.calls[0][2]);
    expect(card.schema).toBe('2.0'); expect(card.config.enable_forward).toBe(false);
    expect(JSON.stringify(card)).toContain('确认开放全群'); expect(JSON.stringify(card)).toContain('长期有效');
  });

  it('a human mention card links the group, names the sender and offers both scopes', async () => {
    await requestGroupAccessConfirmation(APP, GROUP, 'mention', humanEvent());
    const card = JSON.parse(vi.mocked(sendUserMessage).mock.calls[0][2]);
    expect(JSON.stringify(card)).toContain('https://applink.feishu.cn/client/chat/open?openChatId=oc_group');
    expect(JSON.stringify(card)).toContain('仅开放给此人');
    expect(JSON.stringify(card)).toContain('group_access_approve_person');
    expect(card.body.elements[1].columns[0].elements).toContainEqual(expect.objectContaining({ tag: 'person', user_id: 'ou_guest' }));
    expect(current().requester).toEqual({ openId: 'ou_guest', name: '申请人', messageId: 'om_waiting' });
  });

  it('owner-addressed requests use the same private decision and replay the exact waiting message', async () => {
    const event = humanEvent(); await requestGroupAccessConfirmation(APP, GROUP, 'mention', event, { addressedOwner: true });
    expect(current().addressedOwner).toBe(true);
    expect(vi.mocked(sendUserMessage).mock.calls[0][2]).toContain('有人 @ 你询问我正在跟进的话题');
    expect(sendMessage).not.toHaveBeenCalled(); expect(replyMessage).not.toHaveBeenCalled();
    const replay = vi.fn(); await handleGroupAccessAction(APP, personValue(), OWNER, privateId, replay);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(replay).toHaveBeenCalledExactlyOnceWith(event, APP);
  });

  it('person approval grants only this person in this group, permanently, without management', async () => {
    await requestGroupAccessConfirmation(APP, GROUP, 'mention', humanEvent());
    const replay = vi.fn(), action = personValue();
    await Promise.all([handleGroupAccessAction(APP, action, OWNER, privateId, replay),
      handleGroupAccessAction(APP, action, OWNER, privateId, replay)]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(addChatGrant).toHaveBeenCalledExactlyOnceWith(APP, GROUP, 'ou_guest');
    expect(addAllowedChatGroup).not.toHaveBeenCalled();
    expect(canTalk(APP, GROUP, 'ou_guest')).toBe(true);
    expect(canTalk(APP, GROUP, 'ou_other')).toBe(false);
    expect(canTalk(APP, 'oc_other', 'ou_guest')).toBe(false);
    expect(canTalk(PEER, GROUP, 'ou_guest')).toBe(false);
    expect(canOperate(APP, GROUP, 'ou_guest')).toBe(false);
    const key = chatQuotaKey(GROUP, 'ou_guest');
    expect(getBot(APP).config.quotaState?.[key]).toBeUndefined();
    expect(getBot(APP).config.grantExpiryState?.[key]).toBeUndefined();
    expect(current().approvalScope).toBe('person'); expect(current().state).toBe('approved');
    expect(replay).toHaveBeenCalledExactlyOnceWith(humanEvent(), APP);
    expect(buildGroupAccessCard(current(), 'approved')).toContain('仅申请人在本群使用');
    expect(buildGroupAccessCard(current(), 'approved')).not.toContain('group_access_approve');
  });

  it('a pending join card gains the first applicant by an in-place update', async () => {
    await requestGroupAccessConfirmation(APP, GROUP, 'joined'); const nonce = current().nonce;
    expect(buildGroupAccessCard(current())).not.toContain('仅开放给此人');
    await requestGroupAccessConfirmation(APP, GROUP, 'mention', humanEvent());
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(updateMessage).toHaveBeenCalledWith(APP, privateId, expect.stringContaining('仅开放给此人'));
    expect(current().nonce).toBe(nonce);
  });

  it('a failed in-place applicant update retries until that identity is delivered', async () => {
    await requestGroupAccessConfirmation(APP, GROUP, 'joined');
    vi.mocked(updateMessage).mockRejectedValueOnce(new Error('update failed'));
    await expect(requestGroupAccessConfirmation(APP, GROUP, 'mention', humanEvent())).rejects.toThrow('update failed');
    expect(current().deliveredRequesterOpenId).toBeUndefined();
    await requestGroupAccessConfirmation(APP, GROUP, 'mention', humanEvent());
    expect(updateMessage).toHaveBeenCalledTimes(2);
    expect(current().deliveredRequesterOpenId).toBe('ou_guest');
  });

  it('the owner uses the bot without creating a card or holding their work', async () => {
    await requestGroupAccessConfirmation(APP, GROUP, 'mention', humanEvent(OWNER), { replay: false });
    expect(sendUserMessage).not.toHaveBeenCalled(); expect(store().read(APP, GROUP)).toBeUndefined();
    await requestGroupAccessConfirmation(APP, GROUP, 'mention', humanEvent());
    expect(current().requester?.openId).toBe('ou_guest'); expect(current().messageData).toEqual(humanEvent());
  });

  it('a whitelist co-owner cannot cause a self-authorization request from an alternate caller', async () => {
    getBot(APP).resolvedAllowedUsers.push('ou_coowner');
    await requestGroupAccessConfirmation(APP, GROUP, 'mention', humanEvent('ou_coowner'));
    expect(sendUserMessage).not.toHaveBeenCalled(); expect(store().read(APP, GROUP)).toBeUndefined();
  });

  it('other effective permission sources skip authorization requests when the ingress verdict allows them', async () => {
    await requestGroupAccessConfirmation(APP, GROUP, 'mention', humanEvent('ou_granted'), { replay: false });
    expect(sendUserMessage).not.toHaveBeenCalled(); expect(store().read(APP, GROUP)).toBeUndefined();
  });

  it('a whitelist message does not create or replace a guest waiting request', async () => {
    await requestGroupAccessConfirmation(APP, GROUP, 'mention', humanEvent());
    const original = current();
    await requestGroupAccessConfirmation(APP, GROUP, 'mention', humanEvent(OWNER), { replay: false });
    expect(current()).toEqual(original); expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it('retires an old whitelist self-request without granting or denying anyone access', async () => {
    const request = { version: 1 as const, appId: APP, chatId: GROUP, ownerOpenId: OWNER,
      nonce: 'old_nonce', chatName: '协作群', reason: 'mention' as const, state: 'pending' as const,
      createdAt: Date.now(), messageId: privateId, requester: { openId: OWNER, name: '本人', messageId: 'om_original' } };
    await store().transact(APP, GROUP, async (_old, save) => save(request));
    expect(await dismissWhitelistSelfRequest(APP, GROUP)).toBe(true);
    expect(current().state).toBe('dismissed');
    expect(updateMessage).toHaveBeenCalledWith(APP, privateId, expect.stringContaining('无需授权'));
    const callback = await handleGroupAccessAction(APP, value(), OWNER, privateId);
    expect(JSON.stringify(callback)).toContain('无需授权'); expect(JSON.stringify(callback)).not.toContain('group_access_approve');
    expect(addAllowedChatGroup).not.toHaveBeenCalled(); expect(addChatGrant).not.toHaveBeenCalled();
    expect(canTalk(APP, GROUP, OWNER)).toBe(true); expect(canTalk(APP, GROUP, 'ou_guest')).toBe(false);
    await requestGroupAccessConfirmation(APP, GROUP, 'mention', humanEvent());
    expect(current().state).toBe('pending'); expect(current().nonce).not.toBe('old_nonce');
  });

  it('keeps guest requests, join prompts and approved grants during self-request cleanup', async () => {
    await requestGroupAccessConfirmation(APP, GROUP, 'mention', humanEvent());
    expect(await dismissWhitelistSelfRequest(APP, GROUP)).toBe(false);
    await handleGroupAccessAction(APP, value(), OWNER, privateId);
    expect(await dismissWhitelistSelfRequest(APP, GROUP)).toBe(false); expect(current().state).toBe('approved');
    await requestGroupAccessConfirmation(PEER, GROUP, 'joined');
    expect(await dismissWhitelistSelfRequest(PEER, GROUP)).toBe(false);
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it('retries the corrected card after an update failure without reinstating permission buttons', async () => {
    const request = { version: 1 as const, appId: APP, chatId: GROUP, ownerOpenId: OWNER,
      nonce: 'old_nonce', chatName: '协作群', reason: 'mention' as const, state: 'pending' as const,
      createdAt: Date.now(), messageId: privateId, requester: { openId: OWNER, name: '本人', messageId: 'om_original' } };
    await store().transact(APP, GROUP, async (_old, save) => save(request));
    vi.mocked(updateMessage).mockRejectedValueOnce(new Error('card unavailable'));
    await expect(dismissWhitelistSelfRequest(APP, GROUP)).rejects.toThrow('card unavailable');
    expect(current().state).toBe('dismissed');
    expect(await dismissWhitelistSelfRequest(APP, GROUP)).toBe(true);
    expect(addAllowedChatGroup).not.toHaveBeenCalled(); expect(addChatGrant).not.toHaveBeenCalled();
  });

  it('later applicants cannot change the person bound to an existing waiting card', async () => {
    await requestGroupAccessConfirmation(APP, GROUP, 'mention', humanEvent());
    await requestGroupAccessConfirmation(APP, GROUP, 'mention', humanEvent('ou_second'));
    expect(current().requester?.openId).toBe('ou_guest');
    expect((await handleGroupAccessAction(APP, { ...personValue(), requester_open_id: 'ou_second' }, OWNER, privateId)).toast.type).toBe('error');
    expect(addChatGrant).not.toHaveBeenCalled();
  });

  it('missing human identity and a forged target cannot create a person grant', async () => {
    await requestGroupAccessConfirmation(APP, GROUP, 'mention', { sender: { sender_type: 'bot', sender_id: { open_id: 'ou_bot' } }, message: groupMessage('om_bot') });
    expect(current().requester).toBeUndefined();
    expect((await handleGroupAccessAction(APP, { ...value(GROUP_ACCESS_APPROVE_PERSON), requester_open_id: 'ou_guest' }, OWNER, privateId)).toast.type).toBe('error');
    expect(addChatGrant).not.toHaveBeenCalled();
  });

  it('a blocked requester cannot receive a person grant from an older card', async () => {
    await requestGroupAccessConfirmation(APP, GROUP, 'mention', humanEvent());
    getBot(APP).resolvedBlockedUsers = ['ou_guest'];
    expect((await handleGroupAccessAction(APP, personValue(), OWNER, privateId)).toast.type).toBe('error');
    expect(addChatGrant).not.toHaveBeenCalled();
  });

  it('person-granted traffic does not ask again, a different guest gets a fresh decision', async () => {
    await requestGroupAccessConfirmation(APP, GROUP, 'mention', humanEvent());
    await handleGroupAccessAction(APP, personValue(), OWNER, privateId);
    await requestGroupAccessConfirmation(APP, GROUP, 'mention', humanEvent(), { replay: false });
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    await requestGroupAccessConfirmation(APP, GROUP, 'mention', humanEvent('ou_second'));
    expect(sendUserMessage).toHaveBeenCalledTimes(2); expect(current().requester?.openId).toBe('ou_second');
  });

  it('an old person approval cannot restore revoked access', async () => {
    await requestGroupAccessConfirmation(APP, GROUP, 'mention', humanEvent()); const action = personValue();
    await handleGroupAccessAction(APP, action, OWNER, privateId);
    getBot(APP).config.chatGrants = {};
    expect((await handleGroupAccessAction(APP, action, OWNER, privateId)).toast.type).toBe('error');
    expect(addChatGrant).toHaveBeenCalledTimes(1);
  });

  it('a rejected human @ routes privately even with legacy auto request cards disabled', async () => {
    const event = { message: groupMessage('om_inbound'), sender: { sender_id: { open_id: 'ou_guest' } } };
    await maybeSendGrantRequestCard(APP, event.message, GROUP, 'ou_guest', event, { notifyThrottledRequester: true });
    expect(current().reason).toBe('mention'); expect(current().messageData).toEqual(event);
    expect(sendUserMessage).toHaveBeenCalledTimes(1); expect(replyMessage).not.toHaveBeenCalled();
  });

  it('concurrent joins and different applicants share one delivered decision', async () => {
    await Promise.all([requestGroupAccessConfirmation(APP, GROUP, 'joined'),
      requestGroupAccessConfirmation(APP, GROUP, 'mention', { id: 'first' }),
      requestGroupAccessConfirmation(APP, GROUP, 'mention', { id: 'second' })]);
    expect(sendUserMessage).toHaveBeenCalledTimes(1); expect(current().messageData).toEqual({ id: 'first' });
  });

  it('failed private delivery retries the same provider UUID and never falls back to the group', async () => {
    vi.mocked(sendUserMessage).mockRejectedValueOnce(new Error('delivery unknown'));
    await expect(requestGroupAccessConfirmation(APP, GROUP, 'joined')).rejects.toThrow('delivery unknown');
    const nonce = current().nonce;
    await requestGroupAccessConfirmation(APP, GROUP, 'mention');
    expect(current().nonce).toBe(nonce); expect(sendUserMessage).toHaveBeenNthCalledWith(2, APP, OWNER, expect.any(String), 'interactive', nonce);
    expect(replyMessage).not.toHaveBeenCalled(); expect(sendMessage).not.toHaveBeenCalled();
  });

  it('a months-old persisted card still grants all group members through the real callback', async () => {
    await requestGroupAccessConfirmation(APP, GROUP, 'joined');
    const original = current();
    await store().transact(APP, GROUP, async (r, save) => { r!.createdAt -= 180 * 86_400_000; save(r!); });
    // A new store reads the same durable identity: no process-local nonce or TTL.
    expect(new GroupAccessRequestStore(tempDir).read(APP, GROUP)?.nonce).toBe(original.nonce);
    const result = await handleCardAction({ operator: { open_id: OWNER }, context: { open_message_id: privateId },
      action: { value: value() } }, { activeSessions: new Map(), sessionReply: vi.fn(), lastRepoScan: new Map() } as any, APP);
    expect(JSON.stringify(result)).toContain('已开放全群');
    expect(getBot(APP).config.allowedChatGroups).toEqual([GROUP]);
    const disk = JSON.parse(readFileSync(process.env.BOTS_CONFIG!, 'utf8'));
    expect(disk[0].allowedChatGroups).toEqual([GROUP]); expect(disk[0].allowedUsers).toEqual([OWNER]);
    expect(disk[1].allowedChatGroups).toBeUndefined(); expect(current().state).toBe('approved');
  });

  it('rejects non-owner, forged group, wrong nonce and copied-card callbacks without granting', async () => {
    await requestGroupAccessConfirmation(APP, GROUP, 'joined');
    expect((await handleGroupAccessAction(APP, value(), 'ou_guest', privateId)).toast.type).toBe('error');
    expect((await handleGroupAccessAction(APP, { ...value(), chat_id: 'oc_other' }, OWNER, privateId)).toast.type).toBe('error');
    expect((await handleGroupAccessAction(APP, { ...value(), nonce: 'forged' }, OWNER, privateId)).toast.type).toBe('error');
    expect((await handleGroupAccessAction(APP, value(), OWNER, 'om_copied')).toast.type).toBe('error');
    expect(addAllowedChatGroup).not.toHaveBeenCalled(); expect(current().state).toBe('pending');
  });

  it('an owner change invalidates the previous owner card', async () => {
    await requestGroupAccessConfirmation(APP, GROUP, 'joined');
    getBot(APP).resolvedAllowedUsers = ['ou_new_owner'];
    expect((await handleGroupAccessAction(APP, value(), OWNER, privateId)).toast.type).toBe('error');
    expect(addAllowedChatGroup).not.toHaveBeenCalled();
  });

  it('owner removal during membership lookup does not create a grant', async () => {
    await requestGroupAccessConfirmation(APP, GROUP, 'joined');
    vi.mocked(isInChat).mockImplementationOnce(async () => { getBot(APP).resolvedAllowedUsers = ['ou_new_owner']; return true; });
    expect((await handleGroupAccessAction(APP, value(), OWNER, privateId)).toast.type).toBe('error');
    expect(addAllowedChatGroup).not.toHaveBeenCalled();
  });

  it('denial is durable, keeps the group restricted and suppresses immediate re-asks', async () => {
    await requestGroupAccessConfirmation(APP, GROUP, 'joined');
    const nonce = current().nonce;
    await handleGroupAccessAction(APP, value(GROUP_ACCESS_DENY), OWNER, privateId);
    expect(current().state).toBe('denied'); expect(getBot(APP).config.allowedChatGroups).toBeUndefined();
    await requestGroupAccessConfirmation(APP, GROUP, 'mention'); expect(sendUserMessage).toHaveBeenCalledTimes(1);
    await store().transact(APP, GROUP, async (r, save) => { r!.decidedAt! -= 11 * 60_000; save(r!); });
    await requestGroupAccessConfirmation(APP, GROUP, 'mention'); expect(current().nonce).not.toBe(nonce);
    expect(sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it('bot leaving the group prevents authorization, and the original card can retry after rejoin', async () => {
    await requestGroupAccessConfirmation(APP, GROUP, 'joined'); vi.mocked(isInChat).mockResolvedValueOnce(false);
    expect((await handleGroupAccessAction(APP, value(), OWNER, privateId)).toast.type).toBe('error');
    expect(addAllowedChatGroup).not.toHaveBeenCalled(); expect(current().state).toBe('pending');
    await handleGroupAccessAction(APP, value(), OWNER, privateId); expect(current().state).toBe('approved');
  });

  it('double approval grants once and replays only the captured message once', async () => {
    const event = { message: groupMessage('om_waiting') };
    await requestGroupAccessConfirmation(APP, GROUP, 'mention', event);
    const action = value(), replay = vi.fn();
    await Promise.all([handleGroupAccessAction(APP, action, OWNER, privateId, replay),
      handleGroupAccessAction(APP, action, OWNER, privateId, replay)]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(addAllowedChatGroup).toHaveBeenCalledTimes(1); expect(replay).toHaveBeenCalledExactlyOnceWith(event, APP);
    expect(current().messageData).toBeUndefined();
  });

  it('known grant failure leaves the same decision available for retry', async () => {
    await requestGroupAccessConfirmation(APP, GROUP, 'joined'); const action = value();
    vi.mocked(addAllowedChatGroup).mockResolvedValueOnce({ ok: false, reason: 'write_failed' });
    expect((await handleGroupAccessAction(APP, action, OWNER, privateId)).toast.type).toBe('error');
    await handleGroupAccessAction(APP, action, OWNER, privateId); expect(current().state).toBe('approved');
  });

  it('already open groups and disabled policies do not ask again', async () => {
    getBot(APP).config.allowedChatGroups = [GROUP];
    await requestGroupAccessConfirmation(APP, GROUP, 'joined');
    getBot(PEER).config.groupAccessConfirmation = false;
    await requestGroupAccessConfirmation(PEER, GROUP, 'mention'); expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('blocked applicants do not cause private authorization spam', async () => {
    getBot(APP).resolvedBlockedUsers = ['ou_blocked'];
    await maybeSendGrantRequestCard(APP, groupMessage('om_blocked'), GROUP, 'ou_blocked', {}, { notifyThrottledRequester: true });
    expect(sendUserMessage).not.toHaveBeenCalled(); expect(store().read(APP, GROUP)).toBeUndefined();
  });

  it('a terminal card has no live action buttons', async () => {
    await requestGroupAccessConfirmation(APP, GROUP, 'joined');
    const card = buildGroupAccessCard(current(), 'approved');
    expect(card).not.toContain('group_access_approve'); expect(card).not.toContain('group_access_deny');
  });

  it('an old approved card cannot reopen a grant after it has been revoked', async () => {
    await requestGroupAccessConfirmation(APP, GROUP, 'joined'); const action = value();
    await handleGroupAccessAction(APP, action, OWNER, privateId);
    getBot(APP).config.allowedChatGroups = [];
    expect((await handleGroupAccessAction(APP, action, OWNER, privateId)).toast.type).toBe('error');
    expect(addAllowedChatGroup).toHaveBeenCalledTimes(1);
  });
});
