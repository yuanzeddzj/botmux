import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExclusiveTopicCoordinator, currentTopicExecutionContext, readTopicExecutionOwner,
  readTopicSelection, topicExecutionAllowed, type ExclusiveTopicInput,
} from '../src/services/exclusive-topic-owner.js';
import { sessionMatchesExclusiveTopic, waitForTopicWorkerExit } from '../src/core/topic-ownership-revoke.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-topic-owner-')); });
afterEach(() => { vi.useRealTimers(); rmSync(dataDir, { recursive: true, force: true }); });
const topic = { chatId: 'oc_topic_chat', rootId: 'om_topic_root' };
const input = (app: string, time: number, select = true, rootId = topic.rootId): ExclusiveTopicInput => ({
  ...topic, rootId, larkAppId: app, createdAt: time, messageId: `om_message_${time}`,
  ...(select ? { selectedAppId: app } : {}),
});
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('durable exclusive topic admission', () => {
  it('persists owner delegation for same-bot followups and drops it on a different selector', async () => {
    const coordinator = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async () => {} });
    await coordinator.select({ ...input('a', 1), followupOwnerOpenId: 'ou_owner' });
    expect(coordinator.currentSelection(topic.chatId, topic.rootId)?.followupOwnerOpenId).toBe('ou_owner');
    await coordinator.select(input('a', 2));
    expect(coordinator.currentSelection(topic.chatId, topic.rootId)?.followupOwnerOpenId).toBe('ou_owner');
    await coordinator.select(input('b', 3));
    expect(coordinator.currentSelection(topic.chatId, topic.rootId)?.followupOwnerOpenId).toBeUndefined();
    await coordinator.select({ ...input('b', 4), followupOwnerOpenId: 'ou_owner' });
    expect(new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async () => {} }).currentSelection(topic.chatId, topic.rootId)?.followupOwnerOpenId).toBe('ou_owner');
  });
  it('keeps mentionless replies with the latest owner across coordinator restarts', async () => {
    const running = new Set<string>();
    const delivered: string[] = [];
    const options = { dataDir, revokeOtherBots: async () => { running.clear(); } };
    const a = new ExclusiveTopicCoordinator(options);
    const b = new ExclusiveTopicCoordinator(options);
    const accept = (app: string) => async () => { running.add(app); delivered.push(app); expect(running.size).toBe(1); };
    expect(await a.admit(input('a', 1), accept('a'))).toBe(true);
    expect(await a.admit(input('a', 2, false), accept('a'))).toBe(true);
    expect(await b.admit(input('b', 3), accept('b'))).toBe(true);
    expect(await a.admit(input('a', 4, false), accept('a'))).toBe(false);
    const restarted = new ExclusiveTopicCoordinator(options);
    expect(await restarted.admit(input('b', 5, false), accept('b'))).toBe(true);
    expect(delivered).toEqual(['a', 'a', 'b', 'b']);
  });

  it('revokes delayed input as soon as a newer selection is published', async () => {
    const entered = deferred();
    const release = deferred();
    const coordinator = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async () => {} });
    let oldAllowed = true;
    const old = coordinator.admit(input('a', 1), async () => {
      const captured = currentTopicExecutionContext()!;
      entered.resolve();
      await release.promise;
      oldAllowed = topicExecutionAllowed(dataDir, { ...topic, larkAppId: 'a', epoch: captured.epoch });
    });
    await entered.promise;
    await coordinator.select(input('b', 2));
    expect(topicExecutionAllowed(dataDir, { ...topic, larkAppId: 'a' })).toBe(false);
    release.resolve();
    await old;
    expect(oldAllowed).toBe(false);
  });

  it('invalidates an old A callback after A -> B -> A', async () => {
    const coordinator = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async () => {} });
    let oldEpoch = 0;
    let callback!: () => boolean;
    await coordinator.admit(input('a', 1), async () => {
      oldEpoch = currentTopicExecutionContext()!.epoch;
      const captured = currentTopicExecutionContext()!;
      callback = () => topicExecutionAllowed(dataDir, { ...topic, larkAppId: 'a', epoch: captured.epoch });
    });
    await coordinator.admit(input('b', 2), async () => {});
    await coordinator.admit(input('a', 3), async () => {});
    expect(readTopicSelection(dataDir, topic)!.epoch).toBeGreaterThan(oldEpoch);
    expect(callback()).toBe(false);
    expect(topicExecutionAllowed(dataDir, { ...topic, larkAppId: 'a' })).toBe(true);
  });

  it('does not revive a delayed old @ after a newer @ and deduplicates selection epochs', async () => {
    const coordinator = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async () => {} });
    await coordinator.admit(input('b', 20), async () => {});
    expect(await coordinator.admit(input('a', 10), async () => { throw new Error('stale action'); })).toBe(false);
    const epoch = readTopicSelection(dataDir, topic)!.epoch;
    await coordinator.select(input('b', 20));
    await coordinator.select(input('b', 21));
    expect(readTopicSelection(dataDir, topic)!.epoch).toBe(epoch);
  });

  it('leaves a failed handoff blocked and retries it on the next input', async () => {
    let failing = false;
    const revoke = vi.fn(async () => { if (failing) throw new Error('stop failed'); });
    const coordinator = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: revoke });
    await coordinator.admit(input('a', 1), async () => {});
    failing = true;
    const successor = vi.fn(async () => {});
    await expect(coordinator.admit(input('b', 2), successor)).rejects.toThrow('stop failed');
    expect(successor).not.toHaveBeenCalled();
    expect(readTopicExecutionOwner(dataDir, topic)!.phase).toBe('handoff');
    expect(topicExecutionAllowed(dataDir, { ...topic, larkAppId: 'a' })).toBe(false);
    expect(topicExecutionAllowed(dataDir, { ...topic, larkAppId: 'b' })).toBe(false);
    failing = false;
    const restarted = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: revoke });
    expect(await restarted.admit(input('b', 3, false), successor)).toBe(true);
    expect(successor).toHaveBeenCalledOnce();
  });

  it('abandons an intermediate owner when human intervention changes selection during teardown', async () => {
    const entered = deferred();
    const release = deferred();
    const coordinator = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async owner => {
      if (owner.ownerAppId === 'b') { entered.resolve(); await release.promise; }
    } });
    await coordinator.admit(input('a', 1), async () => {});
    const bAction = vi.fn(async () => {});
    const b = coordinator.admit(input('b', 2), bAction);
    await entered.promise;
    await coordinator.select(input('c', 3));
    release.resolve();
    expect(await b).toBe(false);
    expect(bAction).not.toHaveBeenCalled();
    expect(await coordinator.admit(input('c', 4, false), async () => {})).toBe(true);
  });

  it('runs different topics concurrently while one topic admission is waiting', async () => {
    const entered = deferred();
    const release = deferred();
    const coordinator = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async () => {} });
    const first = coordinator.admit(input('a', 1), async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const other = vi.fn(async () => {});
    expect(await coordinator.admit(input('b', 2, true, 'om_other_topic'), other)).toBe(true);
    expect(other).toHaveBeenCalledOnce();
    release.resolve();
    await first;
  });

  it('keeps same-bot followups behind the first admission without blocking selection publication', async () => {
    const entered = deferred();
    const release = deferred();
    const coordinator = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async () => {} });
    const order: number[] = [];
    const first = coordinator.admit(input('a', 1), async () => { entered.resolve(); await release.promise; order.push(1); });
    await entered.promise;
    const second = coordinator.admit(input('a', 2, false), async () => { order.push(2); });
    release.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
  });

  it('does not infer a legacy owner over an explicit selection arriving during history lookup', async () => {
    const entered = deferred();
    const release = deferred();
    const coordinator = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async () => {}, inferOwner: async () => {
      entered.resolve(); await release.promise;
      return { ownerAppId: 'a', selectedAt: 1, selectionMessageId: 'om_old' };
    } });
    const old = coordinator.admit(input('a', 2, false), async () => { throw new Error('old owner'); });
    await entered.promise;
    await coordinator.select(input('b', 3));
    release.resolve();
    expect(await old).toBe(false);
    expect(coordinator.currentOwner(topic.chatId, topic.rootId)).toBe('b');
  });

  it('shares admission and selection with another actual process', async () => {
    const coordinator = new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async () => {} });
    await coordinator.admit(input('a', 1), async () => {});
    const child = spawnTsEvalWithRepoImports(`
      import { ExclusiveTopicCoordinator } from './src/services/exclusive-topic-owner.js';
      const c = new ExclusiveTopicCoordinator({dataDir: ${JSON.stringify(dataDir)}, revokeOtherBots: async () => {}});
      await c.admit(${JSON.stringify(input('b', 2))}, async () => console.log('admitted'));
    `, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout!.on('data', value => { output += value; });
    const code = await new Promise(resolve => child.once('exit', resolve));
    expect(code).toBe(0);
    expect(output).toContain('admitted');
    expect(await coordinator.admit(input('a', 3, false), async () => {})).toBe(false);
  });
});

describe('verified topic retirement', () => {
  it('matches only exact chat and root membership including legacy aliases', () => {
    const session: any = { status: 'active', chatId: topic.chatId, rootMessageId: 'om_legacy', replyThreadAliases: { [topic.rootId]: {} } };
    expect(sessionMatchesExclusiveTopic(session, topic)).toBe(true);
    expect(sessionMatchesExclusiveTopic(session, { ...topic, chatId: 'oc_other' })).toBe(false);
    expect(sessionMatchesExclusiveTopic(session, { ...topic, rootId: 'om_other' })).toBe(false);
  });

  it('does not treat a successful signal as proof the old worker exited', async () => {
    vi.useFakeTimers();
    const worker: any = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: vi.fn(() => true) });
    const wait = waitForTopicWorkerExit(worker, 900);
    await vi.advanceTimersByTimeAsync(900);
    expect(await wait).toBe(false);
    expect(worker.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('waits for the exit event and cancels escalation once teardown is confirmed', async () => {
    vi.useFakeTimers();
    const worker: any = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: vi.fn() });
    const wait = waitForTopicWorkerExit(worker, 900);
    worker.emit('exit', 0);
    expect(await wait).toBe(true);
    await vi.advanceTimersByTimeAsync(900);
    expect(worker.kill).not.toHaveBeenCalled();
  });
});
