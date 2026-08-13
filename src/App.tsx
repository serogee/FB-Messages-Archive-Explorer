import { useState, useCallback, useRef, useEffect } from 'react';
import { useSettings } from './hooks/useSettings';
import { useArchive } from './hooks/useArchive';
import { useChat } from './hooks/useChat';
import { useSearch } from './hooks/useSearch';
import { useResizable } from './hooks/useResizable';
import { Sidebar } from './components/Sidebar/Sidebar';
import { ChatView, type ChatViewHandle } from './components/Chat/ChatView';
import { InfoPanel } from './components/InfoPanel/InfoPanel';
import { TrustModal } from './components/Modals/TrustModal';
import { DeleteConfirmModal } from './components/Modals/DeleteConfirmModal';
import type { ChatListEntry } from './types/messenger';

export default function App() {
  const { settings, setSetting } = useSettings();
  const archive = useArchive();
  const chat = useChat();
  const search = useSearch(chat.chatData, [...archive.inboxList, ...archive.archivedList, ...archive.requestsList]);

  const [sidebarView, setSidebarView] = useState<'chats' | 'settings' | 'archived' | 'requests'>('chats');
  const [activeTab, setActiveTab] = useState<'chats' | 'settings'>('chats');
  const [deleteTarget, setDeleteTarget] = useState<ChatListEntry | ChatListEntry[] | null>(null);
  const [deleteProgress, setDeleteProgress] = useState<{ done: number; total: number } | null>(null);

  // Resizable sidebar
  const { handleRef: sidebarHandleRef } = useResizable({
    minWidth: 260,
    maxWidthFraction: 0.55,
    maxWidthAbsolute: 640,
    storageKey: 'sidebarWidth',
    initialWidth: settings.sidebarWidth,
    onWidthChange: (w) => setSetting('sidebarWidth', w as typeof settings.sidebarWidth),
    side: 'left',
  });

  // Resizable info panel
  const { handleRef: infoHandleRef } = useResizable({
    minWidth: 340,
    maxWidthFraction: 0.45,
    maxWidthAbsolute: 520,
    storageKey: 'infoPanelWidth',
    initialWidth: settings.infoPanelWidth,
    onWidthChange: (w) => setSetting('infoPanelWidth', w as typeof settings.infoPanelWidth),
    side: 'right',
  });

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      if (Array.isArray(deleteTarget)) {
        setDeleteProgress({ done: 0, total: deleteTarget.length });
        await archive.deleteChats(deleteTarget, (done, total) => {
          setDeleteProgress({ done, total });
        });
        
        // Clear view if active chat was deleted
        if (chat.activeEntry && deleteTarget.some(e => e.folderName === chat.activeEntry!.folderName)) {
          chat.clearChat();
        }
      } else {
        await archive.deleteChat(deleteTarget);
        if (chat.activeEntry?.folderName === deleteTarget.folderName) {
          chat.clearChat();
        }
      }
    } catch (e) {
      console.error('Delete failed:', e);
    }
    setDeleteProgress(null);
    setDeleteTarget(null);
  }, [deleteTarget, archive, chat]);

  // Open folder: if deletion is enabled, request write access automatically
  const handleOpenFolder = useCallback(async () => {
    await archive.openFolder(settings.deletionEnabled);
  }, [settings.deletionEnabled, archive]);

  // Ref to ChatView for scrolling/jumping
  const chatViewRef = useRef<ChatViewHandle>(null);

  const pendingJumpIndexRef = useRef<number | null>(null);

  const handleJumpToMessage = useCallback((index: number, folderName?: string) => {
    if (folderName && folderName !== chat.activeEntry?.folderName) {
      const entry = [...archive.inboxList, ...archive.archivedList, ...archive.requestsList].find(e => e.folderName === folderName);
      if (entry) {
        pendingJumpIndexRef.current = index;
        chat.loadChat(entry);
        return;
      }
    }
    chatViewRef.current?.jumpToMessage(index);
  }, [chat, archive]);

  // When chatData changes (new chat loaded), scroll to bottom
  const prevChatDataRef = useRef(chat.chatData);
  useEffect(() => {
    if (chat.chatData && chat.chatData !== prevChatDataRef.current) {
      if (pendingJumpIndexRef.current !== null) {
        const idx = pendingJumpIndexRef.current;
        pendingJumpIndexRef.current = null;
        setTimeout(() => chatViewRef.current?.jumpToMessage(idx), 50);
        setTimeout(() => chatViewRef.current?.jumpToMessage(idx), 200);
      }
    }
    prevChatDataRef.current = chat.chatData;
  }, [chat.chatData]);

  return (
    <div className={`container ${settings.infoPanelOpen ? 'info-open' : ''}`}>
      {/* Sidebar */}
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
        onSelectChat={chat.loadChat}
        onOpenFolder={handleOpenFolder}
        onDeleteChat={setDeleteTarget}
        search={search}
        chatData={chat.chatData}
        mediaState={chat.mediaState}
        selectedPerspective={chat.selectedPerspective}
        setSelectedPerspective={chat.setSelectedPerspective}
        onJumpToMessage={handleJumpToMessage}
      />

      {/* Sidebar resize handle */}
      <div
        className="sidebar-resize-handle"
        id="sidebarResizeHandle"
        ref={sidebarHandleRef}
        role="separator"
        aria-label="Resize sidebar"
        tabIndex={0}
      />

      {/* Chat view */}
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
      />

      {/* Info panel resize handle */}
      <div
        className="info-resize-handle"
        id="infoResizeHandle"
        ref={infoHandleRef}
        role="separator"
        aria-label="Resize info panel"
        tabIndex={0}
      />

      {settings.infoPanelOpen && (
        <InfoPanel
          chatData={chat.chatData}
          activeEntry={chat.activeEntry}
          mediaState={chat.mediaState}
          selectedPerspective={chat.selectedPerspective}
          onSelectPerspective={chat.setSelectedPerspective}
        />
      )}

      {/* Modals */}
      {deleteTarget && (
        <DeleteConfirmModal
          entry={deleteTarget}
          onConfirm={handleDeleteConfirm}
          onCancel={() => {
            if (!deleteProgress) setDeleteTarget(null);
          }}
          progress={deleteProgress}
        />
      )}
      <TrustModal settings={settings} setSetting={setSetting} />
    </div>
  );
}
