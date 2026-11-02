import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class {} }));
import { getBot, registerBot, __testOnly_resetBotRegistry } from '../src/bot-registry.js';
import { nonOwnerHumanProgressSuppressed, nonOwnerHumanSendSuppressed, ownerOnlyProgressSuppressed } from '../src/core/owner-only-progress.js';
import type { Session } from '../src/types.js';
const APP = 'cli_progress', OWNER = 'ou_owner', GUEST = 'ou_guest';
const session = () => ({ ownerOpenId: OWNER, lastCallerOpenId: OWNER, scope: 'thread',
  currentReplyTarget: { turnId: 'om_latest_owner' }, replyTargets: {
    om_guest: { senderOpenId: GUEST, participants: [{ openId: GUEST, isBot: false }, { openId: OWNER, isBot: false }], updatedAt: '2026-11-02' },
    om_owner: { senderOpenId: OWNER, participants: [{ openId: OWNER, isBot: false }], updatedAt: '2026-11-02' },
    om_peer: { senderOpenId: 'ou_peer', participants: [{ openId: 'ou_peer', isBot: true }], updatedAt: '2026-11-02' },
  } } as unknown as Session);
beforeEach(() => { __testOnly_resetBotRegistry(); registerBot({ larkAppId: APP, larkAppSecret: 'test', cliId: 'traex',
  allowedUsers: [OWNER, 'ou_coadmin'], ownerOnlyProgress: true }); });
describe('per-human progress presentation', () => {
  it('only the actual owner gets progress; @owner in a guest request does not reveal progress', () => {
    expect(nonOwnerHumanProgressSuppressed(APP, session(), 'om_guest')).toBe(true);
    expect(nonOwnerHumanProgressSuppressed(APP, session(), 'om_owner')).toBe(false);
  });
  it('never borrows a later owner or guest when late output belongs to another turn', () => {
    const s = session(); s.quoteTargetId = 'om_guest'; s.quoteTargetSenderOpenId = GUEST;
    expect(nonOwnerHumanProgressSuppressed(APP, s, 'om_owner')).toBe(false);
    s.quoteTargetId = 'om_owner'; s.quoteTargetSenderOpenId = OWNER;
    expect(nonOwnerHumanProgressSuppressed(APP, s, 'om_guest')).toBe(true);
  });
  it('uses the running turn for startup frames while the latest accepted sender is queued', () => {
    const ds: any = { larkAppId: APP, session: session(), currentTurnId: 'om_owner',
      activeInteractiveTurn: { turnId: 'om_guest' }, currentReplyTarget: { turnId: 'om_owner' } };
    expect(ownerOnlyProgressSuppressed(ds)).toBe(true);
    expect(ownerOnlyProgressSuppressed(ds, 'om_owner')).toBe(false);
  });
  it('keeps final delivery available while rejecting progress and auxiliary chatter', () => {
    for (const kind of ['progress', 'auxiliary'] as const) expect(nonOwnerHumanSendSuppressed(APP, session(), 'om_guest', kind)).toBe(true);
    expect(nonOwnerHumanSendSuppressed(APP, session(), 'om_guest', 'final')).toBe(false);
    expect(nonOwnerHumanSendSuppressed(APP, session(), 'om_owner', 'progress')).toBe(false);
  });
  it('does not change bots or scheduled tasks and is reversible through the live bot flag', () => {
    expect(nonOwnerHumanProgressSuppressed(APP, session(), 'om_peer')).toBe(false);
    expect(nonOwnerHumanProgressSuppressed(APP, session(), 'schedule:task')).toBe(false);
    getBot(APP).config.ownerOnlyProgress = false;
    expect(nonOwnerHumanProgressSuppressed(APP, session(), 'om_guest')).toBe(false);
  });
});
