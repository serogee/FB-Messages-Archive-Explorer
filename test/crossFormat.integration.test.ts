import { describe, expect, it } from 'vitest';
import { deleteChat, listChatFolders } from '../src/services/fileSystem';
import {
  buildMessengerExportReferenceIndex,
  deleteMessengerExportChat,
} from '../src/services/messengerExport/messengerExportDeletion';
import { isMessengerExport } from '../src/services/messengerExport/messengerExportDetector';
import { listMessengerExportChats } from '../src/services/messengerExport/messengerExportLoader';
import type { ChatListEntry } from '../src/types/messenger';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';

function facebookRoot() {
  return createMockDirectoryHandle('messages', {
    inbox: {
      alice_chat: {
        'message_1.json': JSON.stringify({
          title: 'Alice',
          thread_path: 'inbox/alice_chat',
          participants: [{ name: 'Alice' }, { name: 'Bob' }],
          messages: [
            { sender_name: 'Bob', timestamp_ms: 20, content: 'latest' },
            { sender_name: 'Alice', timestamp_ms: 10, content: 'first' },
          ],
        }),
        photos: {
          'photo.jpg': new Uint8Array([1, 2, 3]),
        },
      },
    },
  });
}

function messengerRoot() {
  return createMockDirectoryHandle('messenger', {
    'alice.json': JSON.stringify({
      threadName: 'Alice',
      participants: ['Alice', 'Bob'],
      messages: [
        {
          senderName: 'Alice',
          text: 'hello',
          timestamp: 10,
          media: [{ uri: 'media/alice.jpg' }, { uri: 'media/shared.jpg' }],
        },
      ],
    }),
    'group.json': JSON.stringify({
      threadName: 'Group',
      participants: ['Alice', 'Bob', 'Cara'],
      messages: [
        {
          senderName: 'Cara',
          text: 'hi all',
          timestamp: 20,
          media: [{ uri: 'media/shared.jpg' }],
        },
      ],
    }),
    media: {
      'alice.jpg': new Uint8Array([1]),
      'shared.jpg': new Uint8Array([1, 2]),
    },
  });
}

function messengerEntry(root: FileSystemDirectoryHandle, jsonFileName: string): ChatListEntry {
  return {
    folderName: jsonFileName.replace(/\.json$/i, ''),
    title: jsonFileName,
    participants: [],
    messageCount: 1,
    folderSize: 0,
    dirHandle: root,
    jsonFileCount: 1,
    source: 'inbox',
    _messengerExport: true,
    _jsonFileName: jsonFileName,
  };
}

describe('cross-format archive regressions', () => {
  it('keeps Facebook and Messenger roots on separate detection paths', async () => {
    await expect(isMessengerExport(facebookRoot())).resolves.toBe(false);
    await expect(isMessengerExport(messengerRoot())).resolves.toBe(true);
  });

  it('marks only Messenger export chat entries with Messenger metadata', async () => {
    const facebookEntries = await listChatFolders(facebookRoot(), 'inbox', 'inbox');
    const messengerEntries = await listMessengerExportChats(messengerRoot());

    expect(facebookEntries).toHaveLength(1);
    expect(facebookEntries[0]._messengerExport).toBeUndefined();
    expect(facebookEntries[0]._jsonFileName).toBeUndefined();

    expect(messengerEntries).toHaveLength(2);
    expect(messengerEntries.every(entry => entry._messengerExport)).toBe(true);
    expect(messengerEntries.map(entry => entry._jsonFileName).sort()).toEqual(['alice.json', 'group.json']);
  });

  it('uses folder deletion semantics for Facebook archives', async () => {
    const root = facebookRoot();
    const inbox = await root.getDirectoryHandle('inbox');

    await deleteChat(root, 'inbox', 'alice_chat');

    await expect(inbox.getDirectoryHandle('alice_chat')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('uses JSON plus exclusive-media deletion semantics for Messenger exports', async () => {
    const root = messengerRoot();
    const referenceIndex = await buildMessengerExportReferenceIndex(root);

    await deleteMessengerExportChat(root, messengerEntry(root, 'alice.json'), referenceIndex);

    const media = await root.getDirectoryHandle('media');
    await expect(root.getFileHandle('alice.json')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(media.getFileHandle('alice.jpg')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(media.getFileHandle('shared.jpg')).resolves.toMatchObject({ kind: 'file' });
    await expect(root.getFileHandle('group.json')).resolves.toMatchObject({ kind: 'file' });
  });
});
