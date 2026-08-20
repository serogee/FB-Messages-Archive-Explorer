import { useRef, useImperativeHandle, forwardRef, useState, useCallback } from 'react';
import type { MessengerThread, MediaState, ChatListEntry } from '../../types/messenger';
import { Info } from 'lucide-react';
import type { Settings } from '../../hooks/useSettings';
import type { useSearch } from '../../hooks/useSearch';
import type { AttachmentCategory } from '../../hooks/useAttachments';
import { useAttachments } from '../../hooks/useAttachments';
import { useSelection } from '../../hooks/useSelection';
import { DateNavigator } from './DateNavigator';
import { MessageList, type MessageListHandle } from './MessageList';
import { AttachmentGallery } from '../AttachmentGallery/AttachmentGallery';
import { MediaViewer } from '../MediaViewer/MediaViewer';

interface ChatViewProps {
  chatData: MessengerThread | null;
  activeEntry: ChatListEntry | null;
  mediaState: MediaState;
  mediaLoading: boolean;
  mediaProgress: number;
  msgProgress: number;
  msgStatusText: string;
  selectedPerspective: string;
  settings: Settings;
  loading: boolean;
  infoPanelOpen: boolean;
  onToggleInfoPanel: () => void;
  search: ReturnType<typeof useSearch>;
  onSelectPerspective: (name: string) => void;
  galleryOpen: boolean;
  galleryDefaultTab?: AttachmentCategory;
  onCloseGallery: () => void;
  selection: ReturnType<typeof useSelection>;
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
    activeEntry,
    mediaState,
    mediaLoading,
    mediaProgress,
    msgProgress,
    msgStatusText,
    selectedPerspective,
    settings,
    loading,
    infoPanelOpen: _infoPanelOpen,
    onToggleInfoPanel,
    search,
    onSelectPerspective: _onSelectPerspective,
    galleryOpen,
    galleryDefaultTab,
    onCloseGallery,
    selection,
  },
  ref
) {
  const messageListRef = useRef<MessageListHandle>(null);

  // Media viewer state (for clicking attachments in chat)
  const [viewerState, setViewerState] = useState<{ open: boolean; index: number }>({ open: false, index: 0 });
  const attachments = useAttachments(chatData, mediaState);

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

  // Handle media click from chat messages
  const handleMediaClick = useCallback((mediaPath: string, msgIndex: number) => {
    const idx = attachments.findIndex(mediaPath, msgIndex);
    if (idx >= 0) {
      setViewerState({ open: true, index: idx });
    }
  }, [attachments]);

  // Handle jump from media viewer (close viewer, scroll to message)
  const handleViewerJump = useCallback((messageIndex: number) => {
    setViewerState({ open: false, index: 0 });
    // If gallery is open, close it first, then jump
    if (galleryOpen) {
      onCloseGallery();
    }
    setTimeout(() => handleJumpToMessage(messageIndex), 50);
  }, [galleryOpen, onCloseGallery]);

  return (
    <div className="chat-container">
      {/* Gallery mode: hidden when not active to preserve scroll position */}
      <div style={{ display: galleryOpen && chatData ? 'flex' : 'none', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        {chatData && (
          <AttachmentGallery
            chatData={chatData}
            mediaState={mediaState}
            settings={settings}
            infoPanelOpen={settings.infoPanelOpen}
            onClose={onCloseGallery}
            onJumpToMessage={handleViewerJump}
            onToggleInfoPanel={onToggleInfoPanel}
            defaultTab={galleryDefaultTab}
            selection={selection}
          />
        )}
      </div>

      {/* Chat mode: hidden when gallery is open to preserve scroll position */}
      <div style={{ display: !galleryOpen ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <>
          {/* Header */}
          <div className={`chat-header ${settings.autoCollapseDateNav ? 'date-nav-auto' : ''}`}>
            <h3 title={chatData?.title || activeEntry?.title || ''}>
              {chatData?.title || activeEntry?.title || (loading ? 'Loading...' : 'Select a chat')}
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
              <Info size={18} />
            </button>
          </div>

          <div id="line" />

          {/* Loading messages state */}
          {loading && (
            <div id="loading">
              <ProgressBar value={msgProgress} label={msgStatusText || "Loading messages"} />
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
              highlightQuery={search.activeQuery}
              onScrollSync={() => {}}
              onMediaClick={handleMediaClick}
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
        </>
      </div>

      {/* Media Viewer (rendered at chat-container level, above everything within it) */}
      {viewerState.open && (
        <MediaViewer
          attachments={attachments.all}
          initialIndex={viewerState.index}
          mediaState={mediaState}
          onClose={() => setViewerState({ open: false, index: viewerState.index })}
          onJumpToMessage={handleViewerJump}
        />
      )}
    </div>
  );
});
