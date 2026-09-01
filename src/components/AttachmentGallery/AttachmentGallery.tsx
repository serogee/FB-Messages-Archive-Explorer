import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MessengerThread, MediaState, ResolvedAttachment } from '../../types/messenger';
import { ArrowLeft, CheckSquare, Image as ImageIcon, Film, Music, FileText, Play, Check, Info } from 'lucide-react';
import type { Settings } from '../../hooks/useSettings';
import { useAttachments, type AttachmentCategory } from '../../hooks/useAttachments';
import type { useSelection } from '../../hooks/useSelection';
import { findMediaFile } from '../../services/media';
import { imageThumbnailCache } from '../../services/imageThumbnailCache';
import { videoPosterCache } from '../../services/videoPosterCache';
import { MediaViewer } from '../MediaViewer/MediaViewer';
import { calculateGalleryLayout, getStickyMonth, type GalleryGroup, type GalleryLayoutRow } from './galleryLayout';

const VIRTUAL_OVERSCAN_PX = 600;

interface AttachmentGalleryProps {
  chatData: MessengerThread;
  mediaState: MediaState;
  settings: Settings;
  infoPanelOpen: boolean;
  onClose: () => void;
  onJumpToMessage: (messageIndex: number) => void;
  onToggleInfoPanel: () => void;
  defaultTab?: AttachmentCategory;
  selection: ReturnType<typeof useSelection>;
}

const TABS: { key: AttachmentCategory; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'photos', label: 'Photos' },
  { key: 'videos', label: 'Videos' },
  { key: 'audio', label: 'Audio' },
  { key: 'gifs', label: 'GIFs' },
  { key: 'files', label: 'Files' },
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

function groupByMonth(attachments: ResolvedAttachment[]): GalleryGroup[] {
  const groups: GalleryGroup[] = [];
  let currentLabel = '';

  for (let index = attachments.length - 1; index >= 0; index--) {
    const attachment = attachments[index];
    const label = attachment.timestamp ? formatMonthYear(attachment.timestamp) : 'Unknown Date';
    if (label !== currentLabel) {
      currentLabel = label;
      groups.push({ key: `${label}:${groups.length}`, label, items: [] });
    }
    groups[groups.length - 1].items.push(attachment);
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

const AttachmentGalleryBase = function AttachmentGallery({
  chatData,
  mediaState,
  settings: _settings,
  infoPanelOpen,
  onClose,
  onJumpToMessage,
  onToggleInfoPanel,
  defaultTab = 'all',
  selection,
}: AttachmentGalleryProps) {
  const { all, byCategory } = useAttachments(chatData, mediaState);
  const [activeTab, setActiveTab] = useState<AttachmentCategory>(defaultTab);
  const [selectionMode, setSelectionMode] = useState(false);
  const [viewerState, setViewerState] = useState({ open: false, index: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const scrollPositions = useRef<Partial<Record<AttachmentCategory, number>>>({});
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);

  const currentItems = activeTab === 'all' ? all : byCategory[activeTab];
  const groups = useMemo(() => groupByMonth(currentItems), [currentItems]);
  const layout = useMemo(() => calculateGalleryLayout(groups, viewport.width), [groups, viewport.width]);

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
  }, []);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const savedPosition = scrollPositions.current[activeTab] || 0;
    container.scrollTop = savedPosition;
    setScrollTop(savedPosition);
  }, [activeTab]);

  const handleScroll = useCallback(() => {
    if (scrollFrameRef.current != null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const container = scrollContainerRef.current;
      if (!container) return;
      scrollPositions.current[activeTab] = container.scrollTop;
      setScrollTop(container.scrollTop);
    });
  }, [activeTab]);

  const handleTabChange = useCallback((tab: AttachmentCategory) => {
    const container = scrollContainerRef.current;
    if (container) scrollPositions.current[activeTab] = container.scrollTop;
    if (scrollFrameRef.current != null) {
      cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    setActiveTab(tab);
  }, [activeTab]);

  const openViewer = useCallback((attachment: ResolvedAttachment) => {
    const index = currentItems.indexOf(attachment);
    setViewerState({ open: true, index: index >= 0 ? index : 0 });
  }, [currentItems]);

  const toggleAttachment = useCallback((attachment: ResolvedAttachment) => {
    selection.toggle(attachment);
  }, [selection]);

  const handleViewerJump = useCallback((messageIndex: number) => {
    setViewerState({ open: false, index: 0 });
    onJumpToMessage(messageIndex);
    onClose();
  }, [onJumpToMessage, onClose]);

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

  const tabCounts = useMemo<Record<AttachmentCategory, number>>(() => ({
    all: all.length,
    photos: byCategory.photos.length,
    videos: byCategory.videos.length,
    audio: byCategory.audio.length,
    gifs: byCategory.gifs.length,
    files: byCategory.files.length,
  }), [all, byCategory]);

  return (
    <>
      <div className="chat-header">
        <button className="gallery-back-btn" onClick={onClose} aria-label="Back to chat" title="Back to chat">
          <ArrowLeft size={18} />
        </button>
        <h3>Attachments</h3>

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
        className={`gallery-scroll ${selectionMode ? 'selection-mode-active' : ''}`}
        ref={scrollContainerRef}
        onScroll={handleScroll}
      >
        {groups.length === 0 ? (
          <div className="gallery-empty">No attachments found</div>
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
                    height: layout.itemSize,
                    gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`,
                  }}
                >
                  {row.items.map(attachment => (
                    <GalleryThumbnail
                      key={`${attachment.category}:${attachment.mediaPath.toLowerCase()}`}
                      attachment={attachment}
                      mediaState={mediaState}
                      onOpen={openViewer}
                      onSelect={toggleAttachment}
                      selectionMode={selectionMode}
                      isSelected={selection.isSelected(attachment)}
                    />
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {viewerState.open && (
        <MediaViewer
          attachments={currentItems}
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
  && previous.infoPanelOpen === next.infoPanelOpen
  && previous.defaultTab === next.defaultTab
  && previous.selection === next.selection
));
