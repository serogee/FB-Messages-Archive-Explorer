import type { MessengerMessage } from '../../src/types/messenger';
import { createMockDirectoryHandle } from '../helpers/mockFileSystem';

export function generateMessages(count: number): MessengerMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    sender_name: index % 2 === 0 ? 'Alice' : 'Bob',
    senderName: index % 2 === 0 ? 'Alice' : 'Bob',
    timestamp_ms: index + 1,
    timestamp: index + 1,
    content: `Message ${index} about archive search and media item ${index % 100}`,
    text: `Message ${index} about archive search and media item ${index % 100}`,
    media: index % 10 === 0 ? [{ uri: `media/photo-${index % 500}.jpg` }] : [],
  }));
}

export function generateFacebookThreadJson(messageCount: number): string {
  return JSON.stringify({
    title: 'Large Facebook Chat',
    thread_path: 'inbox/large_chat',
    participants: [{ name: 'Alice' }, { name: 'Bob' }],
    messages: generateMessages(messageCount).reverse(),
  });
}

export function generateMessengerExportJson(messageCount: number): string {
  return JSON.stringify({
    threadName: 'Large Messenger Chat',
    participants: ['Alice', 'Bob'],
    messages: generateMessages(messageCount),
  });
}

export function generateFacebookMessagesRoot(chatCount: number): FileSystemDirectoryHandle {
  const inbox: Record<string, Record<string, string>> = {};

  for (let index = 0; index < chatCount; index++) {
    inbox[`chat_${index}`] = {
      'message_1.json': JSON.stringify({
        title: `Chat ${index}`,
        thread_path: `inbox/chat_${index}`,
        participants: [{ name: 'Alice' }, { name: `Person ${index}` }],
        messages: [
          {
            sender_name: `Person ${index}`,
            senderName: `Person ${index}`,
            timestamp_ms: index + 1,
            timestamp: index + 1,
            content: `Latest message for chat ${index}`,
            text: `Latest message for chat ${index}`,
          },
        ],
      }),
    };
  }

  return createMockDirectoryHandle('messages', { inbox });
}

export function generateMessengerReferenceRoot(chatCount: number): FileSystemDirectoryHandle {
  const tree: Record<string, string | Uint8Array | Record<string, Uint8Array>> = {
    media: {},
  };
  const media = tree.media as Record<string, Uint8Array>;

  for (let index = 0; index < chatCount; index++) {
    const exclusive = `exclusive_${index}.jpg`;
    const shared = `shared_${index % 25}.jpg`;
    media[exclusive] = new Uint8Array(256);
    media[shared] = new Uint8Array(512);
    tree[`chat_${index}.json`] = JSON.stringify({
      threadName: `Chat ${index}`,
      participants: ['Alice', `Person ${index}`],
      messages: [
        {
          senderName: 'Alice',
          text: `Message ${index}`,
          timestamp: index + 1,
          media: [
            { uri: `media/${exclusive}` },
            { uri: `media/${shared}` },
          ],
        },
      ],
    });
  }

  return createMockDirectoryHandle('messenger', tree);
}
