import { forwardRef, memo, useImperativeHandle, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MessengerThread, MediaState, ResolvedAttachment, ResolvedLink, SelectableItem } from '../../types/messenger';
import { CheckSquare, CircleHelp, Info, Bookmark, Filter, ListMinus, ListPlus, Minus, Plus, Search, X } from 'lucide-react';
import { ParentBackButton } from '../Navigation/ParentBackButton';
import type { Settings } from '../../hooks/useSettings';
import { useAttachments, useSharedLinks, type GalleryCategory } from '../../hooks/useAttachments';
import { useAttachmentReferencesIndexing } from '../../hooks/useAttachmentReferences';
import { shouldConfirmBulkSelection, type useSelection } from '../../hooks/useSelection';
import { findMediaFile } from '../../services/media';
import { countUniqueSelectableItems, normalizeAttachmentPath } from '../../services/attachmentIdentity';
import { AnimatedProgressLabel } from '../AnimatedProgressLabel';
import { openMediaEntryInNewTab } from '../../services/blobCache';
import { getNavigationItemKey, type GallerySnapshot, type PreviewRequest } from '../../services/mobileNavigation';
import { calculateGalleryLayout, getStickyMonth, type GalleryGroup, type GalleryItem, type GalleryLayoutRow } from './galleryLayout';
import { applyGalleryFilters, getGallerySenderOptions, getGallerySenderSearchResults, parseGallerySenderSearch, shouldClearFiltersForGalleryJump, useGalleryFilters, type GalleryBookmarkFilter } from '../../hooks/useGalleryFilters';
import { BulkSelectionConfirmModal } from '../Modals/BulkSelectionConfirmModal';
import { ShortcutsModal } from '../Modals/ShortcutsModal';
import { useThreadData } from '../../hooks/useThreadData';
import { GalleryThumbnail, GalleryLinkCard } from './GalleryCards';

const VIRTUAL_OVERSCAN_PX = 600;
const COMPACT_CARD_MIN_WIDTH = 220;
const COMPACT_CARD_HEIGHT = 128;
const MOBILE_FOUR_COLUMN_MIN_WIDTH = 340;
const JUMP_HIGHLIGHT_DURATION_MS = 2200;
const NO_BOOKMARK_LOOKUP = () => false;

interface AttachmentGalleryProps {
  mobile?: boolean;
  viewerOpen?: boolean;
  onOpenViewer?: (request: PreviewRequest) => void;
  onOpenSelection?: () => void;
  chatData?: MessengerThread;
  mediaState: MediaState;
  settings: Settings;
  isOpen: boolean;
  infoPanelOpen: boolean;
  onClose: () => void;
  onJumpToMessage: (messageIndex: number, item?: SelectableItem) => void;
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
export interface AttachmentGalleryHandle {
  cancelRestore: () => void;
  captureSnapshot: () => GallerySnapshot;
  restoreSnapshot: (snapshot: GallerySnapshot) => void;
}

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

const monthYearFormatter = new Intl.DateTimeFormat([], { month: 'long', year: 'numeric' });
function formatMonthYear(ts: number): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? 'Unknown Date' : monthYearFormatter.format(date);
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
    : `${item.category}:${item.messageIndex}:${normalizeAttachmentPath(item.mediaPath)}`;
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

const AttachmentGalleryBase = forwardRef<AttachmentGalleryHandle, AttachmentGalleryProps>(function AttachmentGallery({
  chatData: providedThread,
  mediaState,
  settings: _settings,
  mobile = false,
  viewerOpen = false,
  onOpenViewer,
  onOpenSelection,
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
  onToggleAttachmentBookmark: _onToggleAttachmentBookmark,
  bookmarkBusy: _bookmarkBusy,
}: AttachmentGalleryProps, ref) {
  // ChatView mounts the gallery only when a loaded thread exists.
  const chatData = useThreadData(providedThread)!;
  const indexingReferences = useAttachmentReferencesIndexing();
  const { all, byCategory } = useAttachments(chatData, mediaState, { includeRepeated: true });
  const links = useSharedLinks(chatData);
  const allItems = useMemo<GalleryItem[]>(
    () => [...all, ...links].sort((left, right) => left.messageIndex - right.messageIndex),
    [all, links],
  );
  const [activeTab, setActiveTab] = useState<GalleryCategory>(defaultTab);
  const [selectionMode, setSelectionMode] = useState(false);
  const pendingRestore = useRef<GallerySnapshot | null>(null);
  const jumpOriginRef = useRef<string | undefined>(undefined);
  const [restoreVersion, setRestoreVersion] = useState(0);
  const [filterExpanded, setFilterExpanded] = useState(false);
  const [senderSearch, setSenderSearch] = useState('');
  const [senderSearchOpen, setSenderSearchOpen] = useState(false);
  const [senderResultRow, setSenderResultRow] = useState(-1);
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
    || effectiveBookmarkFilter !== 'all'
    || !!filters.searchQuery;
  const filterSnapshotRef = useRef({
    includeSenders: filters.includeSenders,
    excludeSenders: filters.excludeSenders,
    bookmarkFilter: effectiveBookmarkFilter,
    searchQuery: filters.searchQuery,
  });
  const filteredItems = useMemo(
    () => applyGalleryFilters(currentItems, {
      includeSenders: filters.includeSenders,
      excludeSenders: filters.excludeSenders,
      bookmarkFilter: effectiveBookmarkFilter,
      searchQuery: filters.searchQuery,
    }, bookmarkFilterLookup),
    [
      bookmarkFilterLookup,
      currentItems,
      effectiveBookmarkFilter,
      filters.excludeSenders,
      filters.includeSenders,
      filters.searchQuery,
    ],
  );
  const filteredItemCount = useMemo(() => countUniqueSelectableItems(filteredItems), [filteredItems]);
  const currentItemCount = useMemo(() => countUniqueSelectableItems(currentItems), [currentItems]);
  const availableSenders = useMemo(() => {
    return getGallerySenderOptions(
      chatData.participants.map(participant => participant.name),
      allItems,
      currentItems,
    );
  }, [allItems, chatData.participants, currentItems]);
  const { mode: senderSearchMode, currentTabOnly: searchCurrentTabSendersOnly } = parseGallerySenderSearch(senderSearch);
  const hasSenderSearchOperator = /[.+-]/.test(senderSearch);
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
    setSenderResultRow(row => row < 0 ? -1 : Math.min(row, senderSearchResults.length - 1));
  }, [senderSearchResults.length]);

  useEffect(() => {
    if (!senderSearchOpen || senderResultRow < 0) return;
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
  const mediaColumns = mobile && !compactCardTab
    ? (viewport.width >= MOBILE_FOUR_COLUMN_MIN_WIDTH ? 4 : 3)
    : undefined;
  const groups = useMemo(() => groupByMonth(filteredItems), [filteredItems]);
  const layout = useMemo(
    () => calculateGalleryLayout(
      groups,
      viewport.width,
      compactCardTab ? COMPACT_CARD_MIN_WIDTH : undefined,
      undefined,
      compactCardTab ? COMPACT_CARD_HEIGHT : undefined,
      mediaColumns,
    ),
    [compactCardTab, groups, mediaColumns, viewport.width],
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
    setSenderResultRow(-1);
    setSenderResultAction('default');
    setBulkSelectionConfirmationAction(null);
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
      && previous.bookmarkFilter === effectiveBookmarkFilter
      && previous.searchQuery === filters.searchQuery) return;
    filterSnapshotRef.current = {
      includeSenders: filters.includeSenders,
      excludeSenders: filters.excludeSenders,
      bookmarkFilter: effectiveBookmarkFilter,
      searchQuery: filters.searchQuery,
    };
    if (pendingRestore.current) return;
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
    filters.searchQuery,
  ]);

  useLayoutEffect(() => {
    if (!attachmentJumpTarget || activeTab !== attachmentJumpTarget.tab || !hasActiveFilters) return;
    if (shouldClearFiltersForGalleryJump(
      currentItems,
      filteredItems,
      attachmentJumpTarget,
      hasActiveFilters,
    )) {
      filters.clearAllFilters();
      setSenderSearch('');
    }
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
    if (pendingRestore.current) return;
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
    if (!isOpen || viewerOpen) return;

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
  }, [activeTab, handleTabChange, isOpen, showStickers, viewerOpen]);

  useEffect(() => {
    if (!isOpen || !filterExpanded || viewerOpen || bulkSelectionConfirmationAction || shortcutsOpen) return;

    const focusSenderSearch = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('button, a, input, select, textarea, [contenteditable="true"]')) return;
      event.preventDefault();
      senderSearchInputRef.current?.focus();
    };

    document.addEventListener('keydown', focusSenderSearch);
    return () => document.removeEventListener('keydown', focusSenderSearch);
  }, [bulkSelectionConfirmationAction, filterExpanded, isOpen, shortcutsOpen, viewerOpen]);

  const openViewer = useCallback((attachment: ResolvedAttachment) => {
    const index = filteredItems.indexOf(attachment);
    onOpenViewer?.({ items: filteredItems, index: index >= 0 ? index : 0, source: 'gallery', selectionMode, reverseNavigation: true });
  }, [filteredItems, onOpenViewer, selectionMode]);

  const openLinkViewer = useCallback((link: ResolvedLink) => {
    const index = filteredItems.indexOf(link);
    onOpenViewer?.({ items: filteredItems, index: index >= 0 ? index : 0, source: 'gallery', selectionMode, reverseNavigation: true });
  }, [filteredItems, onOpenViewer, selectionMode]);

  const openFileInNewTab = useCallback((attachment: ResolvedAttachment) => {
    const entry = attachment.mediaEntry || findMediaFile(mediaState, attachment.mediaPath);
    openMediaEntryInNewTab(entry);
  }, [mediaState]);

  const toggleAttachment = useCallback((attachment: ResolvedAttachment) => {
    selection.toggle(attachment);
  }, [selection]);

  const applySenderFilter = useCallback((sender: string, mode: 'include' | 'exclude') => {
    filters.setSenderFilter(sender, mode);
    const operatorIndex = senderSearch.search(/[.+-]/);
    setSenderSearch(operatorIndex >= 0 ? senderSearch.slice(0, operatorIndex).trimEnd() : '');
    setSenderSearchOpen(false);
    setSenderResultRow(-1);
    setSenderResultAction('default');
  }, [filters, senderSearch]);

  const applySenderFilterFromMouse = useCallback((sender: string, mode: 'include' | 'exclude') => {
    applySenderFilter(sender, mode);
    setSenderSearchOpen(false);
    senderSearchInputRef.current?.blur();
  }, [applySenderFilter]);

  const handleClearFilters = useCallback(() => {
    filters.clearAllFilters();
    setSenderSearch('');
    setSenderSearchOpen(false);
    setSenderResultRow(-1);
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
    if (shouldConfirmBulkSelection(filteredItemCount)) {
      setBulkSelectionConfirmationAction('select');
      return;
    }
    selection.selectMany(filteredItems);
  }, [filteredItems, filteredItemCount, selection]);

  const allFilteredItemsSelected = filteredItems.length > 0
    && filteredItems.every(item => selection.isSelected(item));

  const handleToggleAllSelection = useCallback(() => {
    if (allFilteredItemsSelected) {
      if (shouldConfirmBulkSelection(filteredItemCount)) {
        setBulkSelectionConfirmationAction('deselect');
        return;
      }
      selection.deselectMany(filteredItems);
      return;
    }
    handleAddAllToSelection();
  }, [allFilteredItemsSelected, filteredItems, filteredItemCount, handleAddAllToSelection, selection]);

  const handleViewerJump = useCallback((messageIndex: number, item?: SelectableItem) => {
    jumpOriginRef.current = item ? getNavigationItemKey(item) : undefined;
    onJumpToMessage(messageIndex);
  }, [onJumpToMessage]);

  useImperativeHandle(ref, () => ({
    cancelRestore: () => {
      pendingRestore.current = null;
      if (restoreFrameRef.current !== null) cancelAnimationFrame(restoreFrameRef.current);
      restoreFrameRef.current = null;
      restoringScrollRef.current = false;
    },
    captureSnapshot: () => {
      const container = scrollContainerRef.current;
      const top = container?.scrollTop ?? scrollTop;
      const row = layout.rows.find(row => row.type === 'items' && row.top + row.height > top);
      return {
        tab: activeTab,
        highlightedKey: jumpOriginRef.current,
        positions: { ...scrollPositions.current, [activeTab]: top },
        anchor: row?.type === 'items' ? { key: getNavigationItemKey(row.items[0]), offset: row.top - top } : undefined,
        filters: { include: [...filters.includeSenders], exclude: [...filters.excludeSenders],
          bookmark: filters.bookmarkFilter, query: filters.searchQuery },
        expanded: filterExpanded, senderSearch,
      };
    },
    restoreSnapshot: snapshot => {
      pendingRestore.current = snapshot;
      scrollPositions.current = { ...snapshot.positions };
      setActiveTab(snapshot.tab);
      filters.restoreFilters({ includeSenders: new Set(snapshot.filters.include), excludeSenders: new Set(snapshot.filters.exclude),
        bookmarkFilter: snapshot.filters.bookmark, searchQuery: snapshot.filters.query });
      setFilterExpanded(snapshot.expanded);
      setSenderSearch(snapshot.senderSearch);
      setRestoreVersion(version => version + 1);
    },
  }), [activeTab, filterExpanded, filters, layout.rows, scrollTop, senderSearch]);

  useLayoutEffect(() => {
    const snapshot = pendingRestore.current;
    const container = scrollContainerRef.current;
    if (!snapshot || !container || viewport.width <= 0 || activeTab !== snapshot.tab) return;
    if (filters.searchQuery !== snapshot.filters.query || filters.includeSenders.size !== snapshot.filters.include.length
      || filters.excludeSenders.size !== snapshot.filters.exclude.length || filters.bookmarkFilter !== snapshot.filters.bookmark) return;
    const row = snapshot.anchor ? layout.rows.find(row => row.type === 'items'
      && row.items.some(item => getNavigationItemKey(item) === snapshot.anchor!.key)) : undefined;
    const top = row && snapshot.anchor ? Math.max(0, row.top - snapshot.anchor.offset) : snapshot.positions[snapshot.tab] ?? 0;
    restoringScrollRef.current = true;
    container.scrollTop = top;
    scrollPositions.current[snapshot.tab] = top;
    setScrollTop(top);
    pendingRestore.current = null;
    const highlighted = snapshot.highlightedKey ? filteredItems.find(item => getNavigationItemKey(item) === snapshot.highlightedKey) : undefined;
    if (highlighted) highlightAttachment(highlighted);
    restoreFrameRef.current = requestAnimationFrame(() => {
      restoreFrameRef.current = null;
      restoringScrollRef.current = false;
    });
  }, [activeTab, filters, filteredItems, highlightAttachment, layout.rows, restoreVersion, viewport.width]);

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
    all: countUniqueSelectableItems(allItems),
    photos: countUniqueSelectableItems(byCategory.photos),
    videos: countUniqueSelectableItems(byCategory.videos),
    audio: countUniqueSelectableItems(byCategory.audio),
    gifs: countUniqueSelectableItems(byCategory.gifs),
    files: countUniqueSelectableItems(byCategory.files),
    links: links.length,
    stickers: countUniqueSelectableItems(byCategory.stickers),
  }), [allItems, byCategory, links]);

  const visibleTabs = showStickers ? TABS : TABS.filter(tab => tab.key !== 'stickers');
  const selectAllControl = selectionMode && <button type="button" className="gallery-add-all"
    onClick={handleToggleAllSelection} disabled={filteredItems.length === 0}
    title={allFilteredItemsSelected ? `Unselect all ${filteredItemCount.toLocaleString()} matching items` : `Select all ${filteredItemCount.toLocaleString()} matching items`}>
    {allFilteredItemsSelected ? <ListMinus size={17} /> : <ListPlus size={17} />}
    <span>{allFilteredItemsSelected ? 'Unselect all' : 'Select all'}</span>
  </button>;

  return (
    <>
      <div className="chat-header gallery-header">
        <ParentBackButton className="gallery-back-btn" destination={mobile ? 'info' : 'chat'} ariaLabel={mobile ? 'Back to chat info' : 'Back to chat'} onClick={handleClose} />
        <h3>Attachments</h3>
        {indexingReferences && <span className="gallery-reference-status" role="status"><AnimatedProgressLabel>Scanning for shared attachments</AnimatedProgressLabel></span>}

        {!mobile && selectAllControl}
        <div className="gallery-header-actions">
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
          aria-label={mobile ? 'Open chat info' : 'Toggle chat info panel'}
          aria-expanded={infoPanelOpen}
          onClick={onToggleInfoPanel}
          title="Chat info"
        >
          <Info size={18} />
        </button>
        </div>
      </div>

      {mobile && (selectionMode || selection.selectedCount > 0) && <div className="mobile-selection-toolbar">
        {selectAllControl}
        {selection.selectedCount > 0 && <div className="mobile-selection-review">
          <span className="mobile-selection-count" aria-live="polite">{selection.selectedCount.toLocaleString()} selected</span>
          <button type="button" className="mobile-selected-btn" onClick={onOpenSelection}>Review selection</button>
        </div>}
      </div>}
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
          <div className={`gallery-sender-search ${senderResultRow >= 0 ? 'result-active' : ''}`}>
            <Search size={13} aria-hidden="true" />
            <input
              ref={senderSearchInputRef}
              type="search"
              value={senderSearch}
              onChange={event => {
                const nextSearch = event.target.value;
                const keepDropdownOpen = senderSearchOpen;
                setSenderSearch(nextSearch);
                setSenderSearchOpen(/[.+-]/.test(nextSearch) || keepDropdownOpen);
                if (!keepDropdownOpen) {
                  setSenderResultRow(-1);
                  setSenderResultAction('default');
                }
              }}
              onFocus={() => {
                setSenderSearchOpen(hasSenderSearchOperator);
                setSenderResultRow(-1);
                setSenderResultAction('default');
              }}
              onBlur={() => setSenderSearchOpen(false)}
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  setSenderSearchOpen(false);
                  event.currentTarget.blur();
                } else if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setSenderSearchOpen(true);
                  if (senderSearchResults.length > 0) {
                    setSenderResultRow(row => Math.min(senderSearchResults.length - 1, row + 1));
                  }
                } else if (event.key === 'ArrowUp'
                  && senderSearchOpen
                  && senderResultRow >= 0) {
                  event.preventDefault();
                  if (senderResultRow === 0) {
                    setSenderResultRow(-1);
                    setSenderResultAction('default');
                    if (!hasSenderSearchOperator) setSenderSearchOpen(false);
                  } else {
                    setSenderResultRow(row => row - 1);
                  }
                } else if (event.key === 'ArrowUp'
                  && senderSearchOpen
                  && senderResultRow < 0
                  && !hasSenderSearchOperator) {
                  event.preventDefault();
                  setSenderSearchOpen(false);
                  setSenderResultAction('default');
                } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight')
                  && senderSearchOpen
                  && senderResultRow >= 0) {
                  event.preventDefault();
                  if (event.key === 'ArrowRight'
                    && senderResultAction === 'opposite'
                    && selectedSenderFilters[0]) {
                    setSenderSearchOpen(false);
                    setSenderResultRow(-1);
                    senderTagRefs.current.get(selectedSenderFilters[0].key)?.focus();
                  } else {
                    setSenderResultAction(event.key === 'ArrowRight' ? 'opposite' : 'default');
                  }
                } else if (event.key === 'ArrowRight'
                  && event.currentTarget.selectionStart === event.currentTarget.value.length
                  && event.currentTarget.selectionEnd === event.currentTarget.value.length
                  && selectedSenderFilters[0]) {
                  event.preventDefault();
                  setSenderSearchOpen(false);
                  senderTagRefs.current.get(selectedSenderFilters[0].key)?.focus();
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  const selectedSender = senderSearchOpen && senderResultRow >= 0
                    ? senderSearchResults[senderResultRow]
                    : undefined;
                  if (selectedSender) {
                    const mode = senderResultAction === 'default'
                      ? senderSearchMode
                      : senderSearchMode === 'include' ? 'exclude' : 'include';
                    applySenderFilter(selectedSender.key, mode);
                  } else {
                    filters.setSearchQuery(senderSearch);
                    setSenderSearchOpen(false);
                    setSenderResultRow(-1);
                  }
                  event.currentTarget.blur();
                }
              }}
              placeholder="Search links or filenames"
              aria-label="Search links or filenames. Type plus, minus, or dot to open sender suggestions."
              aria-expanded={senderSearchOpen}
              aria-controls="gallerySenderResults"
              aria-activedescendant={senderSearchOpen && senderResultRow >= 0
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
                      onClick={() => applySenderFilterFromMouse(sender.key, senderSearchMode)}
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
                      onClick={() => applySenderFilterFromMouse(
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
            aria-label={`${filteredItemCount.toLocaleString()} of ${currentItemCount.toLocaleString()} items shown`}
            title="Matching unique items / total unique items"
          >
            {filteredItemCount.toLocaleString()} / {currentItemCount.toLocaleString()}
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
                      mobile={mobile}
                      squareCard={activeTab === 'all'}
                      key={`link:${item.messageIndex}:${item.url}`}
                      link={item}
                      onJumpToMessage={handleViewerJump}
                      onOpen={openLinkViewer}
                      onSelect={selection.toggle}
                      selectionMode={selectionMode}
                      isSelected={selection.isSelected(item)}
                      isBookmarked={attachmentBookmarkingEnabled && isAttachmentBookmarked(item)}
                      isJumpHighlighted={jumpHighlightedKey === getGalleryItemKey(item)}
                      openViewerOnCard={mobile || activeTab === 'all'}
                    />
                  ) : (
                    <GalleryThumbnail
                      mobile={mobile}
                      key={getGalleryItemKey(item)}
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

      {bulkSelectionConfirmationAction && (
        <BulkSelectionConfirmModal
          count={filteredItemCount}
          action={bulkSelectionConfirmationAction}
          onConfirm={confirmBulkSelection}
          onCancel={closeBulkSelectionConfirmation}
        />
      )}

      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
    </>
  );
});

export const AttachmentGallery = memo(AttachmentGalleryBase);
