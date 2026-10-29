import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandHomePath as expandHome } from '../utils/working-dir.js';

/** TRAE CLI (traex / traecli) stores config, state DB, sessions, and skills
 *  under TRAE_HOME when set; otherwise it defaults to ~/.trae. Keep this
 *  dynamic so tests and child processes that set TRAE_HOME after module load
 *  still resolve correctly. */
export function traeHome(): string {
  return traeHomeFor(process.env);
}

/** TRAE_HOME as `env` resolves it. A per-bot `env.TRAE_HOME` reaches only the
 *  CLI child, not the worker's own process.env, so anything computed FOR the
 *  child (its sandbox binds) must use the child's env, not traeHome(). */
export function traeHomeFor(env: NodeJS.ProcessEnv): string {
  const configured = env.TRAE_HOME?.trim();
  return configured ? expandHome(configured) : join(homedir(), '.trae');
}

/**
 * A per-bot TRAE_HOME reaches only the CLI child. Under the sandbox the child
 * sees only binds computed from its own TRAE_HOME, so the worker's own readers
 * (state DB / history / rollouts / Gateway config, all via traeHome()) must
 * follow it too, or resume lookup and submit confirmation read a root the CLI
 * never writes. Re-derived from the boot value on every spawn so a removed
 * override does not stick. Unsandboxed sessions and other CLIs: untouched.
 */
export function pinSandboxedTraeHome(env: NodeJS.ProcessEnv, opts: {
  sandboxed: boolean;
  cliId: string;
  perBotEnv: Record<string, string>;
  bootTraeHome: string | undefined;
}): void {
  if (!opts.sandboxed || (opts.cliId !== 'traex' && opts.cliId !== 'coco')) return;
  const value = opts.perBotEnv.TRAE_HOME?.trim() || opts.bootTraeHome;
  if (value) env.TRAE_HOME = value;
  else delete env.TRAE_HOME;
}

/** TraeX and CoCo share the same Codex-compatible TOML configuration. */
export function traeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(traeHomeFor(env), 'traecli.toml');
}

/** TRAE's state root (SQLite DBs, history, sessions) the sandbox binds
 *  read-write for a child running with `env`. */
export function traeCliStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(traeHomeFor(env), 'cli');
}

/** SQLite database holding the `threads` table (one row per interactive
 *  session). Used to reverse-map a botmux session id to a TRAE-native session
 *  UUID (buildArgs/buildResumeCommand) and as the session/path index for
 *  rollout-based transcript bridging. */
export function traeStateDbPath(): string {
  return join(traeHome(), 'cli', 'state_5.sqlite');
}

/** Global submit log — TRAE appends one JSON line (`{session_id, ts, text}`,
 *  byte-identical to Codex's format) here on every successful user submit
 *  across all sessions, AT SUBMIT TIME. This is the authoritative submit-
 *  confirmation source: unlike the per-session rollout JSONL, a message parked
 *  by TRAE's type-ahead queue while a turn is running is written here
 *  immediately, whereas the rollout only records it once the running turn
 *  dequeues it (which can exceed the worker's submit-confirmation deadline and
 *  fire a false "submission couldn't be confirmed" warning). Shared by every
 *  TRAE pane under one TRAE_HOME, so a match needs a pid-ownership filter to
 *  avoid attributing a sibling pane's identical text — mirrors codexHistoryPath. */
export function traeHistoryPath(): string {
  return join(traeHome(), 'cli', 'history.jsonl');
}

/** Per-session rollout JSONL files live under dates here, e.g.
 *  sessions/2026/06/04/rollout-<timestamp>-<uuid>.jsonl. The threads table
 *  stores the absolute path per session. */
export function traeSessionsRoot(): string {
  return join(traeHome(), 'cli', 'sessions');
}
