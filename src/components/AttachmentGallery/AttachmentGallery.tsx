import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MessengerThread, MediaState, ResolvedAttachment, ResolvedLink } from '../../types/messenger';
import { ArrowLeft, CheckSquare, Image as ImageIcon, Film, Music, FileText, Play, Check, Info, ExternalLink, Link as LinkIcon, MessageSquare, UserRound } from 'lucide-react';
import type { Settings } from '../../hooks/useSettings';
import { useAttachments, useSharedLinks, type GalleryCategory } from '../../hooks/useAttachments';
import type { useSelection } from '../../hooks/useSelection';
import { findMediaFile } from '../../services/media';
import { imageThumbnailCache } from '../../services/imageThumbnailCache';
import { videoPosterCache } from '../../services/videoPosterCache';
import { MediaViewer } from '../MediaViewer/MediaViewer';
import { calculateGalleryLayout, getStickyMonth, type GalleryGroup, type GalleryItem, type GalleryLayoutRow } from './galleryLayout';

const VIRTUAL_OVERSCAN_PX = 600;
const LINK_CARD_MIN_WIDTH = 220;
const LINK_CARD_HEIGHT = 128;

interface AttachmentGalleryProps {
  chatData: MessengerThread;
  mediaState: MediaState;
  settings: Settings;
  isOpen: boolean;
  infoPanelOpen: boolean;
  onClose: () => void;
  onJumpToMessage: (messageIndex: number) => void;
  onToggleInfoPanel: () => void;
  onTabChange: (tab: GalleryCategory) => void;
  defaultTab?: GalleryCategory;
  selection: ReturnType<typeof useSelection>;
}

const TABS: { key: GalleryCategory; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'photos', label: 'Photos' },
  { key: 'videos', label: 'Videos' },
  { key: 'audio', label: 'Audio' },
  { key: 'gifs', label: 'GIFs' },
  { key: 'files', label: 'Files' },
  { key: 'links', label: 'Links' },
];

function formatMonthYear(ts: number): string {
  return new Date(ts).toLocaleDateString([], { month: 'long', year: 'numeric' });
}

function findFirstRow(rows: GalleryLayoutRow[], target: number): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const row = rows[middle];
    if (row.top + row.height < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function groupByMonth(items: GalleryItem[]): GalleryGroup[] {
  const groups: GalleryGroup[] = [];
  let currentLabel = '';

  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    const label = item.timestamp ? formatMonthYear(item.timestamp) : 'Unknown Date';
    if (label !== currentLabel) {
      currentLabel = label;
      groups.push({ key: `${label}:${groups.length}`, label, items: [] });
    }
    groups[groups.length - 1].items.push(item);
  }

  return groups;
}

interface GalleryThumbnailProps {
  attachment: ResolvedAttachment;
  mediaState: MediaState;
  onOpen: (attachment: ResolvedAttachment) => void;
  onSelect: (attachment: ResolvedAttachment) => void;
  selectionMode: boolean;
  isSelected: boolean;
}

const GalleryThumbnail = memo(function GalleryThumbnail({
  attachment,
  mediaState,
  onOpen,
  onSelect,
  selectionMode,
  isSelected,
}: GalleryThumbnailProps) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (attachment.category !== 'photos' && attachment.category !== 'gifs' && attachment.category !== 'videos') {
      setUrl(null);
      return;
    }

    const entry = attachment.mediaEntry || findMediaFile(mediaState, attachment.mediaPath);
    if (!entry) {
      setUrl(null);
      return;
    }

    const cache = attachment.category === 'videos' ? videoPosterCache : imageThumbnailCache;
    const cached = cache.get(entry);
    if (cached) {
      setUrl(cached);
      return;
    }

    let mounted = true;
    setUrl(null);
    void cache.getOrCreate(entry).then(thumbnailUrl => {
      if (mounted && thumbnailUrl) setUrl(thumbnailUrl);
    });

    return () => { mounted = false; };
  }, [attachment, mediaState]);

  const category = attachment.category;
  const filename = attachment.mediaPath.split('/').pop() || 'File';

  const activate = (event: React.MouseEvent | React.KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (selectionMode) onSelect(attachment);
    else onOpen(attachment);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === ' ' || event.key === 'Enter') activate(event);
  };

  return (
    <div
      className={`gallery-thumb ${category === 'audio' || category === 'files' ? 'gallery-thumb-file' : ''} ${isSelected ? 'selected' : ''}`}
      onClick={activate}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      title={filename}
    >
      <div
        className="select-checkbox"
        role="checkbox"
        aria-checked={isSelected}
        tabIndex={-1}
        onClick={event => {
          event.preventDefault();
          event.stopPropagation();
          onSelect(attachment);
        }}
      >
        {isSelected && <Check size={14} />}
      </div>

      {(category === 'photos' || category === 'gifs') ? (
        url
          ? <img src={url} alt={filename} className="gallery-thumb-img" />
          : <div className="gallery-thumb-placeholder"><ImageIcon size={24} /></div>
      ) : category === 'videos' ? (
        <>
          {url
            ? <img src={url} alt={filename} className="gallery-thumb-img" />
            : <div className="gallery-thumb-placeholder"><Film size={24} /></div>}
          <div className="gallery-thumb-play"><Play fill="currentColor" size={24} /></div>
        </>
      ) : category === 'audio' ? (
        <>
          <div className="gallery-thumb-icon"><Music size={24} /></div>
          <div className="gallery-thumb-name">{filename}</div>
        </>
      ) : (
        <>
          <div className="gallery-thumb-icon"><FileText size={24} /></div>
          <div className="gallery-thumb-name">{filename}</div>
        </>
      )}

      {selectionMode && (
        <button
          type="button"
          className="gallery-open-viewer-btn"
          onClick={event => {
            event.preventDefault();
            event.stopPropagation();
            onOpen(attachment);
          }}
          aria-label={`Open ${filename}`}
          title="Open"
        >
          <Info size={15} />
        </button>
      )}
    </div>
  );
}, (previous, next) => (
  previous.attachment === next.attachment
  && previous.mediaState === next.mediaState
  && previous.onOpen === next.onOpen
  && previous.onSelect === next.onSelect
  && previous.selectionMode === next.selectionMode
  && previous.isSelected === next.isSelected
));

function getLinkHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '') || url;
  } catch {
    return url;
  }
}

const GalleryLinkCard = memo(function GalleryLinkCard({
  link,
  onJumpToMessage,
}: {
  link: ResolvedLink;
  onJumpToMessage: (messageIndex: number) => void;
}) {
  const hostname = getLinkHostname(link.url);
  return (
    <div className="gallery-thumb gallery-link-card" title={link.url}>
      <a href={link.url} target="_blank" rel="noreferrer" className="gallery-link-anchor">
        <LinkIcon size={24} className="gallery-link-icon" />
        <strong className="gallery-link-host">{hostname}</strong>
        <span className="gallery-link-url">{link.label || link.url}</span>
        <span className="gallery-link-meta">
          <span className="gallery-link-sender" title={`Sent by ${link.sender}`}>
            <UserRound size={12} />
            <span>{link.sender}</span>
          </span>
          <span className="gallery-link-open"><ExternalLink size={13} /> Open link</span>
        </span>
      </a>
      <button
        type="button"
        className="gallery-link-message"
        onClick={() => onJumpToMessage(link.messageIndex)}
        title="Jump to message"
        aria-label={`Jump to message containing ${hostname}`}
      >
        <MessageSquare size={14} />
      </button>
    </div>
  );
});

const AttachmentGalleryBase = function AttachmentGallery({
  chatData,
  mediaState,
  settings: _settings,
  isOpen,
  infoPanelOpen,
  onClose,
  onJumpToMessage,
  onToggleInfoPanel,
  onTabChange,
  defaultTab = 'all',
  selection,
}: AttachmentGalleryProps) {
  const { all, byCategory } = useAttachments(chatData, mediaState);
  const links = useSharedLinks(chatData);
  const [activeTab, setActiveTab] = useState<GalleryCategory>(defaultTab);
  const [selectionMode, setSelectionMode] = useState(false);
  const [viewerState, setViewerState] = useState({ open: false, index: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const scrollPositions = useRef<Partial<Record<GalleryCategory, number>>>({});
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const restoreFrameRef = useRef<number | null>(null);
  const restoringScrollRef = useRef(false);
  const isOpenRef = useRef(isOpen);

  const currentAttachments = useMemo<ResolvedAttachment[]>(
    () => activeTab === 'links' ? [] : activeTab === 'all' ? all : byCategory[activeTab],
    [activeTab, all, byCategory],
  );
  const currentItems = useMemo<GalleryItem[]>(
    () => activeTab === 'links' ? links : currentAttachments,
    [activeTab, currentAttachments, links],
  );
  const groups = useMemo(() => groupByMonth(currentItems), [currentItems]);
  const layout = useMemo(
    () => calculateGalleryLayout(
      groups,
      viewport.width,
      activeTab === 'links' ? LINK_CARD_MIN_WIDTH : undefined,
      undefined,
      activeTab === 'links' ? LINK_CARD_HEIGHT : undefined,
    ),
    [activeTab, groups, viewport.width],
  );

  useEffect(() => setActiveTab(defaultTab), [defaultTab]);
  useEffect(() => setSelectionMode(selection.selectedCount > 0), [selection.selectedCount]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const updateSize = () => {
      const styles = getComputedStyle(container);
      const horizontalPadding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
      const verticalPadding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
      const next = {
        width: Math.max(0, container.clientWidth - horizontalPadding),
        height: Math.max(0, container.clientHeight - verticalPadding),
      };
      setViewport(previous => (
        previous.width === next.width && previous.height === next.height ? previous : next
      ));
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    if (scrollFrameRef.current != null) cancelAnimationFrame(scrollFrameRef.current);
    if (restoreFrameRef.current != null) cancelAnimationFrame(restoreFrameRef.current);
  }, []);

  useLayoutEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);

  useLayoutEffect(() => {
    if (!isOpen || viewport.width <= 0) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const savedPosition = scrollPositions.current[activeTab] || 0;
    restoringScrollRef.current = true;
    container.scrollTop = savedPosition;
    setScrollTop(savedPosition);
    if (restoreFrameRef.current != null) cancelAnimationFrame(restoreFrameRef.current);
    restoreFrameRef.current = requestAnimationFrame(() => {
      restoreFrameRef.current = null;
      if (!isOpenRef.current) return;
      container.scrollTop = savedPosition;
      setScrollTop(savedPosition);
      restoringScrollRef.current = false;
    });

    return () => {
      if (restoreFrameRef.current != null) {
        cancelAnimationFrame(restoreFrameRef.current);
        restoreFrameRef.current = null;
      }
      restoringScrollRef.current = false;
    };
  }, [activeTab, isOpen, viewport.width]);

  const handleScroll = useCallback(() => {
    if (!isOpenRef.current || restoringScrollRef.current) return;
    if (scrollFrameRef.current != null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (!isOpenRef.current || restoringScrollRef.current) return;
      const container = scrollContainerRef.current;
      if (!container) return;
      scrollPositions.current[activeTab] = container.scrollTop;
      setScrollTop(container.scrollTop);
    });
  }, [activeTab]);

  const saveScrollPosition = useCallback(() => {
    if (scrollFrameRef.current != null) {
      cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    const container = scrollContainerRef.current;
    if (container) scrollPositions.current[activeTab] = container.scrollTop;
  }, [activeTab]);

  const handleClose = useCallback(() => {
    saveScrollPosition();
    isOpenRef.current = false;
    onClose();
  }, [onClose, saveScrollPosition]);

  const handleTabChange = useCallback((tab: GalleryCategory) => {
    const container = scrollContainerRef.current;
    if (container) scrollPositions.current[activeTab] = container.scrollTop;
    if (scrollFrameRef.current != null) {
      cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    setActiveTab(tab);
    onTabChange(tab);
  }, [activeTab, onTabChange]);

  const openViewer = useCallback((attachment: ResolvedAttachment) => {
    const index = currentAttachments.indexOf(attachment);
    setViewerState({ open: true, index: index >= 0 ? index : 0 });
  }, [currentAttachments]);

  const toggleAttachment = useCallback((attachment: ResolvedAttachment) => {
    selection.toggle(attachment);
  }, [selection]);

  const handleViewerJump = useCallback((messageIndex: number) => {
    saveScrollPosition();
    isOpenRef.current = false;
    setViewerState({ open: false, index: 0 });
    onJumpToMessage(messageIndex);
    onClose();
  }, [onJumpToMessage, onClose, saveScrollPosition]);

  const visibleRows = useMemo(() => {
    const start = findFirstRow(layout.rows, Math.max(0, scrollTop - VIRTUAL_OVERSCAN_PX));
    const limit = scrollTop + viewport.height + VIRTUAL_OVERSCAN_PX;
    let end = start;
    while (end < layout.rows.length && layout.rows[end].top < limit) end++;
    return layout.rows.slice(start, end);
  }, [layout.rows, scrollTop, viewport.height]);

  const stickyMonth = useMemo(() => {
    return getStickyMonth(layout.rows, scrollTop);
  }, [layout.rows, scrollTop]);

  const tabCounts = useMemo<Record<GalleryCategory, number>>(() => ({
    all: all.length,
    photos: byCategory.photos.length,
    videos: byCategory.videos.length,
    audio: byCategory.audio.length,
    gifs: byCategory.gifs.length,
    files: byCategory.files.length,
    links: links.length,
  }), [all, byCategory, links]);

  return (
    <>
      <div className="chat-header">
        <button className="gallery-back-btn" onClick={handleClose} aria-label="Back to chat" title="Back to chat">
          <ArrowLeft size={18} />
        </button>
        <h3>Attachments</h3>

        {activeTab !== 'links' && (
          <button
            className={`gallery-select-mode-toggle ${selectionMode ? 'active' : ''}`}
            onClick={() => {
              if (selectionMode && selection.selectedCount > 0) selection.deselectAll();
              setSelectionMode(!selectionMode);
            }}
            title="Select attachments"
          >
            <CheckSquare size={18} />
          </button>
        )}
        <button
          className="chat-info-toggle"
          id="galleryInfoToggle"
          aria-label="Toggle chat info panel"
          aria-expanded={infoPanelOpen}
          onClick={onToggleInfoPanel}
          title="Chat info"
        >
          <Info size={18} />
        </button>
      </div>

      <div className="gallery-tabs">
        {TABS.map(tab => (
          <button
            key={tab.key}
            className={`gallery-tab ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => handleTabChange(tab.key)}
          >
            {tab.label}
            {tabCounts[tab.key] > 0 && <span className="gallery-tab-count">{tabCounts[tab.key]}</span>}
          </button>
        ))}
      </div>

      <div id="line" />

      <div
        className={`gallery-scroll ${selectionMode && activeTab !== 'links' ? 'selection-mode-active' : ''}`}
        ref={scrollContainerRef}
        onScroll={handleScroll}
      >
        {groups.length === 0 ? (
          <div className="gallery-empty">No {activeTab === 'links' ? 'links' : 'attachments'} found</div>
        ) : (
          <>
            {stickyMonth && <div className="gallery-sticky-month">{stickyMonth}</div>}
            <div className="gallery-virtual-canvas" style={{ height: layout.totalHeight }}>
              {visibleRows.map(row => row.type === 'header' ? (
                <div
                  key={row.key}
                  className="gallery-date-separator gallery-virtual-row"
                  style={{ transform: `translateY(${row.top}px)`, height: row.height }}
                >
                  {row.label}
                </div>
              ) : (
                <div
                  key={row.key}
                  className="gallery-grid gallery-virtual-row"
                  style={{
                    transform: `translateY(${row.top}px)`,
                    height: layout.itemHeight,
                    gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`,
                  }}
                >
                  {row.items.map(item => item.category === 'links' ? (
                    <GalleryLinkCard
                      key={`link:${item.messageIndex}:${item.url}`}
                      link={item}
                      onJumpToMessage={handleViewerJump}
                    />
                  ) : (
                    <GalleryThumbnail
                      key={`${item.category}:${item.mediaPath.toLowerCase()}`}
                      attachment={item}
                      mediaState={mediaState}
                      onOpen={openViewer}
                      onSelect={toggleAttachment}
                      selectionMode={selectionMode}
                      isSelected={selection.isSelected(item)}
                    />
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {viewerState.open && activeTab !== 'links' && (
        <MediaViewer
          attachments={currentAttachments}
          initialIndex={viewerState.index}
          mediaState={mediaState}
          onClose={() => setViewerState({ open: false, index: viewerState.index })}
          onJumpToMessage={handleViewerJump}
          selection={selection}
        />
      )}
    </>
  );
};

export const AttachmentGallery = memo(AttachmentGalleryBase, (previous, next) => (
  previous.chatData === next.chatData
  && previous.mediaState === next.mediaState
  && previous.settings === next.settings
  && previous.isOpen === next.isOpen
  && previous.infoPanelOpen === next.infoPanelOpen
  && previous.defaultTab === next.defaultTab
  && previous.onTabChange === next.onTabChange
  && previous.selection === next.selection
));
