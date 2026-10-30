import { config } from '../config.js';
import { getAllBots } from '../bot-registry.js';
import { fetchDaemonIpc } from './daemon-ipc-auth.js';
import { findOnlineDaemon } from '../utils/daemon-discovery.js';
import { ExclusiveTopicCoordinator, type ExclusiveTopicInput } from '../services/exclusive-topic-owner.js';
import { readBotSessionsStrict } from '../services/session-store.js';
import { sessionMatchesExclusiveTopic } from './topic-ownership-revoke.js';

/** Route-bound host IPC reuses the daemon's existing authentication. A missing
 * or incompatible predecessor remains a failed handoff, never a second CLI. */
export function createExclusiveTopicRuntime(options: {
  inferOwner?: (input: ExclusiveTopicInput) => Promise<{ ownerAppId: string; selectedAt: number; selectionMessageId: string } | undefined>;
} = {}): ExclusiveTopicCoordinator {
  return new ExclusiveTopicCoordinator({
    dataDir: config.session.dataDir,
    inferOwner: options.inferOwner,
    async revokeOtherBots(owner, isCurrent) {
      for (const bot of getAllBots()) {
        const appId = bot.config.larkAppId;
        if (bot.config.exclusiveTopicOwner !== true) continue;
        if (!isCurrent()) return;
        const peer = findOnlineDaemon(appId, config.session.dataDir);
        if (!peer) {
          // An offline bot with no membership in THIS topic cannot block a
          // fresh topic. Exact persisted membership fails closed: a detached
          // CLI can survive its daemon, so "offline" is not teardown proof.
          if (readBotSessionsStrict(appId, config.session.dataDir)
            .some(session => sessionMatchesExclusiveTopic(session, owner))) {
            throw new Error('exclusive topic predecessor daemon is unavailable');
          }
          continue;
        }
        const response = await fetchDaemonIpc(peer.ipcPort, '/api/topic-ownership/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(owner),
          signal: AbortSignal.timeout(45_000),
        });
        if (!isCurrent()) return;
        const result = await response.json() as { ok?: boolean };
        if (!response.ok || result.ok !== true) {
          throw new Error('exclusive topic predecessor execution could not be stopped');
        }
      }
    },
  });
}
