import { useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import type { ChatListEntry } from '../types/messenger';
import type { FolderAccessMode, ReadableDirectoryHandle } from '../types/fileSystem';
import { isWritableDirectoryHandle } from '../types/fileSystem';
import {
  pickMessagesFolder,
  pickFolderWithWriteAccess,
  listChatFolders,
  computeFolderSize,
  deleteChat as deleteChatFs,
  resolveFacebookMessagesRootInfo,
  isFileSystemAccessSupported,
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
  getMessengerExportDeletionOwnershipInfo,
  getMessengerMediaBasename,
  resolveMessengerExportRoot,
  listMessengerExportChatsIndexed,
  MessengerExportIndexIncompleteError,
  MessengerExportMediaSizeUnavailableError,
  type MessengerExportChatIndex,
  type MessengerExportSizeMetadata,
  type MessengerExportDeletionInfo,
  type MessengerExportReferenceIndex,
} from '../services/messengerExport';
import { SizeWorkLifecycle } from '../services/sizeWorkLifecycle';
import { mapWithConcurrency } from '../services/concurrency';
import { GenerationScopedAsyncCache } from '../services/generationScopedAsyncCache';
import { SingleFlightGuard } from '../services/singleFlight';
import { resolveArchivePerspective } from '../services/perspective';
import type { BatchDeleteResult, DeleteChatsOptions, DeleteInfoOptions, DeleteProgress } from '../types/deletion';
import { removeChatAttachmentReferences, type AttachmentReferenceIndex, type AttachmentReferenceScan } from '../services/attachmentReferenceIndex';
import {
  getFacebookChatId, getFacebookStickerDeletionTargets, removeFacebookStickers,
} from '../services/facebookStickerReferences';
import { buildMetaAttachmentReferenceIndex, type MetaAttachmentReferenceIndex } from '../services/metaAttachmentReferences';
import { buildMetaChatDeletionPlan, getMetaFolderDeletionBlock, MetaChatDeletionBlockedError } from '../services/metaChatDeletion';
import { CalculationProgressStore, followCalculationProgress, type CalculationProgress } from '../services/calculationProgress';
import type { MetaArchivePlatform } from '../services/metaAttachmentPaths';
import { getFolderUploadInfo } from '../services/polyfill';
import { FolderOpenDiagnostics, runFolderOperation } from '../services/folderOpenDiagnostics';

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

async function computeFacebookEntryDeleteInfo(entry: ChatListEntry, signal?: AbortSignal, onFileChecked?: () => void): Promise<MessengerExportDeletionInfo> {
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
        } finally {
          onFileChecked?.();
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
  concurrency = 4,
  onProgress?: (progress: CalculationProgress) => void
): Promise<MessengerExportDeletionInfo> {
  let doneChats = 0;
  let doneFiles = 0;
  const report = (finished = false) => onProgress?.({
    stage: 'sizes', label: 'Calculating chat sizes',
    done: entries.length > 1 ? doneChats : doneFiles,
    total: entries.length > 1 ? entries.length : finished ? doneFiles : undefined,
    unit: entries.length > 1 ? 'chats' : 'files',
    detail: entries.length > 1 ? `${doneFiles.toLocaleString()} files checked` : undefined,
  });
  report();
  const infos = await mapWithConcurrency(
    entries,
    concurrency,
    async entry => {
      const info = await computeFacebookEntryDeleteInfo(entry, signal, () => { doneFiles++; report(); });
      doneChats++;
      report();
      return info;
    },
    signal
  );
  throwIfAborted(signal);
  report(true);
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
      sizeMetadata: MessengerExportSizeMetadata;
    }
  | {
      kind: 'facebook';
      rootHandle: ReadableDirectoryHandle;
      generation: number;
    };

export function useArchive(deletionEnabled: boolean, debuggingEnabled = false): {
  rootHandle: ReadableDirectoryHandle | null;
  reactionSourceRevision: number;
  reactionMutationPending: boolean;
  standaloneMessenger: boolean;
  attachmentReferenceIndex: AttachmentReferenceIndex | null;
  attachmentReferenceIndexLoading: boolean;
  attachmentReferenceScan: AttachmentReferenceScan | null;
  originalRootHandle: ReadableDirectoryHandle | null;

  inboxList: ChatListEntry[];
  archivedList: ChatListEntry[];
  requestsList: ChatListEntry[];
  archivePerspectiveKey: string | null;
  archivePerspectiveName: string;
  loading: boolean;
  folderSelectionPending: boolean;
  folderPreparationProgress: { done: number; total: number } | null;
  loadProgress: { done: number; total: number } | null;
  sizeProgress: { done: number; total: number } | null;
  error: string | null;
  openFolder: (requestWrite?: boolean, onFolderPicked?: () => void, accessMode?: FolderAccessMode) => Promise<boolean>;
  openFolderWithWriteAccess: () => Promise<void>;
  getDeleteInfo: (
    entry: ChatListEntry | ChatListEntry[],
    signal?: AbortSignal,
    onOwnershipReady?: (info: MessengerExportDeletionInfo) => void,
    options?: DeleteInfoOptions
  ) => Promise<MessengerExportDeletionInfo>;
  computeAndUpdateFolderSize: (entry: ChatListEntry) => Promise<number>;
  suspendSizeWork: () => Promise<void>;
  resumeSizeWork: () => void;
  deleteChat: (entry: ChatListEntry) => Promise<void>;
  deleteChats: (entries: ChatListEntry[], onProgress?: (progress: DeleteProgress) => void, options?: DeleteChatsOptions) => Promise<BatchDeleteResult>;
  deleteMessengerChatsJsonOnly: (entries: ChatListEntry[], onProgress?: (progress: DeleteProgress) => void) => Promise<BatchDeleteResult>;
  updateFolderSize: (entry: ChatListEntry, size: number, sizeIncludesMedia?: boolean) => void;
} {
  const [reactionSourceRevision, setReactionSourceRevision] = useState(0);
  const [reactionMutationPending, setReactionMutationPending] = useState(false);
  const [attachmentReferenceIndex, setAttachmentReferenceIndex] = useState<AttachmentReferenceIndex | null>(null);
  const [attachmentReferenceIndexLoading, setAttachmentReferenceIndexLoading] = useState(false);
  const [attachmentReferenceScan, setAttachmentReferenceScan] = useState<AttachmentReferenceScan | null>(null);
  const [rootHandle, setRootHandle] = useState<ReadableDirectoryHandle | null>(null);
  const [originalRootHandle, setOriginalRootHandle] = useState<ReadableDirectoryHandle | null>(null);
  const [inboxList, setInboxList] = useState<ChatListEntry[]>([]);
  const [archivedList, setArchivedList] = useState<ChatListEntry[]>([]);
  const [requestsList, setRequestsList] = useState<ChatListEntry[]>([]);
  const [archivePerspectiveKey, setArchivePerspectiveKey] = useState<string | null>(null);
  const [archivePerspectiveName, setArchivePerspectiveName] = useState('');
  const [loading, setLoading] = useState(false);
  const [folderSelectionPending, setFolderSelectionPending] = useState(false);
  const [folderPreparationProgress, setFolderPreparationProgress] = useState<{ done: number; total: number } | null>(null);
  const [loadProgress, setLoadProgress] = useState<{ done: number; total: number } | null>(null);
  const [sizeProgress, setSizeProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState('');
  const abortControllerRef = useRef<AbortController | null>(null);
  const archiveGenerationRef = useRef(0);
  const folderPickerRequestRef = useRef(0);
  const ownershipRevisionRef = useRef(0);
  const ownershipAbortRef = useRef<AbortController | null>(null);
  const referenceProgressRef = useRef<CalculationProgressStore | null>(null);
  const messengerSizeProgressRef = useRef<CalculationProgressStore | null>(null);
  const isMessengerExportRef = useRef(false);
  const messengerChatIndexRef = useRef<{
    rootHandle: ReadableDirectoryHandle;
    generation: number;
    chatIndex: MessengerExportChatIndex;
  } | null>(null);
  const messengerReferenceIndexCacheRef = useRef(
    new GenerationScopedAsyncCache<ReadableDirectoryHandle, MessengerExportReferenceIndex>()
  );
  const messengerMediaSizeIndexCacheRef = useRef(
    new GenerationScopedAsyncCache<ReadableDirectoryHandle, Map<string, number>>()
  );
  const facebookReferenceIndexCacheRef = useRef(
    new GenerationScopedAsyncCache<ReadableDirectoryHandle, MetaAttachmentReferenceIndex>()
  );
  const metaArchivePlatformRef = useRef<MetaArchivePlatform>('unknown');
  const sizeComputationPromisesRef = useRef<Map<string, Promise<number>>>(new Map());
  const sizeWorkLifecycleRef = useRef(new SizeWorkLifecycle());
  const sizeWorkPlanRef = useRef<SizeWorkPlan | null>(null);
  const deletedSizeEntryKeysRef = useRef<Set<string>>(new Set());
  const deletionOperationGuardRef = useRef(new SingleFlightGuard());
  const deletionAvailable = deletionEnabled && (!rootHandle || isWritableDirectoryHandle(rootHandle));
  const deletionEnabledRef = useRef(deletionAvailable);
  const messengerSizeMetadataRef = useRef<{
    rootHandle: ReadableDirectoryHandle; generation: number; metadata: MessengerExportSizeMetadata;
  } | null>(null);

  const assertDeletionEnabled = useCallback(() => {
    if (!deletionEnabledRef.current) throw new DOMException('Chat deletion is disabled.', 'AbortError');
  }, []);
  const clearOwnership = useCallback(() => {
    // Invalidate first: abort handlers and late reads cannot restore old owners.
    ownershipRevisionRef.current++;
    ownershipAbortRef.current?.abort();
    ownershipAbortRef.current = null;
    facebookReferenceIndexCacheRef.current.clear();
    messengerReferenceIndexCacheRef.current.clear();
    messengerChatIndexRef.current = null;
    referenceProgressRef.current?.dispose();
    referenceProgressRef.current = null;
    setAttachmentReferenceIndex(null);
    setAttachmentReferenceIndexLoading(false);
    setAttachmentReferenceScan(null);
  }, []);
  useLayoutEffect(() => {
    if (deletionEnabledRef.current === deletionAvailable) return;
    deletionEnabledRef.current = deletionAvailable;
    clearOwnership();
  }, [deletionAvailable, clearOwnership]);
  useEffect(() => () => {
    folderPickerRequestRef.current++;
    ownershipRevisionRef.current++;
    ownershipAbortRef.current?.abort();
    referenceProgressRef.current?.dispose();
    facebookReferenceIndexCacheRef.current.clear();
    messengerReferenceIndexCacheRef.current.clear();
    messengerChatIndexRef.current = null;
  }, []);

  const inboxListRef = useRef<ChatListEntry[]>([]);
  const archivedListRef = useRef<ChatListEntry[]>([]);
  const requestsListRef = useRef<ChatListEntry[]>([]);
  inboxListRef.current = inboxList;
  archivedListRef.current = archivedList;
  requestsListRef.current = requestsList;

  const runMetaReferenceScan = useCallback(async (
    handle: ReadableDirectoryHandle,
    generation: number,
    signal: AbortSignal | undefined,
    platform: MetaArchivePlatform,
    verificationProgress?: CalculationProgressStore,
  ): Promise<MetaAttachmentReferenceIndex> => {
    assertDeletionEnabled();
    const revision = ownershipRevisionRef.current;
    const isCurrent = () => deletionEnabledRef.current && archiveGenerationRef.current === generation && ownershipRevisionRef.current === revision;
    throwIfAborted(signal);
    const controller = new AbortController();
    ownershipAbortRef.current = controller;
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    if (!isCurrent()) throw new DOMException('Aborted', 'AbortError');
    const progress = new CalculationProgressStore();
    referenceProgressRef.current = progress;
    const stopProgress = followCalculationProgress(progress, verificationProgress);
    let status: AttachmentReferenceScan['status'] = 'failed';
    setAttachmentReferenceIndexLoading(true);
    setAttachmentReferenceScan({ status: 'checking', progress });
    try {
      // Let scan status and the chat list paint before reading the archive.
      await new Promise(resolve => setTimeout(resolve, 0));
      const index = await buildMetaAttachmentReferenceIndex(handle, controller.signal, platform, progress.report);
      throwIfAborted(controller.signal);
      status = index.complete ? 'complete' : 'incomplete';
      return index;
    } finally {
      progress.dispose();
      stopProgress();
      signal?.removeEventListener('abort', abort);
      if (ownershipAbortRef.current === controller) ownershipAbortRef.current = null;
      if (isCurrent()) {
        setAttachmentReferenceIndexLoading(false);
        setAttachmentReferenceScan({ status, progress });
      }
    }
  }, [assertDeletionEnabled]);

  const getFacebookReferenceIndexForRoot = useCallback((
    handle: ReadableDirectoryHandle,
    generation: number,
    signal?: AbortSignal,
  ): Promise<MetaAttachmentReferenceIndex> => {
    assertDeletionEnabled();
    const archiveSignal = abortControllerRef.current?.signal;
    const revision = ownershipRevisionRef.current;
    const isCurrent = () => deletionEnabledRef.current && archiveGenerationRef.current === generation && ownershipRevisionRef.current === revision;
    const platform = metaArchivePlatformRef.current;
    const work = facebookReferenceIndexCacheRef.current.getOrCreate(handle, generation, async () => {
      const controller = new AbortController();
      ownershipAbortRef.current = controller;
      const abort = () => controller.abort();
      if (archiveSignal?.aborted) abort();
      else archiveSignal?.addEventListener('abort', abort, { once: true });
      try {
        const index = await runMetaReferenceScan(handle, generation, controller.signal, platform);
        if (isCurrent()) setAttachmentReferenceIndex(index);
        return index;
      } finally {
        archiveSignal?.removeEventListener('abort', abort);
        if (ownershipAbortRef.current === controller) ownershipAbortRef.current = null;
      }
    }, isCurrent);
    return waitForPromiseWithAbort(work, signal);
  }, [runMetaReferenceScan, assertDeletionEnabled]);

  const refreshFacebookReferenceIndex = useCallback(async (
    handle: ReadableDirectoryHandle,
    generation: number,
    signal?: AbortSignal,
  ): Promise<MetaAttachmentReferenceIndex> => {
    assertDeletionEnabled();
    // Keep the completed index available to the gallery while an optional
    // manual recheck runs. It becomes the fallback if the user cancels it.
    const previousIndex = facebookReferenceIndexCacheRef.current.get(handle, generation);
    // A dialog waiting for the initial scan does not own that background work.
    if (!previousIndex) return getFacebookReferenceIndexForRoot(handle, generation, signal);
    throwIfAborted(signal);
    const revision = ownershipRevisionRef.current + 1;
    ownershipRevisionRef.current = revision;
    ownershipAbortRef.current?.abort();
    const isCurrent = () => deletionEnabledRef.current && archiveGenerationRef.current === generation
      && ownershipRevisionRef.current === revision;
    const controller = new AbortController();
    ownershipAbortRef.current = controller;
    const archiveSignal = abortControllerRef.current?.signal;
    const abort = () => {
      controller.abort();
      if (!isCurrent()) return;
      // Invalidate publication now, even if getFile()/entries() cannot abort.
      ownershipRevisionRef.current++;
      referenceProgressRef.current?.dispose();
      setAttachmentReferenceIndex(previousIndex);
      setAttachmentReferenceIndexLoading(false);
      setAttachmentReferenceScan({ status: previousIndex.complete ? 'complete' : 'incomplete' });
    };
    signal?.addEventListener('abort', abort, { once: true });
    archiveSignal?.addEventListener('abort', abort, { once: true });
    try {
      const index = await waitForPromiseWithAbort(runMetaReferenceScan(
        handle,
        generation,
        controller.signal,
        metaArchivePlatformRef.current,
      ), controller.signal);
      if (isCurrent()) {
        facebookReferenceIndexCacheRef.current.set(handle, generation, index);
        setAttachmentReferenceIndex(index);
      }
      return index;
    } finally {
      signal?.removeEventListener('abort', abort);
      archiveSignal?.removeEventListener('abort', abort);
      if (ownershipAbortRef.current === controller) ownershipAbortRef.current = null;
    }
  }, [getFacebookReferenceIndexForRoot, runMetaReferenceScan, assertDeletionEnabled]);

  const getMessengerMediaSizeIndexForRoot = useCallback((
    handle: ReadableDirectoryHandle,
    generation: number,
    buildSignal?: AbortSignal,
    waitSignal?: AbortSignal
  ): Promise<Map<string, number>> => {
    const promise = messengerMediaSizeIndexCacheRef.current.getOrCreate(
      handle,
      generation,
      async () => {
        const progress = new CalculationProgressStore();
        messengerSizeProgressRef.current = progress;
        try {
          const mediaSizeIndex = await buildMessengerExportMediaSizeIndex(handle, buildSignal, progress.report);
          throwIfAborted(buildSignal);
          return mediaSizeIndex;
        } finally { progress.dispose(); }
      },
      () => archiveGenerationRef.current === generation
    );
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
            plan.sizeMetadata,
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

  const openFolder = useCallback(async (requestWrite?: boolean, onFolderPicked?: () => void, accessMode: FolderAccessMode = 'native'): Promise<boolean> => {
    let abortCtrl: AbortController | null = null;
    let browserFolderDetails = '';
    const pickerRequest = ++folderPickerRequestRef.current;
    setFolderSelectionPending(true);
    setFolderPreparationProgress(null);
    const onPreparationProgress = (done: number, total: number) => {
      if (pickerRequest !== folderPickerRequestRef.current) throw new DOMException('Aborted', 'AbortError');
      setFolderSelectionPending(false);
      if (done === 0) setError(null);
      setFolderPreparationProgress({ done, total });
    };
    const nativeSelected = accessMode === 'native' && isFileSystemAccessSupported();
    const diagnostics = nativeSelected ? new FolderOpenDiagnostics(requestWrite ? 'readwrite' : 'read') : undefined;
    try {
      const handle = await runFolderOperation(diagnostics, 'showDirectoryPicker()', () => requestWrite
        ? pickFolderWithWriteAccess(accessMode, onPreparationProgress)
        : pickMessagesFolder(accessMode, onPreparationProgress));
      if (pickerRequest !== folderPickerRequestRef.current) return false;
      if (diagnostics) diagnostics.pickerReturned = true;
      setFolderSelectionPending(false);
      setFolderPreparationProgress(null);
      onFolderPicked?.();
      setReactionSourceRevision(v => v + 1);
      const generation = ++archiveGenerationRef.current;
      
      setError(null);
      setErrorDetails('');
      setLoading(true);
      setLoadProgress({ done: 0, total: 0 });

      if (abortControllerRef.current) abortControllerRef.current.abort();
      abortCtrl = new AbortController();
      abortControllerRef.current = abortCtrl;
      
      setInboxList([]);
      setArchivedList([]);
      setRequestsList([]);
      setArchivePerspectiveKey(null);
      setArchivePerspectiveName('');
      inboxListRef.current = [];
      archivedListRef.current = [];
      requestsListRef.current = [];
      setRootHandle(null);
      setOriginalRootHandle(null);
      isMessengerExportRef.current = false;
      clearOwnership();
      messengerSizeMetadataRef.current = null;
      messengerChatIndexRef.current = null;
      messengerReferenceIndexCacheRef.current.clear();
      messengerMediaSizeIndexCacheRef.current.clear();
      facebookReferenceIndexCacheRef.current.clear();
      metaArchivePlatformRef.current = 'unknown';
      setAttachmentReferenceIndex(null);
      setAttachmentReferenceIndexLoading(false);
      setAttachmentReferenceScan(null);
      referenceProgressRef.current?.dispose();
      referenceProgressRef.current = null;
      messengerSizeProgressRef.current?.dispose();
      messengerSizeProgressRef.current = null;
      sizeWorkLifecycleRef.current.reset();
      sizeWorkPlanRef.current = null;
      deletedSizeEntryKeysRef.current.clear();
      sizeComputationPromisesRef.current.clear();
      
      if (diagnostics) diagnostics.stage = 'Facebook folder lookup';
      const messagesRootInfo = await resolveFacebookMessagesRootInfo(handle, diagnostics);
      const messagesRoot = messagesRootInfo?.handle;
      if (!messagesRoot) {
        const detection = { files: 0, directories: 0, jsonFiles: 0, invalidJsonFiles: 0, otherJsonFiles: 0, emptyJsonFiles: 0 };
        if (diagnostics) diagnostics.stage = 'Messenger detection';
        const messengerRoot = await resolveMessengerExportRoot(handle, detection, abortCtrl.signal, diagnostics);
        if (!messengerRoot) {
          const upload = getFolderUploadInfo(handle);
          const uploadDetails = upload
            ? ` Folder upload: ${upload.files} files, ${upload.jsonFileNames} JSON filenames, ${upload.jsonPaths} JSON paths, ${upload.rootJsonFiles} top-level JSON files, ${upload.missingRelativePaths} files without relative paths.`
            : '';
          browserFolderDetails = `Browser folder details: ${detection.files} top-level files, ${detection.directories} subfolders, ${detection.jsonFiles} JSON files (${detection.invalidJsonFiles} invalid, ${detection.otherJsonFiles} unrecognized, ${detection.emptyJsonFiles} empty).${uploadDetails}`;
          throw new Error('Could not find messages in this folder. Select an extracted Facebook, Instagram, or Messenger export in JSON format.');
        }

        isMessengerExportRef.current = true;
        setOriginalRootHandle(handle);
        setRootHandle(messengerRoot);

        const revision = ownershipRevisionRef.current;
        const isCurrent = () => deletionEnabledRef.current && archiveGenerationRef.current === generation
          && ownershipRevisionRef.current === revision;
        const ownershipController = new AbortController();
        const collectOwnership = deletionEnabledRef.current && isWritableDirectoryHandle(messengerRoot);
        if (collectOwnership) ownershipAbortRef.current = ownershipController;
        const progress = new CalculationProgressStore();
        referenceProgressRef.current = progress;
        if (collectOwnership) {
          setAttachmentReferenceIndexLoading(true);
          setAttachmentReferenceScan({ status: 'checking', progress });
        }
        if (diagnostics) diagnostics.stage = 'Messenger conversation listing';
        const { entries: inbox, chatIndex, sizeMetadata } = await listMessengerExportChatsIndexed(
          messengerRoot,
          (done, total) => {
            setLoadProgress({ done, total });
            if (collectOwnership && isCurrent()) progress.report({ stage: 'ownership', label: 'Scanning for shared attachments', done, total, unit: 'files' });
          },
          abortCtrl.signal,
          { collectOwnership, ownershipSignal: ownershipController.signal, diagnostics },
        ).catch(error => {
          if (collectOwnership && isCurrent()) {
            setAttachmentReferenceIndexLoading(false);
            setAttachmentReferenceScan({ status: 'failed', progress });
          }
          throw error;
        }).finally(() => {
          progress.dispose();
          if (ownershipAbortRef.current === ownershipController) ownershipAbortRef.current = null;
        });
        if (abortCtrl.signal.aborted) return false;

        const perspective = resolveArchivePerspective(inbox, 'messenger');
        if (archiveGenerationRef.current !== generation || abortCtrl.signal.aborted) return false;
        setArchivePerspectiveKey(perspective.archiveKey);
        setArchivePerspectiveName(perspective.name);

        messengerSizeMetadataRef.current = { rootHandle: messengerRoot, generation, metadata: sizeMetadata };
        if (chatIndex && isCurrent()) {
          messengerChatIndexRef.current = { rootHandle: messengerRoot, generation, chatIndex };
          messengerReferenceIndexCacheRef.current.set(messengerRoot, generation, chatIndex.referenceIndex);
          setAttachmentReferenceIndex(chatIndex.referenceIndex);
          setAttachmentReferenceIndexLoading(false);
          setAttachmentReferenceScan({ status: chatIndex.referenceIndex.complete ? 'complete' : 'incomplete', progress });
        }

        inboxListRef.current = inbox;
        archivedListRef.current = [];
        requestsListRef.current = [];
        setInboxList(inbox);
        setArchivedList([]);
        setRequestsList([]);
        sizeWorkPlanRef.current = { kind: 'messenger', rootHandle: messengerRoot, generation, sizeMetadata };
        startBackgroundSizeWork();
        return true;
      }

      setOriginalRootHandle(handle);
      setRootHandle(messagesRoot);
      // Explicit Instagram roots must never opt into Facebook shared-sticker removal.
      metaArchivePlatformRef.current = messagesRootInfo?.platform || 'unknown';

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

      if (diagnostics) diagnostics.stage = 'Facebook conversation listing';
      const [inbox, archived, requests, e2ee] = await Promise.all([
        listChatFolders(messagesRoot, 'inbox', 'inbox', (d, t) => updateProgress(0, d, t), abortCtrl.signal, diagnostics),
        listChatFolders(messagesRoot, 'archived_threads', 'archived', (d, t) => updateProgress(1, d, t), abortCtrl.signal, diagnostics),
        listChatFolders(messagesRoot, 'message_requests', 'requests', (d, t) => updateProgress(2, d, t), abortCtrl.signal, diagnostics),
        listChatFolders(messagesRoot, 'e2ee_cutover', 'e2ee', (d, t) => updateProgress(3, d, t), abortCtrl.signal, diagnostics),
      ]);
      if (abortCtrl.signal.aborted) return false;
      const mergedInbox = [...inbox, ...e2ee].sort((a, b) => {
        if (a.lastTimestamp == null && b.lastTimestamp == null) return 0;
        if (a.lastTimestamp == null) return 1;
        if (b.lastTimestamp == null) return -1;
        return b.lastTimestamp - a.lastTimestamp;
      });
      if (mergedInbox.length + archived.length + requests.length === 0) {
        setRootHandle(null);
        setOriginalRootHandle(null);
        throw new Error('No readable conversation files were found in this folder. Select an extracted export in JSON format.');
      }
      const perspective = resolveArchivePerspective(
        [...mergedInbox, ...archived, ...requests],
        'facebook'
      );
      if (archiveGenerationRef.current !== generation || abortCtrl.signal.aborted) return false;
      setArchivePerspectiveKey(perspective.archiveKey);
      setArchivePerspectiveName(perspective.name);
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
      if (pickerRequest !== folderPickerRequestRef.current) return false;
      const detail = e as { name?: unknown; message?: unknown } | null;
      if (detail?.name === 'AbortError') return false;
      const message = typeof detail?.message === 'string' && detail.message
        ? detail.message : typeof e === 'string' ? e : 'Failed to open folder';
      setError(message + (diagnostics ? ' If Native access fails, try Read-only access and select the folder again.' : ''));
      setErrorDetails([browserFolderDetails, diagnostics?.describe(e)].filter(Boolean).join(' '));
      return true;
    } finally {
      if (pickerRequest === folderPickerRequestRef.current) {
        setFolderSelectionPending(false);
        setFolderPreparationProgress(null);
      }
      if (abortControllerRef.current === abortCtrl) {
        setLoading(false);
        setLoadProgress(null);
      }
    }
  }, [clearOwnership, startBackgroundSizeWork]);

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

  const getMessengerMediaSizeIndex = useCallback(async (signal?: AbortSignal, progress?: CalculationProgressStore): Promise<Map<string, number>> => {
    if (!rootHandle) throw new Error('No folder open');
    const work = getMessengerMediaSizeIndexForRoot(
      rootHandle,
      archiveGenerationRef.current,
      abortControllerRef.current?.signal,
      signal
    );
    const stop = followCalculationProgress(messengerSizeProgressRef.current, progress);
    try { return await work; } finally { stop(); }
  }, [getMessengerMediaSizeIndexForRoot, rootHandle]);

  const getMessengerReferenceIndex = useCallback(async (signal?: AbortSignal, progressTarget?: CalculationProgressStore): Promise<{
    index: MessengerExportReferenceIndex;
    chatIndex?: MessengerExportChatIndex;
  }> => {
    assertDeletionEnabled();
    if (!rootHandle) throw new Error('No folder open');
    const generation = archiveGenerationRef.current;
    const revision = ownershipRevisionRef.current;
    const isCurrent = () => deletionEnabledRef.current && archiveGenerationRef.current === generation
      && ownershipRevisionRef.current === revision;
    const chatCached = messengerChatIndexRef.current;
    if (chatCached && chatCached.rootHandle === rootHandle && chatCached.generation === generation) {
      return {
        index: chatCached.chatIndex.referenceIndex,
        chatIndex: chatCached.chatIndex,
      };
    }

    const buildSignal = abortControllerRef.current?.signal;
    const promise = messengerReferenceIndexCacheRef.current.getOrCreate(
      rootHandle,
      generation,
      async () => {
        const controller = new AbortController();
        ownershipAbortRef.current = controller;
        const abort = () => controller.abort();
        if (buildSignal?.aborted) abort();
        else buildSignal?.addEventListener('abort', abort, { once: true });
        const progress = new CalculationProgressStore();
        referenceProgressRef.current = progress;
        setAttachmentReferenceIndexLoading(true);
        setAttachmentReferenceScan({ status: 'checking', progress });
        let status: AttachmentReferenceScan['status'] = 'failed';
        try {
          const builtIndex = await buildMessengerExportReferenceIndex(rootHandle, controller.signal, progress.report);
          throwIfAborted(controller.signal);
          status = builtIndex.complete ? 'complete' : 'incomplete';
          if (isCurrent()) setAttachmentReferenceIndex(builtIndex);
          return builtIndex;
        } finally {
          progress.dispose();
          buildSignal?.removeEventListener('abort', abort);
          if (ownershipAbortRef.current === controller) ownershipAbortRef.current = null;
          if (isCurrent()) {
            setAttachmentReferenceIndexLoading(false);
            setAttachmentReferenceScan({ status, progress });
          }
        }
      },
      isCurrent,
    );
    const stopProgress = followCalculationProgress(referenceProgressRef.current, progressTarget);
    try {
      const index = await waitForPromiseWithAbort(promise, signal);
      return { index };
    } finally { stopProgress(); }
  }, [rootHandle, assertDeletionEnabled]);

  useEffect(() => {
    if (!deletionAvailable || !rootHandle || loading || !sizeWorkPlanRef.current
      || sizeWorkPlanRef.current.generation !== archiveGenerationRef.current || deletionOperationGuardRef.current.busy) return;
    const work = isMessengerExportRef.current ? getMessengerReferenceIndex()
      : getFacebookReferenceIndexForRoot(rootHandle, archiveGenerationRef.current);
    void work.catch(error => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) console.error('Shared attachment scan failed:', error);
    });
  }, [deletionAvailable, rootHandle, loading, reactionMutationPending, getMessengerReferenceIndex, getFacebookReferenceIndexForRoot]);

  const getDeleteInfo = useCallback(async (
    entry: ChatListEntry | ChatListEntry[],
    signal?: AbortSignal,
    onOwnershipReady?: (info: MessengerExportDeletionInfo) => void,
    options?: DeleteInfoOptions
  ): Promise<MessengerExportDeletionInfo> => {
    assertDeletionEnabled();
    if (!rootHandle) throw new Error('No folder open');
    throwIfAborted(signal);
    const entries = Array.isArray(entry) ? entry : [entry];
    const messengerEntries = entries.filter(e => e._messengerExport);
    if (messengerEntries.length === 0) {
      const generation = archiveGenerationRef.current;
      const selectedEntries = [...new Map(entries.map(item => [getFacebookChatId(item), item])).values()];
      if (options?.skipAttachmentCheck) {
        // This dialog no longer waits for, or follows, the independent
        // background index. Global stickers never enter an unchecked estimate.
        const info: MessengerExportDeletionInfo = {
          jsonSize: 0, chatFileCount: 0, mediaSize: 0, totalSize: 0,
          exclusiveMediaFiles: [], exclusiveMediaCount: 0, sharedMediaCount: 0,
          stickerCount: 0, stickerSize: 0, stickersPreservedForSafety: true,
          deletableChatCount: selectedEntries.length,
        };
        if (options.skipSizes) return info;
        return { ...info, ...await computeFacebookDeleteInfo(selectedEntries, signal, 4, options.progress?.report) };
      }
      const work = options?.forceOwnershipCheck
        ? refreshFacebookReferenceIndex(rootHandle, generation, signal)
        : getFacebookReferenceIndexForRoot(rootHandle, generation, signal);
      const stop = followCalculationProgress(referenceProgressRef.current, options?.progress);
      let index: MetaAttachmentReferenceIndex;
      try { index = await work; } finally { stop(); }
      const plan = buildMetaChatDeletionPlan(selectedEntries, index);
      const chatIds = new Set(plan.chats.map(getFacebookChatId));
      const referenced = new Set<string>();
      for (const chatId of chatIds) {
        for (const identity of index.chatMedia.get(chatId) || []) referenced.add(identity);
      }
      const ownershipInfo: MessengerExportDeletionInfo = {
        jsonSize: 0, chatFileCount: 0, mediaSize: 0, totalSize: 0,
        exclusiveMediaFiles: [], exclusiveMediaCount: 0,
        sharedMediaCount: [...referenced].filter(identity =>
          [...(index.mediaOwners.get(identity) || [])].some(owner => !chatIds.has(owner))
        ).length,
        stickersPreservedForSafety: !index.complete || !index.deletionSupported,
        deletableChatCount: plan.chats.length,
        blockedChats: plan.blocked.map(block => ({
          chatId: getFacebookChatId(block.entry), title: block.entry.title, reason: block.reason,
          kind: block.kind, dependencies: block.dependencies,
        })),
      };
      onOwnershipReady?.(ownershipInfo);
      if (options?.skipSizes) return ownershipInfo;
      const folderInfo = await computeFacebookDeleteInfo(plan.chats, signal, 4, options?.progress?.report);
      const stickers = await getFacebookStickerDeletionTargets(rootHandle, index, chatIds, signal, options?.progress?.report);
      const stickerSize = stickers.reduce((sum, sticker) => sum + sticker.size, 0);
      return { ...ownershipInfo, ...folderInfo, sharedMediaCount: ownershipInfo.sharedMediaCount,
        stickerSize, stickerCount: stickers.length, totalSize: folderInfo.totalSize + stickerSize };
    }

    const referenceResult = await getMessengerReferenceIndex(signal, options?.progress);
    const { index: referenceIndex, chatIndex } = referenceResult;
    if (!referenceIndex.complete) throw new MessengerExportIndexIncompleteError();
    const deletionIndex = chatIndex || referenceIndex;
    const ownershipInfo = getMessengerExportDeletionOwnershipInfo(messengerEntries, deletionIndex);
    onOwnershipReady?.(ownershipInfo);
    let mediaSizeIndex: Map<string, number>;
    try {
      mediaSizeIndex = await getMessengerMediaSizeIndex(signal, options?.progress);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new MessengerExportMediaSizeUnavailableError(ownershipInfo, error);
    }
    if (messengerEntries.length === 1 && !Array.isArray(entry)) {
      return getMessengerExportDeletionInfo(rootHandle, messengerEntries[0], deletionIndex, signal, mediaSizeIndex, options?.progress?.report);
    }

    return getMessengerExportBatchDeletionInfo(rootHandle, messengerEntries, deletionIndex, signal, mediaSizeIndex, options?.progress?.report);
  }, [assertDeletionEnabled, getFacebookReferenceIndexForRoot, getMessengerMediaSizeIndex, getMessengerReferenceIndex, refreshFacebookReferenceIndex, rootHandle]);

  const beginDeletionOperation = useCallback((): symbol => {
    assertDeletionEnabled();
    const token = deletionOperationGuardRef.current.begin();
    setReactionMutationPending(true);
    setReactionSourceRevision(v => v + 1);
    return token;
  }, [assertDeletionEnabled]);

  const finishDeletionOperation = useCallback((token: symbol) => {
    deletionOperationGuardRef.current.finish(token);
    setReactionSourceRevision(v => v + 1);
    setReactionMutationPending(false);
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
    onProgress?: (progress: DeleteProgress) => void,
    options?: DeleteChatsOptions
  ): Promise<BatchDeleteResult> => {
    const operationToken = beginDeletionOperation();
    try {
      if (!rootHandle) throw new Error('No folder open');
      if (!isWritableDirectoryHandle(rootHandle)) throw new Error('Deletion is not supported for this folder');
      const generation = archiveGenerationRef.current;
      let ownershipRevision = ownershipRevisionRef.current;
      const assertOwnershipCurrent = () => {
        assertDeletionEnabled();
        if (ownershipRevision !== ownershipRevisionRef.current) throw new DOMException('Attachment check was superseded.', 'AbortError');
      };
      let mutationStarted = false;
      const beginMutation = () => {
        if (mutationStarted) return;
        assertOwnershipCurrent();
        mutationStarted = true;
      };
      const result: BatchDeleteResult = { requested: entries.length, deleted: [], failed: [] };
      const messengerEntries = entries.filter(entry => entry._messengerExport);

      if (messengerEntries.length > 0) {
        if (messengerEntries.length !== entries.length) {
          throw new Error('Facebook and Messenger chats cannot be deleted in one operation.');
        }
        const { index: referenceIndex, chatIndex } = await getMessengerReferenceIndex(undefined, options?.verificationProgress);
        const deletionIndex = chatIndex || referenceIndex;
        const mediaSizeIndex = messengerMediaSizeIndexCacheRef.current.get(rootHandle, generation);
        const plan = buildMessengerExportDeletionPlan(entries, deletionIndex, mediaSizeIndex);
        assertOwnershipCurrent();
        const deletionResult = await executeMessengerExportDeletionPlan(
          rootHandle,
          plan,
          deletionIndex,
          progress => onProgress?.({
            stage: progress.stage,
            done: progress.done,
            total: progress.total,
          }),
          beginMutation,
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
              removedMediaCount: chatResult.removedMediaCount,
              jsonRetained: true,
            });
          }
        }
      } else {
        const buildSignal = abortControllerRef.current?.signal;
        let stickerIndex: MetaAttachmentReferenceIndex | null = null;
        if (options?.skipAttachmentCheck) {
          // Invalidate pending publication before mutation. An old background
          // scan must not restore owners for folders removed without checking.
          ownershipRevisionRef.current++;
          ownershipRevision = ownershipRevisionRef.current;
          ownershipAbortRef.current?.abort();
          facebookReferenceIndexCacheRef.current.clear();
          setAttachmentReferenceIndex(null);
          setAttachmentReferenceIndexLoading(false);
          setAttachmentReferenceScan(null);
        } else {
          const initialWork = getFacebookReferenceIndexForRoot(rootHandle, generation, buildSignal);
          const stopProgress = followCalculationProgress(referenceProgressRef.current, options?.verificationProgress);
          try { await initialWork; } finally { stopProgress(); }
          // Refresh ownership immediately before mutation; a preview/background cache is not deletion proof.
          stickerIndex = await runMetaReferenceScan(
            rootHandle, generation, buildSignal, metaArchivePlatformRef.current, options?.verificationProgress,
          );
        }
        const plan = stickerIndex ? buildMetaChatDeletionPlan(entries, stickerIndex)
          : { chats: [...new Map(entries.map(entry => [getFacebookChatId(entry), entry])).values()], blocked: [] };
        const selected = options?.allowSharedAttachmentLoss
          ? [...plan.chats, ...plan.blocked.map(block => block.entry)] : plan.chats;
        if (!options?.allowSharedAttachmentLoss) {
          for (const block of plan.blocked) result.failed.push({ entry: block.entry, error: new MetaChatDeletionBlockedError(block), partial: false, blocked: true });
        }
        const stickerTargets = stickerIndex ? await getFacebookStickerDeletionTargets(
          rootHandle, stickerIndex, new Set(selected.map(getFacebookChatId)), buildSignal, options?.verificationProgress?.report,
        ) : [];
        const total = selected.length + stickerTargets.length;
        assertOwnershipCurrent();
        for (let position = 0; position < selected.length; position++) {
          throwIfAborted(buildSignal);
          const entry = selected[position];
          const safeIds = new Set([...result.deleted.map(getFacebookChatId), getFacebookChatId(entry)]);
          const block = !stickerIndex || options?.allowSharedAttachmentLoss ? null : getMetaFolderDeletionBlock(entry, stickerIndex, safeIds);
          if (block) {
            result.failed.push({ entry, error: new MetaChatDeletionBlockedError(block), partial: false, blocked: true });
            onProgress?.({ stage: 'chat', done: position + 1, total });
            continue;
          }
          const subfolderName =
            entry.source === 'inbox'    ? 'inbox' :
            entry.source === 'requests' ? 'message_requests' :
            entry.source === 'e2ee'     ? 'e2ee_cutover' :
            'archived_threads';
          try {
            await deleteChatFs(rootHandle, subfolderName, entry.folderName, beginMutation);
            result.deleted.push(entry);
          } catch (error) {
            if (!mutationStarted && error instanceof DOMException && error.name === 'AbortError') throw error;
            console.error(`Failed to delete ${entry.folderName}`, error);
            result.failed.push({ entry, error, partial: false });
          }
          onProgress?.({ stage: 'chat', done: position + 1, total });
        }
        // Only successful deletions count: a failed batch member retains its stickers.
        try {
          const failures = stickerIndex ? await removeFacebookStickers(
            rootHandle, stickerIndex, new Set(result.deleted.map(getFacebookChatId)), stickerTargets, buildSignal,
          ) : [];
          if (failures.length > 0) result.sharedMediaCleanupFailures = failures;
        } catch (error) {
          result.sharedMediaCleanupFailures = stickerTargets.map(target => ({ fileName: target.fileName, error }));
        }
        onProgress?.({ stage: 'media', done: total, total });
        if (stickerIndex) for (const entry of result.deleted) removeChatAttachmentReferences(stickerIndex, getFacebookChatId(entry));
        if (deletionEnabledRef.current && ownershipRevisionRef.current === ownershipRevision && archiveGenerationRef.current === generation) {
          if (stickerIndex) {
            facebookReferenceIndexCacheRef.current.set(rootHandle, generation, stickerIndex);
            setAttachmentReferenceIndex({ ...stickerIndex });
          } else {
            // Rebuild badges for the remaining chats without delaying the
            // explicitly unchecked deletion on another ownership scan.
            void getFacebookReferenceIndexForRoot(rootHandle, generation).catch(error => {
              if (!(error instanceof DOMException && error.name === 'AbortError')) console.error('Shared attachment scan failed:', error);
            });
          }
        }
      }

      if (archiveGenerationRef.current === generation) {
        if (deletionEnabledRef.current && ownershipRevisionRef.current === ownershipRevision) {
          const messengerIndex = messengerChatIndexRef.current?.chatIndex.referenceIndex
            || messengerReferenceIndexCacheRef.current.get(rootHandle, generation);
          if (messengerIndex) setAttachmentReferenceIndex({ ...messengerIndex });
        }
        for (const entry of result.deleted) {
          const metadata = messengerSizeMetadataRef.current?.metadata;
          if (entry._jsonFileName) {
            metadata?.chatMediaPaths.delete(entry._jsonFileName);
            metadata?.jsonSizes.delete(entry._jsonFileName);
          }
        }
        removeDeletedEntriesFromLists(result.deleted);
      }
      return result;
    } finally {
      finishDeletionOperation(operationToken);
    }
  }, [
    beginDeletionOperation,
    finishDeletionOperation,
    getFacebookReferenceIndexForRoot,
    assertDeletionEnabled,
    runMetaReferenceScan,
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
      const revision = ownershipRevisionRef.current;
      const { index: referenceIndex, chatIndex } = await getMessengerReferenceIndex();
      const deletionIndex = chatIndex || referenceIndex;
      assertDeletionEnabled();
      if (revision !== ownershipRevisionRef.current) throw new DOMException('Attachment check was superseded.', 'AbortError');
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
        if (deletionEnabledRef.current && revision === ownershipRevisionRef.current) setAttachmentReferenceIndex({ ...referenceIndex });
        for (const entry of result.deleted) {
          messengerSizeMetadataRef.current?.metadata.chatMediaPaths.delete(entry._jsonFileName!);
          messengerSizeMetadataRef.current?.metadata.jsonSizes.delete(entry._jsonFileName!);
        }
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
    assertDeletionEnabled,
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
          const cached = messengerSizeMetadataRef.current;
          if (cached
            && cached.rootHandle === rootHandle
            && cached.generation === archiveGenerationRef.current
            && cached.metadata.jsonSizes.has(entry._jsonFileName!)) {
            return computeMessengerExportChatSizeFromIndex(
              entry._jsonFileName!,
              cached.metadata,
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
    rootHandle, attachmentReferenceIndex: deletionAvailable ? attachmentReferenceIndex : null,
    attachmentReferenceIndexLoading: deletionAvailable && attachmentReferenceIndexLoading,
    attachmentReferenceScan: deletionAvailable ? attachmentReferenceScan : null,
    reactionSourceRevision, reactionMutationPending, standaloneMessenger: isMessengerExportRef.current, originalRootHandle, inboxList, archivedList, requestsList,
    archivePerspectiveKey, archivePerspectiveName,
    loading, folderSelectionPending, folderPreparationProgress, loadProgress, sizeProgress,
    error: error && debuggingEnabled && errorDetails ? `${error} ${errorDetails}` : error,
    openFolder, openFolderWithWriteAccess, getDeleteInfo, computeAndUpdateFolderSize, suspendSizeWork, resumeSizeWork, deleteChat, deleteChats, deleteMessengerChatsJsonOnly, updateFolderSize,
  };
}
