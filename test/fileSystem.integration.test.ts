import { describe, expect, it } from 'vitest';
import {
  computeFolderSize,
  deleteChat,
  listChatFolders,
  resolveFacebookMessagesRoot,
} from '../src/services/fileSystem';
import { createMediaState, findMediaFile, processMediaFromDirectory } from '../src/services/media';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';

describe('Facebook archive filesystem services', () => {
  it('resolves every documented Facebook messages root layout', async () => {
    const selectedMessages = createMockDirectoryHandle('messages', { inbox: {} });
    const exportRoot = createMockDirectoryHandle('facebook-export', { messages: { inbox: {} } });
    const accountsCenterRoot = createMockDirectoryHandle('facebook-export', {
      your_facebook_activity: { messages: { inbox: {} } },
    });

    await expect(resolveFacebookMessagesRoot(selectedMessages)).resolves.toBe(selectedMessages);

    const nestedMessages = await exportRoot.getDirectoryHandle('messages');
    await expect(resolveFacebookMessagesRoot(exportRoot)).resolves.toBe(nestedMessages);

    const activity = await accountsCenterRoot.getDirectoryHandle('your_facebook_activity');
    const accountsCenterMessages = await activity.getDirectoryHandle('messages');
    await expect(resolveFacebookMessagesRoot(accountsCenterRoot)).resolves.toBe(accountsCenterMessages);
  });

  it('accepts an archived-only Facebook messages root', async () => {
    const root = createMockDirectoryHandle('messages', { archived_threads: {} });

    await expect(resolveFacebookMessagesRoot(root)).resolves.toBe(root);
  });

  it('rejects undocumented and invalid archive layouts', async () => {
    const instagramRoot = createMockDirectoryHandle('instagram-export', {
      your_instagram_activity: { messages: { inbox: {} } },
    });
    const invalidRoot = createMockDirectoryHandle('invalid', { messages: {} });

    await expect(resolveFacebookMessagesRoot(instagramRoot)).resolves.toBeNull();
    await expect(resolveFacebookMessagesRoot(invalidRoot)).resolves.toBeNull();
  });

  it('lists chat folders from a Facebook inbox', async () => {
    const root = createMockDirectoryHandle('messages', {
      inbox: {
        alice_chat: {
          'message_1.json': JSON.stringify({
            title: 'Alice Chat',
            thread_path: 'inbox/alice_chat',
            participants: [{ name: 'Alice' }, { name: 'Bob' }],
            messages: [
              { sender_name: 'Bob Smith', timestamp_ms: 20, content: 'Newest' },
              { sender_name: 'Alice', timestamp_ms: 10, content: 'Oldest' },
            ],
          }),
          'message_2.json': JSON.stringify({ messages: [] }),
        },
      },
    });

    const entries = await listChatFolders(root, 'inbox', 'inbox');

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      folderName: 'alice_chat',
      title: 'Alice Chat',
      participants: ['Alice', 'Bob'],
      lastMessage: 'Newest',
      lastTimestamp: 20,
      messageCount: 2,
      jsonFileCount: 2,
      source: 'inbox',
    });
  });

  it('returns an empty list for missing sections', async () => {
    const root = createMockDirectoryHandle('messages', {});
    await expect(listChatFolders(root, 'inbox', 'inbox')).resolves.toEqual([]);
  });

  it('indexes Facebook media directories', async () => {
    const chat = createMockDirectoryHandle('chat', {
      photos: { 'photo.jpg': new Uint8Array([1]) },
      videos: { 'clip.mp4': new Uint8Array([1]) },
    });
    const state = createMediaState();

    await processMediaFromDirectory(chat, state);

    expect(findMediaFile(state, 'photos/photo.jpg')?.type).toBe('image');
    expect(findMediaFile(state, 'clip.mp4')?.type).toBe('video');
  });

  it('computes folder size recursively and deletes chat folders', async () => {
    const root = createMockDirectoryHandle('messages', {
      inbox: {
        alice_chat: {
          'message_1.json': '12345',
          photos: { 'photo.jpg': new Uint8Array([1, 2, 3]) },
        },
      },
    });
    const inbox = await root.getDirectoryHandle('inbox');
    const chat = await inbox.getDirectoryHandle('alice_chat');

    await expect(computeFolderSize(chat)).resolves.toBe(8);
    await deleteChat(root, 'inbox', 'alice_chat');
    await expect(inbox.getDirectoryHandle('alice_chat')).rejects.toMatchObject({ name: 'NotFoundError' });
  });
});
