import { BoundedMap } from '../../utils/bounded-map.js';
import type { TopicSelection } from '../../services/exclusive-topic-owner.js';

/** Match only a person's explicit text/post address. Forwarded cards retain
 * old mentions, so they cannot trigger an owner's delegated follow-up. */
export function isOwnerMentionFollowupAddress(message: any, ownerOpenId: string | undefined): boolean {
  if (!ownerOpenId || message?.chat_type === 'p2p' || (!message?.root_id && !message?.thread_id)
    || !['text', 'post'].includes(message?.message_type ?? message?.msg_type)) return false;
  const mentions = message.mentions ?? [];
  if (mentions.some((m: any) => m.mentioned_type === 'bot' || m.id?.app_id || m.id_type === 'app_id')) return false;
  return mentions.some((m: any) => (m.id?.open_id ?? (m.id_type === 'open_id' ? m.id : undefined)) === ownerOpenId);
}

/** Owner delegation is bound to the current selected bot/topic. Older
 * selections are verified once against their original human selection, using
 * the same app's message identity rather than a display-name match. */
export function createOwnerMentionFollowupResolver(deps: {
  currentSelection(chatId: string, rootId: string): TopicSelection | undefined;
  lookupSelector(appId: string, messageId: string): Promise<{ chatId: string; openId: string; mentionedThisBot: boolean } | undefined>;
}) {
  const verified = new BoundedMap<string, Promise<boolean>>(512);
  return async (appId: string, chatId: string, rootId: string, ownerOpenId: string): Promise<boolean> => {
    const selection = deps.currentSelection(chatId, rootId);
    if (!selection || selection.protocol !== 'v2' || selection.ownerAppId !== appId) return false;
    if (selection.followupOwnerOpenId !== undefined) return selection.followupOwnerOpenId === ownerOpenId;
    const key = JSON.stringify([appId, chatId, rootId, selection.epoch, selection.selectionMessageId, ownerOpenId]);
    let check = verified.get(key);
    if (!check) {
      check = deps.lookupSelector(appId, selection.selectionMessageId).then(selector =>
        selector?.chatId === chatId && selector.openId === ownerOpenId && selector.mentionedThisBot === true);
      verified.set(key, check);
      check.catch(() => { if (verified.get(key) === check) verified.delete(key); });
    }
    if (!await check) return false;
    const current = deps.currentSelection(chatId, rootId);
    return current?.ownerAppId === appId && current.epoch === selection.epoch
      && current.selectionMessageId === selection.selectionMessageId;
  };
}
