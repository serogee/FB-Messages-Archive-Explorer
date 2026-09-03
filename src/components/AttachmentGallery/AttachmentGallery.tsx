import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MessengerThread, MediaState, ResolvedAttachment, ResolvedLink, SelectableItem } from '../../types/messenger';
import { ArrowLeft, CheckSquare, Image as ImageIcon, Film, Music, FileText, Play, Check, CircleHelp, Info, ExternalLink, Link as LinkIcon, MessageSquare, UserRound, Bookmark, Filter, ListMinus, ListPlus, Minus, Plus, Search, X } from 'lucide-react';
import type { Settings } from '../../hooks/useSettings';
import { useAttachments, useSharedLinks, type GalleryCategory } from '../../hooks/useAttachments';
import { shouldConfirmBulkSelection, type useSelection } from '../../hooks/useSelection';
import { findMediaFile } from '../../services/media';
import { imageThumbnailCache } from '../../services/imageThumbnailCache';
import { videoPosterCache } from '../../services/videoPosterCache';
import { blobCache, openMediaEntryInNewTab } from '../../services/blobCache';
import { getAudioMetadata, type AudioMetadata } from '../../services/audioMetadata';
import { formatFileSize } from '../../services/storage';
import { MediaViewer } from '../MediaViewer/MediaViewer';
import { MediaFileSize } from '../MediaFileSize';
import { calculateGalleryLayout, getStickyMonth, type GalleryGroup, type GalleryItem, type GalleryLayoutRow } from './galleryLayout';
import { applyGalleryFilters, getGallerySenderOptions, getGallerySenderSearchResults, parseGallerySenderSearch, shouldClearFiltersForGalleryJump, useGalleryFilters, type GalleryBookmarkFilter } from '../../hooks/useGalleryFilters';
import { BulkSelectionConfirmModal } from '../Modals/BulkSelectionConfirmModal';
import { ShortcutsModal } from '../Modals/ShortcutsModal';
import { getAttachmentJumpTab } from './attachmentJump';

const VIRTUAL_OVERSCAN_PX = 600;
const COMPACT_CARD_MIN_WIDTH = 220;
const COMPACT_CARD_HEIGHT = 128;
const JUMP_HIGHLIGHT_DURATION_MS = 2200;
const NO_BOOKMARK_LOOKUP = () => false;

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

      setUrl(null);
      setVideoDuration(null);
      return videoPosterCache.subscribe(entry, details => {
        if (details) {
          setUrl(details.url);
          setVideoDuration(details.duration);
        }
      });
    }

    setUrl(null);
    setVideoDuration(null);
    const cached = imageThumbnailCache.get(entry);
    if (cached) {
      setUrl(cached);
      return;
    }
    return imageThumbnailCache.subscribe(entry, thumbnailUrl => {
      if (thumbnailUrl) setUrl(thumbnailUrl);
    });
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
  const [filterExpanded, setFilterExpanded] = useState(false);
  const [senderSearch, setSenderSearch] = useState('');
  const [senderSearchOpen, setSenderSearchOpen] = useState(false);
  const [senderResultRow, setSenderResultRow] = useState(0);
  const [senderResultAction, setSenderResultAction] = useState<'default' | 'opposite'>('default');
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [bulkSelectionConfirmationAction, setBulkSelectionConfirmationAction] = useState<'select' | 'deselect' | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [jumpHighlightedKey, setJumpHighlightedKey] = useState<string | null>(null);
  const scrollPositions = useRef<Partial<Record<GalleryCategory, number>>>({});
  const tabRefs = useRef<Partial<Record<GalleryCategory, HTMLButtonElement | null>>>({});
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const senderSearchInputRef = useRef<HTMLInputElement>(null);
  const senderResultsRef = useRef<HTMLDivElement>(null);
  const senderFilterViewportRef = useRef<HTMLDivElement>(null);
  const senderFilterScrollRef = useRef<HTMLDivElement>(null);
  const senderTagRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const scrollFrameRef = useRef<number | null>(null);
  const restoreFrameRef = useRef<number | null>(null);
  const jumpHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoringScrollRef = useRef(false);
  const isOpenRef = useRef(isOpen);
  const previousChatDataRef = useRef(chatData);
  const filters = useGalleryFilters();

  const currentItems = useMemo<GalleryItem[]>(
    () => activeTab === 'links' ? links : activeTab === 'all' ? allItems : byCategory[activeTab],
    [activeTab, allItems, byCategory, links],
  );
  const effectiveBookmarkFilter: GalleryBookmarkFilter = attachmentBookmarkingEnabled
    ? filters.bookmarkFilter
    : 'all';
  const bookmarkFilterLookup = effectiveBookmarkFilter === 'all'
    ? NO_BOOKMARK_LOOKUP
    : isAttachmentBookmarked;
  const hasActiveFilters = filters.includeSenders.size > 0
    || filters.excludeSenders.size > 0
    || effectiveBookmarkFilter !== 'all';
  const filterSnapshotRef = useRef({
    includeSenders: filters.includeSenders,
    excludeSenders: filters.excludeSenders,
    bookmarkFilter: effectiveBookmarkFilter,
  });
  const filteredItems = useMemo(
    () => applyGalleryFilters(currentItems, {
      includeSenders: filters.includeSenders,
      excludeSenders: filters.excludeSenders,
      bookmarkFilter: effectiveBookmarkFilter,
    }, bookmarkFilterLookup),
    [
      bookmarkFilterLookup,
      currentItems,
      effectiveBookmarkFilter,
      filters.excludeSenders,
      filters.includeSenders,
    ],
  );
  const availableSenders = useMemo(() => {
    return getGallerySenderOptions(
      chatData.participants.map(participant => participant.name),
      allItems,
      currentItems,
    );
  }, [allItems, chatData.participants, currentItems]);
  const { mode: senderSearchMode, currentTabOnly: searchCurrentTabSendersOnly } = parseGallerySenderSearch(senderSearch);
  const senderSearchResults = useMemo(
    () => getGallerySenderSearchResults(
      searchCurrentTabSendersOnly
        ? availableSenders.filter(sender => sender.hasCurrentTabItems)
        : availableSenders,
      senderSearch,
      20,
    ),
    [
      availableSenders,
      searchCurrentTabSendersOnly,
      senderSearch,
    ],
  );
  const selectedSenderFilters = useMemo(() => availableSenders.filter(sender => (
    filters.includeSenders.has(sender.key) || filters.excludeSenders.has(sender.key)
  )), [availableSenders, filters.excludeSenders, filters.includeSenders]);

  const updateSenderFilterScrollIndicators = useCallback(() => {
    const viewport = senderFilterViewportRef.current;
    const scroller = senderFilterScrollRef.current;
    if (!viewport || !scroller) return;
    const scrollRange = scroller.scrollWidth - scroller.clientWidth;
    const overflowing = scrollRange > 1;
    viewport.classList.toggle('overflowing', overflowing);
    if (!overflowing) return;

    const thumbWidth = Math.max(18, scroller.clientWidth * (scroller.clientWidth / scroller.scrollWidth));
    const thumbTravel = Math.max(0, scroller.clientWidth - thumbWidth);
    const thumbLeft = thumbTravel * (scroller.scrollLeft / scrollRange);
    viewport.style.setProperty('--gallery-filter-thumb-width', `${thumbWidth}px`);
    viewport.style.setProperty('--gallery-filter-thumb-left', `${thumbLeft}px`);
  }, []);

  useEffect(() => {
    setSenderResultRow(row => Math.min(row, Math.max(0, senderSearchResults.length - 1)));
  }, [senderSearchResults.length]);

  useEffect(() => {
    if (!senderSearchOpen) return;
    const activeResult = senderResultsRef.current?.querySelector<HTMLElement>(
      `#gallerySenderResult-${senderResultRow}-${senderResultAction}`,
    );
    activeResult?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [senderResultAction, senderResultRow, senderSearchOpen]);

  useLayoutEffect(() => {
    updateSenderFilterScrollIndicators();
    const scroller = senderFilterScrollRef.current;
    if (!scroller) return;
    const observer = new ResizeObserver(updateSenderFilterScrollIndicators);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [selectedSenderFilters, updateSenderFilterScrollIndicators]);
  const compactCardTab = activeTab === 'links' || activeTab === 'files' || activeTab === 'audio';
  const groups = useMemo(() => groupByMonth(filteredItems), [filteredItems]);
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
    if (attachmentBookmarkingEnabled || filters.bookmarkFilter === 'all') return;
    filters.setBookmarkFilter('all');
  }, [attachmentBookmarkingEnabled, filters]);

  useEffect(() => {
    if (previousChatDataRef.current === chatData) return;
    previousChatDataRef.current = chatData;
    filters.clearAllFilters();
    setFilterExpanded(false);
    setSenderSearch('');
    setSenderSearchOpen(false);
    setSenderResultRow(0);
    setSenderResultAction('default');
    setBulkSelectionConfirmationAction(null);
    setViewerState({ open: false, index: 0 });
    scrollPositions.current = {};
    const container = scrollContainerRef.current;
    if (container) container.scrollTop = 0;
    setScrollTop(0);
  }, [chatData, filters]);

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
    const previous = filterSnapshotRef.current;
    if (previous.includeSenders === filters.includeSenders
      && previous.excludeSenders === filters.excludeSenders
      && previous.bookmarkFilter === effectiveBookmarkFilter) return;
    filterSnapshotRef.current = {
      includeSenders: filters.includeSenders,
      excludeSenders: filters.excludeSenders,
      bookmarkFilter: effectiveBookmarkFilter,
    };
    scrollPositions.current = {};
    const container = scrollContainerRef.current;
    if (container) container.scrollTop = 0;
    setScrollTop(0);
    clearJumpHighlight();
  }, [
    clearJumpHighlight,
    effectiveBookmarkFilter,
    filters.excludeSenders,
    filters.includeSenders,
  ]);

  useLayoutEffect(() => {
    if (!attachmentJumpTarget || activeTab !== attachmentJumpTarget.tab || !hasActiveFilters) return;
    if (shouldClearFiltersForGalleryJump(
      currentItems,
      filteredItems,
      attachmentJumpTarget,
      hasActiveFilters,
    )) filters.clearAllFilters();
  }, [
    activeTab,
    attachmentJumpTarget,
    currentItems,
    filteredItems,
    filters,
    hasActiveFilters,
  ]);

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

  useEffect(() => {
    if (!isOpen || !filterExpanded || viewerState.open || bulkSelectionConfirmationAction || shortcutsOpen) return;

    const focusSenderSearch = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('button, a, input, select, textarea, [contenteditable="true"]')) return;
      event.preventDefault();
      senderSearchInputRef.current?.focus();
    };

    document.addEventListener('keydown', focusSenderSearch);
    return () => document.removeEventListener('keydown', focusSenderSearch);
  }, [bulkSelectionConfirmationAction, filterExpanded, isOpen, shortcutsOpen, viewerState.open]);

  const openViewer = useCallback((attachment: ResolvedAttachment) => {
    const index = filteredItems.indexOf(attachment);
    setViewerState({ open: true, index: index >= 0 ? index : 0 });
  }, [filteredItems]);

  const openLinkViewer = useCallback((link: ResolvedLink) => {
    const index = filteredItems.indexOf(link);
    setViewerState({ open: true, index: index >= 0 ? index : 0 });
  }, [filteredItems]);

  const openFileInNewTab = useCallback((attachment: ResolvedAttachment) => {
    const entry = attachment.mediaEntry || findMediaFile(mediaState, attachment.mediaPath);
    openMediaEntryInNewTab(entry);
  }, [mediaState]);

  const toggleAttachment = useCallback((attachment: ResolvedAttachment) => {
    selection.toggle(attachment);
  }, [selection]);

  const applySenderFilter = useCallback((sender: string, mode: 'include' | 'exclude') => {
    filters.setSenderFilter(sender, mode);
    setSenderSearch('');
    setSenderSearchOpen(true);
    setSenderResultRow(0);
    setSenderResultAction('default');
  }, [filters]);

  const handleClearFilters = useCallback(() => {
    filters.clearAllFilters();
    setSenderSearch('');
  }, [filters]);

  const closeBulkSelectionConfirmation = useCallback(() => {
    setBulkSelectionConfirmationAction(null);
  }, []);

  const confirmBulkSelection = useCallback(() => {
    if (bulkSelectionConfirmationAction === 'deselect') selection.deselectMany(filteredItems);
    else selection.selectMany(filteredItems);
    setBulkSelectionConfirmationAction(null);
  }, [bulkSelectionConfirmationAction, filteredItems, selection]);

  const handleAddAllToSelection = useCallback(() => {
    if (filteredItems.length === 0) return;
    if (shouldConfirmBulkSelection(filteredItems.length)) {
      setBulkSelectionConfirmationAction('select');
      return;
    }
    selection.selectMany(filteredItems);
  }, [filteredItems, selection]);

  const allFilteredItemsSelected = filteredItems.length > 0
    && filteredItems.every(item => selection.isSelected(item));

  const handleToggleAllSelection = useCallback(() => {
    if (allFilteredItemsSelected) {
      if (shouldConfirmBulkSelection(filteredItems.length)) {
        setBulkSelectionConfirmationAction('deselect');
        return;
      }
      selection.deselectMany(filteredItems);
      return;
    }
    handleAddAllToSelection();
  }, [allFilteredItemsSelected, filteredItems, handleAddAllToSelection, selection]);

  const handleViewerJump = useCallback((messageIndex: number) => {
    saveScrollPosition();
    isOpenRef.current = false;
    setViewerState({ open: false, index: 0 });
    onJumpToMessage(messageIndex);
    onClose();
  }, [onJumpToMessage, onClose, saveScrollPosition]);

  const handleViewerAttachmentJump = useCallback((targetItem: SelectableItem) => {
    const tab = getAttachmentJumpTab(activeTab, targetItem.category);
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

        {selectionMode && (
          <button
            type="button"
            className="gallery-add-all"
            onClick={handleToggleAllSelection}
            disabled={filteredItems.length === 0}
            title={allFilteredItemsSelected
              ? `Unselect all ${filteredItems.length.toLocaleString()} matching items`
              : `Select all ${filteredItems.length.toLocaleString()} matching items`}
          >
            {allFilteredItemsSelected ? <ListMinus size={17} /> : <ListPlus size={17} />}
            <span>{allFilteredItemsSelected ? 'Unselect all' : 'Select all'}</span>
          </button>
        )}
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
          type="button"
          className={`gallery-filter-toggle ${filterExpanded ? 'active' : ''}`}
          onClick={() => setFilterExpanded(expanded => !expanded)}
          aria-label="Toggle attachment filters"
          aria-expanded={filterExpanded}
          title="Filter attachments"
        >
          <Filter size={18} />
          {hasActiveFilters && !filterExpanded && <span className="gallery-filter-badge" />}
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
            {tabCounts[tab.key] > 0 && (
              <span className="gallery-tab-count">{tabCounts[tab.key].toLocaleString()}</span>
            )}
          </button>
        ))}
      </div>

      <div
        className={`gallery-filter-panel ${filterExpanded ? 'expanded' : ''}`}
        aria-hidden={!filterExpanded}
        inert={!filterExpanded}
      >
        <div className="gallery-filter-row">
          <div className="gallery-sender-search">
            <Search size={13} aria-hidden="true" />
            <input
              ref={senderSearchInputRef}
              type="search"
              value={senderSearch}
              onChange={event => {
                setSenderSearch(event.target.value);
                setSenderSearchOpen(true);
                setSenderResultRow(0);
                setSenderResultAction('default');
              }}
              onFocus={() => {
                setSenderSearchOpen(true);
                setSenderResultRow(0);
                setSenderResultAction('default');
              }}
              onBlur={() => setSenderSearchOpen(false)}
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  setSenderSearchOpen(false);
                  event.currentTarget.blur();
                } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && senderSearchResults.length > 0) {
                  event.preventDefault();
                  setSenderSearchOpen(true);
                  setSenderResultRow(row => event.key === 'ArrowDown'
                    ? Math.min(senderSearchResults.length - 1, row + 1)
                    : Math.max(0, row - 1));
                } else if (event.key === 'ArrowRight'
                  && senderResultAction === 'opposite'
                  && selectedSenderFilters[0]) {
                  event.preventDefault();
                  setSenderSearchOpen(false);
                  senderTagRefs.current.get(selectedSenderFilters[0].key)?.focus();
                } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && senderSearchResults.length > 0) {
                  event.preventDefault();
                  setSenderSearchOpen(true);
                  setSenderResultAction(event.key === 'ArrowRight' ? 'opposite' : 'default');
                } else if (event.key === 'Enter' && senderSearchResults[senderResultRow]) {
                  event.preventDefault();
                  const mode = senderResultAction === 'default'
                    ? senderSearchMode
                    : senderSearchMode === 'include' ? 'exclude' : 'include';
                  applySenderFilter(senderSearchResults[senderResultRow].key, mode);
                  event.currentTarget.blur();
                }
              }}
              placeholder="Sender (. current tab, + / - action)"
              aria-label="Search senders. Prefix with dot for senders with items in the current tab, then plus to include or minus to exclude."
              aria-expanded={senderSearchOpen}
              aria-controls="gallerySenderResults"
              aria-activedescendant={senderSearchOpen && senderSearchResults.length > 0
                ? `gallerySenderResult-${senderResultRow}-${senderResultAction}`
                : undefined}
              aria-autocomplete="list"
              role="combobox"
              autoComplete="off"
            />
            {senderSearchOpen && (
              <div
                ref={senderResultsRef}
                className="gallery-sender-results"
                id="gallerySenderResults"
                role="listbox"
                onMouseDown={event => event.preventDefault()}
              >
                {senderSearchResults.map((sender, index) => (
                  <div className={`gallery-sender-result ${sender.hasCurrentTabItems ? '' : 'unavailable'}`} key={sender.key}>
                    <button
                      type="button"
                      id={`gallerySenderResult-${index}-default`}
                      role="option"
                      aria-selected={senderResultRow === index && senderResultAction === 'default'}
                      className={`gallery-sender-result-name ${senderSearchMode} ${sender.hasCurrentTabItems ? '' : 'unavailable'} ${senderResultRow === index && senderResultAction === 'default' ? 'keyboard-active' : ''}`}
                      onClick={() => applySenderFilter(sender.key, senderSearchMode)}
                      onMouseEnter={() => {
                        setSenderResultRow(index);
                        setSenderResultAction('default');
                      }}
                      title={`${senderSearchMode === 'include' ? 'Include' : 'Exclude'} ${sender.label}`}
                    >
                      {senderSearchMode === 'include' ? <Plus size={13} /> : <Minus size={13} />}
                      <span>{sender.label}</span>
                    </button>
                    <button
                      type="button"
                      id={`gallerySenderResult-${index}-opposite`}
                      role="option"
                      aria-selected={senderResultRow === index && senderResultAction === 'opposite'}
                      className={`gallery-sender-result-action ${senderSearchMode === 'include' ? 'exclude' : 'include'} ${sender.hasCurrentTabItems ? '' : 'unavailable'} ${senderResultRow === index && senderResultAction === 'opposite' ? 'keyboard-active' : ''}`}
                      onClick={() => applySenderFilter(
                        sender.key,
                        senderSearchMode === 'include' ? 'exclude' : 'include',
                      )}
                      onMouseEnter={() => {
                        setSenderResultRow(index);
                        setSenderResultAction('opposite');
                      }}
                      aria-label={`${senderSearchMode === 'include' ? 'Exclude' : 'Include'} ${sender.label}`}
                      title={`${senderSearchMode === 'include' ? 'Exclude' : 'Include'} sender`}
                    >
                      {senderSearchMode === 'include' ? <Minus size={13} /> : <Plus size={13} />}
                    </button>
                  </div>
                ))}
                {senderSearchResults.length === 0 && (
                  <span className="gallery-sender-results-empty">No matching senders</span>
                )}
              </div>
            )}
          </div>

          <button
            type="button"
            className="gallery-filter-help"
            onClick={() => setShortcutsOpen(true)}
            aria-label="Show keyboard shortcuts"
            title="Keyboard shortcuts"
          >
            <CircleHelp size={15} />
          </button>

          <div className="gallery-filter-selected-viewport" ref={senderFilterViewportRef}>
            <span className="gallery-filter-scroll-track top" aria-hidden="true">
              <span className="gallery-filter-scroll-thumb" />
            </span>
            <div
              className="gallery-filter-selected"
              ref={senderFilterScrollRef}
              onScroll={updateSenderFilterScrollIndicators}
              aria-label="Active sender filters"
            >
              {selectedSenderFilters.map((sender, index) => {
              const state = filters.includeSenders.has(sender.key) ? 'included' : 'excluded';
              const removeAndContinue = () => {
                const nextSender = selectedSenderFilters[index + 1] || selectedSenderFilters[index - 1];
                filters.removeSenderFilter(sender.key);
                requestAnimationFrame(() => {
                  if (nextSender) senderTagRefs.current.get(nextSender.key)?.focus();
                });
              };
                return (
                  <button
                  type="button"
                  key={sender.key}
                  ref={element => {
                    if (element) senderTagRefs.current.set(sender.key, element);
                    else senderTagRefs.current.delete(sender.key);
                  }}
                  className={`gallery-filter-chip ${state} ${sender.hasCurrentTabItems ? '' : 'unavailable'}`}
                  onClick={removeAndContinue}
                  onKeyDown={event => {
                    if (event.key === 'ArrowRight' && selectedSenderFilters[index + 1]) {
                      event.preventDefault();
                      senderTagRefs.current.get(selectedSenderFilters[index + 1].key)?.focus();
                    } else if (event.key === 'ArrowLeft') {
                      event.preventDefault();
                      const previousSender = selectedSenderFilters[index - 1];
                      if (previousSender) senderTagRefs.current.get(previousSender.key)?.focus();
                      else senderSearchInputRef.current?.focus();
                    } else if (event.key === 'Enter' || event.key === 'Backspace') {
                      event.preventDefault();
                      removeAndContinue();
                    }
                  }}
                  aria-label={`Remove ${state} sender filter for ${sender.label}`}
                  title="Remove sender filter"
                >
                  <span>{sender.label}</span>
                  <X size={11} aria-hidden="true" />
                  </button>
                );
              })}
            </div>
            <span className="gallery-filter-scroll-track bottom" aria-hidden="true">
              <span className="gallery-filter-scroll-thumb" />
            </span>
          </div>

          <span
            className="gallery-filter-count"
            aria-label={`${filteredItems.length.toLocaleString()} of ${currentItems.length.toLocaleString()} items shown`}
            title="Matching items / total items"
          >
            {filteredItems.length.toLocaleString()} / {currentItems.length.toLocaleString()}
          </span>

          {attachmentBookmarkingEnabled && (
            <button
              type="button"
              className={`gallery-bookmark-filter ${effectiveBookmarkFilter}`}
              onClick={() => filters.setBookmarkFilter(
                effectiveBookmarkFilter === 'all'
                  ? 'bookmarked'
                  : effectiveBookmarkFilter === 'bookmarked' ? 'not-bookmarked' : 'all'
              )}
              title="Cycle bookmark filter"
              aria-label={`Bookmark filter: ${effectiveBookmarkFilter}`}
            >
              <Bookmark size={14} fill={effectiveBookmarkFilter === 'bookmarked' ? 'currentColor' : 'none'} />
              <span>{effectiveBookmarkFilter === 'all'
                ? 'All bookmarks'
                : effectiveBookmarkFilter === 'bookmarked' ? 'Bookmarked' : 'Not bookmarked'}</span>
            </button>
          )}

          <button
            type="button"
            className="gallery-filter-clear"
            onClick={handleClearFilters}
            aria-label="Clear all attachment filters"
            title="Clear filters"
            disabled={!hasActiveFilters}
          >
            <X size={15} />
          </button>
        </div>
      </div>

      <div id="line" />

      <div
        className={`gallery-scroll ${selectionMode ? 'selection-mode-active' : ''}`}
        ref={scrollContainerRef}
        onScroll={handleScroll}
      >
        {groups.length === 0 ? (
          hasActiveFilters ? (
            <div className="gallery-empty gallery-empty-filtered">
              <span>No matching attachments</span>
              <button type="button" className="btn btn-secondary" onClick={handleClearFilters}>
                Clear filters
              </button>
            </div>
          ) : (
            <div className="gallery-empty">No {activeTab === 'links' ? 'links' : 'attachments'} found</div>
          )
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
          items={filteredItems}
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

      {bulkSelectionConfirmationAction && (
        <BulkSelectionConfirmModal
          count={filteredItems.length}
          action={bulkSelectionConfirmationAction}
          onConfirm={confirmBulkSelection}
          onCancel={closeBulkSelectionConfirmation}
        />
      )}

      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
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
