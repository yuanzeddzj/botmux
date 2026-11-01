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
    getChatName: vi.fn(async () => '测试协作群'), replyMessage: vi.fn(async () => 'om_public'),
    sendMessage: vi.fn(async () => 'om_public') };
});
vi.mock('../src/services/groups-store.js', async original => ({
  ...await original<typeof import('../src/services/groups-store.js')>(), isInChat: vi.fn(async () => true),
}));
vi.mock('../src/services/grant-store.js', async original => {
  const actual = await original<typeof import('../src/services/grant-store.js')>();
  return { ...actual, addAllowedChatGroup: vi.fn(actual.addAllowedChatGroup) };
});

import { loadBotConfigs, registerBot, getBot, __testOnly_resetBotRegistry } from '../src/bot-registry.js';
import { sendUserMessage, sendMessage, replyMessage } from '../src/im/lark/client.js';
import { isInChat } from '../src/services/groups-store.js';
import { addAllowedChatGroup } from '../src/services/grant-store.js';
import { GroupAccessRequestStore } from '../src/services/group-access-request-store.js';
import { requestGroupAccessConfirmation, handleGroupAccessAction, buildGroupAccessCard, GROUP_ACCESS_APPROVE, GROUP_ACCESS_DENY } from '../src/im/lark/group-access-confirmation.js';
import { maybeSendGrantRequestCard } from '../src/im/lark/event-dispatcher.js';
import { handleCardAction } from '../src/im/lark/card-handler.js';

const APP = 'cli_groupaccess', PEER = 'cli_peer', GROUP = 'oc_group', OWNER = 'ou_owner';
const privateId = 'om_private_card';
const store = () => new GroupAccessRequestStore(tempDir);
const current = () => store().read(APP, GROUP)!;
const value = (action = GROUP_ACCESS_APPROVE) => ({ action, chat_id: GROUP, nonce: current().nonce });
const groupMessage = (id: string) => ({ message_id: id, chat_id: GROUP, chat_type: 'group', mentions: [] });

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
  it.each([undefined, 'approved', 'denied'] as const)('uses supported Feishu layout fields for outcome %s', outcome => {
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
