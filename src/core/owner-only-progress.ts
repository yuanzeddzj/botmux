import { getBot, getOwnerOpenId } from '../bot-registry.js';
import type { Session } from '../types.js';
import type { DaemonSession } from './types.js';
import { pickTurnReplyTarget, registryEntryProvesHumanSender } from './reply-target.js';
type ProgressSession = Pick<Session, 'replyTargets' | 'currentReplyTarget' | 'quoteTargetId' | 'quoteTargetSenderOpenId'>;

function progressOwner(appId: string): string | undefined {
  return getOwnerOpenId(appId) ?? getBot(appId).progressOwnerOpenId;
}

/** Only the real human sender of this exact turn determines its presentation.
 * The session owner and people mentioned by the sender are never substitutes.
 * Non-human scheduled/peer work retains its existing delivery policy. */
export function nonOwnerHumanProgressSuppressed(appId: string, session: ProgressSession, turnId: string | undefined): boolean {
  if (!turnId) return false;
  try { if (getBot(appId).config.ownerOnlyProgress !== true) return false; }
  catch { return false; }
  const entry = pickTurnReplyTarget(session, turnId);
  if (!registryEntryProvesHumanSender(entry)) return false;
  return entry.senderOpenId !== progressOwner(appId);
}

/** Unattributed startup frames belong to the running turn, rather than a newer
 * accepted turn that may already be queued in this same conversation. */
export function ownerOnlyProgressSuppressed(ds: DaemonSession, turnId?: string): boolean {
  const exact = turnId ?? ds.activeInteractiveTurn?.turnId ?? ds.currentTurnId
    ?? ds.currentReplyTarget?.turnId ?? ds.session.currentReplyTarget?.turnId;
  return nonOwnerHumanProgressSuppressed(ds.larkAppId, ds.session, exact);
}

export function nonOwnerHumanSendSuppressed(
  appId: string, session: ProgressSession, turnId: string | undefined, responseKind: 'progress' | 'final' | 'auxiliary',
): boolean {
  return responseKind !== 'final' && nonOwnerHumanProgressSuppressed(appId, session, turnId);
}

/** The group's process display belongs to its exact human sender, never to
 * a mentioned owner, a co-admin, or the creator of the shared session. */
export function ownerPrivateProgressRecipient(
  appId: string, session: ProgressSession & { chatType?: 'group' | 'p2p' }, turnId?: string,
): string | undefined {
  if (!turnId || session.chatType !== 'group') return undefined;
  try {
    if (getBot(appId).config.ownerProgressToDm !== true) return undefined;
    return ownerGroupProgressRecipient(appId, session, turnId);
  } catch { return undefined; }
}

/** Principal proof is independent of whether the presentation is enabled;
 * terminal persistence must survive a mid-turn display toggle. */
export function ownerGroupProgressRecipient(
  appId: string, session: ProgressSession & { chatType?: 'group' | 'p2p' }, turnId?: string,
): string | undefined {
  if (!turnId || session.chatType !== 'group') return undefined;
  try {
    const entry = pickTurnReplyTarget(session, turnId);
    const owner = progressOwner(appId);
    return owner && registryEntryProvesHumanSender(entry) && entry.senderOpenId === owner ? owner : undefined;
  } catch { return undefined; }
}

export function ownerPrivateProgressTurn(ds: DaemonSession, turnId?: string): string | undefined {
  return turnId ?? ds.activeInteractiveTurn?.turnId ?? ds.currentTurnId
    ?? ds.currentReplyTarget?.turnId ?? ds.session.currentReplyTarget?.turnId;
}

/** Reactions remain governed by ownerOnlyProgress; only the process channels
 * move to a DM. Keep these decisions separate. */
export function publicProgressSuppressed(ds: DaemonSession, turnId?: string): boolean {
  const exact = ownerPrivateProgressTurn(ds, turnId);
  return ownerOnlyProgressSuppressed(ds, exact)
    || !!ownerPrivateProgressRecipient(ds.larkAppId, { ...ds.session, chatType: ds.chatType }, exact)
    || privateProgressSenderUnproven(ds.larkAppId, { ...ds.session, chatType: ds.chatType }, exact);
}

/** Lost/pruned attribution on a native group message cannot authorize public
 * process output. Proven bots and synthetic schedule keys retain their path. */
export function privateProgressSenderUnproven(
  appId: string, session: ProgressSession & { chatType?: 'group' | 'p2p' }, turnId?: string,
): boolean {
  if (session.chatType !== 'group' || !turnId?.startsWith('om_')) return false;
  try { if (getBot(appId).config.ownerProgressToDm !== true) return false; } catch { return false; }
  const entry = pickTurnReplyTarget(session, turnId);
  if (registryEntryProvesHumanSender(entry)) return false;
  return !entry?.senderOpenId || !entry.participants?.some(p => p.openId === entry.senderOpenId && p.isBot === true);
}
