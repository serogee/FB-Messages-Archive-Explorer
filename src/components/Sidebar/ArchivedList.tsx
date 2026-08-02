import type { ChatListEntry } from '../../types/messenger';
import { ChatList } from './ChatList';

interface ArchivedListProps {
  chatList: ChatListEntry[];
  activeEntry: ChatListEntry | null;
  onSelectChat: (entry: ChatListEntry) => Promise<void>;
  onDeleteChat: (entry: ChatListEntry) => void;
  deletionEnabled: boolean;
  onBack: () => void;
  label: string;
  emptyText: string;
}

export function ArchivedList({
  chatList,
  activeEntry,
  onSelectChat,
  onDeleteChat,
  deletionEnabled,
  onBack,
  label,
  emptyText,
}: ArchivedListProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <button className="archived-back" onClick={onBack} aria-label="Back to inbox">
        ← Back to Chats
      </button>
      <span className="archived-label">{label}</span>
      {chatList.length === 0 ? (
        <div className="chat-list-empty">{emptyText}</div>
      ) : (
        <ChatList
          chatList={chatList}
          activeEntry={activeEntry}
          onSelectChat={onSelectChat}
          onDeleteChat={onDeleteChat}
          deletionEnabled={deletionEnabled}
        />
      )}
    </div>
  );
}
