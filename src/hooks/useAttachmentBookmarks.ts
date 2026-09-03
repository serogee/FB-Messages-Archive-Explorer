import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatListEntry, SelectableItem } from '../types/messenger';
import type { ReadableDirectoryHandle, WritableDirectoryHandle } from '../types/fileSystem';
import {
  createBookmark,
  getBookmarkItemId,
  loadAttachmentBookmarks,
  removeBookmarksForChats,
  saveAttachmentBookmarks,
  type AttachmentBookmark,
} from '../services/attachmentBookmarks';

export function useAttachmentBookmarks(messagesRoot: ReadableDirectoryHandle | null) {
  const [bookmarks, setBookmarks] = useState<AttachmentBookmark[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bookmarksRef = useRef<AttachmentBookmark[]>([]);
  const fileExistsRef = useRef(false);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const readyRef = useRef<Promise<void>>(Promise.resolve());
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    bookmarksRef.current = [];
    fileExistsRef.current = false;
    setBookmarks([]);
    setError(null);
    writeQueueRef.current = Promise.resolve();
    if (!messagesRoot) return;

    readyRef.current = loadAttachmentBookmarks(messagesRoot)
      .then(result => {
        if (generationRef.current !== generation) return;
        bookmarksRef.current = result.bookmarks;
        fileExistsRef.current = result.fileExists;
        setBookmarks(result.bookmarks);
      })
      .catch(loadError => {
        if (generationRef.current !== generation) return;
        console.error('Failed to load attachment bookmarks:', loadError);
        setError('Could not load attachment bookmarks.');
      });
  }, [messagesRoot]);

  const persist = useCallback(async (next: AttachmentBookmark[], createIfMissing = true) => {
    if (!messagesRoot) throw new Error('No messages folder is open.');
    if (!createIfMissing && !fileExistsRef.current) return;
    const generation = generationRef.current;
    setBusy(true);
    setError(null);
    const write = writeQueueRef.current
      .catch(() => {})
      .then(async () => {
        if (generationRef.current !== generation) return;
        await saveAttachmentBookmarks(messagesRoot as WritableDirectoryHandle, next);
        fileExistsRef.current = true;
      });
    writeQueueRef.current = write;
    try {
      await write;
    } catch (writeError) {
      console.error('Failed to save attachment bookmarks:', writeError);
      setError('Could not save attachment bookmarks. Check folder write access.');
      throw writeError;
    } finally {
      if (generationRef.current === generation) setBusy(false);
    }
  }, [messagesRoot]);

  const replace = useCallback(async (next: AttachmentBookmark[], createIfMissing = true) => {
    const previous = bookmarksRef.current;
    bookmarksRef.current = next;
    setBookmarks(next);
    try {
      await persist(next, createIfMissing);
    } catch (writeError) {
      if (bookmarksRef.current === next) {
        bookmarksRef.current = previous;
        setBookmarks(previous);
      }
      throw writeError;
    }
  }, [persist]);

  const isBookmarked = useCallback((entry: ChatListEntry, item: SelectableItem) => {
    const id = getBookmarkItemId(entry, item);
    return bookmarksRef.current.some(bookmark => bookmark.id === id);
  }, []);

  const toggle = useCallback(async (entry: ChatListEntry, item: SelectableItem) => {
    await readyRef.current;
    const id = getBookmarkItemId(entry, item);
    const current = bookmarksRef.current;
    const existing = current.some(bookmark => bookmark.id === id);
    const next = existing
      ? current.filter(bookmark => bookmark.id !== id)
      : [...current, createBookmark(entry, item)];
    await replace(next);
  }, [replace]);

  const setMany = useCallback(async (
    entry: ChatListEntry,
    items: SelectableItem[],
    bookmarked: boolean
  ) => {
    await readyRef.current;
    const ids = new Set(items.map(item => getBookmarkItemId(entry, item)));
    const current = bookmarksRef.current;
    const next = bookmarked
      ? [
          ...current,
          ...items
            .filter(item => !current.some(bookmark => bookmark.id === getBookmarkItemId(entry, item)))
            .map(item => createBookmark(entry, item)),
        ]
      : current.filter(bookmark => !ids.has(bookmark.id));
    if (next.length === current.length) return;
    await replace(next);
  }, [replace]);

  const removeForChats = useCallback(async (entries: ChatListEntry[]) => {
    await readyRef.current;
    const current = bookmarksRef.current;
    const next = removeBookmarksForChats(current, entries);
    if (next.length === current.length) return;
    await replace(next, false);
  }, [replace]);

  return {
    bookmarks,
    busy,
    error,
    clearError: () => setError(null),
    isBookmarked,
    toggle,
    setMany,
    removeForChats,
  };
}

export type AttachmentBookmarksController = ReturnType<typeof useAttachmentBookmarks>;
