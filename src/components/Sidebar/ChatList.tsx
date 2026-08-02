import { useState, useRef, useEffect } from 'react';
import type { ChatListEntry } from '../../types/messenger';
import { formatRelativeTime, formatFileSize } from '../../services/storage';

interface ChatListProps {
  chatList: ChatListEntry[];
  activeEntry: ChatListEntry | null;
  onSelectChat: (entry: ChatListEntry) => Promise<void>;
  onDeleteChat: (entry: ChatListEntry) => void;
  deletionEnabled: boolean;
}

interface ChatItemProps {
  entry: ChatListEntry;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
  deletionEnabled: boolean;
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

function ChatItem({ entry, isActive, onSelect, onDelete, deletionEnabled }: ChatItemProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
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

  const showMenu = deletionEnabled || true; // Always show menu for "Open file location"

  return (
    <div
      className={`chat-list-item ${isActive ? 'active' : ''}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onSelect(); }}
    >
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
            {entry.folderSize > 0 ? formatFileSize(entry.folderSize) : `${entry.jsonFileCount} file${entry.jsonFileCount !== 1 ? 's' : ''}`}
          </span>
        </div>
        {showMenu && (
          <div className="chat-item-menu-wrap" ref={dropdownRef}>
            <button
              className="chat-item-menu-btn visible"
              title="Chat options"
              onClick={e => { e.stopPropagation(); setDropdownOpen(v => !v); }}
              aria-label="Chat options"
            >
              &#8942;
            </button>
            {dropdownOpen && (
              <div className="chat-item-dropdown">
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

export function ChatList({ chatList, activeEntry, onSelectChat, onDeleteChat, deletionEnabled }: ChatListProps) {
  const [filter, setFilter] = useState('');

  const filtered = filter.trim()
    ? chatList.filter(e => e.title.toLowerCase().includes(filter.toLowerCase()))
    : chatList;

  return (
    <>
      <div className="filter-row">
        <input
          className="chat-list-filter"
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
      <div className="chat-list" role="list">
        {filtered.length === 0 && (
          <div className="chat-list-empty">
            {filter ? 'No chats match your filter.' : 'No chats found.'}
          </div>
        )}
        {filtered.map(entry => (
          <ChatItem
            key={entry.folderName}
            entry={entry}
            isActive={activeEntry?.folderName === entry.folderName}
            onSelect={() => onSelectChat(entry)}
            onDelete={() => onDeleteChat(entry)}
            deletionEnabled={deletionEnabled}
          />
        ))}
      </div>
    </>
  );
}
