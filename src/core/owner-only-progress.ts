import { getBot, getOwnerOpenId } from '../bot-registry.js';
import type { Session } from '../types.js';
import type { DaemonSession } from './types.js';
import { pickTurnReplyTarget, registryEntryProvesHumanSender } from './reply-target.js';
type ProgressSession = Pick<Session, 'replyTargets' | 'currentReplyTarget' | 'quoteTargetId' | 'quoteTargetSenderOpenId'>;

/** Only the real human sender of this exact turn determines its presentation.
 * The session owner and people mentioned by the sender are never substitutes.
 * Non-human scheduled/peer work retains its existing delivery policy. */
export function nonOwnerHumanProgressSuppressed(appId: string, session: ProgressSession, turnId: string | undefined): boolean {
  if (!turnId) return false;
  try { if (getBot(appId).config.ownerOnlyProgress !== true) return false; }
  catch { return false; }
  const entry = pickTurnReplyTarget(session, turnId);
  if (!registryEntryProvesHumanSender(entry)) return false;
  return entry.senderOpenId !== getOwnerOpenId(appId);
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
