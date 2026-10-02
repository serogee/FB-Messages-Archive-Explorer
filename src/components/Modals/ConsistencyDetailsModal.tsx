import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { ChatListEntry } from '../../types/messenger';
import type { ReactionConsistencyChat } from '../../services/reactionAuditProtocol';
import { formatRelativeTime } from '../../services/storage';
import { formatEntrySize, getAvatarChar, getAvatarColor } from '../../services/chatListPresentation';

interface ConsistencyDetailsModalProps {
  chats: { entry: ChatListEntry; issue: ReactionConsistencyChat }[];
  onOpenChat: (entry: ChatListEntry) => Promise<void>;
  onClose: () => void;
}

export function ConsistencyDetailsModal({ chats, onOpenChat, onClose }: ConsistencyDetailsModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  return (
    <div className="shortcuts-modal" role="dialog" aria-modal="true" aria-labelledby="consistencyDetailsTitle">
      <div className="shortcuts-backdrop" onClick={onClose} />
      <div className="shortcuts-card consistency-details-card">
        <div className="shortcuts-header">
          <h3 id="consistencyDetailsTitle">Chats with inconsistent matches</h3>
          <button ref={closeRef} className="shortcuts-close" onClick={onClose} aria-label="Close inconsistent chats">
            <X size={18} />
          </button>
        </div>
        <div className="shortcuts-body">
          <p className="shortcuts-note">{chats.length ? 'Select a chat to open it. The count shows notices that match reactions out of all supported notices in that chat.' : 'This result was created before chat details were available. Run Check again to list the affected chats.'}</p>
          {chats.length > 0 && <div className="consistency-chat-list" role="list">
            {chats.map(({ entry, issue }) => (
              <button
                type="button"
                className="chat-list-item consistency-chat-item"
                key={issue.id}
                onClick={() => { onClose(); void onOpenChat(entry); }}
              >
                <div className="chat-avatar" style={{ background: getAvatarColor(entry.title) }}>
                  {getAvatarChar(entry.title)}
                </div>
                <div className="chat-item-body">
                  <div className="chat-item-info">
                    <div className="chat-item-title-row"><div className="chat-item-title" title={entry.title}>{entry.title}</div></div>
                    <div className="chat-item-preview">{entry.lastMessage || <em>No messages</em>}</div>
                    <div className="consistency-chat-result">{issue.candidates.toLocaleString()}/{issue.notices.toLocaleString()} notices match reactions</div>
                  </div>
                  <div className="chat-item-meta">
                    <span className="chat-item-time">{entry.lastTimestamp ? formatRelativeTime(entry.lastTimestamp) : ''}</span>
                    <span className="chat-item-size">{formatEntrySize(entry)}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>}
        </div>
      </div>
    </div>
  );
}
