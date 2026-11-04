import { getOwnerOpenId } from '../bot-registry.js';
import { getChatInfo, listChatUserMembers } from '../im/lark/client.js';
import { handleCotThinkingUpdate } from '../im/lark/cot-message.js';
import type { DaemonSession } from './types.js';
import type { CotEntry } from '../types.js';
import {
  noteOwnerGroupAudience, ownerGroupAudience, ownerPrivateProgressRecipient, ownerPrivateProgressTurn,
} from './owner-only-progress.js';

const AUDIENCE_TTL_MS = 5 * 60 * 1000;
const AUDIENCE_ERROR_TTL_MS = 30 * 1000;
const resolving = new Map<string, Promise<boolean>>();

/** True when the group's only human member is this app's owner. A lookup
 * failure is treated as a shared group so process text stays out of the chat. */
export async function resolveOwnerOnlyGroup(appId: string, chatId: string): Promise<boolean> {
  const known = ownerGroupAudience(appId, chatId);
  if (known) return known === 'owner-only';
  const key = appId + '\0' + chatId;
  let job = resolving.get(key);
  if (!job) {
    job = loadOwnerOnlyGroup(appId, chatId).finally(() => resolving.delete(key));
    resolving.set(key, job);
  }
  return job;
}

async function loadOwnerOnlyGroup(appId: string, chatId: string): Promise<boolean> {
  try {
    const info = await getChatInfo(appId, chatId);
    if (info.userCount !== 1) {
      noteOwnerGroupAudience(appId, chatId, 'shared', AUDIENCE_TTL_MS);
      return false;
    }
    const members = await listChatUserMembers(appId, chatId);
    const owner = getOwnerOpenId(appId);
    const solo = !!owner && members.length === 1 && members[0]?.openId === owner;
    noteOwnerGroupAudience(appId, chatId, solo ? 'owner-only' : 'shared', AUDIENCE_TTL_MS);
    return solo;
  } catch {
    noteOwnerGroupAudience(appId, chatId, 'shared', AUDIENCE_ERROR_TTL_MS);
    return false;
  }
}

/** Owner group progress uses the native thinking bubble. An owner-only group
 * keeps it under the original message. Any other human sends the same bubble
 * to the owner's private chat. */
export async function presentOwnerGroupProgress(
  ds: DaemonSession,
  msg: { type: 'thinking_update'; entries: CotEntry[]; turnId: string; dispatchAttempt?: number },
): Promise<void> {
  const turnId = ownerPrivateProgressTurn(ds, msg.turnId);
  const owner = turnId
    ? ownerPrivateProgressRecipient(ds.larkAppId, { ...ds.session, chatType: ds.chatType }, turnId)
    : undefined;
  if (!owner || !ds.chatId) return;
  const inGroup = ownerGroupAudience(ds.larkAppId, ds.chatId) === 'owner-only'
    || await resolveOwnerOnlyGroup(ds.larkAppId, ds.chatId);
  handleCotThinkingUpdate(ds, msg, inGroup ? undefined : { ownerOpenId: owner });
}
