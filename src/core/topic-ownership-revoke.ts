import type { ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Session } from '../types.js';
import type { TopicIdentity } from '../services/exclusive-topic-owner.js';
import { isLinuxZombie, readProcessStartIdentity } from '../utils/process-identity.js';
import { captureCodexNativeProcesses } from './codex-native-release.js';
import { userSystemdBusEnv } from './session-scope.js';

export interface TopicProcessContainment {
  processes: Array<{ pid: number; start: string }>;
  release(): void;
  retire?(): void;
}

async function containLinuxTopicTree(roots: readonly number[]): Promise<TopicProcessContainment> {
  const environment = userSystemdBusEnv();
  if (!environment) throw new Error('topic containment needs a user systemd bus');
  const unit = `botmux-topic-retire-${process.pid}-${randomUUID()}.scope`;
  const run = (command: string, args: string[]) => execFileSync(command, args, {
    encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', ...environment },
  }).trim();
  const inScope = (pid: number) => {
    try { return readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n').some(line => line.endsWith(`/${unit}`)); }
    catch { return false; }
  };
  const live = [...new Set(roots)].filter(pid => !topicProcessExited(pid, undefined));
  if (live.some(pid => pid === process.pid)) throw new Error('topic containment cannot own the daemon');
  if (!live.length) return { processes: [], release() {} };
  const captured = new Map<number, string>();
  const initial = captureCodexNativeProcesses(live);
  for (const entry of initial) captured.set(entry.pid, entry.started);
  const check = (entries: { pid: number; started: string }[]) => {
    if (entries.some(entry => readProcessStartIdentity(entry.pid) !== entry.started)) {
      throw new Error('topic containment process identity changed');
    }
  };
  check(initial);
  run('busctl', ['--user', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
    'org.freedesktop.systemd1.Manager', 'StartTransientUnit', 'ssa(sv)a(sa(sv))',
    unit, 'fail', '4', 'PIDs', 'au', String(initial.length), ...initial.map(entry => String(entry.pid)),
    'Description', 's', 'botmux topic retirement', 'CollectMode', 's', 'inactive-or-failed',
    'KillSignal', 'i', '9', '0']);
  let retired = false;
  let frozen = false;
  const scopeHasProducers = () => readdirSync('/proc').some(entry => /^\d+$/.test(entry) && inScope(Number(entry)));
  const retire = () => {
    try { run('systemctl', ['--user', 'stop', unit]); }
    catch (error) { if (scopeHasProducers()) throw error; }
    if (scopeHasProducers()) throw new Error('topic containment still has producers after stop');
    retired = true;
  };
  const result = () => ({ processes: [...captured].map(([pid, start]) => ({ pid, start })), release, retire });
  const release = () => {
    if (retired) return;
    try {
      const gone = [...captured].every(([pid, started]) => topicProcessExited(pid, started));
      if (gone) retire();
      else if (frozen) run('systemctl', ['--user', 'thaw', unit]);
    } catch { /* a completed/collected scope no longer exists */ }
  };
  try {
    const deadline = Date.now() + 3_000;
    while (initial.some(entry => !inScope(entry.pid) && !topicProcessExited(entry.pid, entry.started))) {
      if (Date.now() > deadline) throw new Error('topic containment scope did not acquire processes');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    // cgroup-v1 hosts can contain/kill a complete scope without exposing the
    // cgroup-v2 freezer. Freezing is an optimization; verified control-group
    // retirement below remains mandatory and covers late forked children.
    try {
      run('systemctl', ['--user', 'freeze', unit]);
      frozen = run('systemctl', ['--user', 'show', unit, '--property=FreezerState', '--value']) === 'frozen';
    } catch { /* scope containment also works on cgroup v1 */ }
    // Descendants created just before their parent entered the scope may still
    // be outside. Capture and attach them until every owned producer is inside
    // the exact kernel cgroup, which also contains all future descendants.
    for (let attempt = 0; attempt < 4; attempt++) {
      const remaining = live.filter(pid => !topicProcessExited(pid, captured.get(pid)));
      if (!remaining.length) break;
      const snapshot = captureCodexNativeProcesses(remaining);
      for (const entry of snapshot) captured.set(entry.pid, entry.started);
      const outside = snapshot.filter(entry => !inScope(entry.pid));
      if (!outside.length) return result();
      check(outside);
      run('busctl', ['--user', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
        'org.freedesktop.systemd1.Manager', 'AttachProcessesToUnit', 'ssau', unit, '',
        String(outside.length), ...outside.map(entry => String(entry.pid))]);
      if (attempt === 3) throw new Error('topic containment tree did not stabilize');
    }
    return result();
  } catch (error) { release(); throw error; }
}

/** Contain every producer before teardown. Linux uses an exact systemd scope
 * including children forked after the snapshot; other hosts require a stable
 * stopped process tree so teardown cannot create an untracked child. */
export async function containTopicProcessTree(roots: readonly number[]): Promise<TopicProcessContainment> {
  if (process.platform === 'linux') return containLinuxTopicTree(roots);
  const frozen = new Map<number, string>();
  const release = () => {
    for (const [pid, started] of frozen) {
      if (readProcessStartIdentity(pid) !== started) continue;
      try { process.kill(pid, 'SIGCONT'); } catch { /* already exited */ }
    }
  };
  const stop = async (pid: number, started: string) => {
    if (pid === process.pid || readProcessStartIdentity(pid) !== started) throw new Error('topic producer identity changed');
    process.kill(pid, 'SIGSTOP');
    frozen.set(pid, started);
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      if (topicProcessExited(pid, started)) return;
      const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
        encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (state.startsWith('T')) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('topic producer did not freeze');
  };
  try {
    const liveRoots = [...new Set(roots)].filter(pid => !topicProcessExited(pid, undefined));
    for (const pid of liveRoots) {
      const started = readProcessStartIdentity(pid);
      if (!started) throw new Error('topic producer identity unavailable');
      await stop(pid, started);
    }
    for (let attempt = 0; liveRoots.length > 0 && attempt < 4; attempt++) {
      const live = liveRoots.filter(pid => !topicProcessExited(pid, frozen.get(pid)));
      if (!live.length) break;
      const snapshot = captureCodexNativeProcesses(live);
      const newEntries = snapshot.filter(entry => !frozen.has(entry.pid));
      if (!newEntries.length) return { processes: [...frozen].map(([pid, start]) => ({ pid, start })), release };
      for (const entry of newEntries) await stop(entry.pid, entry.started);
      if (attempt === 3) throw new Error('topic producer tree did not stabilize');
    }
    return { processes: [...frozen].map(([pid, start]) => ({ pid, start })), release };
  } catch (error) { release(); throw error; }
}

/** Also retire a legacy flat session that subscribed to this exact topic. */
export function sessionMatchesExclusiveTopic(session: Session, topic: TopicIdentity): boolean {
  return session.status === 'active' && session.chatId === topic.chatId
    && (session.rootMessageId === topic.rootId || !!session.replyThreadAliases?.[topic.rootId]);
}

/** A successful signal is not proof of exit. Only the child exit event or a
 * positively changed process identity admits the successor. */
export async function waitForTopicWorkerExit(worker: ChildProcess, timeoutMs = 8_000): Promise<boolean> {
  if (worker.exitCode !== null || worker.signalCode !== null) return true;
  return new Promise(resolve => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(term);
      clearTimeout(kill);
      clearTimeout(deadline);
      worker.off('exit', onExit);
      resolve(ok);
    };
    const onExit = () => finish(true);
    const term = setTimeout(() => { try { worker.kill('SIGTERM'); } catch { /* wait for exit */ } }, Math.min(1_500, timeoutMs / 3));
    const kill = setTimeout(() => { try { worker.kill('SIGKILL'); } catch { /* wait for exit */ } }, Math.min(4_000, timeoutMs * 2 / 3));
    const deadline = setTimeout(() => finish(false), timeoutMs);
    worker.once('exit', onExit);
    if (worker.exitCode !== null || worker.signalCode !== null) finish(true);
  });
}

export function topicProcessExited(pid: number, started: string | undefined): boolean {
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  if (isLinuxZombie(pid)) return true;
  const now = readProcessStartIdentity(pid);
  return !!started && !!now && now !== started;
}
