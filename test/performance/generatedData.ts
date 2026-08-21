import type { MessengerMessage } from '../../src/types/messenger';

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
