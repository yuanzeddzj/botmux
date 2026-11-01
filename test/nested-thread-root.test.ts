import { describe, expect, it, vi } from 'vitest';
import { createNestedThreadRootResolver } from '../src/im/lark/nested-thread-root.js';

const source = { message_id: 'om_at', chat_id: 'oc_group', root_id: 'om_ancestor', parent_id: 'om_quote', chat_type: 'group' };
const deps = () => ({
  lookupMessage: vi.fn(async (_app: string, id: string) => ({ message_id: id, chat_id: 'oc_group',
    thread_id: id === 'om_at' ? 'omt_child' : 'omt_parent' })),
  lookupThreadRoot: vi.fn(async () => ({ message_id: 'om_at', chat_id: 'oc_group', thread_id: 'omt_child' })),
});

describe('nested native thread roots', () => {
  it('uses the actual child thread when its seed retains an ancestor root', async () => {
    const d = deps();
    expect(await createNestedThreadRootResolver(d)('cli_app', source)).toEqual({ rootId: 'om_at', threadId: 'omt_child' });
    expect(d.lookupThreadRoot).toHaveBeenCalledExactlyOnceWith('cli_app', 'omt_child');
  });
  it('does not promote an ordinary quoted top-level message into a thread', async () => {
    const d = deps(); d.lookupMessage.mockResolvedValue({ ...source, thread_id: undefined as any });
    expect(await createNestedThreadRootResolver(d)('cli_app', source)).toBeUndefined();
    expect(d.lookupThreadRoot).not.toHaveBeenCalled();
  });
  it('keeps an ordinary in-thread quote when the ancestor is in the same native thread', async () => {
    const d = deps(); d.lookupMessage.mockResolvedValue({ message_id: 'om_ancestor', chat_id: 'oc_group', thread_id: 'omt_child' });
    expect(await createNestedThreadRootResolver(d)('cli_app', { ...source, thread_id: 'omt_child' })).toEqual({ rootId: 'om_ancestor', threadId: 'omt_child' });
    expect(d.lookupThreadRoot).not.toHaveBeenCalled();
  });
  it('does not perform extra reads for direct replies, top-level messages or private chats', async () => {
    const d = deps(), resolve = createNestedThreadRootResolver(d);
    expect(await resolve('cli_app', { ...source, parent_id: 'om_ancestor' })).toBeUndefined();
    expect(await resolve('cli_app', { ...source, root_id: undefined })).toBeUndefined();
    expect(await resolve('cli_app', { ...source, chat_type: 'p2p' })).toBeUndefined();
    expect(d.lookupMessage).not.toHaveBeenCalled();
  });
  it('deduplicates native root reads while keeping app and chat identities isolated', async () => {
    const d = deps(), resolve = createNestedThreadRootResolver(d), message = { ...source, thread_id: 'omt_child' };
    await Promise.all([resolve('cli_app', message), resolve('cli_app', message)]);
    expect(d.lookupThreadRoot).toHaveBeenCalledTimes(1);
    await resolve('cli_peer', message); expect(d.lookupThreadRoot).toHaveBeenCalledTimes(2);
  });
  it('rejects a mismatched container result and retries after the lookup recovers', async () => {
    const d = deps(), resolve = createNestedThreadRootResolver(d);
    d.lookupThreadRoot.mockResolvedValueOnce({ message_id: 'om_wrong', chat_id: 'oc_other', thread_id: 'omt_child' });
    await expect(resolve('cli_app', source)).rejects.toThrow('native thread root unavailable');
    expect(await resolve('cli_app', source)).toEqual({ rootId: 'om_at', threadId: 'omt_child' });
  });
  it('does not reuse an unverified ancestor when native identity is known', async () => {
    const d = deps(); d.lookupMessage.mockResolvedValueOnce({ message_id: 'om_at', chat_id: 'oc_group', thread_id: 'omt_child' })
      .mockResolvedValueOnce(undefined as any);
    await expect(createNestedThreadRootResolver(d)('cli_app', source)).rejects.toThrow('ancestor unavailable');
  });
});
