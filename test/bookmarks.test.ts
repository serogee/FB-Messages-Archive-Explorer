import { describe, expect, it } from 'vitest';
import {
  createAttachmentBookmark,
  createBookmark,
  createPinnedChatBookmark,
  getAttachmentBookmarkId,
  getBookmarkChatId,
  getBookmarkItemId,
  invalidateBookmarksDirectoryPreparation,
  loadBookmarks,
  migrateLegacyBookmarksDirectory,
  prepareBookmarksDirectory,
  removeBookmarkDataForChats,
  saveBookmarks,
  setChatPins,
} from '../src/services/bookmarks';
import type { ChatListEntry, ResolvedAttachment, ResolvedLink } from '../src/types/messenger';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';

function facebookEntry(
  folderName = 'alice',
  source: ChatListEntry['source'] = 'inbox',
  title = 'Alice'
): ChatListEntry {
  return {
    folderName,
    title,
    participants: [title],
    messageCount: 1,
    folderSize: 0,
    dirHandle: createMockDirectoryHandle(folderName, {}),
    jsonFileCount: 1,
    source,
  };
}

function messengerEntry(fileName = 'alice.json'): ChatListEntry {
  return {
    ...facebookEntry(fileName.replace(/\.json$/i, '')),
    dirHandle: createMockDirectoryHandle('messenger', {}),
    _messengerExport: true,
    _jsonFileName: fileName,
  };
}

function attachment(path = 'photos/Photo.JPG'): ResolvedAttachment {
  return {
    mediaPath: path,
    category: 'photos',
    messageIndex: 4,
    timestamp: 1700000000000,
    sender: 'Alice',
    mediaEntry: null,
  };
}

function link(url = 'https://example.com/Page'): ResolvedLink {
  return {
    category: 'links',
    url,
    label: 'Example',
    messageIndex: 5,
    timestamp: 1700000001000,
    sender: 'Alice',
  };
}

describe('bookmarks', () => {
  it('uses stable, source-aware IDs for both archive formats', () => {
    expect(getBookmarkChatId(facebookEntry())).toBe('facebook:inbox:alice');
    expect(getBookmarkChatId(facebookEntry('alice', 'archived'))).toBe('facebook:archived:alice');
    expect(getBookmarkChatId(messengerEntry())).toBe('messenger:alice.json');
    expect(getAttachmentBookmarkId(facebookEntry(), attachment()))
      .toBe('facebook:inbox:alice:photos:photos/photo.jpg');
    expect(getAttachmentBookmarkId(messengerEntry(), attachment('MEDIA\\Photo.JPG')))
      .toBe('messenger:alice.json:photos:media/photo.jpg');
  });

  it('creates stable link bookmarks with sender data for future filtering', () => {
    const entry = facebookEntry();
    const bookmarkedLink = createBookmark(entry, link(), '2026-09-02T00:00:00.000Z');

    expect(getBookmarkItemId(entry, link())).toBe(
      'facebook:inbox:alice:links:1700000001000:alice:https://example.com/Page'
    );
    expect(bookmarkedLink).toMatchObject({
      kind: 'link',
      link: { url: 'https://example.com/Page', label: 'Example' },
      message: { sender: 'Alice', timestampMs: 1700000001000, index: 5 },
    });
  });

  it('loads version 1 files with no pins and upgrades them without losing bookmarks', async () => {
    const bookmark = createAttachmentBookmark(facebookEntry(), attachment(), '2026-09-02T00:00:00.000Z');
    const root = createMockDirectoryHandle('messages', {
      selected_messages: {
        'bookmarks.json': JSON.stringify({
          version: 1,
          updatedAt: '2026-09-02T00:00:00.000Z',
          bookmarks: [bookmark],
        }),
        'keep.txt': 'legacy data',
        nested: { 'note.txt': 'nested legacy data' },
      },
    });

    await expect(loadBookmarks(root)).resolves.toEqual({
      bookmarks: [bookmark],
      pinnedChats: [],
      fileExists: true,
    });

    const pin = createPinnedChatBookmark(facebookEntry('bob', 'archived', 'Bob'));
    await expect(migrateLegacyBookmarksDirectory(root)).resolves.toBe(true);
    await saveBookmarks(root, { bookmarks: [bookmark], pinnedChats: [pin] });
    const selected = await root.getDirectoryHandle('fb-mae');
    const file = await selected.getFileHandle('bookmarks.json');
    const parsed = JSON.parse(await (await file.getFile()).text());
    expect(parsed).toMatchObject({ version: 2, bookmarks: [bookmark], pinnedChats: [pin] });
    expect(await (await (await selected.getFileHandle('keep.txt')).getFile()).text()).toBe('legacy data');
    const nested = await selected.getDirectoryHandle('nested');
    expect(await (await (await nested.getFileHandle('note.txt')).getFile()).text()).toBe('nested legacy data');
    await expect(root.getDirectoryHandle('selected_messages')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('round-trips attachment, link, Facebook pin, and Messenger pin records together', async () => {
    const root = createMockDirectoryHandle('messages', {});
    const facebook = facebookEntry();
    const records = [createBookmark(facebook, attachment()), createBookmark(facebook, link())];
    const pins = [
      createPinnedChatBookmark(messengerEntry(), '2026-09-12T02:00:00.000Z'),
      createPinnedChatBookmark(facebook, '2026-09-12T01:00:00.000Z'),
    ];

    await saveBookmarks(root, { bookmarks: records, pinnedChats: pins });
    await expect(loadBookmarks(root)).resolves.toEqual({
      bookmarks: records,
      pinnedChats: pins,
      fileExists: true,
    });
  });

  it('does not create a bookmark file while loading an archive without one', async () => {
    const root = createMockDirectoryHandle('messages', {});
    await expect(loadBookmarks(root)).resolves.toEqual({
      bookmarks: [],
      pinnedChats: [],
      fileExists: false,
    });
    await expect(root.getDirectoryHandle('fb-mae')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(root.getDirectoryHandle('selected_messages')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('strictly prioritizes fb-mae when both bookmark directories exist', async () => {
    const canonicalPin = createPinnedChatBookmark(facebookEntry('canonical'));
    const legacyPin = createPinnedChatBookmark(facebookEntry('legacy'));
    const root = createMockDirectoryHandle('messages', {
      'fb-mae': {
        'bookmarks.json': JSON.stringify({ version: 2, bookmarks: [], pinnedChats: [canonicalPin] }),
      },
      selected_messages: {
        'bookmarks.json': JSON.stringify({ version: 2, bookmarks: [], pinnedChats: [legacyPin] }),
      },
    });

    await expect(loadBookmarks(root)).resolves.toEqual({
      bookmarks: [],
      pinnedChats: [canonicalPin],
      fileExists: true,
    });
  });

  it('does not fall back to selected_messages when an empty fb-mae directory exists', async () => {
    const legacyPin = createPinnedChatBookmark(facebookEntry('legacy'));
    const root = createMockDirectoryHandle('messages', {
      'fb-mae': {},
      selected_messages: {
        'bookmarks.json': JSON.stringify({ version: 2, bookmarks: [], pinnedChats: [legacyPin] }),
      },
    });

    await expect(loadBookmarks(root)).resolves.toEqual({
      bookmarks: [],
      pinnedChats: [],
      fileExists: false,
    });
  });

  it('keeps the JSON file with empty arrays after its final records are removed', async () => {
    const root = createMockDirectoryHandle('messages', {});
    await saveBookmarks(root, { bookmarks: [], pinnedChats: [] });

    await expect(loadBookmarks(root)).resolves.toEqual({
      bookmarks: [],
      pinnedChats: [],
      fileExists: true,
    });
  });

  it('shares bookmark directory preparation across writes for the same root', async () => {
    const root = createMockDirectoryHandle('messages', {});
    const originalGetDirectoryHandle = root.getDirectoryHandle.bind(root);
    let directoryLookups = 0;
    root.getDirectoryHandle = async (name, options) => {
      directoryLookups++;
      return originalGetDirectoryHandle(name, options);
    };

    const firstPreparation = prepareBookmarksDirectory(root);
    const secondPreparation = prepareBookmarksDirectory(root);
    expect(secondPreparation).toBe(firstPreparation);
    await firstPreparation;
    const lookupsAfterPreparation = directoryLookups;

    await saveBookmarks(root, { bookmarks: [], pinnedChats: [] });
    await saveBookmarks(root, { bookmarks: [], pinnedChats: [] });
    expect(directoryLookups).toBe(lookupsAfterPreparation);
  });

  it('keeps a failed preparation cached until explicit invalidation', async () => {
    const root = createMockDirectoryHandle('messages', {});
    const originalGetDirectoryHandle = root.getDirectoryHandle.bind(root);
    let failPreparation = true;
    let directoryLookups = 0;
    root.getDirectoryHandle = async (name, options) => {
      directoryLookups++;
      if (failPreparation) throw new DOMException('Permission expired', 'NotAllowedError');
      return originalGetDirectoryHandle(name, options);
    };

    const firstPreparation = prepareBookmarksDirectory(root);
    await expect(firstPreparation).rejects.toMatchObject({ name: 'NotAllowedError' });
    await expect(prepareBookmarksDirectory(root)).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(directoryLookups).toBe(1);

    failPreparation = false;
    invalidateBookmarksDirectoryPreparation(root);
    await expect(prepareBookmarksDirectory(root)).resolves.toMatchObject({ name: 'fb-mae' });
    expect(directoryLookups).toBeGreaterThan(1);
  });

  it('ignores malformed records independently and retains the first duplicate pin position', async () => {
    const validBookmark = createAttachmentBookmark(facebookEntry(), attachment());
    const firstPin = createPinnedChatBookmark(facebookEntry(), '2026-09-12T01:00:00.000Z');
    const duplicatePin = createPinnedChatBookmark(facebookEntry(), '2026-09-12T03:00:00.000Z');
    const secondPin = createPinnedChatBookmark(messengerEntry(), '2026-09-12T02:00:00.000Z');
    const root = createMockDirectoryHandle('messages', {
      'fb-mae': {
        'bookmarks.json': JSON.stringify({
          version: 2,
          bookmarks: [validBookmark, { id: 123 }],
          pinnedChats: [firstPin, { id: 123 }, duplicatePin, secondPin],
        }),
      },
    });

    await expect(loadBookmarks(root)).resolves.toEqual({
      bookmarks: [validBookmark],
      pinnedChats: [firstPin, secondPin],
      fileExists: true,
    });
  });

  it('prepends new pins, preserves bulk order, and moves a re-pinned chat to the top', () => {
    const alice = facebookEntry('alice', 'inbox', 'Alice');
    const bob = facebookEntry('bob', 'archived', 'Bob');
    const carol = facebookEntry('carol', 'requests', 'Carol');

    let pins = setChatPins([], [alice], true);
    pins = setChatPins(pins, [bob], true);
    expect(pins.map(pin => pin.id)).toEqual([getBookmarkChatId(bob), getBookmarkChatId(alice)]);

    pins = setChatPins(pins, [carol, alice], true);
    expect(pins.map(pin => pin.id)).toEqual([
      getBookmarkChatId(carol),
      getBookmarkChatId(bob),
      getBookmarkChatId(alice),
    ]);

    pins = setChatPins(pins, [bob], false);
    pins = setChatPins(pins, [bob], true);
    expect(pins.map(pin => pin.id)).toEqual([
      getBookmarkChatId(bob),
      getBookmarkChatId(carol),
      getBookmarkChatId(alice),
    ]);
  });

  it('removes deleted chats from pins and item bookmarks without disturbing other pin order', () => {
    const alice = facebookEntry();
    const messenger = messengerEntry();
    const bob = facebookEntry('bob', 'archived', 'Bob');
    const retained = createAttachmentBookmark(bob, attachment('photos/bob.jpg'));
    const data = {
      bookmarks: [
        createAttachmentBookmark(alice, attachment()),
        createAttachmentBookmark(messenger, attachment('media/alice.jpg')),
        retained,
      ],
      pinnedChats: [
        createPinnedChatBookmark(bob),
        createPinnedChatBookmark(messenger),
        createPinnedChatBookmark(alice),
      ],
    };

    expect(removeBookmarkDataForChats(data, [alice, messenger])).toEqual({
      bookmarks: [retained],
      pinnedChats: [data.pinnedChats[0]],
    });
  });
});
