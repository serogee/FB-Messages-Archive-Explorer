import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { ChatListEntry } from '../../types/messenger';
import { formatRelativeTime, formatFileSize } from '../../services/storage';

interface ChatListProps {
  chatList: ChatListEntry[];
  activeEntry: ChatListEntry | null;
  onSelectChat: (entry: ChatListEntry) => Promise<void>;
  onDeleteChat: (entry: ChatListEntry) => void;
  deletionEnabled: boolean;
  sizeProgress?: { done: number; total: number } | null;
  extraFilterLists?: { label: string; list: ChatListEntry[] }[];
  selectionMode?: boolean;
  selectedChats?: Set<string>;
  onToggleSelectChat?: (folderName: string, select: boolean) => void;
}

interface ChatItemProps {
  entry: ChatListEntry;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
  deletionEnabled: boolean;
  selectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (e: React.MouseEvent | React.KeyboardEvent, select: boolean) => void;
}

function getAvatarChar(title: string): string {
  return (title || '?').trim().charAt(0).toUpperCase();
}

function getAvatarColor(title: string): string {
  const colors = [
    '#0084ff', '#44bec7', '#fa3c4c', '#d696bb',
    '#6d86d4', '#1da1f2', '#e75d5d', '#5bb974',
  ];
  let hash = 0;
  for (let i = 0; i < title.length; i++) hash = (hash * 31 + title.charCodeAt(i)) & 0xffffff;
  return colors[Math.abs(hash) % colors.length];
}

function formatEntrySize(entry: ChatListEntry): string {
  if (entry._messengerExport && !entry._sizeIncludesMedia) {
    return `${formatFileSize(entry.folderSize)} + media`;
  }

  if (entry.folderSize <= 0) {
    return `${entry.jsonFileCount} json + media`;
  }

  return formatFileSize(entry.folderSize);
}

async function copyFolderPath(entry: ChatListEntry) {
  // Build a human-readable path from the directory handle chain
  const subfolder =
    entry.source === 'inbox'    ? 'inbox' :
    entry.source === 'requests' ? 'message_requests' :
    entry.source === 'e2ee'     ? 'e2ee_cutover' :
    'archived_threads';
  const path = `messages/${subfolder}/${entry.folderName}`;
  try {
    await navigator.clipboard.writeText(path);
  } catch {
    // Fallback: show in a prompt
    window.prompt('Folder path:', path);
  }
}

function ChatItem({ entry, isActive, onSelect, onDelete, deletionEnabled, selectionMode, isSelected, onToggleSelect }: ChatItemProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  const showMenu = !selectionMode && (deletionEnabled || true); // Always show menu for "Open file location"

  const handleMenuClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!dropdownOpen) {
      const rect = e.currentTarget.getBoundingClientRect();
      // Drop up if there's less than 150px of space below the button
      if (window.innerHeight - rect.bottom < 150) {
        setDropUp(true);
      } else {
        setDropUp(false);
      }
    }
    setDropdownOpen(v => !v);
  };

  const handleClick = (e: React.MouseEvent) => {
    if (selectionMode && onToggleSelect) {
      onToggleSelect(e, !isSelected);
    } else {
      onSelect();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      if (selectionMode && onToggleSelect) {
        onToggleSelect(e, !isSelected);
      } else {
        onSelect();
      }
    }
  };

  return (
    <div
      className={`chat-list-item ${isActive && !selectionMode ? 'active' : ''} ${isSelected ? 'selected' : ''}`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {selectionMode && (
        <div className="chat-item-checkbox">
          <input 
            type="checkbox" 
            checked={!!isSelected} 
            readOnly 
            tabIndex={-1}
          />
        </div>
      )}
      <div
        className="chat-avatar"
        style={{ background: getAvatarColor(entry.title) }}
      >
        {getAvatarChar(entry.title)}
      </div>
      <div className="chat-item-body">
        <div className="chat-item-info">
          <div className="chat-item-title" title={entry.title}>{entry.title}</div>
          <div className="chat-item-preview">
            {entry.lastMessage || <em style={{ opacity: 0.5 }}>No messages</em>}
          </div>
        </div>
        <div className="chat-item-meta">
          <span className="chat-item-time">
            {entry.lastTimestamp ? formatRelativeTime(entry.lastTimestamp) : ''}
          </span>
          <span className="chat-item-size">
            {formatEntrySize(entry)}
          </span>
        </div>
        {showMenu && (
          <div className="chat-item-menu-wrap" ref={dropdownRef}>
            <button
              className="chat-item-menu-btn visible"
              title="Chat options"
              onClick={handleMenuClick}
              aria-label="Chat options"
            >
              &#8942;
            </button>
            {dropdownOpen && (
              <div className={`chat-item-dropdown${dropUp ? ' drop-up' : ''}`}>
                <button
                  onClick={e => { e.stopPropagation(); copyFolderPath(entry); setDropdownOpen(false); }}
                >
                  Copy folder path
                </button>
                {deletionEnabled && (
                  <button
                    className="danger"
                    onClick={e => { e.stopPropagation(); setDropdownOpen(false); onDelete(); }}
                  >
                    Delete chat
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function ChatList({ chatList, activeEntry, onSelectChat, onDeleteChat, deletionEnabled, sizeProgress, extraFilterLists, selectionMode, selectedChats, onToggleSelectChat }: ChatListProps) {
  const [filter, setFilter] = useState('');
  const [sortBy, setSortBy] = useState('recent');
  const lastSelectedRef = useRef<string | null>(null);

  const normalizedFilter = useMemo(() => filter.trim().toLowerCase(), [filter]);

  const applyFilterAndSort = useCallback((list: ChatListEntry[]) => {
    const filtered = filter.trim()
      ? list.filter(e => 
          e.title.toLowerCase().includes(normalizedFilter) ||
          e.folderName.toLowerCase().includes(normalizedFilter)
        )
      : [...list];

    filtered.sort((a, b) => {
      switch (sortBy) {
        case 'oldest':
          if (a.lastTimestamp == null && b.lastTimestamp == null) return 0;
          if (a.lastTimestamp == null) return 1;
          if (b.lastTimestamp == null) return -1;
          return a.lastTimestamp - b.lastTimestamp;
        case 'most_msgs':
          return (b.messageCount || b.jsonFileCount) - (a.messageCount || a.jsonFileCount);
        case 'least_msgs':
          return (a.messageCount || a.jsonFileCount) - (b.messageCount || b.jsonFileCount);
        case 'biggest_size':
          return b.folderSize - a.folderSize;
        case 'smallest_size':
          return a.folderSize - b.folderSize;
        case 'recent':
        default:
          if (a.lastTimestamp == null && b.lastTimestamp == null) return 0;
          if (a.lastTimestamp == null) return 1;
          if (b.lastTimestamp == null) return -1;
          return b.lastTimestamp - a.lastTimestamp;
      }
    });
    return filtered;
  }, [filter, normalizedFilter, sortBy]);

  const mainFiltered = useMemo(
    () => applyFilterAndSort(chatList),
    [applyFilterAndSort, chatList]
  );
  const extras = useMemo(() => normalizedFilter && extraFilterLists
    ? extraFilterLists.map(extra => ({
        label: extra.label,
        items: applyFilterAndSort(extra.list)
      })).filter(e => e.items.length > 0)
    : [],
    [applyFilterAndSort, extraFilterLists, normalizedFilter]
  );

  const sizeDisabled = !!sizeProgress;
  const sizeTitle = sizeProgress ? `Calculating sizes (${Math.round((sizeProgress.done / sizeProgress.total) * 100)}%)...` : undefined;

  const handleToggleSelect = (e: React.MouseEvent | React.KeyboardEvent, entry: ChatListEntry, select: boolean) => {
    if (!onToggleSelectChat) return;

    if (e.shiftKey && lastSelectedRef.current) {
      // Find the range in mainFiltered or extras
      const allDisplayed = [
        ...mainFiltered,
        ...extras.flatMap(extra => extra.items)
      ];
      
      const currentIndex = allDisplayed.findIndex(x => x.folderName === entry.folderName);
      const lastIndex = allDisplayed.findIndex(x => x.folderName === lastSelectedRef.current);
      
      if (currentIndex !== -1 && lastIndex !== -1) {
        const start = Math.min(currentIndex, lastIndex);
        const end = Math.max(currentIndex, lastIndex);
        
        for (let i = start; i <= end; i++) {
          onToggleSelectChat(allDisplayed[i].folderName, select);
        }
      } else {
        onToggleSelectChat(entry.folderName, select);
      }
    } else {
      onToggleSelectChat(entry.folderName, select);
    }
    
    lastSelectedRef.current = entry.folderName;
  };

  return (
    <>
      <div className="filter-row" style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: '1 1 auto', minWidth: 0, display: 'flex', gap: '6px', alignItems: 'center' }}>
          <input
            className="chat-list-filter"
            style={{ width: '100%' }}
            type="search"
            placeholder="Filter chats..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
            aria-label="Filter chats"
          />
          {filter && (
            <button
              className="sidebar-clear-btn"
              onClick={() => setFilter('')}
              aria-label="Clear filter"
              title="Clear filter"
            >
              X
            </button>
          )}
        </div>
        <select
          value={sortBy}
          onChange={e => setSortBy(e.target.value)}
          className="chat-list-sort"
          aria-label="Sort chats"
          style={{
            flex: '0 0 auto',
            padding: '6px',
            borderRadius: '6px',
            border: '1px solid var(--border)',
            background: 'var(--bg)',
            color: 'var(--text)',
            fontSize: '13px'
          }}
        >
          <option value="recent">Recent</option>
          <option value="oldest">Oldest</option>
          <option value="most_msgs">Most Msgs</option>
          <option value="least_msgs">Least Msgs</option>
          <option value="biggest_size" disabled={sizeDisabled} title={sizeDisabled ? sizeTitle : ''}>Biggest Size</option>
          <option value="smallest_size" disabled={sizeDisabled} title={sizeDisabled ? sizeTitle : ''}>Smallest Size</option>
        </select>
      </div>
      <div className="chat-list" role="list">
        {mainFiltered.length === 0 && extras.length === 0 && (
          <div className="chat-list-empty">
            {filter ? 'No chats match your filter.' : 'No chats found.'}
          </div>
        )}
        {mainFiltered.map(entry => (
          <ChatItem
            key={entry.folderName}
            entry={entry}
            isActive={activeEntry?.folderName === entry.folderName}
            onSelect={() => onSelectChat(entry)}
            onDelete={() => onDeleteChat(entry)}
            deletionEnabled={deletionEnabled}
            selectionMode={selectionMode}
            isSelected={selectedChats?.has(entry.folderName)}
            onToggleSelect={(e, select) => handleToggleSelect(e, entry, select)}
          />
        ))}
        {extras.map(extra => (
          <div key={extra.label}>
            <div className="chat-list-separator">{extra.label}</div>
            {extra.items.map(entry => (
              <ChatItem
                key={entry.folderName}
                entry={entry}
                isActive={activeEntry?.folderName === entry.folderName}
                onSelect={() => onSelectChat(entry)}
                onDelete={() => onDeleteChat(entry)}
                deletionEnabled={deletionEnabled}
                selectionMode={selectionMode}
                isSelected={selectedChats?.has(entry.folderName)}
                onToggleSelect={(e, select) => handleToggleSelect(e, entry, select)}
              />
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
