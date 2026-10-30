import { mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import type { TraexAutoModelConfig } from './traex-auto-model.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { readDurableProcessIdentity, isLinuxZombie } from '../utils/process-identity.js';
import { pidIsSignalable } from '../utils/process-alive.js';

const FILE_NAME = 'traex-auto-model-circuits.json';

export interface TraexAutoModelCircuitLease {
  model: string;
  token: string;
  acquiredAtMs: number;
}

interface PersistedProbe extends TraexAutoModelCircuitLease {
  sessionId: string;
  pid?: number;
  procStart?: string;
}

export interface TraexAutoModelCircuitEntry {
  model: string;
  state: 'closed' | 'open' | 'half_open';
  failureCount: number;
  successCount: number;
  openCount: number;
  openUntilMs?: number;
  probes: PersistedProbe[];
  updatedAtMs: number;
  failureObservations?: string[];
}

interface CircuitFile {
  version: 1;
  bots: Record<string, Record<string, TraexAutoModelCircuitEntry>>;
}

export interface TraexAutoModelCircuitSelection {
  model: string;
  lease?: TraexAutoModelCircuitLease;
  /** Every configured model was still protected or already probing. The
   * earliest recovery candidate is used to preserve availability. */
  allProtected?: true;
  retryAtMs?: number;
}

export class TraexAutoModelCircuitStoreError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'TraexAutoModelCircuitStoreError';
  }
}

export function traexAutoModelCircuitPath(dataDir: string): string {
  return join(dataDir, FILE_NAME);
}

function emptyFile(): CircuitFile {
  return { version: 1, bots: Object.create(null) };
}

function readFileStrict(dataDir: string): CircuitFile {
  const path = traexAutoModelCircuitPath(dataDir);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile();
    throw new TraexAutoModelCircuitStoreError(`cannot read TraeX auto-model circuit state at ${path}`, error);
  }
  const raw = value as Partial<CircuitFile> | null;
  if (!raw || raw.version !== 1 || !raw.bots || typeof raw.bots !== 'object'
    || Array.isArray(raw.bots)) {
    throw new TraexAutoModelCircuitStoreError(`invalid TraeX auto-model circuit state at ${path}`);
  }
  for (const [appId, models] of Object.entries(raw.bots)) {
    if (!appId || !models || typeof models !== 'object' || Array.isArray(models)) {
      throw new TraexAutoModelCircuitStoreError(`invalid TraeX auto-model circuit bot entry at ${path}`);
    }
    for (const entry of Object.values(models)) validateEntry(entry, path);
    Object.defineProperty(raw.bots, appId, { value: Object.assign(Object.create(null), models),
      enumerable: true, configurable: true, writable: true });
  }
  return { version: 1, bots: Object.assign(Object.create(null), raw.bots) };
}

function validateEntry(value: unknown, path: string): asserts value is TraexAutoModelCircuitEntry {
  const entry = value as Partial<TraexAutoModelCircuitEntry> | null;
  if (!entry || typeof entry.model !== 'string'
    || !['closed', 'open', 'half_open'].includes(entry.state ?? '')
    || !Number.isSafeInteger(entry.failureCount) || entry.failureCount! < 0
    || !Number.isSafeInteger(entry.successCount) || entry.successCount! < 0
    || !Number.isSafeInteger(entry.openCount) || entry.openCount! < 0
    || !Number.isSafeInteger(entry.updatedAtMs) || entry.updatedAtMs! < 0
    || !Array.isArray(entry.probes)) {
    throw new TraexAutoModelCircuitStoreError(`invalid TraeX auto-model circuit entry at ${path}`);
  }
  if (entry.openUntilMs !== undefined
    && (!Number.isSafeInteger(entry.openUntilMs) || entry.openUntilMs < 0)) {
    throw new TraexAutoModelCircuitStoreError(`invalid TraeX auto-model circuit deadline at ${path}`);
  }
  for (const probe of entry.probes) {
    if (!probe || typeof probe.model !== 'string' || typeof probe.token !== 'string'
      || typeof probe.sessionId !== 'string' || !Number.isSafeInteger(probe.acquiredAtMs)
      || probe.acquiredAtMs < 0) {
      throw new TraexAutoModelCircuitStoreError(`invalid TraeX auto-model circuit probe at ${path}`);
    }
    if (probe.pid !== undefined && (!Number.isSafeInteger(probe.pid) || probe.pid <= 1)) {
      throw new TraexAutoModelCircuitStoreError(`invalid TraeX auto-model probe process at ${path}`);
    }
  }
  if (entry.failureObservations !== undefined && (!Array.isArray(entry.failureObservations)
    || !entry.failureObservations.every(key => typeof key === 'string'))) {
    throw new TraexAutoModelCircuitStoreError(`invalid TraeX auto-model failure observations at ${path}`);
  }
}

function writeFileStrict(dataDir: string, value: CircuitFile): void {
  const path = traexAutoModelCircuitPath(dataDir);
  try {
    atomicWriteFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      durable: true,
      followTargetSymlink: false,
    });
  } catch (error) {
    throw new TraexAutoModelCircuitStoreError(`cannot persist TraeX auto-model circuit state at ${path}`, error);
  }
}

function mutate<T>(dataDir: string, fn: (value: CircuitFile) => { result: T; changed: boolean }): T {
  const path = traexAutoModelCircuitPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  return withFileLockSync(path, () => {
    const value = readFileStrict(dataDir);
    const mutation = fn(value);
    if (mutation.changed) writeFileStrict(dataDir, value);
    return mutation.result;
  });
}

function modelKey(model: string): string {
  return model.trim().toLowerCase();
}

function botEntries(file: CircuitFile, appId: string): Record<string, TraexAutoModelCircuitEntry> {
  return file.bots[appId] ??= Object.create(null);
}

function probeLeaseMs(config: TraexAutoModelConfig): number {
  return Math.max(config.circuitBreaker!.openMs, config.queueTimeoutMs + 60_000);
}

function pruneProbes(entry: TraexAutoModelCircuitEntry, config: TraexAutoModelConfig, nowMs: number): boolean {
  const probes = entry.probes.filter(probe => {
    if (probe.pid) {
      if (isLinuxZombie(probe.pid)) return false;
      const start = readDurableProcessIdentity(probe.pid);
      return start && probe.procStart ? start === probe.procStart : pidIsSignalable(probe.pid);
    }
    return nowMs - probe.acquiredAtMs < probeLeaseMs(config);
  });
  if (probes.length === entry.probes.length) return false;
  entry.probes = probes;
  entry.updatedAtMs = nowMs;
  return true;
}

function transitionExpiredOpen(entry: TraexAutoModelCircuitEntry, nowMs: number): boolean {
  if (entry.state !== 'open' || (entry.openUntilMs ?? Infinity) > nowMs) return false;
  entry.state = 'half_open';
  entry.successCount = 0;
  entry.probes = [];
  entry.updatedAtMs = nowMs;
  return true;
}

/** Select the first CLOSED model, or acquire one bounded HALF_OPEN probe. */
export function selectTraexAutoModelCircuit(input: {
  dataDir: string;
  appId: string;
  sessionId: string;
  config: TraexAutoModelConfig;
  /** Empty daemon-restoration forks must not consume the sole recovery probe. */
  allowProbe?: boolean;
  candidates?: string[];
  ownerPid?: number;
  nowMs?: number;
}): TraexAutoModelCircuitSelection {
  const circuit = input.config.circuitBreaker;
  if (!circuit) return { model: input.config.models[0]! };
  const nowMs = input.nowMs ?? Date.now();
  return mutate<TraexAutoModelCircuitSelection>(input.dataDir, file => {
    const entries = botEntries(file, input.appId);
    let changed = false;
    let earliest: { model: string; atMs: number } | undefined;
    const candidates = input.candidates ?? input.config.models;
    for (const model of candidates) {
      if (!input.config.models.includes(model)) throw new Error('circuit candidate outside configured pool');
      const entry = entries[modelKey(model)];
      if (!entry || entry.state === 'closed') return { result: { model }, changed };
      const transitioned = transitionExpiredOpen(entry, nowMs);
      const pruned = pruneProbes(entry, input.config, nowMs);
      changed = transitioned || pruned || changed;
      const existing = entry.probes.find(probe => probe.sessionId === input.sessionId);
      if (existing) {
        return {
          result: { model, lease: { model, token: existing.token, acquiredAtMs: existing.acquiredAtMs } },
          changed,
        };
      }
      const probesNeeded = Math.max(0, circuit.successThreshold - entry.successCount);
      if (input.allowProbe !== false && entry.state === 'half_open'
        && entry.probes.length < Math.min(circuit.halfOpenMaxProbes, probesNeeded)) {
        const lease = { model, token: randomUUID(), acquiredAtMs: nowMs };
        entry.probes.push({ ...lease, sessionId: input.sessionId,
          ...(input.ownerPid ? { pid: input.ownerPid, procStart: readDurableProcessIdentity(input.ownerPid) } : {}) });
        entry.updatedAtMs = nowMs;
        return { result: { model, lease }, changed: true };
      }
      const atMs = entry.state === 'open' ? entry.openUntilMs ?? Infinity : nowMs + probeLeaseMs(input.config);
      if (!earliest || atMs < earliest.atMs) earliest = { model, atMs };
    }
    // A placeholder model may start the CLI shell, but callers MUST keep input
    // outside it until a CLOSED candidate or an exact probe is admitted.
    return {
      result: { model: earliest?.model ?? input.config.models.at(-1)!, allProtected: true,
        retryAtMs: earliest?.atMs ?? nowMs + 1_000 },
      changed,
    };
  });
}

export function bindTraexAutoModelCircuitLease(input: {
  dataDir: string; appId: string; model: string; token: string; pid: number;
}): void {
  mutate(input.dataDir, file => {
    const probe = file.bots[input.appId]?.[modelKey(input.model)]?.probes.find(p => p.token === input.token);
    if (!probe) return { result: undefined, changed: false };
    probe.pid = input.pid;
    probe.procStart = readDurableProcessIdentity(input.pid);
    return { result: undefined, changed: true };
  });
}

/** Recover the lease of a persistent session after daemon/worker replacement. */
export function restoreTraexAutoModelCircuitLease(input: {
  dataDir: string;
  appId: string;
  sessionId: string;
  model: string;
  config: TraexAutoModelConfig;
  nowMs?: number;
}): TraexAutoModelCircuitLease | undefined {
  if (!input.config.circuitBreaker) return undefined;
  const nowMs = input.nowMs ?? Date.now();
  return mutate(input.dataDir, file => {
    const entry = file.bots[input.appId]?.[modelKey(input.model)];
    if (!entry) return { result: undefined, changed: false };
    const changed = pruneProbes(entry, input.config, nowMs);
    const probe = entry.probes.find(candidate => candidate.sessionId === input.sessionId);
    return {
      result: probe ? { model: input.model, token: probe.token, acquiredAtMs: probe.acquiredAtMs } : undefined,
      changed,
    };
  });
}

/** Release a probe that was acquired for a worker fork which failed before its
 * init message could be dispatched. Exact-token removal cannot affect a newer
 * probe for the same session. */
export function releaseTraexAutoModelCircuitLease(input: {
  dataDir: string;
  appId: string;
  model: string;
  token: string;
}): void {
  mutate(input.dataDir, file => {
    const entry = file.bots[input.appId]?.[modelKey(input.model)];
    if (!entry) return { result: undefined, changed: false };
    const index = entry.probes.findIndex(probe => probe.token === input.token);
    if (index < 0) return { result: undefined, changed: false };
    entry.probes.splice(index, 1);
    entry.updatedAtMs = Date.now();
    return { result: undefined, changed: true };
  });
}

function openEntry(entry: TraexAutoModelCircuitEntry, config: TraexAutoModelConfig, nowMs: number): void {
  const circuit = config.circuitBreaker!;
  const duration = Math.min(circuit.maxOpenMs,
    circuit.openMs * (2 ** Math.min(entry.openCount, 20)));
  entry.state = 'open';
  entry.failureCount = 0;
  entry.successCount = 0;
  entry.openCount += 1;
  entry.openUntilMs = nowMs + duration;
  entry.probes = [];
  entry.updatedAtMs = nowMs;
}

/** Record one confirmed capacity queue. Other failures do not open circuits. */
export function recordTraexAutoModelCircuitFailure(input: {
  dataDir: string;
  appId: string;
  model: string;
  config: TraexAutoModelConfig;
  leaseToken?: string;
  observationKey?: string;
  nowMs?: number;
}): void {
  const circuit = input.config.circuitBreaker;
  if (!circuit || !input.config.models.some(model => model.toLowerCase() === input.model.toLowerCase())) return;
  const nowMs = input.nowMs ?? Date.now();
  mutate(input.dataDir, file => {
    const entries = botEntries(file, input.appId);
    const key = modelKey(input.model);
    const entry = entries[key] ??= {
      model: input.model,
      state: 'closed',
      failureCount: 0,
      successCount: 0,
      openCount: 0,
      probes: [],
      updatedAtMs: nowMs,
    };
    if (input.observationKey) {
      if (entry.failureObservations?.includes(input.observationKey)) return { result: undefined, changed: false };
      entry.failureObservations = [...(entry.failureObservations ?? []), input.observationKey].slice(-256);
    }
    if (entry.state === 'open') return { result: undefined, changed: false };
    if (entry.state === 'half_open') {
      if (!input.leaseToken || !entry.probes.some(probe => probe.token === input.leaseToken)) {
        return { result: undefined, changed: false };
      }
      openEntry(entry, input.config, nowMs);
      return { result: undefined, changed: true };
    }
    entry.failureCount += 1;
    entry.successCount = 0;
    entry.updatedAtMs = nowMs;
    if (entry.failureCount >= circuit.failureThreshold) openEntry(entry, input.config, nowMs);
    return { result: undefined, changed: true };
  });
}

/** A normal CLOSED success resets the failure streak. A HALF_OPEN success must
 * hold an exact lease and closes only after the configured success count. */
export function recordTraexAutoModelCircuitSuccess(input: {
  dataDir: string;
  appId: string;
  model: string;
  config: TraexAutoModelConfig;
  leaseToken?: string;
  nowMs?: number;
}): void {
  const circuit = input.config.circuitBreaker;
  if (!circuit || !input.config.models.some(model => model.toLowerCase() === input.model.toLowerCase())) return;
  const nowMs = input.nowMs ?? Date.now();
  mutate(input.dataDir, file => {
    const entry = file.bots[input.appId]?.[modelKey(input.model)];
    if (!entry) return { result: undefined, changed: false };
    if (entry.state === 'closed') {
      if (entry.failureCount === 0) return { result: undefined, changed: false };
      entry.failureCount = 0;
      entry.updatedAtMs = nowMs;
      return { result: undefined, changed: true };
    }
    if (entry.state !== 'half_open' || !input.leaseToken) {
      return { result: undefined, changed: false };
    }
    const probeIndex = entry.probes.findIndex(probe => probe.token === input.leaseToken);
    if (probeIndex < 0) return { result: undefined, changed: false };
    entry.probes.splice(probeIndex, 1);
    entry.successCount += 1;
    entry.updatedAtMs = nowMs;
    if (entry.successCount >= circuit.successThreshold) {
      entry.state = 'closed';
      entry.failureCount = 0;
      entry.successCount = 0;
      entry.openCount = 0;
      entry.openUntilMs = undefined;
      entry.probes = [];
    }
    return { result: undefined, changed: true };
  });
}

/** Read-only diagnostic snapshot for tests and future operator surfaces. */
export function readTraexAutoModelCircuitState(dataDir: string): CircuitFile {
  return readFileStrict(dataDir);
}
