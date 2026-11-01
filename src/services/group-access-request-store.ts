import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';
import { serializeByAnchor } from '../utils/anchor-serializer.js';

export interface GroupAccessRequest {
  version: 1;
  appId: string;
  chatId: string;
  ownerOpenId: string;
  nonce: string;
  chatName: string;
  reason: 'joined' | 'mention';
  state: 'pending' | 'approving' | 'approved' | 'denied';
  createdAt: number;
  decidedAt?: number;
  messageId?: string;
  messageData?: unknown;
  replayClaimed?: boolean;
  requester?: { openId: string; name: string; messageId: string };
  approvalScope?: 'group' | 'person';
  deliveredRequesterOpenId?: string;
}

/** One durable decision per bot/group. Pending cards have no expiry. */
export class GroupAccessRequestStore {
  constructor(private readonly dataDir: string) {}

  private path(appId: string, chatId: string): string {
    if (!appId || !/^oc_[\w-]+$/.test(chatId)) throw new Error('invalid group access identity');
    const dir = join(this.dataDir, 'group-access-requests', encodeURIComponent(appId));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return join(dir, createHash('sha256').update(chatId).digest('hex') + '.json');
  }

  read(appId: string, chatId: string): GroupAccessRequest | undefined {
    let raw: string;
    try { raw = readFileSync(this.path(appId, chatId), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const v = JSON.parse(raw) as GroupAccessRequest;
    if (!v || v.version !== 1 || v.appId !== appId || v.chatId !== chatId
      || typeof v.ownerOpenId !== 'string' || !v.ownerOpenId
      || typeof v.nonce !== 'string' || !v.nonce
      || typeof v.chatName !== 'string'
      || !['joined', 'mention'].includes(v.reason)
      || !['pending', 'approving', 'approved', 'denied'].includes(v.state)
      || !Number.isSafeInteger(v.createdAt) || v.createdAt < 0
      || (v.messageId !== undefined && typeof v.messageId !== 'string')
      || (v.approvalScope !== undefined && !['group', 'person'].includes(v.approvalScope))
      || (v.deliveredRequesterOpenId !== undefined && !/^ou_[\w-]+$/.test(v.deliveredRequesterOpenId))
      || (v.requester !== undefined && (!/^ou_[\w-]+$/.test(v.requester.openId)
        || typeof v.requester.name !== 'string' || typeof v.requester.messageId !== 'string'))
      || (v.decidedAt !== undefined && !Number.isSafeInteger(v.decidedAt))) {
      throw new Error('invalid group access request record');
    }
    return v;
  }

  async transact<T>(appId: string, chatId: string, action: (
    record: GroupAccessRequest | undefined,
    save: (next: GroupAccessRequest) => void,
  ) => Promise<T>): Promise<T> {
    const path = this.path(appId, chatId);
    return serializeByAnchor(`group-access:${path}`, () => withFileLock(path, async () => action(this.read(appId, chatId), next => {
      if (next.appId !== appId || next.chatId !== chatId) throw new Error('group access identity changed');
      atomicWriteFileSync(path, JSON.stringify(next) + '\n', { mode: 0o600, durable: true });
    }), { maxWaitMs: 30_000 }), 0);
  }
}
