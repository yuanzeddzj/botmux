import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPostTerminalRecheck } from '../src/services/post-terminal-recheck.js';

afterEach(() => { vi.useRealTimers(); });

describe('post-terminal input recheck ownership', () => {
  it('retries a static held composer and stops once the input fence clears', async () => {
    vi.useFakeTimers();
    const owner = {};
    let held = true;
    const probe = vi.fn(async () => {});
    const recheck = createPostTerminalRecheck({
      isCurrent: () => held, probe, onError: vi.fn(), onWait: vi.fn(), intervalMs: 10,
    });
    recheck.request(owner);
    await vi.advanceTimersByTimeAsync(35);
    expect(probe.mock.calls.length).toBeGreaterThan(1);
    held = false;
    const before = probe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(probe).toHaveBeenCalledTimes(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('deduplicates repeated requests for the same terminal fence', async () => {
    vi.useFakeTimers();
    const owner = {};
    const probe = vi.fn(async () => {});
    const recheck = createPostTerminalRecheck({isCurrent: () => true, probe, onError: vi.fn(), onWait: vi.fn(), intervalMs: 10});
    recheck.request(owner); recheck.request(owner); recheck.request(owner);
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    recheck.cancel();
  });

  it('revokes an awaited old callback when a successor fence is installed', async () => {
    vi.useFakeTimers();
    const old = {}, successor = {};
    let release: () => void = () => {};
    const deferred = new Promise<void>(done => { release = done; });
    const effects: object[] = [];
    const recheck = createPostTerminalRecheck({
      isCurrent: () => true,
      probe: async (owner, current) => {
        if (owner === old) await deferred;
        if (current()) effects.push(owner);
      }, onError: vi.fn(), onWait: vi.fn(),
    });
    recheck.request(old); recheck.request(successor);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(effects).toEqual([successor]);
    recheck.cancel();
  });

  it('does not release an input from a timed-out late probe', async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const deferred = new Promise<void>(done => { release = done; });
    const effect = vi.fn(), error = vi.fn();
    const recheck = createPostTerminalRecheck({
      isCurrent: () => true,
      probe: async (_owner, current) => { await deferred; if (current()) effect(); },
      onError: error, onWait: vi.fn(), probeTimeoutMs: 20, intervalMs: 50,
    });
    recheck.request({});
    await vi.advanceTimersByTimeAsync(21);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledTimes(1);
    expect(effect).not.toHaveBeenCalled();
    recheck.cancel();
  });

  it('stands down after restart, session rotation or explicit close invalidates its owner', async () => {
    vi.useFakeTimers();
    let valid = true;
    let release: () => void = () => {};
    const deferred = new Promise<void>(done => { release = done; });
    const effect = vi.fn();
    const recheck = createPostTerminalRecheck({
      isCurrent: () => valid,
      probe: async (_owner, current) => { await deferred; if (current()) effect(); },
      onError: vi.fn(), onWait: vi.fn(),
    });
    recheck.request({}); valid = false; release();
    await vi.advanceTimersByTimeAsync(100);
    expect(effect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports prolonged waiting while keeping a recoverable input fence', async () => {
    vi.useFakeTimers();
    const owner = {}, wait = vi.fn();
    const recheck = createPostTerminalRecheck({
      isCurrent: () => true, probe: vi.fn(async () => {}), onError: vi.fn(), onWait: wait,
      intervalMs: 10, reportAfterMs: 25,
    });
    recheck.request(owner);
    await vi.advanceTimersByTimeAsync(35);
    expect(wait).toHaveBeenCalledWith(owner);
    expect(vi.getTimerCount()).toBe(1);
    recheck.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });
});
