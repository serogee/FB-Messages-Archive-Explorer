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
import type { DeleteProgress } from './types/deletion';
import type { GalleryCategory } from './hooks/useAttachments';
import {
  MessengerExportIndexIncompleteError,
  type MessengerExportDeletionInfo,
} from './services/messengerExport';
import { isFileSystemAccessSupported } from './services/fileSystem';
import { getBookmarkChatId } from './services/bookmarks';
import { requestDirectoryWritePermission } from './types/fileSystem';

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
  const [deleteInfo, setDeleteInfo] = useState<MessengerExportDeletionInfo | null>(null);
  const [deleteInfoLoading, setDeleteInfoLoading] = useState(false);
  const [deleteInfoSkipped, setDeleteInfoSkipped] = useState(false);
  const [deleteMediaSafetyUnavailable, setDeleteMediaSafetyUnavailable] = useState(false);
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

  const handleDeleteConfirm = useCallback(async (jsonOnly = false) => {
    if (!deleteTarget || deleteOperationRef.current) return;
    const operationToken = Symbol('delete-confirm');
    deleteOperationRef.current = operationToken;
    deleteInfoAbortRef.current?.abort();
    deleteInfoAbortRef.current = null;
    setDeletePreparing(true);
    setDeleteProgress({ stage: 'preparing', done: 0, total: 0 });
    setDeleteInfoLoading(false);
    deleteInfoRequestRef.current++;
    const targets = Array.isArray(deleteTarget) ? deleteTarget : [deleteTarget];
    let bookmarkCleanupFailed = false;
    let sizeWorkSuspended = false;
    try {
      sizeWorkSuspended = true;
      await archive.suspendSizeWork();
      setDeletePreparing(false);
      setDeleteBusy(true);
      setDeleteProgress(null);
      const result = jsonOnly
        ? await archive.deleteMessengerChatsJsonOnly(targets, setDeleteProgress)
        : await archive.deleteChats(targets, setDeleteProgress);

      if (result.deleted.length > 0) {
        setDeleteProgress({ stage: 'bookmarks', done: 0, total: 1 });
        try {
          await bookmarks.removeForChats(result.deleted);
        } catch (error) {
          bookmarkCleanupFailed = true;
          console.error('Chats were deleted, but their bookmarks could not be removed:', error);
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
      const deletedCount = result.deleted.length;
      const failureCount = result.failed.length;
      let resultMessage = jsonOnly
        ? failureCount > 0
          ? `${deletedCount} of ${result.requested} chat JSON files deleted; media retained; ${failureCount} failed`
          : `${deletedCount} chat ${deletedCount === 1 ? 'JSON' : 'JSON files'} deleted; media retained`
        : failureCount > 0
          ? `${deletedCount} of ${result.requested} chats deleted; ${failureCount} failed`
          : `${deletedCount} ${deletedCount === 1 ? 'chat' : 'chats'} deleted`;
      if (bookmarkCleanupFailed) resultMessage += '; bookmark cleanup failed';
      setDeleteToast(resultMessage);
      if (deleteToastTimerRef.current) clearTimeout(deleteToastTimerRef.current);
      deleteToastTimerRef.current = setTimeout(() => setDeleteToast(null), 3200);
    } catch (e) {
      console.error('Delete failed:', e);
    } finally {
      if (sizeWorkSuspended) archive.resumeSizeWork();
      if (deleteOperationRef.current === operationToken) deleteOperationRef.current = null;
    }
    setDeletePreparing(false);
    setDeleteBusy(false);
    setDeleteProgress(null);
    setDeleteTarget(null);
    setDeleteInfo(null);
    setDeleteInfoLoading(false);
    setDeleteInfoSkipped(false);
    setDeleteMediaSafetyUnavailable(false);
    deleteInfoRequestRef.current++;
  }, [deleteTarget, archive, bookmarks, chat, selection]);

  const handleDeleteRequest = useCallback((target: ChatListEntry | ChatListEntry[]) => {
    deleteInfoAbortRef.current?.abort();
    const abortCtrl = new AbortController();
    deleteInfoAbortRef.current = abortCtrl;
    const requestId = deleteInfoRequestRef.current + 1;
    deleteInfoRequestRef.current = requestId;
    setDeleteTarget(target);
    setDeleteInfo(null);
    setDeleteInfoSkipped(false);
    setDeleteMediaSafetyUnavailable(false);
    setDeletePreparing(false);
    setDeleteBusy(false);

    setDeleteInfoLoading(true);
    archive.getDeleteInfo(target, abortCtrl.signal)
      .then(info => {
        if (deleteInfoRequestRef.current !== requestId) return;
        setDeleteInfo(info);
        if (!Array.isArray(target) && !target._messengerExport && target.folderSize <= 0) {
          archive.updateFolderSize(target, info.totalSize);
        }
      })
      .catch(error => {
        if (deleteInfoRequestRef.current !== requestId) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (error instanceof MessengerExportIndexIncompleteError) {
          setDeleteMediaSafetyUnavailable(true);
        }
        console.error('Failed to prepare delete details:', error);
      })
      .finally(() => {
        if (deleteInfoRequestRef.current !== requestId) return;
        if (deleteInfoAbortRef.current === abortCtrl) {
          deleteInfoAbortRef.current = null;
        }
        setDeleteInfoLoading(false);
      });
  }, [archive]);

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
      setDeleteInfo(null);
      setDeleteInfoLoading(false);
      setDeleteInfoSkipped(false);
      setDeleteMediaSafetyUnavailable(false);
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
          onConfirm={handleDeleteConfirm}
          onDeleteJsonOnly={() => handleDeleteConfirm(true)}
          onSkipCalculation={() => {
            deleteInfoAbortRef.current?.abort();
            deleteInfoAbortRef.current = null;
            deleteInfoRequestRef.current++;
            setDeleteInfoLoading(false);
            setDeleteInfoSkipped(true);
            setDeleteMediaSafetyUnavailable(false);
          }}
          onCancel={() => {
            if (!deleteProgress && !deleteBusy) {
              deleteInfoAbortRef.current?.abort();
              deleteInfoAbortRef.current = null;
              setDeleteTarget(null);
              setDeleteInfo(null);
              setDeleteInfoLoading(false);
              setDeleteInfoSkipped(false);
              setDeleteMediaSafetyUnavailable(false);
              deleteInfoRequestRef.current++;
            }
          }}
          progress={deleteProgress}
          messengerDeletionInfo={deleteInfo}
          deletionInfoLoading={deleteInfoLoading}
          deletionInfoSkipped={deleteInfoSkipped}
          mediaSafetyUnavailable={deleteMediaSafetyUnavailable}
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
          <button
            type="button"
            className="delete-toast"
            role="status"
            onClick={bookmarks.clearError}
            title="Dismiss"
          >
            {bookmarks.error}
          </button>
        )}
      </div>
      <TrustModal settings={settings} setSetting={setSetting} />
    </div>
  );
}
