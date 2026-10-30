import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

import type { TraexAutoModelConfig } from '../src/services/traex-auto-model.js';
import {
  readTraexAutoModelCircuitState,
  recordTraexAutoModelCircuitFailure,
  recordTraexAutoModelCircuitSuccess,
  bindTraexAutoModelCircuitLease,
  releaseTraexAutoModelCircuitLease,
  restoreTraexAutoModelCircuitLease,
  selectTraexAutoModelCircuit,
} from '../src/services/traex-auto-model-circuit.js';

const roots: string[] = [];
function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'botmux-auto-circuit-'));
  roots.push(value);
  return value;
}
afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function config(overrides: Partial<NonNullable<TraexAutoModelConfig['circuitBreaker']>> = {}): TraexAutoModelConfig {
  return {
    enabled: true,
    models: ['core', 'backup'],
    queueTimeoutMs: 5_000,
    circuitBreaker: {
      enabled: true,
      failureThreshold: 1,
      openMs: 600_000,
      maxOpenMs: 1_800_000,
      halfOpenMaxProbes: 1,
      successThreshold: 1,
      ...overrides,
    },
  };
}

describe('durable TraeX auto-model circuit breaker', () => {
  it('skips an OPEN model across sessions and admits only one recovery probe', () => {
    const dataDir = root();
    const policy = config();
    expect(selectTraexAutoModelCircuit({ dataDir, appId: 'bot-a', sessionId: 's1', config: policy, nowMs: 0 }))
      .toEqual({ model: 'core' });
    recordTraexAutoModelCircuitFailure({ dataDir, appId: 'bot-a', model: 'core', config: policy, nowMs: 100 });

    expect(selectTraexAutoModelCircuit({ dataDir, appId: 'bot-a', sessionId: 's2', config: policy, nowMs: 200 }))
      .toEqual({ model: 'backup' });
    expect(selectTraexAutoModelCircuit({
      dataDir, appId: 'bot-a', sessionId: 'empty-restore', config: policy,
      allowProbe: false, nowMs: 600_100,
    })).toEqual({ model: 'backup' });
    const probe = selectTraexAutoModelCircuit({
      dataDir, appId: 'bot-a', sessionId: 'probe', config: policy, nowMs: 600_101,
    });
    expect(probe.model).toBe('core');
    expect(probe.lease?.token).toBeTruthy();
    expect(selectTraexAutoModelCircuit({
      dataDir, appId: 'bot-a', sessionId: 'other', config: policy, nowMs: 600_101,
    })).toEqual({ model: 'backup' });
    expect(restoreTraexAutoModelCircuitLease({
      dataDir, appId: 'bot-a', sessionId: 'probe', model: 'core', config: policy, nowMs: 600_102,
    })).toEqual(probe.lease);

    recordTraexAutoModelCircuitSuccess({
      dataDir, appId: 'bot-a', model: 'core', config: policy,
      leaseToken: probe.lease!.token, nowMs: 600_200,
    });
    expect(selectTraexAutoModelCircuit({
      dataDir, appId: 'bot-a', sessionId: 's3', config: policy, nowMs: 600_201,
    })).toEqual({ model: 'core' });
  });

  it('reopens a failed HALF_OPEN probe with bounded exponential backoff', () => {
    const dataDir = root();
    const policy = config();
    recordTraexAutoModelCircuitFailure({ dataDir, appId: 'bot-a', model: 'core', config: policy, nowMs: 0 });
    const probe = selectTraexAutoModelCircuit({
      dataDir, appId: 'bot-a', sessionId: 'probe', config: policy, nowMs: 600_000,
    });
    recordTraexAutoModelCircuitFailure({
      dataDir, appId: 'bot-a', model: 'core', config: policy,
      leaseToken: probe.lease!.token, nowMs: 600_100,
    });
    const entry = readTraexAutoModelCircuitState(dataDir).bots['bot-a'].core;
    expect(entry).toMatchObject({ state: 'open', openCount: 2, openUntilMs: 1_800_100 });
    expect(entry.probes).toEqual([]);
  });

  it('honors failure and success thresholds and isolates bot state', () => {
    const dataDir = root();
    const policy = config({ failureThreshold: 2, successThreshold: 2, halfOpenMaxProbes: 2 });
    recordTraexAutoModelCircuitFailure({ dataDir, appId: 'bot-a', model: 'core', config: policy, nowMs: 0 });
    expect(selectTraexAutoModelCircuit({ dataDir, appId: 'bot-a', sessionId: 's1', config: policy, nowMs: 1 }))
      .toEqual({ model: 'core' });
    recordTraexAutoModelCircuitSuccess({ dataDir, appId: 'bot-a', model: 'core', config: policy, nowMs: 2 });
    recordTraexAutoModelCircuitFailure({ dataDir, appId: 'bot-a', model: 'core', config: policy, nowMs: 3 });
    recordTraexAutoModelCircuitFailure({ dataDir, appId: 'bot-a', model: 'core', config: policy, nowMs: 4 });
    expect(selectTraexAutoModelCircuit({ dataDir, appId: 'bot-b', sessionId: 'other-bot', config: policy, nowMs: 5 }))
      .toEqual({ model: 'core' });

    const first = selectTraexAutoModelCircuit({
      dataDir, appId: 'bot-a', sessionId: 'p1', config: policy, nowMs: 600_004,
    });
    const second = selectTraexAutoModelCircuit({
      dataDir, appId: 'bot-a', sessionId: 'p2', config: policy, nowMs: 600_005,
    });
    expect(first.lease).toBeTruthy();
    expect(second.lease).toBeTruthy();
    recordTraexAutoModelCircuitSuccess({
      dataDir, appId: 'bot-a', model: 'core', config: policy,
      leaseToken: first.lease!.token, nowMs: 600_006,
    });
    expect(selectTraexAutoModelCircuit({
      dataDir, appId: 'bot-a', sessionId: 'wait', config: policy, nowMs: 600_007,
    })).toEqual({ model: 'backup' });
    recordTraexAutoModelCircuitSuccess({
      dataDir, appId: 'bot-a', model: 'core', config: policy,
      leaseToken: second.lease!.token, nowMs: 600_008,
    });
    expect(selectTraexAutoModelCircuit({
      dataDir, appId: 'bot-a', sessionId: 'restored', config: policy, nowMs: 600_009,
    })).toEqual({ model: 'core' });
  });

  it('requires callers to wait when every model is protected without granting an extra probe', () => {
    const dataDir = root();
    const policy = config();
    recordTraexAutoModelCircuitFailure({ dataDir, appId: 'bot-a', model: 'core', config: policy, nowMs: 0 });
    recordTraexAutoModelCircuitFailure({ dataDir, appId: 'bot-a', model: 'backup', config: policy, nowMs: 100 });
    expect(selectTraexAutoModelCircuit({
      dataDir, appId: 'bot-a', sessionId: 'emergency', config: policy, nowMs: 200,
    })).toEqual({ model: 'core', allProtected: true, retryAtMs: 600_000 });
  });

  it('releases only the exact unused fork probe', () => {
    const dataDir = root();
    const policy = config();
    recordTraexAutoModelCircuitFailure({ dataDir, appId: 'bot-a', model: 'core', config: policy, nowMs: 0 });
    const probe = selectTraexAutoModelCircuit({
      dataDir, appId: 'bot-a', sessionId: 'failed-fork', config: policy, nowMs: 600_000,
    });
    releaseTraexAutoModelCircuitLease({
      dataDir, appId: 'bot-a', model: 'core', token: 'stale-token',
    });
    expect(readTraexAutoModelCircuitState(dataDir).bots['bot-a'].core.probes).toHaveLength(1);
    releaseTraexAutoModelCircuitLease({
      dataDir, appId: 'bot-a', model: 'core', token: probe.lease!.token,
    });
    expect(readTraexAutoModelCircuitState(dataDir).bots['bot-a'].core.probes).toEqual([]);
    expect(selectTraexAutoModelCircuit({
      dataDir, appId: 'bot-a', sessionId: 'retry', config: policy, nowMs: 600_001,
    }).lease).toBeTruthy();
  });

  it('keeps a live long-running probe exclusive and ignores events with retired probe tokens', () => {
    const dataDir = root();
    const policy = config();
    recordTraexAutoModelCircuitFailure({ dataDir, appId: 'bot-a', model: 'core', config: policy, nowMs: 0 });
    const probe = selectTraexAutoModelCircuit({ dataDir, appId: 'bot-a', sessionId: 'probe', config: policy, nowMs: 600_000 });
    bindTraexAutoModelCircuitLease({ dataDir, appId: 'bot-a', model: 'core', token: probe.lease!.token, pid: process.pid });
    expect(selectTraexAutoModelCircuit({ dataDir, appId: 'bot-a', sessionId: 'other', config: policy, nowMs: 5_000_000 }))
      .toEqual({ model: 'backup' });
    recordTraexAutoModelCircuitFailure({ dataDir, appId: 'bot-a', model: 'core', config: policy,
      leaseToken: 'retired-token', nowMs: 5_000_001 });
    recordTraexAutoModelCircuitSuccess({ dataDir, appId: 'bot-a', model: 'core', config: policy,
      leaseToken: 'retired-token', nowMs: 5_000_001 });
    expect(readTraexAutoModelCircuitState(dataDir).bots['bot-a'].core.state).toBe('half_open');
  });

  it('serializes concurrent daemon processes so only one acquires the HALF_OPEN probe', async () => {
    const dataDir = root();
    const policy = config();
    recordTraexAutoModelCircuitFailure({ dataDir, appId: 'bot-a', model: 'core', config: policy, nowMs: 0 });
    const script = join(dataDir, 'probe-worker.mts');
    const gate = join(dataDir, 'start');
    const moduleUrl = pathToFileURL(resolve('src/services/traex-auto-model-circuit.ts')).href;
    writeFileSync(script, `
import { existsSync } from 'node:fs';
import { selectTraexAutoModelCircuit } from ${JSON.stringify(moduleUrl)};
while (!existsSync(process.argv[4])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
const config = JSON.parse(process.argv[3]);
const result = selectTraexAutoModelCircuit({ dataDir: process.argv[2], appId: 'bot-a',
  sessionId: process.argv[5], config, nowMs: 600000 });
process.stdout.write(JSON.stringify(result));
`);
    const children = Array.from({ length: 4 }, (_, index) => spawnNodeTsScript(
      script,
      [dataDir, JSON.stringify(policy), gate, `session-${index}`],
      { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] },
    ));
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
    writeFileSync(gate, 'go');
    const outputs = await Promise.all(children.map(child => new Promise<string>((resolveOutput, reject) => {
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
      child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolveOutput(stdout) : reject(new Error(stderr)));
    })));
    const selections = outputs.map(output => JSON.parse(output));
    expect(selections.filter(selection => selection.lease)).toHaveLength(1);
    expect(selections.filter(selection => selection.model === 'core')).toHaveLength(1);
    expect(selections.filter(selection => selection.model === 'backup')).toHaveLength(3);
  });
});
