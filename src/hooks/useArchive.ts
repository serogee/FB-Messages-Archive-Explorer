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
  buildMessengerExportDeletionPlan,
  buildMessengerExportReferenceIndex,
  computeMessengerExportChatSize,
  computeMessengerExportChatSizeFromIndex,
  deleteMessengerExportJsonOnly,
  executeMessengerExportDeletionPlan,
  getMessengerExportBatchDeletionInfo,
  getMessengerExportDeletionInfo,
  getMessengerMediaBasename,
  isMessengerExport,
  listMessengerExportChatsIndexed,
  MessengerExportIndexIncompleteError,
  type MessengerExportChatIndex,
  type MessengerExportDeletionInfo,
  type MessengerExportReferenceIndex,
} from '../services/messengerExport';
import { SizeWorkLifecycle } from '../services/sizeWorkLifecycle';
import { mapWithConcurrency } from '../services/concurrency';
import type { BatchDeleteResult, DeleteProgress } from '../types/deletion';

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

export async function computeFacebookDeleteInfo(
  entries: ChatListEntry[],
  signal?: AbortSignal,
  concurrency = 4
): Promise<MessengerExportDeletionInfo> {
  const infos = await mapWithConcurrency(
    entries,
    concurrency,
    entry => computeFacebookEntryDeleteInfo(entry, signal),
    signal
  );
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

type SizeWorkPlan =
  | {
      kind: 'messenger';
      rootHandle: ReadableDirectoryHandle;
      generation: number;
      chatIndex: MessengerExportChatIndex;
    }
  | {
      kind: 'facebook';
      rootHandle: ReadableDirectoryHandle;
      generation: number;
    };

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
  suspendSizeWork: () => Promise<void>;
  resumeSizeWork: () => void;
  deleteChat: (entry: ChatListEntry) => Promise<void>;
  deleteChats: (entries: ChatListEntry[], onProgress?: (progress: DeleteProgress) => void) => Promise<BatchDeleteResult>;
  deleteMessengerChatsJsonOnly: (entries: ChatListEntry[], onProgress?: (progress: DeleteProgress) => void) => Promise<BatchDeleteResult>;
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
  const sizeWorkLifecycleRef = useRef(new SizeWorkLifecycle());
  const sizeWorkPlanRef = useRef<SizeWorkPlan | null>(null);
  const deletedSizeEntryKeysRef = useRef<Set<string>>(new Set());
  const deletionOperationRef = useRef<symbol | null>(null);

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

  const trackActiveSizeWork = useCallback(<T,>(promise: Promise<T>): Promise<T> => {
    return sizeWorkLifecycleRef.current.track(promise);
  }, []);

  const suspendSizeWork = useCallback(async (): Promise<void> => {
    await sizeWorkLifecycleRef.current.suspend();
    sizeComputationPromisesRef.current.clear();
  }, []);

  const startLazySizeComputation = useCallback((
    entries: ChatListEntry[],
    setList: React.Dispatch<React.SetStateAction<ChatListEntry[]>>,
    onProgress?: (done: number) => void,
    signal: AbortSignal = sizeWorkLifecycleRef.current.signal,
    computeSize: (entry: ChatListEntry, signal: AbortSignal) => Promise<number> =
      (entry, workSignal) => computeFolderSize(entry.dirHandle, workSignal)
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
        try {
          const currentEntry = getCurrentEntry(entry);
          const key = getSizeEntryKey(entry);
          if (!currentEntry
            || deletedSizeEntryKeysRef.current.has(key)
            || hasCompleteSize(currentEntry)) {
            done++;
            scheduleFlush(done >= entries.length);
            processNext(index + 1);
            return;
          }

          let sizePromise = sizeComputationPromisesRef.current.get(key);
          if (!sizePromise) {
            sizePromise = trackActiveSizeWork(computeSize(currentEntry, signal));
            sizeComputationPromisesRef.current.set(key, sizePromise);
            const ownedPromise = sizePromise;
            void ownedPromise.finally(() => {
              if (sizeComputationPromisesRef.current.get(key) === ownedPromise) {
                sizeComputationPromisesRef.current.delete(key);
              }
            }).catch(() => {});
          }

          const size = await sizePromise;
          throwIfAborted(signal);
          pendingSizes.set(entry._jsonFileName || entry.folderName, size);
        } catch { /* Folder size is optional metadata; failure must not hide the conversation. */ }
        if (signal.aborted) return;
        done++;
        scheduleFlush(done >= entries.length);
        processNext(index + 1);
      }, 0);
    };
    processNext(0);
  }, [getCurrentEntry, getSizeEntryKey, hasCompleteSize, trackActiveSizeWork]);

  const startBackgroundSizeWork = useCallback(() => {
    const plan = sizeWorkPlanRef.current;
    const lifecycle = sizeWorkLifecycleRef.current;
    const signal = lifecycle.signal;
    if (!plan
      || lifecycle.suspended
      || signal.aborted
      || archiveGenerationRef.current !== plan.generation) {
      return;
    }

    const isPending = (entry: ChatListEntry) => (
      !deletedSizeEntryKeysRef.current.has(getSizeEntryKey(entry)) && !hasCompleteSize(entry)
    );

    if (plan.kind === 'messenger') {
      const entries = inboxListRef.current.filter(isPending);
      if (entries.length === 0) {
        setSizeProgress(null);
        return;
      }

      setSizeProgress({ done: 0, total: entries.length });
      const mediaSizePromise = trackActiveSizeWork(getMessengerMediaSizeIndexForRoot(
        plan.rootHandle,
        plan.generation,
        signal
      ));
      void mediaSizePromise.then(mediaSizeIndex => {
        throwIfAborted(signal);
        if (sizeWorkLifecycleRef.current.signal !== signal
          || archiveGenerationRef.current !== plan.generation) {
          return;
        }

        startLazySizeComputation(
          entries,
          setInboxList,
          done => {
            if (signal.aborted) return;
            if (done === entries.length) {
              setSizeProgress(null);
            } else {
              setSizeProgress({ done, total: entries.length });
            }
          },
          signal,
          async entry => computeMessengerExportChatSizeFromIndex(
            entry._jsonFileName!,
            plan.chatIndex,
            mediaSizeIndex
          )
        );
      }).catch(error => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          console.error('Failed to build Messenger media size index:', error);
          if (archiveGenerationRef.current === plan.generation) setSizeProgress(null);
        }
      });
      return;
    }

    const lanes = [
      { entries: inboxListRef.current.filter(isPending), setList: setInboxList },
      { entries: archivedListRef.current.filter(isPending), setList: setArchivedList },
      { entries: requestsListRef.current.filter(isPending), setList: setRequestsList },
    ];
    const progress = lanes.map(lane => ({ done: 0, total: lane.entries.length }));
    const total = progress.reduce((sum, item) => sum + item.total, 0);
    if (total === 0) {
      setSizeProgress(null);
      return;
    }
    setSizeProgress({ done: 0, total });

    const updateProgress = (index: number, done: number) => {
      if (signal.aborted) return;
      progress[index].done = done;
      const totalDone = progress.reduce((sum, item) => sum + item.done, 0);
      if (totalDone === total) {
        setSizeProgress(null);
      } else {
        setSizeProgress({ done: totalDone, total });
      }
    };

    lanes.forEach((lane, index) => {
      startLazySizeComputation(
        lane.entries,
        lane.setList,
        done => updateProgress(index, done),
        signal
      );
    });
  }, [
    getMessengerMediaSizeIndexForRoot,
    getSizeEntryKey,
    hasCompleteSize,
    startLazySizeComputation,
    trackActiveSizeWork,
  ]);

  const resumeSizeWork = useCallback(() => {
    if (!sizeWorkLifecycleRef.current.resume()) return;
    startBackgroundSizeWork();
  }, [startBackgroundSizeWork]);

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
      inboxListRef.current = [];
      archivedListRef.current = [];
      requestsListRef.current = [];
      setRootHandle(null);
      setOriginalRootHandle(null);
      isMessengerExportRef.current = false;
      messengerChatIndexRef.current = null;
      messengerReferenceIndexRef.current = null;
      messengerReferenceIndexPromiseRef.current = null;
      messengerMediaSizeIndexRef.current = null;
      messengerMediaSizeIndexPromiseRef.current = null;
      sizeWorkLifecycleRef.current.reset();
      sizeWorkPlanRef.current = null;
      deletedSizeEntryKeysRef.current.clear();
      sizeComputationPromisesRef.current.clear();
      
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

        inboxListRef.current = inbox;
        archivedListRef.current = [];
        requestsListRef.current = [];
        setInboxList(inbox);
        setArchivedList([]);
        setRequestsList([]);
        sizeWorkPlanRef.current = { kind: 'messenger', rootHandle: handle, generation, chatIndex };
        startBackgroundSizeWork();
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
      inboxListRef.current = mergedInbox;
      archivedListRef.current = archived;
      requestsListRef.current = requests;
      setInboxList(mergedInbox);
      setArchivedList(archived);
      setRequestsList(requests);
      sizeWorkPlanRef.current = { kind: 'facebook', rootHandle: messagesRoot, generation };
      startBackgroundSizeWork();
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
  }, [startBackgroundSizeWork]);

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

  const beginDeletionOperation = useCallback((): symbol => {
    if (deletionOperationRef.current) throw new Error('A deletion operation is already in progress.');
    const token = Symbol('deletion-operation');
    deletionOperationRef.current = token;
    return token;
  }, []);

  const finishDeletionOperation = useCallback((token: symbol) => {
    if (deletionOperationRef.current === token) deletionOperationRef.current = null;
  }, []);

  const removeDeletedEntriesFromLists = useCallback((entries: readonly ChatListEntry[]) => {
    const deletedKeys = new Set(entries.map(getSizeEntryKey));
    const wasDeleted = (entry: ChatListEntry) => deletedKeys.has(getSizeEntryKey(entry));
    for (const entry of entries) deletedSizeEntryKeysRef.current.add(getSizeEntryKey(entry));
    setInboxList(prev => prev.filter(entry => !wasDeleted(entry)));
    setRequestsList(prev => prev.filter(entry => !wasDeleted(entry)));
    setArchivedList(prev => prev.filter(entry => !wasDeleted(entry)));
  }, [getSizeEntryKey]);

  const deleteChats = useCallback(async (
    entries: ChatListEntry[],
    onProgress?: (progress: DeleteProgress) => void
  ): Promise<BatchDeleteResult> => {
    const operationToken = beginDeletionOperation();
    try {
      if (!rootHandle) throw new Error('No folder open');
      if (!isWritableDirectoryHandle(rootHandle)) throw new Error('Deletion is not supported for this folder');
      const generation = archiveGenerationRef.current;
      const result: BatchDeleteResult = { requested: entries.length, deleted: [], failed: [] };
      const messengerEntries = entries.filter(entry => entry._messengerExport);

      if (messengerEntries.length > 0) {
        if (messengerEntries.length !== entries.length) {
          throw new Error('Facebook and Messenger chats cannot be deleted in one operation.');
        }
        const { index: referenceIndex, chatIndex } = await getMessengerReferenceIndex();
        const deletionIndex = chatIndex || referenceIndex;
        const mediaSizeCache = messengerMediaSizeIndexRef.current;
        const mediaSizeIndex = mediaSizeCache
          && mediaSizeCache.rootHandle === rootHandle
          && mediaSizeCache.generation === generation
          ? mediaSizeCache.mediaSizeIndex
          : undefined;
        const plan = buildMessengerExportDeletionPlan(entries, deletionIndex, mediaSizeIndex);
        const deletionResult = await executeMessengerExportDeletionPlan(
          rootHandle,
          plan,
          deletionIndex,
          progress => onProgress?.({
            stage: progress.stage,
            done: progress.done,
            total: progress.total,
          })
        );

        for (const chatResult of deletionResult.chats) {
          for (const media of chatResult.completedMedia) {
            mediaSizeIndex?.delete(media.identity);
            mediaSizeIndex?.delete(getMessengerMediaBasename(media.identity));
          }
          if (chatResult.deleted) {
            result.deleted.push(chatResult.entry);
          } else {
            result.failed.push({
              entry: chatResult.entry,
              error: chatResult.error || new Error('Messenger chat deletion failed.'),
              partial: chatResult.partial,
            });
          }
        }
      } else {
        for (let index = 0; index < entries.length; index++) {
          const entry = entries[index];
          const subfolderName =
            entry.source === 'inbox'    ? 'inbox' :
            entry.source === 'requests' ? 'message_requests' :
            entry.source === 'e2ee'     ? 'e2ee_cutover' :
            'archived_threads';
          try {
            await deleteChatFs(rootHandle, subfolderName, entry.folderName);
            result.deleted.push(entry);
          } catch (error) {
            console.error(`Failed to delete ${entry.folderName}`, error);
            result.failed.push({ entry, error, partial: false });
          }
          onProgress?.({ stage: 'chat', done: index + 1, total: entries.length });
        }
      }

      if (archiveGenerationRef.current === generation) {
        removeDeletedEntriesFromLists(result.deleted);
      }
      return result;
    } finally {
      finishDeletionOperation(operationToken);
    }
  }, [
    beginDeletionOperation,
    finishDeletionOperation,
    getMessengerReferenceIndex,
    removeDeletedEntriesFromLists,
    rootHandle,
  ]);

  const deleteChat = useCallback(async (entry: ChatListEntry): Promise<void> => {
    const result = await deleteChats([entry]);
    const failure = result.failed[0];
    if (failure) throw failure.error;
  }, [deleteChats]);

  const deleteMessengerChatsJsonOnly = useCallback(async (
    entries: ChatListEntry[],
    onProgress?: (progress: DeleteProgress) => void
  ): Promise<BatchDeleteResult> => {
    const operationToken = beginDeletionOperation();
    try {
      if (!rootHandle) throw new Error('No folder open');
      if (!isWritableDirectoryHandle(rootHandle)) throw new Error('Deletion is not supported for this folder');
      if (entries.some(entry => !entry._messengerExport)) {
        throw new Error('JSON-only deletion is available only for Messenger exports.');
      }
      const generation = archiveGenerationRef.current;
      const { index: referenceIndex, chatIndex } = await getMessengerReferenceIndex();
      const deletionIndex = chatIndex || referenceIndex;
      const chatResults = await deleteMessengerExportJsonOnly(
        rootHandle,
        entries,
        deletionIndex,
        (done, total) => onProgress?.({ stage: 'chat', done, total })
      );
      const result: BatchDeleteResult = {
        requested: entries.length,
        deleted: chatResults.filter(chat => chat.deleted).map(chat => chat.entry),
        failed: chatResults
          .filter(chat => !chat.deleted)
          .map(chat => ({
            entry: chat.entry,
            error: chat.error || new Error('Messenger chat JSON deletion failed.'),
            partial: false,
          })),
      };
      if (archiveGenerationRef.current === generation) {
        removeDeletedEntriesFromLists(result.deleted);
      }
      return result;
    } finally {
      finishDeletionOperation(operationToken);
    }
  }, [
    beginDeletionOperation,
    finishDeletionOperation,
    getMessengerReferenceIndex,
    removeDeletedEntriesFromLists,
    rootHandle,
  ]);

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
    const workSignal = sizeWorkLifecycleRef.current.signal;
    let sizePromise = sizeComputationPromisesRef.current.get(key);
    if (!sizePromise) {
      if (sizeWorkLifecycleRef.current.suspended) throw new DOMException('Aborted', 'AbortError');
      const signal = sizeWorkLifecycleRef.current.signal;
      sizePromise = trackActiveSizeWork((async () => {
        if (entry._messengerExport) {
          if (!rootHandle) throw new Error('No folder open');
          const mediaSizeIndex = await getMessengerMediaSizeIndexForRoot(
            rootHandle,
            archiveGenerationRef.current,
            signal
          );
          throwIfAborted(signal);
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
          return computeMessengerExportChatSize(
            entry.dirHandle,
            entry._jsonFileName!,
            mediaSizeIndex,
            signal
          );
        }
        return computeFolderSize(entry.dirHandle, signal);
      })());
      sizeComputationPromisesRef.current.set(key, sizePromise);
    }

    try {
      const size = await sizePromise;
      throwIfAborted(workSignal);
      updateFolderSize(entry, size, entry._messengerExport ? true : undefined);
      return size;
    } finally {
      if (sizeComputationPromisesRef.current.get(key) === sizePromise) {
        sizeComputationPromisesRef.current.delete(key);
      }
    }
  }, [
    getCurrentEntry,
    getMessengerMediaSizeIndexForRoot,
    getSizeEntryKey,
    hasCompleteSize,
    rootHandle,
    trackActiveSizeWork,
    updateFolderSize,
  ]);

  return {
    rootHandle, originalRootHandle, inboxList, archivedList, requestsList,    loading, loadProgress, sizeProgress, error,
    openFolder, openFolderWithWriteAccess, getDeleteInfo, computeAndUpdateFolderSize, suspendSizeWork, resumeSizeWork, deleteChat, deleteChats, deleteMessengerChatsJsonOnly, updateFolderSize,
  };
}
