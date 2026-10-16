import { useState, useCallback, useRef, useEffect } from 'react';
import type { ChatListEntry } from '../types/messenger';
import type { ArchiveLists, ArchiveListLane, ArchiveScope } from '../types/archive';
import { useArchiveSizes } from './useArchiveSizes';
import { useArchiveOwnership } from './useArchiveOwnership';
import type { FolderAccessMode, ReadableDirectoryHandle } from '../types/fileSystem';
import { isWritableDirectoryHandle } from '../types/fileSystem';
import {
  pickMessagesFolder,
  pickFolderWithWriteAccess,
  listChatFolders,
  deleteChat as deleteChatFs,
  resolveFacebookMessagesRootInfo,
  isFileSystemAccessSupported,
} from '../services/fileSystem';
import {
  buildMessengerExportDeletionPlan,
  deleteMessengerExportJsonOnly,
  executeMessengerExportDeletionPlan,
  getMessengerExportBatchDeletionInfo,
  getMessengerExportDeletionInfo,
  getMessengerExportDeletionOwnershipInfo,
  resolveMessengerExportRoot,
  listMessengerExportChatsIndexed,
  MessengerExportIndexIncompleteError,
  MessengerExportMediaSizeUnavailableError,
  type MessengerExportChatIndex,
  type MessengerExportDeletionInfo,
  type MessengerExportReferenceIndex,
} from '../services/messengerExport';
import { createConcurrencyLimiter, mapWithConcurrency, type Concurrency, type ConcurrencyLimiter } from '../services/concurrency';
import { performanceLimit } from '../services/performanceSettings';
import { SingleFlightGuard } from '../services/singleFlight';
import { resolveArchivePerspective } from '../services/perspective';
import type { BatchDeleteResult, DeleteChatsOptions, DeleteInfoOptions, DeleteProgress } from '../types/deletion';
import type { AttachmentReferenceIndex, AttachmentReferenceScan } from '../services/attachmentReferenceIndex';
import {
  getFacebookChatId, getFacebookStickerDeletionTargets, removeFacebookStickers,
} from '../services/facebookStickerReferences';
import type { MetaAttachmentReferenceIndex } from '../services/metaAttachmentReferences';
import { buildMetaChatDeletionPlan, getMetaFolderDeletionBlock, MetaChatDeletionBlockedError } from '../services/metaChatDeletion';
import type { CalculationProgressStore, CalculationProgress } from '../services/calculationProgress';
import type { MetaArchivePlatform } from '../services/metaAttachmentPaths';
import { getFolderUploadInfo } from '../services/polyfill';
import { FolderOpenDiagnostics, runFolderOperation } from '../services/folderOpenDiagnostics';

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

async function computeFacebookEntryDeleteInfo(entry: ChatListEntry, signal?: AbortSignal, onFileChecked?: () => void, limitRead?: ConcurrencyLimiter): Promise<MessengerExportDeletionInfo> {
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
          const file = limitRead ? await limitRead(() => child.getFile(), signal) : await child.getFile();
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
  concurrency: Concurrency = performanceLimit('sizeDetails'),
  onProgress?: (progress: CalculationProgress) => void
): Promise<MessengerExportDeletionInfo> {
  const limitRead = createConcurrencyLimiter(concurrency);
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
      const info = await computeFacebookEntryDeleteInfo(entry, signal, () => { doneFiles++; report(); }, limitRead);
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
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState('');
  const abortControllerRef = useRef<AbortController | null>(null);
  const archiveGenerationRef = useRef(0);
  const folderPickerRequestRef = useRef(0);
  const isMessengerExportRef = useRef(false);
  const metaArchivePlatformRef = useRef<MetaArchivePlatform>('unknown');
  const deletionOperationGuardRef = useRef(new SingleFlightGuard());
  const deletionAvailable = deletionEnabled && (!rootHandle || isWritableDirectoryHandle(rootHandle));

  useEffect(() => () => { folderPickerRequestRef.current++; }, []);

  const inboxListRef = useRef<ChatListEntry[]>([]);
  const archivedListRef = useRef<ChatListEntry[]>([]);
  const requestsListRef = useRef<ChatListEntry[]>([]);
  inboxListRef.current = inboxList;
  archivedListRef.current = archivedList;
  requestsListRef.current = requestsList;

  const getSizeEntryKey = useCallback((entry: ChatListEntry): string => {
    return `${entry.source}:${entry.folderName}:${entry._jsonFileName || ''}`;
  }, []);

  const isArchiveCurrent = useCallback((scope: ArchiveScope): boolean => (
    archiveGenerationRef.current === scope.generation
  ), []);

  const {
    index: attachmentReferenceIndex,
    loading: attachmentReferenceIndexLoading,
    scan: attachmentReferenceScan,
    clear: clearOwnership,
    assertEnabled: assertDeletionEnabled,
    captureRevision: captureOwnershipRevision,
    assertRevision: assertOwnershipRevision,
    getMeta: getMetaOwnership,
    recheckMeta: recheckMetaOwnership,
    scanMetaBeforeDeletion,
    getMessenger: getMessengerOwnership,
    beginMessengerListing,
    invalidateMeta: invalidateMetaOwnership,
    publishMetaAfterDeletion: publishMetaOwnership,
    publishMessengerAfterDeletion: publishMessengerOwnership,
  } = useArchiveOwnership({ available: deletionAvailable, isArchiveCurrent });

  const captureArchiveScope = useCallback((): ArchiveScope | undefined => (
    rootHandle ? {
      rootHandle,
      generation: archiveGenerationRef.current,
      signal: abortControllerRef.current?.signal,
    } : undefined
  ), [rootHandle]);

  const readLists = useCallback((): ArchiveLists => ({
    inbox: inboxListRef.current,
    archived: archivedListRef.current,
    requests: requestsListRef.current,
  }), []);

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

  const commitSizeBatch = useCallback((
    scope: ArchiveScope,
    lane: ArchiveListLane,
    updates: ReadonlyMap<string, number>,
  ): void => {
    if (!isArchiveCurrent(scope)) return;
    const applySizes = (prev: ChatListEntry[]) => prev.map(entry => {
      const size = updates.get(entry._jsonFileName || entry.folderName);
      return size == null ? entry : { ...entry, folderSize: size, _sizeIncludesMedia: entry._messengerExport ? true : entry._sizeIncludesMedia };
    });
    if (lane === 'inbox') setInboxList(applySizes);
    else if (lane === 'requests') setRequestsList(applySizes);
    else setArchivedList(applySizes);
  }, [isArchiveCurrent]);

  const commitSize = useCallback((
    scope: ArchiveScope | undefined,
    entry: ChatListEntry,
    size: number,
    includesMedia?: boolean,
  ): void => {
    if (scope && !isArchiveCurrent(scope)) return;
    updateFolderSize(entry, size, includesMedia);
  }, [isArchiveCurrent, updateFolderSize]);

  const {
    sizeProgress,
    setPlan: setSizeWorkPlan,
    hasPlanFor: hasSizeWorkPlanFor,
    reset: resetSizeWork,
    startBackground: startBackgroundSizeWork,
    suspend: suspendSizeWork,
    resume: resumeSizeWork,
    computeAndUpdate: computeAndUpdateSize,
    getMediaSizes, peekMediaSizes, forgetMediaSizes,
    forgetDeleted: forgetDeletedSizeEntries,
  } = useArchiveSizes({
    isArchiveCurrent,
    readLists,
    entryKey: getSizeEntryKey,
    commitBatch: commitSizeBatch,
    commitOne: commitSize,
  });

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
      metaArchivePlatformRef.current = 'unknown';
      resetSizeWork();
      
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

        const ownershipListing = beginMessengerListing({ rootHandle: messengerRoot, generation, signal: abortCtrl.signal });
        if (diagnostics) diagnostics.stage = 'Messenger conversation listing';
        const { entries: inbox, chatIndex, sizeMetadata } = await listMessengerExportChatsIndexed(
          messengerRoot,
          (done, total) => {
            setLoadProgress({ done, total });
            ownershipListing.report(done, total);
          },
          abortCtrl.signal,
          { collectOwnership: ownershipListing.collectOwnership, ownershipSignal: ownershipListing.signal, diagnostics },
        ).catch(error => {
          ownershipListing.fail();
          throw error;
        }).finally(ownershipListing.finish);
        if (abortCtrl.signal.aborted) return false;

        const perspective = resolveArchivePerspective(inbox, 'messenger');
        if (archiveGenerationRef.current !== generation || abortCtrl.signal.aborted) return false;
        setArchivePerspectiveKey(perspective.archiveKey);
        setArchivePerspectiveName(perspective.name);

        ownershipListing.accept(chatIndex);

        inboxListRef.current = inbox;
        archivedListRef.current = [];
        requestsListRef.current = [];
        setInboxList(inbox);
        setArchivedList([]);
        setRequestsList([]);
        setSizeWorkPlan({ kind: 'messenger', scope: { rootHandle: messengerRoot, generation, signal: abortCtrl.signal }, sizeMetadata });
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
      const limitRead = createConcurrencyLimiter(performanceLimit('archiveReads'));
      const [inbox, archived, requests, e2ee] = await Promise.all([
        listChatFolders(messagesRoot, 'inbox', 'inbox', (d, t) => updateProgress(0, d, t), abortCtrl.signal, diagnostics, limitRead),
        listChatFolders(messagesRoot, 'archived_threads', 'archived', (d, t) => updateProgress(1, d, t), abortCtrl.signal, diagnostics, limitRead),
        listChatFolders(messagesRoot, 'message_requests', 'requests', (d, t) => updateProgress(2, d, t), abortCtrl.signal, diagnostics, limitRead),
        listChatFolders(messagesRoot, 'e2ee_cutover', 'e2ee', (d, t) => updateProgress(3, d, t), abortCtrl.signal, diagnostics, limitRead),
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
      setSizeWorkPlan({ kind: 'facebook', scope: { rootHandle: messagesRoot, generation, signal: abortCtrl.signal } });
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
  }, [beginMessengerListing, clearOwnership, resetSizeWork, setSizeWorkPlan, startBackgroundSizeWork]);

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

  const getMessengerMediaSizeIndex = useCallback((signal?: AbortSignal, progress?: CalculationProgressStore): Promise<Map<string, number>> => {
    const scope = captureArchiveScope();
    if (!scope) return Promise.reject(new Error('No folder open'));
    return getMediaSizes(scope, scope.signal, signal, progress);
  }, [captureArchiveScope, getMediaSizes]);

  const getMessengerReferenceIndex = useCallback(async (signal?: AbortSignal, progressTarget?: CalculationProgressStore): Promise<{
    index: MessengerExportReferenceIndex;
    chatIndex?: MessengerExportChatIndex;
  }> => {
    assertDeletionEnabled();
    const scope = captureArchiveScope();
    if (!scope) throw new Error('No folder open');
    return getMessengerOwnership(scope, signal, progressTarget);
  }, [assertDeletionEnabled, captureArchiveScope, getMessengerOwnership]);

  useEffect(() => {
    const scope = captureArchiveScope();
    if (!deletionAvailable || !scope || loading
      || !hasSizeWorkPlanFor(scope)
      || deletionOperationGuardRef.current.busy) return;
    const work = isMessengerExportRef.current ? getMessengerReferenceIndex()
      : getMetaOwnership(scope, metaArchivePlatformRef.current);
    void work.catch(error => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) console.error('Shared attachment scan failed:', error);
    });
  }, [deletionAvailable, captureArchiveScope, loading, reactionMutationPending, getMessengerReferenceIndex, getMetaOwnership, hasSizeWorkPlanFor]);

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
      const scope: ArchiveScope = { rootHandle, generation, signal: abortControllerRef.current?.signal };
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
        return { ...info, ...await computeFacebookDeleteInfo(selectedEntries, signal, performanceLimit('sizeDetails'), options.progress?.report) };
      }
      const work = options?.forceOwnershipCheck
        ? recheckMetaOwnership(scope, metaArchivePlatformRef.current, signal, options?.progress)
        : getMetaOwnership(scope, metaArchivePlatformRef.current, signal, options?.progress);
      const index = await work;
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
      const folderInfo = await computeFacebookDeleteInfo(plan.chats, signal, performanceLimit('sizeDetails'), options?.progress?.report);
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
  }, [assertDeletionEnabled, getMetaOwnership, getMessengerMediaSizeIndex, getMessengerReferenceIndex, recheckMetaOwnership, rootHandle]);

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

  const removeDeletedEntriesFromLists = useCallback((scope: ArchiveScope, entries: readonly ChatListEntry[]) => {
    const deletedKeys = new Set(entries.map(getSizeEntryKey));
    const wasDeleted = (entry: ChatListEntry) => deletedKeys.has(getSizeEntryKey(entry));
    forgetDeletedSizeEntries(scope, entries);
    setInboxList(prev => prev.filter(entry => !wasDeleted(entry)));
    setRequestsList(prev => prev.filter(entry => !wasDeleted(entry)));
    setArchivedList(prev => prev.filter(entry => !wasDeleted(entry)));
  }, [forgetDeletedSizeEntries, getSizeEntryKey]);

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
      const scope: ArchiveScope = { rootHandle, generation, signal: abortControllerRef.current?.signal };
      let ownershipRevision = captureOwnershipRevision();
      const assertOwnershipCurrent = () => assertOwnershipRevision(ownershipRevision);
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
        const mediaSizeIndex = peekMediaSizes(scope);
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
          forgetMediaSizes(mediaSizeIndex, chatResult.completedMedia.map(media => media.identity));
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
          ownershipRevision = invalidateMetaOwnership();
        } else {
          await getMetaOwnership(scope, metaArchivePlatformRef.current, buildSignal, options?.verificationProgress);
          // Refresh ownership immediately before mutation; a preview/background cache is not deletion proof.
          stickerIndex = await scanMetaBeforeDeletion(scope, metaArchivePlatformRef.current, options?.verificationProgress);
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
        publishMetaOwnership(scope, ownershipRevision, stickerIndex, result.deleted.map(getFacebookChatId), metaArchivePlatformRef.current);
      }

      if (archiveGenerationRef.current === generation) {
        publishMessengerOwnership(scope, ownershipRevision);
        removeDeletedEntriesFromLists(scope, result.deleted);
      }
      return result;
    } finally {
      finishDeletionOperation(operationToken);
    }
  }, [
    beginDeletionOperation,
    finishDeletionOperation,
    getMetaOwnership,
    captureOwnershipRevision,
    assertOwnershipRevision,
    invalidateMetaOwnership,
    scanMetaBeforeDeletion,
    publishMetaOwnership,
    publishMessengerOwnership,
    peekMediaSizes,
    forgetMediaSizes,
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
      const scope: ArchiveScope = { rootHandle, generation, signal: abortControllerRef.current?.signal };
      const revision = captureOwnershipRevision();
      const { index: referenceIndex, chatIndex } = await getMessengerReferenceIndex();
      const deletionIndex = chatIndex || referenceIndex;
      assertOwnershipRevision(revision);
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
        publishMessengerOwnership(scope, revision, referenceIndex);
        removeDeletedEntriesFromLists(scope, result.deleted);
      }
      return result;
    } finally {
      finishDeletionOperation(operationToken);
    }
  }, [
    beginDeletionOperation,
    finishDeletionOperation,
    getMessengerReferenceIndex,
    captureOwnershipRevision,
    assertOwnershipRevision,
    publishMessengerOwnership,
    removeDeletedEntriesFromLists,
    rootHandle,
  ]);

  const computeAndUpdateFolderSize = useCallback((entry: ChatListEntry): Promise<number> => (
    computeAndUpdateSize(captureArchiveScope(), entry)
  ), [captureArchiveScope, computeAndUpdateSize]);

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
