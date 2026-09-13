import { describe, expect, it } from 'vitest';
import { isConversationJsonContent } from '../src/services/messengerExport/messengerExportDetector';
import {
  getMessengerExportLastMessage,
  parseMessengerExportJson,
  tryParseMessengerExportJson,
} from '../src/services/messengerExport/messengerExportParser';

function conversationJson() {
  return JSON.stringify({
    threadName: 'Group Chat',
    participants: ['Alice', 'Bob', 'Cara'],
    messages: [
      {
        senderName: 'Bob',
        text: 'later',
        timestamp: 20,
        media: [{ uri: 'media/photo.jpg' }, { uri: 'media/sticker.webp' }, { uri: 'media/clip.mp4' }],
        sticker: { uri: 'messages/stickers_used/ignored.webp' },
      },
      {
        senderName: 'Alice',
        text: 'earlier',
        timestamp: 10,
        media: [{ uri: 'media/sound.mp3' }, { uri: 'media/doc.pdf' }],
      },
    ],
  });
}

describe('Messenger export parser and detector', () => {
  it('detects conversation JSON content and rejects non-conversations', () => {
    expect(isConversationJsonContent(conversationJson())).toBe(true);
    expect(isConversationJsonContent(JSON.stringify({ settings: true }))).toBe(false);
    expect(isConversationJsonContent('not json')).toBe(false);
  });

  it('tryParseMessengerExportJson returns null for invalid content', () => {
    expect(tryParseMessengerExportJson(JSON.stringify({ settings: true }))).toBeNull();
    expect(tryParseMessengerExportJson('{')).toBeNull();
  });

  it('normalizes Messenger export conversations', () => {
    const thread = parseMessengerExportJson(conversationJson());

    expect(thread.title).toBe('Group Chat');
    expect(thread.thread_path).toBe('Group Chat');
    expect(thread.participants.map(participant => participant.name)).toEqual(['Alice', 'Bob', 'Cara']);
    expect(thread.messages.map(message => message.text)).toEqual(['earlier', 'later']);
    expect(thread.messages[0].audio).toHaveLength(1);
    expect(thread.messages[0].files).toHaveLength(1);
    expect(thread.messages[1].photos).toHaveLength(2);
    expect(thread.messages[1].videos).toHaveLength(1);
    expect(thread.messages[1].sticker).toBeUndefined();
  });

  it('finds the last timestamped Messenger export message', () => {
    const thread = parseMessengerExportJson(JSON.stringify({
      threadName: 'Chat',
      participants: ['Alice'],
      messages: [
        { senderName: 'Alice', text: 'undated', timestamp: 0 },
        { senderName: 'Alice', text: 'dated', timestamp: 5 },
      ],
    }));

    expect(getMessengerExportLastMessage(thread)?.text).toBe('dated');
  });

  it('repairs encoded Messenger export display fields', () => {
    const thread = parseMessengerExportJson(JSON.stringify({
      threadName: 'Caf\u00c3\u00a9',
      participants: ['Andr\u00c3\u00a9'],
      messages: [{
        senderName: 'Zo\u00c3\u00ab',
        text: 'Ol\u00c3\u00a1',
        timestamp: 1,
        share: { share_text: 'R\u00c3\u00a9sum\u00c3\u00a9' },
        reactions: [{ actor: 'Andr\u00c3\u00a9', reaction: '\u00f0\u009f\u0091\u008d' }],
        media: [{ uri: 'media/caf\u00c3\u00a9.jpg' }],
      }],
    }));

    expect(thread.title).toBe('Caf\u00e9');
    expect(thread.participants[0].name).toBe('Andr\u00e9');
    expect(thread.messages[0]).toMatchObject({
      senderName: 'Zo\u00eb',
      text: 'Ol\u00e1',
      share: { share_text: 'R\u00e9sum\u00e9' },
      reactions: [{ actor: 'Andr\u00e9', reaction: '\ud83d\udc4d' }],
      media: [{ uri: 'media/caf\u00e9.jpg' }],
    });
  });
});
