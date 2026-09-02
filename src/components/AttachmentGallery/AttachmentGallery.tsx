import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MessengerThread, MediaState, ResolvedAttachment, ResolvedLink, SelectableItem } from '../../types/messenger';
import { ArrowLeft, CheckSquare, Image as ImageIcon, Film, Music, FileText, Play, Check, Info, ExternalLink, Link as LinkIcon, MessageSquare, UserRound, Bookmark } from 'lucide-react';
import type { Settings } from '../../hooks/useSettings';
import { useAttachments, useSharedLinks, type GalleryCategory } from '../../hooks/useAttachments';
import type { useSelection } from '../../hooks/useSelection';
import { findMediaFile } from '../../services/media';
import { imageThumbnailCache } from '../../services/imageThumbnailCache';
import { videoPosterCache } from '../../services/videoPosterCache';
import { blobCache, openMediaEntryInNewTab } from '../../services/blobCache';
import { getAudioMetadata, type AudioMetadata } from '../../services/audioMetadata';
import { formatFileSize } from '../../services/storage';
import { MediaViewer } from '../MediaViewer/MediaViewer';
import { MediaFileSize } from '../MediaFileSize';
import { calculateGalleryLayout, getStickyMonth, type GalleryGroup, type GalleryItem, type GalleryLayoutRow } from './galleryLayout';

const VIRTUAL_OVERSCAN_PX = 600;
const COMPACT_CARD_MIN_WIDTH = 220;
const COMPACT_CARD_HEIGHT = 128;
const JUMP_HIGHLIGHT_DURATION_MS = 2200;

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
  showStickers: boolean;
  attachmentJumpTarget?: AttachmentJumpTarget | null;
  onAttachmentJumpHandled?: () => void;
  attachmentBookmarkingEnabled: boolean;
  isAttachmentBookmarked: (item: SelectableItem) => boolean;
  onToggleAttachmentBookmark: (item: SelectableItem) => Promise<void>;
  bookmarkBusy: boolean;
}

export type AttachmentJumpTarget = SelectableItem & { tab: GalleryCategory };

const TABS: { key: GalleryCategory; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'photos', label: 'Photos' },
  { key: 'videos', label: 'Videos' },
  { key: 'audio', label: 'Audio' },
  { key: 'gifs', label: 'GIFs' },
  { key: 'files', label: 'Files' },
  { key: 'links', label: 'Links' },
  { key: 'stickers', label: 'Stickers' },
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

function getGalleryItemKey(item: SelectableItem): string {
  return item.category === 'links'
    ? `links:${item.messageIndex}:${item.url}`
    : `${item.category}:${item.messageIndex}:${item.mediaPath.toLowerCase()}`;
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
  onOpenFile: (attachment: ResolvedAttachment) => void;
  onJumpToMessage: (messageIndex: number) => void;
  onSelect: (attachment: ResolvedAttachment) => void;
  selectionMode: boolean;
  isSelected: boolean;
  isBookmarked: boolean;
  isJumpHighlighted: boolean;
  compactFileCard: boolean;
  compactAudioCard: boolean;
  showAuthorAndSize: boolean;
}

function formatAudioDuration(seconds: number | null): string {
  if (seconds === null) return 'Unknown duration';
  const totalSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
    : `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

function AudioCardMetadata({ attachment, mediaState }: { attachment: ResolvedAttachment; mediaState: MediaState }) {
  const [metadata, setMetadata] = useState<AudioMetadata | null>(null);

  useEffect(() => {
    const entry = attachment.mediaEntry || findMediaFile(mediaState, attachment.mediaPath);
    if (!entry) {
      setMetadata({ duration: null, size: null });
      return;
    }

    let mounted = true;
    setMetadata(null);
    void getAudioMetadata(entry).then(result => {
      if (mounted) setMetadata(result);
    });
    return () => { mounted = false; };
  }, [attachment, mediaState]);

  return (
    <div className="gallery-audio-meta gallery-author-size-meta">
      <span className="gallery-audio-details">
        {metadata
          ? `${formatAudioDuration(metadata.duration)} · ${metadata.size === null ? 'Unknown size' : formatFileSize(metadata.size)}`
          : 'Loading…'}
      </span>
      <span className="gallery-link-sender" title={`Sent by ${attachment.sender}`}>
        <UserRound size={12} />
        <span>{attachment.sender}</span>
      </span>
    </div>
  );
}

function AttachmentAuthorAndSize({ attachment, mediaState }: { attachment: ResolvedAttachment; mediaState: MediaState }) {
  return (
    <div className="gallery-file-meta gallery-author-size-meta gallery-even-metadata-spacing">
      <MediaFileSize
        entry={attachment.mediaEntry || findMediaFile(mediaState, attachment.mediaPath)}
        className="gallery-thumb-file-size"
      />
      <span className="gallery-link-sender" title={`Sent by ${attachment.sender}`}>
        <UserRound size={12} />
        <span>{attachment.sender}</span>
      </span>
    </div>
  );
}

function AudioAuthorDurationAndSize({ attachment, mediaState }: { attachment: ResolvedAttachment; mediaState: MediaState }) {
  const [metadata, setMetadata] = useState<AudioMetadata | null>(null);

  useEffect(() => {
    const entry = attachment.mediaEntry || findMediaFile(mediaState, attachment.mediaPath);
    if (!entry) {
      setMetadata({ duration: null, size: null });
      return;
    }

    let mounted = true;
    setMetadata(null);
    void getAudioMetadata(entry).then(result => {
      if (mounted) setMetadata(result);
    });
    return () => { mounted = false; };
  }, [attachment, mediaState]);

  return (
    <div className="gallery-file-meta gallery-author-size-meta gallery-even-metadata-spacing">
      <span className="gallery-audio-details">
        {metadata
          ? `${formatAudioDuration(metadata.duration)} · ${metadata.size === null ? 'Unknown size' : formatFileSize(metadata.size)}`
          : 'Loading…'}
      </span>
      <span className="gallery-link-sender" title={`Sent by ${attachment.sender}`}>
        <UserRound size={12} />
        <span>{attachment.sender}</span>
      </span>
    </div>
  );
}

const GalleryThumbnail = memo(function GalleryThumbnail({
  attachment,
  mediaState,
  onOpen,
  onOpenFile,
  onJumpToMessage,
  onSelect,
  selectionMode,
  isSelected,
  isBookmarked,
  isJumpHighlighted,
  compactFileCard,
  compactAudioCard,
  showAuthorAndSize,
}: GalleryThumbnailProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);

  useEffect(() => {
    if (attachment.category !== 'photos' && attachment.category !== 'gifs' && attachment.category !== 'videos' && attachment.category !== 'stickers') {
      setUrl(null);
      setVideoDuration(null);
      return;
    }

    const entry = attachment.mediaEntry || findMediaFile(mediaState, attachment.mediaPath);
    if (!entry) {
      setUrl(null);
      setVideoDuration(null);
      return;
    }

    if (attachment.category === 'stickers') {
      const cached = blobCache.get(entry) || entry.url || null;
      if (cached) {
        setUrl(cached);
        setVideoDuration(null);
        return;
      }

      let mounted = true;
      setUrl(null);
      setVideoDuration(null);
      void blobCache.getOrCreate(entry).then(stickerUrl => {
        if (mounted) setUrl(stickerUrl);
      });
      return () => { mounted = false; };
    }

    if (attachment.category === 'videos') {
      const cached = videoPosterCache.getDetails(entry);
      if (cached) {
        setUrl(cached.url);
        setVideoDuration(cached.duration);
        return;
      }

      let mounted = true;
      setUrl(null);
      setVideoDuration(null);
      void videoPosterCache.getOrCreateDetails(entry).then(details => {
        if (mounted && details) {
          setUrl(details.url);
          setVideoDuration(details.duration);
        }
      });

      return () => { mounted = false; };
    }

    let mounted = true;
    setUrl(null);
    setVideoDuration(null);
    const cached = imageThumbnailCache.get(entry);
    if (cached) {
      setUrl(cached);
      return;
    }
    void imageThumbnailCache.getOrCreate(entry).then(thumbnailUrl => {
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
    else if (category === 'files') onOpenFile(attachment);
    else onOpen(attachment);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === ' ' || event.key === 'Enter') activate(event);
  };

  return (
    <div
      className={`gallery-thumb ${category === 'audio' || category === 'files' ? 'gallery-thumb-file' : ''} ${category === 'stickers' ? 'gallery-thumb-sticker' : ''} ${compactFileCard ? 'gallery-thumb-file-compact' : ''} ${compactAudioCard ? 'gallery-thumb-audio-compact' : ''} ${isSelected ? 'selected' : ''} ${isJumpHighlighted ? 'jump-highlight' : ''}`}
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

      {(category === 'photos' || category === 'gifs' || category === 'stickers') ? (
        url
          ? <img src={url} alt={filename} className="gallery-thumb-img" />
          : <div className="gallery-thumb-placeholder"><ImageIcon size={24} /></div>
      ) : category === 'videos' ? (
        <>
          {url
            ? <img src={url} alt={filename} className="gallery-thumb-img" />
            : <div className="gallery-thumb-placeholder"><Film size={24} /></div>}
          {videoDuration !== null && <div className="gallery-video-duration">{formatAudioDuration(videoDuration)}</div>}
          <div className="gallery-thumb-play"><Play fill="currentColor" size={24} /></div>
        </>
      ) : category === 'audio' ? (
        <>
          <div className="gallery-thumb-icon"><Music size={24} /></div>
          <div className="gallery-thumb-name">{filename}</div>
          {compactAudioCard && <AudioCardMetadata attachment={attachment} mediaState={mediaState} />}
          {showAuthorAndSize && <AudioAuthorDurationAndSize attachment={attachment} mediaState={mediaState} />}
        </>
      ) : (
        <>
          <div className="gallery-thumb-icon"><FileText size={24} /></div>
          <div className="gallery-thumb-name">{filename}</div>
          {showAuthorAndSize
            ? <AttachmentAuthorAndSize attachment={attachment} mediaState={mediaState} />
            : <MediaFileSize
                entry={attachment.mediaEntry || findMediaFile(mediaState, attachment.mediaPath)}
                className="gallery-thumb-file-size"
              />}
          {compactFileCard && (
            <div className="gallery-file-meta">
              <span className="gallery-link-sender" title={`Sent by ${attachment.sender}`}>
                <UserRound size={12} />
                <span>{attachment.sender}</span>
              </span>
              {!selectionMode && (
                <span className="gallery-file-open"><FileText size={12} /> Open file</span>
              )}
            </div>
          )}
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

      {!selectionMode && category === 'files' && (
        <button
          type="button"
          className="gallery-open-viewer-btn with-jump"
          onClick={event => {
            event.preventDefault();
            event.stopPropagation();
            onOpen(attachment);
          }}
          aria-label={`View information for ${filename}`}
          title="Open in viewer"
        >
          <Info size={15} />
        </button>
      )}

      {!selectionMode && (
        <button
          type="button"
          className="gallery-link-message"
          onClick={event => {
            event.preventDefault();
            event.stopPropagation();
            onJumpToMessage(attachment.messageIndex);
          }}
          title="Jump to message"
          aria-label={`Jump to message containing ${filename}`}
        >
          <MessageSquare size={14} />
        </button>
      )}

      {isBookmarked && (
        <span className="gallery-bookmark-indicator" title="Bookmarked" aria-label="Bookmarked attachment">
          <Bookmark size={15} fill="currentColor" />
        </span>
      )}
    </div>
  );
}, (previous, next) => (
  previous.attachment === next.attachment
  && previous.mediaState === next.mediaState
  && previous.onOpen === next.onOpen
  && previous.onOpenFile === next.onOpenFile
  && previous.onJumpToMessage === next.onJumpToMessage
  && previous.onSelect === next.onSelect
  && previous.selectionMode === next.selectionMode
  && previous.isSelected === next.isSelected
  && previous.isBookmarked === next.isBookmarked
  && previous.isJumpHighlighted === next.isJumpHighlighted
  && previous.compactFileCard === next.compactFileCard
  && previous.compactAudioCard === next.compactAudioCard
  && previous.showAuthorAndSize === next.showAuthorAndSize
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
  onOpen,
  onSelect,
  selectionMode,
  isSelected,
  isBookmarked,
  isJumpHighlighted,
  openViewerOnCard,
}: {
  link: ResolvedLink;
  onJumpToMessage: (messageIndex: number) => void;
  onOpen: (link: ResolvedLink) => void;
  onSelect: (link: ResolvedLink) => void;
  selectionMode: boolean;
  isSelected: boolean;
  isBookmarked: boolean;
  isJumpHighlighted: boolean;
  openViewerOnCard: boolean;
}) {
  const hostname = getLinkHostname(link.url);
  const activateLink = (event: React.MouseEvent | React.KeyboardEvent) => {
    if (!selectionMode && !openViewerOnCard) return;
    event.preventDefault();
    event.stopPropagation();
    if (selectionMode) onSelect(link);
    else onOpen(link);
  };
  const content = (
    <>
      <LinkIcon size={24} className="gallery-link-icon" />
      <strong className="gallery-link-host">{hostname}</strong>
      <span className="gallery-link-url">{link.label || link.url}</span>
      <span className="gallery-link-meta">
        <span className="gallery-link-sender" title={`Sent by ${link.sender}`}>
          <UserRound size={12} />
          <span>{link.sender}</span>
        </span>
        {!openViewerOnCard && !selectionMode && <span className="gallery-link-open"><ExternalLink size={13} /> Open link</span>}
      </span>
    </>
  );
  return (
    <div
      className={`gallery-thumb gallery-link-card ${openViewerOnCard ? 'gallery-link-card-square' : ''} ${isSelected ? 'selected' : ''} ${isJumpHighlighted ? 'jump-highlight' : ''}`}
      title={link.url}
      onClick={activateLink}
      onKeyDown={event => {
        if ((selectionMode || openViewerOnCard) && (event.key === ' ' || event.key === 'Enter')) activateLink(event);
      }}
      role={selectionMode || openViewerOnCard ? 'button' : undefined}
      tabIndex={selectionMode || openViewerOnCard ? 0 : undefined}
    >
      {openViewerOnCard ? (
        <div className="gallery-link-anchor">{content}</div>
      ) : (
        <a
          href={link.url}
          target="_blank"
          rel="noreferrer"
          className="gallery-link-anchor"
          tabIndex={selectionMode ? -1 : 0}
          aria-disabled={selectionMode}
        >
          {content}
        </a>
      )}
      {selectionMode && (
        <div
          className="select-checkbox"
          role="checkbox"
          aria-checked={isSelected}
          onClick={event => {
            event.preventDefault();
            event.stopPropagation();
            onSelect(link);
          }}
        >
          {isSelected && <Check size={14} />}
        </div>
      )}
      {(selectionMode || !openViewerOnCard) && (
        <button
          type="button"
          className={`gallery-open-viewer-btn ${selectionMode ? '' : 'with-jump'}`}
          onClick={event => {
            event.preventDefault();
            event.stopPropagation();
            onOpen(link);
          }}
          aria-label={`View information for ${hostname}`}
          title="Open in viewer"
        >
          <Info size={15} />
        </button>
      )}
      {!selectionMode && <button
        type="button"
        className="gallery-link-message"
        onClick={event => {
          event.preventDefault();
          event.stopPropagation();
          onJumpToMessage(link.messageIndex);
        }}
        title="Jump to message"
        aria-label={`Jump to message containing ${hostname}`}
      >
        <MessageSquare size={14} />
      </button>}
      {isBookmarked && (
        <span className="gallery-bookmark-indicator" title="Bookmarked" aria-label="Bookmarked link">
          <Bookmark size={15} fill="currentColor" />
        </span>
      )}
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
  showStickers,
  attachmentJumpTarget,
  onAttachmentJumpHandled,
  attachmentBookmarkingEnabled,
  isAttachmentBookmarked,
  onToggleAttachmentBookmark,
  bookmarkBusy,
}: AttachmentGalleryProps) {
  const { all, byCategory } = useAttachments(chatData, mediaState);
  const links = useSharedLinks(chatData);
  const allItems = useMemo<GalleryItem[]>(
    () => [...all, ...links].sort((left, right) => left.messageIndex - right.messageIndex),
    [all, links],
  );
  const [activeTab, setActiveTab] = useState<GalleryCategory>(defaultTab);
  const [selectionMode, setSelectionMode] = useState(false);
  const [viewerState, setViewerState] = useState({ open: false, index: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [jumpHighlightedKey, setJumpHighlightedKey] = useState<string | null>(null);
  const scrollPositions = useRef<Partial<Record<GalleryCategory, number>>>({});
  const tabRefs = useRef<Partial<Record<GalleryCategory, HTMLButtonElement | null>>>({});
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const restoreFrameRef = useRef<number | null>(null);
  const jumpHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoringScrollRef = useRef(false);
  const isOpenRef = useRef(isOpen);

  const currentItems = useMemo<GalleryItem[]>(
    () => activeTab === 'links' ? links : activeTab === 'all' ? allItems : byCategory[activeTab],
    [activeTab, allItems, byCategory, links],
  );
  const compactCardTab = activeTab === 'links' || activeTab === 'files' || activeTab === 'audio';
  const groups = useMemo(() => groupByMonth(currentItems), [currentItems]);
  const layout = useMemo(
    () => calculateGalleryLayout(
      groups,
      viewport.width,
      compactCardTab ? COMPACT_CARD_MIN_WIDTH : undefined,
      undefined,
      compactCardTab ? COMPACT_CARD_HEIGHT : undefined,
    ),
    [compactCardTab, groups, viewport.width],
  );

  useEffect(() => {
    const nextTab = !showStickers && defaultTab === 'stickers' ? 'all' : defaultTab;
    setActiveTab(nextTab);
    if (nextTab !== defaultTab) onTabChange(nextTab);
  }, [defaultTab, onTabChange, showStickers]);
  useEffect(() => {
    if (selection.selectedCount > 0) setSelectionMode(true);
  }, [selection.selectedCount]);

  useEffect(() => setSelectionMode(false), [selection.clearVersion]);

  const highlightAttachment = useCallback((item: SelectableItem) => {
    if (jumpHighlightTimerRef.current != null) clearTimeout(jumpHighlightTimerRef.current);
    setJumpHighlightedKey(getGalleryItemKey(item));
    jumpHighlightTimerRef.current = setTimeout(() => {
      jumpHighlightTimerRef.current = null;
      setJumpHighlightedKey(null);
    }, JUMP_HIGHLIGHT_DURATION_MS);
  }, []);

  const clearJumpHighlight = useCallback(() => {
    if (jumpHighlightTimerRef.current != null) {
      clearTimeout(jumpHighlightTimerRef.current);
      jumpHighlightTimerRef.current = null;
    }
    setJumpHighlightedKey(null);
  }, []);

  useLayoutEffect(() => {
    if (!attachmentJumpTarget || activeTab !== attachmentJumpTarget.tab) return;
    const container = scrollContainerRef.current;
    if (!container || layout.rows.length === 0) return;

    const targetRow = layout.rows.find(row => row.type === 'items' && row.items.some(item => (
      getGalleryItemKey(item) === getGalleryItemKey(attachmentJumpTarget)
    )));

    if (!targetRow) return;

    const nextScrollTop = Math.max(0, targetRow.top - 40);
    restoringScrollRef.current = true;
    container.scrollTop = nextScrollTop;
    scrollPositions.current[activeTab] = nextScrollTop;
    setScrollTop(nextScrollTop);
    highlightAttachment(attachmentJumpTarget);
    requestAnimationFrame(() => {
      restoringScrollRef.current = false;
      onAttachmentJumpHandled?.();
    });
  }, [activeTab, attachmentJumpTarget, highlightAttachment, layout.rows, onAttachmentJumpHandled]);

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
    if (jumpHighlightTimerRef.current != null) clearTimeout(jumpHighlightTimerRef.current);
  }, []);

  useLayoutEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const container = tabsContainerRef.current;
    const tab = tabRefs.current[activeTab];
    if (!container || !tab) return;

    const tabStart = tab.offsetLeft;
    const tabEnd = tabStart + tab.offsetWidth;
    const visibleStart = container.scrollLeft;
    const visibleEnd = visibleStart + container.clientWidth;

    if (tabStart < visibleStart) container.scrollLeft = tabStart;
    else if (tabEnd > visibleEnd) container.scrollLeft = tabEnd - container.clientWidth;
  }, [activeTab, isOpen]);

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
    clearJumpHighlight();
    if (scrollFrameRef.current != null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (!isOpenRef.current || restoringScrollRef.current) return;
      const container = scrollContainerRef.current;
      if (!container) return;
      scrollPositions.current[activeTab] = container.scrollTop;
      setScrollTop(container.scrollTop);
    });
  }, [activeTab, clearJumpHighlight]);

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
    clearJumpHighlight();
    onTabChange(tab);
  }, [activeTab, clearJumpHighlight, onTabChange]);

  useEffect(() => {
    if (!isOpen || viewerState.open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'PageUp' && event.key !== 'PageDown') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;

      const tabs = showStickers ? TABS : TABS.filter(tab => tab.key !== 'stickers');
      const currentIndex = tabs.findIndex(tab => tab.key === activeTab);
      const direction = event.key === 'PageUp' ? -1 : 1;
      const nextIndex = Math.min(tabs.length - 1, Math.max(0, currentIndex + direction));
      const nextTab = tabs[nextIndex];
      if (!nextTab || nextTab.key === activeTab) return;

      event.preventDefault();
      handleTabChange(nextTab.key);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [activeTab, handleTabChange, isOpen, showStickers, viewerState.open]);

  const openViewer = useCallback((attachment: ResolvedAttachment) => {
    const index = currentItems.indexOf(attachment);
    setViewerState({ open: true, index: index >= 0 ? index : 0 });
  }, [currentItems]);

  const openLinkViewer = useCallback((link: ResolvedLink) => {
    const index = currentItems.indexOf(link);
    setViewerState({ open: true, index: index >= 0 ? index : 0 });
  }, [currentItems]);

  const openFileInNewTab = useCallback((attachment: ResolvedAttachment) => {
    const entry = attachment.mediaEntry || findMediaFile(mediaState, attachment.mediaPath);
    openMediaEntryInNewTab(entry);
  }, [mediaState]);

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

  const handleViewerAttachmentJump = useCallback((targetItem: SelectableItem) => {
    const tab = activeTab === targetItem.category ? targetItem.category : 'all';
    setViewerState({ open: false, index: 0 });
    if (activeTab !== tab) {
      setActiveTab(tab);
      onTabChange(tab);
    }
    onAttachmentJumpHandled?.();
    requestAnimationFrame(() => {
      const targetRow = layout.rows.find(row => row.type === 'items' && row.items.some(candidate => (
        getGalleryItemKey(candidate) === getGalleryItemKey(targetItem)
      )));
      const container = scrollContainerRef.current;
      if (!targetRow || !container) {
        restoringScrollRef.current = false;
        return;
      }
      const nextScrollTop = Math.max(0, targetRow.top - 40);
      restoringScrollRef.current = true;
      container.scrollTop = nextScrollTop;
      scrollPositions.current[tab] = nextScrollTop;
      setScrollTop(nextScrollTop);
      highlightAttachment(targetItem);
      requestAnimationFrame(() => {
        restoringScrollRef.current = false;
      });
    });
  }, [activeTab, highlightAttachment, layout.rows, onAttachmentJumpHandled, onTabChange]);

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
    all: allItems.length,
    photos: byCategory.photos.length,
    videos: byCategory.videos.length,
    audio: byCategory.audio.length,
    gifs: byCategory.gifs.length,
    files: byCategory.files.length,
    links: links.length,
    stickers: byCategory.stickers.length,
  }), [allItems, byCategory, links]);

  const visibleTabs = showStickers ? TABS : TABS.filter(tab => tab.key !== 'stickers');

  return (
    <>
      <div className="chat-header">
        <button className="gallery-back-btn" onClick={handleClose} aria-label="Back to chat" title="Back to chat">
          <ArrowLeft size={18} />
        </button>
        <h3>Attachments</h3>

        <button
            className={`gallery-select-mode-toggle ${selectionMode ? 'active' : ''}`}
            onClick={() => {
              if (selectionMode && selection.selectedCount > 0) selection.deselectAll();
              setSelectionMode(!selectionMode);
            }}
            title="Select attachments and links"
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

      <div className="gallery-tabs" ref={tabsContainerRef}>
        {visibleTabs.map(tab => (
          <button
            key={tab.key}
            ref={element => { tabRefs.current[tab.key] = element; }}
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
                      onOpen={openLinkViewer}
                      onSelect={selection.toggle}
                      selectionMode={selectionMode}
                      isSelected={selection.isSelected(item)}
                      isBookmarked={attachmentBookmarkingEnabled && isAttachmentBookmarked(item)}
                      isJumpHighlighted={jumpHighlightedKey === getGalleryItemKey(item)}
                      openViewerOnCard={activeTab === 'all'}
                    />
                  ) : (
                    <GalleryThumbnail
                      key={`${item.category}:${item.mediaPath.toLowerCase()}`}
                      attachment={item}
                      mediaState={mediaState}
                      onOpen={openViewer}
                      onOpenFile={openFileInNewTab}
                      onJumpToMessage={handleViewerJump}
                      onSelect={toggleAttachment}
                      selectionMode={selectionMode}
                      isSelected={selection.isSelected(item)}
                      isBookmarked={attachmentBookmarkingEnabled && isAttachmentBookmarked(item)}
                      isJumpHighlighted={jumpHighlightedKey === getGalleryItemKey(item)}
                      compactFileCard={activeTab === 'files' && item.category === 'files'}
                      compactAudioCard={activeTab === 'audio' && item.category === 'audio'}
                      showAuthorAndSize={activeTab === 'all' && (item.category === 'audio' || item.category === 'files')}
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
          items={currentItems}
          initialIndex={viewerState.index}
          mediaState={mediaState}
          onClose={() => setViewerState({ open: false, index: viewerState.index })}
          onJumpToMessage={handleViewerJump}
          onJumpToAttachment={handleViewerAttachmentJump}
          selection={selection}
          selectionMode={selectionMode}
          reverseNavigation
          useDateFilename={_settings.dateAttachmentFilenames}
          chatTitle={chatData.title}
          filenameTemplate={_settings.attachmentFilenameTemplate}
          allowLongFilenames={_settings.longAttachmentFilenames}
          attachmentBookmarkingEnabled={attachmentBookmarkingEnabled}
          isBookmarked={isAttachmentBookmarked}
          onToggleBookmark={onToggleAttachmentBookmark}
          bookmarkBusy={bookmarkBusy}
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
  && previous.showStickers === next.showStickers
  && previous.attachmentBookmarkingEnabled === next.attachmentBookmarkingEnabled
  && previous.isAttachmentBookmarked === next.isAttachmentBookmarked
  && previous.onToggleAttachmentBookmark === next.onToggleAttachmentBookmark
  && previous.bookmarkBusy === next.bookmarkBusy
  && previous.attachmentJumpTarget === next.attachmentJumpTarget
  && previous.onTabChange === next.onTabChange
  && previous.selection === next.selection
));
