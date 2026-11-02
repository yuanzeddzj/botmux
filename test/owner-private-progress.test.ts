import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class {} }));
import { registerBot, getBot, __testOnly_resetBotRegistry } from '../src/bot-registry.js';
import { OwnerPrivateProgress, buildOwnerPrivateProgressCard, type PrivateProgressTransport } from '../src/core/owner-private-progress.js';
import { ownerPrivateProgressRecipient, publicProgressSuppressed, ownerOnlyProgressSuppressed, nonOwnerHumanSendSuppressed } from '../src/core/owner-only-progress.js';
import type { DaemonSession } from '../src/core/types.js';
const APP = 'cli_private', OWNER = 'ou_owner';
const human = (senderOpenId: string) => ({ senderOpenId, rootMessageId: 'om_root',
  participants: [{ openId: senderOpenId, isBot: false }], updatedAt: '2026-11-02' });
function session(): DaemonSession {
  return { larkAppId: APP, chatType: 'group', chatId: 'oc_group', currentTurnId: 'om_owner',
    activeInteractiveTurn: { turnId: 'om_owner' },
    session: { larkAppId: APP, sessionId: 'sid_private', rootMessageId: 'om_root', chatId: 'oc_group',
      chatType: 'group', status: 'active', scope: 'thread', replyTargets: {
        om_owner: human(OWNER), om_next_owner: human(OWNER), om_guest: human('ou_guest'),
        om_coadmin: human('ou_coadmin'), om_bot: { senderOpenId: 'ou_peer',
          participants: [{ openId: 'ou_peer', isBot: true }], updatedAt: '2026-11-02' },
      } },
  } as unknown as DaemonSession;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'owner-private-progress-'));
  __testOnly_resetBotRegistry();
  registerBot({ larkAppId: APP, larkAppSecret: 'test', cliId: 'traex', allowedUsers: [OWNER, 'ou_coadmin'],
    ownerOnlyProgress: true, ownerProgressToDm: true });
});
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });
function harness(interval = 0) {
  const posted: { owner: string; card: any; uuid: string }[] = [], patched: { id: string; card: any }[] = [];
  const io: PrivateProgressTransport = {
    send: vi.fn(async (_app, owner, card, uuid, beforeWrite) => {
      await beforeWrite();
      posted.push({ owner, card: JSON.parse(card), uuid }); return 'om_private_' + posted.length;
    }),
    patch: vi.fn(async (_app, id, card, beforeWrite) => { await beforeWrite(); patched.push({ id, card: JSON.parse(card) }); }),
    thread: vi.fn(async () => 'omt_native'),
  };
  return { io, posted, patched, manager: new OwnerPrivateProgress(dir, io, interval) };
}
describe('owner group process in one private updating card', () => {
  it('hides public process for the owner while keeping owner reactions and every final allowed', () => {
    const ds = session();
    expect(ownerPrivateProgressRecipient(APP, ds.session, 'om_owner')).toBe(OWNER);
    expect(publicProgressSuppressed(ds, 'om_owner')).toBe(true);
    expect(ownerOnlyProgressSuppressed(ds, 'om_owner')).toBe(false);
    for (const turn of ['om_owner', 'om_guest']) expect(nonOwnerHumanSendSuppressed(APP, ds.session, turn, 'final')).toBe(false);
    expect(ownerPrivateProgressRecipient(APP, ds.session, 'om_guest')).toBeUndefined();
    expect(ownerPrivateProgressRecipient(APP, ds.session, 'om_coadmin')).toBeUndefined();
    expect(ownerPrivateProgressRecipient(APP, ds.session, 'om_bot')).toBeUndefined();
  });
  it('uses the active owner turn when a newer guest is queued and a startup frame has no turn', () => {
    const ds = session(); ds.currentTurnId = 'om_guest';
    expect(publicProgressSuppressed(ds)).toBe(true);
    expect(ownerOnlyProgressSuppressed(ds)).toBe(false);
  });
  it('leaves direct chats, unknown senders and bot-driven work on their original path', async () => {
    const h = harness(), ds = session();
    ds.chatType = 'p2p'; ds.session.chatType = 'p2p';
    expect(h.manager.eligible(ds, 'om_owner')).toBeUndefined();
    ds.chatType = 'group'; ds.session.chatType = 'group';
    for (const turn of ['om_guest', 'om_bot', 'schedule:unknown']) {
      expect((await h.manager.update(ds, turn, { text: 'ignored' })).delivered).toBe(false);
    }
    expect(h.io.send).not.toHaveBeenCalled();
  });
  it('combines thought, tool entries and explicit text progress into the same card identity', async () => {
    const h = harness(), ds = session(), original = structuredClone(session().session);
    const first = await h.manager.update(ds, 'om_owner', { entries: [{ kind: 'thinking', text: 'checking the request' }] });
    const second = await h.manager.update(ds, 'om_owner', { text: 'checking the configuration',
      entries: [{ kind: 'tool_call', id: 'tool1', name: 'Read', args: '{}', subject: 'config.json' }] });
    expect(first.messageId).toBe(second.messageId);
    expect(h.posted).toHaveLength(1); expect(h.posted[0].owner).toBe(OWNER);
    expect(h.patched).toHaveLength(1); expect(h.patched[0].id).toBe(first.messageId);
    expect(JSON.stringify(h.patched[0].card)).toContain('checking the configuration');
    expect(JSON.stringify(h.patched[0].card)).toContain('config.json');
    const url = h.posted[0].card.body.elements.at(-1).behaviors[0].default_url;
    expect(new URL(url).searchParams.get('open_thread_id')).toBe('omt_native');
    expect(ds.session).toEqual(original);
  });
  it('coalesces in-flight updates with a fake clock and never creates a second card', async () => {
    vi.useFakeTimers();
    const h = harness(1000), ds = session();
    await h.manager.update(ds, 'om_owner', { text: 'start' });
    const next = h.manager.update(ds, 'om_owner', { text: 'intermediate' });
    const latest = h.manager.update(ds, 'om_owner', { text: 'latest' });
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([next, latest]);
    expect(h.posted).toHaveLength(1); expect(h.patched).toHaveLength(1);
    expect(JSON.stringify(h.patched[0].card)).toContain('latest');
    expect(JSON.stringify(h.patched[0].card)).not.toContain('intermediate');
  });
  it('serializes creation even when another update arrives before its acknowledgement', async () => {
    const h = harness(), ds = session(), gate = deferred<string>();
    h.io.send = vi.fn(async (_app, owner, card, uuid) => {
      h.posted.push({ owner, card: JSON.parse(card), uuid }); return gate.promise;
    });
    const first = h.manager.update(ds, 'om_owner', { text: 'first' });
    await vi.waitFor(() => expect(h.posted).toHaveLength(1));
    const next = h.manager.update(ds, 'om_owner', { text: 'newer' });
    gate.resolve('om_private_gate');
    const results = await Promise.all([first, next]);
    expect(h.io.send).toHaveBeenCalledTimes(1);
    expect(results.every(r => r.messageId === 'om_private_gate')).toBe(true);
    expect(JSON.stringify(h.patched.at(-1)?.card)).toContain('newer');
  });
  it('keeps adjacent owner and guest turns separate and ignores late updates after completion', async () => {
    const h = harness(), ds = session();
    await h.manager.update(ds, 'om_owner', { text: 'owner first' });
    ds.currentTurnId = 'om_guest';
    await h.manager.update(ds, 'om_guest', { text: 'guest must stay hidden' });
    await h.manager.finish(ds, 'om_owner', 'completed');
    const patches = h.patched.length;
    expect((await h.manager.update(ds, 'om_owner', { text: 'late', status: 'working' })).delivered).toBe(false);
    expect(h.patched).toHaveLength(patches);
    ds.activeInteractiveTurn!.turnId = 'om_next_owner';
    await h.manager.update(ds, 'om_next_owner', { text: 'owner next' });
    expect(h.posted).toHaveLength(2);
    expect(h.posted[0].uuid).not.toBe(h.posted[1].uuid);
    expect(JSON.stringify([...h.posted, ...h.patched])).not.toContain('guest must stay hidden');
  });
  it('reuses a persisted card after restart and does not reopen a completed turn', async () => {
    const h = harness(), ds = session();
    await h.manager.update(ds, 'om_owner', { text: 'before restart' });
    const restarted = new OwnerPrivateProgress(dir, h.io, 0);
    await restarted.update(ds, 'om_owner', { text: 'after restart' });
    expect(h.io.send).toHaveBeenCalledTimes(1);
    expect(h.patched.every(p => p.id === 'om_private_1')).toBe(true);
    await restarted.finish(ds, 'om_owner', 'failed');
    const again = new OwnerPrivateProgress(dir, h.io, 0);
    expect((await again.update(ds, 'om_owner', { text: 'old output' })).delivered).toBe(false);
    expect(h.io.send).toHaveBeenCalledTimes(1);
  });
  it('retries a lost create receipt using the same provider uuid on restart', async () => {
    const h = harness(), ds = session(), ids = new Set<string>(); let attempts = 0;
    h.io.send = vi.fn(async (_app, _owner, _card, uuid) => {
      ids.add(uuid);
      if (++attempts === 1) throw new Error('acknowledgement lost');
      return 'om_private_replayed';
    }) as any;
    expect((await h.manager.update(ds, 'om_owner', { text: 'original' })).delivered).toBe(false);
    const restarted = new OwnerPrivateProgress(dir, h.io, 0);
    expect((await restarted.update(ds, 'om_owner', { text: 'resume' })).messageId).toBe('om_private_replayed');
    expect(ids.size).toBe(1);
  });
  it('fails closed on private send failure and a policy change during pending creation', async () => {
    const h = harness(), ds = session(); h.io.send = vi.fn(async () => { throw new Error('DM blocked'); });
    expect((await h.manager.update(ds, 'om_owner', { text: 'private' })).delivered).toBe(false);
    expect(h.io.patch).not.toHaveBeenCalled();
    const h2 = harness(), wait = deferred<string | undefined>(); h2.io.thread = () => wait.promise;
    const pending = h2.manager.update(ds, 'om_next_owner', { text: 'must not escape' });
    await Promise.resolve(); getBot(APP).config.ownerProgressToDm = false;
    wait.resolve('omt_native');
    expect((await pending).delivered).toBe(false);
    expect(h2.io.send).not.toHaveBeenCalled();
  });
  it('keeps source context in the recovery notice without persisting the thought text', async () => {
    const h = harness(), ds = session();
    await h.manager.update(ds, 'om_owner', { entries: [{ kind: 'thinking', text: 'private thoughts' }] });
    const appDir = join(dir, 'owner-private-progress', readdirSync(join(dir, 'owner-private-progress'))[0], 'active');
    const raw = readFileSync(join(appDir, readdirSync(appDir)[0]), 'utf8');
    expect(raw).not.toContain('private thoughts');
    const restarted = new OwnerPrivateProgress(dir, h.io, 0); await restarted.recover(APP);
    expect(new URL(h.patched.at(-1)!.card.body.elements.at(-1).behaviors[0].default_url).searchParams.get('open_thread_id')).toBe('omt_native');
  });
  it('bounds very long tool output while preserving a valid updating card and source link', () => {
    const card = buildOwnerPrivateProgressCard({ status: 'working', text: 'progress',
      entries: [{ kind: 'thinking', text: '中文'.repeat(20000) }], link: 'https://example.test/source' });
    expect(Buffer.byteLength(card)).toBeLessThan(30000);
    const parsed = JSON.parse(card); expect(parsed.schema).toBe('2.0');
    expect(parsed.config.update_multi).toBe(true); expect(parsed.config.enable_forward).toBe(false);
    expect(parsed.body.elements.find((e: any) => e.tag === 'collapsible_panel')).toBeTruthy();
  });
  it('does not create a task card from an idle restored session with a historical owner turn', async () => {
    const h = harness(), ds = session(); ds.activeInteractiveTurn = undefined;
    expect((await h.manager.update(ds, 'om_owner', { status: 'working' })).delivered).toBe(false);
    expect(h.io.send).not.toHaveBeenCalled();
  });
  it('does not publish repeated unchanged status frames', async () => {
    const h = harness(), ds = session();
    await h.manager.update(ds, 'om_owner', { status: 'working' });
    for (let i = 0; i < 10; i++) await h.manager.update(ds, 'om_owner', { status: 'working' });
    expect(h.io.send).toHaveBeenCalledTimes(1); expect(h.io.patch).not.toHaveBeenCalled();
  });
  it('persists terminal identity with the display off and rejects old output after re-enabling', async () => {
    const h = harness(), ds = session();
    await h.manager.update(ds, 'om_owner', { text: 'start' });
    getBot(APP).config.ownerProgressToDm = false;
    await h.manager.finish(ds, 'om_owner', 'completed');
    expect(h.io.patch).not.toHaveBeenCalled();
    getBot(APP).config.ownerProgressToDm = true;
    const restored = new OwnerPrivateProgress(dir, h.io, 0);
    expect((await restored.update(ds, 'om_owner', { text: 'late' })).delivered).toBe(false);
    expect(h.io.send).toHaveBeenCalledTimes(1);
  });
  it('keeps a terminal fence when the completed directory cannot be created', async () => {
    const h = harness(), ds = session();
    await h.manager.update(ds, 'om_owner', { text: 'start' });
    const appDir = join(dir, 'owner-private-progress', readdirSync(join(dir, 'owner-private-progress'))[0]);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(appDir, 'completed'), 'blocked directory');
    expect((await h.manager.finish(ds, 'om_owner', 'completed')).delivered).toBe(false);
    const active = join(appDir, 'active');
    const record = JSON.parse(readFileSync(join(active, readdirSync(active)[0]), 'utf8'));
    expect(record.closed).toBe(true); expect(record.status).toBe('completed');
    rmSync(join(appDir, 'completed'));
    const restarted = new OwnerPrivateProgress(dir, h.io, 0);
    expect((await restarted.update(ds, 'om_owner', { text: 'old output' })).delivered).toBe(false);
    expect(h.io.send).toHaveBeenCalledTimes(1);
  });
  it('finishes the same card after a recovery request that already passed its guard', async () => {
    const h = harness(), ds = session();
    await h.manager.update(ds, 'om_owner', { text: 'start' });
    const gate = deferred<void>(); let recoveryDispatched = false;
    h.io.patch = vi.fn(async (_app, id, card, beforeWrite) => {
      await beforeWrite();
      if (!recoveryDispatched) { recoveryDispatched = true; await gate.promise; }
      h.patched.push({ id, card: JSON.parse(card) });
    });
    const restarted = new OwnerPrivateProgress(dir, h.io, 0);
    const recovery = restarted.recover(APP);
    await vi.waitFor(() => expect(recoveryDispatched).toBe(true));
    const finish = restarted.finish(ds, 'om_owner', 'completed');
    await Promise.resolve(); gate.resolve();
    await recovery; expect((await finish).delivered).toBe(true);
    expect(h.patched.at(-1)!.card.header.template).toBe('green');
  });
  it('acknowledges an explicit progress update without waiting for the entire update stream to quiet', async () => {
    const h = harness(), ds = session(), nextWrite = deferred<void>(); let writes = 0;
    await h.manager.update(ds, 'om_owner', { text: 'start' });
    h.io.patch = vi.fn(async (_app, id, card, beforeWrite) => {
      await beforeWrite();
      if (++writes === 2) await nextWrite.promise;
      h.patched.push({ id, card: JSON.parse(card) });
    });
    const first = h.manager.update(ds, 'om_owner', { text: 'first' });
    await first;
    const second = h.manager.update(ds, 'om_owner', { text: 'second' });
    await vi.waitFor(() => expect(writes).toBe(2));
    const third = h.manager.update(ds, 'om_owner', { text: 'third' });
    nextWrite.resolve(); await Promise.all([second, third]);
    expect(h.io.send).toHaveBeenCalledTimes(1);
  });
  it('keeps a native group message with missing attribution from falling back to public progress', () => {
    const ds = session(); delete ds.session.replyTargets!.om_owner;
    expect(publicProgressSuppressed(ds, 'om_owner')).toBe(true);
  });
});
