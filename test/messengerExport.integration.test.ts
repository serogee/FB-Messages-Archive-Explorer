import { describe, expect, it, vi } from 'vitest';
import { createMediaState, findMediaFile } from '../src/services/media';
import {
  buildMessengerExportReferenceIndex,
  buildMessengerExportDeletionPlan,
  deleteMessengerExportChat,
  deleteMessengerExportJsonOnly,
  executeMessengerExportDeletionPlan,
  getMessengerExportBatchDeletionInfo,
  getMessengerExportDeletionInfo,
  getMessengerExportDeletionOwnershipInfo,
  MessengerExportIndexIncompleteError,
  MessengerExportDeletionPartialError,
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
  computeMessengerExportChatSize,
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

  it('detects a conversation after metadata and unreadable root JSON files', async () => {
    const root = createMockDirectoryHandle('messenger', {
      '01-settings.json': JSON.stringify({ settings: true }),
      '02-profile.json': JSON.stringify({ profile: true }),
      '03-broken.json': '{',
      '04-unreadable.json': JSON.stringify({ metadata: true }),
      '05-conversation.json': JSON.stringify({
        threadName: 'Late conversation',
        participants: ['Alice', 'Bob'],
        messages: [],
      }),
    });
    const unreadable = await root.getFileHandle('04-unreadable.json');
    vi.spyOn(unreadable, 'getFile').mockRejectedValue(new DOMException('denied', 'NotAllowedError'));

    await expect(isMessengerExport(root)).resolves.toBe(true);
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
    expect(chatIndex.chatMediaPaths.get('chat_alice.json')).toBe(
      chatIndex.referenceIndex.chatMedia.get('chat_alice.json')
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

  it('reads and parses each root JSON exactly once during indexed listing', async () => {
    const root = messengerRoot();
    const getFileSpies: Array<ReturnType<typeof vi.fn>> = [];
    const textSpies: Array<ReturnType<typeof vi.fn>> = [];
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== 'file' || !name.endsWith('.json')) continue;
      const file = await handle.getFile();
      const text = file.text.bind(file);
      const textSpy = vi.fn(text);
      const getFileSpy = vi.fn(async () => {
        Object.defineProperty(file, 'text', { configurable: true, value: textSpy });
        return file;
      });
      handle.getFile = getFileSpy;
      getFileSpies.push(getFileSpy);
      textSpies.push(textSpy);
    }

    await listMessengerExportChatsIndexed(root);

    expect(getFileSpies.every(spy => spy.mock.calls.length === 1)).toBe(true);
    expect(textSpies.every(spy => spy.mock.calls.length === 1)).toBe(true);
  });

  it('computes indexed sizes and deletion details without reopening conversation JSON', async () => {
    const root = messengerRoot();
    const { entries, chatIndex } = await listMessengerExportChatsIndexed(root);
    const mediaSizeIndex = await buildMessengerExportMediaSizeIndex(root);
    const alice = entries.find(item => item._jsonFileName === 'chat_alice.json')!;

    const size = computeMessengerExportChatSizeFromIndex(
      'chat_alice.json',
      chatIndex,
      mediaSizeIndex
    );
    const fallbackSize = await computeMessengerExportChatSize(
      root,
      'chat_alice.json',
      mediaSizeIndex
    );
    const getFileHandle = vi.spyOn(root, 'getFileHandle');
    const info = await getMessengerExportDeletionInfo(
      root,
      alice,
      chatIndex,
      undefined,
      mediaSizeIndex
    );

    expect(size).toBe(chatIndex.jsonSizes.get('chat_alice.json')! + 7);
    expect(size).toBe(fallbackSize);
    expect(info.jsonSize).toBe(chatIndex.jsonSizes.get('chat_alice.json'));
    expect(getFileHandle).not.toHaveBeenCalled();
  });

  it('does not return or cache a partial Messenger size after abort', async () => {
    const root = messengerRoot();
    const media = await root.getDirectoryHandle('media');
    const photo = await media.getFileHandle('photo1.jpg');
    const readPhoto = photo.getFile.bind(photo);
    const abortController = new AbortController();
    vi.spyOn(photo, 'getFile').mockImplementation(async () => {
      abortController.abort();
      return readPhoto();
    });

    await expect(buildMessengerExportMediaSizeIndex(
      root,
      abortController.signal
    )).rejects.toMatchObject({ name: 'AbortError' });

    const fallbackAbortController = new AbortController();
    fallbackAbortController.abort();
    await expect(computeMessengerExportChatSize(
      root,
      'chat_alice.json',
      undefined,
      fallbackAbortController.signal
    )).rejects.toMatchObject({ name: 'AbortError' });
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
    expect(state.pathIndex.size).toBe(state.mediaFileCount);
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

  it('reports ownership counts before media byte sizing completes', async () => {
    const root = messengerRoot();
    const { entries, chatIndex } = await listMessengerExportChatsIndexed(root);
    const alice = entries.find(item => item._jsonFileName === 'chat_alice.json')!;

    const info = getMessengerExportDeletionOwnershipInfo([alice], chatIndex);

    expect(info.jsonSize).toBeGreaterThan(0);
    expect(info.exclusiveMediaFiles).toEqual(['photo1.jpg']);
    expect(info.exclusiveMediaCount).toBe(1);
    expect(info.sharedMediaCount).toBe(1);
    expect(info.mediaSize).toBe(0);
    expect(info.totalSize).toBe(info.jsonSize);
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
    await expect(root.getFileHandle('chat_group.json')).resolves.toMatchObject({ kind: 'file' });
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
    ).rejects.toBeInstanceOf(MessengerExportDeletionPartialError);
    await expect(root.getFileHandle('chat_alice.json')).resolves.toMatchObject({ kind: 'file' });
    expect(referenceIndex.chatMedia.has('chat_alice.json')).toBe(true);
  });

  it('continues media removals after one fails and reports a partial result', async () => {
    const root = createMockDirectoryHandle('messenger', {
      'chat.json': JSON.stringify({
        threadName: 'Chat',
        participants: ['Alice'],
        messages: [{
          senderName: 'Alice',
          timestamp: 1,
          media: [{ uri: 'media/blocked.jpg' }, { uri: 'media/removed.jpg' }],
        }],
      }),
      media: {
        'blocked.jpg': new Uint8Array([1]),
        'removed.jpg': new Uint8Array([2]),
      },
    });
    const { entries, chatIndex } = await listMessengerExportChatsIndexed(root);
    const plan = buildMessengerExportDeletionPlan(entries, chatIndex);
    const media = await root.getDirectoryHandle('media');
    const removeMedia = media.removeEntry.bind(media);
    vi.spyOn(media, 'removeEntry').mockImplementation(async name => {
      if (name === 'blocked.jpg') {
        throw new DOMException('Media deletion denied', 'NotAllowedError');
      }
      return removeMedia(name);
    });

    const result = await executeMessengerExportDeletionPlan(root, plan, chatIndex);

    expect(result.chats[0]).toMatchObject({ deleted: false, partial: true, removedMediaCount: 1 });
    expect((result.chats[0].error as MessengerExportDeletionPartialError).mediaFailures).toHaveLength(1);
    await expect(root.getFileHandle('chat.json')).resolves.toMatchObject({ kind: 'file' });
    await expect(media.getFileHandle('blocked.jpg')).resolves.toMatchObject({ kind: 'file' });
    await expect(media.getFileHandle('removed.jpg')).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(chatIndex.referenceIndex.chatMedia.has('chat.json')).toBe(true);
  });

  it('keeps the chat retryable when every media removal fails before JSON deletion', async () => {
    const root = createMockDirectoryHandle('messenger', {
      'chat.json': JSON.stringify({
        threadName: 'Chat',
        participants: ['Alice'],
        messages: [{ senderName: 'Alice', timestamp: 1, media: [{ uri: 'media/blocked.jpg' }] }],
      }),
      media: { 'blocked.jpg': new Uint8Array([1]) },
    });
    const { entries, chatIndex } = await listMessengerExportChatsIndexed(root);
    const media = await root.getDirectoryHandle('media');
    vi.spyOn(media, 'removeEntry').mockRejectedValue(
      new DOMException('Media deletion denied', 'NotAllowedError')
    );

    const result = await executeMessengerExportDeletionPlan(
      root,
      buildMessengerExportDeletionPlan(entries, chatIndex),
      chatIndex
    );

    expect(result.chats[0]).toMatchObject({ deleted: false, partial: false, removedMediaCount: 0 });
    await expect(root.getFileHandle('chat.json')).resolves.toMatchObject({ kind: 'file' });
    expect(chatIndex.referenceIndex.chatMedia.has('chat.json')).toBe(true);
  });

  it('reports text-only and JSON-only removal failures without mutating the index', async () => {
    const root = createMockDirectoryHandle('messenger', {
      'chat.json': JSON.stringify({
        threadName: 'Text only',
        participants: ['Alice'],
        messages: [{ senderName: 'Alice', timestamp: 1, text: 'hello' }],
      }),
    });
    const { entries, chatIndex } = await listMessengerExportChatsIndexed(root);
    vi.spyOn(root, 'removeEntry').mockRejectedValue(
      new DOMException('JSON deletion denied', 'NotAllowedError')
    );

    const normalResult = await executeMessengerExportDeletionPlan(
      root,
      buildMessengerExportDeletionPlan(entries, chatIndex),
      chatIndex
    );
    const jsonOnlyResult = await deleteMessengerExportJsonOnly(root, entries, chatIndex);

    expect(normalResult.chats[0]).toMatchObject({ deleted: false, partial: false });
    expect(jsonOnlyResult[0]).toMatchObject({ deleted: false, partial: false });
    expect(chatIndex.referenceIndex.chatMedia.has('chat.json')).toBe(true);
  });

  it('removes media before JSON and resolves the media directory once', async () => {
    const root = messengerRoot();
    const { entries, chatIndex } = await listMessengerExportChatsIndexed(root);
    const alice = entries.find(item => item._jsonFileName === 'chat_alice.json')!;
    const media = await root.getDirectoryHandle('media');
    const operations: string[] = [];
    const removeMedia = media.removeEntry.bind(media);
    const removeRoot = root.removeEntry.bind(root);
    vi.spyOn(media, 'removeEntry').mockImplementation(async name => {
      operations.push(`media:${name}`);
      return removeMedia(name);
    });
    vi.spyOn(root, 'removeEntry').mockImplementation(async name => {
      operations.push(`json:${name}`);
      return removeRoot(name);
    });
    const getDirectory = vi.spyOn(root, 'getDirectoryHandle');

    await deleteMessengerExportChat(root, alice, chatIndex);

    expect(operations).toEqual(['media:photo1.jpg', 'json:chat_alice.json']);
    expect(getDirectory.mock.calls.filter(([name]) => name === 'media')).toHaveLength(1);
  });

  it('caps Messenger media removal at four active files', async () => {
    const mediaEntries = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [`file-${index}.jpg`, new Uint8Array([index])])
    );
    const root = createMockDirectoryHandle('messenger', {
      'chat.json': JSON.stringify({
        threadName: 'Many files',
        participants: ['Alice'],
        messages: [{
          senderName: 'Alice',
          timestamp: 1,
          media: Object.keys(mediaEntries).map(name => ({ uri: `media/${name}` })),
        }],
      }),
      media: mediaEntries,
    });
    const { entries, chatIndex } = await listMessengerExportChatsIndexed(root);
    const media = await root.getDirectoryHandle('media');
    const removeEntry = media.removeEntry.bind(media);
    let active = 0;
    let peak = 0;
    let started = 0;
    const releases = Array.from({ length: 9 }, () => {
      let release = () => {};
      const promise = new Promise<void>(resolve => { release = resolve; });
      return { promise, release };
    });
    vi.spyOn(media, 'removeEntry').mockImplementation(async name => {
      const index = Number(name.match(/\d+/)?.[0]);
      started++;
      active++;
      peak = Math.max(peak, active);
      await releases[index].promise;
      try {
        await removeEntry(name);
      } finally {
        active--;
      }
    });

    const deletion = deleteMessengerExportChat(root, entries[0], chatIndex);
    for (let turn = 0; turn < 10 && started < 4; turn++) await Promise.resolve();

    expect(started).toBe(4);
    expect(active).toBe(4);
    releases[0].release();
    for (let turn = 0; turn < 10 && started < 5; turn++) await Promise.resolve();
    expect(started).toBe(5);

    releases.forEach(gate => gate.release());
    await deletion;

    expect(peak).toBe(4);
    expect(started).toBe(9);
    await expect(root.getFileHandle('chat.json')).rejects.toMatchObject({ name: 'NotFoundError' });
    for (const name of Object.keys(mediaEntries)) {
      await expect(media.getFileHandle(name)).rejects.toMatchObject({ name: 'NotFoundError' });
    }
  });

  it('keeps media owned by a selected chat that fails to commit', async () => {
    const root = createMockDirectoryHandle('messenger', {
      'a.json': JSON.stringify({
        threadName: 'A',
        participants: ['A'],
        messages: [{ senderName: 'A', timestamp: 1, media: [{ uri: 'media/ab.jpg' }] }],
      }),
      'b.json': JSON.stringify({
        threadName: 'B',
        participants: ['B'],
        messages: [{
          senderName: 'B',
          timestamp: 2,
          media: [{ uri: 'media/ab.jpg' }, { uri: 'media/bc.jpg' }],
        }],
      }),
      'c.json': JSON.stringify({
        threadName: 'C',
        participants: ['C'],
        messages: [{ senderName: 'C', timestamp: 3, media: [{ uri: 'media/bc.jpg' }] }],
      }),
      media: {
        'ab.jpg': new Uint8Array([1]),
        'bc.jpg': new Uint8Array([2]),
      },
    });
    const { entries, chatIndex } = await listMessengerExportChatsIndexed(root);
    const orderedEntries = ['a.json', 'b.json', 'c.json'].map(
      name => entries.find(item => item._jsonFileName === name)!
    );
    const getFileHandle = vi.spyOn(root, 'getFileHandle');
    const getDirectoryHandle = vi.spyOn(root, 'getDirectoryHandle');
    const plan = buildMessengerExportDeletionPlan(orderedEntries, chatIndex);
    expect(plan.chats.map(chat => [chat.jsonFileName, chat.mediaFiles.map(file => file.path)])).toEqual([
      ['a.json', []],
      ['b.json', ['ab.jpg']],
      ['c.json', ['bc.jpg']],
    ]);
    expect(plan.totalOperations).toBe(5);
    expect(getFileHandle).not.toHaveBeenCalled();
    expect(getDirectoryHandle).not.toHaveBeenCalled();
    const removeRoot = root.removeEntry.bind(root);
    vi.spyOn(root, 'removeEntry').mockImplementation(async name => {
      if (name === 'b.json') throw new DOMException('JSON deletion denied', 'NotAllowedError');
      return removeRoot(name);
    });

    const result = await executeMessengerExportDeletionPlan(root, plan, chatIndex);
    expect(getDirectoryHandle.mock.calls.filter(([name]) => name === 'media')).toHaveLength(1);
    const media = await root.getDirectoryHandle('media');

    expect(result.chats.map(chat => [chat.entry._jsonFileName, chat.deleted, chat.partial])).toEqual([
      ['a.json', true, false],
      ['b.json', false, true],
      ['c.json', true, false],
    ]);
    await expect(root.getFileHandle('b.json')).resolves.toMatchObject({ kind: 'file' });
    await expect(media.getFileHandle('ab.jpg')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(media.getFileHandle('bc.jpg')).resolves.toMatchObject({ kind: 'file' });
    expect(chatIndex.referenceIndex.mediaOwners.get('media/bc.jpg')).toEqual(new Set(['b.json']));
  });

  it('deletes only Messenger JSON when media ownership is incomplete', async () => {
    const root = createMockDirectoryHandle('messenger', {
      'chat.json': JSON.stringify({
        threadName: 'Chat',
        participants: ['Alice'],
        messages: [{ senderName: 'Alice', timestamp: 1, media: [{ uri: 'media/photo.jpg' }] }],
      }),
      'broken.json': '{not-json',
      media: { 'photo.jpg': new Uint8Array([1]) },
    });
    const { entries, chatIndex } = await listMessengerExportChatsIndexed(root);
    expect(() => buildMessengerExportDeletionPlan(entries, chatIndex)).toThrow(
      MessengerExportIndexIncompleteError
    );

    const result = await deleteMessengerExportJsonOnly(root, entries, chatIndex);
    const media = await root.getDirectoryHandle('media');

    expect(result[0].deleted).toBe(true);
    await expect(root.getFileHandle('chat.json')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(media.getFileHandle('photo.jpg')).resolves.toMatchObject({ kind: 'file' });
    expect(chatIndex.referenceIndex.chatMedia.has('chat.json')).toBe(false);
    expect(chatIndex.complete).toBe(false);
  });
});
