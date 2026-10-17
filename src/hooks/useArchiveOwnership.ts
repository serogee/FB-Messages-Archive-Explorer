import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ArchiveScope } from '../types/archive';
import { isWritableDirectoryHandle } from '../types/fileSystem';
import { GenerationScopedAsyncCache } from '../services/generationScopedAsyncCache';
import { waitForPromiseWithAbort } from '../services/concurrency';
import { CalculationProgressStore, followCalculationProgress } from '../services/calculationProgress';
import { removeChatAttachmentReferences, type AttachmentReferenceIndex, type AttachmentReferenceScan } from '../services/attachmentReferenceIndex';
import { buildMetaAttachmentReferenceIndex, type MetaAttachmentReferenceIndex } from '../services/metaAttachmentReferences';
import type { MetaArchivePlatform } from '../services/metaAttachmentPaths';
import {
  buildMessengerExportReferenceIndex,
  type MessengerExportChatIndex,
  type MessengerExportReferenceIndex,
} from '../services/messengerExport';

interface ArchiveOwnershipInputs {
  available: boolean;
  isArchiveCurrent: (scope: ArchiveScope) => boolean;
}

interface MessengerOwnershipListing {
  collectOwnership: boolean;
  signal: AbortSignal;
  report: (done: number, total: number) => void;
  accept: (index?: MessengerExportChatIndex) => void;
  fail: () => void;
  finish: () => void;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

export function useArchiveOwnership({ available, isArchiveCurrent }: ArchiveOwnershipInputs) {
  const [index, setIndex] = useState<AttachmentReferenceIndex | null>(null);
  const [loading, setLoading] = useState(false);
  const [scan, setScan] = useState<AttachmentReferenceScan | null>(null);
  const availableRef = useRef(available);
  const revisionRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const progressRef = useRef<CalculationProgressStore | null>(null);
  const messengerChatIndexRef = useRef<{
    rootHandle: ArchiveScope['rootHandle']; generation: number; chatIndex: MessengerExportChatIndex;
  } | null>(null);
  const messengerIndexCacheRef = useRef(
    new GenerationScopedAsyncCache<ArchiveScope['rootHandle'], MessengerExportReferenceIndex>()
  );
  const metaIndexCacheRef = useRef(
    new GenerationScopedAsyncCache<ArchiveScope['rootHandle'], MetaAttachmentReferenceIndex>()
  );

  const advanceRevision = useCallback((): number => ++revisionRef.current, []);
  const captureRevision = useCallback((): number => revisionRef.current, []);
  const assertEnabled = useCallback((): void => {
    if (!availableRef.current) throw new DOMException('Chat deletion is disabled.', 'AbortError');
  }, []);
  const assertRevision = useCallback((revision: number): void => {
    assertEnabled();
    if (revision !== revisionRef.current) throw new DOMException('Attachment check was superseded.', 'AbortError');
  }, [assertEnabled]);
  const isCurrent = useCallback((scope: ArchiveScope, revision: number): boolean => (
    availableRef.current && isArchiveCurrent(scope) && revisionRef.current === revision
  ), [isArchiveCurrent]);

  const clear = useCallback((): void => {
    // Invalidate first: abort handlers and late reads cannot restore old owners.
    advanceRevision();
    abortRef.current?.abort();
    abortRef.current = null;
    metaIndexCacheRef.current.clear();
    messengerIndexCacheRef.current.clear();
    messengerChatIndexRef.current = null;
    progressRef.current?.dispose();
    progressRef.current = null;
    setIndex(null);
    setLoading(false);
    setScan(null);
  }, [advanceRevision]);

  useLayoutEffect(() => {
    if (availableRef.current === available) return;
    availableRef.current = available;
    clear();
  }, [available, clear]);

  useEffect(() => () => {
    advanceRevision();
    abortRef.current?.abort();
    progressRef.current?.dispose();
    metaIndexCacheRef.current.clear();
    messengerIndexCacheRef.current.clear();
    messengerChatIndexRef.current = null;
  }, [advanceRevision]);

  const runMetaScan = useCallback(async (
    scope: ArchiveScope,
    signal: AbortSignal | undefined,
    platform: MetaArchivePlatform,
    verificationProgress?: CalculationProgressStore,
  ): Promise<MetaAttachmentReferenceIndex> => {
    assertEnabled();
    const revision = captureRevision();
    throwIfAborted(signal);
    const controller = new AbortController();
    abortRef.current = controller;
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    if (!isCurrent(scope, revision)) throw new DOMException('Aborted', 'AbortError');
    const progress = new CalculationProgressStore();
    progressRef.current = progress;
    const stopProgress = followCalculationProgress(progress, verificationProgress);
    let status: AttachmentReferenceScan['status'] = 'failed';
    setLoading(true);
    setScan({ status: 'checking', progress });
    try {
      // Let scan status and the chat list paint before reading the archive.
      await new Promise(resolve => setTimeout(resolve, 0));
      const result = await buildMetaAttachmentReferenceIndex(scope.rootHandle, controller.signal, platform, progress.report);
      throwIfAborted(controller.signal);
      status = result.complete ? 'complete' : 'incomplete';
      return result;
    } finally {
      progress.dispose();
      stopProgress();
      signal?.removeEventListener('abort', abort);
      if (abortRef.current === controller) abortRef.current = null;
      if (isCurrent(scope, revision)) {
        setLoading(false);
        setScan({ status, progress });
      }
    }
  }, [assertEnabled, captureRevision, isCurrent]);

  const getMeta = useCallback((
    scope: ArchiveScope,
    platform: MetaArchivePlatform,
    waitSignal?: AbortSignal,
    progressTarget?: CalculationProgressStore,
  ): Promise<MetaAttachmentReferenceIndex> => {
    assertEnabled();
    const { rootHandle, generation, signal: archiveSignal } = scope;
    const revision = captureRevision();
    const work = metaIndexCacheRef.current.getOrCreate(rootHandle, generation, async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      const abort = () => controller.abort();
      if (archiveSignal?.aborted) abort();
      else archiveSignal?.addEventListener('abort', abort, { once: true });
      try {
        const result = await runMetaScan(scope, controller.signal, platform);
        if (isCurrent(scope, revision)) setIndex(result);
        return result;
      } finally {
        archiveSignal?.removeEventListener('abort', abort);
        if (abortRef.current === controller) abortRef.current = null;
      }
    }, () => isCurrent(scope, revision));
    const waiting = waitForPromiseWithAbort(work, waitSignal);
    if (!progressTarget) return waiting;
    const stop = followCalculationProgress(progressRef.current, progressTarget);
    return waiting.finally(stop);
  }, [runMetaScan, assertEnabled, captureRevision, isCurrent]);

  const recheckMeta = useCallback(async (
    scope: ArchiveScope,
    platform: MetaArchivePlatform,
    signal?: AbortSignal,
    progressTarget?: CalculationProgressStore,
  ): Promise<MetaAttachmentReferenceIndex> => {
    assertEnabled();
    // An initial scan is independently owned; cancel only its dialog waiter.
    const previousIndex = metaIndexCacheRef.current.get(scope.rootHandle, scope.generation);
    if (!previousIndex) return getMeta(scope, platform, signal, progressTarget);
    throwIfAborted(signal);
    const revision = advanceRevision();
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const archiveSignal = scope.signal;
    const abort = () => {
      controller.abort();
      if (!isCurrent(scope, revision)) return;
      // Restore now, without waiting for non-abortable filesystem reads.
      advanceRevision();
      progressRef.current?.dispose();
      setIndex(previousIndex);
      setLoading(false);
      setScan({ status: previousIndex.complete ? 'complete' : 'incomplete' });
    };
    signal?.addEventListener('abort', abort, { once: true });
    archiveSignal?.addEventListener('abort', abort, { once: true });
    let stopProgress = () => {};
    try {
      const work = waitForPromiseWithAbort(runMetaScan(scope, controller.signal, platform), controller.signal);
      stopProgress = followCalculationProgress(progressRef.current, progressTarget);
      const result = await work;
      if (isCurrent(scope, revision)) {
        metaIndexCacheRef.current.set(scope.rootHandle, scope.generation, result);
        setIndex(result);
      }
      return result;
    } finally {
      stopProgress();
      signal?.removeEventListener('abort', abort);
      archiveSignal?.removeEventListener('abort', abort);
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [getMeta, runMetaScan, assertEnabled, advanceRevision, isCurrent]);

  const scanMetaBeforeDeletion = useCallback((
    scope: ArchiveScope,
    platform: MetaArchivePlatform,
    progress?: CalculationProgressStore,
  ): Promise<MetaAttachmentReferenceIndex> => (
    runMetaScan(scope, scope.signal, platform, progress)
  ), [runMetaScan]);

  const getMessenger = useCallback(async (
    scope: ArchiveScope,
    signal?: AbortSignal,
    progressTarget?: CalculationProgressStore,
  ): Promise<{ index: MessengerExportReferenceIndex; chatIndex?: MessengerExportChatIndex }> => {
    assertEnabled();
    const { rootHandle, generation, signal: buildSignal } = scope;
    const revision = captureRevision();
    const chatCached = messengerChatIndexRef.current;
    if (chatCached && chatCached.rootHandle === rootHandle && chatCached.generation === generation) {
      return { index: chatCached.chatIndex.referenceIndex, chatIndex: chatCached.chatIndex };
    }

    const promise = messengerIndexCacheRef.current.getOrCreate(rootHandle, generation, async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      const abort = () => controller.abort();
      if (buildSignal?.aborted) abort();
      else buildSignal?.addEventListener('abort', abort, { once: true });
      const progress = new CalculationProgressStore();
      progressRef.current = progress;
      setLoading(true);
      setScan({ status: 'checking', progress });
      let status: AttachmentReferenceScan['status'] = 'failed';
      try {
        const result = await buildMessengerExportReferenceIndex(rootHandle, controller.signal, progress.report);
        throwIfAborted(controller.signal);
        status = result.complete ? 'complete' : 'incomplete';
        if (isCurrent(scope, revision)) setIndex(result);
        return result;
      } finally {
        progress.dispose();
        buildSignal?.removeEventListener('abort', abort);
        if (abortRef.current === controller) abortRef.current = null;
        if (isCurrent(scope, revision)) {
          setLoading(false);
          setScan({ status, progress });
        }
      }
    }, () => isCurrent(scope, revision));
    const stopProgress = followCalculationProgress(progressRef.current, progressTarget);
    try {
      const result = await waitForPromiseWithAbort(promise, signal);
      return { index: result };
    } finally { stopProgress(); }
  }, [assertEnabled, captureRevision, isCurrent]);

  const beginMessengerListing = useCallback((scope: ArchiveScope): MessengerOwnershipListing => {
    const revision = captureRevision();
    const controller = new AbortController();
    const collectOwnership = availableRef.current && isWritableDirectoryHandle(scope.rootHandle);
    if (collectOwnership) abortRef.current = controller;
    const progress = new CalculationProgressStore();
    progressRef.current = progress;
    if (collectOwnership) {
      setLoading(true);
      setScan({ status: 'checking', progress });
    }
    return {
      collectOwnership,
      signal: controller.signal,
      report: (done, total) => {
        if (collectOwnership && isCurrent(scope, revision)) progress.report({ stage: 'ownership', label: 'Scanning for shared attachments', done, total, unit: 'files' });
      },
      accept: chatIndex => {
        if (!chatIndex || !isCurrent(scope, revision)) return;
        messengerChatIndexRef.current = { rootHandle: scope.rootHandle, generation: scope.generation, chatIndex };
        messengerIndexCacheRef.current.set(scope.rootHandle, scope.generation, chatIndex.referenceIndex);
        setIndex(chatIndex.referenceIndex);
        setLoading(false);
        setScan({ status: chatIndex.referenceIndex.complete ? 'complete' : 'incomplete', progress });
      },
      fail: () => {
        if (collectOwnership && isCurrent(scope, revision)) {
          setLoading(false);
          setScan({ status: 'failed', progress });
        }
      },
      finish: () => {
        progress.dispose();
        if (abortRef.current === controller) abortRef.current = null;
      },
    };
  }, [captureRevision, isCurrent]);

  const invalidateMeta = useCallback((): number => {
    const revision = advanceRevision();
    abortRef.current?.abort();
    metaIndexCacheRef.current.clear();
    setIndex(null);
    setLoading(false);
    setScan(null);
    return revision;
  }, [advanceRevision]);

  const publishMetaAfterDeletion = useCallback((
    scope: ArchiveScope,
    revision: number,
    result: MetaAttachmentReferenceIndex | null,
    deletedChatIds: readonly string[],
    platform: MetaArchivePlatform,
  ): void => {
    if (result) for (const chatId of deletedChatIds) removeChatAttachmentReferences(result, chatId);
    if (!isCurrent(scope, revision)) return;
    if (result) {
      metaIndexCacheRef.current.set(scope.rootHandle, scope.generation, result);
      setIndex({ ...result });
    } else {
      // Unchecked deletion does not wait for the replacement badge scan.
      void getMeta(scope, platform).catch(error => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) console.error('Shared attachment scan failed:', error);
      });
    }
  }, [getMeta, isCurrent]);

  const publishMessengerAfterDeletion = useCallback((
    scope: ArchiveScope,
    revision: number,
    result?: MessengerExportReferenceIndex,
  ): void => {
    if (!isCurrent(scope, revision)) return;
    const current = result || messengerChatIndexRef.current?.chatIndex.referenceIndex
      || messengerIndexCacheRef.current.get(scope.rootHandle, scope.generation);
    if (current) setIndex({ ...current });
  }, [isCurrent]);

  return {
    index: available ? index : null,
    loading: available && loading,
    scan: available ? scan : null,
    clear, assertEnabled, captureRevision, assertRevision,
    getMeta, recheckMeta, scanMetaBeforeDeletion, getMessenger, beginMessengerListing,
    invalidateMeta, publishMetaAfterDeletion, publishMessengerAfterDeletion,
  };
}
