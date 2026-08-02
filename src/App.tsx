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
  const search = useSearch(chat.chatData, archive.inboxList);

  const [sidebarView, setSidebarView] = useState<'chats' | 'settings' | 'archived' | 'requests'>('chats');
  const [activeTab, setActiveTab] = useState<'chats' | 'settings'>('chats');
  const [deleteTarget, setDeleteTarget] = useState<ChatListEntry | null>(null);

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
      await archive.deleteChat(deleteTarget);
      // If the deleted chat is currently open, clear the view
      if (chat.activeEntry?.folderName === deleteTarget.folderName) {
        chat.clearChat();
      }
    } catch (e) {
      console.error('Delete failed:', e);
    }
    setDeleteTarget(null);
  }, [deleteTarget, archive, chat]);

  // Open folder: if deletion is enabled, request write access automatically
  const handleOpenFolder = useCallback(async () => {
    await archive.openFolder(settings.deletionEnabled);
  }, [settings.deletionEnabled, archive]);

  // Ref to ChatView for scrolling/jumping
  const chatViewRef = useRef<ChatViewHandle>(null);

  const handleJumpToMessage = useCallback((index: number) => {
    chatViewRef.current?.jumpToMessage(index);
  }, []);

  // When chatData changes (new chat loaded), scroll to bottom
  const prevChatDataRef = useRef(chat.chatData);
  useEffect(() => {
    if (chat.chatData && chat.chatData !== prevChatDataRef.current) {
      // Scroll immediately to push last chunk into view (triggers IntersectionObserver render),
      // then re-scroll after the chunk has had time to actually render its content.
      chatViewRef.current?.scrollToBottom();
      setTimeout(() => chatViewRef.current?.scrollToBottom(), 50);
      setTimeout(() => chatViewRef.current?.scrollToBottom(), 200);
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
        loading={archive.loading}
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
        mediaState={chat.mediaState}
        mediaLoading={chat.mediaLoading}
        mediaProgress={chat.mediaProgress}
        msgProgress={chat.msgProgress}
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

      {/* Info panel */}
      <InfoPanel
        chatData={chat.chatData}
        mediaState={chat.mediaState}
        selectedPerspective={chat.selectedPerspective}
        onSelectPerspective={chat.setSelectedPerspective}
      />

      {/* Modals */}
      {deleteTarget && (
        <DeleteConfirmModal
          entry={deleteTarget}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
      <TrustModal settings={settings} setSetting={setSetting} />
    </div>
  );
}
