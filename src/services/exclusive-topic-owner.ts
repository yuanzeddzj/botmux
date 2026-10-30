import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { serializeByAnchor } from '../utils/anchor-serializer.js';
import { withFileLock } from '../utils/file-lock.js';

export interface TopicIdentity {
  chatId: string;
  rootId: string;
}

export interface TopicSelection extends TopicIdentity {
  ownerAppId: string;
  epoch: number;
  selectedAt: number;
  selectionMessageId: string;
}

export interface TopicExecutionOwner extends TopicIdentity {
  ownerAppId: string;
  epoch: number;
  phase: 'handoff' | 'active';
}

export interface ExclusiveTopicInput extends TopicIdentity {
  larkAppId: string;
  messageId: string;
  createdAt: number;
  selectedAppId?: string;
  threadId?: string;
}

export interface ExclusiveTopics {
  currentOwner(chatId: string, rootId: string): string | undefined;
  select?(input: ExclusiveTopicInput): Promise<void>;
  admit(input: ExclusiveTopicInput, action: () => Promise<void>): Promise<boolean>;
}

const executionContext = new AsyncLocalStorage<TopicExecutionOwner>();

/** Detached descendants retain the captured epoch, so A -> B -> A does not
 * turn an old A callback into a new admission. */
export function currentTopicExecutionContext(): TopicExecutionOwner | undefined {
  return executionContext.getStore();
}

function topicFile(dataDir: string, identity: TopicIdentity, suffix: string): string {
  if (!/^oc_[\w-]+$/.test(identity.chatId) || !/^om_[\w-]+$/.test(identity.rootId)) {
    throw new Error('invalid exclusive topic identity');
  }
  const key = createHash('sha256').update(`${identity.chatId}\0${identity.rootId}`).digest('hex');
  return join(dataDir, 'topic-owners', `${key}.${suffix}.json`);
}

function readRecord<T extends TopicIdentity>(path: string, identity: TopicIdentity): T | undefined {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const value = JSON.parse(raw) as T & { ownerAppId?: unknown; epoch?: unknown };
  if (!value || value.chatId !== identity.chatId || value.rootId !== identity.rootId
    || typeof value.ownerAppId !== 'string' || !value.ownerAppId
    || !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 1) {
    throw new Error('invalid exclusive topic ownership record');
  }
  return value;
}

export function readTopicSelection(dataDir: string, identity: TopicIdentity): TopicSelection | undefined {
  const value = readRecord<TopicSelection>(topicFile(dataDir, identity, 'selection'), identity);
  if (value && (!Number.isSafeInteger(value.selectedAt) || value.selectedAt < 0
    || typeof value.selectionMessageId !== 'string' || !value.selectionMessageId)) {
    throw new Error('invalid exclusive topic selection');
  }
  return value;
}

export function readTopicExecutionOwner(dataDir: string, identity: TopicIdentity): TopicExecutionOwner | undefined {
  const value = readRecord<TopicExecutionOwner>(topicFile(dataDir, identity, 'execution'), identity);
  if (value && value.phase !== 'active' && value.phase !== 'handoff') {
    throw new Error('invalid exclusive topic execution phase');
  }
  return value;
}

function writeRecord<T extends TopicIdentity>(path: string, record: T): void {
  atomicWriteFileSync(path, JSON.stringify(record) + '\n', { followTargetSymlink: false });
}

function selectionIsNewer(input: { createdAt: number; messageId: string }, previous: TopicSelection): boolean {
  return input.createdAt > previous.selectedAt
    || (input.createdAt === previous.selectedAt && input.messageId > previous.selectionMessageId);
}

/** Selection publication is independent from the execution lock. An @B can
 * revoke A's future input while A is still preparing its admitted turn. Only
 * the executor holding the other lock may stop predecessors and start B. */
export class ExclusiveTopicCoordinator implements ExclusiveTopics {
  constructor(private readonly options: {
    dataDir: string;
    inferOwner?: (input: ExclusiveTopicInput) => Promise<{ ownerAppId: string; selectedAt: number; selectionMessageId: string } | undefined>;
    revokeOtherBots: (owner: TopicExecutionOwner, isCurrent: () => boolean) => Promise<void>;
  }) {
    mkdirSync(join(options.dataDir, 'topic-owners'), { recursive: true });
  }

  currentOwner(chatId: string, rootId: string): string | undefined {
    const identity = { chatId, rootId };
    return readTopicSelection(this.options.dataDir, identity)?.ownerAppId
      ?? readTopicExecutionOwner(this.options.dataDir, identity)?.ownerAppId;
  }

  private async publishSelection(input: ExclusiveTopicInput): Promise<void> {
    if (!input.selectedAppId || input.selectedAppId !== input.larkAppId) return;
    if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0 || !input.messageId) {
      throw new Error('exclusive topic selection needs a stable event identity');
    }
    const path = topicFile(this.options.dataDir, input, 'selection');
    await withFileLock(path, async () => {
      const previous = readTopicSelection(this.options.dataDir, input);
      if (previous && !selectionIsNewer(input, previous)) return;
      const next: TopicSelection = {
        chatId: input.chatId,
        rootId: input.rootId,
        ownerAppId: input.selectedAppId!,
        epoch: previous
          ? previous.epoch + (previous.ownerAppId === input.selectedAppId ? 0 : 1)
          : 1,
        selectedAt: input.createdAt,
        selectionMessageId: input.messageId,
      };
      writeRecord(path, next);
    });
  }

  select(input: ExclusiveTopicInput): Promise<void> {
    return this.publishSelection(input);
  }

  admit(input: ExclusiveTopicInput, action: () => Promise<void>): Promise<boolean> {
    // Publish immediately, but append the complete admission synchronously to
    // the local FIFO before awaiting publication. A plain B follow-up cannot
    // overtake B's first @ while its short selection lock is being acquired.
    const executionPath = topicFile(this.options.dataDir, input, 'execution');
    const publication = this.publishSelection(input).then(
      () => ({ ok: true as const }),
      error => ({ ok: false as const, error }),
    );
    return serializeByAnchor(`exclusive:${input.larkAppId}:${executionPath}`, async () => {
      const published = await publication;
      if (!published.ok) throw published.error;
      return withFileLock(executionPath, async () => {
        let selection = readTopicSelection(this.options.dataDir, input);
        if (!selection && this.options.inferOwner) {
          const inferred = await this.options.inferOwner(input);
          if (inferred) {
            const selectionPath = topicFile(this.options.dataDir, input, 'selection');
            await withFileLock(selectionPath, async () => {
              // A newer explicit selector can publish while history is read.
              if (readTopicSelection(this.options.dataDir, input)) return;
              writeRecord(selectionPath, { ...inferred, chatId: input.chatId, rootId: input.rootId, epoch: 1 });
            });
            selection = readTopicSelection(this.options.dataDir, input);
          }
        }
        if (!selection || selection.ownerAppId !== input.larkAppId) return false;
        const captured = selection;
        const isCurrent = () => {
          const current = readTopicSelection(this.options.dataDir, input);
          return current?.ownerAppId === captured.ownerAppId && current.epoch === captured.epoch;
        };
        let owner = readTopicExecutionOwner(this.options.dataDir, input);
        if (!owner || owner.ownerAppId !== captured.ownerAppId
          || owner.epoch !== captured.epoch || owner.phase !== 'active') {
          owner = { chatId: input.chatId, rootId: input.rootId, ownerAppId: captured.ownerAppId, epoch: captured.epoch, phase: 'handoff' };
          writeRecord(executionPath, owner);
          try {
            await this.options.revokeOtherBots(owner, isCurrent);
          } catch (error) {
            if (!isCurrent()) return false;
            throw error;
          }
          if (!isCurrent()) return false;
          owner = { ...owner, phase: 'active' };
          writeRecord(executionPath, owner);
        }
        if (!isCurrent()) return false;
        await executionContext.run(owner, action);
        return true;
      }, { maxWaitMs: 300_000 });
    }, 0);
  }
}

/** A deferred spawn/input must consult both intentions and the completed
 * handoff. Neither an old session map nor an early selector is execution proof. */
export function topicExecutionAllowed(dataDir: string, input: TopicIdentity & { larkAppId: string; epoch?: number }): boolean {
  const selection = readTopicSelection(dataDir, input);
  const owner = readTopicExecutionOwner(dataDir, input);
  return selection?.ownerAppId === input.larkAppId
    && owner?.ownerAppId === input.larkAppId
    && owner.epoch === selection.epoch
    && (input.epoch === undefined || owner.epoch === input.epoch)
    && owner.phase === 'active';
}
