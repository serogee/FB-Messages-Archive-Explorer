import { useState, useEffect, useMemo } from 'react';
import type { Settings } from '../../hooks/useSettings';
import type {
    ChatListEntry,
    MessengerThread,
    MediaState,
} from '../../types/messenger';
import type { ReadableDirectoryHandle } from '../../types/fileSystem';
import type { useSearch } from '../../hooks/useSearch';
import type { PinnedChatBookmark } from '../../services/bookmarks';
import { getBookmarkChatId } from '../../services/bookmarks';
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
    rootHandle: ReadableDirectoryHandle | null;
    originalRootHandle: ReadableDirectoryHandle | null;
    loading: boolean;
    loadProgress: { done: number; total: number } | null;
    sizeProgress: { done: number; total: number } | null;
    error: string | null;
    sidebarView: 'chats' | 'settings' | 'archived' | 'requests';
    setSidebarView: (
        view: 'chats' | 'settings' | 'archived' | 'requests',
    ) => void;
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
    onAttachmentBookmarkingChange: (enabled: boolean) => Promise<boolean>;
    bookmarkingEnabled: boolean;
    pinnedChats: PinnedChatBookmark[];
    bookmarkBusy: boolean;
    isChatPinned: (entry: ChatListEntry) => boolean;
    onToggleChatPin: (entry: ChatListEntry) => Promise<void>;
    onSetChatsPinned: (entries: ChatListEntry[], pinned: boolean) => Promise<void>;
}

export function Sidebar({
    settings,
    setSetting,
    inboxList,
    archivedList,
    requestsList,
    activeEntry,
    rootHandle,
    originalRootHandle,
    loading,
    loadProgress,
    sizeProgress,
    error,
    sidebarView,
    setSidebarView,
    activeTab,
    setActiveTab,
    onSelectChat,
    onOpenFolder,
    onDeleteChat,
    search,
    chatData,
    mediaState: _mediaState,
    selectedPerspective,
    setSelectedPerspective,
    onJumpToMessage,
    onAttachmentBookmarkingChange,
    bookmarkingEnabled,
    pinnedChats,
    bookmarkBusy,
    isChatPinned,
    onToggleChatPin,
    onSetChatsPinned,
}: SidebarProps) {
    const isSubView = sidebarView === 'archived' || sidebarView === 'requests';
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedChats, setSelectedChats] = useState<Set<string>>(new Set());

    const handleToggleSelectChat = (chatId: string, select: boolean) => {
        setSelectedChats((prev: Set<string>) => {
            const next = new Set(prev);
            if (select) next.add(chatId);
            else next.delete(chatId);
            return next;
        });
    };

    const allChats = useMemo(
        () => [...inboxList, ...archivedList, ...requestsList],
        [inboxList, archivedList, requestsList],
    );
    const allChatsById = useMemo(
        () => new Map(allChats.map(entry => [getBookmarkChatId(entry), entry])),
        [allChats],
    );
    const pinnedChatIds = useMemo(
        () => bookmarkingEnabled ? pinnedChats.map(pin => pin.id) : [],
        [bookmarkingEnabled, pinnedChats],
    );
    const pinnedIdSet = useMemo(() => new Set(pinnedChatIds), [pinnedChatIds]);
    const resolvedPinnedChats = useMemo(
        () => pinnedChatIds
            .map(id => allChatsById.get(id))
            .filter((entry): entry is ChatListEntry => !!entry),
        [allChatsById, pinnedChatIds],
    );
    const mainChatList = useMemo(
        () => bookmarkingEnabled
            ? [...resolvedPinnedChats, ...inboxList.filter(entry => !pinnedIdSet.has(getBookmarkChatId(entry)))]
            : inboxList,
        [bookmarkingEnabled, inboxList, pinnedIdSet, resolvedPinnedChats],
    );
    const extraFilterLists = useMemo(
        () => [
            {
                label: 'Archived Threads',
                list: bookmarkingEnabled
                    ? archivedList.filter(entry => !pinnedIdSet.has(getBookmarkChatId(entry)))
                    : archivedList,
            },
            {
                label: 'Message Requests',
                list: bookmarkingEnabled
                    ? requestsList.filter(entry => !pinnedIdSet.has(getBookmarkChatId(entry)))
                    : requestsList,
            },
        ],
        [archivedList, bookmarkingEnabled, pinnedIdSet, requestsList],
    );

    useEffect(() => {
        if (selectionMode) {
            const allChatIds = new Set(allChats.map(getBookmarkChatId));
            let changed = false;
            const nextSelected = new Set<string>();
            selectedChats.forEach((f) => {
                if (allChatIds.has(f)) {
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
        const targets = allChats.filter((c) => selectedChats.has(getBookmarkChatId(c)));
        if (targets.length > 0) {
            onDeleteChat(targets);
        }
    };

    const selectedEntries = useMemo(
        () => [...selectedChats]
            .map(id => allChatsById.get(id))
            .filter((entry): entry is ChatListEntry => !!entry),
        [allChatsById, selectedChats],
    );
    const allSelectedPinned = selectedEntries.length > 0 && selectedEntries.every(isChatPinned);

    const handleSetSelectedPinned = async () => {
        if (selectedEntries.length === 0) return;
        try {
            await onSetChatsPinned(selectedEntries, !allSelectedPinned);
        } catch {
            // The shared bookmark toast reports the write error; retain selection for retry.
        }
    };

    return (
        <div className="sub-container" id="sidebar">
            <div className="title-row">
                <div className="title-text">
                    <strong>
                        <span className="title-full">FB Messages Archive Explorer</span>
                        <span className="title-short">FB-MAE</span>
                    </strong>
                    <small className="footer">
                        By serogee |{' '}
                        <a href="https://github.com/serogee/FB-Messages-Archive-Explorer">
                            Src &amp; Usage
                        </a>
                    </small>
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

            <SearchBar search={search} onJumpToMessage={onJumpToMessage} />

            {!isSubView && (
                <div className="sidebar-tabs" role="tablist">
                    <button
                        className={`sidebar-tab ${activeTab === 'chats' ? 'active' : ''}`}
                        role="tab"
                        aria-selected={activeTab === 'chats'}
                        id="tab-chats"
                        onClick={() => {
                            setActiveTab('chats');
                            setSidebarView('chats');
                        }}
                    >
                        Chats
                    </button>
                    <button
                        className={`sidebar-tab ${activeTab === 'settings' ? 'active' : ''}`}
                        role="tab"
                        aria-selected={activeTab === 'settings'}
                        id="tab-settings"
                        onClick={() => {
                            setActiveTab('settings');
                            setSidebarView('settings');
                        }}
                    >
                        Settings
                    </button>
                </div>
            )}

            <div className="settings" role="tabpanel">
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
                    <div
                        className="chat-list-loading"
                        style={{ alignItems: 'stretch', padding: '32px 24px' }}
                    >
                        <div
                            style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                marginBottom: '12px',
                            }}
                        >
                            <span>Loading chats...</span>
                            {loadProgress && loadProgress.total > 0 && (
                                <span
                                    style={{
                                        fontSize: '13px',
                                        fontWeight: 500,
                                        color: 'var(--text)',
                                    }}
                                >
                                    {loadProgress.done} / {loadProgress.total}
                                </span>
                            )}
                        </div>
                        {loadProgress && loadProgress.total > 0 && (
                            <div
                                style={{
                                    width: '100%',
                                    height: '6px',
                                    background: 'var(--border)',
                                    borderRadius: '3px',
                                    overflow: 'hidden',
                                }}
                            >
                                <div
                                    style={{
                                        height: '100%',
                                        background: 'var(--accent)',
                                        width: `${Math.round((loadProgress.done / loadProgress.total) * 100)}%`,
                                    }}
                                />
                            </div>
                        )}
                    </div>
                )}
                {sidebarView === 'chats' && rootHandle && !loading && (
                    <ChatList
                        chatList={mainChatList}
                        extraFilterLists={extraFilterLists}
                        activeEntry={activeEntry}
                        sizeProgress={sizeProgress}
                        onSelectChat={onSelectChat}
                        onDeleteChat={onDeleteChat}
                        deletionEnabled={settings.deletionEnabled}
                        selectionMode={selectionMode}
                        selectedChats={selectedChats}
                        onToggleSelectChat={handleToggleSelectChat}
                        bookmarkingEnabled={bookmarkingEnabled}
                        pinnedChatIds={pinnedChatIds}
                        bookmarkBusy={bookmarkBusy}
                        onToggleChatPin={onToggleChatPin}
                    />
                )}

                {sidebarView === 'settings' && (
                    <SettingsPanel
                        settings={settings}
                        setSetting={setSetting}
                        chatData={chatData}
                        selectedPerspective={selectedPerspective}
                        setSelectedPerspective={setSelectedPerspective}
                        onOpenFolder={onOpenFolder}
                        rootHandle={originalRootHandle || rootHandle}
                        onAttachmentBookmarkingChange={onAttachmentBookmarkingChange}
                    />
                )}

                {sidebarView === 'archived' && (
                    <ArchivedList
                        chatList={archivedList}
                        activeEntry={activeEntry}
                        sizeProgress={sizeProgress}
                        onSelectChat={onSelectChat}
                        onDeleteChat={onDeleteChat}
                        deletionEnabled={settings.deletionEnabled}
                        onBack={() => {
                            setSidebarView('chats');
                            setActiveTab('chats');
                        }}
                        label="Archived Threads"
                        emptyText="No archived chats found."
                        selectionMode={selectionMode}
                        selectedChats={selectedChats}
                        onToggleSelectChat={handleToggleSelectChat}
                        bookmarkingEnabled={bookmarkingEnabled}
                        pinnedChatIds={pinnedChatIds}
                        bookmarkBusy={bookmarkBusy}
                        onToggleChatPin={onToggleChatPin}
                    />
                )}

                {sidebarView === 'requests' && (
                    <ArchivedList
                        chatList={requestsList}
                        activeEntry={activeEntry}
                        sizeProgress={sizeProgress}
                        onSelectChat={onSelectChat}
                        onDeleteChat={onDeleteChat}
                        deletionEnabled={settings.deletionEnabled}
                        onBack={() => {
                            setSidebarView('chats');
                            setActiveTab('chats');
                        }}
                        label="Message Requests"
                        emptyText="No message requests found."
                        selectionMode={selectionMode}
                        selectedChats={selectedChats}
                        onToggleSelectChat={handleToggleSelectChat}
                        bookmarkingEnabled={bookmarkingEnabled}
                        pinnedChatIds={pinnedChatIds}
                        bookmarkBusy={bookmarkBusy}
                        onToggleChatPin={onToggleChatPin}
                    />
                )}
            </div>

            {selectionMode && (
                <div className="sidebar-action-bar">
                    <span className="sidebar-selection-summary" aria-label={`${selectedChats.size} selected`}>
                        <span className="sidebar-selection-count">{selectedChats.size}</span>
                        <span className="sidebar-selection-label"> Selected</span>
                    </span>
                    <div className="sidebar-selection-actions">
                        {bookmarkingEnabled && (
                            <button
                                className="sidebar-action-btn pin"
                                onClick={() => void handleSetSelectedPinned()}
                                disabled={selectedEntries.length === 0 || bookmarkBusy}
                            >
                                {allSelectedPinned ? 'Unpin' : 'Pin'}
                            </button>
                        )}
                        <button
                            className="sidebar-action-btn cancel"
                            onClick={handleToggleSelectMode}
                        >
                            Cancel
                        </button>
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
