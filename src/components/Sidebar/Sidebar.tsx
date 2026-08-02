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
  loading: boolean;
  sidebarView: 'chats' | 'settings' | 'archived' | 'requests';
  setSidebarView: (view: 'chats' | 'settings' | 'archived' | 'requests') => void;
  activeTab: 'chats' | 'settings';
  setActiveTab: (tab: 'chats' | 'settings') => void;
  onSelectChat: (entry: ChatListEntry) => Promise<void>;
  onOpenFolder: () => Promise<void>;
  onDeleteChat: (entry: ChatListEntry) => void;
  search: ReturnType<typeof useSearch>;
  chatData: MessengerThread | null;
  mediaState: MediaState;
  selectedPerspective: string;
  setSelectedPerspective: (name: string) => void;
  onJumpToMessage?: (index: number) => void;
}

export function Sidebar({
  settings, setSetting,
  inboxList, archivedList, requestsList,
  activeEntry, rootHandle, loading,
  sidebarView, setSidebarView,
  activeTab, setActiveTab,
  onSelectChat, onOpenFolder, onDeleteChat,
  search,
  chatData, mediaState: _mediaState,
  selectedPerspective, setSelectedPerspective,
  onJumpToMessage,
}: SidebarProps) {
  const isSubView = sidebarView === 'archived' || sidebarView === 'requests';

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
          <FolderPicker onOpenFolder={onOpenFolder} />
        )}
        {sidebarView === 'chats' && rootHandle && loading && (
          <div className="chat-list-loading">Loading chats...</div>
        )}
        {sidebarView === 'chats' && rootHandle && !loading && (
          <ChatList
            chatList={inboxList}
            activeEntry={activeEntry}
            onSelectChat={onSelectChat}
            onDeleteChat={onDeleteChat}
            deletionEnabled={settings.deletionEnabled}
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
            rootHandle={rootHandle}
          />
        )}

        {/* Archived view */}
        {sidebarView === 'archived' && (
          <ArchivedList
            chatList={archivedList}
            activeEntry={activeEntry}
            onSelectChat={onSelectChat}
            onDeleteChat={onDeleteChat}
            deletionEnabled={settings.deletionEnabled}
            onBack={() => { setSidebarView('chats'); setActiveTab('chats'); }}
            label="Archived Threads"
            emptyText="No archived chats found."
          />
        )}

        {/* Message Requests view */}
        {sidebarView === 'requests' && (
          <ArchivedList
            chatList={requestsList}
            activeEntry={activeEntry}
            onSelectChat={onSelectChat}
            onDeleteChat={onDeleteChat}
            deletionEnabled={settings.deletionEnabled}
            onBack={() => { setSidebarView('chats'); setActiveTab('chats'); }}
            label="Message Requests"
            emptyText="No message requests found."
          />
        )}
      </div>
    </div>
  );
}
