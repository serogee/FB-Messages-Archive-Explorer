import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { useSettings } from './hooks/useSettings';
import { useMobileLayout, useMobileNavigation } from './hooks/useMobileNavigation';
import { getNavigationItemKey, type NavigationSnapshot, type SidebarView, type PreviewRequest } from './services/mobileNavigation';
import { getAttachmentJumpTab } from './components/AttachmentGallery/attachmentJump';
import { ReactionFeatureContext, useReactionFeature } from './hooks/useReactionFeature';
import { useArchive } from './hooks/useArchive';
import { useChat } from './hooks/useChat';
import { ThreadDataContext } from './hooks/useThreadData';
import { AttachmentReferencesContext } from './hooks/useAttachmentReferences';
import { getMetaChatId } from './services/metaAttachmentPaths';
import { useSearch } from './hooks/useSearch';
import { useResizable } from './hooks/useResizable';
import { sortSelectableItemsNewestFirst, useSelection } from './hooks/useSelection';
import { useAttachments, useSharedLinks } from './hooks/useAttachments';
import { useBookmarks } from './hooks/useBookmarks';
import { Sidebar } from './components/Sidebar/Sidebar';
import { ChatView, type ChatViewHandle } from './components/Chat/ChatView';
import type { MessageJumpOptions } from './components/Chat/MessageList';
import { DateNavigator } from './components/Chat/DateNavigator';
import { InfoPanel } from './components/InfoPanel/InfoPanel';
import { SelectionHeader, SelectionPanel } from './components/InfoPanel/SelectionPanel';
import { MediaViewer } from './components/MediaViewer/MediaViewer';
import { ParentBackButton } from './components/Navigation/ParentBackButton';
import { ENABLE_CONTEXTUAL_BACK_NAVIGATION } from './config/uiFeatures';
import { TrustModal } from './components/Modals/TrustModal';
import { ReloadPrompt } from './components/ReloadPrompt';
import { DeleteConfirmModal } from './components/Modals/DeleteConfirmModal';
import type { ChatListEntry, SelectableItem } from './types/messenger';
import type {
  DeletePreparationState,
  DeleteProgress,
  DeleteResultNotice,
} from './types/deletion';
import type { GalleryCategory } from './hooks/useAttachments';
import {
  MessengerExportIndexIncompleteError,
  MessengerExportMediaSizeUnavailableError,
} from './services/messengerExport';
import { isFileSystemAccessSupported } from './services/fileSystem';
import { getBookmarkChatId } from './services/bookmarks';
import {
  formatBatchDeleteResult,
  getBookmarkCleanupEntries,
  getDeleteRetryEntries,
} from './services/deletionResults';
import { createProgressThrottle } from './services/progressThrottle';
import { CalculationProgressStore } from './services/calculationProgress';
import { SingleFlightGuard } from './services/singleFlight';
import { isWritableDirectoryHandle, requestDirectoryWritePermission } from './types/fileSystem';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected error occurred.';
}

export default function App() {
  const { settings, setSetting } = useSettings();
  const isMobile = useMobileLayout();
  const { controller: navigation, state: navigationState } = useMobileNavigation(isMobile);
  const location = navigationState.location;
  const archive = useArchive(settings.deletionEnabled, settings.debuggingEnabled);
  const chat = useChat();
  const attachmentReferences = useMemo(() => ({
    index: archive.attachmentReferenceIndex,
    standaloneMessenger: archive.standaloneMessenger,
    indexing: archive.attachmentReferenceIndexLoading,
    chatId: chat.activeEntry && !chat.activeEntry._messengerExport ? getMetaChatId(chat.activeEntry) : undefined,
  }), [archive.attachmentReferenceIndex, archive.attachmentReferenceIndexLoading, archive.standaloneMessenger, chat.activeEntry]);
  const archiveList = useMemo(
    () => [...archive.inboxList, ...archive.archivedList, ...archive.requestsList],
    [archive.inboxList, archive.archivedList, archive.requestsList]
  );
  const navigatingChat = !!location.chatId && (!chat.activeEntry || getBookmarkChatId(chat.activeEntry) !== location.chatId);
  const viewEntry = navigatingChat ? archiveList.find(entry => getBookmarkChatId(entry) === location.chatId) ?? chat.activeEntry : chat.activeEntry;
  const showAllReactionNotices = useCallback(() => setSetting('hideLikelyReactionNotices', false), [setSetting]);
  const reactionFeature = useReactionFeature({
    root: archive.rootHandle, revision: archive.reactionSourceRevision, standalone: archive.standaloneMessenger,
    archiveLoading: archive.loading || archive.reactionMutationPending, chatLoading: chat.loading, chatData: chat.chatData, entry: chat.activeEntry,
    mode: settings.reactionTimestampGuessingMode, hide: settings.hideLikelyReactionNotices, showAll: showAllReactionNotices,
  });
  const search = useSearch(chat.chatData, archiveList, settings.hideLikelyReactionNotices, archive.standaloneMessenger);
  const { clearWideSearchCache, clearSearch } = search;
  useEffect(() => {
    clearWideSearchCache();
    clearSearch();
  }, [archive.reactionSourceRevision, clearWideSearchCache, clearSearch]);
  const selection = useSelection();
  const attachments = useAttachments(chat.chatData, chat.mediaState);
  const sharedLinks = useSharedLinks(chat.chatData);
  const bookmarkingEnabled = settings.attachmentBookmarkingEnabled && isFileSystemAccessSupported()
    && (!archive.rootHandle || isWritableDirectoryHandle(archive.rootHandle));
  const bookmarks = useBookmarks(archive.rootHandle, bookmarkingEnabled);

  const [sidebarView, setSidebarView] = useState<'chats' | 'settings' | 'archived' | 'requests'>('chats');
  const [activeTab, setActiveTab] = useState<'chats' | 'settings'>('chats');
  const [deleteTarget, setDeleteTarget] = useState<ChatListEntry | ChatListEntry[] | null>(null);
  const [deleteProgress, setDeleteProgress] = useState<DeleteProgress | null>(null);
  const [deletePreparation, setDeletePreparation] = useState<DeletePreparationState>({
    status: 'loading',
    calculatingSizes: false,
  });
  const [deleteResultNotice, setDeleteResultNotice] = useState<DeleteResultNotice | null>(null);
  const [deletePreparing, setDeletePreparing] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteToast, setDeleteToast] = useState<string | null>(null);
  const deleteInfoRequestRef = useRef(0);
  const deleteInfoAbortRef = useRef<AbortController | null>(null);
  const deleteCalculationProgressRef = useRef<CalculationProgressStore | null>(null);
  const [deleteVerificationProgress, setDeleteVerificationProgress] = useState<CalculationProgressStore | null>(null);
  const deleteToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deleteOperationGuardRef = useRef(new SingleFlightGuard());
  const deletionPolicyRef = useRef({ enabled: settings.deletionEnabled, revision: 0 });
  useLayoutEffect(() => {
    if (deletionPolicyRef.current.enabled === settings.deletionEnabled) return;
    deletionPolicyRef.current = { enabled: settings.deletionEnabled, revision: deletionPolicyRef.current.revision + 1 };
  }, [settings.deletionEnabled]);
  useEffect(() => {
    if (settings.deletionEnabled) return;
    deleteInfoRequestRef.current++;
    deleteInfoAbortRef.current?.abort();
    deleteInfoAbortRef.current = null;
    deleteCalculationProgressRef.current?.dispose();
    setDeleteTarget(null);
    setDeleteResultNotice(null);
  }, [settings.deletionEnabled]);

  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryDefaultTab, setGalleryDefaultTab] = useState<GalleryCategory>('all');
  const repeatedAttachments = useAttachments(chat.chatData, chat.mediaState, { includeRepeated: true });
  const viewerLookup = useMemo(() => new Map([...repeatedAttachments.all, ...sharedLinks].map(item => [getNavigationItemKey(item), item])), [repeatedAttachments.all, sharedLinks]);
  const preview = location.preview;
  const viewerItems = useMemo(() => preview?.keys.map(key => viewerLookup.get(key)).filter((item): item is SelectableItem => !!item) ?? [], [preview?.keys, viewerLookup]);

  const { handleRef: sidebarHandleRef } = useResizable({
    enabled: !isMobile,
    minWidth: 260,
    maxWidthFraction: 0.55,
    maxWidthAbsolute: 640,
    initialWidth: settings.sidebarWidth,
    onWidthChange: (w) => setSetting('sidebarWidth', w as typeof settings.sidebarWidth),
    cssVariable: '--sidebar-width',
    minMainWidth: 320,
    layoutDependency: settings.infoPanelOpen,
    side: 'left',
  });

  const { handleRef: infoHandleRef } = useResizable({
    enabled: !isMobile,
    minWidth: 240,
    maxWidthFraction: 0.45,
    maxWidthAbsolute: 520,
    initialWidth: settings.infoPanelWidth,
    onWidthChange: (w) => setSetting('infoPanelWidth', w as typeof settings.infoPanelWidth),
    cssVariable: '--info-panel-width',
    minMainWidth: 320,
    layoutDependency: settings.infoPanelOpen,
    side: 'right',
  });

  const prepareDeleteTarget = useCallback((
    target: ChatListEntry | ChatListEntry[],
    preserveResult = false,
    skipSizes = false,
    forceOwnershipCheck = false,
    skipAttachmentCheck = false,
  ) => {
    if (!deletionPolicyRef.current.enabled) return;
    deleteCalculationProgressRef.current?.dispose();
    deleteInfoAbortRef.current?.abort();
    const abortCtrl = new AbortController();
    deleteInfoAbortRef.current = abortCtrl;
    const requestId = deleteInfoRequestRef.current + 1;
    deleteInfoRequestRef.current = requestId;
    const progress = new CalculationProgressStore();
    const isMessenger = (Array.isArray(target) ? target : [target]).some(entry => entry._messengerExport);
    progress.report(skipAttachmentCheck
      ? { stage: 'sizes', label: 'Calculating chat sizes', done: 0, unit: 'files' }
      : { stage: 'ownership', label: 'Scanning for shared attachments', done: 0,
        unit: isMessenger ? 'files' : 'folders', jsonFound: isMessenger ? undefined : 0 });
    deleteCalculationProgressRef.current = progress;
    setDeleteTarget(target);
    if (!preserveResult) setDeleteResultNotice(null);
    setDeletePreparing(false);
    setDeleteBusy(false);
    setDeletePreparation(current => ({
      status: 'loading', calculatingSizes: skipAttachmentCheck && !skipSizes, sizesSkipped: skipSizes,
      attachmentCheckSkipped: skipAttachmentCheck,
      info: !skipAttachmentCheck && preserveResult && 'info' in current ? current.info : undefined, progress,
    }));
    archive.getDeleteInfo(target, abortCtrl.signal, ownershipInfo => {
      if (deleteInfoRequestRef.current !== requestId) return;
      setDeletePreparation({ status: 'loading', info: ownershipInfo, calculatingSizes: !skipSizes, sizesSkipped: skipSizes, progress });
    }, { skipSizes, forceOwnershipCheck, skipAttachmentCheck, progress })
      .then(info => {
        if (deleteInfoRequestRef.current !== requestId) return;
        setDeletePreparation(skipSizes
          ? skipAttachmentCheck ? { status: 'unchecked', attachmentCheckSkipped: true } : { status: 'skipped', info }
          : { status: 'ready', info, attachmentCheckSkipped: skipAttachmentCheck });
        if (!skipSizes && !Array.isArray(target) && !target._messengerExport && target.folderSize <= 0) {
          archive.updateFolderSize(target, info.totalSize - (info.stickerSize || 0));
        }
      })
      .catch(error => {
        if (deleteInfoRequestRef.current !== requestId) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (error instanceof MessengerExportIndexIncompleteError) {
          setDeletePreparation({
            status: 'error',
            error: 'Media ownership could not be verified for every conversation.',
            mediaSafetyUnavailable: true,
          });
        } else if (error instanceof MessengerExportMediaSizeUnavailableError) {
          setDeletePreparation({
            status: 'error',
            error: 'Media byte totals could not be calculated. Ownership is verified, so deletion is still safe.',
            mediaSafetyUnavailable: false,
            info: error.safeInfo,
          });
        } else {
          setDeletePreparation(current => ({
            status: 'error',
            error: getErrorMessage(error),
            mediaSafetyUnavailable: false,
            info: 'info' in current ? current.info : undefined,
            attachmentCheckSkipped: skipAttachmentCheck,
          }));
        }
        console.error('Failed to prepare delete details:', error);
      })
      .finally(() => {
        progress.dispose();
        if (deleteInfoRequestRef.current !== requestId) return;
        if (deleteInfoAbortRef.current === abortCtrl) {
          deleteInfoAbortRef.current = null;
        }
      });
  }, [archive]);

  const handleDeleteRequest = useCallback((target: ChatListEntry | ChatListEntry[]) => {
    prepareDeleteTarget(target);
  }, [prepareDeleteTarget]);

  const handleDeleteConfirm = useCallback(async (mode: 'normal' | 'json-only' | 'override' | 'unchecked') => {
    if (!deleteTarget || !deletionPolicyRef.current.enabled) return;
    const policyRevision = deletionPolicyRef.current.revision;
    const assertPolicyCurrent = () => {
      if (!deletionPolicyRef.current.enabled || deletionPolicyRef.current.revision !== policyRevision) {
        throw new DOMException('Chat deletion was disabled or superseded.', 'AbortError');
      }
    };
    const jsonOnly = mode === 'json-only';
    const operationToken = deleteOperationGuardRef.current.tryBegin();
    if (!operationToken) return;
    const progressReporter = createProgressThrottle<DeleteProgress>(
      setDeleteProgress,
      75,
      progress => progress.stage
    );
    deleteCalculationProgressRef.current?.dispose();
    deleteInfoAbortRef.current?.abort();
    deleteInfoAbortRef.current = null;
    setDeleteResultNotice(null);
    setDeletePreparing(true);
    setDeleteProgress({ stage: 'preparing', done: 0, total: 0 });
    const verificationProgress = new CalculationProgressStore();
    setDeleteVerificationProgress(mode === 'normal' || mode === 'override' ? verificationProgress : null);
    deleteInfoRequestRef.current++;
    const targets = Array.isArray(deleteTarget) ? deleteTarget : [deleteTarget];
    let retryTargets: ChatListEntry[] | null = null;
    let sizeWorkSuspended = false;
    try {
      const permissionRoot = archive.originalRootHandle || archive.rootHandle;
      if (!permissionRoot || !await requestDirectoryWritePermission(permissionRoot)) {
        throw new DOMException('Write access is required to delete these chats.', 'NotAllowedError');
      }
      assertPolicyCurrent();
      sizeWorkSuspended = true;
      await archive.suspendSizeWork();
      assertPolicyCurrent();
      setDeletePreparing(false);
      setDeleteBusy(true);
      setDeleteProgress(null);
      const result = jsonOnly
        ? await archive.deleteMessengerChatsJsonOnly(targets, progress => {
            progressReporter.report(progress, progress.total > 0 && progress.done >= progress.total);
          })
        : await archive.deleteChats(targets, progress => {
            setDeleteVerificationProgress(null);
            progressReporter.report(progress, progress.total > 0 && progress.done >= progress.total);
          }, { allowSharedAttachmentLoss: mode === 'override', skipAttachmentCheck: mode === 'unchecked', verificationProgress });
      progressReporter.flush();

      let bookmarkCleanupError: string | undefined;
      const bookmarkCleanupEntries = getBookmarkCleanupEntries(result);
      if (bookmarkCleanupEntries.length > 0) {
        setDeleteProgress({ stage: 'bookmarks', done: 0, total: 1 });
        try {
          await bookmarks.removeForChats(bookmarkCleanupEntries);
        } catch (error) {
          bookmarkCleanupError = 'Chats were deleted, but their bookmarks could not be removed.';
          console.error(bookmarkCleanupError, error);
        } finally {
          setDeleteProgress({ stage: 'bookmarks', done: 1, total: 1 });
        }
      }

      if (chat.activeEntry && result.deleted.some(
        entry => getBookmarkChatId(entry) === getBookmarkChatId(chat.activeEntry!)
      )) {
        chat.clearChat();
        navigation.reset();
        selection.deselectAll();
      }

      for (const failure of result.failed) {
        console.error(`Failed to delete ${failure.entry.folderName}`, failure.error);
      }
      const resultMessage = formatBatchDeleteResult(result, jsonOnly);
      setDeleteToast(bookmarkCleanupError
        ? `${resultMessage}; bookmark cleanup failed`
        : resultMessage);
      if (deleteToastTimerRef.current) clearTimeout(deleteToastTimerRef.current);
      deleteToastTimerRef.current = setTimeout(() => setDeleteToast(null), 3200);

      const failedEntries = getDeleteRetryEntries(result);
      if (failedEntries.length > 0) {
        retryTargets = failedEntries;
        setDeleteResultNotice({
          message: resultMessage,
          failures: result.failed,
          bookmarkCleanupError,
        });
      } else {
        setDeleteTarget(null);
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        console.error('Delete failed:', error);
        const message = error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'Write access was not granted. The chats were not deleted.'
          : `Deletion failed: ${getErrorMessage(error)}`;
        setDeleteResultNotice({ message, failures: [] });
      }
    } finally {
      if (sizeWorkSuspended) archive.resumeSizeWork();
      progressReporter.cancel();
      verificationProgress.dispose();
      setDeleteVerificationProgress(null);
      deleteOperationGuardRef.current.finish(operationToken);
      setDeletePreparing(false);
      setDeleteBusy(false);
      setDeleteProgress(null);
    }

    if (retryTargets && retryTargets.length > 0) {
      const retryTarget = retryTargets.length === 1 ? retryTargets[0] : retryTargets;
      prepareDeleteTarget(retryTarget, true);
    }
  }, [deleteTarget, archive, bookmarks, chat, selection, prepareDeleteTarget, navigation]);

  const loadChatEntry = useCallback(async (entry: ChatListEntry) => {
    await archive.suspendSizeWork();
    try {
      await chat.loadChat(
        entry,
        archive.rootHandle,
        archive.archivePerspectiveKey,
        archive.archivePerspectiveName
      );
    } finally {
      archive.resumeSizeWork();
    }
  }, [archive, chat]);

  const handleSelectChat = useCallback(async (entry: ChatListEntry) => {
    navigation.navigate({ ...navigation.getState().location, screen: 'chat', chatId: getBookmarkChatId(entry),
      preview: undefined, messageTarget: undefined, attachmentTarget: undefined });
    setGalleryOpen(false);
    if (chat.activeEntry && getBookmarkChatId(chat.activeEntry) === getBookmarkChatId(entry) && chat.chatData) return;
    // Paint the loading view before pausing background work or reading chat files.
    await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    if (navigation.getState().location.chatId !== getBookmarkChatId(entry)) return;
    await loadChatEntry(entry);
  }, [navigation, loadChatEntry, chat.activeEntry, chat.chatData]);

  useEffect(() => {
    return () => {
      deleteInfoAbortRef.current?.abort();
      if (deleteToastTimerRef.current) clearTimeout(deleteToastTimerRef.current);
    };
  }, []);

  const handleOpenFolder = useCallback(async () => {
    const picked = await archive.openFolder(
      settings.deletionEnabled || settings.attachmentBookmarkingEnabled,
      () => {
        setActiveTab('chats');
        setSidebarView('chats');
        deleteInfoAbortRef.current?.abort();
        deleteInfoAbortRef.current = null;
        chat.clearChat();
        search.clearSearch();
        search.clearWideSearchCache();
        selection.deselectAll();
        setGalleryOpen(false);
        navigation.reset();
      },
      settings.folderAccessMode,
    );
    if (picked) {
      deleteInfoRequestRef.current++;
      setDeleteTarget(null);
      setDeletePreparation({ status: 'loading', calculatingSizes: false });
      setDeleteResultNotice(null);
      setDeletePreparing(false);
      setDeleteBusy(false);
      setDeleteProgress(null);
    }
  }, [settings.deletionEnabled, settings.attachmentBookmarkingEnabled, settings.folderAccessMode, archive, chat, search, selection, navigation]);

  const handleAttachmentBookmarkingChange = useCallback(async (enabled: boolean): Promise<boolean> => {
    if (!enabled) {
      setSetting('attachmentBookmarkingEnabled', false);
      return true;
    }
    if (!isFileSystemAccessSupported()) return false;
    const handle = archive.originalRootHandle || archive.rootHandle;
    if (handle && !await requestDirectoryWritePermission(handle)) return false;
    setSetting('attachmentBookmarkingEnabled', true);
    return true;
  }, [archive.originalRootHandle, archive.rootHandle, setSetting]);

  const chatViewRef = useRef<ChatViewHandle>(null);
  const chatScrollContainerRef = useMemo(() => ({ get current() { return chatViewRef.current?.getChatContainer() ?? null; } }), []);
  const pendingJumpCompletion = useRef<{ revision: number; resolve: () => void; options?: MessageJumpOptions } | null>(null);
  const pendingDateBrowse = useRef<{ data: typeof chat.chatData; index: number } | null>(null);

  const handleBrowseToMessage = useCallback((index: number) => {
    pendingDateBrowse.current = { data: chat.chatData, index };
  }, [chat.chatData]);

  const handleJumpToMessage = useCallback(async (index: number, folderName?: string, options?: MessageJumpOptions) => {
    const entry = folderName ? archiveList.find(entry => entry.folderName === folderName) : chat.activeEntry;
    if (!entry) return;
    pendingDateBrowse.current = null;
    const previousRevision = navigation.getState().revision;
    const source = navigation.getState().location;
    const fromAttachment = source.screen === 'gallery' || source.screen === 'selected' || !!source.preview;
    navigation.navigate({ ...source, screen: 'chat', chatId: getBookmarkChatId(entry),
      preview: undefined, messageTarget: index, attachmentTarget: undefined },
      ENABLE_CONTEXTUAL_BACK_NAVIGATION && fromAttachment ? 'attachment' : undefined);
    const revision = navigation.getState().revision;
    if (revision === previousRevision) {
      await chatViewRef.current?.jumpToMessage(index, options);
      return;
    }
    pendingJumpCompletion.current?.resolve();
    const completion = new Promise<void>(resolve => { pendingJumpCompletion.current = { revision, resolve, options }; });
    setGalleryOpen(false);
    if (getBookmarkChatId(entry) !== (chat.activeEntry ? getBookmarkChatId(chat.activeEntry) : undefined)) {
      await loadChatEntry(entry);
    }
    await completion;
  }, [archiveList, chat.activeEntry, loadChatEntry, navigation]);

  const handleChatMessageJump = useCallback((index: number, options?: MessageJumpOptions) => (
    handleJumpToMessage(index, undefined, options)
  ), [handleJumpToMessage]);

  const prevChatDataRef = useRef(chat.chatData);
  useEffect(() => {
    if (chat.chatData && chat.chatData !== prevChatDataRef.current) selection.deselectAll();
    prevChatDataRef.current = chat.chatData;
  }, [chat.chatData, selection]);

  const handleOpenGallery = useCallback((tab?: string) => {
    const nextTab = (tab as GalleryCategory | undefined) ?? galleryDefaultTab;
    navigation.navigate({ ...navigation.getState().location, screen: 'gallery', galleryTab: nextTab,
      preview: undefined, messageTarget: undefined, attachmentTarget: undefined });
    setGalleryDefaultTab(nextTab);
    setGalleryOpen(true);
  }, [galleryDefaultTab, navigation]);

  const handleJumpToAttachment = useCallback((item: SelectableItem) => {
    const tab = getAttachmentJumpTab(galleryDefaultTab, item.category);
    const source = navigation.getState().location;
    navigation.navigate({ ...source, screen: 'gallery', galleryTab: tab,
      preview: undefined, messageTarget: undefined, attachmentTarget: getNavigationItemKey(item) },
      ENABLE_CONTEXTUAL_BACK_NAVIGATION && (source.screen === 'chat' || source.preview?.source === 'chat') ? 'message' : undefined);
    setGalleryDefaultTab(tab);
    setGalleryOpen(true);
  }, [galleryDefaultTab, navigation]);

  const handleSidebarViewChange = useCallback((view: SidebarView) => {
    const destination = { ...navigation.getState().location, screen: 'home' as const, sidebarView: view,
      chatListView: view === 'settings' ? navigation.getState().location.chatListView : view,
      preview: undefined, messageTarget: undefined, attachmentTarget: undefined };
    if (isMobile) navigation.navigate(destination);
    else navigation.update(destination);
    setSidebarView(view);
  }, [isMobile, navigation]);

  const handleInfo = useCallback(() => {
    if (isMobile) navigation.navigate({ ...navigation.getState().location, screen: 'info', preview: undefined,
      messageTarget: undefined, attachmentTarget: undefined });
    else {
      setSetting('infoPanelOpen', !settings.infoPanelOpen);
      navigation.update({ ...navigation.getState().location, screen: settings.infoPanelOpen ? (galleryOpen ? 'gallery' : 'chat') : 'info' });
    }
  }, [isMobile, navigation, setSetting, settings.infoPanelOpen, galleryOpen]);

  const openViewer = useCallback((request: PreviewRequest) => {
    if (!isMobile) navigation.update({ ...navigation.getState().location, screen: request.source === 'selected' ? 'gallery' : request.source });
    navigation.openPreview(request);
  }, [isMobile, navigation]);
  const updateViewerItem = useCallback((item: SelectableItem) => navigation.updatePreview(item), [navigation]);
  const closeViewer = useCallback(() => navigation.closePreview(), [navigation]);
  const parent = useCallback(() => navigation.parent(), [navigation]);

  const sidebarScrollElement = () => document.querySelector<HTMLElement>('#sidebar .sidebar-scroll-region')
    ?? document.querySelector<HTMLElement>('#sidebar .settings');
  navigation.capture = (): NavigationSnapshot => ({
    ...chatViewRef.current?.captureSnapshot(),
    sidebarScroll: sidebarScrollElement()?.scrollTop,
    infoScroll: document.querySelector<HTMLElement>('#chatInfoPanel .info-panel-content')?.scrollTop,
    selectedScroll: document.querySelector<HTMLElement>('.selection-panel-content')?.scrollTop,
  });

  const appliedRevisionRef = useRef(-1);
  const startedRevisionRef = useRef(-1);
  const loadedRestorationRef = useRef(-1);
  const [attachmentJumpTarget, setAttachmentJumpTarget] = useState<import('./components/AttachmentGallery/AttachmentGallery').AttachmentJumpTarget | null>(null);
  useLayoutEffect(() => {
    const { location: destination, snapshot, revision, restoring } = navigationState;
    if (pendingDateBrowse.current?.data !== chat.chatData) pendingDateBrowse.current = null;
    if (appliedRevisionRef.current === revision) return;
    if (startedRevisionRef.current !== revision) {
      if (pendingJumpCompletion.current && pendingJumpCompletion.current.revision !== revision) {
        pendingJumpCompletion.current.resolve();
        pendingJumpCompletion.current = null;
      }
      startedRevisionRef.current = revision;
      chatViewRef.current?.cancelJump();
      setAttachmentJumpTarget(null);
    }
    if (sidebarView !== destination.sidebarView) {
      setSidebarView(destination.sidebarView);
      setActiveTab(destination.sidebarView === 'settings' ? 'settings' : 'chats');
      return;
    }
    setSidebarView(destination.sidebarView);
    setActiveTab(destination.sidebarView === 'settings' ? 'settings' : 'chats');
    const wantsGallery = destination.screen === 'gallery' || destination.screen === 'selected';
    if (galleryOpen !== wantsGallery) { setGalleryOpen(wantsGallery); return; }
    if (galleryDefaultTab !== destination.galleryTab) { setGalleryDefaultTab(destination.galleryTab); return; }
    if (destination.chatId) {
      const entry = archiveList.find(entry => getBookmarkChatId(entry) === destination.chatId);
      if (!entry) { navigation.reset(); return; }
      if (!chat.activeEntry || getBookmarkChatId(chat.activeEntry) !== destination.chatId) {
        if (restoring && loadedRestorationRef.current !== revision) {
          loadedRestorationRef.current = revision;
          void loadChatEntry(entry);
        }
        return;
      }
      if (chat.loading) return;
      if (!chat.chatData && destination.screen !== 'home' && destination.screen !== 'chat') {
        navigation.navigate({ ...destination, screen: 'chat', preview: undefined });
        return;
      }
    }
    appliedRevisionRef.current = revision;
    const dateBrowse = destination.screen === 'chat' && !destination.preview ? pendingDateBrowse.current : null;
    if (dateBrowse) pendingDateBrowse.current = null;
    if (restoring && snapshot) {
      // A date selected in Info takes precedence over the chat position saved on entry.
      void chatViewRef.current?.restoreSnapshot(dateBrowse ? { ...snapshot, message: undefined } : snapshot);
      const sidebar = sidebarScrollElement();
      if (sidebar && snapshot.sidebarScroll !== undefined) sidebar.scrollTop = snapshot.sidebarScroll;
      const info = document.querySelector<HTMLElement>('#chatInfoPanel .info-panel-content');
      if (info && snapshot.infoScroll !== undefined) info.scrollTop = snapshot.infoScroll;
      const selected = document.querySelector<HTMLElement>('.selection-panel-content');
      if (selected && snapshot.selectedScroll !== undefined) selected.scrollTop = snapshot.selectedScroll;
    } else if (!destination.preview) {
      if (destination.messageTarget !== undefined && !dateBrowse) {
        const finish = () => {
          if (pendingJumpCompletion.current?.revision === revision) {
            pendingJumpCompletion.current.resolve();
            pendingJumpCompletion.current = null;
          }
        };
        const options = pendingJumpCompletion.current?.revision === revision ? pendingJumpCompletion.current.options : undefined;
        void chatViewRef.current?.jumpToMessage(destination.messageTarget, options).then(finish, finish);
      }
      if (destination.attachmentTarget) {
        const item = viewerLookup.get(destination.attachmentTarget);
        if (item) setAttachmentJumpTarget({ ...item, tab: destination.galleryTab });
      } else setAttachmentJumpTarget(null);
    }
    if (dateBrowse) void chatViewRef.current?.jumpToMessage(dateBrowse.index);
    if (isMobile) {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.closest('[inert]')) focused.blur();
      const activePanel = destination.screen === 'home' ? '#sidebar' : destination.screen === 'info' ? '#chatInfoPanel'
        : destination.screen === 'selected' ? '.selection-panel' : '.chat-container .chat-view-layer.active';
      const heading = document.querySelector<HTMLElement>(`${activePanel} h3, ${activePanel} .title-text`);
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    }
  }, [navigationState, archiveList, chat.activeEntry, chat.chatData, chat.loading, galleryOpen, galleryDefaultTab, sidebarView, isMobile, loadChatEntry, navigation, viewerLookup]);

  const selectableItemsNewestFirst = useMemo(
    () => sortSelectableItemsNewestFirst([...attachments.all, ...sharedLinks]),
    [attachments.all, sharedLinks]
  );
  const selectedItems = selection.getSelectedItems(selectableItemsNewestFirst);

  return (
    <ReactionFeatureContext.Provider value={reactionFeature}>
    <ThreadDataContext.Provider value={navigatingChat ? null : chat.chatData}>
    <AttachmentReferencesContext.Provider value={attachmentReferences}>
    <div className={`container ${settings.infoPanelOpen ? 'info-open' : ''}`} data-mobile-screen={location.screen} inert={!!preview || undefined}>
      <Sidebar
        hidden={isMobile && location.screen !== 'home'}
        settings={settings}
        setSetting={setSetting}
        inboxList={archive.inboxList}
        archivedList={archive.archivedList}
        requestsList={archive.requestsList}
        activeEntry={chat.activeEntry}
        rootHandle={archive.rootHandle}
        originalRootHandle={archive.originalRootHandle}
        loading={archive.loading}
        folderSelectionPending={archive.folderSelectionPending}
        folderPreparationProgress={archive.folderPreparationProgress}
        loadProgress={archive.loadProgress}
        sizeProgress={archive.sizeProgress}
        attachmentReferenceScan={archive.attachmentReferenceScan}
        error={archive.error}
        sidebarView={sidebarView}
        setSidebarView={handleSidebarViewChange}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onSelectChat={handleSelectChat}
        onOpenFolder={handleOpenFolder}
        onDeleteChat={handleDeleteRequest}
        search={search}
        mediaState={chat.mediaState}
        selectedPerspective={chat.selectedPerspective}
        setSelectedPerspective={chat.setSelectedPerspective}
        onJumpToMessage={handleJumpToMessage}
        onAttachmentBookmarkingChange={handleAttachmentBookmarkingChange}
        bookmarkingEnabled={bookmarkingEnabled}
        pinnedChats={bookmarks.pinnedChats}
        bookmarkBusy={bookmarks.busy}
        isChatPinned={bookmarks.isChatPinned}
        onToggleChatPin={bookmarks.toggleChatPin}
        onSetChatsPinned={bookmarks.setChatsPinned}
      />

      <div
        className="sidebar-resize-handle"
        id="sidebarResizeHandle"
        ref={sidebarHandleRef}
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        tabIndex={0}
      />

      <ChatView
        ref={chatViewRef}
        mobile={isMobile}
        hidden={isMobile && location.screen !== 'chat' && location.screen !== 'gallery'}
        viewerOpen={!!preview}
        onBack={parent}
        onOpenSelection={() => navigation.navigate({ ...location, screen: 'selected', preview: undefined })}
        onOpenViewer={openViewer}
        onNavigateToMessage={handleChatMessageJump}
        onNavigateToAttachment={handleJumpToAttachment}
        attachmentJumpTarget={attachmentJumpTarget}
        onAttachmentJumpHandled={() => setAttachmentJumpTarget(null)}
        activeEntry={viewEntry}
        mediaState={chat.mediaState}
        msgProgress={navigatingChat ? 0 : chat.msgProgress}
        msgStatusText={navigatingChat ? 'Loading messages' : chat.msgStatusText}
        chatError={chat.error}
        selectedPerspective={chat.selectedPerspective}
        settings={settings}
        loading={chat.loading || navigatingChat}
        infoPanelOpen={settings.infoPanelOpen}
        onToggleInfoPanel={handleInfo}
        search={search}
        onSelectPerspective={chat.setSelectedPerspective}
        galleryOpen={galleryOpen}
        galleryDefaultTab={galleryDefaultTab}
        onGalleryTabChange={tab => { setGalleryDefaultTab(tab); navigation.update({ ...navigation.getState().location, galleryTab: tab }); }}
        onOpenGallery={handleOpenGallery}
        onCloseGallery={() => { if (isMobile) parent(); else { setGalleryOpen(false); navigation.navigate({ ...location, screen: 'chat', preview: undefined, messageTarget: undefined, attachmentTarget: undefined }); } }}
        selection={selection}
        attachmentBookmarkingEnabled={bookmarkingEnabled}
        bookmarks={bookmarks}
      />

      <div
        className="info-resize-handle"
        id="infoResizeHandle"
        ref={infoHandleRef}
        role="separator"
        aria-label="Resize info panel"
        aria-orientation="vertical"
        tabIndex={0}
      />

      {(isMobile || settings.infoPanelOpen) && (
        (!isMobile && galleryOpen && selection.selectedCount > 0 && chat.chatData && !navigatingChat) ? (
          <SelectionPanel
            activeEntry={viewEntry}
            chatData={chat.chatData}
            mediaState={chat.mediaState}
            selectedItems={selectedItems}
            onDeselect={selection.toggle}
            onOpenViewer={index => openViewer({ items: [...selectedItems], index, source: 'selected', selectionMode: true, selectedNavigation: true })}
            onClearSelection={selection.deselectAll}
            useDateFilenames={settings.dateAttachmentFilenames}
            filenameTemplate={settings.attachmentFilenameTemplate}
            allowLongFilenames={settings.longAttachmentFilenames}
            attachmentBookmarkingEnabled={bookmarkingEnabled}
            bookmarks={bookmarks}
          />
        ) : (
          <InfoPanel
            debuggingEnabled={settings.debuggingEnabled}
            dateNavigation={isMobile ? <DateNavigator settings={settings} onJumpToMessage={handleJumpToMessage} onBrowseToMessage={handleBrowseToMessage} chatContainerRef={chatScrollContainerRef} mobile embedded /> : undefined}
            onBack={isMobile ? parent : undefined}
            hidden={isMobile && location.screen !== 'info'}
            activeEntry={viewEntry}
            mediaState={chat.mediaState}
            selectedPerspective={chat.selectedPerspective}
            onSelectPerspective={chat.setSelectedPerspective}
            onOpenGallery={handleOpenGallery}
            header={!isMobile && !galleryOpen && selection.selectedCount > 0 && chat.chatData ? (
              <SelectionHeader
                activeEntry={chat.activeEntry}
                chatData={chat.chatData}
                mediaState={chat.mediaState}
                selectedItems={selectedItems}
                onClearSelection={selection.deselectAll}
                useDateFilenames={settings.dateAttachmentFilenames}
                filenameTemplate={settings.attachmentFilenameTemplate}
                allowLongFilenames={settings.longAttachmentFilenames}
                attachmentBookmarkingEnabled={bookmarkingEnabled}
                bookmarks={bookmarks}
              />
            ) : undefined}
          />
        )
      )}

      {isMobile && chat.chatData && !navigatingChat && (
        <SelectionPanel
          onBack={parent}
          hidden={location.screen !== 'selected'}
          activeEntry={chat.activeEntry}
          chatData={chat.chatData}
          mediaState={chat.mediaState}
          selectedItems={selectedItems}
          onDeselect={selection.toggle}
          onOpenViewer={index => openViewer({ items: [...selectedItems], index, source: 'selected', selectionMode: true, selectedNavigation: true })}
          onClearSelection={selection.deselectAll}
          useDateFilenames={settings.dateAttachmentFilenames}
          filenameTemplate={settings.attachmentFilenameTemplate}
          allowLongFilenames={settings.longAttachmentFilenames}
          attachmentBookmarkingEnabled={bookmarkingEnabled}
          bookmarks={bookmarks}
        />
      )}

      {isMobile && location.screen === 'selected' && (!chat.chatData || navigatingChat) && (
        <div className="chat-info-panel selection-panel">
          <div className="mobile-page-header">
            <ParentBackButton destination="attachments" ariaLabel="Back to attachments" onClick={parent} />
            <h3>Selected attachments</h3>
          </div>
          <p className="info-empty" role="status">Loading selected attachments...</p>
        </div>
      )}

      {deleteTarget && (
        <DeleteConfirmModal
          entry={deleteTarget}
          onConfirm={() => handleDeleteConfirm(deletePreparation.status === 'unchecked' || deletePreparation.attachmentCheckSkipped ? 'unchecked' : 'normal')}
          onDeleteAnyway={() => handleDeleteConfirm('override')}
          onDeleteJsonOnly={() => handleDeleteConfirm('json-only')}
          onRetryCalculation={() => prepareDeleteTarget(deleteTarget, true)}
          onSkipCalculation={() => {
            deleteCalculationProgressRef.current?.dispose();
            deleteInfoAbortRef.current?.abort();
            deleteInfoAbortRef.current = null;
            deleteInfoRequestRef.current++;
            setDeleteResultNotice(null);
            setDeletePreparation(current => current.attachmentCheckSkipped
              ? { status: 'unchecked', attachmentCheckSkipped: true }
              : { status: 'skipped', info: 'info' in current ? current.info : undefined });
          }}
          onCheckAttachments={() => prepareDeleteTarget(deleteTarget, false, deletePreparation.status === 'skipped', true)}
          onSkipCheck={() => prepareDeleteTarget(deleteTarget, false, false, false, true)}
          onCancel={() => {
            if (!deleteProgress && !deleteBusy) {
              deleteCalculationProgressRef.current?.dispose();
              deleteInfoAbortRef.current?.abort();
              deleteInfoAbortRef.current = null;
              setDeleteTarget(null);
              setDeletePreparation({ status: 'loading', calculatingSizes: false });
              setDeleteResultNotice(null);
              deleteInfoRequestRef.current++;
            }
          }}
          progress={deleteProgress}
          preparation={deletePreparation}
          resultNotice={deleteResultNotice}
          preparingDeletion={deletePreparing}
          deleting={deleteBusy}
          verificationProgress={deleteVerificationProgress}
        />
      )}
      {preview && viewerItems.length > 0 && !chat.loading && !navigatingChat && (
        <MediaViewer
          key={navigationState.revision}
          mobile={isMobile}
          navigationVisible={settings.viewerNavigation === 'auto' ? !isMobile : settings.viewerNavigation === 'show'}
          onToggleNavigation={() => setSetting('viewerNavigation', (settings.viewerNavigation === 'auto' ? !isMobile : settings.viewerNavigation === 'show') ? 'hide' : 'show')}
          items={viewerItems}
          initialIndex={Math.max(0, viewerItems.findIndex(item => getNavigationItemKey(item) === preview.currentKey))}
          mediaState={chat.mediaState}
          onClose={closeViewer}
          onCurrentItemChange={updateViewerItem}
          onJumpToMessage={handleJumpToMessage}
          onJumpToAttachment={handleJumpToAttachment}
          selection={selection}
          selectionMode={preview.source === 'chat' ? selection.selectedCount > 0 : preview.selectionMode}
          reverseNavigation={preview.reverseNavigation}
          selectedNavigation={preview.selectedNavigation}
          useDateFilename={settings.dateAttachmentFilenames}
          chatTitle={chat.chatData?.title}
          filenameTemplate={settings.attachmentFilenameTemplate}
          allowLongFilenames={settings.longAttachmentFilenames}
          attachmentBookmarkingEnabled={bookmarkingEnabled}
          isBookmarked={item => !!chat.activeEntry && bookmarks.isItemBookmarked(chat.activeEntry, item)}
          onToggleBookmark={item => chat.activeEntry ? bookmarks.toggleItemBookmark(chat.activeEntry, item) : Promise.resolve()}
          bookmarkBusy={bookmarks.busy}
        />
      )}
      <div className="app-toast-stack">
        {ENABLE_CONTEXTUAL_BACK_NAVIGATION && navigationState.returnTo && !preview && <div className="jump-return-banner">
          <button type="button" className="jump-return-action" onClick={() => navigation.returnFromJump()}>
            <ArrowLeft size={16} />Return to {navigationState.returnTo.label}
          </button>
          <button type="button" className="jump-return-dismiss" aria-label="Dismiss return action" onClick={() => navigation.dismissJumpReturn()}><X size={16} /></button>
        </div>}
        {settings.offlineSupportEnabled && (
          <ReloadPrompt canAutoReload={!archive.rootHandle && !archive.loading} />
        )}
        {deleteToast && (
          <div className="delete-toast" role="status" aria-live="polite">
            {deleteToast}
          </div>
        )}
        {!deleteToast && bookmarks.error && (
          <div className="delete-toast bookmark-error-toast" role="status">
            <span>{bookmarks.error}</span>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={bookmarks.preparationFailed
                ? () => void bookmarks.retryPreparation().catch(() => {})
                : bookmarks.clearError}
            >
              {bookmarks.preparationFailed ? 'Retry' : 'Dismiss'}
            </button>
          </div>
        )}
      </div>
      <TrustModal settings={settings} setSetting={setSetting} />
    </div>
    </AttachmentReferencesContext.Provider>
    </ThreadDataContext.Provider>
    </ReactionFeatureContext.Provider>
  );
}
