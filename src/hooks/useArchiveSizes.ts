import { useCallback, useRef, useState } from 'react';
import type { ArchiveLists, ArchiveListLane, ArchiveScope } from '../types/archive';
import type { ChatListEntry } from '../types/messenger';
import { computeFolderSize } from '../services/fileSystem';
import {
  buildMessengerExportMediaSizeIndex,
  computeMessengerExportChatSize,
  computeMessengerExportChatSizeFromIndex,
  getMessengerMediaBasename,
  type MediaSizeIndex,
  type MessengerExportSizeMetadata,
} from '../services/messengerExport';
import { SizeWorkLifecycle } from '../services/sizeWorkLifecycle';
import { GenerationScopedAsyncCache } from '../services/generationScopedAsyncCache';
import { createConcurrencyLimiter, mapWithConcurrency, waitForPromiseWithAbort } from '../services/concurrency';
import { performanceLimit } from '../services/performanceSettings';
import { CalculationProgressStore, followCalculationProgress } from '../services/calculationProgress';

type SizeWorkPlan =
  | { kind: 'facebook'; scope: ArchiveScope }
  | { kind: 'messenger'; scope: ArchiveScope; sizeMetadata: MessengerExportSizeMetadata };

interface ArchiveSizeCallbacks {
  isArchiveCurrent: (scope: ArchiveScope) => boolean;
  readLists: () => ArchiveLists;
  entryKey: (entry: ChatListEntry) => string;
  commitBatch: (scope: ArchiveScope, lane: ArchiveListLane, updates: ReadonlyMap<string, number>) => void;
  commitOne: (scope: ArchiveScope | undefined, entry: ChatListEntry, size: number, includesMedia?: boolean) => void;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

export function useArchiveSizes({
  isArchiveCurrent, readLists, entryKey: getSizeEntryKey, commitBatch, commitOne,
}: ArchiveSizeCallbacks) {
  const [sizeProgress, setSizeProgress] = useState<{ done: number; total: number } | null>(null);
  const messengerSizeProgressRef = useRef<CalculationProgressStore | null>(null);
  const messengerMediaSizeIndexCacheRef = useRef(
    new GenerationScopedAsyncCache<ArchiveScope['rootHandle'], MediaSizeIndex>()
  );
  const sizeComputationPromisesRef = useRef<Map<string, Promise<number>>>(new Map());
  const sizeWorkLifecycleRef = useRef(new SizeWorkLifecycle());
  const sizeWorkPlanRef = useRef<SizeWorkPlan | null>(null);
  const deletedSizeEntryKeysRef = useRef<Set<string>>(new Set());
  const messengerSizeMetadataRef = useRef<{
    scope: ArchiveScope; metadata: MessengerExportSizeMetadata;
  } | null>(null);

  const getMessengerMediaSizeIndexForRoot = useCallback((
    scope: ArchiveScope,
    buildSignal?: AbortSignal,
    waitSignal?: AbortSignal
  ): Promise<Map<string, number>> => {
    const { rootHandle: handle, generation } = scope;
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
      () => isArchiveCurrent(scope)
    );
    return waitForPromiseWithAbort(promise, waitSignal);
  }, [isArchiveCurrent]);

  const getCurrentEntry = useCallback((entry: ChatListEntry): ChatListEntry | null => {
    const key = getSizeEntryKey(entry);
    const lists = readLists();
    return [...lists.inbox, ...lists.archived, ...lists.requests]
      .find(candidate => getSizeEntryKey(candidate) === key) || null;
  }, [getSizeEntryKey, readLists]);

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
    scope: ArchiveScope,
    entries: readonly ChatListEntry[],
    lane: ArchiveListLane,
    onProgress?: (done: number) => void,
    signal: AbortSignal = sizeWorkLifecycleRef.current.signal,
    computeSize?: (entry: ChatListEntry, signal: AbortSignal) => Promise<number>
  ) => {
    const limitSizeRead = createConcurrencyLimiter(performanceLimit('sizes'));
    const calculateSize = computeSize || ((entry: ChatListEntry, workSignal: AbortSignal) => computeFolderSize(entry.dirHandle, workSignal, limitSizeRead));
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
        commitBatch(scope, lane, updates);
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

    void mapWithConcurrency(entries, performanceLimit('sizes'), async entry => {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (signal?.aborted) return;
        try {
          const currentEntry = getCurrentEntry(entry);
          const key = getSizeEntryKey(entry);
          if (!currentEntry
            || deletedSizeEntryKeysRef.current.has(key)
            || hasCompleteSize(currentEntry)) {
            done++;
            scheduleFlush(done >= entries.length);
            return;
          }

          let sizePromise = sizeComputationPromisesRef.current.get(key);
          if (!sizePromise) {
            sizePromise = trackActiveSizeWork(calculateSize(currentEntry, signal));
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
    }, signal).then(() => scheduleFlush(true)).catch(error => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) console.error('Chat size calculation failed:', error);
    });
  }, [commitBatch, getCurrentEntry, getSizeEntryKey, hasCompleteSize, trackActiveSizeWork]);

  const startBackgroundSizeWork = useCallback(() => {
    const plan = sizeWorkPlanRef.current;
    const lifecycle = sizeWorkLifecycleRef.current;
    const signal = lifecycle.signal;
    if (!plan
      || lifecycle.suspended
      || signal.aborted
      || !isArchiveCurrent(plan.scope)) {
      return;
    }

    const lists = readLists();
    const isPending = (entry: ChatListEntry) => (
      !deletedSizeEntryKeysRef.current.has(getSizeEntryKey(entry)) && !hasCompleteSize(entry)
    );

    if (plan.kind === 'messenger') {
      const entries = lists.inbox.filter(isPending);
      if (entries.length === 0) {
        setSizeProgress(null);
        return;
      }

      setSizeProgress({ done: 0, total: entries.length });
      const mediaSizePromise = trackActiveSizeWork(getMessengerMediaSizeIndexForRoot(
        plan.scope,
        signal
      ));
      void mediaSizePromise.then(mediaSizeIndex => {
        throwIfAborted(signal);
        if (sizeWorkLifecycleRef.current.signal !== signal
          || !isArchiveCurrent(plan.scope)) {
          return;
        }

        startLazySizeComputation(
          plan.scope,
          entries,
          'inbox',
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
          if (isArchiveCurrent(plan.scope)) setSizeProgress(null);
        }
      });
      return;
    }

    const lanes = [
      { entries: lists.inbox.filter(isPending), lane: 'inbox' as const },
      { entries: lists.archived.filter(isPending), lane: 'archived' as const },
      { entries: lists.requests.filter(isPending), lane: 'requests' as const },
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
        plan.scope,
        lane.entries,
        lane.lane,
        done => updateProgress(index, done),
        signal
      );
    });
  }, [
    getMessengerMediaSizeIndexForRoot,
    getSizeEntryKey,
    hasCompleteSize,
    isArchiveCurrent,
    readLists,
    startLazySizeComputation,
    trackActiveSizeWork,
  ]);

  const resumeSizeWork = useCallback(() => {
    if (!sizeWorkLifecycleRef.current.resume()) return;
    startBackgroundSizeWork();
  }, [startBackgroundSizeWork]);

  const computeAndUpdateFolderSize = useCallback(async (scope: ArchiveScope | undefined, entry: ChatListEntry): Promise<number> => {
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
          if (!scope) throw new Error('No folder open');
          const { rootHandle } = scope;
          const mediaSizeIndex = await getMessengerMediaSizeIndexForRoot(
            scope,
            signal
          );
          throwIfAborted(signal);
          const cached = messengerSizeMetadataRef.current;
          if (cached
            && cached.scope.rootHandle === rootHandle
            && isArchiveCurrent(cached.scope)
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
      commitOne(scope, entry, size, entry._messengerExport ? true : undefined);
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
    isArchiveCurrent,
    trackActiveSizeWork,
    commitOne,
  ]);

  const getMediaSizes = useCallback(async (
    scope: ArchiveScope,
    buildSignal?: AbortSignal,
    waitSignal?: AbortSignal,
    progress?: CalculationProgressStore,
  ): Promise<MediaSizeIndex> => {
    const work = getMessengerMediaSizeIndexForRoot(scope, buildSignal, waitSignal);
    const stop = followCalculationProgress(messengerSizeProgressRef.current, progress);
    try { return await work; } finally { stop(); }
  }, [getMessengerMediaSizeIndexForRoot]);

  const setPlan = useCallback((plan: SizeWorkPlan): void => {
    if (plan.kind === 'messenger') {
      messengerSizeMetadataRef.current = { scope: plan.scope, metadata: plan.sizeMetadata };
    }
    sizeWorkPlanRef.current = plan;
  }, []);

  const hasPlanFor = useCallback((scope: ArchiveScope): boolean => (
    sizeWorkPlanRef.current?.scope.generation === scope.generation
  ), []);

  const reset = useCallback((): void => {
    messengerSizeMetadataRef.current = null;
    messengerMediaSizeIndexCacheRef.current.clear();
    messengerSizeProgressRef.current?.dispose();
    messengerSizeProgressRef.current = null;
    sizeWorkLifecycleRef.current.reset();
    sizeWorkPlanRef.current = null;
    deletedSizeEntryKeysRef.current.clear();
    sizeComputationPromisesRef.current.clear();
  }, []);

  const peekMediaSizes = useCallback((scope: ArchiveScope): MediaSizeIndex | undefined => (
    messengerMediaSizeIndexCacheRef.current.get(scope.rootHandle, scope.generation)
  ), []);

  const forgetMediaSizes = useCallback((index: MediaSizeIndex | undefined, identities: readonly string[]): void => {
    for (const identity of identities) {
      index?.delete(identity);
      index?.delete(getMessengerMediaBasename(identity));
    }
  }, []);

  const forgetDeleted = useCallback((scope: ArchiveScope, entries: readonly ChatListEntry[]): void => {
    if (!isArchiveCurrent(scope)) return;
    for (const entry of entries) {
      deletedSizeEntryKeysRef.current.add(getSizeEntryKey(entry));
      if (entry._jsonFileName) {
        messengerSizeMetadataRef.current?.metadata.chatMediaPaths.delete(entry._jsonFileName);
        messengerSizeMetadataRef.current?.metadata.jsonSizes.delete(entry._jsonFileName);
      }
    }
  }, [getSizeEntryKey, isArchiveCurrent]);

  return {
    sizeProgress,
    setPlan, hasPlanFor, reset,
    startBackground: startBackgroundSizeWork,
    suspend: suspendSizeWork,
    resume: resumeSizeWork,
    computeAndUpdate: computeAndUpdateFolderSize,
    getMediaSizes, peekMediaSizes, forgetMediaSizes, forgetDeleted,
  };
}
