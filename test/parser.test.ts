import { describe, expect, it } from 'vitest';
import {
  fixEncoding,
  getOrderedMessageFileNames,
  mergeMessengerData,
  normalizeMessengerData,
  parseMessengerJsonContent,
  sanitizeFileName,
} from '../src/services/parser';
import type { MessengerThread } from '../src/types/messenger';

describe('parser service', () => {
  it('fixes mojibake and leaves clean text alone', () => {
    expect(fixEncoding('caf\u00c3\u00a9')).toBe('caf\u00e9');
    expect(fixEncoding('plain text')).toBe('plain text');
  });

  it('reverses Facebook archive message order when thread_path exists', () => {
    const parsed = parseMessengerJsonContent(JSON.stringify({
      title: 'Alice',
      thread_path: 'inbox/alice',
      participants: [{ name: 'Alice' }],
      messages: [
        { sender_name: 'Alice', timestamp_ms: 2, content: 'newest' },
        { sender_name: 'Bob', timestamp_ms: 1, content: 'oldest' },
      ],
    }));

    expect(parsed.messages.map(message => message.content)).toEqual(['oldest', 'newest']);
  });

  it('sorts message files in numeric load order', () => {
    expect(getOrderedMessageFileNames([
      'message_2.json',
      'notes.txt',
      'message_10.json',
      'message_1.json',
    ])).toEqual(['message_10.json', 'message_2.json', 'message_1.json']);
  });

  it('normalizes messages chronologically with undated messages last', () => {
    const thread = normalizeMessengerData({
      title: 'Thread',
      thread_path: 'thread',
      participants: [],
      is_still_participant: true,
      messages: [
        { sender_name: 'A', timestamp_ms: 30, content: 'third' },
        { sender_name: 'A', timestamp_ms: 0, content: 'undated' },
        { sender_name: 'A', timestamp_ms: 10, content: 'first' },
      ],
    });

    expect(thread.messages.map(message => message.content)).toEqual(['first', 'third', 'undated']);
  });

  it('merges messages and deduplicates participants', () => {
    const dataFiles: MessengerThread[] = [
      {
        title: 'Chat',
        thread_path: 'chat',
        is_still_participant: true,
        participants: [{ name: 'Alice' }, { name: 'Bob' }],
        messages: [{ sender_name: 'Alice', timestamp_ms: 1, content: 'one' }],
      },
      {
        title: 'Chat',
        thread_path: 'chat',
        is_still_participant: true,
        participants: [{ name: 'Bob' }, { name: 'Cara' }],
        messages: [{ sender_name: 'Cara', timestamp_ms: 2, content: 'two' }],
      },
    ];

    const merged = mergeMessengerData(dataFiles);
    expect(merged.messages.map(message => message.content)).toEqual(['one', 'two']);
    expect(merged.participants.map(participant => participant.name)).toEqual(['Alice', 'Bob', 'Cara']);
  });

  it('sanitizes unsafe file names', () => {
    expect(sanitizeFileName(' Alice/Bob:*?  Chat ')).toBe('Alice-Bob- Chat');
    expect(sanitizeFileName('')).toBe('conversation');
    expect(sanitizeFileName('a'.repeat(200))).toHaveLength(140);
  });

  it('rejects truncated Facebook JSON instead of returning partial conversation data', () => {
    expect(() => parseMessengerJsonContent('{"title":"Partial"')).toThrow(SyntaxError);
  });

  it('repairs display encoding across people, shares, reactions, and attachment names', () => {
    const parsed = parseMessengerJsonContent(JSON.stringify({
      title: 'Caf\u00c3\u00a9 chat',
      thread_path: 'inbox/caf\u00c3\u00a9',
      participants: [{ name: 'Andr\u00c3\u00a9' }],
      messages: [{
        sender_name: 'Zo\u00c3\u00ab',
        timestamp_ms: 1,
        content: 'Ol\u00c3\u00a1',
        share: { link: 'https://example.com', share_text: 'R\u00c3\u00a9sum\u00c3\u00a9' },
        reactions: [{ actor: 'Andr\u00c3\u00a9', reaction: '\u00f0\u009f\u0091\u008d' }],
        files: [{ uri: 'files/caf\u00c3\u00a9.txt' }],
      }],
    }));

    expect(parsed).toMatchObject({
      title: 'Caf\u00e9 chat',
      thread_path: 'inbox/caf\u00e9',
      participants: [{ name: 'Andr\u00e9' }],
    });
    expect(parsed.messages[0]).toMatchObject({
      sender_name: 'Zo\u00eb',
      content: 'Ol\u00e1',
      share: { share_text: 'R\u00e9sum\u00e9' },
      reactions: [{ actor: 'Andr\u00e9', reaction: '\ud83d\udc4d' }],
      files: [{ uri: 'files/caf\u00e9.txt' }],
    });
  });
});
