import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatListEntry, SelectableItem } from '../types/messenger';
import type { ReadableDirectoryHandle, WritableDirectoryHandle } from '../types/fileSystem';
import {
  createBookmark,
  getBookmarkChatId,
  getBookmarkItemId,
  invalidateBookmarksDirectoryPreparation,
  loadBookmarks,
  prepareBookmarksDirectory,
  removeBookmarkDataForChats,
  saveBookmarksToDirectory,
  setChatPins,
  type BookmarkData,
} from '../services/bookmarks';

const EMPTY_BOOKMARK_DATA: BookmarkData = { bookmarks: [], pinnedChats: [] };

export function useBookmarks(
  messagesRoot: ReadableDirectoryHandle | null,
  migrateLegacyDirectory = false
) {
  const [data, setData] = useState<BookmarkData>(EMPTY_BOOKMARK_DATA);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preparationFailed, setPreparationFailed] = useState(false);
  const dataRef = useRef<BookmarkData>(EMPTY_BOOKMARK_DATA);
  const fileExistsRef = useRef(false);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const readyRef = useRef<Promise<void>>(Promise.resolve());
  const generationRef = useRef(0);
  const pendingWritesRef = useRef(0);
  const preparedDirectoryRef = useRef<Promise<WritableDirectoryHandle> | null>(null);

  useEffect(() => {
    const generation = ++generationRef.current;
    dataRef.current = EMPTY_BOOKMARK_DATA;
    fileExistsRef.current = false;
    pendingWritesRef.current = 0;
    setData(EMPTY_BOOKMARK_DATA);
    setBusy(false);
    setError(null);
    setPreparationFailed(false);
    writeQueueRef.current = Promise.resolve();
    readyRef.current = Promise.resolve();
    preparedDirectoryRef.current = null;
    if (!messagesRoot) return;

    readyRef.current = (async () => {
      let migrationFailed = false;
      if (migrateLegacyDirectory) {
        const preparation = prepareBookmarksDirectory(messagesRoot as WritableDirectoryHandle);
        preparedDirectoryRef.current = preparation;
        try {
          await preparation;
        } catch (migrationError) {
          migrationFailed = true;
          console.error('Failed to migrate legacy bookmarks directory:', migrationError);
        }
      }
      const result = await loadBookmarks(messagesRoot);
        if (generationRef.current !== generation) return;
        const loaded = { bookmarks: result.bookmarks, pinnedChats: result.pinnedChats };
        dataRef.current = loaded;
        fileExistsRef.current = result.fileExists;
        setData(loaded);
        if (migrationFailed) {
          setPreparationFailed(true);
          setError('Could not migrate selected_messages to fb-mae.');
        }
      })()
      .catch(loadError => {
        if (generationRef.current !== generation) return;
        console.error('Failed to load bookmarks:', loadError);
        setError('Could not load bookmarks.');
      });
  }, [messagesRoot, migrateLegacyDirectory]);

  const persist = useCallback(async (next: BookmarkData, createIfMissing = true) => {
    if (!messagesRoot) throw new Error('No messages folder is open.');
    if (!createIfMissing && !fileExistsRef.current) return;
    const generation = generationRef.current;
    pendingWritesRef.current++;
    setBusy(true);
    setError(null);
    const write = writeQueueRef.current
      .catch(() => {})
      .then(async () => {
        if (generationRef.current !== generation) return;
        let preparation = preparedDirectoryRef.current;
        if (!preparation) {
          preparation = prepareBookmarksDirectory(messagesRoot as WritableDirectoryHandle);
          preparedDirectoryRef.current = preparation;
        }
        let directory: WritableDirectoryHandle;
        try {
          directory = await preparation;
        } catch (preparationError) {
          if (generationRef.current === generation) setPreparationFailed(true);
          throw preparationError;
        }
        await saveBookmarksToDirectory(directory, next);
        fileExistsRef.current = true;
      });
    writeQueueRef.current = write;
    try {
      await write;
    } catch (writeError) {
      console.error('Failed to save bookmarks:', writeError);
      if (generationRef.current === generation) {
        setError('Could not save bookmarks. Check folder write access.');
      }
      throw writeError;
    } finally {
      if (generationRef.current === generation) {
        pendingWritesRef.current = Math.max(0, pendingWritesRef.current - 1);
        setBusy(pendingWritesRef.current > 0);
      }
    }
  }, [messagesRoot]);

  const replace = useCallback(async (next: BookmarkData, createIfMissing = true) => {
    const previous = dataRef.current;
    dataRef.current = next;
    setData(next);
    try {
      await persist(next, createIfMissing);
    } catch (writeError) {
      if (dataRef.current === next) {
        dataRef.current = previous;
        setData(previous);
      }
      throw writeError;
    }
  }, [persist]);

  const isItemBookmarked = useCallback((entry: ChatListEntry, item: SelectableItem) => {
    const id = getBookmarkItemId(entry, item);
    return dataRef.current.bookmarks.some(bookmark => bookmark.id === id);
  }, []);

  const toggleItemBookmark = useCallback(async (entry: ChatListEntry, item: SelectableItem) => {
    await readyRef.current;
    const id = getBookmarkItemId(entry, item);
    const current = dataRef.current;
    const existing = current.bookmarks.some(bookmark => bookmark.id === id);
    const bookmarks = existing
      ? current.bookmarks.filter(bookmark => bookmark.id !== id)
      : [...current.bookmarks, createBookmark(entry, item)];
    await replace({ ...current, bookmarks });
  }, [replace]);

  const setItemBookmarks = useCallback(async (
    entry: ChatListEntry,
    items: SelectableItem[],
    bookmarked: boolean
  ) => {
    await readyRef.current;
    const ids = new Set(items.map(item => getBookmarkItemId(entry, item)));
    const current = dataRef.current;
    const bookmarks = bookmarked
      ? [
          ...current.bookmarks,
          ...items
            .filter(item => !current.bookmarks.some(bookmark => bookmark.id === getBookmarkItemId(entry, item)))
            .map(item => createBookmark(entry, item)),
        ]
      : current.bookmarks.filter(bookmark => !ids.has(bookmark.id));
    if (bookmarks.length === current.bookmarks.length) return;
    await replace({ ...current, bookmarks });
  }, [replace]);

  const isChatPinned = useCallback((entry: ChatListEntry) => {
    const id = getBookmarkChatId(entry);
    return dataRef.current.pinnedChats.some(pin => pin.id === id);
  }, []);

  const setChatsPinned = useCallback(async (entries: ChatListEntry[], pinned: boolean) => {
    await readyRef.current;
    const current = dataRef.current;
    const pinnedChats = setChatPins(current.pinnedChats, entries, pinned);
    if (pinnedChats === current.pinnedChats
      || (pinnedChats.length === current.pinnedChats.length
        && pinnedChats.every((pin, index) => pin === current.pinnedChats[index]))) return;
    await replace({ ...current, pinnedChats });
  }, [replace]);

  const toggleChatPin = useCallback(async (entry: ChatListEntry) => {
    await readyRef.current;
    const current = dataRef.current;
    const id = getBookmarkChatId(entry);
    const pinned = current.pinnedChats.some(pin => pin.id === id);
    const pinnedChats = setChatPins(current.pinnedChats, [entry], !pinned);
    await replace({ ...current, pinnedChats });
  }, [replace]);

  const removeForChats = useCallback(async (entries: ChatListEntry[]) => {
    await readyRef.current;
    const current = dataRef.current;
    const next = removeBookmarkDataForChats(current, entries);
    if (next.bookmarks.length === current.bookmarks.length
      && next.pinnedChats.length === current.pinnedChats.length) return;
    await replace(next, false);
  }, [replace]);

  const clearError = useCallback(() => setError(null), []);

  const retryPreparation = useCallback(async () => {
    if (!messagesRoot) return;
    const generation = generationRef.current;
    const writableRoot = messagesRoot as WritableDirectoryHandle;
    invalidateBookmarksDirectoryPreparation(writableRoot);
    const preparation = prepareBookmarksDirectory(writableRoot);
    preparedDirectoryRef.current = preparation;
    setBusy(true);
    setError(null);
    setPreparationFailed(false);
    try {
      await preparation;
      if (generationRef.current !== generation) return;
      const result = await loadBookmarks(messagesRoot);
      if (generationRef.current !== generation) return;
      const loaded = { bookmarks: result.bookmarks, pinnedChats: result.pinnedChats };
      dataRef.current = loaded;
      fileExistsRef.current = result.fileExists;
      setData(loaded);
    } catch (retryError) {
      console.error('Failed to prepare the bookmarks directory:', retryError);
      if (generationRef.current === generation) {
        setPreparationFailed(true);
        setError('Could not migrate selected_messages to fb-mae.');
      }
      throw retryError;
    } finally {
      if (generationRef.current === generation) setBusy(pendingWritesRef.current > 0);
    }
  }, [messagesRoot]);

  return {
    attachmentBookmarks: data.bookmarks,
    pinnedChats: data.pinnedChats,
    busy,
    error,
    preparationFailed,
    clearError,
    retryPreparation,
    isItemBookmarked,
    toggleItemBookmark,
    setItemBookmarks,
    isChatPinned,
    toggleChatPin,
    setChatsPinned,
    removeForChats,
  };
}

export type BookmarksController = ReturnType<typeof useBookmarks>;
