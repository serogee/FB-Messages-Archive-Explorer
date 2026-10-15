import { useRef, useImperativeHandle, forwardRef, useState, useCallback, useMemo, useEffect, useLayoutEffect } from 'react';
import type { MessengerThread, MediaState, ChatListEntry, SelectableItem } from '../../types/messenger';
import { CalendarDays, Info } from 'lucide-react';
import { LoadingLabel } from '../LoadingLabel';
import { ParentBackButton } from '../Navigation/ParentBackButton';
import { useReactionContext } from '../../hooks/useReactionFeature';
import { useThreadData } from '../../hooks/useThreadData';
import { isReactionNoticeMessage } from '../../services/reactions';
import type { Settings } from '../../hooks/useSettings';
import type { useSearch } from '../../hooks/useSearch';
import type { GalleryCategory } from '../../hooks/useAttachments';
import { useAttachments, useSharedLinks } from '../../hooks/useAttachments';
import { useSelection } from '../../hooks/useSelection';
import { DateNavigator } from './DateNavigator';
import { MessageList, type MessageListHandle, type MessageJumpOptions } from './MessageList';
import { AttachmentGallery, type AttachmentGalleryHandle } from '../AttachmentGallery/AttachmentGallery';
import type { AttachmentJumpTarget } from '../AttachmentGallery/AttachmentGallery';
import type { NavigationSnapshot, PreviewRequest } from '../../services/mobileNavigation';
import type { BookmarksController } from '../../hooks/useBookmarks';

interface ChatViewProps {
  chatData?: MessengerThread | null;
  activeEntry: ChatListEntry | null;
  mediaState: MediaState;
  msgProgress: number;
  msgStatusText: string;
  chatError: string | null;
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
  selection: ReturnType<typeof useSelection>;
  attachmentBookmarkingEnabled: boolean;
  bookmarks: BookmarksController;
  mobile?: boolean;
  hidden?: boolean;
  viewerOpen?: boolean;
  onBack?: () => void;
  onOpenSelection?: () => void;
  onOpenViewer?: (request: PreviewRequest) => void;
  onNavigateToMessage?: (index: number, options?: MessageJumpOptions) => Promise<void>;
  onNavigateToAttachment?: (item: SelectableItem) => void;
  attachmentJumpTarget?: AttachmentJumpTarget | null;
  onAttachmentJumpHandled?: () => void;
}

export interface ChatViewHandle {
  getChatContainer: () => HTMLDivElement | null;
  cancelJump: () => void;
  scrollToBottom: () => void;
  jumpToMessage: (index: number, options?: MessageJumpOptions) => Promise<void>;
  jumpToAttachment: (item: SelectableItem) => void;
  captureSnapshot: () => NavigationSnapshot;
  restoreSnapshot: (snapshot: NavigationSnapshot) => Promise<void>;
}

function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.round(value * 100);
  return (
    <div className="load-progress-block">
      <div className="load-progress-header">
        <span className="load-progress-label" role="status">
          <LoadingLabel label={label} />
        </span>
        <span className="load-progress-pct">{pct}%</span>
      </div>
      <div className="load-progress-track" role="progressbar" aria-label="Chat loading progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="load-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export const ChatView = forwardRef<ChatViewHandle, ChatViewProps>(function ChatView(
  {
    chatData: providedThread,
    activeEntry,
    mediaState,
    msgProgress,
    msgStatusText,
    chatError,
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
    selection,
    attachmentBookmarkingEnabled,
    bookmarks,
    mobile = false,
    hidden = false,
    viewerOpen = false,
    onBack,
    onOpenSelection,
    onOpenViewer,
    onNavigateToMessage,
    onNavigateToAttachment,
    attachmentJumpTarget,
    onAttachmentJumpHandled,
  },
  ref
) {
  const chatData = useThreadData(providedThread);
  const reactions = useReactionContext();
  const totalHiddenCount = useMemo(() => reactions.hide ? (chatData?.messages || []).filter(isReactionNoticeMessage).length : 0, [chatData, reactions.hide]);
  const [reportedHidden, setReportedHidden] = useState<{ data: MessengerThread | null; hide: boolean; count: number } | null>(null);
  const handleHiddenCountChange = useCallback((count: number) => setReportedHidden({ data: chatData, hide: reactions.hide, count }), [chatData, reactions.hide]);
  const hiddenCount = reportedHidden?.data === chatData && reportedHidden.hide === reactions.hide ? reportedHidden.count : totalHiddenCount;
  const hasHiddenNotices = hiddenCount > 0;
  const [noticeHintChat, setNoticeHintChat] = useState<MessengerThread | null>(null);
  useEffect(() => {
    if (loading || !chatData || !reactions.hide || !hasHiddenNotices) {
      setNoticeHintChat(null);
      return;
    }
    setNoticeHintChat(chatData);
    const timer = setTimeout(() => setNoticeHintChat(null), 3000);
    return () => clearTimeout(timer);
  }, [chatData, loading, reactions.hide, hasHiddenNotices]);
  const messageListRef = useRef<MessageListHandle>(null);

  const galleryRef = useRef<AttachmentGalleryHandle>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [compactDateHeader, setCompactDateHeader] = useState(false);
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header || mobile) { setCompactDateHeader(false); return; }
    // Read the actual container-query layout so sidebar resizing uses the same breakpoint.
    const update = () => setCompactDateHeader(getComputedStyle(header).display === 'grid');
    update();
    const observer = new ResizeObserver(update);
    observer.observe(header.parentElement ?? header);
    return () => observer.disconnect();
  }, [mobile]);
  const [dateKeyboardFocus, setDateKeyboardFocus] = useState(false);
  const [dateHeaderHovered, setDateHeaderHovered] = useState(false);
  const [dateHeaderExpanded, setDateHeaderExpanded] = useState<boolean | null>(null);
  useEffect(() => {
    setDateHeaderExpanded(null);
    setDateKeyboardFocus(false);
    setDateHeaderHovered(false);
  }, [chatData, mobile, galleryOpen, settings.autoCollapseDateNav]);

  useEffect(() => {
    if (!compactDateHeader || viewerOpen || galleryOpen) return;
    const dismiss = (keyboard: boolean) => {
      setDateHeaderExpanded(settings.autoCollapseDateNav && !keyboard ? null : false);
      setDateKeyboardFocus(false);
      setDateHeaderHovered(false);
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !headerRef.current?.contains(event.target)) dismiss(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss(true);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [compactDateHeader, viewerOpen, galleryOpen, settings.autoCollapseDateNav]);

  const datesExpanded = dateHeaderExpanded === true || (dateHeaderExpanded !== false
    && settings.autoCollapseDateNav && (dateHeaderHovered || dateKeyboardFocus));

  const toggleHeaderDates = useCallback(() => {
    const controls = headerRef.current?.querySelector<HTMLElement>('.date-nav-controls');
    if (mobile || !controls || getComputedStyle(controls).position !== 'absolute') return;
    setDateHeaderExpanded(getComputedStyle(controls).display === 'none');
  }, [mobile]);

  const isHeaderControl = (target: EventTarget) => target instanceof Element && !!target.closest(
    'button, a, input, select, textarea, [role="button"], .date-nav-controls',
  );
  const [galleryThread, setGalleryThread] = useState<MessengerThread | null>(null);
  useEffect(() => {
    setGalleryThread(previous => galleryOpen && chatData ? chatData : previous === chatData ? previous : null);
  }, [chatData, galleryOpen]);
  const galleryMounted = !!chatData && (galleryOpen || galleryThread === chatData);
  const attachments = useAttachments(chatData, mediaState, { includeRepeated: true });
  const links = useSharedLinks(chatData);
  const bookmarkRecords = bookmarks.attachmentBookmarks;
  const bookmarkLookup = bookmarks.isItemBookmarked;
  const toggleBookmark = bookmarks.toggleItemBookmark;
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

  const handleJumpToMessage = useCallback(async (index: number, options?: MessageJumpOptions) => {
    if (onNavigateToMessage) await onNavigateToMessage(index, options);
    else await messageListRef.current?.jumpToMessage(index, options);
  }, [onNavigateToMessage]);

  const handleDateJump = useCallback((index: number) => handleJumpToMessage(index, {
    minimumOffset: () => {
      const controls = headerRef.current?.querySelector<HTMLElement>('.date-nav-controls');
      const container = messageListRef.current?.getChatContainer();
      // Only the compact desktop row needs extra clearance. Other jumps keep their defaults.
      if (!controls || !container || getComputedStyle(controls).position !== 'absolute' || !controls.getClientRects().length) return;
      return controls.getBoundingClientRect().bottom - container.getBoundingClientRect().top + 12;
    },
  }), [handleJumpToMessage]);

  const chatContainerRef = {
    get current() { return messageListRef.current?.getChatContainer() ?? null; }
  };

  const handleMediaClick = useCallback((mediaPath: string, msgIndex: number) => {
    const idx = attachments.findIndex(mediaPath, msgIndex);
    if (idx >= 0) {
      onOpenViewer?.({ items: attachments.all, index: idx, source: 'chat' });
    }
  }, [attachments, onOpenViewer]);

  const handleLinkClick = useCallback((url: string, msgIndex: number) => {
    const index = links.findIndex(link => link.url === url && link.messageIndex === msgIndex);
    if (index >= 0) onOpenViewer?.({ items: links, index, source: 'chat' });
  }, [links, onOpenViewer]);

  const handleViewerJump = useCallback((messageIndex: number) => {
    void handleJumpToMessage(messageIndex);
  }, [handleJumpToMessage]);

  useImperativeHandle(ref, () => ({
    getChatContainer: () => messageListRef.current?.getChatContainer() ?? null,
    cancelJump: () => { messageListRef.current?.cancelJump(); galleryRef.current?.cancelRestore(); },
    scrollToBottom: () => {
      messageListRef.current?.scrollToBottom();
    },
    jumpToMessage: async (index: number, options?: MessageJumpOptions) => {
      await messageListRef.current?.jumpToMessage(index, options);
    },
    jumpToAttachment: item => {
      if (onNavigateToAttachment) onNavigateToAttachment(item);
      else onOpenGallery(item.category);
    },
    captureSnapshot: () => ({
      message: messageListRef.current?.capturePosition(),
      gallery: galleryRef.current?.captureSnapshot(),
    }),
    restoreSnapshot: async snapshot => {
      if (snapshot.gallery) galleryRef.current?.restoreSnapshot(snapshot.gallery);
      if (snapshot.message) await messageListRef.current?.restorePosition(snapshot.message);
    },
  }), [onOpenGallery, onNavigateToAttachment]);

  return (
    <div className="chat-container" inert={hidden || undefined} aria-hidden={hidden || undefined}>
      {/* Keep both views laid out so their native scroll positions survive view switches. */}
      <div
        className={`chat-view-layer ${galleryOpen && chatData ? 'active' : 'inactive'}`}
        aria-hidden={!galleryOpen || !chatData}
        inert={!galleryOpen || !chatData || undefined}
      >
        {galleryMounted && (
          <AttachmentGallery
            ref={galleryRef}
            chatData={providedThread ?? undefined}
            mediaState={mediaState}
            settings={settings}
            isOpen={galleryOpen && !hidden}
            infoPanelOpen={mobile ? false : settings.infoPanelOpen}
            onClose={onCloseGallery}
            onJumpToMessage={handleViewerJump}
            onToggleInfoPanel={onToggleInfoPanel}
            onTabChange={onGalleryTabChange}
            defaultTab={galleryDefaultTab}
            selection={selection}
            showStickers={!activeEntry?._messengerExport}
            attachmentJumpTarget={attachmentJumpTarget}
            onAttachmentJumpHandled={onAttachmentJumpHandled}
            attachmentBookmarkingEnabled={attachmentBookmarkingEnabled}
            isAttachmentBookmarked={isAttachmentBookmarked}
            onToggleAttachmentBookmark={handleToggleBookmark}
            bookmarkBusy={bookmarks.busy}
            mobile={mobile}
            viewerOpen={viewerOpen}
            onOpenViewer={onOpenViewer}
            onOpenSelection={onOpenSelection}
          />
        )}
      </div>

      <div
        className={`chat-view-layer ${!galleryOpen || !chatData ? 'active' : 'inactive'}`}
        aria-hidden={galleryOpen && !!chatData}
        inert={(galleryOpen && !!chatData) || undefined}
      >
        <>
          <div className="chat-header-region">
            <div
              ref={headerRef}
              className={`chat-header ${settings.autoCollapseDateNav ? 'date-nav-auto' : ''}`}
              data-date-keyboard={dateKeyboardFocus || undefined}
              data-date-expanded={dateHeaderExpanded ?? undefined}
              onPointerDown={() => setDateKeyboardFocus(false)}
              onPointerOver={event => {
                setDateHeaderHovered(!(event.target instanceof Element && event.target.closest('.chat-info-toggle')));
              }}
              onPointerLeave={() => {
                setDateHeaderHovered(false);
                if (settings.autoCollapseDateNav && dateHeaderExpanded !== true) setDateHeaderExpanded(null);
              }}
              onClick={event => {
                if (!isHeaderControl(event.target)) toggleHeaderDates();
              }}
              onFocus={event => {
                if (event.target instanceof Element && event.target.matches(':focus-visible') && !event.target.closest('.chat-info-toggle')) {
                  setDateKeyboardFocus(true);
                  if (settings.autoCollapseDateNav && dateHeaderExpanded !== true) setDateHeaderExpanded(null);
                } else if (event.target instanceof Element && event.target.closest('.chat-info-toggle')) setDateKeyboardFocus(false);
              }}
              onBlur={event => {
                if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDateKeyboardFocus(false);
              }}
            >
              {mobile && <ParentBackButton destination="chats" ariaLabel="Back to chat list" onClick={onBack} />}
              <h3 title={chatData?.title || activeEntry?.title || ''} aria-label={chatData?.title || activeEntry?.title || undefined}>
                {compactDateHeader && chatData && !mobile ? (
                  <button type="button" className="chat-date-toggle" aria-label="Browse dates" title="Browse dates"
                    aria-expanded={datesExpanded} aria-controls="dateNavControls" onClick={toggleHeaderDates}>
                    <span>{chatData.title}</span><CalendarDays size={16} aria-hidden="true" />
                  </button>
                ) : galleryOpen && loading ? 'Attachments' : (loading ? activeEntry?.title : chatData?.title) || activeEntry?.title || (loading ? 'Loading...' : 'Select a chat')}
              </h3>

              {chatData && !mobile && (
                <DateNavigator
                  chatData={providedThread}
                  settings={settings}
                  headerControlled={compactDateHeader}
                  onJumpToMessage={handleDateJump}
                  chatContainerRef={chatContainerRef as React.RefObject<HTMLDivElement | null>}
                  mobile={mobile}
                />
              )}

              <button
                className="chat-info-toggle"
                id="chatInfoToggle"
                aria-label={mobile ? 'Open chat info' : 'Toggle chat info panel'}
                aria-expanded={mobile ? false : settings.infoPanelOpen}
                onClick={onToggleInfoPanel}
                title="Chat info"
              >
                <Info size={18} />
              </button>
            </div>
          </div>

          <div id="line" />

          {!loading && chatData && hasHiddenNotices && noticeHintChat === chatData && <div className="reaction-notice-overlay">
            <div className="reaction-notice-panel" role="region" aria-label="Hidden reaction notices">
              <span role="status">{hiddenCount} reaction {hiddenCount === 1 ? 'notice' : 'notices'} hidden</span>
              <button type="button" className="reaction-hidden-control" onClick={reactions.showAll}>Show all</button>
            </div>
          </div>}

          {loading && (
            <div id="loading">
              <ProgressBar value={msgProgress} label={msgStatusText || "Loading messages"} />
            </div>
          )}

          {!loading && !chatData && (
            <div id="loading" className={chatError ? 'chat-load-error' : undefined} style={{ flexDirection: 'column', gap: 12 }}>
              {chatError ? (
                <>
                  <strong>Chat could not be loaded</strong>
                  <span role="alert">{chatError}</span>
                </>
              ) : (
                <span>Open a chat from the sidebar</span>
              )}
            </div>
          )}

          {!loading && chatData && (
            <MessageList
              ref={messageListRef}
              chatData={providedThread}
              mediaState={mediaState}
              selectedPerspective={selectedPerspective}
              settings={settings}
              highlightQuery={search.activeQuery}
              onScrollSync={() => {}}
              onMediaClick={handleMediaClick}
              onLinkClick={handleLinkClick}
              onHiddenCountChange={handleHiddenCountChange}
            />
          )}

        </>
      </div>

    </div>
  );
});
