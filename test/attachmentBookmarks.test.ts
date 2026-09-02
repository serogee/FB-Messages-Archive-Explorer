import { describe, expect, it } from 'vitest';
import {
  createAttachmentBookmark,
  createBookmark,
  getBookmarkItemId,
  getAttachmentBookmarkId,
  loadAttachmentBookmarks,
  removeBookmarksForChats,
  saveAttachmentBookmarks,
} from '../src/services/attachmentBookmarks';
import type { ChatListEntry, ResolvedAttachment } from '../src/types/messenger';
import type { ResolvedLink } from '../src/types/messenger';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';

function facebookEntry(folderName = 'alice'): ChatListEntry {
  return {
    folderName,
    title: 'Alice',
    participants: ['Alice'],
    messageCount: 1,
    folderSize: 0,
    dirHandle: createMockDirectoryHandle(folderName, {}),
    jsonFileCount: 1,
    source: 'inbox',
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

describe('attachment bookmarks', () => {
  it('uses stable, normalized IDs for both archive formats', () => {
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

  it('creates and reloads selected_messages/bookmarks.json', async () => {
    const root = createMockDirectoryHandle('messages', {});
    const bookmark = createAttachmentBookmark(facebookEntry(), attachment(), '2026-09-02T00:00:00.000Z');

    await saveAttachmentBookmarks(root, [bookmark]);
    const loaded = await loadAttachmentBookmarks(root);

    expect(loaded.fileExists).toBe(true);
    expect(loaded.bookmarks).toEqual([bookmark]);
    const selected = await root.getDirectoryHandle('selected_messages');
    const file = await selected.getFileHandle('bookmarks.json');
    expect(JSON.parse(await (await file.getFile()).text()).version).toBe(1);
  });

  it('does not create a bookmark file while loading an archive without one', async () => {
    const root = createMockDirectoryHandle('messages', {});
    await expect(loadAttachmentBookmarks(root)).resolves.toEqual({ bookmarks: [], fileExists: false });
    await expect(root.getDirectoryHandle('selected_messages')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('keeps the JSON file and writes an empty list after its last bookmark is removed', async () => {
    const root = createMockDirectoryHandle('messages', {});
    await saveAttachmentBookmarks(root, []);

    const loaded = await loadAttachmentBookmarks(root);
    expect(loaded).toMatchObject({ fileExists: true, bookmarks: [] });
  });

  it('removes only bookmarks belonging to deleted Facebook and Messenger chats', () => {
    const facebook = facebookEntry();
    const messenger = messengerEntry();
    const retained = createAttachmentBookmark(facebookEntry('bob'), attachment('photos/bob.jpg'));
    const bookmarks = [
      createAttachmentBookmark(facebook, attachment()),
      createAttachmentBookmark(messenger, attachment('media/alice.jpg')),
      retained,
    ];

    expect(removeBookmarksForChats(bookmarks, [facebook, messenger])).toEqual([retained]);
  });

  it('ignores malformed records while retaining valid bookmarks', async () => {
    const valid = createAttachmentBookmark(facebookEntry(), attachment());
    const root = createMockDirectoryHandle('messages', {
      selected_messages: {
        'bookmarks.json': JSON.stringify({ version: 1, bookmarks: [valid, { id: 123 }] }),
      },
    });

    await expect(loadAttachmentBookmarks(root)).resolves.toEqual({ bookmarks: [valid], fileExists: true });
  });

  it('round-trips attachment and link bookmarks together', async () => {
    const root = createMockDirectoryHandle('messages', {});
    const entry = facebookEntry();
    const records = [
      createBookmark(entry, attachment()),
      createBookmark(entry, link()),
    ];

    await saveAttachmentBookmarks(root, records);
    await expect(loadAttachmentBookmarks(root)).resolves.toMatchObject({
      fileExists: true,
      bookmarks: records,
    });
  });
});
