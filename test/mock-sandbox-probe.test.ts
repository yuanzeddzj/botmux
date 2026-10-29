import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SANDBOX_PROBE_EXPECTED,
  SANDBOX_PROBE_TOKEN,
  sandboxCanaryDir,
  sandboxProbeCommand,
  sandboxSecretPaths,
} from './helpers/mock-llm-server/sandbox-probe.js';

const TAG = 'e2e-sbx-1793300000000';
const prompt = (text: string) => [{ role: 'user', content: [{ type: 'text', text }] }];

describe('sandbox probe of the mock LLM', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('answers only a probe in the latest turn', () => {
    expect(sandboxProbeCommand(prompt(`${TAG} ${SANDBOX_PROBE_TOKEN} 请立刻调用 botmux send`))).toContain(`"ACK-${TAG} SBX `);
    expect(sandboxProbeCommand(prompt(`${TAG} 请立刻调用 botmux send`))).toBeNull();
    const older = [...prompt(`${TAG} ${SANDBOX_PROBE_TOKEN} 请立刻调用`), { role: 'assistant', content: 'ok' }, ...prompt('next')];
    expect(sandboxProbeCommand(older)).toBeNull();
  });

  it('reports the opposite of every expected check when run outside a sandbox', () => {
    // The checks must be able to fail: on the host each one sees what the
    // sandbox must hide.
    root = mkdtempSync(path.join(tmpdir(), 'botmux-sbx-probe-'));
    const home = path.join(root, 'home');
    const work = path.join(root, 'work');
    const bin = path.join(root, 'bin');
    for (const dir of [home, work, bin]) mkdirSync(dir, { recursive: true });
    mkdirSync(sandboxCanaryDir(home), { recursive: true });
    writeFileSync(path.join(sandboxCanaryDir(home), 'secret.txt'), 'canary');
    writeFileSync(path.join(work, 'test-bots.json'), '[]');
    writeFileSync(path.join(work, 'storageState.json'), '{}');
    const recorded = path.join(root, 'sent.txt');
    writeFileSync(path.join(bin, 'botmux'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${recorded}'\n`);
    chmodSync(path.join(bin, 'botmux'), 0o755);

    const env = { ...process.env, HOME: home, BOTS_CONFIG: 'test-bots.json' };
    const savedHome = process.env.HOME;
    const savedCwd = process.cwd();
    let command: string | null;
    try {
      process.env.HOME = home;
      process.env.BOTS_CONFIG = 'test-bots.json';
      process.chdir(work);
      expect(sandboxSecretPaths().bots).toBe(path.join(work, 'test-bots.json'));
      command = sandboxProbeCommand(prompt(`${TAG} ${SANDBOX_PROBE_TOKEN} 请立刻调用 botmux send`));
    } finally {
      process.chdir(savedCwd);
      process.env.HOME = savedHome;
      delete process.env.BOTS_CONFIG;
    }
    const run = spawnSync('bash', ['--noprofile', '--norc', '-c', command!], {
      cwd: work,
      env: { ...env, PATH: `${bin}:/usr/bin:/bin` },
      encoding: 'utf8',
    });
    expect(run.status, run.stderr).toBe(0);
    const line = readFileSync(recorded, 'utf8').split('\n')[2];
    expect(line).toBe(`ACK-${TAG} SBX pid1=host home=READ bots=READ state=READ outside=WROTE workdir=OK`);
    expect(existsSync(path.join(sandboxCanaryDir(home), `w-${TAG}`))).toBe(true);
    expect(existsSync(path.join(work, `sbx-${TAG}`))).toBe(true);
    // Same checks, same order as the line a sandbox must produce.
    expect(SANDBOX_PROBE_EXPECTED.split(' ').map((c) => c.split('=')[0])).toEqual(
      line.split(' ').slice(2).map((c) => c.split('=')[0]),
    );
  });
});
