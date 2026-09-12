import type { ChatListEntry } from '../../types/messenger';
import { ArrowLeft } from 'lucide-react';
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
  sizeProgress?: { done: number; total: number } | null;
  selectionMode?: boolean;
  selectedChats?: Set<string>;
  onToggleSelectChat?: (chatId: string, select: boolean) => void;
  bookmarkingEnabled?: boolean;
  pinnedChatIds?: readonly string[];
  bookmarkBusy?: boolean;
  onToggleChatPin?: (entry: ChatListEntry) => Promise<void>;
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
  sizeProgress,
  selectionMode,
  selectedChats,
  onToggleSelectChat,
  bookmarkingEnabled,
  pinnedChatIds,
  bookmarkBusy,
  onToggleChatPin,
}: ArchivedListProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <button className="archived-back" onClick={onBack} aria-label="Back to inbox">
        <ArrowLeft size={16} /> Back to Chats
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
          sizeProgress={sizeProgress}
          selectionMode={selectionMode}
          selectedChats={selectedChats}
          onToggleSelectChat={onToggleSelectChat}
          bookmarkingEnabled={bookmarkingEnabled}
          pinnedChatIds={pinnedChatIds}
          bookmarkBusy={bookmarkBusy}
          onToggleChatPin={onToggleChatPin}
        />
      )}
    </div>
  );
}
