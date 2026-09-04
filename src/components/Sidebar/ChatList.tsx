import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties } from 'react';
import type { ChatListEntry } from '../../types/messenger';
import { formatRelativeTime, formatFileSize } from '../../services/storage';
import { getOrderedMessageFileNames } from '../../services/parser';

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

const MENU_DROP_UP_THRESHOLD_PX = 150;
const MENU_WIDTH_PX = 160;

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
  const subfolder =
    entry.source === 'inbox'    ? 'inbox' :
    entry.source === 'requests' ? 'message_requests' :
    entry.source === 'e2ee'     ? 'e2ee_cutover' :
    'archived_threads';
  const path = `messages/${subfolder}/${entry.folderName}`;
  try {
    await navigator.clipboard.writeText(path);
  } catch {
    // Clipboard access may be unavailable outside a secure browser context.
    window.prompt('Folder path:', path);
  }
}

async function getChatJsonFileNames(entry: ChatListEntry): Promise<string[]> {
  const jsonFileName = entry._jsonFileName;
  if (entry._messengerExport && jsonFileName) {
    return [jsonFileName];
  }

  const fileNames: string[] = [];
  for await (const [name, handle] of entry.dirHandle.entries()) {
    if (handle.kind === 'file' && /\.json$/i.test(name)) fileNames.push(name);
  }

  return getOrderedMessageFileNames(fileNames);
}

async function getChatJsonFile(entry: ChatListEntry, jsonFileName?: string): Promise<File | null> {
  const selectedJsonFileName = jsonFileName || (await getChatJsonFileNames(entry))[0];
  if (!selectedJsonFileName) return null;
  return (await entry.dirHandle.getFileHandle(selectedJsonFileName)).getFile();
}

async function openChatJson(entry: ChatListEntry, jsonFileName?: string) {
  const newTab = window.open('about:blank', '_blank');
  if (newTab) newTab.opener = null;

  try {
    const file = await getChatJsonFile(entry, jsonFileName);
    if (!file) {
      newTab?.close();
      return;
    }

    const url = URL.createObjectURL(new Blob([file], { type: 'application/json' }));
    if (newTab) {
      newTab.location.href = url;
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  } catch {
    newTab?.close();
  }
}

function ChatItem({ entry, isActive, onSelect, onDelete, deletionEnabled, selectionMode, isSelected, onToggleSelect }: ChatItemProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const [jsonFileNames, setJsonFileNames] = useState<string[] | null>(null);
  const [menuPosition, setMenuPosition] = useState<CSSProperties | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const updateMenuPosition = useCallback((button: HTMLElement) => {
    const rect = button.getBoundingClientRect();
    const nextDropUp = window.innerHeight - rect.bottom < MENU_DROP_UP_THRESHOLD_PX;
    const left = Math.max(8, rect.right - MENU_WIDTH_PX);
    setDropUp(nextDropUp);
    setMenuPosition(nextDropUp
      ? { left, bottom: window.innerHeight - rect.top + 4 }
      : { left, top: rect.bottom + 4 }
    );
  }, []);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: PointerEvent) => {
      const target = e.target as Node;
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(target) &&
        !menuButtonRef.current?.contains(target)
      ) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [dropdownOpen]);

  useEffect(() => {
    if (!dropdownOpen || jsonFileNames) return;

    let cancelled = false;
    void getChatJsonFileNames(entry).then(names => {
      if (!cancelled) setJsonFileNames(names);
    }).catch(() => {
      if (!cancelled) setJsonFileNames([]);
    });

    return () => {
      cancelled = true;
    };
  }, [dropdownOpen, entry, jsonFileNames]);

  useEffect(() => {
    if (!dropdownOpen) return;

    const handleResize = () => {
      setDropdownOpen(false);
    };
    const handleScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && dropdownRef.current?.contains(target)) return;
      setDropdownOpen(false);
    };

    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [dropdownOpen]);

  const showMenu = !selectionMode;

  const handleMenuClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!dropdownOpen) {
      updateMenuPosition(e.currentTarget as HTMLButtonElement);
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

  const closeDropdown = () => {
    setDropdownOpen(false);
  };

  const dropdown = dropdownOpen && menuPosition ? createPortal(
    <div
      ref={dropdownRef}
      className={`chat-item-dropdown${dropUp ? ' drop-up' : ''}`}
      style={menuPosition}
      onClick={e => e.stopPropagation()}
    >
      {jsonFileNames && jsonFileNames.length > 1 ? (
        <div className="chat-item-submenu-wrap">
          <button className="chat-item-submenu-trigger" onClick={e => e.stopPropagation()}>
            <span>Open JSON</span>
            <span className="chat-item-submenu-arrow">&gt;</span>
          </button>
          <div className="chat-item-submenu">
            {jsonFileNames.map(name => (
              <button
                key={name}
                title={name}
                onClick={e => {
                  e.stopPropagation();
                  closeDropdown();
                  openChatJson(entry, name);
                }}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <button
          disabled={jsonFileNames?.length === 0}
          onClick={e => { e.stopPropagation(); closeDropdown(); openChatJson(entry); }}
        >
          {jsonFileNames === null ? 'Loading JSON...' : 'Open JSON'}
        </button>
      )}
      <button
        onClick={e => { e.stopPropagation(); copyFolderPath(entry); closeDropdown(); }}
      >
        Copy folder path
      </button>
      {deletionEnabled && (
        <button
          className="danger"
          onClick={e => { e.stopPropagation(); closeDropdown(); onDelete(); }}
        >
          Delete chat
        </button>
      )}
    </div>,
    document.body
  ) : null;

  return (
    <div
      className={`chat-list-item ${isActive && !selectionMode ? 'active' : ''} ${isSelected ? 'selected' : ''} ${selectionMode ? 'selection-mode' : ''}`}
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
          <div className="chat-item-menu-wrap">
            <button
              ref={menuButtonRef}
              className={`chat-item-menu-btn visible${dropdownOpen ? ' open' : ''}`}
              title="Chat options"
              onClick={handleMenuClick}
              aria-label="Chat options"
            >
              &#8942;
            </button>
          </div>
        )}
      </div>
      {dropdown}
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
      // Shift-selection follows rendered order, including auxiliary chat sections.
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
      <div className="chat-list sidebar-scroll-region" role="list">
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
