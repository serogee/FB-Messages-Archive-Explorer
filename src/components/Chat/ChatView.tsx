import { useRef, useImperativeHandle, forwardRef } from 'react';
import type { MessengerThread, MediaState } from '../../types/messenger';
import type { Settings } from '../../hooks/useSettings';
import type { useSearch } from '../../hooks/useSearch';
import { DateNavigator } from './DateNavigator';
import { MessageList, type MessageListHandle } from './MessageList';

interface ChatViewProps {
  chatData: MessengerThread | null;
  mediaState: MediaState;
  mediaLoading: boolean;
  mediaProgress: number;
  msgProgress: number;
  selectedPerspective: string;
  settings: Settings;
  loading: boolean;
  infoPanelOpen: boolean;
  onToggleInfoPanel: () => void;
  search: ReturnType<typeof useSearch>;
  onSelectPerspective: (name: string) => void;
}

export interface ChatViewHandle {
  scrollToBottom: () => void;
  jumpToMessage: (index: number) => Promise<void>;
}

function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.round(value * 100);
  return (
    <div className="load-progress-block">
      <div className="load-progress-header">
        <span className="load-progress-label">{label}…</span>
        <span className="load-progress-pct">{pct}%</span>
      </div>
      <div className="load-progress-track">
        <div className="load-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export const ChatView = forwardRef<ChatViewHandle, ChatViewProps>(function ChatView(
  {
    chatData,
    mediaState,
    mediaLoading,
    mediaProgress,
    msgProgress,
    selectedPerspective,
    settings,
    loading,
    infoPanelOpen: _infoPanelOpen,
    onToggleInfoPanel,
    search,
    onSelectPerspective: _onSelectPerspective,
  },
  ref
) {
  const messageListRef = useRef<MessageListHandle>(null);

  useImperativeHandle(ref, () => ({
    scrollToBottom: () => {
      messageListRef.current?.scrollToBottom();
    },
    jumpToMessage: async (index: number) => {
      await messageListRef.current?.jumpToMessage(index);
    },
  }));

  const handleJumpToMessage = async (index: number) => {
    await messageListRef.current?.jumpToMessage(index);
  };

  const chatContainerRef = {
    get current() { return messageListRef.current?.getChatContainer() ?? null; }
  };

  return (
    <div className="chat-container">
      {/* Header */}
      <div className={`chat-header ${settings.autoCollapseDateNav ? 'date-nav-auto' : ''}`}>
        <h3 title={chatData?.title || ''}>
          {chatData?.title || (loading ? 'Loading...' : 'Select a chat')}
        </h3>

        {/* Date navigator (inline in header) */}
        {chatData && (
          <DateNavigator
            chatData={chatData}
            settings={settings}
            onJumpToMessage={handleJumpToMessage}
            chatContainerRef={chatContainerRef as React.RefObject<HTMLDivElement | null>}
          />
        )}

        {/* Info panel toggle */}
        <button
          className="chat-info-toggle"
          id="chatInfoToggle"
          aria-label="Toggle chat info panel"
          aria-expanded={settings.infoPanelOpen}
          onClick={onToggleInfoPanel}
          title="Chat info"
        >
          i
        </button>
      </div>

      <div id="line" />

      {/* Loading messages state */}
      {loading && (
        <div id="loading">
          <ProgressBar value={msgProgress} label="Loading messages" />
        </div>
      )}

      {/* Empty state */}
      {!loading && !chatData && (
        <div id="loading" style={{ flexDirection: 'column', gap: 12 }}>
          <span>Open a chat from the sidebar</span>
        </div>
      )}

      {/* Messages */}
      {!loading && chatData && (
        <MessageList
          ref={messageListRef}
          chatData={chatData}
          mediaState={mediaState}
          selectedPerspective={selectedPerspective}
          settings={settings}
          highlightQuery={search.query}
          onScrollSync={() => {}}
        />
      )}

      {/* Loading attachments overlay */}
      {mediaLoading && (
        <div className="media-loading-overlay">
          <div className="media-loading-card">
            <ProgressBar value={mediaProgress} label="Loading attachments" />
          </div>
        </div>
      )}
    </div>
  );
});
