import { describe, expect, it, vi } from 'vitest';
import { createMediaState, findMediaFile } from '../src/services/media';
import {
  buildMessengerExportReferenceIndex,
  deleteMessengerExportChat,
  getMessengerExportBatchDeletionInfo,
  getMessengerExportDeletionInfo,
  MessengerExportIndexIncompleteError,
} from '../src/services/messengerExport/messengerExportDeletion';
import { isMessengerExport } from '../src/services/messengerExport/messengerExportDetector';
import {
  listMessengerExportChats,
  listMessengerExportChatsIndexed,
} from '../src/services/messengerExport/messengerExportLoader';
import { processMessengerExportMedia } from '../src/services/messengerExport/messengerExportMedia';
import { buildReferenceIndexFromChatMedia } from '../src/services/messengerExport/messengerExportIndex';
import {
  buildMessengerExportMediaSizeIndex,
  computeMessengerExportChatSizeFromIndex,
} from '../src/services/messengerExport/messengerExportSize';
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

  it('builds ownership, paths, and JSON sizes during the listing pass', async () => {
    const root = messengerRoot();
    const { entries, chatIndex } = await listMessengerExportChatsIndexed(root);

    expect(chatIndex.complete).toBe(true);
    expect(chatIndex.warnings).toEqual([]);
    expect(chatIndex.referenceIndex.mediaOwners.get('media/shared.jpg')).toEqual(
      new Set(['chat_alice.json', 'chat_group.json'])
    );
    expect(chatIndex.referenceIndex.chatMedia.get('chat_alice.json')).toEqual(
      new Set(['media/photo1.jpg', 'media/shared.jpg'])
    );
    expect(chatIndex.chatMediaPaths.get('chat_group.json')).toEqual(
      new Set(['media/shared.jpg', 'media/video1.mp4'])
    );
    const rebuiltReferenceIndex = buildReferenceIndexFromChatMedia(chatIndex.chatMediaPaths);
    expect(rebuiltReferenceIndex.mediaOwners).toEqual(chatIndex.referenceIndex.mediaOwners);
    expect(rebuiltReferenceIndex.chatMedia).toEqual(chatIndex.referenceIndex.chatMedia);
    expect(chatIndex.jsonSizes.get('chat_alice.json')).toBe(entries.find(
      item => item._jsonFileName === 'chat_alice.json'
    )?.folderSize);
  });

  it('computes indexed sizes and deletion details without reopening conversation JSON', async () => {
    const root = messengerRoot();
    const { entries, chatIndex } = await listMessengerExportChatsIndexed(root);
    const mediaSizeIndex = await buildMessengerExportMediaSizeIndex(root);
    const getFileHandle = vi.spyOn(root, 'getFileHandle');
    const alice = entries.find(item => item._jsonFileName === 'chat_alice.json')!;

    const size = computeMessengerExportChatSizeFromIndex(
      'chat_alice.json',
      chatIndex,
      mediaSizeIndex
    );
    const info = await getMessengerExportDeletionInfo(
      root,
      alice,
      chatIndex,
      undefined,
      mediaSizeIndex
    );

    expect(size).toBe(chatIndex.jsonSizes.get('chat_alice.json')! + 7);
    expect(info.jsonSize).toBe(chatIndex.jsonSizes.get('chat_alice.json'));
    expect(getFileHandle).not.toHaveBeenCalled();
  });

  it('fails closed when a possible conversation cannot be indexed', async () => {
    const root = createMockDirectoryHandle('messenger', {
      'chat.json': JSON.stringify({
        threadName: 'Chat',
        participants: ['Alice'],
        messages: [{ senderName: 'Alice', timestamp: 1 }],
      }),
      'broken.json': '{not-json',
      media: {},
    });
    const { entries, chatIndex } = await listMessengerExportChatsIndexed(root);

    expect(chatIndex.complete).toBe(false);
    expect(chatIndex.warnings).toEqual([
      { jsonFileName: 'broken.json', reason: 'malformed-conversation' },
    ]);
    await expect(getMessengerExportDeletionInfo(
      root,
      entries[0],
      chatIndex,
      undefined,
      new Map()
    )).rejects.toBeInstanceOf(MessengerExportIndexIncompleteError);
  });

  it('keeps nested files with duplicate basenames as separate media identities', async () => {
    const root = createMockDirectoryHandle('messenger', {
      'one.json': JSON.stringify({
        threadName: 'One',
        participants: ['Alice'],
        messages: [{ senderName: 'Alice', timestamp: 1, media: [{ uri: 'media/one/photo.jpg' }] }],
      }),
      'two.json': JSON.stringify({
        threadName: 'Two',
        participants: ['Bob'],
        messages: [{ senderName: 'Bob', timestamp: 2, media: [{ uri: 'media/two/photo.jpg' }] }],
      }),
      media: {
        one: { 'photo.jpg': new Uint8Array([1]) },
        two: { 'photo.jpg': new Uint8Array([1, 2]) },
      },
    });
    const { entries, chatIndex } = await listMessengerExportChatsIndexed(root);
    const mediaSizeIndex = await buildMessengerExportMediaSizeIndex(root);
    const info = await getMessengerExportBatchDeletionInfo(
      root,
      entries,
      chatIndex,
      undefined,
      mediaSizeIndex
    );

    expect(chatIndex.referenceIndex.mediaOwners.has('media/one/photo.jpg')).toBe(true);
    expect(chatIndex.referenceIndex.mediaOwners.has('media/two/photo.jpg')).toBe(true);
    expect(info.exclusiveMediaFiles.sort()).toEqual(['one/photo.jpg', 'two/photo.jpg']);
    expect(info.mediaSize).toBe(3);

    const one = entries.find(item => item._jsonFileName === 'one.json')!;
    await deleteMessengerExportChat(root, one, chatIndex);
    const media = await root.getDirectoryHandle('media');
    const oneDirectory = await media.getDirectoryHandle('one');
    const twoDirectory = await media.getDirectoryHandle('two');
    await expect(oneDirectory.getFileHandle('photo.jpg')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(twoDirectory.getFileHandle('photo.jpg')).resolves.toMatchObject({ kind: 'file' });
    expect(chatIndex.jsonSizes.has('one.json')).toBe(false);
    expect(chatIndex.chatMediaPaths.has('one.json')).toBe(false);
    expect(chatIndex.referenceIndex.chatMedia.has('one.json')).toBe(false);
  });

  it('fails closed when case-normalized media identities are ambiguous', async () => {
    const root = createMockDirectoryHandle('messenger', {
      'upper.json': JSON.stringify({
        threadName: 'Upper',
        participants: ['Alice'],
        messages: [{ senderName: 'Alice', timestamp: 1, media: [{ uri: 'media/Photo.jpg' }] }],
      }),
      'lower.json': JSON.stringify({
        threadName: 'Lower',
        participants: ['Bob'],
        messages: [{ senderName: 'Bob', timestamp: 2, media: [{ uri: 'media/photo.jpg' }] }],
      }),
      media: {
        'Photo.jpg': new Uint8Array([1]),
        'photo.jpg': new Uint8Array([2]),
      },
    });

    const { chatIndex } = await listMessengerExportChatsIndexed(root);
    const mediaSizeIndex = await buildMessengerExportMediaSizeIndex(root);

    expect(chatIndex.complete).toBe(false);
    expect(chatIndex.warnings).toContainEqual({
      jsonFileName: 'lower.json',
      reason: 'ambiguous-media-path',
    });
    expect(mediaSizeIndex.has('photo.jpg')).toBe(false);
  });

  it('indexes Messenger export media', async () => {
    const state = createMediaState();
    const progress = vi.fn();

    await processMessengerExportMedia(messengerRoot(), state, progress);

    expect(findMediaFile(state, 'media/photo1.jpg')?.type).toBe('image');
    expect(findMediaFile(state, './media/video1.mp4')?.type).toBe('video');
    expect(findMediaFile(state, 'shared.jpg')?.type).toBe('image');
    expect(state.mediaFileCount).toBe(3);
    expect(state.pathIndex.size).toBeGreaterThan(state.mediaFileCount);
    expect(progress.mock.calls).toEqual([[0, 3], [3, 3]]);
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

  it('accepts a Messenger export without a media directory', async () => {
    const root = createMockDirectoryHandle('messenger', {
      'chat.json': JSON.stringify({
        threadName: 'Text only',
        participants: ['Alice'],
        messages: [{ senderName: 'Alice', text: 'hello', timestamp: 10 }],
      }),
    });

    await expect(buildMessengerExportMediaSizeIndex(root)).resolves.toEqual(new Map());
  });

  it('reports failures while opening the media directory for sizing', async () => {
    const root = messengerRoot();
    vi.spyOn(root, 'getDirectoryHandle').mockRejectedValueOnce(
      new DOMException('Media access denied', 'NotAllowedError')
    );

    await expect(buildMessengerExportMediaSizeIndex(root)).rejects.toMatchObject({
      name: 'NotAllowedError',
    });
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
    expect(referenceIndex.mediaOwners.get('media/shared.jpg')).toEqual(new Set(['chat_group.json']));
  });

  it('continues deletion when exclusive media is already missing', async () => {
    const root = createMockDirectoryHandle('messenger', {
      'chat.json': JSON.stringify({
        threadName: 'Alice',
        participants: ['Alice'],
        messages: [{
          senderName: 'Alice',
          timestamp: 10,
          media: [{ uri: 'media/missing.jpg' }],
        }],
      }),
      media: {},
    });
    const referenceIndex = await buildMessengerExportReferenceIndex(root);

    await expect(deleteMessengerExportChat(root, entry('chat.json'), referenceIndex)).resolves.toBeUndefined();
    await expect(root.getFileHandle('chat.json')).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(referenceIndex.chatMedia.has('chat.json')).toBe(false);
  });

  it('reports media deletion failures instead of completing successfully', async () => {
    const root = messengerRoot();
    const referenceIndex = await buildMessengerExportReferenceIndex(root);
    const media = await root.getDirectoryHandle('media');
    vi.spyOn(media, 'removeEntry').mockRejectedValueOnce(
      new DOMException('Media deletion denied', 'NotAllowedError')
    );

    await expect(
      deleteMessengerExportChat(root, entry('chat_alice.json'), referenceIndex)
    ).rejects.toMatchObject({ name: 'NotAllowedError' });
    await expect(root.getFileHandle('chat_alice.json')).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(referenceIndex.chatMedia.has('chat_alice.json')).toBe(true);
  });
});
