import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getChatInfo, listChatUserMembers } = vi.hoisted(() => ({
  getChatInfo: vi.fn(),
  listChatUserMembers: vi.fn(),
}));
vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class {} }));
vi.mock('../src/im/lark/client.js', () => ({ getChatInfo, listChatUserMembers }));

import { registerBot, __testOnly_resetBotRegistry } from '../src/bot-registry.js';
import { __testOnly_resetOwnerGroupAudience } from '../src/core/owner-only-progress.js';
import { presentOwnerGroupProgress, resolveOwnerOnlyGroup } from '../src/core/owner-progress-cot.js';
import type { DaemonSession } from '../src/core/types.js';

const APP = 'cli_private';
const OWNER = 'ou_owner';

function session(): DaemonSession {
  return {
    larkAppId: APP, chatType: 'group', chatId: 'oc_group', currentTurnId: 'om_owner',
    session: {
      larkAppId: APP, sessionId: 'sid', rootMessageId: 'om_root', chatId: 'oc_group',
      chatType: 'group', status: 'active', scope: 'thread',
      replyTargets: {
        om_owner: {
          senderOpenId: OWNER, rootMessageId: 'om_root', updatedAt: '2026-11-05',
          participants: [{ openId: OWNER, isBot: false }],
        },
      },
    },
  } as unknown as DaemonSession;
}

beforeEach(() => {
  __testOnly_resetBotRegistry();
  __testOnly_resetOwnerGroupAudience();
  getChatInfo.mockReset();
  listChatUserMembers.mockReset();
  registerBot({
    larkAppId: APP, larkAppSecret: 'test', cliId: 'traex', allowedUsers: [OWNER],
    ownerOnlyProgress: true, ownerProgressToDm: true, cotEnabled: true,
  });
});

describe('owner group progress uses the native thinking bubble', () => {
  it('treats a single matching human as an owner-only group', async () => {
    getChatInfo.mockResolvedValue({ userCount: 1, botCount: 2 });
    listChatUserMembers.mockResolvedValue([{ openId: OWNER }]);
    await expect(resolveOwnerOnlyGroup(APP, 'oc_group')).resolves.toBe(true);
    expect(listChatUserMembers).toHaveBeenCalledTimes(1);
    await expect(resolveOwnerOnlyGroup(APP, 'oc_group')).resolves.toBe(true);
    expect(getChatInfo).toHaveBeenCalledTimes(1);
  });

  it('keeps a multi-human group on the private chat and does not leak on lookup failure', async () => {
    getChatInfo.mockResolvedValueOnce({ userCount: 3, botCount: 1 });
    await expect(resolveOwnerOnlyGroup(APP, 'oc_shared')).resolves.toBe(false);
    expect(listChatUserMembers).not.toHaveBeenCalled();
    getChatInfo.mockRejectedValueOnce(new Error('members unavailable'));
    await expect(resolveOwnerOnlyGroup(APP, 'oc_unknown')).resolves.toBe(false);
  });

  it('does not open a private bubble for a guest turn', async () => {
    const ds = session();
    await presentOwnerGroupProgress(ds, { type: 'thinking_update', turnId: 'om_guest', entries: [{ kind: 'thinking', text: 'no' }] });
    expect(getChatInfo).not.toHaveBeenCalled();
  });
});
