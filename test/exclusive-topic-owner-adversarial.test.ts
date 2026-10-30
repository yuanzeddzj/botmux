import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, type ChildProcess } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnTsEval, spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(), cleanupSessionBridgeSendMarkersNow: vi.fn(),
  updateSessionPid: vi.fn(), updateSession: vi.fn(), listSessions: vi.fn(() => []), readBotSessionsStrict: vi.fn(() => []),
}));
vi.mock('../src/core/dashboard-events.js', () => ({ dashboardEventBus: { publish: vi.fn() } }));
vi.mock('../src/utils/logger.js', () => ({ logger: {
  debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn(),
} }));

import { config } from '../src/config.js';
import * as registry from '../src/bot-registry.js';
import {
  ExclusiveTopicCoordinator, currentTopicExecutionContext, readTopicExecutionOwner,
  readTopicSelection, topicExecutionAllowed, type ExclusiveTopicInput,
} from '../src/services/exclusive-topic-owner.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import * as processIdentity from '../src/utils/process-identity.js';
import {
  __testOnly_resetOrdinaryImDeliveries, __testOnly_resetRestartCoordinator,
  sendWorkerInput, sendWorkerSessionInput, requestSessionRestart, suspendTopicWorkerVerified, forkWorker, setActiveSessionsRegistry,
} from '../src/core/worker-pool.js';
import { createExclusiveTopicRuntime } from '../src/core/exclusive-topic-runtime.js';
import { setIpcAuthSecret, setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { withBotTurnAdmission, __testOnly_resetBotTurnMutationGates } from '../src/core/bot-turn-mutation-gate.js';
import { loadOrCreateDashboardSecret } from '../src/dashboard/auth.js';
import { logger } from '../src/utils/logger.js';
import * as ipcAuth from '../src/core/daemon-ipc-auth.js';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { containTopicProcessTree, topicProcessExited } from '../src/core/topic-ownership-revoke.js';
import { userSystemdBusEnv } from '../src/core/session-scope.js';

const topic = { chatId: 'oc_attack_chat', rootId: 'om_attack_root' };
const event = (app: string, createdAt: number, selected = true, rootId = topic.rootId): ExclusiveTopicInput => ({
  ...topic, rootId, larkAppId: app, createdAt, messageId: `om_attack_${createdAt}`,
  ...(selected ? { selectedAppId: app } : {}),
});
let dataDir: string;
let previousDataDir: string;
const children = new Set<ChildProcess>();
let ipc: IpcServerHandle | undefined;
const tmuxSockets = new Set<string>();
const extraPids = new Set<number>();
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'bmx-owner-attack-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = dataDir;
  const bots = ['a', 'b', 'c'].map(larkAppId => ({ config: {
    larkAppId, cliId: 'claude-code', backendType: 'pty', exclusiveTopicOwner: true,
  } }));
  vi.spyOn(registry, 'getAllBots').mockReturnValue(bots as any);
  vi.spyOn(registry, 'getBot').mockImplementation(app => bots.find(bot => bot.config.larkAppId === app) as any);
});
afterEach(async () => {
  vi.useRealTimers();
  __testOnly_resetOrdinaryImDeliveries();
  __testOnly_resetRestartCoordinator();
  if (ipc) await ipc.close();
  ipc = undefined;
  setActiveSessionsRegistry(undefined);
  setIpcAuthSecret(null);
  setLarkAppId('');
  __testOnly_resetBotTurnMutationGates();
  for (const socket of tmuxSockets) {
    try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore', env: privateTmuxEnv(process.env.TMUX_TMPDIR!) }); }
    catch { /* server already stopped */ }
  }
  tmuxSockets.clear();
  for (const pid of extraPids) { try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ } }
  extraPids.clear();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
    }
  }
  children.clear();
  vi.restoreAllMocks();
  config.session.dataDir = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

async function workerProbe(options: { closeExits?: boolean } = {}) {
  const worker = spawnTsEval(`
    process.on('message', message => {
      console.log(JSON.stringify(message));
      if (message.type === 'close' && ${options.closeExits !== false}) process.exit(0);
    });
    setInterval(() => {}, 1000);
    console.log('READY');
  `, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.add(worker);
  let output = '';
  await new Promise<void>((resolve, reject) => {
    worker.once('error', reject);
    worker.stdout!.on('data', chunk => {
      output += chunk;
      if (output.includes('READY')) resolve();
    });
    worker.once('exit', code => { if (!output.includes('READY')) reject(new Error(`probe exited ${code}`)); });
  });
  return { worker, output: () => output };
}

function session(worker: ChildProcess, rootId = topic.rootId): any {
  return {
    larkAppId: 'a', chatId: topic.chatId, chatType: 'group', scope: 'thread',
    worker, workerGeneration: 1, workerReady: true, cliReady: true,
    initConfig: { cliId: 'claude-code', backendType: 'pty' },
    session: { sessionId: `sid-${rootId}`, rootMessageId: rootId, chatId: topic.chatId,
      scope: 'thread', cliId: 'claude-code', backendType: 'pty', status: 'active', workerGeneration: 1 },
    localProcessAttestation: { cliPid: worker.pid, cliProcStart: readProcessStartIdentity(worker.pid!) },
  };
}

describe('exclusive owner adversarial execution probes', () => {
  it('retires an attested live PTY process before B runs while preserving its logical session', async () => {
    const probe = await workerProbe();
    const ds = session(probe.worker);
    const coordinator = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async owner => {
      if (owner.ownerAppId === 'b' && !await suspendTopicWorkerVerified(ds)) throw new Error('retirement unverified');
    } });
    await coordinator.admit(event('a', 1), async () => {
      expect(sendWorkerSessionInput(ds, { type: 'set_display_mode', mode: 'compact' } as any)).toBe(true);
    });
    const bAction = vi.fn(async () => {
      expect(probe.worker.exitCode !== null || probe.worker.signalCode !== null).toBe(true);
    });
    expect(await coordinator.admit(event('b', 2), bAction)).toBe(true);
    expect(bAction).toHaveBeenCalledOnce();
    expect(ds.session.status).toBe('active');
    expect(ds.session.suspendedColdResume).toBe(true);
    expect(ds.worker).toBeNull();
  });

  it('does not authorize B when worker exit leaves a CLI whose process identity cannot be verified', async () => {
    const worker = await workerProbe();
    const cli = await workerProbe();
    const ds = session(worker.worker);
    ds.localProcessAttestation = { cliPid: cli.worker.pid, cliProcStart: readProcessStartIdentity(cli.worker.pid!) };
    const actualReadIdentity = processIdentity.readProcessStartIdentity;
    const identity = vi.spyOn(processIdentity, 'readProcessStartIdentity').mockImplementation(pid =>
      pid === cli.worker.pid ? undefined : actualReadIdentity(pid));
    const coordinator = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async owner => {
      if (owner.ownerAppId === 'b' && !await suspendTopicWorkerVerified(ds)) throw new Error('retirement unverified');
    } });
    await coordinator.admit(event('a', 1), async () => {});
    const bAction = vi.fn(async () => {});
    await expect(coordinator.admit(event('b', 2), bAction)).rejects.toThrow('retirement unverified');
    expect(bAction).not.toHaveBeenCalled();
    expect(readTopicExecutionOwner(dataDir, topic)?.phase).toBe('handoff');
    expect(topicExecutionAllowed(dataDir, { ...topic, larkAppId: 'b' })).toBe(false);
    expect(() => process.kill(cli.worker.pid!, 0)).not.toThrow();
    const exited = new Promise<void>(resolve => cli.worker.once('exit', () => resolve()));
    cli.worker.kill('SIGKILL');
    await exited;
    identity.mockRestore();
    const restarted = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async () => {
      if (!await suspendTopicWorkerVerified(ds)) throw new Error('retirement unverified');
    } });
    expect(await restarted.admit(event('b', 3, false), bAction)).toBe(true);
  });

  it('revokes a tracked input retry when @B arrives before its transport callback timeout', async () => {
    const probe = await workerProbe();
    const ds = session(probe.worker);
    const coordinator = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async () => {} });
    await coordinator.admit(event('a', 1), async () => {
      ds.session.exclusiveTopicOwnerEpoch = currentTopicExecutionContext()!.epoch;
    });
    // The real child receives the payload. Hold transport completion to expose
    // the production retry timer before predecessor teardown has acquired its gate.
    const actualSend = probe.worker.send.bind(probe.worker);
    const send = vi.spyOn(probe.worker, 'send').mockImplementation(((message: any) => actualSend(message)) as any);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    expect(sendWorkerInput(ds, 'old ordinary turn', 'om_attack_pending')).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    await coordinator.select(event('b', 2));
    expect(sendWorkerSessionInput(ds, { type: 'set_display_mode', mode: 'compact' } as any)).toBe(false);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(send, 'no old-owner retry may cross worker IPC after the new selection').toHaveBeenCalledTimes(1);
  });

  it('refuses an in-worker restart requested after @B has revoked A', async () => {
    const probe = await workerProbe();
    const ds = session(probe.worker);
    const coordinator = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async () => {} });
    await coordinator.admit(event('a', 1), async () => { ds.session.exclusiveTopicOwnerEpoch = currentTopicExecutionContext()!.epoch; });
    await coordinator.select(event('b', 2));
    const send = vi.spyOn(probe.worker, 'send');
    requestSessionRestart(ds, { source: 'dashboard' } as any);
    expect(send, 'restart starts a CLI generation and needs the same owner admission').not.toHaveBeenCalled();
  });

  it('rejects a delayed old-A callback after A -> B -> A, while a current A callback can send', async () => {
    const old = await workerProbe();
    const oldDs = session(old.worker);
    const coordinator = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async () => {} });
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    let oldResult!: Promise<boolean>;
    await coordinator.admit(event('a', 1), async () => {
      oldDs.session.exclusiveTopicOwnerEpoch = currentTopicExecutionContext()!.epoch;
      oldResult = delayed.then(() => sendWorkerSessionInput(oldDs, { type: 'set_display_mode', mode: 'compact' } as any));
    });
    await coordinator.admit(event('b', 2), async () => {});
    await coordinator.admit(event('a', 3), async () => {
      expect(sendWorkerSessionInput(oldDs, { type: 'set_display_mode', mode: 'compact' } as any)).toBe(true);
    });
    release();
    expect(await oldResult).toBe(false);
  });

  it('allows an independent topic while a handoff waits, and skips an intermediate B after @C', async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const delayed = new Promise<void>(resolve => { release = resolve; });
    const coordinator = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async owner => {
      if (owner.ownerAppId === 'b' && owner.rootId === topic.rootId) { enter(); await delayed; }
    } });
    await coordinator.admit(event('a', 1), async () => {});
    const bAction = vi.fn(async () => {});
    const b = coordinator.admit(event('b', 2), bAction);
    await entered;
    const independent = vi.fn(async () => {});
    expect(await coordinator.admit(event('b', 3, true, 'om_attack_independent'), independent)).toBe(true);
    expect(independent).toHaveBeenCalledOnce();
    await coordinator.select(event('c', 4));
    release();
    expect(await b).toBe(false);
    expect(bAction).not.toHaveBeenCalled();
    expect(readTopicSelection(dataDir, topic)?.ownerAppId).toBe('c');
    expect(await coordinator.admit(event('c', 5, false), async () => {})).toBe(true);
  });

  it('keeps legacy thread restore and delayed starts blocked until a shared admission exists', async () => {
    const ds = session({} as ChildProcess);
    ds.worker = null;
    ds.localProcessAttestation = undefined;
    ds.workerReady = false;
    ds.cliReady = false;
    const onAdmission = vi.fn();
    expect(forkWorker(ds, '', true, { reattachLiveBackend: true, onAdmission })).toBe(false);
    expect(onAdmission).toHaveBeenLastCalledWith('rejected');
    const c = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async () => {} });
    await c.admit(event('b', 1), async () => {});
    expect(forkWorker(ds, 'late saved activation', true, { onAdmission })).toBe(false);
    expect(ds.worker).toBeNull();
    expect(sendWorkerInput(ds, 'late saved activation', 'om_attack_legacy')).toBe(false);
  });

  it('retires a legacy session created while real host IPC waits for its bot admission to drain', async () => {
    const old = await workerProbe();
    const independent = await workerProbe();
    const ds = session(old.worker);
    const other = session(independent.worker, 'om_attack_untouched');
    const active = new Map<string, any>([['independent', other]]);
    setActiveSessionsRegistry(active);
    setLarkAppId('a');
    const secret = loadOrCreateDashboardSecret(join(homedir(), '.botmux', '.dashboard-secret'));
    setIpcAuthSecret(secret);
    ipc = await startIpcServer({ host: '127.0.0.1', port: 0, authRequired: true });
    const actualFetch = ipcAuth.fetchDaemonIpc;
    vi.spyOn(ipcAuth, 'fetchDaemonIpc').mockImplementation(async (...args) => {
      const response = await actualFetch(...args);
      if (!response.ok) console.error('IPC probe response', response.status, await response.clone().text());
      return response;
    });
    mkdirSync(join(dataDir, 'dashboard-daemons'), { recursive: true });
    writeFileSync(join(dataDir, 'dashboard-daemons', 'a.json'), JSON.stringify({
      larkAppId: 'a', ipcPort: ipc.port, pid: process.pid, lastHeartbeat: Date.now(),
    }));
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const oldPreparation = withBotTurnAdmission('a', async () => {
      enter();
      await held;
      active.set('late-legacy-topic', ds);
    });
    await entered;
    const runtime = createExclusiveTopicRuntime();
    const action = vi.fn(async () => {
      expect(old.worker.exitCode !== null || old.worker.signalCode !== null).toBe(true);
      expect(() => process.kill(independent.worker.pid!, 0)).not.toThrow();
    });
    const admission = runtime.admit(event('b', 1), action);
    // Real IPC reaches the mutation gate while the old admission is held.
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(action).not.toHaveBeenCalled();
    release();
    await oldPreparation;
    const result = await admission.catch(error => {
      console.error('IPC probe logs', JSON.stringify(vi.mocked(logger.warn).mock.calls));
      throw error;
    });
    expect(result).toBe(true);
    expect(action).toHaveBeenCalledOnce();
    expect(ds.worker).toBeNull();
    expect(other.worker).toBe(independent.worker);
  });

  it.skipIf(process.platform !== 'linux')('retires the restored tmux CLI that ignores HUP before B runs and leaves unrelated panes alive', async () => {
    const socket = `owner-attack-${process.pid}`;
    tmuxSockets.add(socket);
    const env = privateTmuxEnv(process.env.TMUX_TMPDIR!);
    const run = (args: string[]) => execFileSync('tmux', ['-L', socket, ...args], { env, encoding: 'utf8' }).trim();
    const name = TmuxBackend.sessionName('restore-owner-attack');
    const otherName = 'unrelated-topic';
    run(['new-session', '-d', '-s', otherName, 'sleep', '60']);
    const otherPid = Number(run(['display-message', '-p', '-t', otherName, '#{pane_pid}']));
    extraPids.add(otherPid);
    const pidFile = join(dataDir, 'restored-cli.pid');
    run(['new-session', '-d', '-s', name, '/bin/sh', '-c', 'trap "" HUP; printf "%s" "$$" > "$1"; exec sleep 60', 'probe', pidFile]);
    let pid = 0;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { pid = Number((await import('node:fs')).readFileSync(pidFile, 'utf8')); } catch { /* start pending */ }
      if (pid > 1) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(pid).toBeGreaterThan(1);
    extraPids.add(pid);
    const start = readProcessStartIdentity(pid);
    const ds: any = {
      larkAppId: 'a', chatId: topic.chatId, chatType: 'group', scope: 'thread', worker: null,
      initConfig: { cliId: 'claude-code', backendType: 'tmux' },
      session: { sessionId: 'restore-owner-attack', rootMessageId: topic.rootId,
        chatId: topic.chatId, scope: 'thread', cliId: 'claude-code', backendType: 'tmux', status: 'active',
        persistentBackendTarget: { backendType: 'tmux', sessionName: name, socketName: socket } },
    };
    const coordinator = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async owner => {
      if (owner.ownerAppId === 'b' && !await suspendTopicWorkerVerified(ds)) throw new Error('retirement unverified');
    } });
    await coordinator.admit(event('a', 1), async () => {});
    const bAction = vi.fn(async () => {
      expect(topicProcessExited(pid, start), 'the old CLI must already be dead at the new execution boundary').toBe(true);
      expect(() => process.kill(otherPid, 0)).not.toThrow();
    });
    const accepted = await coordinator.admit(event('b', 2), bAction);
    expect(TmuxBackend.probeSession(name, socket)).toBe('missing');
    expect(topicProcessExited(pid, start)).toBe(true);
    expect(accepted).toBe(true);
    expect(bAction).toHaveBeenCalledOnce();
    expect(TmuxBackend.probeSession(otherName, socket)).toBe('exists');
  });

  it.skipIf(process.platform !== 'linux')('contains and retires only the owned topic scope while another pane on the same tmux server runs', async () => {
    const socket = `owner-attack-scope-${process.pid}`;
    tmuxSockets.add(socket);
    const env = privateTmuxEnv(process.env.TMUX_TMPDIR!);
    const run = (args: string[]) => execFileSync('tmux', ['-L', socket, ...args], { env, encoding: 'utf8' }).trim();
    run(['new-session', '-d', '-s', 'owned-topic', 'sleep', '60']);
    run(['new-session', '-d', '-s', 'other-topic', 'sleep', '60']);
    const ownedPid = Number(run(['display-message', '-p', '-t', 'owned-topic', '#{pane_pid}']));
    const otherPid = Number(run(['display-message', '-p', '-t', 'other-topic', '#{pane_pid}']));
    const serverPid = Number(run(['display-message', '-p', '#{pid}']));
    for (const pid of [ownedPid, otherPid]) extraPids.add(pid);
    const before = readFileSync(`/proc/${otherPid}/cgroup`, 'utf8');
    const serverBefore = readFileSync(`/proc/${serverPid}/cgroup`, 'utf8');
    const daemonBefore = readFileSync(`/proc/${process.pid}/cgroup`, 'utf8');
    const ownedStart = readProcessStartIdentity(ownedPid);
    const contained = await containTopicProcessTree([ownedPid]);
    const placements = readFileSync(`/proc/${ownedPid}/cgroup`, 'utf8').trim().split('\n').map(line => line.split(':'));
    const cgroup = (placements.find(parts => parts[1] === '') ?? placements.find(parts => parts[1] === 'name=systemd'))![2]!;
    const unit = cgroup.split('/').at(-1)!;
    const unified = placements.find(parts => parts[1] === '');
    const kernelPath = unified ? `/sys/fs/cgroup${cgroup}` : `/sys/fs/cgroup/systemd${cgroup}`;
    const members = () => {
      try { return readFileSync(`${kernelPath}/cgroup.procs`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    };
    try {
      expect(unit).toMatch(/^botmux-topic-retire-.*\.scope$/);
      const actualMembers = members();
      expect(actualMembers).toEqual([ownedPid]);
      for (const pid of [otherPid, serverPid, process.pid]) expect(actualMembers).not.toContain(pid);
      expect(readFileSync(`/proc/${otherPid}/cgroup`, 'utf8')).toBe(before);
      expect(readFileSync(`/proc/${serverPid}/cgroup`, 'utf8')).toBe(serverBefore);
      expect(readFileSync(`/proc/${process.pid}/cgroup`, 'utf8')).toBe(daemonBefore);
      expect(() => process.kill(otherPid, 0)).not.toThrow();
      expect(TmuxBackend.probeSession('other-topic', socket)).toBe('exists');
      expect(contained.processes.map(entry => entry.pid)).toContain(ownedPid);
      expect(contained.retire).toBeTypeOf('function');
      contained.retire!();
      expect(topicProcessExited(ownedPid, ownedStart)).toBe(true);
      expect(members()).toEqual([]);
      expect(readFileSync(`/proc/${otherPid}/cgroup`, 'utf8')).toBe(before);
      expect(readFileSync(`/proc/${serverPid}/cgroup`, 'utf8')).toBe(serverBefore);
      expect(readFileSync(`/proc/${process.pid}/cgroup`, 'utf8')).toBe(daemonBefore);
    } finally {
      contained.release();
      if (/^botmux-topic-retire-.*\.scope$/.test(unit)) {
        try { execFileSync('systemctl', ['--user', 'stop', unit], { env: { ...process.env, ...userSystemdBusEnv() }, stdio: 'ignore' }); }
        catch { /* scope already collected */ }
      }
    }
    expect(TmuxBackend.probeSession('other-topic', socket)).toBe('exists');
  });

  it('recovers after a real coordinator process crashes with selection and handoff written before retirement', async () => {
    const old = await workerProbe();
    const ds = session(old.worker);
    const coordinator = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async () => {} });
    await coordinator.admit(event('a', 1), async () => {});
    const crashed = spawnTsEvalWithRepoImports(`
      import { ExclusiveTopicCoordinator } from './src/services/exclusive-topic-owner.js';
      const coordinator = new ExclusiveTopicCoordinator({
        dataDir: ${JSON.stringify(dataDir)},
        revokeOtherBots: async () => process.exit(79),
      });
      await coordinator.admit(${JSON.stringify(event('b', 2))}, async () => process.exit(80));
    `, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(crashed);
    const code = await new Promise<number | null>(resolve => crashed.once('exit', resolve));
    expect(code).toBe(79);
    expect(readTopicSelection(dataDir, topic)?.ownerAppId).toBe('b');
    expect(readTopicExecutionOwner(dataDir, topic)?.phase).toBe('handoff');
    expect(topicExecutionAllowed(dataDir, { ...topic, larkAppId: 'a' })).toBe(false);
    expect(topicExecutionAllowed(dataDir, { ...topic, larkAppId: 'b' })).toBe(false);
    expect(() => process.kill(old.worker.pid!, 0)).not.toThrow();
    const restarted = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async () => {
      if (!await suspendTopicWorkerVerified(ds)) throw new Error('retirement unverified');
    } });
    const action = vi.fn(async () => {
      expect(old.worker.exitCode !== null || old.worker.signalCode !== null).toBe(true);
    });
    expect(await restarted.admit(event('b', 3, false), action)).toBe(true);
    expect(action).toHaveBeenCalledOnce();
  });

  it('keeps a missing restored tmux pane blocked when no CLI identity or previous retirement proof exists', async () => {
    const unknownCli = await workerProbe();
    const socket = `owner-attack-missing-${process.pid}`;
    tmuxSockets.add(socket);
    execFileSync('tmux', ['-L', socket, 'new-session', '-d', '-s', 'another-topic', 'sleep', '60'], {
      env: privateTmuxEnv(process.env.TMUX_TMPDIR!),
    });
    const ds: any = {
      larkAppId: 'a', chatId: topic.chatId, chatType: 'group', worker: null,
      initConfig: { backendType: 'tmux' },
      session: { sessionId: 'missing-restored', status: 'active', chatId: topic.chatId, rootMessageId: topic.rootId,
        backendType: 'tmux', persistentBackendTarget: { backendType: 'tmux', sessionName: 'already-missing', socketName: socket } },
    };
    const coordinator = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async owner => {
      if (owner.ownerAppId === 'b' && !await suspendTopicWorkerVerified(ds)) throw new Error('retirement unverified');
    } });
    await coordinator.admit(event('a', 1), async () => {});
    const action = vi.fn(async () => {});
    await expect(coordinator.admit(event('b', 2), action)).rejects.toThrow('retirement unverified');
    expect(action).not.toHaveBeenCalled();
    expect(readTopicExecutionOwner(dataDir, topic)?.phase).toBe('handoff');
    expect(() => process.kill(unknownCli.worker.pid!, 0)).not.toThrow();
  });

  it('does not admit B if the old CLI creates a late background child while its tmux pane is being torn down', async () => {
    const socket = `owner-attack-late-${process.pid}`;
    tmuxSockets.add(socket);
    const env = privateTmuxEnv(process.env.TMUX_TMPDIR!);
    const run = (args: string[]) => execFileSync('tmux', ['-L', socket, ...args], { env, encoding: 'utf8' }).trim();
    const name = 'late-child-owner';
    const latePidFile = join(dataDir, 'late-child.pid');
    const rootPidFile = join(dataDir, 'late-root.pid');
    run(['new-session', '-d', '-s', name, '/bin/sh', '-c',
      'trap \'trap "" HUP; sleep 60 >/dev/null 2>&1 </dev/null & printf "%s" "$!" > "$1"; exit 0\' HUP; printf "%s" "$$" > "$2"; while :; do sleep 60 & wait "$!"; done',
      'probe', latePidFile, rootPidFile]);
    let rootPid = 0;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { rootPid = Number((await import('node:fs')).readFileSync(rootPidFile, 'utf8')); } catch { /* start pending */ }
      if (rootPid > 1) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(rootPid).toBeGreaterThan(1);
    extraPids.add(rootPid);
    const ds: any = {
      larkAppId: 'a', chatId: topic.chatId, chatType: 'group', worker: null,
      initConfig: { backendType: 'tmux' },
      session: { sessionId: 'late-child-owner', status: 'active', chatId: topic.chatId, rootMessageId: topic.rootId,
        backendType: 'tmux', persistentBackendTarget: { backendType: 'tmux', sessionName: name, socketName: socket } },
    };
    const coordinator = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async owner => {
      if (owner.ownerAppId === 'b' && !await suspendTopicWorkerVerified(ds)) throw new Error('retirement unverified');
    } });
    await coordinator.admit(event('a', 1), async () => {});
    const action = vi.fn(async () => {});
    const accepted = await coordinator.admit(event('b', 2), action).catch(() => false);
    let latePid = 0;
    try { latePid = Number((await import('node:fs')).readFileSync(latePidFile, 'utf8')); } catch { /* HUP handler did not fork */ }
    if (latePid > 1) extraPids.add(latePid);
    const lateAlive = latePid > 1 && !topicProcessExited(latePid, readProcessStartIdentity(latePid));
    expect(accepted && lateAlive, `accepted=${accepted}, late child=${latePid}, alive=${lateAlive}`).toBe(false);
  });

  it.skipIf(process.platform !== 'linux')('does not admit B when a child is born before its root enters the scope and the root exits before rescan', async () => {
    const childPidFile = join(dataDir, 'before-scope-child.pid');
    const root = spawnTsEvalWithRepoImports(`
      import { writeFileSync } from 'node:fs';
      import { spawnTsEval } from './test/helpers/ts-runner.js';
      process.on('message', message => {
        if (message.type === 'spawn-before-scope') {
          const child = spawnTsEval('setInterval(() => {}, 1000)', {stdio: 'ignore'});
          writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
        } else if (message.type === 'exit-after-scope') process.exit(0);
      });
      setInterval(() => {}, 1000);
      console.log('READY');
    `, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.add(root);
    await new Promise<void>((resolve, reject) => {
      root.once('error', reject);
      root.stdout!.on('data', chunk => { if (String(chunk).includes('READY')) resolve(); });
    });
    const ds = session(root);
    const actualExec = childProcess.execFileSync;
    let outsideChild = 0;
    let intercepted = false;
    vi.spyOn(childProcess, 'execFileSync').mockImplementation(((command: any, args: any, options: any) => {
      if (command !== 'busctl' || !args?.includes('StartTransientUnit') || intercepted) return actualExec(command, args, options);
      intercepted = true;
      root.send({ type: 'spawn-before-scope' });
      for (let attempt = 0; attempt < 200; attempt++) {
        try { outsideChild = Number(readFileSync(childPidFile, 'utf8')); } catch { /* other process preparing */ }
        if (outsideChild > 1) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      if (outsideChild <= 1) throw new Error('child probe did not start');
      extraPids.add(outsideChild);
      const result = actualExec(command, args, options);
      root.send({ type: 'exit-after-scope' });
      for (let attempt = 0; attempt < 200 && !topicProcessExited(root.pid!, undefined); attempt++) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      return result;
    }) as any);
    const coordinator = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async owner => {
      if (owner.ownerAppId === 'b' && !await suspendTopicWorkerVerified(ds)) throw new Error('retirement unverified');
    } });
    await coordinator.admit(event('a', 1), async () => {});
    const action = vi.fn(async () => {});
    const accepted = await coordinator.admit(event('b', 2), action).catch(() => false);
    const retry = await coordinator.admit(event('b', 3, false), action).catch(() => false);
    // A daemon restore retains the Session but loses its worker descriptor and
    // process attestation. The unresolved child must not become a fresh proof.
    const restoredDs = { ...ds, session: { ...ds.session }, worker: null, workerReady: false, cliReady: false,
      localProcessAttestation: undefined };
    const restored = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async () => {
      if (!await suspendTopicWorkerVerified(restoredDs)) throw new Error('retirement unverified');
    } });
    const afterRestore = await restored.admit(event('b', 4, false), action).catch(() => false);
    expect(intercepted).toBe(true);
    expect(outsideChild).toBeGreaterThan(1);
    const childAlive = !topicProcessExited(outsideChild, readProcessStartIdentity(outsideChild));
    expect(accepted && childAlive, `accepted=${accepted}, outside child=${outsideChild}, alive=${childAlive}`).toBe(false);
    expect(retry && childAlive, 'another bare B input must not clear an unresolved retirement').toBe(false);
    expect(afterRestore && childAlive, 'coordinator and daemon restoration must retain the unresolved retirement').toBe(false);
  });
});
