import { useState, useEffect, useMemo } from 'react';
import type { Settings } from '../../hooks/useSettings';
import type { ChatListEntry, MessengerThread, MediaState } from '../../types/messenger';
import type { useSearch } from '../../hooks/useSearch';
import { HeaderMenu } from './HeaderMenu';
import { SearchBar } from './SearchBar';
import { FolderPicker } from './FolderPicker';
import { ChatList } from './ChatList';
import { ArchivedList } from './ArchivedList';
import { SettingsPanel } from './SettingsPanel';

interface SidebarProps {
  settings: Settings;
  setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  inboxList: ChatListEntry[];
  archivedList: ChatListEntry[];
  requestsList: ChatListEntry[];
  activeEntry: ChatListEntry | null;
  rootHandle: FileSystemDirectoryHandle | null;
  originalRootHandle: FileSystemDirectoryHandle | null;
  loading: boolean;
  loadProgress: { done: number; total: number } | null;
  sizeProgress: { done: number; total: number } | null;
  error: string | null;
  sidebarView: 'chats' | 'settings' | 'archived' | 'requests';
  setSidebarView: (view: 'chats' | 'settings' | 'archived' | 'requests') => void;
  activeTab: 'chats' | 'settings';
  setActiveTab: (tab: 'chats' | 'settings') => void;
  onSelectChat: (entry: ChatListEntry) => Promise<void>;
  onOpenFolder: () => Promise<void>;
  onDeleteChat: (entry: ChatListEntry | ChatListEntry[]) => void;
  search: ReturnType<typeof useSearch>;
  chatData: MessengerThread | null;
  mediaState: MediaState;
  selectedPerspective: string;
  setSelectedPerspective: (name: string) => void;
  onJumpToMessage?: (index: number, folderName?: string) => void;
}

export function Sidebar({
  settings, setSetting,
  inboxList, archivedList, requestsList,
  activeEntry, rootHandle, originalRootHandle, loading, loadProgress, sizeProgress, error,
  sidebarView, setSidebarView,
  activeTab, setActiveTab,
  onSelectChat, onOpenFolder, onDeleteChat,
  search,
  chatData, mediaState: _mediaState,
  selectedPerspective, setSelectedPerspective,
  onJumpToMessage,
}: SidebarProps) {
  const isSubView = sidebarView === 'archived' || sidebarView === 'requests';
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedChats, setSelectedChats] = useState<Set<string>>(new Set());

  const handleToggleSelectChat = (folderName: string, select: boolean) => {
    setSelectedChats((prev: Set<string>) => {
      const next = new Set(prev);
      if (select) next.add(folderName);
      else next.delete(folderName);
      return next;
    });
  };

  const allChats = useMemo(
    () => [...inboxList, ...archivedList, ...requestsList],
    [inboxList, archivedList, requestsList]
  );
  const extraFilterLists = useMemo(
    () => [
      { label: 'Archived Threads', list: archivedList },
      { label: 'Message Requests', list: requestsList }
    ],
    [archivedList, requestsList]
  );

  useEffect(() => {
    if (selectionMode) {
      const allFolderNames = new Set(allChats.map(c => c.folderName));
      let changed = false;
      const nextSelected = new Set<string>();
      selectedChats.forEach(f => {
        if (allFolderNames.has(f)) {
          nextSelected.add(f);
        } else {
          changed = true;
        }
      });
      if (changed) {
        setSelectedChats(nextSelected);
        if (nextSelected.size === 0) {
          setSelectionMode(false);
        }
      }
    }
  }, [allChats, selectionMode, selectedChats]);

  const handleToggleSelectMode = () => {
    if (selectionMode) {
      setSelectionMode(false);
      setSelectedChats(new Set());
    } else {
      setSelectionMode(true);
    }
  };

  const handleDeleteSelected = () => {
    const targets = allChats.filter(c => selectedChats.has(c.folderName));
    if (targets.length > 0) {
      onDeleteChat(targets);
    }
  };

  return (
    <div className="sub-container" id="sidebar">
      {/* Title row */}
      <div className="title-row">
        <div className="title-text">
          <strong>FB Messages Archive Explorer</strong>
          <small className="footer">Browser-only · no data uploaded</small>
        </div>
        <HeaderMenu
          onViewArchived={() => setSidebarView('archived')}
          hasArchived={archivedList.length > 0}
          onViewRequests={() => setSidebarView('requests')}
          hasRequests={requestsList.length > 0}
          onToggleSelectMode={handleToggleSelectMode}
          selectionModeActive={selectionMode}
        />
      </div>
      <hr />

      {/* Search bar — persistent across all tabs */}
      <SearchBar search={search} onJumpToMessage={onJumpToMessage} />

      {/* Tab bar — hidden in sub-views */}
      {!isSubView && (
        <div className="sidebar-tabs" role="tablist">
          <button
            className={`sidebar-tab ${activeTab === 'chats' ? 'active' : ''}`}
            role="tab"
            aria-selected={activeTab === 'chats'}
            id="tab-chats"
            onClick={() => { setActiveTab('chats'); setSidebarView('chats'); }}
          >
            Chats
          </button>
          <button
            className={`sidebar-tab ${activeTab === 'settings' ? 'active' : ''}`}
            role="tab"
            aria-selected={activeTab === 'settings'}
            id="tab-settings"
            onClick={() => { setActiveTab('settings'); setSidebarView('settings'); }}
          >
            Settings
          </button>
        </div>
      )}

      {/* Tab content area */}
      <div className="settings" role="tabpanel">
        {/* Chats tab */}
        {sidebarView === 'chats' && !rootHandle && (
          <>
            <FolderPicker onOpenFolder={onOpenFolder} />
            {error && (
              <div className="sidebar-error-alert">
                <strong>Error:</strong> {error}
              </div>
            )}
          </>
        )}
        {sidebarView === 'chats' && rootHandle && loading && (
          <div className="chat-list-loading" style={{ alignItems: 'stretch', padding: '32px 24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <span>Loading chats...</span>
              {loadProgress && loadProgress.total > 0 && (
                <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text)' }}>
                  {loadProgress.done} / {loadProgress.total}
                </span>
              )}
            </div>
            {loadProgress && loadProgress.total > 0 && (
              <div style={{ width: '100%', height: '6px', background: 'var(--border)', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{ height: '100%', background: 'var(--accent)', width: `${Math.round((loadProgress.done / loadProgress.total) * 100)}%` }} />
              </div>
            )}
          </div>
        )}
        {sidebarView === 'chats' && rootHandle && !loading && (
          <ChatList
            chatList={inboxList}
            extraFilterLists={extraFilterLists}
            activeEntry={activeEntry}
            sizeProgress={sizeProgress}
            onSelectChat={onSelectChat}
            onDeleteChat={onDeleteChat}
            deletionEnabled={settings.deletionEnabled}
            selectionMode={selectionMode}
            selectedChats={selectedChats}
            onToggleSelectChat={handleToggleSelectChat}
          />
        )}

        {/* Settings tab */}
        {sidebarView === 'settings' && (
          <SettingsPanel
            settings={settings}
            setSetting={setSetting}
            chatData={chatData}
            selectedPerspective={selectedPerspective}
            setSelectedPerspective={setSelectedPerspective}
            onOpenFolder={onOpenFolder}
            rootHandle={originalRootHandle || rootHandle}
          />
        )}

        {/* Archived view */}
        {sidebarView === 'archived' && (
          <ArchivedList
            chatList={archivedList}
            activeEntry={activeEntry}
            sizeProgress={sizeProgress}
            onSelectChat={onSelectChat}
            onDeleteChat={onDeleteChat}
            deletionEnabled={settings.deletionEnabled}
            onBack={() => { setSidebarView('chats'); setActiveTab('chats'); }}
            label="Archived Threads"
            emptyText="No archived chats found."
            selectionMode={selectionMode}
            selectedChats={selectedChats}
            onToggleSelectChat={handleToggleSelectChat}
          />
        )}

        {/* Message Requests view */}
        {sidebarView === 'requests' && (
          <ArchivedList
            chatList={requestsList}
            activeEntry={activeEntry}
            sizeProgress={sizeProgress}
            onSelectChat={onSelectChat}
            onDeleteChat={onDeleteChat}
            deletionEnabled={settings.deletionEnabled}
            onBack={() => { setSidebarView('chats'); setActiveTab('chats'); }}
            label="Message Requests"
            emptyText="No message requests found."
            selectionMode={selectionMode}
            selectedChats={selectedChats}
            onToggleSelectChat={handleToggleSelectChat}
          />
        )}
      </div>
      
      {selectionMode && (
        <div className="sidebar-action-bar">
          <span style={{ fontSize: '13px', fontWeight: 600 }}>{selectedChats.size} Selected</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="sidebar-action-btn cancel" onClick={handleToggleSelectMode}>Cancel</button>
            <button 
              className="sidebar-action-btn delete" 
              onClick={handleDeleteSelected}
              disabled={selectedChats.size === 0}
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
