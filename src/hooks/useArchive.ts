import { useState, useCallback, useRef } from 'react';
import type { ChatListEntry } from '../types/messenger';
import type { ReadableDirectoryHandle } from '../types/fileSystem';
import { isWritableDirectoryHandle } from '../types/fileSystem';
import {
  pickMessagesFolder,
  pickFolderWithWriteAccess,
  listChatFolders,
  computeFolderSize,
  deleteChat as deleteChatFs,
  resolveFacebookMessagesRoot,
} from '../services/fileSystem';
import {
  buildMessengerExportMediaSizeIndex,
  buildMessengerExportReferenceIndex,
  computeMessengerExportChatSize,
  computeMessengerExportChatSizeFromIndex,
  deleteMessengerExportChat,
  getMessengerExportBatchDeletionInfo,
  getMessengerExportDeletionInfo,
  isMessengerExport,
  listMessengerExportChatsIndexed,
  MessengerExportIndexIncompleteError,
  type MessengerExportChatIndex,
  type MessengerExportDeletionInfo,
  type MessengerExportReferenceIndex,
} from '../services/messengerExport';

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

function waitForPromiseWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}

async function computeFacebookEntryDeleteInfo(entry: ChatListEntry, signal?: AbortSignal): Promise<MessengerExportDeletionInfo> {
  let jsonSize = 0;
  let chatFileCount = 0;
  let mediaSize = 0;
  let mediaCount = 0;

  const scan = async (dirHandle: ReadableDirectoryHandle) => {
    throwIfAborted(signal);
    for await (const [name, child] of dirHandle.entries()) {
      throwIfAborted(signal);
      if (child.kind === 'file') {
        try {
          const file = await child.getFile();
          throwIfAborted(signal);
          if (/\.json$/i.test(name)) {
            jsonSize += file.size;
            chatFileCount++;
          } else {
            mediaSize += file.size;
            mediaCount++;
          }
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') throw error;
          /* Unreadable files are omitted from the estimate; deletion still targets the entire folder. */
        }
      } else if (child.kind === 'directory') {
        await scan(child);
      }
    }
  };

  await scan(entry.dirHandle);

  return {
    jsonSize,
    chatFileCount,
    mediaSize,
    totalSize: jsonSize + mediaSize,
    exclusiveMediaFiles: [],
    exclusiveMediaCount: mediaCount,
    sharedMediaCount: 0,
  };
}

async function computeFacebookDeleteInfo(entries: ChatListEntry[], signal?: AbortSignal): Promise<MessengerExportDeletionInfo> {
  const infos = await Promise.all(entries.map(entry => computeFacebookEntryDeleteInfo(entry, signal)));
  throwIfAborted(signal);
  return infos.reduce<MessengerExportDeletionInfo>((acc, info) => ({
    jsonSize: acc.jsonSize + info.jsonSize,
    chatFileCount: acc.chatFileCount + info.chatFileCount,
    mediaSize: acc.mediaSize + info.mediaSize,
    totalSize: acc.totalSize + info.totalSize,
    exclusiveMediaFiles: [],
    exclusiveMediaCount: acc.exclusiveMediaCount + info.exclusiveMediaCount,
    sharedMediaCount: 0,
  }), {
    jsonSize: 0,
    chatFileCount: 0,
    mediaSize: 0,
    totalSize: 0,
    exclusiveMediaFiles: [],
    exclusiveMediaCount: 0,
    sharedMediaCount: 0,
  });
}

export function useArchive(): {
  rootHandle: ReadableDirectoryHandle | null;
  originalRootHandle: ReadableDirectoryHandle | null;

  inboxList: ChatListEntry[];
  archivedList: ChatListEntry[];
  requestsList: ChatListEntry[];
  loading: boolean;
  loadProgress: { done: number; total: number } | null;
  sizeProgress: { done: number; total: number } | null;
  error: string | null;
  openFolder: (requestWrite?: boolean, onFolderPicked?: () => void) => Promise<boolean>;
  openFolderWithWriteAccess: () => Promise<void>;
  getDeleteInfo: (entry: ChatListEntry | ChatListEntry[], signal?: AbortSignal) => Promise<MessengerExportDeletionInfo>;
  computeAndUpdateFolderSize: (entry: ChatListEntry) => Promise<number>;
  setSizeQueuePaused: (paused: boolean) => void;
  deleteChat: (entry: ChatListEntry) => Promise<void>;
  deleteChats: (entries: ChatListEntry[], onProgress?: (done: number, total: number) => void) => Promise<ChatListEntry[]>;
  updateFolderSize: (entry: ChatListEntry, size: number, sizeIncludesMedia?: boolean) => void;
} {
  const [rootHandle, setRootHandle] = useState<ReadableDirectoryHandle | null>(null);
  const [originalRootHandle, setOriginalRootHandle] = useState<ReadableDirectoryHandle | null>(null);
  const [inboxList, setInboxList] = useState<ChatListEntry[]>([]);
  const [archivedList, setArchivedList] = useState<ChatListEntry[]>([]);
  const [requestsList, setRequestsList] = useState<ChatListEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState<{ done: number; total: number } | null>(null);
  const [sizeProgress, setSizeProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const archiveGenerationRef = useRef(0);
  const isMessengerExportRef = useRef(false);
  const messengerChatIndexRef = useRef<{
    rootHandle: ReadableDirectoryHandle;
    generation: number;
    chatIndex: MessengerExportChatIndex;
  } | null>(null);
  const messengerReferenceIndexRef = useRef<{
    rootHandle: ReadableDirectoryHandle;
    generation: number;
    index: MessengerExportReferenceIndex;
  } | null>(null);
  const messengerReferenceIndexPromiseRef = useRef<{
    rootHandle: ReadableDirectoryHandle;
    generation: number;
    promise: Promise<MessengerExportReferenceIndex>;
  } | null>(null);
  const messengerMediaSizeIndexRef = useRef<{
    rootHandle: ReadableDirectoryHandle;
    generation: number;
    mediaSizeIndex: Map<string, number>;
  } | null>(null);
  const messengerMediaSizeIndexPromiseRef = useRef<{
    rootHandle: ReadableDirectoryHandle;
    generation: number;
    promise: Promise<Map<string, number>>;
  } | null>(null);
  const sizeComputationPromisesRef = useRef<Map<string, Promise<number>>>(new Map());
  const sizeQueuePausedRef = useRef(false);
  const sizeQueuePauseCountRef = useRef(0);
  const sizeQueueResumeWaitersRef = useRef<Set<() => void>>(new Set());

  const inboxListRef = useRef<ChatListEntry[]>([]);
  const archivedListRef = useRef<ChatListEntry[]>([]);
  const requestsListRef = useRef<ChatListEntry[]>([]);
  inboxListRef.current = inboxList;
  archivedListRef.current = archivedList;
  requestsListRef.current = requestsList;

  const getMessengerMediaSizeIndexForRoot = useCallback((
    handle: ReadableDirectoryHandle,
    generation: number,
    buildSignal?: AbortSignal,
    waitSignal?: AbortSignal
  ): Promise<Map<string, number>> => {
    const cached = messengerMediaSizeIndexRef.current;
    if (cached && cached.rootHandle === handle && cached.generation === generation) {
      return waitForPromiseWithAbort(Promise.resolve(cached.mediaSizeIndex), waitSignal);
    }

    const pending = messengerMediaSizeIndexPromiseRef.current;
    if (pending && pending.rootHandle === handle && pending.generation === generation) {
      return waitForPromiseWithAbort(pending.promise, waitSignal);
    }

    const promise = (async () => {
      const mediaSizeIndex = await buildMessengerExportMediaSizeIndex(handle, buildSignal);
      throwIfAborted(buildSignal);
      if (archiveGenerationRef.current === generation) {
        messengerMediaSizeIndexRef.current = { rootHandle: handle, generation, mediaSizeIndex };
      }
      return mediaSizeIndex;
    })();
    const record = { rootHandle: handle, generation, promise };
    messengerMediaSizeIndexPromiseRef.current = record;
    void promise.finally(() => {
      if (messengerMediaSizeIndexPromiseRef.current === record) {
        messengerMediaSizeIndexPromiseRef.current = null;
      }
    }).catch(() => {});
    return waitForPromiseWithAbort(promise, waitSignal);
  }, []);

  const getSizeEntryKey = useCallback((entry: ChatListEntry): string => {
    return `${entry.source}:${entry.folderName}:${entry._jsonFileName || ''}`;
  }, []);

  const getCurrentEntry = useCallback((entry: ChatListEntry): ChatListEntry | null => {
    const key = getSizeEntryKey(entry);
    return [...inboxListRef.current, ...archivedListRef.current, ...requestsListRef.current]
      .find(candidate => getSizeEntryKey(candidate) === key) || null;
  }, [getSizeEntryKey]);

  const hasCompleteSize = useCallback((entry: ChatListEntry): boolean => {
    return entry.folderSize > 0 && (!entry._messengerExport || !!entry._sizeIncludesMedia);
  }, []);

  const waitForSizeQueueResume = useCallback(async (signal?: AbortSignal): Promise<void> => {
    while (sizeQueuePausedRef.current && !signal?.aborted) {
      await new Promise<void>(resolve => {
        sizeQueueResumeWaitersRef.current.add(resolve);
      });
    }
  }, []);

  const resumeSizeQueue = useCallback(() => {
    sizeQueuePausedRef.current = false;
    if (sizeQueueResumeWaitersRef.current.size > 0) {
      const waiters = Array.from(sizeQueueResumeWaitersRef.current);
      sizeQueueResumeWaitersRef.current.clear();
      waiters.forEach(resolve => resolve());
    }
  }, []);

  const setSizeQueuePaused = useCallback((paused: boolean) => {
    if (paused) {
      sizeQueuePauseCountRef.current++;
    } else {
      sizeQueuePauseCountRef.current = Math.max(0, sizeQueuePauseCountRef.current - 1);
    }

    if (sizeQueuePauseCountRef.current > 0) {
      sizeQueuePausedRef.current = true;
      return;
    }

    resumeSizeQueue();
  }, [resumeSizeQueue]);

  const startLazySizeComputation = useCallback((
    entries: ChatListEntry[],
    setList: React.Dispatch<React.SetStateAction<ChatListEntry[]>>,
    onProgress?: (done: number) => void,
    signal?: AbortSignal,
    computeSize: (entry: ChatListEntry) => Promise<number> = entry => computeFolderSize(entry.dirHandle)
  ) => {
    let done = 0;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const pendingSizes = new Map<string, number>();

    if (entries.length === 0 && onProgress) {
      onProgress(0);
      return;
    }

    const flushUpdates = () => {
      flushTimer = null;
      if (signal?.aborted) return;

      const updates = new Map(pendingSizes);
      pendingSizes.clear();

      if (updates.size > 0) {
        setList(prev =>
          prev.map(e => {
            const size = updates.get(e._jsonFileName || e.folderName);
            return size == null ? e : { ...e, folderSize: size, _sizeIncludesMedia: e._messengerExport ? true : e._sizeIncludesMedia };
          })
        );
      }

      if (onProgress) onProgress(done);
    };

    const scheduleFlush = (immediate = false) => {
      if (flushTimer) {
        if (!immediate) return;
        clearTimeout(flushTimer);
        flushTimer = null;
      }

      if (immediate || pendingSizes.size >= 20 || done >= entries.length) {
        flushUpdates();
      } else {
        flushTimer = setTimeout(flushUpdates, 500);
      }
    };

    signal?.addEventListener('abort', () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      pendingSizes.clear();
    }, { once: true });

    const processNext = (index: number) => {
      if (signal?.aborted) return;
      if (index >= entries.length) {
        scheduleFlush(true);
        return;
      }
      const entry = entries[index];
      setTimeout(async () => {
        if (signal?.aborted) return;
        await waitForSizeQueueResume(signal);
        if (signal?.aborted) return;
        try {
          const currentEntry = getCurrentEntry(entry);
          if (currentEntry && hasCompleteSize(currentEntry)) {
            done++;
            scheduleFlush(done >= entries.length);
            processNext(index + 1);
            return;
          }

          const key = getSizeEntryKey(entry);
          let sizePromise = sizeComputationPromisesRef.current.get(key);
          if (!sizePromise) {
            sizePromise = computeSize(entry);
            sizeComputationPromisesRef.current.set(key, sizePromise);
          }

          const size = await sizePromise;
          if (signal?.aborted) return;
          pendingSizes.set(entry._jsonFileName || entry.folderName, size);
        } catch { /* Folder size is optional metadata; failure must not hide the conversation. */ }
        finally {
          sizeComputationPromisesRef.current.delete(getSizeEntryKey(entry));
        }
        done++;
        scheduleFlush(done >= entries.length);
        processNext(index + 1);
      }, 0);
    };
    processNext(0);
  }, [getCurrentEntry, getSizeEntryKey, hasCompleteSize, waitForSizeQueueResume]);

  const openFolder = useCallback(async (requestWrite?: boolean, onFolderPicked?: () => void): Promise<boolean> => {
    let abortCtrl: AbortController | null = null;
    try {
      const handle = requestWrite ? await pickFolderWithWriteAccess() : await pickMessagesFolder();
      onFolderPicked?.();
      const generation = ++archiveGenerationRef.current;
      
      setError(null);
      setLoading(true);
      setLoadProgress({ done: 0, total: 0 });

      if (abortControllerRef.current) abortControllerRef.current.abort();
      abortCtrl = new AbortController();
      abortControllerRef.current = abortCtrl;
      
      setInboxList([]);
      setArchivedList([]);
      setRequestsList([]);
      setRootHandle(null);
      setOriginalRootHandle(null);
      isMessengerExportRef.current = false;
      messengerChatIndexRef.current = null;
      messengerReferenceIndexRef.current = null;
      messengerReferenceIndexPromiseRef.current = null;
      messengerMediaSizeIndexRef.current = null;
      messengerMediaSizeIndexPromiseRef.current = null;
      sizeComputationPromisesRef.current.clear();
      sizeQueuePauseCountRef.current = 0;
      resumeSizeQueue();
      
      const messagesRoot = await resolveFacebookMessagesRoot(handle);
      if (!messagesRoot) {
        const messengerExport = await isMessengerExport(handle);
        if (!messengerExport) {
          throw new Error("Could not find messages in this folder. Make sure you selected an extracted Facebook archive or Messenger export.");
        }

        isMessengerExportRef.current = true;
        setOriginalRootHandle(handle);
        setRootHandle(handle);

        const { entries: inbox, chatIndex } = await listMessengerExportChatsIndexed(
          handle,
          (done, total) => setLoadProgress({ done, total }),
          abortCtrl.signal
        );
        if (abortCtrl.signal.aborted) return false;

        messengerChatIndexRef.current = { rootHandle: handle, generation, chatIndex };
        messengerReferenceIndexRef.current = {
          rootHandle: handle,
          generation,
          index: chatIndex.referenceIndex,
        };

        setInboxList(inbox);
        setArchivedList([]);
        setRequestsList([]);

        if (inbox.length > 0) {
          setSizeProgress({ done: 0, total: inbox.length });
          const signal = abortCtrl.signal;
          void (async () => {
            const mediaSizeIndex = await getMessengerMediaSizeIndexForRoot(
              handle,
              generation,
              signal
            );
            if (signal.aborted) return;

            startLazySizeComputation(
              inbox,
              setInboxList,
              done => {
                if (done === inbox.length) {
                  setSizeProgress(null);
                } else {
                  setSizeProgress({ done, total: inbox.length });
                }
              },
              signal,
              async entry => computeMessengerExportChatSizeFromIndex(
                entry._jsonFileName!,
                chatIndex,
                mediaSizeIndex
              )
            );
          })().catch(error => {
            if (!(error instanceof DOMException && error.name === 'AbortError')) {
              console.error('Failed to build Messenger media size index:', error);
              if (archiveGenerationRef.current === generation) setSizeProgress(null);
            }
          });
        } else {
          setSizeProgress(null);
        }
        return true;
      }

      setOriginalRootHandle(handle);
      setRootHandle(messagesRoot);

      const progresses = [
        { done: 0, total: 0 },
        { done: 0, total: 0 },
        { done: 0, total: 0 },
        { done: 0, total: 0 }
      ];
      const updateProgress = (idx: number, done: number, total: number) => {
        progresses[idx] = { done, total };
        let sumDone = 0;
        let sumTotal = 0;
        for (const p of progresses) {
          sumDone += p.done;
          sumTotal += p.total;
        }
        setLoadProgress({ done: sumDone, total: sumTotal });
      };

      const [inbox, archived, requests, e2ee] = await Promise.all([
        listChatFolders(messagesRoot, 'inbox', 'inbox', (d, t) => updateProgress(0, d, t), abortCtrl.signal),
        listChatFolders(messagesRoot, 'archived_threads', 'archived', (d, t) => updateProgress(1, d, t), abortCtrl.signal),
        listChatFolders(messagesRoot, 'message_requests', 'requests', (d, t) => updateProgress(2, d, t), abortCtrl.signal),
        listChatFolders(messagesRoot, 'e2ee_cutover', 'e2ee', (d, t) => updateProgress(3, d, t), abortCtrl.signal),
      ]);
      if (abortCtrl.signal.aborted) return false;
      const mergedInbox = [...inbox, ...e2ee].sort((a, b) => {
        if (a.lastTimestamp == null && b.lastTimestamp == null) return 0;
        if (a.lastTimestamp == null) return 1;
        if (b.lastTimestamp == null) return -1;
        return b.lastTimestamp - a.lastTimestamp;
      });
      setInboxList(mergedInbox);
      setArchivedList(archived);
      setRequestsList(requests);
      
      const sizeProgresses = [
        { done: 0, total: mergedInbox.length },
        { done: 0, total: archived.length },
        { done: 0, total: requests.length }
      ];
      const totalSizeToCompute = mergedInbox.length + archived.length + requests.length;
      if (totalSizeToCompute > 0) {
        setSizeProgress({ done: 0, total: totalSizeToCompute });
      }

      const updateSizeProgress = (idx: number, done: number) => {
        sizeProgresses[idx].done = done;
        let sumDone = 0;
        let sumTotal = 0;
        for (const p of sizeProgresses) {
          sumDone += p.done;
          sumTotal += p.total;
        }
        if (sumDone === sumTotal) {
          setSizeProgress(null);
        } else {
          setSizeProgress({ done: sumDone, total: sumTotal });
        }
      };

      startLazySizeComputation(mergedInbox, setInboxList, (d) => updateSizeProgress(0, d), abortCtrl.signal);
      startLazySizeComputation(archived, setArchivedList, (d) => updateSizeProgress(1, d), abortCtrl.signal);
      startLazySizeComputation(requests, setRequestsList, (d) => updateSizeProgress(2, d), abortCtrl.signal);
      return true;
    } catch (e: unknown) {
      if (e instanceof Error && e.name !== 'AbortError') {
        setError(e.message || 'Failed to open folder');
        return true;
      }
      return false;
    } finally {
      if (abortControllerRef.current === abortCtrl) {
        setLoading(false);
        setLoadProgress(null);
      }
    }
  }, [getMessengerMediaSizeIndexForRoot, resumeSizeQueue, startLazySizeComputation]);

  const openFolderWithWriteAccess = useCallback(async () => {
    setError(null);
    try {
      const handle = await pickFolderWithWriteAccess();
      setRootHandle(handle);
    } catch (e: unknown) {
      if (e instanceof Error && e.name !== 'AbortError') {
        setError(e.message || 'Failed to get write access');
      }
    }
  }, []);

  const getMessengerMediaSizeIndex = useCallback(async (signal?: AbortSignal): Promise<Map<string, number>> => {
    if (!rootHandle) throw new Error('No folder open');
    return getMessengerMediaSizeIndexForRoot(
      rootHandle,
      archiveGenerationRef.current,
      abortControllerRef.current?.signal,
      signal
    );
  }, [getMessengerMediaSizeIndexForRoot, rootHandle]);

  const getMessengerReferenceIndex = useCallback(async (signal?: AbortSignal): Promise<{
    index: MessengerExportReferenceIndex;
    chatIndex?: MessengerExportChatIndex;
  }> => {
    if (!rootHandle) throw new Error('No folder open');
    const generation = archiveGenerationRef.current;
    const chatCached = messengerChatIndexRef.current;
    if (chatCached && chatCached.rootHandle === rootHandle && chatCached.generation === generation) {
      return {
        index: chatCached.chatIndex.referenceIndex,
        chatIndex: chatCached.chatIndex,
      };
    }

    const cached = messengerReferenceIndexRef.current;
    let index: MessengerExportReferenceIndex;
    if (cached && cached.rootHandle === rootHandle && cached.generation === generation) {
      index = cached.index;
    } else {
      const pending = messengerReferenceIndexPromiseRef.current;
      let promise: Promise<MessengerExportReferenceIndex>;
      if (pending && pending.rootHandle === rootHandle && pending.generation === generation) {
        promise = pending.promise;
      } else {
        const buildSignal = abortControllerRef.current?.signal;
        promise = (async () => {
          const builtIndex = await buildMessengerExportReferenceIndex(rootHandle, buildSignal);
          throwIfAborted(buildSignal);
          if (archiveGenerationRef.current === generation) {
            messengerReferenceIndexRef.current = { rootHandle, generation, index: builtIndex };
          }
          return builtIndex;
        })();
        const record = { rootHandle, generation, promise };
        messengerReferenceIndexPromiseRef.current = record;
        void promise.finally(() => {
          if (messengerReferenceIndexPromiseRef.current === record) {
            messengerReferenceIndexPromiseRef.current = null;
          }
        }).catch(() => {});
      }
      index = await waitForPromiseWithAbort(promise, signal);
    }

    return { index };
  }, [rootHandle]);

  const getDeleteInfo = useCallback(async (
    entry: ChatListEntry | ChatListEntry[],
    signal?: AbortSignal
  ): Promise<MessengerExportDeletionInfo> => {
    if (!rootHandle) throw new Error('No folder open');
    throwIfAborted(signal);
    const entries = Array.isArray(entry) ? entry : [entry];
    const messengerEntries = entries.filter(e => e._messengerExport);
    if (messengerEntries.length === 0) {
      return computeFacebookDeleteInfo(entries, signal);
    }

    const referenceResult = await getMessengerReferenceIndex(signal);
    const { index: referenceIndex, chatIndex } = referenceResult;
    if (!referenceIndex.complete) throw new MessengerExportIndexIncompleteError();
    const mediaSizeIndex = await getMessengerMediaSizeIndex(signal);
    const deletionIndex = chatIndex || referenceIndex;
    if (messengerEntries.length === 1 && !Array.isArray(entry)) {
      return getMessengerExportDeletionInfo(rootHandle, messengerEntries[0], deletionIndex, signal, mediaSizeIndex);
    }

    return getMessengerExportBatchDeletionInfo(rootHandle, messengerEntries, deletionIndex, signal, mediaSizeIndex);
  }, [getMessengerMediaSizeIndex, getMessengerReferenceIndex, rootHandle]);

  const deleteChat = useCallback(async (entry: ChatListEntry) => {
    if (!rootHandle) throw new Error('No folder open');
    if (!isWritableDirectoryHandle(rootHandle)) throw new Error('Deletion is not supported for this folder');
    const generation = archiveGenerationRef.current;
    if (entry._messengerExport) {
      const { index: referenceIndex, chatIndex } = await getMessengerReferenceIndex();
      const jsonFileName = entry._jsonFileName!;
      const removedMedia = Array.from(referenceIndex.chatMedia.get(jsonFileName) || [])
        .filter(identity => (referenceIndex.mediaOwners.get(identity)?.size || 0) <= 1);
      await deleteMessengerExportChat(rootHandle, entry, chatIndex || referenceIndex);
      const mediaSizeCache = messengerMediaSizeIndexRef.current;
      const mediaSizeIndex = mediaSizeCache
        && mediaSizeCache.rootHandle === rootHandle
        && mediaSizeCache.generation === generation
        && archiveGenerationRef.current === generation
        ? mediaSizeCache.mediaSizeIndex
        : undefined;
      for (const identity of removedMedia) mediaSizeIndex?.delete(identity);
      if (archiveGenerationRef.current !== generation) return;
      setInboxList(prev => prev.filter(e => e.folderName !== entry.folderName));
      return;
    }

    const subfolderName =
      entry.source === 'inbox'    ? 'inbox' :
      entry.source === 'requests' ? 'message_requests' :
      entry.source === 'e2ee'     ? 'e2ee_cutover' :
      'archived_threads';
    await deleteChatFs(rootHandle, subfolderName, entry.folderName);
    if (archiveGenerationRef.current !== generation) return;
    if (entry.source === 'inbox' || entry.source === 'e2ee') {
      setInboxList(prev => prev.filter(e => e.folderName !== entry.folderName));
    } else if (entry.source === 'requests') {
      setRequestsList(prev => prev.filter(e => e.folderName !== entry.folderName));
    } else {
      setArchivedList(prev => prev.filter(e => e.folderName !== entry.folderName));
    }
  }, [getMessengerReferenceIndex, rootHandle]);

  const deleteChats = useCallback(async (entries: ChatListEntry[], onProgress?: (done: number, total: number) => void) => {
    if (!rootHandle) throw new Error('No folder open');
    if (!isWritableDirectoryHandle(rootHandle)) throw new Error('Deletion is not supported for this folder');
    const generation = archiveGenerationRef.current;
    
    const deletedEntries: ChatListEntry[] = [];
    const messengerIndexes = entries.some(entry => entry._messengerExport)
      ? await getMessengerReferenceIndex()
      : null;
    
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry._messengerExport) {
        try {
          const referenceIndex = messengerIndexes!.index;
          const jsonFileName = entry._jsonFileName!;
          const removedMedia = Array.from(referenceIndex.chatMedia.get(jsonFileName) || [])
            .filter(identity => (referenceIndex.mediaOwners.get(identity)?.size || 0) <= 1);
          await deleteMessengerExportChat(
            rootHandle,
            entry,
            messengerIndexes!.chatIndex || referenceIndex
          );
          const mediaSizeCache = messengerMediaSizeIndexRef.current;
          const mediaSizeIndex = mediaSizeCache
            && mediaSizeCache.rootHandle === rootHandle
            && mediaSizeCache.generation === generation
            && archiveGenerationRef.current === generation
            ? mediaSizeCache.mediaSizeIndex
            : undefined;
          for (const identity of removedMedia) mediaSizeIndex?.delete(identity);
          deletedEntries.push(entry);
        } catch (err) {
          console.error(`Failed to delete ${entry.folderName}`, err);
        }
        if (onProgress) onProgress(i + 1, entries.length);
        continue;
      }

      const subfolderName =
        entry.source === 'inbox'    ? 'inbox' :
        entry.source === 'requests' ? 'message_requests' :
        entry.source === 'e2ee'     ? 'e2ee_cutover' :
        'archived_threads';
      try {
        await deleteChatFs(rootHandle, subfolderName, entry.folderName);
        deletedEntries.push(entry);
      } catch (err) {
        console.error(`Failed to delete ${entry.folderName}`, err);
      }
      if (onProgress) onProgress(i + 1, entries.length);
    }

    if (archiveGenerationRef.current !== generation) return deletedEntries;
    const deletedKeys = new Set(deletedEntries.map(entry => `${entry.source}:${entry.folderName}`));
    const wasDeleted = (entry: ChatListEntry) => deletedKeys.has(`${entry.source}:${entry.folderName}`);
    setInboxList(prev => prev.filter(e => !wasDeleted(e)));
    setRequestsList(prev => prev.filter(e => !wasDeleted(e)));
    setArchivedList(prev => prev.filter(e => !wasDeleted(e)));
    return deletedEntries;
  }, [getMessengerReferenceIndex, rootHandle]);

  const updateFolderSize = useCallback((entry: ChatListEntry, size: number, sizeIncludesMedia?: boolean) => {
    const applySize = (e: ChatListEntry) => e.folderName === entry.folderName
      ? {
          ...e,
          folderSize: size,
          _sizeIncludesMedia: entry._messengerExport ? (sizeIncludesMedia ?? true) : e._sizeIncludesMedia,
        }
      : e;

    if (entry.source === 'inbox' || entry.source === 'e2ee') {
      setInboxList(prev => prev.map(applySize));
    } else if (entry.source === 'requests') {
      setRequestsList(prev => prev.map(applySize));
    } else {
      setArchivedList(prev => prev.map(applySize));
    }
  }, []);

  const computeAndUpdateFolderSize = useCallback(async (entry: ChatListEntry): Promise<number> => {
    const currentEntry = getCurrentEntry(entry);
    if (currentEntry && hasCompleteSize(currentEntry)) {
      return currentEntry.folderSize;
    }

    const key = getSizeEntryKey(entry);
    let sizePromise = sizeComputationPromisesRef.current.get(key);
    if (!sizePromise) {
      sizePromise = (async () => {
        if (entry._messengerExport) {
          const mediaSizeIndex = await getMessengerMediaSizeIndex();
          const cached = messengerChatIndexRef.current;
          if (cached
            && cached.rootHandle === rootHandle
            && cached.generation === archiveGenerationRef.current
            && cached.chatIndex.jsonSizes.has(entry._jsonFileName!)) {
            return computeMessengerExportChatSizeFromIndex(
              entry._jsonFileName!,
              cached.chatIndex,
              mediaSizeIndex
            );
          }
          return computeMessengerExportChatSize(entry.dirHandle, entry._jsonFileName!, mediaSizeIndex);
        }
        return computeFolderSize(entry.dirHandle);
      })();
      sizeComputationPromisesRef.current.set(key, sizePromise);
    }

    try {
      const size = await sizePromise;
      updateFolderSize(entry, size, entry._messengerExport ? true : undefined);
      return size;
    } finally {
      if (sizeComputationPromisesRef.current.get(key) === sizePromise) {
        sizeComputationPromisesRef.current.delete(key);
      }
    }
  }, [getCurrentEntry, getMessengerMediaSizeIndex, getSizeEntryKey, hasCompleteSize, rootHandle, updateFolderSize]);

  return {
    rootHandle, originalRootHandle, inboxList, archivedList, requestsList,    loading, loadProgress, sizeProgress, error,
    openFolder, openFolderWithWriteAccess, getDeleteInfo, computeAndUpdateFolderSize, setSizeQueuePaused, deleteChat, deleteChats, updateFolderSize,
  };
}
