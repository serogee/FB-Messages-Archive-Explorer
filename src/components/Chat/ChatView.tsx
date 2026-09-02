import { useRef, useImperativeHandle, forwardRef, useState, useCallback } from 'react';
import type { MessengerThread, MediaState, ChatListEntry, SelectableItem } from '../../types/messenger';
import { Info } from 'lucide-react';
import type { Settings } from '../../hooks/useSettings';
import type { useSearch } from '../../hooks/useSearch';
import type { GalleryCategory } from '../../hooks/useAttachments';
import { useAttachments, useSharedLinks } from '../../hooks/useAttachments';
import { useSelection } from '../../hooks/useSelection';
import { DateNavigator } from './DateNavigator';
import { MessageList, type MessageListHandle } from './MessageList';
import { AttachmentGallery } from '../AttachmentGallery/AttachmentGallery';
import type { AttachmentJumpTarget } from '../AttachmentGallery/AttachmentGallery';
import { MediaViewer } from '../MediaViewer/MediaViewer';
import type { AttachmentBookmarksController } from '../../hooks/useAttachmentBookmarks';

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
  galleryDefaultTab?: GalleryCategory;
  onGalleryTabChange: (tab: GalleryCategory) => void;
  onOpenGallery: (tab?: GalleryCategory) => void;
  onCloseGallery: () => void;
  galleryHasOpened: boolean;
  selection: ReturnType<typeof useSelection>;
  attachmentBookmarkingEnabled: boolean;
  bookmarks: AttachmentBookmarksController;
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
    onGalleryTabChange,
    onOpenGallery,
    onCloseGallery,
    galleryHasOpened,
    selection,
    attachmentBookmarkingEnabled,
    bookmarks,
  },
  ref
) {
  const messageListRef = useRef<MessageListHandle>(null);

  const [viewerState, setViewerState] = useState<{ open: boolean; index: number; kind: 'attachments' | 'links' }>({ open: false, index: 0, kind: 'attachments' });
  const [attachmentJumpTarget, setAttachmentJumpTarget] = useState<AttachmentJumpTarget | null>(null);
  const attachments = useAttachments(chatData, mediaState);
  const links = useSharedLinks(chatData);
  const bookmarkRecords = bookmarks.bookmarks;
  const bookmarkLookup = bookmarks.isBookmarked;
  const toggleBookmark = bookmarks.toggle;
  const isAttachmentBookmarked = useCallback(
    (item: SelectableItem) => {
      // Capture the records snapshot so memoized consumers refresh when bookmark membership changes.
      void bookmarkRecords;
      return !!activeEntry && bookmarkLookup(activeEntry, item);
    },
    [activeEntry, bookmarkLookup, bookmarkRecords]
  );
  const handleToggleBookmark = useCallback(
    (item: SelectableItem) => activeEntry
      ? toggleBookmark(activeEntry, item)
      : Promise.resolve(),
    [activeEntry, toggleBookmark]
  );

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

  const handleMediaClick = useCallback((mediaPath: string, msgIndex: number) => {
    const idx = attachments.findIndex(mediaPath, msgIndex);
    if (idx >= 0) {
      setViewerState({ open: true, index: idx, kind: 'attachments' });
    }
  }, [attachments]);

  const handleLinkClick = useCallback((url: string, msgIndex: number) => {
    const index = links.findIndex(link => link.url === url && link.messageIndex === msgIndex);
    if (index >= 0) setViewerState({ open: true, index, kind: 'links' });
  }, [links]);

  const handleViewerJump = useCallback((messageIndex: number) => {
    setViewerState(previous => ({ ...previous, open: false, index: 0 }));
    if (galleryOpen) {
      onCloseGallery();
    }
    setTimeout(() => handleJumpToMessage(messageIndex), 50);
  }, [galleryOpen, onCloseGallery]);

  const handleViewerAttachmentJump = useCallback((item: SelectableItem) => {
    const targetTab = galleryHasOpened && galleryDefaultTab === item.category
      ? item.category
      : 'all';
    setAttachmentJumpTarget({ ...item, tab: targetTab });
    setViewerState(previous => ({ ...previous, open: false, index: 0 }));
    onOpenGallery(targetTab);
  }, [galleryDefaultTab, galleryHasOpened, onOpenGallery]);

  return (
    <div className="chat-container">
      {/* Keep both views laid out so their native scroll positions survive view switches. */}
      <div
        className={`chat-view-layer ${galleryOpen && chatData ? 'active' : 'inactive'}`}
        aria-hidden={!galleryOpen || !chatData}
      >
        {chatData && (
          <AttachmentGallery
            chatData={chatData}
            mediaState={mediaState}
            settings={settings}
            isOpen={galleryOpen}
            infoPanelOpen={settings.infoPanelOpen}
            onClose={onCloseGallery}
            onJumpToMessage={handleViewerJump}
            onToggleInfoPanel={onToggleInfoPanel}
            onTabChange={onGalleryTabChange}
            defaultTab={galleryDefaultTab}
            selection={selection}
            showStickers={!activeEntry?._messengerExport}
            attachmentJumpTarget={attachmentJumpTarget}
            onAttachmentJumpHandled={() => setAttachmentJumpTarget(null)}
            attachmentBookmarkingEnabled={attachmentBookmarkingEnabled}
            isAttachmentBookmarked={isAttachmentBookmarked}
            onToggleAttachmentBookmark={handleToggleBookmark}
            bookmarkBusy={bookmarks.busy}
          />
        )}
      </div>

      <div
        className={`chat-view-layer ${!galleryOpen ? 'active' : 'inactive'}`}
        aria-hidden={galleryOpen}
      >
        <>
          <div className={`chat-header ${settings.autoCollapseDateNav ? 'date-nav-auto' : ''}`}>
            <h3 title={chatData?.title || activeEntry?.title || ''}>
              {chatData?.title || activeEntry?.title || (loading ? 'Loading...' : 'Select a chat')}
            </h3>

            {chatData && (
              <DateNavigator
                chatData={chatData}
                settings={settings}
                onJumpToMessage={handleJumpToMessage}
                chatContainerRef={chatContainerRef as React.RefObject<HTMLDivElement | null>}
              />
            )}

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

          {loading && (
            <div id="loading">
              <ProgressBar value={msgProgress} label={msgStatusText || "Loading messages"} />
            </div>
          )}

          {!loading && !chatData && (
            <div id="loading" style={{ flexDirection: 'column', gap: 12 }}>
              <span>Open a chat from the sidebar</span>
            </div>
          )}

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
              onLinkClick={handleLinkClick}
            />
          )}

          {mediaLoading && (
            <div className="media-loading-overlay">
              <div className="media-loading-card">
                <ProgressBar value={mediaProgress} label="Loading attachments" />
              </div>
            </div>
          )}
        </>
      </div>

      {viewerState.open && (
        <MediaViewer
          items={viewerState.kind === 'links' ? links : attachments.all}
          initialIndex={viewerState.index}
          mediaState={mediaState}
          onClose={() => setViewerState(previous => ({ ...previous, open: false }))}
          onJumpToMessage={handleViewerJump}
          onJumpToAttachment={handleViewerAttachmentJump}
          selection={selection}
          selectionMode={selection.selectedCount > 0}
          useDateFilename={settings.dateAttachmentFilenames}
          chatTitle={chatData?.title}
          filenameTemplate={settings.attachmentFilenameTemplate}
          allowLongFilenames={settings.longAttachmentFilenames}
          attachmentBookmarkingEnabled={attachmentBookmarkingEnabled}
          isBookmarked={isAttachmentBookmarked}
          onToggleBookmark={handleToggleBookmark}
          bookmarkBusy={bookmarks.busy}
        />
      )}
    </div>
  );
});
