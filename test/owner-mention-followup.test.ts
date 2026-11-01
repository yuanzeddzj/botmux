import { describe, expect, it, vi } from 'vitest';
import { createOwnerMentionFollowupResolver, isOwnerMentionFollowupAddress } from '../src/im/lark/owner-mention-followup.js';
import type { TopicSelection } from '../src/services/exclusive-topic-owner.js';

const selection = (): TopicSelection => ({ chatId: 'oc_chat', rootId: 'om_topic', ownerAppId: 'cli_a', epoch: 1,
  selectedAt: 1, selectionMessageId: 'om_select', protocol: 'v2', followupOwnerOpenId: 'ou_owner' });
const message = () => ({ chat_type: 'group', message_type: 'text', root_id: 'om_topic', thread_id: 'omt_topic',
  message_id: 'om_followup', mentions: [{ id: { open_id: 'ou_owner' }, mentioned_type: 'user' }] });

describe('owner-addressed topic follow-ups', () => {
  it('matches an exact owner address only inside a real topic-shaped message', () => {
    expect(isOwnerMentionFollowupAddress(message(), 'ou_owner')).toBe(true);
    expect(isOwnerMentionFollowupAddress({ ...message(), mentions: [{ id: { open_id: 'ou_other' } }] }, 'ou_owner')).toBe(false);
    expect(isOwnerMentionFollowupAddress({ ...message(), root_id: undefined, thread_id: undefined }, 'ou_owner')).toBe(false);
    expect(isOwnerMentionFollowupAddress({ ...message(), chat_type: 'p2p' }, 'ou_owner')).toBe(false);
    expect(isOwnerMentionFollowupAddress(message(), undefined)).toBe(false);
  });
  it('ignores forwarded mentions, @all and explicit bot addresses', () => {
    for (const type of ['interactive', 'merge_forward', 'image']) expect(isOwnerMentionFollowupAddress({ ...message(), message_type: type }, 'ou_owner')).toBe(false);
    expect(isOwnerMentionFollowupAddress({ ...message(), mentions: [{ id: { open_id: 'all' } }] }, 'ou_owner')).toBe(false);
    expect(isOwnerMentionFollowupAddress({ ...message(), mentions: [...message().mentions, { id: { open_id: 'ou_bot' }, mentioned_type: 'bot' }] }, 'ou_owner')).toBe(false);
  });
  it('admits only the selected bot whose current topic was delegated by the owner', async () => {
    const lookupSelector = vi.fn(), row = selection();
    const resolve = createOwnerMentionFollowupResolver({ currentSelection: () => row, lookupSelector });
    expect(await resolve('cli_a', 'oc_chat', 'om_topic', 'ou_owner')).toBe(true);
    expect(await resolve('cli_b', 'oc_chat', 'om_topic', 'ou_owner')).toBe(false);
    expect(await resolve('cli_a', 'oc_chat', 'om_topic', 'ou_newowner')).toBe(false);
    expect(lookupSelector).not.toHaveBeenCalled();
  });
  it('backfills verification of older selections using the real owner selector, caching by epoch', async () => {
    const row = selection(); delete row.followupOwnerOpenId;
    const lookupSelector = vi.fn(async () => ({ chatId: 'oc_chat', openId: 'ou_owner', mentionedThisBot: true }));
    const resolve = createOwnerMentionFollowupResolver({ currentSelection: () => row, lookupSelector });
    expect(await resolve('cli_a', 'oc_chat', 'om_topic', 'ou_owner')).toBe(true);
    expect(await resolve('cli_a', 'oc_chat', 'om_topic', 'ou_owner')).toBe(true);
    expect(lookupSelector).toHaveBeenCalledTimes(1);
    row.epoch = 2; row.selectionMessageId = 'om_next';
    expect(await resolve('cli_a', 'oc_chat', 'om_topic', 'ou_owner')).toBe(true);
    expect(lookupSelector).toHaveBeenCalledTimes(2);
  });
  it('rejects non-owner selectors, missing selection and a handoff during verification', async () => {
    let row: TopicSelection | undefined = selection(); delete row.followupOwnerOpenId;
    const lookupSelector = vi.fn(async () => ({ chatId: 'oc_chat', openId: 'ou_guest', mentionedThisBot: true }));
    const resolve = createOwnerMentionFollowupResolver({ currentSelection: () => row, lookupSelector });
    expect(await resolve('cli_a', 'oc_chat', 'om_topic', 'ou_owner')).toBe(false);
    row = undefined; expect(await resolve('cli_a', 'oc_chat', 'om_topic', 'ou_owner')).toBe(false);
    row = selection(); delete row.followupOwnerOpenId; row.epoch = 2;
    lookupSelector.mockImplementationOnce(async () => { row = { ...row!, ownerAppId: 'cli_b' }; return { chatId: 'oc_chat', openId: 'ou_owner', mentionedThisBot: true }; });
    expect(await resolve('cli_a', 'oc_chat', 'om_topic', 'ou_owner')).toBe(false);
  });
});
