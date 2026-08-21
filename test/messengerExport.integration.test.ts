import { describe, expect, it } from 'vitest';
import { createMediaState, findMediaFile } from '../src/services/media';
import {
  buildMessengerExportReferenceIndex,
  deleteMessengerExportChat,
  getMessengerExportBatchDeletionInfo,
  getMessengerExportDeletionInfo,
} from '../src/services/messengerExport/messengerExportDeletion';
import { isMessengerExport } from '../src/services/messengerExport/messengerExportDetector';
import { listMessengerExportChats } from '../src/services/messengerExport/messengerExportLoader';
import { processMessengerExportMedia } from '../src/services/messengerExport/messengerExportMedia';
import { buildMessengerExportMediaSizeIndex } from '../src/services/messengerExport/messengerExportSize';
import type { ChatListEntry } from '../src/types/messenger';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';

function messengerRoot() {
  return createMockDirectoryHandle('messenger', {
    'chat_alice.json': JSON.stringify({
      threadName: 'Alice',
      participants: ['Alice', 'Bob'],
      messages: [
        {
          senderName: 'Alice',
          text: 'hello',
          timestamp: 10,
          media: [{ uri: 'media/photo1.jpg' }, { uri: 'media/shared.jpg' }],
        },
      ],
    }),
    'chat_group.json': JSON.stringify({
      threadName: 'Group',
      participants: ['Alice', 'Bob', 'Cara'],
      messages: [
        {
          senderName: 'Cara',
          text: 'group hello',
          timestamp: 20,
          media: [{ uri: 'media/shared.jpg' }, { uri: 'media/video1.mp4' }],
        },
      ],
    }),
    'settings.json': JSON.stringify({ settings: true }),
    media: {
      'photo1.jpg': new Uint8Array([1, 2, 3]),
      'shared.jpg': new Uint8Array([1, 2, 3, 4]),
      'video1.mp4': new Uint8Array([1, 2, 3, 4, 5]),
    },
  });
}

function entry(jsonFileName: string): ChatListEntry {
  return {
    folderName: jsonFileName.replace(/\.json$/i, ''),
    title: jsonFileName,
    participants: [],
    messageCount: 1,
    folderSize: 0,
    dirHandle: messengerRoot(),
    jsonFileCount: 1,
    source: 'inbox',
    _messengerExport: true,
    _jsonFileName: jsonFileName,
  };
}

describe('Messenger export filesystem services', () => {
  it('detects Messenger exports and rejects Facebook roots', async () => {
    await expect(isMessengerExport(messengerRoot())).resolves.toBe(true);
    await expect(isMessengerExport(createMockDirectoryHandle('messages', { inbox: {} }))).resolves.toBe(false);
  });

  it('lists Messenger export chats and skips non-conversation JSON', async () => {
    const entries = await listMessengerExportChats(messengerRoot());

    expect(entries.map(item => item.title)).toEqual(['Group', 'Alice']);
    expect(entries.every(item => item._messengerExport)).toBe(true);
    expect(entries.map(item => item._jsonFileName)).toEqual(['chat_group.json', 'chat_alice.json']);
  });

  it('indexes Messenger export media', async () => {
    const state = createMediaState();

    await processMessengerExportMedia(messengerRoot(), state);

    expect(findMediaFile(state, 'media/photo1.jpg')?.type).toBe('image');
    expect(findMediaFile(state, './media/video1.mp4')?.type).toBe('video');
    expect(findMediaFile(state, 'shared.jpg')?.type).toBe('image');
  });

  it('computes deletion info with exclusive and shared media', async () => {
    const root = messengerRoot();
    const referenceIndex = await buildMessengerExportReferenceIndex(root);
    const sizeIndex = await buildMessengerExportMediaSizeIndex(root);

    const info = await getMessengerExportDeletionInfo(
      root,
      entry('chat_alice.json'),
      referenceIndex,
      undefined,
      sizeIndex
    );

    expect(info.exclusiveMediaFiles).toEqual(['photo1.jpg']);
    expect(info.exclusiveMediaCount).toBe(1);
    expect(info.sharedMediaCount).toBe(1);
    expect(info.mediaSize).toBe(3);
  });

  it('treats shared media as exclusive when all owners are in a batch', async () => {
    const root = messengerRoot();
    const referenceIndex = await buildMessengerExportReferenceIndex(root);
    const sizeIndex = await buildMessengerExportMediaSizeIndex(root);

    const info = await getMessengerExportBatchDeletionInfo(
      root,
      [entry('chat_alice.json'), entry('chat_group.json')],
      referenceIndex,
      undefined,
      sizeIndex
    );

    expect(info.sharedMediaCount).toBe(0);
    expect(info.exclusiveMediaFiles.sort()).toEqual(['photo1.jpg', 'shared.jpg', 'video1.mp4']);
    expect(info.mediaSize).toBe(12);
  });

  it('deletes only exclusive Messenger export media and preserves shared media', async () => {
    const root = messengerRoot();
    const referenceIndex = await buildMessengerExportReferenceIndex(root);
    const alice = entry('chat_alice.json');

    await deleteMessengerExportChat(root, alice, referenceIndex);

    const media = await root.getDirectoryHandle('media');
    await expect(root.getFileHandle('chat_alice.json')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(media.getFileHandle('photo1.jpg')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(media.getFileHandle('shared.jpg')).resolves.toMatchObject({ kind: 'file' });
    expect(referenceIndex.chatMedia.has('chat_alice.json')).toBe(false);
    expect(referenceIndex.mediaOwners.get('shared.jpg')).toEqual(new Set(['chat_group.json']));
  });
});
