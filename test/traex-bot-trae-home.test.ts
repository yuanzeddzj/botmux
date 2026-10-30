import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinWorkerTraeHome } from '../src/services/traex-paths.js';
import { traexResumeTargetLeftInDefaultHome } from '../src/services/traex-transcript.js';
import { t } from '../src/i18n/index.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

describe('pinWorkerTraeHome', () => {
  const pin = (env: NodeJS.ProcessEnv, opts: Partial<Parameters<typeof pinWorkerTraeHome>[1]> = {}) => {
    pinWorkerTraeHome(env, { cliId: 'traex', adoptMode: false, perBotEnv: {}, bootTraeHome: undefined, ...opts });
    return env;
  };

  it.each(['traex', 'coco'])('makes the %s worker read the bot TRAE_HOME', cliId => {
    expect(pin({}, { cliId, perBotEnv: { TRAE_HOME: '/srv/bot-a/trae' } }).TRAE_HOME).toBe('/srv/bot-a/trae');
  });

  it('leaves a bot without its own TRAE_HOME exactly as inherited', () => {
    expect(pin({ TRAE_HOME: '/fleet/trae' }, { bootTraeHome: '/fleet/trae' })).toEqual({ TRAE_HOME: '/fleet/trae' });
    expect(pin({})).toEqual({});
  });

  it('leaves adopted panes and other CLIs alone', () => {
    expect(pin({}, { adoptMode: true, perBotEnv: { TRAE_HOME: '/srv/bot-a/trae' } }).TRAE_HOME).toBeUndefined();
    expect(pin({}, { cliId: 'codex', perBotEnv: { TRAE_HOME: '/srv/bot-a/trae' } }).TRAE_HOME).toBeUndefined();
  });

  it('returns to the inherited value once the per-bot override is gone', () => {
    // A previous spawn pinned the override (or a scratch view of it).
    expect(pin({ TRAE_HOME: '/srv/bot-a/trae' }, { bootTraeHome: '/fleet/trae' }).TRAE_HOME).toBe('/fleet/trae');
    const unset = pin({ TRAE_HOME: '/srv/bot-a/trae' });
    expect('TRAE_HOME' in unset).toBe(false);
  });
});

describe('resume target left in the default ~/.trae', () => {
  const SID = '00000000-0000-7000-8000-0000000000aa';
  let root: string;
  let previous: { HOME?: string; TRAE_HOME?: string };
  const writeRollout = (traeRoot: string) => {
    const day = join(traeRoot, 'cli', 'sessions', '2026', '06', '04');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, `rollout-2026-06-04T12-00-00-${SID}.jsonl`), '{}\n');
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'trae-default-home-'));
    previous = { HOME: process.env.HOME, TRAE_HOME: process.env.TRAE_HOME };
    process.env.HOME = join(root, 'home');
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('reports a session that only the default root holds, and restores TRAE_HOME', () => {
    writeRollout(join(root, 'home', '.trae'));
    process.env.TRAE_HOME = join(root, 'bot-trae');
    expect(traexResumeTargetLeftInDefaultHome(SID)).toBe(join(root, 'home', '.trae'));
    expect(process.env.TRAE_HOME).toBe(join(root, 'bot-trae'));
  });

  it('stays quiet when the bot TRAE_HOME has the session', () => {
    writeRollout(join(root, 'home', '.trae'));
    writeRollout(join(root, 'bot-trae'));
    process.env.TRAE_HOME = join(root, 'bot-trae');
    expect(traexResumeTargetLeftInDefaultHome(SID)).toBeUndefined();
  });

  it('stays quiet without a TRAE_HOME override', () => {
    writeRollout(join(root, 'home', '.trae'));
    delete process.env.TRAE_HOME;
    expect(traexResumeTargetLeftInDefaultHome(SID)).toBeUndefined();
  });

  it('notifies the topic once per worker', () => {
    writeRollout(join(root, 'home', '.trae'));
    process.env.TRAE_HOME = join(root, 'bot-trae');
    const scope = {
      traexDefaultHomeResumeNoticeSent: false,
      traexResumeTargetLeftInDefaultHome,
      send: vi.fn(), log: vi.fn(), t, process, currentBotmuxTurnId: 'turn-1',
    };
    const note = loadWorkerFunction<(sid: string) => void>('noteTraexResumeTargetLeftInDefaultHome', scope);
    note(SID);
    note(SID);
    expect(scope.send).toHaveBeenCalledOnce();
    expect(scope.send.mock.calls[0]![0]).toMatchObject({ type: 'user_notify', turnId: 'turn-1' });
    expect(scope.send.mock.calls[0]![0].message).toContain(SID);
  });
});
