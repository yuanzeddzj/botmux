import { BoundedMap } from '../../utils/bounded-map.js';

type Message = { message_id: string; chat_id: string; root_id?: string; parent_id?: string; thread_id?: string; chat_type?: string };
type Facts = { message_id?: string; chat_id?: string; thread_id?: string };

/** A quoted reply can become the root of another native thread while Feishu
 * retains the earlier conversation's root_id. Resolve only that ambiguous
 * parent/root shape; ordinary top-level and direct thread replies need no API. */
export function createNestedThreadRootResolver(deps: {
  lookupMessage(appId: string, messageId: string): Promise<Facts | undefined>;
  lookupThreadRoot(appId: string, threadId: string): Promise<Facts | undefined>;
}) {
  const roots = new BoundedMap<string, Promise<string>>(512);
  return async (appId: string, message: Message): Promise<{ rootId: string; threadId: string } | undefined> => {
    if (message.chat_type === 'p2p' || !message.root_id || !message.parent_id
      || message.parent_id === message.root_id) return;
    const source = message.thread_id ? message : await deps.lookupMessage(appId, message.message_id);
    if (!source || source.message_id !== message.message_id || source.chat_id !== message.chat_id) return;
    const threadId = source.thread_id;
    // A plain quote is still top-level. Only REST's native thread identity can
    // turn an event missing thread_id into a genuine nested topic.
    if (!threadId) return;
    const key = JSON.stringify([appId, message.chat_id, threadId]);
    let pending = roots.get(key);
    if (!pending) {
      pending = (async () => {
        const ancestor = await deps.lookupMessage(appId, message.root_id!);
        if (!ancestor || ancestor.message_id !== message.root_id || ancestor.chat_id !== message.chat_id) {
          throw new Error('nested reply ancestor unavailable');
        }
        if (ancestor.thread_id === threadId) return message.root_id!;
        const root = await deps.lookupThreadRoot(appId, threadId);
        if (!root?.message_id || root.chat_id !== message.chat_id || root.thread_id !== threadId) {
          throw new Error('nested reply native thread root unavailable');
        }
        return root.message_id;
      })();
      roots.set(key, pending);
      pending.catch(() => { if (roots.get(key) === pending) roots.delete(key); });
    }
    return { rootId: await pending, threadId };
  };
}
