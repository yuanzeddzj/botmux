import { describe, it, expect } from 'vitest';
import { pinSandboxedTraeHome } from '../src/services/traex-paths.js';

describe('pinSandboxedTraeHome', () => {
  const pin = (env: NodeJS.ProcessEnv, opts: Partial<Parameters<typeof pinSandboxedTraeHome>[1]> = {}) => {
    pinSandboxedTraeHome(env, { sandboxed: true, cliId: 'traex', perBotEnv: {}, bootTraeHome: undefined, ...opts });
    return env.TRAE_HOME;
  };

  it.each(['traex', 'coco'])('makes a sandboxed %s worker read the bot TRAE_HOME', cliId => {
    expect(pin({}, { cliId, perBotEnv: { TRAE_HOME: '/srv/bot-a/trae' } })).toBe('/srv/bot-a/trae');
  });

  it('leaves unsandboxed sessions exactly as inherited', () => {
    const env: NodeJS.ProcessEnv = { TRAE_HOME: '/fleet/trae' };
    expect(pin(env, { sandboxed: false, perBotEnv: { TRAE_HOME: '/srv/bot-a/trae' } })).toBe('/fleet/trae');
  });

  it('leaves other CLIs alone', () => {
    expect(pin({}, { cliId: 'codex', perBotEnv: { TRAE_HOME: '/srv/bot-a/trae' } })).toBeUndefined();
  });

  it('returns to the inherited value once the per-bot override is gone', () => {
    // A previous spawn pinned the override (or a scratch view of it).
    const env: NodeJS.ProcessEnv = { TRAE_HOME: '/srv/bot-a/trae' };
    expect(pin(env, { bootTraeHome: '/fleet/trae' })).toBe('/fleet/trae');
    const unset: NodeJS.ProcessEnv = { TRAE_HOME: '/srv/bot-a/trae' };
    expect(pin(unset)).toBeUndefined();
    expect('TRAE_HOME' in unset).toBe(false);
  });
});
