import type { ChatListEntry, ResolvedAttachment, SelectableItem } from '../types/messenger';
import type { ReadableDirectoryHandle, WritableDirectoryHandle } from '../types/fileSystem';

export const ATTACHMENT_BOOKMARKS_DIRECTORY = 'selected_messages';
export const ATTACHMENT_BOOKMARKS_FILE = 'bookmarks.json';

export interface AttachmentBookmark {
  id: string;
  chatId: string;
  archiveFormat: 'facebook' | 'messenger';
  chat: {
    title: string;
    source: ChatListEntry['source'];
    folderName: string;
    jsonFileName?: string;
  };
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

export interface AttachmentBookmarkFile {
  version: 1;
  updatedAt: string;
  bookmarks: AttachmentBookmark[];
}

export interface LoadedAttachmentBookmarks {
  bookmarks: AttachmentBookmark[];
  fileExists: boolean;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
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
    chat: {
      title: entry.title,
      source: entry.source,
      folderName: entry.folderName,
      ...(entry._jsonFileName ? { jsonFileName: entry._jsonFileName } : {}),
    },
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
    chat: {
      title: entry.title,
      source: entry.source,
      folderName: entry.folderName,
      ...(entry._jsonFileName ? { jsonFileName: entry._jsonFileName } : {}),
    },
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
    && !!item.chat && typeof item.chat.title === 'string'
    && (hasAttachment || hasLink)
    && !!item.message && typeof item.message.sender === 'string'
    && typeof item.message.timestampMs === 'number'
    && typeof item.message.index === 'number'
    && typeof item.createdAt === 'string';
}

export async function loadAttachmentBookmarks(
  messagesRoot: ReadableDirectoryHandle
): Promise<LoadedAttachmentBookmarks> {
  try {
    const directory = await messagesRoot.getDirectoryHandle(ATTACHMENT_BOOKMARKS_DIRECTORY);
    const fileHandle = await directory.getFileHandle(ATTACHMENT_BOOKMARKS_FILE);
    const parsed = JSON.parse(await (await fileHandle.getFile()).text()) as Partial<AttachmentBookmarkFile>;
    const bookmarks = Array.isArray(parsed.bookmarks)
      ? parsed.bookmarks.filter(isAttachmentBookmark).map(bookmark => ({
          ...bookmark,
          kind: bookmark.link ? 'link' as const : 'attachment' as const,
        }))
      : [];
    return { bookmarks, fileExists: true };
  } catch (error) {
    if (isNotFoundError(error)) return { bookmarks: [], fileExists: false };
    if (error instanceof SyntaxError) return { bookmarks: [], fileExists: true };
    throw error;
  }
}

export async function saveAttachmentBookmarks(
  messagesRoot: WritableDirectoryHandle,
  bookmarks: AttachmentBookmark[]
): Promise<void> {
  const directory = await messagesRoot.getDirectoryHandle(ATTACHMENT_BOOKMARKS_DIRECTORY, { create: true });
  const fileHandle = await directory.getFileHandle(ATTACHMENT_BOOKMARKS_FILE, { create: true });
  const writable = await fileHandle.createWritable();
  const payload: AttachmentBookmarkFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    bookmarks,
  };
  await writable.write(JSON.stringify(payload, null, 2) + '\n');
  await writable.close();
}

export function removeBookmarksForChats(
  bookmarks: AttachmentBookmark[],
  entries: ChatListEntry[]
): AttachmentBookmark[] {
  const removedChatIds = new Set(entries.map(getBookmarkChatId));
  return bookmarks.filter(bookmark => !removedChatIds.has(bookmark.chatId));
}
