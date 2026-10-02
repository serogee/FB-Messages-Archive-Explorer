import { describe, expect, it } from 'vitest';
import { buildReactionBlocks, compactReactionThread, inferReactionOwner, matchReactionThread } from '../src/services/reactionMatching';
import { getRecordedReactionTime, getReactionTimestamp, formatReactionTime, isReactionNoticeMessage } from '../src/services/reactions';
import { assignReactionActivityBlocks, parseStrictReactionNoticeText } from '../src/services/reactionNoticeClassifier';
import { readReactionFile, validateReactionInput } from '../src/services/reactionSnapshot';
import { discoverReactionConversations } from '../src/services/reactionAuditInventory';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';
import type { MessengerMessage, MessengerThread } from '../src/types/messenger';
const emoji = '\u{1f602}', heart = '\u2764';
const message = (t: number, reaction = emoji, actor = 'Alice'): MessengerMessage => ({ sender_name: 'Owner', timestamp_ms: t, content: 'hello', reactions: [{ actor, reaction }] });
const notice = (t: number, reaction = emoji, sender = 'Alice'): MessengerMessage => ({ sender_name: sender, timestamp_ms: t, content: `Wrong embedded name reacted ${reaction} to your message` });
const thread = (messages: MessengerMessage[]): MessengerThread => ({ messages, participants: [{ name: 'Owner' }, { name: 'Alice' }], title: 'test', thread_path: 'inbox/test', is_still_participant: true });
const match = (messages: MessengerMessage[], mode: 'near' | 'aggressive' = 'near') => matchReactionThread(compactReactionThread(thread(messages)), 'Owner', mode).estimates;

describe('reaction source and hiding contracts', () => {
  it('identifies original file bytes even when decoding gives identical text', async () => {
    const text = '{"messages":[]}';
    const original = new File([text], 'message_1.json');
    const withBom = new File([new Uint8Array([0xef, 0xbb, 0xbf]), text], 'message_1.json');
    const a = await readReactionFile(original), b = await readReactionFile(withBom);
    expect(a.text).toBe(b.text);
    expect(a.hash).not.toBe(b.hash);
    expect(a.hash).toBe((await readReactionFile(original)).hash);
  });

  it('recognizes both name forms and emoji sequences but rejects commentary for matching', () => {
    expect(parseStrictReactionNoticeText(`reacted ${emoji} to your message`)).not.toBeNull();
    expect(parseStrictReactionNoticeText(`Alice reacted ${emoji} to your message.`)).not.toBeNull();
    expect(parseStrictReactionNoticeText(`Alice reacted ${emoji} to your message: just kidding`)).toBeNull();
    expect(parseStrictReactionNoticeText('Alice reacted hello to your message')).toBeNull();
  });
  it('hides plain-text lookalikes but protects malformed/pathless media and reaction payloads', () => {
    const n = notice(1);
    expect(isReactionNoticeMessage(n)).toBe(true);
    expect(isReactionNoticeMessage({ ...n, content: `${n.content}!` })).toBe(true);
    expect(isReactionNoticeMessage({ ...n, _isReactionNotice: false })).toBe(true);
    expect(isReactionNoticeMessage({ ...n, photos: [{}] })).toBe(false);
    expect(isReactionNoticeMessage({ ...n, photos: null } as never)).toBe(false);
    expect(isReactionNoticeMessage({ ...n, share: {} })).toBe(false);
    expect(isReactionNoticeMessage({ ...n, content: `${n.content}. https://example.com` })).toBe(false);
    expect(isReactionNoticeMessage({ ...n, reactions: [{ actor: 'Alice', reaction: emoji }] })).toBe(false);
  });
  it('keeps missing distinct from invalid, unsupported or imported time values', () => {
    expect(getReactionTimestamp({ actor: 'A', reaction: emoji, timestamp: 1700000000 })).toBe(1700000000000);
    for (const timestamp of [0, -1, null, undefined, '1700000000', .5, Infinity]) expect(getRecordedReactionTime({ actor: 'A', reaction: emoji, timestamp } as never).kind).toBe('invalid');
    expect(getRecordedReactionTime({ actor: 'A', reaction: emoji }).kind).toBe('missing');
    expect(getReactionTimestamp({ actor: 'A', reaction: emoji, timestamp_ms: 1700000000000 })).toBe(0);
    expect(getReactionTimestamp({ actor: 'A', reaction: emoji, __timestamp: 1 })).toBe(0);
    expect(formatReactionTime(1700000000000, 'strict')).toMatch(/^~ /);
    expect(formatReactionTime(1700000000000, 'local')).toMatch(/^~ /);
    expect(formatReactionTime(1700000000000, 'cross')).toMatch(/^~~ /);
    expect(formatReactionTime(1700000000000)).not.toContain('~');
  });
});
describe('activity blocks and indexed matching', () => {
  it('keeps interleaved notices together and matches every eligible in-block reaction', () => {
    const input = [message(1000), message(2000, heart), notice(3000), { sender_name: 'Alice', timestamp_ms: 4000, content: 'ordinary reply' }, message(5000), notice(6000, heart), notice(7000)];
    expect([...buildReactionBlocks(input)]).toEqual([0, 0, 0, 0, 0, 0, 0]);
    const estimates = match(input);
    expect(estimates).toHaveLength(3);
    expect(new Set(estimates.map(e => `${e.messageIndex}:${e.reactionIndex}`)).size).toBe(3);
    expect(estimates.every(e => e.method !== 'cross')).toBe(true);
  });
  it('does not stop after one pair in a balanced repeated group and leaves only excess', () => {
    const input = [message(1), message(2), message(3), message(4), notice(5), notice(6), notice(7), notice(8), notice(9)];
    expect(match(input)).toHaveLength(4);
    expect(match(input).map(e => e.timestamp).sort()).toEqual([6, 7, 8, 9]);
    expect(match(input.slice(0, -2))).toHaveLength(3);
  });
  it('keeps a following notice cluster with targets at the size cap', () => {
    const input = Array.from({ length: 50 }, (_, i) => message(i + 1));
    input.push(notice(51), notice(52), notice(53));
    expect(buildReactionBlocks(input)[52]).toBe(0);
    expect(match(input)).toHaveLength(3);
  });
  it('extends past the time cutoff until included reactions have pairs, then excludes surplus notices', () => {
    const late = 31 * 60_000;
    const input = [message(1), message(2), notice(3), { sender_name: 'Alice', timestamp_ms: late, content: 'ordinary reply' }, notice(late + 1), notice(late + 2)];
    expect([...buildReactionBlocks(input)]).toEqual([0, 0, 0, 0, 0, 1]);
    const near = match(input);
    expect(near).toHaveLength(2);
    expect(near.map(e => e.noticeIndex).sort()).toEqual([2, 4]);
    expect(near.every(e => e.method === 'local')).toBe(true);
    for (const estimate of near) expect(match(input, 'aggressive')).toContainEqual(estimate);
  });
  it('closes the extension before a new reaction-bearing message even after ordinary messages bridge the gap', () => {
    const late = 31 * 60_000;
    const input = [message(1), message(2), { sender_name: 'Alice', timestamp_ms: late, content: 'reply' }, message(late + 1), notice(late + 2), notice(late + 3)];
    expect([...buildReactionBlocks(input)]).toEqual([0, 0, 0, 1, 1, 1]);
    const near = match(input);
    expect(near).toHaveLength(1);
    expect(near[0].messageIndex).toBe(3);
    expect(match(input, 'aggressive')).toHaveLength(2);
  });
  it('counts each reaction separately and requires an earlier exact actor/emoji partner', () => {
    const late = 31 * 60_000;
    const target = message(1);
    target.reactions!.push({ actor: 'Bob', reaction: heart });
    const input = [target, notice(1), notice(late, heart), notice(late + 1, emoji, 'alice'), notice(late + 2), notice(late + 3, heart, 'Bob'), notice(late + 4)];
    expect([...buildReactionBlocks(input)]).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(match(input).map(e => e.noticeIndex).sort()).toEqual([4, 5]);
  });
  it('never carries an extension across an unknown message clock', () => {
    const late = 31 * 60_000;
    const input = [message(1), message(2), notice(late), { sender_name: 'Alice', timestamp_ms: 0, content: 'unknown clock' }, notice(late + 1)];
    expect([...buildReactionBlocks(input)]).toEqual([0, 0, 0, 1, 2]);
    expect(match(input)).toHaveLength(1);
  });
  it('extends size-limited blocks to complete pairs without admitting later targets', () => {
    const events = Array.from({ length: 7 }, (_, i) => ({ t: i + 1, notice: i === 3 || i >= 5, chars: 1 }));
    const reactions = [{ mi: 0, t: 1, key: 'Alice/heart' }, { mi: 1, t: 2, key: 'Alice/heart' }];
    const notices = [3, 5, 6].map(mi => ({ mi, t: mi + 1, key: 'Alice/heart' }));
    for (const preset of [{ sessionGapMs: 100, maxOrdinary: 2, maxChars: 100 }, { sessionGapMs: 100, maxOrdinary: 100, maxChars: 2 }]) {
      expect([...assignReactionActivityBlocks(events, preset, reactions, notices)]).toEqual([0, 0, 0, 0, 0, 0, 1]);
    }
  });
  it('uses only owner-authored reactions to decide when an extended block is complete', () => {
    const late = 31 * 60_000;
    const input = [message(1), message(2), { ...message(3, heart, 'Owner'), sender_name: 'Alice' }, notice(late), notice(late + 1), notice(late + 2)];
    expect([...buildReactionBlocks(input, 'Owner')]).toEqual([0, 0, 0, 0, 0, 1]);
    expect(match(input).map(e => e.noticeIndex).sort()).toEqual([3, 4]);
  });
  it('does not use protected payloads or unusable notice metadata to complete a block', () => {
    const late = 31 * 60_000;
    const input = [message(1), message(2), { ...notice(late), photos: [{}] }, notice(late + 1, emoji, ''), notice(late + 2), notice(late + 3), notice(late + 4)];
    expect([...buildReactionBlocks(input)]).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(match(input).map(e => e.noticeIndex).sort()).toEqual([4, 5]);
  });
  it('uses the sender field, exact actor/emoji, and strictly earlier owner messages', () => {
    expect(match([message(1), notice(2)])).toHaveLength(1);
    expect(match([message(1), notice(2, emoji, 'alice')])).toHaveLength(0);
    expect(match([message(1), notice(2, heart)])).toHaveLength(0);
    expect(match([message(2), notice(2)])).toHaveLength(0);
    expect(match([{ ...message(1), sender_name: 'Other' }, notice(2)])).toHaveLength(0);
  });
  it('suppresses plausible unknown authors/time but ignores unrelated and too-late competitors', () => {
    expect(match([{ ...message(1), sender_name: '' }, message(2), notice(3)])).toHaveLength(0);
    expect(match([{ ...message(1), timestamp_ms: 0 }, message(2), notice(3)])).toHaveLength(0);
    expect(match([{ ...message(1, heart), sender_name: '' }, message(2), notice(3)])).toHaveLength(1);
    expect(match([message(1), notice(2), { ...message(3), sender_name: '' }])).toHaveLength(1);
  });
  it('reserves recorded reactions without overwriting them and preserves source values', () => {
    const a = message(1); a.reactions![0].timestamp = 2;
    const input = [a, message(2), notice(2000), notice(3000)];
    const original = JSON.stringify(input);
    expect(match(input)).toEqual([{ messageIndex: 1, reactionIndex: 0, noticeIndex: 3, timestamp: 3000, method: 'strict' }]);
    expect(JSON.stringify(input)).toBe(original);
  });
  it('reports associations separately from emitted times and keeps coverage denominators complete', () => {
    const recorded = message(1); recorded.reactions![0].timestamp = 2;
    const input = [recorded, message(2), notice(2000), notice(3000), { ...notice(0) }, { ...notice(4000), content: `${notice(4000).content}: commentary` }];
    const result = matchReactionThread(compactReactionThread(thread(input)), 'Owner', 'near');
    expect(result).toMatchObject({ syntaxCount: 3, usableNotices: 2, hidingCandidates: 4, candidates: 2, associations: { recorded: 1, strict: 1, local: 0, cross: 0 } });
    expect(result.estimates).toHaveLength(1);
  });
  it('reports recorded-clock disagreements without replacing or redirecting the source time', () => {
    const recorded = message(1); recorded.reactions![0].timestamp = 1;
    const result = matchReactionThread(compactReactionThread(thread([recorded, notice(2000)])), 'Owner', 'near');
    expect(result.estimates).toHaveLength(0);
    expect(result.recordedDisagreements).toBe(1);
    expect(recorded.reactions![0].timestamp).toBe(1);
  });
  it('keeps invalid-present and recorded competitors instead of redirecting to missing fields', () => {
    const newer = message(2); newer.reactions![0].timestamp = 0;
    expect(match([message(1), newer, notice(3)])).toHaveLength(0);
  });
  it('freezes local pairs and only aggressive reaches much older leftover targets', () => {
    const input = [message(1), message(2), message(40_000_000), notice(40_000_001), notice(40_000_002)];
    const near = match(input), aggressive = match(input, 'aggressive');
    expect(near).toHaveLength(1);
    expect(aggressive).toHaveLength(2);
    expect(aggressive).toContainEqual(near[0]);
    expect(aggressive.find(e => e.method === 'cross')!.messageIndex).toBe(1);
  });
  it('handles a dense 10,000-by-10,000 group without enumerating edges', () => {
    const input = [...Array.from({ length: 10_000 }, (_, i) => message(i + 1)), ...Array.from({ length: 10_000 }, (_, i) => notice(10_001 + i))];
    const estimates = match(input, 'aggressive');
    expect(estimates).toHaveLength(10_000);
    expect(new Set(estimates.map(e => e.messageIndex)).size).toBe(10_000);
  });
  it('detects the owner from independent distinct dyads', () => {
    const threads = ['A', 'B', 'C'].map(other => compactReactionThread({ ...thread([]), participants: [{ name: 'Owner' }, { name: other }] }));
    expect(inferReactionOwner(threads)).toBe('Owner');
    expect(inferReactionOwner(threads.slice(0, 1))).toBeNull();
  });
});
describe('complete discovery and raw validation', () => {
  it.each([false, true])('pauses directory reads and honors cancellation on resume (abort=%s)', async abort => {
    const root = createMockDirectoryHandle('messages', { inbox: { test: { 'message_1.json': '{}' } } });
    let reads = 0, checks = 0, resume!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const paused = new Promise<void>(resolve => { reached = resolve; });
    const watched = {
      kind: 'directory' as const, name: 'root',
      entries: root.entries.bind(root), getFileHandle: root.getFileHandle.bind(root),
      getDirectoryHandle: async (name: string) => { reads++; return root.getDirectoryHandle(name); },
    };
    const controller = new AbortController();
    const scan = discoverReactionConversations(watched, controller.signal, async () => {
      if (++checks === 3) { reached(); await gate; }
    });
    await paused;
    expect(reads).toBe(0);
    if (abort) controller.abort();
    resume();
    if (abort) { await expect(scan).rejects.toThrow('Aborted'); expect(reads).toBe(0); }
    else { expect(await scan).toHaveLength(1); expect(reads).toBe(1); }
  });

  it('rejects empty-looking invalid schema and malformed reaction arrays', () => {
    for (const messages of [null, {}, 'bad', undefined]) expect(() => validateReactionInput({ messages })).toThrow();
    expect(() => validateReactionInput({ messages: [] })).not.toThrow();
    expect(() => validateReactionInput({ messages: [{ reactions: {} }] })).toThrow();
  });
  it('finds conversations independently of preview success and fails unreadable sections', async () => {
    const root = createMockDirectoryHandle('messages', { inbox: { test: { 'message_1.json': '{broken' } } });
    expect(await discoverReactionConversations(root, new AbortController().signal)).toHaveLength(1);
    const failing = { ...root, kind: 'directory' as const, name: 'root', entries: root.entries.bind(root), getFileHandle: root.getFileHandle.bind(root), getDirectoryHandle: async () => { throw new DOMException('Denied', 'NotAllowedError'); } };
    await expect(discoverReactionConversations(failing, new AbortController().signal)).rejects.toThrow('Denied');
    await expect(discoverReactionConversations(createMockDirectoryHandle('messages', { inbox: '{}' }), new AbortController().signal)).rejects.toThrow('not a folder');
  });
});
