import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { ExclusiveTopicCoordinator, readTopicExecutionOwner } from '../src/services/exclusive-topic-owner.js';
import { startIpcServer, setIpcAuthSecret, setLarkAppId, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import * as workerPool from '../src/core/worker-pool.js';
import { withBotTurnAdmission } from '../src/core/bot-turn-mutation-gate.js';

let handle: IpcServerHandle | undefined;
let dataDir: string;
const previousDataDir = config.session.dataDir;
const topic = { chatId: 'oc_ipc_topic', rootId: 'om_ipc_topic' };
const secret = 'test-topic-ownership-secret';
beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-topic-ipc-'));
  config.session.dataDir = dataDir;
  setIpcAuthSecret(secret);
  setLarkAppId('a');
  const coordinator = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async () => { throw new Error('pending'); } });
  await coordinator.admit({ ...topic, larkAppId: 'b', selectedAppId: 'b', createdAt: 1, messageId: 'om_select_b' }, async () => {}).catch(() => {});
  handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
});
afterEach(async () => {
  await handle?.close();
  handle = undefined;
  config.session.dataDir = previousDataDir;
  setIpcAuthSecret(null);
  setLarkAppId('');
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});
function ds(root = topic.rootId, app = 'a', epoch?: number): any {
  return { larkAppId: app, session: { sessionId: `sid-${root}-${app}`, status: 'active', chatId: topic.chatId,
    rootMessageId: root, exclusiveTopicOwnerEpoch: epoch }, lastScreenStatus: 'working' };
}
async function post(signed = true, epoch?: number) {
  const path = '/api/topic-ownership/revoke';
  const body = { ...readTopicExecutionOwner(dataDir, topic)!, ...(epoch === undefined ? {} : { epoch }) };
  return fetch(`http://127.0.0.1:${handle!.port}${path}`, { method: 'POST', body: JSON.stringify(body), headers: signed
    ? daemonIpcAuthHeaders({ secret, port: handle!.port, method: 'POST', path, headers: { 'content-type': 'application/json' } })
    : { 'content-type': 'application/json' } });
}

it('rejects unauthenticated and stale handoffs without stopping any worker', async () => {
  const stop = vi.spyOn(workerPool, 'suspendTopicWorkerVerified').mockResolvedValue(true);
  expect((await post(false)).status).toBe(401);
  expect((await post(true, 999)).status).toBe(409);
  expect(stop).not.toHaveBeenCalled();
});

it('stops the exact busy topic before acknowledging while leaving another topic running', async () => {
  const old = ds();
  const another = ds('om_independent_topic');
  vi.spyOn(workerPool, 'listActiveSessions').mockReturnValue([old, another]);
  const stop = vi.spyOn(workerPool, 'suspendTopicWorkerVerified').mockResolvedValue(true);
  const response = await post();
  expect(response.status).toBe(200);
  expect((await response.json()).ok).toBe(true);
  expect(stop).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledWith(old);
});

it('fails the handoff if physical worker retirement cannot be verified', async () => {
  vi.spyOn(workerPool, 'listActiveSessions').mockReturnValue([ds()]);
  vi.spyOn(workerPool, 'suspendTopicWorkerVerified').mockResolvedValue(false);
  const response = await post();
  expect(response.status).toBe(409);
  expect((await response.json()).ok).toBe(false);
});

it('includes a session created while the predecessor admission was draining', async () => {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const live: any[] = [];
  const old = ds();
  vi.spyOn(workerPool, 'listActiveSessions').mockImplementation(() => live);
  const stop = vi.spyOn(workerPool, 'suspendTopicWorkerVerified').mockResolvedValue(true);
  const admission = withBotTurnAdmission('a', async () => { enter(); await blocked; live.push(old); });
  await entered;
  const response = post();
  release();
  await admission;
  expect((await response).status).toBe(200);
  expect(stop).toHaveBeenCalledWith(old);
});

it('retires its own old epoch on A -> B -> A before admitting the returned owner', async () => {
  setLarkAppId('b');
  const old = ds(topic.rootId, 'b', 0);
  const current = ds(topic.rootId, 'b', 1);
  vi.spyOn(workerPool, 'listActiveSessions').mockReturnValue([old, current]);
  const stop = vi.spyOn(workerPool, 'suspendTopicWorkerVerified').mockResolvedValue(true);
  expect((await post()).status).toBe(200);
  expect(stop).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledWith(old);
});
