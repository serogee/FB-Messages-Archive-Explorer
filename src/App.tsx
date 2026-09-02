import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useSettings } from './hooks/useSettings';
import { useArchive } from './hooks/useArchive';
import { useChat } from './hooks/useChat';
import { useSearch } from './hooks/useSearch';
import { useResizable } from './hooks/useResizable';
import { useSelection } from './hooks/useSelection';
import { useAttachments } from './hooks/useAttachments';
import { Sidebar } from './components/Sidebar/Sidebar';
import { ChatView, type ChatViewHandle } from './components/Chat/ChatView';
import { InfoPanel } from './components/InfoPanel/InfoPanel';
import { SelectionHeader, SelectionPanel } from './components/InfoPanel/SelectionPanel';
import { TrustModal } from './components/Modals/TrustModal';
import { DeleteConfirmModal } from './components/Modals/DeleteConfirmModal';
import type { ChatListEntry } from './types/messenger';
import type { GalleryCategory } from './hooks/useAttachments';
import type { MessengerExportDeletionInfo } from './services/messengerExport';

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

  const [sidebarView, setSidebarView] = useState<'chats' | 'settings' | 'archived' | 'requests'>('chats');
  const [activeTab, setActiveTab] = useState<'chats' | 'settings'>('chats');
  const [deleteTarget, setDeleteTarget] = useState<ChatListEntry | ChatListEntry[] | null>(null);
  const [deleteProgress, setDeleteProgress] = useState<{ done: number; total: number } | null>(null);
  const [deleteInfo, setDeleteInfo] = useState<MessengerExportDeletionInfo | null>(null);
  const [deleteInfoLoading, setDeleteInfoLoading] = useState(false);
  const [deleteInfoSkipped, setDeleteInfoSkipped] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteToast, setDeleteToast] = useState<string | null>(null);
  const deleteInfoRequestRef = useRef(0);
  const deleteInfoAbortRef = useRef<AbortController | null>(null);
  const deleteToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryDefaultTab, setGalleryDefaultTab] = useState<GalleryCategory>('all');
  const [galleryHasOpened, setGalleryHasOpened] = useState(false);

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

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    deleteInfoAbortRef.current?.abort();
    deleteInfoAbortRef.current = null;
    setDeleteBusy(true);
    setDeleteInfoLoading(false);
    deleteInfoRequestRef.current++;
    const deletedName = Array.isArray(deleteTarget)
      ? `${deleteTarget.length} Chats`
      : deleteTarget.title;
    try {
      if (Array.isArray(deleteTarget)) {
        setDeleteProgress({ done: 0, total: deleteTarget.length });
        await archive.deleteChats(deleteTarget, (done, total) => {
          setDeleteProgress({ done, total });
        });
        
        if (chat.activeEntry && deleteTarget.some(e => e.folderName === chat.activeEntry!.folderName)) {
          chat.clearChat();
          selection.deselectAll();
        }
      } else {
        await archive.deleteChat(deleteTarget);
        if (chat.activeEntry?.folderName === deleteTarget.folderName) {
          chat.clearChat();
          selection.deselectAll();
        }
      }
      setDeleteToast(`${deletedName} Deleted`);
      if (deleteToastTimerRef.current) clearTimeout(deleteToastTimerRef.current);
      deleteToastTimerRef.current = setTimeout(() => setDeleteToast(null), 3200);
    } catch (e) {
      console.error('Delete failed:', e);
    }
    setDeleteBusy(false);
    setDeleteProgress(null);
    setDeleteTarget(null);
    setDeleteInfo(null);
    setDeleteInfoLoading(false);
    setDeleteInfoSkipped(false);
    deleteInfoRequestRef.current++;
  }, [deleteTarget, archive, chat, selection]);

  const handleDeleteRequest = useCallback((target: ChatListEntry | ChatListEntry[]) => {
    deleteInfoAbortRef.current?.abort();
    const abortCtrl = new AbortController();
    deleteInfoAbortRef.current = abortCtrl;
    const requestId = deleteInfoRequestRef.current + 1;
    deleteInfoRequestRef.current = requestId;
    setDeleteTarget(target);
    setDeleteInfo(null);
    setDeleteInfoSkipped(false);
    setDeleteBusy(false);

    setDeleteInfoLoading(true);
    archive.getDeleteInfo(target, abortCtrl.signal)
      .then(info => {
        if (deleteInfoRequestRef.current !== requestId) return;
        setDeleteInfo(info);
        if (!Array.isArray(target) && !target._messengerExport && target.folderSize <= 0) {
          archive.updateFolderSize(target, info.totalSize);
          return;
        }

        const entries = Array.isArray(target) ? target : [target];
        entries.forEach(entry => {
          if (entry.folderSize > 0 && (!entry._messengerExport || entry._sizeIncludesMedia)) return;
          void archive.computeAndUpdateFolderSize(entry).catch(error => {
            console.error('Failed to update chat size from delete details:', error);
          });
        });
      })
      .catch(error => {
        if (deleteInfoRequestRef.current !== requestId) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
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
    if (entry.folderSize <= 0 || (entry._messengerExport && !entry._sizeIncludesMedia)) {
      void archive.computeAndUpdateFolderSize(entry).catch(error => {
        console.error('Failed to calculate chat size:', error);
      });
    }
    archive.setSizeQueuePaused(true);
    try {
      await chat.loadChat(entry, archive.rootHandle);
    } finally {
      archive.setSizeQueuePaused(false);
    }
  }, [archive, chat]);

  useEffect(() => {
    return () => {
      deleteInfoAbortRef.current?.abort();
      if (deleteToastTimerRef.current) clearTimeout(deleteToastTimerRef.current);
    };
  }, []);

  const handleOpenFolder = useCallback(async () => {
    const picked = await archive.openFolder(settings.deletionEnabled, () => {
      setActiveTab('chats');
      setSidebarView('chats');
      deleteInfoAbortRef.current?.abort();
      deleteInfoAbortRef.current = null;
      chat.clearChat();
      search.clearSearch();
      search.clearWideSearchCache();
      selection.deselectAll();
      setGalleryOpen(false);
      setGalleryHasOpened(false);
      pendingJumpIndexRef.current = null;
    });
    if (picked) {
      deleteInfoRequestRef.current++;
      setDeleteTarget(null);
      setDeleteInfo(null);
      setDeleteInfoLoading(false);
      setDeleteInfoSkipped(false);
      setDeleteBusy(false);
      setDeleteProgress(null);
    }
  }, [settings.deletionEnabled, archive, chat, search, selection]);

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
    if (chat.chatData && chat.chatData !== prevChatDataRef.current) {
      setGalleryOpen(false);
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
    setGalleryHasOpened(true);
    setGalleryOpen(true);
  }, []);

  const selectedAttachments = selection.getSelectedAttachments(attachments.all);

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
        mediaLoading={chat.mediaLoading}
        mediaProgress={chat.mediaProgress}
        msgProgress={chat.msgProgress}
        msgStatusText={chat.msgStatusText}
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
        galleryHasOpened={galleryHasOpened}
        selection={selection}
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
            chatData={chat.chatData}
            mediaState={chat.mediaState}
            selectedAttachments={selectedAttachments}
            onDeselect={selection.toggle}
            onClearSelection={selection.deselectAll}
            useDateFilenames={settings.dateAttachmentFilenames}
            filenameTemplate={settings.attachmentFilenameTemplate}
            allowLongFilenames={settings.longAttachmentFilenames}
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
                chatData={chat.chatData}
                mediaState={chat.mediaState}
                selectedAttachments={selectedAttachments}
                onClearSelection={selection.deselectAll}
                useDateFilenames={settings.dateAttachmentFilenames}
                filenameTemplate={settings.attachmentFilenameTemplate}
                allowLongFilenames={settings.longAttachmentFilenames}
              />
            ) : undefined}
          />
        )
      )}

      {deleteTarget && (
        <DeleteConfirmModal
          entry={deleteTarget}
          onConfirm={handleDeleteConfirm}
          onSkipCalculation={() => {
            deleteInfoAbortRef.current?.abort();
            deleteInfoAbortRef.current = null;
            deleteInfoRequestRef.current++;
            setDeleteInfoLoading(false);
            setDeleteInfoSkipped(true);
          }}
          onCancel={() => {
            if (!deleteProgress && !deleteBusy) {
              deleteInfoAbortRef.current?.abort();
              deleteInfoAbortRef.current = null;
              setDeleteTarget(null);
              setDeleteInfo(null);
              setDeleteInfoLoading(false);
              setDeleteInfoSkipped(false);
              deleteInfoRequestRef.current++;
            }
          }}
          progress={deleteProgress}
          messengerDeletionInfo={deleteInfo}
          deletionInfoLoading={deleteInfoLoading}
          deletionInfoSkipped={deleteInfoSkipped}
          deleting={deleteBusy}
        />
      )}
      {deleteToast && (
        <div className="delete-toast" role="status" aria-live="polite">
          {deleteToast}
        </div>
      )}
      <TrustModal settings={settings} setSetting={setSetting} />
    </div>
  );
}
