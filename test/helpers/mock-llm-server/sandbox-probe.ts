/**
 * Sandbox probe for the Feishu live sandbox lane. A prompt
 * `e2e-<tag> SANDBOX_PROBE 请立刻调用 …` makes the synthetic model run one
 * `botmux send` whose reply line carries what the sandboxed shell could see:
 *
 *   ACK-<tag> SBX pid1=isolated home=HIDDEN bots=HIDDEN state=HIDDEN outside=BLOCKED workdir=OK
 *
 * Every check is a fixed shell fragment built here; only the tag (letters,
 * digits, `_`, `-`) and paths this process knows are interpolated, never
 * message text. The mock runs on the same machine as the daemon and the test,
 * so host paths match:
 *
 * - pid1: /proc/1/comm differs from the host's (bwrap's own PID namespace).
 * - home: a canary file under the host home (the test writes it) is not readable.
 * - bots / state: the test bots config and the Feishu login state, both inside
 *   the checkout, are not readable. The sandbox mounts the botmux checkout
 *   read-only, so scripts/run-e2e.ts denies them for sandboxed bots.
 * - outside: writing next to the canary fails.
 * - workdir: writing into the working directory succeeds (the test checks the
 *   file reached the host).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { currentTurnTexts } from './marker-extractor.js';

export const SANDBOX_PROBE_TOKEN = 'SANDBOX_PROBE';

/** The checks a sandboxed session must pass, as they appear in the reply line. */
export const SANDBOX_PROBE_EXPECTED = 'pid1=isolated home=HIDDEN bots=HIDDEN state=HIDDEN outside=BLOCKED workdir=OK';

export function sandboxCanaryDir(home = homedir()): string {
  return path.join(home, 'botmux-sbx-canary');
}

/** Files the sandbox must not read: the bots config and the Feishu login state. */
export function sandboxSecretPaths(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): { bots: string; state: string } {
  return {
    bots: path.resolve(cwd, env.BOTS_CONFIG || 'test-bots.json'),
    state: path.resolve(cwd, 'storageState.json'),
  };
}

const PROBE = /(e2e-[A-Za-z0-9_-]+?-\d{10,})\s+SANDBOX_PROBE\b/;

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

function hostPid1(): string {
  try {
    return readFileSync('/proc/1/comm', 'utf8').trim();
  } catch {
    return '';
  }
}

/** The shell command answering a sandbox probe in the latest turn, or null. */
export function sandboxProbeCommand(messages: unknown[]): string | null {
  if (!Array.isArray(messages)) return null;
  const tag = currentTurnTexts(messages)
    .map((text) => PROBE.exec(text)?.[1])
    .find(Boolean);
  if (!tag) return null;
  const canary = sandboxCanaryDir();
  const { bots, state } = sandboxSecretPaths();
  const checks = [
    `pid1=$([ "$(cat /proc/1/comm 2>/dev/null)" = ${quote(hostPid1())} ] && echo host || echo isolated)`,
    `home=$(cat ${quote(path.join(canary, 'secret.txt'))} >/dev/null 2>&1 && echo READ || echo HIDDEN)`,
    `bots=$([ -r ${quote(bots)} ] && echo READ || echo HIDDEN)`,
    `state=$([ -r ${quote(state)} ] && echo READ || echo HIDDEN)`,
    `outside=$( (echo x > ${quote(path.join(canary, `w-${tag}`))}) 2>/dev/null && echo WROTE || echo BLOCKED)`,
    `workdir=$( (echo ok > ${quote(`./sbx-${tag}`)}) 2>/dev/null && echo OK || echo FAIL)`,
  ];
  return `botmux send --mention-back "ACK-${tag} SBX ${checks.join(' ')}"`;
}
