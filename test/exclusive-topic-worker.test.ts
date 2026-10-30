import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(), cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(), updateSessionPid: vi.fn(), updateSession: vi.fn(),
}));
vi.mock('../src/core/dashboard-events.js', () => ({ dashboardEventBus: { publish: vi.fn() } }));
import { config } from '../src/config.js';
import * as registry from '../src/bot-registry.js';
import { ExclusiveTopicCoordinator } from '../src/services/exclusive-topic-owner.js';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';
import { sendWorkerSessionInput, forkWorker, suspendTopicWorkerVerified, __testOnly_setSuspendBackingVerifier } from '../src/core/worker-pool.js';

let dataDir: string;
const oldDataDir = config.session.dataDir;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-topic-worker-'));
  config.session.dataDir = dataDir;
  vi.spyOn(registry, 'getAllBots').mockReturnValue([{ config: { larkAppId: 'a', exclusiveTopicOwner: true } }] as any);
});
afterEach(() => {
  config.session.dataDir = oldDataDir;
  __testOnly_setSuspendBackingVerifier();
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});
const topic = { chatId: 'oc_worker_topic', rootId: 'om_worker_root' };
const input = (app: string, time: number) => ({ ...topic, larkAppId: app, selectedAppId: app, createdAt: time, messageId: `om_${time}` });
function session() {
  const worker = Object.assign(new EventEmitter(), { killed: false, connected: true, exitCode: null, signalCode: null, send: vi.fn(), kill: vi.fn() });
  return { larkAppId: 'a', chatId: topic.chatId, chatType: 'group', worker,
    initConfig: { backendType: 'tmux' }, session: { sessionId: 'sid-topic-worker', status: 'active',
      chatId: topic.chatId, rootMessageId: topic.rootId, scope: 'thread' } } as any;
}

it('blocks old input and delayed fork immediately after the topic is selected by another bot', async () => {
  const c = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async () => {} });
  const ds = session();
  await c.admit(input('a', 1), async () => {
    expect(sendWorkerSessionInput(ds, { type: 'raw_input', data: 'first' } as any)).toBe(true);
  });
  expect(ds.worker.send).toHaveBeenCalledOnce();
  await c.select(input('b', 2));
  expect(sendWorkerSessionInput(ds, { type: 'raw_input', data: 'stale' } as any)).toBe(false);
  const onAdmission = vi.fn();
  expect(forkWorker(ds, 'stale', false, { onAdmission })).toBe(false);
  expect(onAdmission).toHaveBeenCalledWith('rejected');
  expect(ds.worker.send).toHaveBeenCalledOnce();
});

it('blocks a revoked session after A returns until a new explicit admission binds its epoch', async () => {
  const c = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async () => {} });
  const ds = session();
  await c.admit(input('a', 1), async () => { sendWorkerSessionInput(ds, { type: 'raw_input', data: 'first' } as any); });
  await c.admit(input('b', 2), async () => {});
  await c.admit(input('a', 3), async () => {});
  expect(sendWorkerSessionInput(ds, { type: 'raw_input', data: 'stale' } as any)).toBe(false);
  await c.admit({ ...input('a', 4), selectedAppId: undefined }, async () => {
    expect(sendWorkerSessionInput(ds, { type: 'raw_input', data: 'new' } as any)).toBe(true);
  });
  expect(ds.worker.send).toHaveBeenCalledTimes(2);
});

it('stops a busy worker and reports success only after its exit without deleting its session', async () => {
  vi.spyOn(TmuxBackend, 'probeSessionForTeardown').mockReturnValue('missing');
  const ds = session();
  ds.lastScreenStatus = 'working';
  __testOnly_setSuspendBackingVerifier(() => true);
  const worker = ds.worker;
  let exited = false;
  worker.send.mockImplementation((message: any) => {
    if (message.type === 'suspend') queueMicrotask(() => { exited = true; worker.exitCode = 0; worker.emit('exit', 0); });
  });
  expect(await suspendTopicWorkerVerified(ds)).toBe(true);
  expect(exited).toBe(true);
  expect(ds.worker).toBeNull();
  expect(ds.session.status).toBe('active');
  expect(ds.session.suspendedColdResume).toBe(true);
});
