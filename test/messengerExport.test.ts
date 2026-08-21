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
        media: [{ uri: 'media/photo.jpg' }, { uri: 'media/clip.mp4' }],
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
    expect(thread.messages[1].photos).toHaveLength(1);
    expect(thread.messages[1].videos).toHaveLength(1);
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
});
