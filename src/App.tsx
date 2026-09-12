import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useSettings } from './hooks/useSettings';
import { useArchive } from './hooks/useArchive';
import { useChat } from './hooks/useChat';
import { useSearch } from './hooks/useSearch';
import { useResizable } from './hooks/useResizable';
import { sortSelectableItemsNewestFirst, useSelection } from './hooks/useSelection';
import { useAttachments, useSharedLinks } from './hooks/useAttachments';
import { useBookmarks } from './hooks/useBookmarks';
import { Sidebar } from './components/Sidebar/Sidebar';
import { ChatView, type ChatViewHandle } from './components/Chat/ChatView';
import { InfoPanel } from './components/InfoPanel/InfoPanel';
import { SelectionHeader, SelectionPanel } from './components/InfoPanel/SelectionPanel';
import { MediaViewer } from './components/MediaViewer/MediaViewer';
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
import { formatBatchDeleteResult } from './services/deletionResults';
import { requestDirectoryWritePermission } from './types/fileSystem';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected error occurred.';
}

export default function App() {
  const { settings, setSetting } = useSettings();
  const archive = useArchive();
  const chat = useChat();
  const archiveList = useMemo(
    () => [...archive.inboxList, ...archive.archivedList, ...archive.requestsList],
    [archive.inboxList, archive.archivedList, archive.requestsList]
  );
  const search = useSearch(chat.chatData, archiveList);
  const selection = useSelection();
  const attachments = useAttachments(chat.chatData, chat.mediaState);
  const sharedLinks = useSharedLinks(chat.chatData);
  const bookmarkingEnabled = settings.attachmentBookmarkingEnabled && isFileSystemAccessSupported();
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
  const deleteToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deleteOperationRef = useRef<symbol | null>(null);

  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryDefaultTab, setGalleryDefaultTab] = useState<GalleryCategory>('all');
  const [selectedViewer, setSelectedViewer] = useState<{ items: SelectableItem[]; index: number } | null>(null);

  const { handleRef: sidebarHandleRef } = useResizable({
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
    preserveResult = false
  ) => {
    deleteInfoAbortRef.current?.abort();
    const abortCtrl = new AbortController();
    deleteInfoAbortRef.current = abortCtrl;
    const requestId = deleteInfoRequestRef.current + 1;
    deleteInfoRequestRef.current = requestId;
    setDeleteTarget(target);
    if (!preserveResult) setDeleteResultNotice(null);
    setDeletePreparing(false);
    setDeleteBusy(false);
    const entries = Array.isArray(target) ? target : [target];
    const isMessenger = entries.some(entry => entry._messengerExport);
    setDeletePreparation({ status: 'loading', calculatingSizes: !isMessenger });
    archive.getDeleteInfo(target, abortCtrl.signal, ownershipInfo => {
      if (deleteInfoRequestRef.current !== requestId) return;
      setDeletePreparation({ status: 'loading', info: ownershipInfo, calculatingSizes: true });
    })
      .then(info => {
        if (deleteInfoRequestRef.current !== requestId) return;
        setDeletePreparation({ status: 'ready', info });
        if (!Array.isArray(target) && !target._messengerExport && target.folderSize <= 0) {
          archive.updateFolderSize(target, info.totalSize);
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
          setDeletePreparation({
            status: 'error',
            error: getErrorMessage(error),
            mediaSafetyUnavailable: false,
          });
        }
        console.error('Failed to prepare delete details:', error);
      })
      .finally(() => {
        if (deleteInfoRequestRef.current !== requestId) return;
        if (deleteInfoAbortRef.current === abortCtrl) {
          deleteInfoAbortRef.current = null;
        }
      });
  }, [archive]);

  const handleDeleteRequest = useCallback((target: ChatListEntry | ChatListEntry[]) => {
    prepareDeleteTarget(target);
  }, [prepareDeleteTarget]);

  const handleDeleteConfirm = useCallback(async (mode: 'normal' | 'json-only') => {
    if (!deleteTarget || deleteOperationRef.current) return;
    const jsonOnly = mode === 'json-only';
    const operationToken = Symbol('delete-confirm');
    deleteOperationRef.current = operationToken;
    deleteInfoAbortRef.current?.abort();
    deleteInfoAbortRef.current = null;
    setDeleteResultNotice(null);
    setDeletePreparing(true);
    setDeleteProgress({ stage: 'preparing', done: 0, total: 0 });
    deleteInfoRequestRef.current++;
    const targets = Array.isArray(deleteTarget) ? deleteTarget : [deleteTarget];
    let retryTargets: ChatListEntry[] | null = null;
    let sizeWorkSuspended = false;
    try {
      const permissionRoot = archive.originalRootHandle || archive.rootHandle;
      if (!permissionRoot || !await requestDirectoryWritePermission(permissionRoot)) {
        throw new DOMException('Write access is required to delete these chats.', 'NotAllowedError');
      }
      sizeWorkSuspended = true;
      await archive.suspendSizeWork();
      setDeletePreparing(false);
      setDeleteBusy(true);
      setDeleteProgress(null);
      const result = jsonOnly
        ? await archive.deleteMessengerChatsJsonOnly(targets, setDeleteProgress)
        : await archive.deleteChats(targets, setDeleteProgress);

      let bookmarkCleanupError: string | undefined;
      if (result.deleted.length > 0) {
        setDeleteProgress({ stage: 'bookmarks', done: 0, total: 1 });
        try {
          await bookmarks.removeForChats(result.deleted);
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
        selection.deselectAll();
      }

      for (const failure of result.failed) {
        console.error(`Failed to delete ${failure.entry.folderName}`, failure.error);
      }
      const resultMessage = formatBatchDeleteResult(result, jsonOnly);
      setDeleteToast(resultMessage);
      if (deleteToastTimerRef.current) clearTimeout(deleteToastTimerRef.current);
      deleteToastTimerRef.current = setTimeout(() => setDeleteToast(null), 3200);

      if (result.failed.some(failure => failure.partial)) {
        retryTargets = result.failed.map(failure => failure.entry);
        setDeleteResultNotice({
          message: resultMessage,
          failures: result.failed,
          bookmarkCleanupError,
        });
      } else {
        setDeleteTarget(null);
      }
    } catch (error) {
      console.error('Delete failed:', error);
      const message = error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'Write access was not granted. The chats were not deleted.'
        : `Deletion failed: ${getErrorMessage(error)}`;
      setDeleteResultNotice({ message, failures: [] });
    } finally {
      if (sizeWorkSuspended) archive.resumeSizeWork();
      if (deleteOperationRef.current === operationToken) deleteOperationRef.current = null;
      setDeletePreparing(false);
      setDeleteBusy(false);
      setDeleteProgress(null);
    }

    if (retryTargets && retryTargets.length > 0) {
      const retryTarget = retryTargets.length === 1 ? retryTargets[0] : retryTargets;
      prepareDeleteTarget(retryTarget, true);
    }
  }, [deleteTarget, archive, bookmarks, chat, selection, prepareDeleteTarget]);

  const handleSelectChat = useCallback(async (entry: ChatListEntry) => {
    setGalleryOpen(false);
    await archive.suspendSizeWork();
    try {
      await chat.loadChat(entry, archive.rootHandle);
    } finally {
      archive.resumeSizeWork();
    }
  }, [archive, chat]);

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
        pendingJumpIndexRef.current = null;
      }
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
  }, [settings.deletionEnabled, settings.attachmentBookmarkingEnabled, archive, chat, search, selection]);

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

  const pendingJumpIndexRef = useRef<number | null>(null);

  const handleJumpToMessage = useCallback((index: number, folderName?: string) => {
    if (folderName && folderName !== chat.activeEntry?.folderName) {
      const entry = archiveList.find(e => e.folderName === folderName);
      if (entry) {
        pendingJumpIndexRef.current = index;
        handleSelectChat(entry);
        selection.deselectAll();
        return;
      }
    }
    chatViewRef.current?.jumpToMessage(index);
  }, [chat, archiveList, handleSelectChat, selection]);

  const prevChatDataRef = useRef(chat.chatData);
  useEffect(() => {
    if (chat.chatData !== prevChatDataRef.current) setSelectedViewer(null);
    if (chat.chatData && chat.chatData !== prevChatDataRef.current) {
      setGalleryOpen(false);
      setSelectedViewer(null);
      selection.deselectAll();
      if (pendingJumpIndexRef.current !== null) {
        const idx = pendingJumpIndexRef.current;
        pendingJumpIndexRef.current = null;
        setTimeout(() => chatViewRef.current?.jumpToMessage(idx), 50);
        setTimeout(() => chatViewRef.current?.jumpToMessage(idx), 200);
      }
    }
    prevChatDataRef.current = chat.chatData;
  }, [chat.chatData, selection]);

  const handleOpenGallery = useCallback((tab?: string) => {
    if (tab) setGalleryDefaultTab(tab as GalleryCategory);
    setGalleryOpen(true);
  }, []);

  const selectableItemsNewestFirst = useMemo(
    () => sortSelectableItemsNewestFirst([...attachments.all, ...sharedLinks]),
    [attachments.all, sharedLinks]
  );
  const selectedItems = selection.getSelectedItems(selectableItemsNewestFirst);

  return (
    <div className={`container ${settings.infoPanelOpen ? 'info-open' : ''}`}>
      <Sidebar
        settings={settings}
        setSetting={setSetting}
        inboxList={archive.inboxList}
        archivedList={archive.archivedList}
        requestsList={archive.requestsList}
        activeEntry={chat.activeEntry}
        rootHandle={archive.rootHandle}
        originalRootHandle={archive.originalRootHandle}
        loading={archive.loading}
        loadProgress={archive.loadProgress}
        sizeProgress={archive.sizeProgress}
        error={archive.error}
        sidebarView={sidebarView}
        setSidebarView={setSidebarView}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onSelectChat={handleSelectChat}
        onOpenFolder={handleOpenFolder}
        onDeleteChat={handleDeleteRequest}
        search={search}
        chatData={chat.chatData}
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
        chatData={chat.chatData}
        activeEntry={chat.activeEntry}
        mediaState={chat.mediaState}
        msgProgress={chat.msgProgress}
        msgStatusText={chat.msgStatusText}
        chatError={chat.error}
        selectedPerspective={chat.selectedPerspective}
        settings={settings}
        loading={chat.loading}
        infoPanelOpen={settings.infoPanelOpen}
        onToggleInfoPanel={() => setSetting('infoPanelOpen', !settings.infoPanelOpen as typeof settings.infoPanelOpen)}
        search={search}
        onSelectPerspective={chat.setSelectedPerspective}
        galleryOpen={galleryOpen}
        galleryDefaultTab={galleryDefaultTab}
        onGalleryTabChange={setGalleryDefaultTab}
        onOpenGallery={handleOpenGallery}
        onCloseGallery={() => setGalleryOpen(false)}
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

      {settings.infoPanelOpen && (
        galleryOpen && selection.selectedCount > 0 && chat.chatData ? (
          <SelectionPanel
            activeEntry={chat.activeEntry}
            chatData={chat.chatData}
            mediaState={chat.mediaState}
            selectedItems={selectedItems}
            onDeselect={selection.toggle}
            onOpenViewer={index => setSelectedViewer({ items: [...selectedItems], index })}
            onClearSelection={selection.deselectAll}
            useDateFilenames={settings.dateAttachmentFilenames}
            filenameTemplate={settings.attachmentFilenameTemplate}
            allowLongFilenames={settings.longAttachmentFilenames}
            attachmentBookmarkingEnabled={bookmarkingEnabled}
            bookmarks={bookmarks}
          />
        ) : (
          <InfoPanel
            chatData={chat.chatData}
            activeEntry={chat.activeEntry}
            mediaState={chat.mediaState}
            selectedPerspective={chat.selectedPerspective}
            onSelectPerspective={chat.setSelectedPerspective}
            onOpenGallery={handleOpenGallery}
            header={!galleryOpen && selection.selectedCount > 0 && chat.chatData ? (
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

      {deleteTarget && (
        <DeleteConfirmModal
          entry={deleteTarget}
          onConfirm={() => handleDeleteConfirm('normal')}
          onDeleteJsonOnly={() => handleDeleteConfirm('json-only')}
          onRetryCalculation={() => prepareDeleteTarget(deleteTarget, true)}
          onSkipCalculation={() => {
            deleteInfoAbortRef.current?.abort();
            deleteInfoAbortRef.current = null;
            deleteInfoRequestRef.current++;
            setDeletePreparation({ status: 'skipped' });
          }}
          onCancel={() => {
            if (!deleteProgress && !deleteBusy) {
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
        />
      )}
      {selectedViewer && (
        <MediaViewer
          items={selectedViewer.items}
          initialIndex={selectedViewer.index}
          mediaState={chat.mediaState}
          onClose={() => setSelectedViewer(null)}
          onJumpToMessage={messageIndex => {
            setSelectedViewer(null);
            setGalleryOpen(false);
            setTimeout(() => chatViewRef.current?.jumpToMessage(messageIndex), 50);
          }}
          onJumpToAttachment={item => {
            setSelectedViewer(null);
            chatViewRef.current?.jumpToAttachment(item);
          }}
          selection={selection}
          selectionMode
          selectedNavigation
          useDateFilename={settings.dateAttachmentFilenames}
          chatTitle={chat.chatData?.title}
          filenameTemplate={settings.attachmentFilenameTemplate}
          allowLongFilenames={settings.longAttachmentFilenames}
          attachmentBookmarkingEnabled={bookmarkingEnabled}
          isBookmarked={item => !!chat.activeEntry && bookmarks.isItemBookmarked(chat.activeEntry, item)}
          onToggleBookmark={item => chat.activeEntry
            ? bookmarks.toggleItemBookmark(chat.activeEntry, item)
            : Promise.resolve()}
          bookmarkBusy={bookmarks.busy}
        />
      )}
      <div className="app-toast-stack">
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
  );
}
