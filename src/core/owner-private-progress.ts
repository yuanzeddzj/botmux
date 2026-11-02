import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getBot, getOwnerOpenId } from '../bot-registry.js';
import { config } from '../config.js';
import { assertMessageWriteAllowed, getMessageDetail, getMessageThreadId, sendUserMessage, updateMessage } from '../im/lark/client.js';
import { chatAppLink, normalizeBrand, threadAppLink } from '../im/lark/lark-hosts.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';
import type { CotEntry } from '../types.js';
import { larkTransportEnabled, type DaemonSession } from './types.js';
import { ownerGroupProgressRecipient, ownerPrivateProgressRecipient, ownerPrivateProgressTurn } from './owner-only-progress.js';
import { isSubstituteTurn, pickTurnReplyTarget } from './reply-target.js';
import { isSilentScheduledTurn } from './silent-schedule-turns.js';

export type PrivateProgressStatus = 'working' | 'waiting' | 'limited' | 'completed' | 'failed' | 'cancelled' | 'ambiguous' | 'superseded';
export interface PrivateProgressUpdate { text?: string; entries?: CotEntry[]; status?: PrivateProgressStatus }
export interface PrivateProgressReceipt { delivered: boolean; messageId?: string; error?: string }
interface CardIdentity { appId: string; sessionId: string; turnId: string; owner: string; chatId: string;
  rootId: string; createdAt: number; link?: string; title?: string; messageId?: string; closed: boolean; status: PrivateProgressStatus }
interface CardState extends CardIdentity {
  file: string; ds: DaemonSession; rootId: string; link?: string; text: string; entries: CotEntry[];
  status: PrivateProgressStatus; revision: number; sentRevision: number; lastWrite: number;
  inFlight?: Promise<PrivateProgressReceipt>; disabled?: boolean;
  failedRevision?: number;
  waiters: { revision: number; resolve(receipt: PrivateProgressReceipt): void }[];
}
export interface PrivateProgressTransport {
  send(appId: string, owner: string, card: string, uuid: string, beforeWrite: () => void | Promise<void>): Promise<string>;
  patch(appId: string, messageId: string, card: string, beforeWrite: () => void | Promise<void>): Promise<void>;
  thread(appId: string, rootId: string): Promise<string | undefined>;
}
const transport: PrivateProgressTransport = {
  send: (app, owner, card, uuid, beforeWrite) => sendUserMessage(app, owner, card, 'interactive', uuid,
    { timeoutMs: 15000, beforeWrite }),
  patch: (app, id, card, beforeWrite) => updateMessage(app, id, card, { beforeWrite, timeoutMs: 15000 }),
  thread: async (app, root) => (await getMessageThreadId(app, root, { timeoutMs: 10000 })) ?? undefined,
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const terminal = (status: PrivateProgressStatus) => !['working', 'waiting', 'limited'].includes(status);
const labels: Record<PrivateProgressStatus, string> = {
  working: '正在处理', waiting: '等待补充信息', limited: '等待恢复', completed: '处理完成',
  failed: '处理遇到问题', cancelled: '处理已中断', ambiguous: '执行状态待确认', superseded: '已转入后续消息',
};
function bounded(value: string, bytes = 16000): string {
  if (Buffer.byteLength(value) <= bytes) return value;
  let end = Math.min(value.length, bytes);
  while (Buffer.byteLength(value.slice(0, end)) > bytes) end = Math.floor(end * 0.9);
  return value.slice(0, end) + '\n…过程较长，此卡展示部分进展。';
}
export function buildOwnerPrivateProgressCard(input: { status: PrivateProgressStatus; text: string; entries: CotEntry[]; link: string; title?: string }): string {
  const color = input.status === 'completed' ? 'green' : ['failed', 'ambiguous', 'limited'].includes(input.status) ? 'orange' : 'blue';
  const process = bounded(input.entries.slice(-40).map(entry => {
    if (entry.kind === 'thinking' || entry.kind === 'text') return entry.text;
    if (entry.kind === 'tool_call') return '**' + entry.name + '**\n' + (entry.subject ?? '');
    return bounded(entry.result, 1200);
  }).join('\n\n'), 14000);
  return JSON.stringify({ schema: '2.0', config: { update_multi: true, enable_forward: false, width_mode: 'default',
    summary: { content: '任务进展 · ' + labels[input.status] } },
    header: { template: color, title: { tag: 'plain_text', content: '任务进展' },
      subtitle: { tag: 'plain_text', content: input.title?.replace(/\s+/g, ' ').slice(0, 100) || '群聊任务 · 最终答复保留在原会话' },
      icon: { tag: 'standard_icon', token: 'ai-common_colorful' } },
    body: { direction: 'vertical', vertical_spacing: '12px', padding: '12px', elements: [
      { tag: 'markdown', content: '**' + labels[input.status] + '**\n' + bounded(input.text, 2500) },
      { tag: 'collapsible_panel', expanded: false, header: { title: { tag: 'plain_text', content: '思考与处理过程' } },
        elements: [{ tag: 'markdown', content: process || '正在准备处理。' }] },
      { tag: 'button', type: 'primary_filled', width: 'fill', text: { tag: 'plain_text', content: '查看来源' },
        behaviors: [{ type: 'open_url', default_url: input.link }] },
    ] } });
}

/** Approved presentation: one private card per exact owner group turn, with an
 * independent identity and no group fallback or final-answer receipt. */
export class OwnerPrivateProgress {
  private states = new Map<string, CardState>();
  private recoveries = new Map<string, Promise<void>>();
  private recoveringCards = new Map<string, Promise<void>>();
  private enabledApps = new Set<string>();
  constructor(private dataDir: string, private io: PrivateProgressTransport = transport,
    private intervalMs = 1000) {}

  eligible(ds: DaemonSession, turnId?: string): string | undefined {
    const exact = ownerPrivateProgressTurn(ds, turnId);
    if (getBot(ds.larkAppId).config.ownerProgressToDm === true) this.enabledApps.add(ds.larkAppId);
    if (!exact || isSilentScheduledTurn(ds, exact) || isSubstituteTurn(ds, exact) || ds.session.vcMeetingReceiver
      || ds.session.exclusiveTopicLegacyRetired || ds.session.exclusiveTopicRetirement
      || !larkTransportEnabled({ chatId: ds.chatId, apiOnly: getBot(ds.larkAppId).config.apiOnly })) return undefined;
    const recipient = ownerPrivateProgressRecipient(ds.larkAppId, { ...ds.session, chatType: ds.chatType }, exact);
    const known = this.states.get(this.key(ds, exact));
    return recipient ?? (getBot(ds.larkAppId).config.ownerProgressToDm === true
      && known && known.owner === getOwnerOpenId(ds.larkAppId) ? known.owner : undefined);
  }
  hasOpenCard(ds: DaemonSession, turnId: string): boolean {
    const key = this.key(ds, turnId), known = this.states.get(key);
    if (known) return !known.closed;
    try {
      const file = join(this.directory(ds.larkAppId), key + '.json');
      if (!existsSync(file)) return false;
      const record = JSON.parse(readFileSync(file, 'utf8')) as CardIdentity;
      return record.appId === ds.larkAppId && record.sessionId === ds.session.sessionId
        && record.turnId === turnId && record.closed === false;
    } catch { return false; }
  }

  private key(ds: DaemonSession, turnId: string): string {
    return digest(ds.larkAppId + '\0' + ds.session.sessionId + '\0' + turnId);
  }
  private directory(appId: string, closed = false): string {
    return join(this.dataDir, 'owner-private-progress', digest(appId), closed ? 'completed' : 'active');
  }
  private remember(state: CardIdentity & { file: string }): void {
    const dir = this.directory(state.appId, state.closed);
    const record: CardIdentity = { appId: state.appId, sessionId: state.sessionId, turnId: state.turnId,
      owner: state.owner, chatId: state.chatId, rootId: state.rootId, createdAt: state.createdAt,
      link: state.link, title: state.title, messageId: state.messageId, closed: state.closed, status: state.status };
    const path = state.closed ? join(dir, digest(state.appId + '\0' + state.sessionId + '\0' + state.turnId) + '.json') : state.file;
    // The active identity is the durable terminal fence. A crash/failure while
    // moving it to completed must not leave a resumable closed:false record.
    if (state.closed) {
      mkdirSync(this.directory(state.appId), { recursive: true });
      atomicWriteFileSync(state.file, JSON.stringify(record), { mode: 0o600, durable: true });
    }
    mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(path, JSON.stringify(record), { mode: 0o600, durable: true });
  }
  private state(ds: DaemonSession, turnId: string, owner: string): CardState {
    const key = this.key(ds, turnId);
    const known = this.states.get(key);
    if (known) return known;
    const file = join(this.directory(ds.larkAppId), key + '.json');
    const completedFile = join(this.directory(ds.larkAppId, true), key + '.json');
    let old: CardIdentity | undefined;
    if (existsSync(completedFile) || existsSync(file)) {
      const raw = JSON.parse(readFileSync(existsSync(completedFile) ? completedFile : file, 'utf8')) as CardIdentity;
      if (raw.appId !== ds.larkAppId || raw.sessionId !== ds.session.sessionId || raw.turnId !== turnId
        || raw.owner !== owner || raw.chatId !== ds.chatId || typeof raw.closed !== 'boolean'
        || !Number.isFinite(raw.createdAt) || !Object.hasOwn(labels, raw.status)
        || (!raw.closed && !raw.messageId && Date.now() - raw.createdAt > 55 * 60 * 1000)
        || (raw.messageId !== undefined && !raw.messageId.startsWith('om_'))) throw new Error('private_progress_identity_invalid');
      old = raw;
    }
    const target = pickTurnReplyTarget(ds.session, turnId);
    const rootId = target?.rootMessageId ?? (turnId.startsWith('om_') ? turnId : ds.session.rootMessageId);
    const state: CardState = { appId: ds.larkAppId, sessionId: ds.session.sessionId, turnId, owner,
      messageId: old?.messageId, closed: old?.closed ?? false, file, ds, rootId,
      chatId: ds.chatId, createdAt: old?.createdAt ?? Date.now(), link: old?.link,
      title: old?.title ?? ds.session.nativeSessionTitle ?? ds.session.title,
      text: '', entries: [], status: old?.status ?? 'working', revision: 0, sentRevision: -1, lastWrite: 0, waiters: [] };
    if (!state.closed) this.states.set(key, state);
    if (this.states.size > 128) for (const [id, candidate] of this.states) {
      if (candidate.closed && !candidate.inFlight) this.states.delete(id);
      if (this.states.size <= 128) break;
    }
    return state;
  }
  private assertEligible(state: CardState): void {
    if (state.disabled) throw new Error('private_progress_disabled');
    if (this.eligible(state.ds, state.turnId) !== state.owner) throw new Error('private_progress_policy_changed');
  }
  private async beforeWrite(state: CardState): Promise<void> {
    this.assertEligible(state);
    if (getBot(state.appId).config.topicUnavailablePolicy === 'stop' && state.rootId.startsWith('om_')) {
      await assertMessageWriteAllowed(state.appId, state.rootId,
        (app, id) => getMessageDetail(app, id, { timeoutMs: 10000, userCardContent: false }));
    }
    this.assertEligible(state);
  }

  async update(ds: DaemonSession, turnId: string, update: PrivateProgressUpdate): Promise<PrivateProgressReceipt> {
    if (update.status && terminal(update.status)) return this.finish(ds, turnId, update.status, update);
    const owner = this.eligible(ds, turnId);
    if (!owner) return { delivered: false, error: 'private_progress_not_eligible' };
    // Restoring an idle CLI is not a new user task. Screen/old transcript
    // frames may still carry the previous turn id; don't open a phantom card.
    if (ds.activeInteractiveTurn?.turnId !== turnId && !this.hasOpenCard(ds, turnId)) {
      return { delivered: false, error: 'private_progress_turn_not_running' };
    }
    void this.recover(ds.larkAppId);
    // Serialize only this card's recovery. An old, slow card must not hold a
    // global app queue ahead of an unrelated new owner request.
    await this.recoveringCards.get(this.key(ds, turnId));
    if (this.eligible(ds, turnId) !== owner) return { delivered: false, error: 'private_progress_policy_changed' };
    let state: CardState;
    try { state = this.state(ds, turnId, owner); }
    catch { return { delivered: false, error: 'private_progress_identity_unavailable' }; }
    if (state.closed || state.disabled) return { delivered: false, error: 'private_progress_closed' };
    if (terminal(state.status)) return state.inFlight ?? { delivered: false, error: 'private_progress_closing' };
    const changed = (update.text !== undefined && update.text !== state.text)
      || (update.entries !== undefined && update.entries !== state.entries)
      || (update.status !== undefined && update.status !== state.status);
    if (update.text !== undefined) state.text = update.text;
    if (update.entries !== undefined) state.entries = update.entries;
    if (update.status !== undefined) state.status = update.status;
    const requestedRevision = changed || state.revision === 0 ? ++state.revision : state.revision;
    if (state.messageId && state.sentRevision >= requestedRevision) return { delivered: true, messageId: state.messageId };
    const acknowledgement = new Promise<PrivateProgressReceipt>(resolve => { state.waiters.push({ revision: requestedRevision, resolve }); });
    this.ensurePump(state);
    return acknowledgement;
  }
  async finish(ds: DaemonSession, turnId: string, status: PrivateProgressStatus, update?: PrivateProgressUpdate): Promise<PrivateProgressReceipt> {
    const key = this.key(ds, turnId), file = join(this.directory(ds.larkAppId), key + '.json');
    const owner = ownerGroupProgressRecipient(ds.larkAppId, { ...ds.session, chatType: ds.chatType }, turnId)
      ?? this.states.get(key)?.owner;
    if (!owner) return { delivered: false };
    if (!this.states.has(key) && !existsSync(file) && !this.enabledApps.has(ds.larkAppId)
      && getBot(ds.larkAppId).config.ownerProgressToDm !== true) return { delivered: false };
    let state: CardState;
    try { state = this.state(ds, turnId, owner); } catch { return { delivered: false, error: 'private_progress_identity_unavailable' }; }
    if (state.closed) return { delivered: false, error: 'private_progress_closed' };
    if (update?.text !== undefined) state.text = update.text;
    if (update?.entries !== undefined) state.entries = update.entries;
    state.status = status;
    state.closed = true;
    ++state.revision;
    try { this.remember(state); } catch {
      state.disabled = true;
      this.acknowledge(state, Infinity, { delivered: false, error: 'private_progress_terminal_persistence_failed' });
      return { delivered: false, error: 'private_progress_terminal_persistence_failed' };
    }
    // A dispatched recovery request cannot be cancelled by beforeWrite. Wait
    // for this card only, then let its terminal patch be the last writer.
    await this.recoveringCards.get(key);
    if (state.messageId && state.sentRevision >= state.revision) return { delivered: true, messageId: state.messageId };
    // Terminal identity is persisted even with the switch off, but no private
    // update is sent. Re-enabling later cannot reopen this settled turn.
    if (this.eligible(ds, turnId) !== owner || (!state.messageId && !state.inFlight)) {
      if (!state.messageId && !state.inFlight && existsSync(state.file)) unlinkSync(state.file);
      if (!state.inFlight) this.states.delete(key);
      return { delivered: false };
    }
    const acknowledgement = new Promise<PrivateProgressReceipt>(resolve => {
      state.waiters.push({ revision: state.revision, resolve });
    });
    this.ensurePump(state);
    return acknowledgement;
  }
  private acknowledge(state: CardState, through: number, receipt: PrivateProgressReceipt): void {
    const pending = state.waiters;
    state.waiters = [];
    for (const waiter of pending) {
      if (waiter.revision <= through) waiter.resolve(receipt);
      else state.waiters.push(waiter);
    }
  }
  private ensurePump(state: CardState): void {
    if (state.inFlight) return;
    state.inFlight = this.pump(state).finally(() => {
      state.inFlight = undefined;
      if (!state.disabled && state.sentRevision !== state.revision && state.failedRevision !== state.revision) this.ensurePump(state);
      else if (state.closed) this.states.delete(this.key(state.ds, state.turnId));
    });
  }
  private async pump(state: CardState): Promise<PrivateProgressReceipt> {
    try {
      if (!state.link) {
        const brand = normalizeBrand(getBot(state.appId).config.brand);
        state.link = chatAppLink(state.ds.chatId, brand);
        if (state.rootId.startsWith('om_')) {
          const thread = await this.io.thread(state.appId, state.rootId).catch(() => undefined);
          if (thread) state.link = threadAppLink(state.ds.chatId, thread, brand);
        }
      }
      while (state.sentRevision !== state.revision) {
        const delay = state.messageId ? this.intervalMs - (Date.now() - state.lastWrite) : 0;
        if (delay > 0) await new Promise<void>(resolve => setTimeout(resolve, delay));
        this.assertEligible(state);
        const revision = state.revision;
        state.title = state.ds.session.nativeSessionTitle ?? state.ds.session.title ?? state.title;
        const card = buildOwnerPrivateProgressCard({ ...state, link: state.link });
        if (state.messageId) {
          await this.io.patch(state.appId, state.messageId, card, () => this.beforeWrite(state));
        } else {
          // Persist an intent first; a lost create acknowledgement can retry
          // the same provider uuid instead of creating a second process card.
          this.remember(state);
          const id = await this.io.send(state.appId, state.owner, card,
            digest(state.appId + '\0' + state.sessionId + '\0' + state.turnId).slice(0, 32), () => this.beforeWrite(state));
          if (!id?.startsWith('om_')) throw new Error('private_progress_missing_message_id');
          state.messageId = id;
          this.remember(state);
        }
        state.lastWrite = Date.now();
        state.sentRevision = revision;
        this.acknowledge(state, revision, { delivered: true, messageId: state.messageId });
        if (terminal(state.status) && state.revision === revision) {
          state.closed = true;
          this.remember(state);
          if (existsSync(state.file)) unlinkSync(state.file);
          state.entries = []; state.text = '';
          break;
        }
      }
      return { delivered: true, messageId: state.messageId };
    } catch (error) {
      state.disabled ||= !(error instanceof Error && error.message === 'private_progress_policy_changed');
      state.failedRevision = state.revision;
      this.acknowledge(state, Infinity, { delivered: false, error: 'private_progress_delivery_failed' });
      logger.warn('[owner-private-progress] private process display stopped; final reply remains independent');
      return { delivered: false, error: 'private_progress_delivery_failed' };
    }
  }

  recover(appId: string, force = false): Promise<void> {
    let recovery = this.recoveries.get(appId);
    if (!recovery || force) {
      recovery = this.recoverRecords(appId);
      this.recoveries.set(appId, recovery);
    }
    return recovery;
  }
  private async recoverRecords(appId: string): Promise<void> {
    const dir = this.directory(appId);
    if (!existsSync(dir)) return;
    const jobs = readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => {
      const key = name.slice(0, -5);
      const existing = this.recoveringCards.get(key);
      if (existing) return existing;
      const job = (async () => { try {
        const completedFile = join(this.directory(appId, true), name);
        const old = JSON.parse(readFileSync(existsSync(completedFile) ? completedFile : join(dir, name), 'utf8')) as CardIdentity;
        if (old.appId !== appId || !old.owner?.startsWith('ou_')) return;
        if (old.closed && !old.messageId) {
          mkdirSync(this.directory(appId, true), { recursive: true });
          atomicWriteFileSync(completedFile, JSON.stringify(old), { mode: 0o600, durable: true });
          unlinkSync(join(dir, name)); return;
        }
        if (!old.messageId?.startsWith('om_')) return;
        const beforeWrite = () => {
          const current = this.states.get(key);
          if (getBot(appId).config.ownerProgressToDm !== true || getOwnerOpenId(appId) !== old.owner
            || (current && (!current.closed || current.inFlight))) {
            throw new Error('private_progress_recovery_not_current');
          }
        };
        beforeWrite();
        const status = old.closed && old.status && terminal(old.status) ? old.status : 'ambiguous';
        await this.io.patch(appId, old.messageId, buildOwnerPrivateProgressCard({ status,
          text: old.closed ? '处理已结束，请以原会话的答复为准。' : '过程展示已重启，请以原会话的答复为准。', entries: [],
          title: old.title, link: old.link ?? chatAppLink(old.chatId, normalizeBrand(getBot(appId).config.brand)) }), beforeWrite);
        if (old.closed) {
          mkdirSync(this.directory(appId, true), { recursive: true });
          atomicWriteFileSync(completedFile, JSON.stringify(old), { mode: 0o600, durable: true });
          unlinkSync(join(dir, name));
        }
        // Keep the card resumable: a still-running exact turn can replace this
        // generic restart notice when its next authenticated update arrives.
      } catch { logger.warn('[owner-private-progress] restart display cleanup deferred'); } })();
      this.recoveringCards.set(key, job);
      return job.finally(() => { this.recoveringCards.delete(key); });
    });
    await Promise.allSettled(jobs);
  }
}
let manager: OwnerPrivateProgress | undefined;
export function ownerPrivateProgressManager(): OwnerPrivateProgress {
  return manager ??= new OwnerPrivateProgress(config.session.dataDir);
}
