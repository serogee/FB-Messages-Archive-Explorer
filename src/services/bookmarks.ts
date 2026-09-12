import type { ChatListEntry, ResolvedAttachment, SelectableItem } from '../types/messenger';
import type { ReadableDirectoryHandle, WritableDirectoryHandle } from '../types/fileSystem';

export const BOOKMARKS_DIRECTORY = 'fb-mae';
export const LEGACY_BOOKMARKS_DIRECTORY = 'selected_messages';
export const BOOKMARKS_FILE = 'bookmarks.json';

interface BookmarkChatSnapshot {
  title: string;
  source: ChatListEntry['source'];
  folderName: string;
  jsonFileName?: string;
}

export interface AttachmentBookmark {
  id: string;
  chatId: string;
  archiveFormat: 'facebook' | 'messenger';
  chat: BookmarkChatSnapshot;
  kind: 'attachment' | 'link';
  attachment?: {
    category: ResolvedAttachment['category'];
    mediaPath: string;
  };
  link?: {
    url: string;
    label?: string;
  };
  message: {
    sender: string;
    timestampMs: number;
    index: number;
  };
  createdAt: string;
}

export interface PinnedChatBookmark {
  id: string;
  archiveFormat: 'facebook' | 'messenger';
  chat: BookmarkChatSnapshot;
  pinnedAt: string;
}

export interface BookmarkData {
  bookmarks: AttachmentBookmark[];
  pinnedChats: PinnedChatBookmark[];
}

export interface BookmarkFile extends BookmarkData {
  version: 2;
  updatedAt: string;
}

export interface LoadedBookmarks extends BookmarkData {
  fileExists: boolean;
}

const bookmarkDirectoryPreparations = new WeakMap<
  WritableDirectoryHandle,
  Promise<WritableDirectoryHandle>
>();

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function createChatSnapshot(entry: ChatListEntry): BookmarkChatSnapshot {
  return {
    title: entry.title,
    source: entry.source,
    folderName: entry.folderName,
    ...(entry._jsonFileName ? { jsonFileName: entry._jsonFileName } : {}),
  };
}

export function getBookmarkChatId(entry: ChatListEntry): string {
  return entry._messengerExport
    ? `messenger:${(entry._jsonFileName || entry.folderName).toLowerCase()}`
    : `facebook:${entry.source}:${entry.folderName.toLowerCase()}`;
}

export function getAttachmentBookmarkId(
  entry: ChatListEntry,
  attachment: Pick<ResolvedAttachment, 'category' | 'mediaPath'>
): string {
  return `${getBookmarkChatId(entry)}:${attachment.category}:${normalizePath(attachment.mediaPath)}`;
}

export function getBookmarkItemId(entry: ChatListEntry, item: SelectableItem): string {
  if (item.category !== 'links') return getAttachmentBookmarkId(entry, item);
  return `${getBookmarkChatId(entry)}:links:${item.timestamp}:${item.sender.toLowerCase()}:${item.url}`;
}

export function createAttachmentBookmark(
  entry: ChatListEntry,
  attachment: ResolvedAttachment,
  createdAt = new Date().toISOString()
): AttachmentBookmark {
  return {
    id: getAttachmentBookmarkId(entry, attachment),
    chatId: getBookmarkChatId(entry),
    archiveFormat: entry._messengerExport ? 'messenger' : 'facebook',
    kind: 'attachment',
    chat: createChatSnapshot(entry),
    attachment: {
      category: attachment.category,
      mediaPath: attachment.mediaPath.replace(/\\/g, '/'),
    },
    message: {
      sender: attachment.sender,
      timestampMs: attachment.timestamp,
      index: attachment.messageIndex,
    },
    createdAt,
  };
}

export function createBookmark(
  entry: ChatListEntry,
  item: SelectableItem,
  createdAt = new Date().toISOString()
): AttachmentBookmark {
  if (item.category !== 'links') return createAttachmentBookmark(entry, item, createdAt);
  return {
    id: getBookmarkItemId(entry, item),
    chatId: getBookmarkChatId(entry),
    archiveFormat: entry._messengerExport ? 'messenger' : 'facebook',
    kind: 'link',
    chat: createChatSnapshot(entry),
    link: {
      url: item.url,
      ...(item.label ? { label: item.label } : {}),
    },
    message: {
      sender: item.sender,
      timestampMs: item.timestamp,
      index: item.messageIndex,
    },
    createdAt,
  };
}

export function createPinnedChatBookmark(
  entry: ChatListEntry,
  pinnedAt = new Date().toISOString()
): PinnedChatBookmark {
  return {
    id: getBookmarkChatId(entry),
    archiveFormat: entry._messengerExport ? 'messenger' : 'facebook',
    chat: createChatSnapshot(entry),
    pinnedAt,
  };
}

function hasValidChatSnapshot(value: unknown): value is BookmarkChatSnapshot {
  if (!value || typeof value !== 'object') return false;
  const chat = value as Partial<BookmarkChatSnapshot>;
  return typeof chat.title === 'string'
    && typeof chat.folderName === 'string'
    && (chat.source === 'inbox' || chat.source === 'archived' || chat.source === 'requests' || chat.source === 'e2ee')
    && (chat.jsonFileName === undefined || typeof chat.jsonFileName === 'string');
}

function isAttachmentBookmark(value: unknown): value is AttachmentBookmark {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<AttachmentBookmark>;
  const hasAttachment = !!item.attachment
    && typeof item.attachment.mediaPath === 'string'
    && typeof item.attachment.category === 'string';
  const hasLink = !!item.link && typeof item.link.url === 'string';
  return typeof item.id === 'string'
    && typeof item.chatId === 'string'
    && (item.archiveFormat === 'facebook' || item.archiveFormat === 'messenger')
    && hasValidChatSnapshot(item.chat)
    && (hasAttachment || hasLink)
    && !!item.message && typeof item.message.sender === 'string'
    && typeof item.message.timestampMs === 'number'
    && typeof item.message.index === 'number'
    && typeof item.createdAt === 'string';
}

function isPinnedChatBookmark(value: unknown): value is PinnedChatBookmark {
  if (!value || typeof value !== 'object') return false;
  const pin = value as Partial<PinnedChatBookmark>;
  return typeof pin.id === 'string'
    && (pin.archiveFormat === 'facebook' || pin.archiveFormat === 'messenger')
    && hasValidChatSnapshot(pin.chat)
    && typeof pin.pinnedAt === 'string';
}

function normalizePinnedChats(values: unknown[]): PinnedChatBookmark[] {
  const seen = new Set<string>();
  const pins: PinnedChatBookmark[] = [];
  for (const value of values) {
    if (!isPinnedChatBookmark(value) || seen.has(value.id)) continue;
    seen.add(value.id);
    pins.push(value);
  }
  return pins;
}

async function loadBookmarksFromDirectory(
  messagesRoot: ReadableDirectoryHandle,
  directoryName: string
): Promise<LoadedBookmarks> {
  const directory = await messagesRoot.getDirectoryHandle(directoryName);
  const fileHandle = await directory.getFileHandle(BOOKMARKS_FILE);
  const parsed = JSON.parse(await (await fileHandle.getFile()).text()) as Partial<BookmarkFile>;
  const bookmarks = Array.isArray(parsed.bookmarks)
    ? parsed.bookmarks.filter(isAttachmentBookmark).map(bookmark => ({
        ...bookmark,
        kind: bookmark.link ? 'link' as const : 'attachment' as const,
      }))
    : [];
  const pinnedChats = Array.isArray(parsed.pinnedChats)
    ? normalizePinnedChats(parsed.pinnedChats)
    : [];
  return { bookmarks, pinnedChats, fileExists: true };
}

export async function loadBookmarks(
  messagesRoot: ReadableDirectoryHandle
): Promise<LoadedBookmarks> {
  let canonicalDirectoryExists = true;
  try {
    await messagesRoot.getDirectoryHandle(BOOKMARKS_DIRECTORY);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    canonicalDirectoryExists = false;
  }

  if (canonicalDirectoryExists) {
    try {
      return await loadBookmarksFromDirectory(messagesRoot, BOOKMARKS_DIRECTORY);
    } catch (error) {
      if (isNotFoundError(error)) return { bookmarks: [], pinnedChats: [], fileExists: false };
      if (error instanceof SyntaxError) return { bookmarks: [], pinnedChats: [], fileExists: true };
      throw error;
    }
  }

  try {
    return await loadBookmarksFromDirectory(messagesRoot, LEGACY_BOOKMARKS_DIRECTORY);
  } catch (error) {
    if (isNotFoundError(error)) return { bookmarks: [], pinnedChats: [], fileExists: false };
    if (error instanceof SyntaxError) return { bookmarks: [], pinnedChats: [], fileExists: true };
    throw error;
  }
}

async function copyDirectoryContents(
  source: ReadableDirectoryHandle,
  destination: WritableDirectoryHandle
): Promise<void> {
  for await (const [name, entry] of source.entries()) {
    if (entry.kind === 'directory') {
      const destinationDirectory = await destination.getDirectoryHandle(name, { create: true });
      await copyDirectoryContents(entry, destinationDirectory);
      continue;
    }

    const destinationFile = await destination.getFileHandle(name, { create: true });
    const writable = await destinationFile.createWritable();
    await writable.write(await entry.getFile());
    await writable.close();
  }
}

export async function migrateLegacyBookmarksDirectory(
  messagesRoot: WritableDirectoryHandle
): Promise<boolean> {
  try {
    await messagesRoot.getDirectoryHandle(BOOKMARKS_DIRECTORY);
    return false;
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  let legacyDirectory: WritableDirectoryHandle | null = null;
  try {
    legacyDirectory = await messagesRoot.getDirectoryHandle(LEGACY_BOOKMARKS_DIRECTORY);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  if (!legacyDirectory) return false;

  const directory = await messagesRoot.getDirectoryHandle(BOOKMARKS_DIRECTORY, { create: true });

  try {
    await copyDirectoryContents(legacyDirectory, directory);
    await messagesRoot.removeEntry(LEGACY_BOOKMARKS_DIRECTORY, { recursive: true });
    return true;
  } catch (error) {
    try {
      await messagesRoot.removeEntry(BOOKMARKS_DIRECTORY, { recursive: true });
    } catch {
      // Preserve the original migration error; cleanup is best effort.
    }
    throw error;
  }
}

export function prepareBookmarksDirectory(
  messagesRoot: WritableDirectoryHandle
): Promise<WritableDirectoryHandle> {
  const cached = bookmarkDirectoryPreparations.get(messagesRoot);
  if (cached) return cached;

  const preparation = (async () => {
    await migrateLegacyBookmarksDirectory(messagesRoot);
    return messagesRoot.getDirectoryHandle(BOOKMARKS_DIRECTORY, { create: true });
  })();
  bookmarkDirectoryPreparations.set(messagesRoot, preparation);
  return preparation;
}

export function invalidateBookmarksDirectoryPreparation(
  messagesRoot: WritableDirectoryHandle
): void {
  bookmarkDirectoryPreparations.delete(messagesRoot);
}

export async function saveBookmarksToDirectory(
  directory: WritableDirectoryHandle,
  data: BookmarkData
): Promise<void> {
  const fileHandle = await directory.getFileHandle(BOOKMARKS_FILE, { create: true });
  const writable = await fileHandle.createWritable();
  const payload: BookmarkFile = {
    version: 2,
    updatedAt: new Date().toISOString(),
    bookmarks: data.bookmarks,
    pinnedChats: data.pinnedChats,
  };
  await writable.write(JSON.stringify(payload, null, 2) + '\n');
  await writable.close();
}

export async function saveBookmarks(
  messagesRoot: WritableDirectoryHandle,
  data: BookmarkData
): Promise<void> {
  const directory = await prepareBookmarksDirectory(messagesRoot);
  await saveBookmarksToDirectory(directory, data);
}

export function setChatPins(
  pinnedChats: PinnedChatBookmark[],
  entries: ChatListEntry[],
  pinned: boolean
): PinnedChatBookmark[] {
  const ids = new Set(entries.map(getBookmarkChatId));
  if (!pinned) return pinnedChats.filter(pin => !ids.has(pin.id));

  const existingIds = new Set(pinnedChats.map(pin => pin.id));
  const additions: PinnedChatBookmark[] = [];
  const addedIds = new Set<string>();
  for (const entry of entries) {
    const id = getBookmarkChatId(entry);
    if (existingIds.has(id) || addedIds.has(id)) continue;
    addedIds.add(id);
    additions.push(createPinnedChatBookmark(entry));
  }
  return additions.length > 0 ? [...additions, ...pinnedChats] : pinnedChats;
}

export function removeBookmarkDataForChats(
  data: BookmarkData,
  entries: ChatListEntry[]
): BookmarkData {
  const removedChatIds = new Set(entries.map(getBookmarkChatId));
  return {
    bookmarks: data.bookmarks.filter(bookmark => !removedChatIds.has(bookmark.chatId)),
    pinnedChats: data.pinnedChats.filter(pin => !removedChatIds.has(pin.id)),
  };
}
