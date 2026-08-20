import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo, memo } from 'react';
import type { MessengerThread, MediaState, ResolvedAttachment } from '../../types/messenger';
import { ArrowLeft, CheckSquare, Image as ImageIcon, Film, Music, FileText, Play, Check, Info } from 'lucide-react';
import type { Settings } from '../../hooks/useSettings';
import { useAttachments, type AttachmentCategory } from '../../hooks/useAttachments';
import type { useSelection } from '../../hooks/useSelection';
import { findMediaFile } from '../../services/media';
import { blobCache } from '../../services/blobCache';
import { MediaViewer } from '../MediaViewer/MediaViewer';

// Shared IntersectionObserver for all gallery thumbnails to avoid creating thousands of observers
let sharedObserver: IntersectionObserver | null = null;
let unloadObserver: IntersectionObserver | null = null;

const observerCallbacks = new Map<Element, { load: () => void; unload: () => void }>();
const loadingElements = new Set<Element>();

// All items currently in the viewport or preload zone
const pendingElements = new Set<Element>();
let loadTimer: ReturnType<typeof setTimeout> | null = null;

function processPending() {
  loadTimer = null;
  for (const el of pendingElements) {
    if (loadingElements.has(el)) continue;
    loadingElements.add(el);
    const cbs = observerCallbacks.get(el);
    if (cbs) cbs.load();
  }
}

function resetObservers() {
  if (sharedObserver) { sharedObserver.disconnect(); sharedObserver = null; }
  if (unloadObserver) { unloadObserver.disconnect(); unloadObserver = null; }
  pendingElements.clear();
  loadingElements.clear();
  observerCallbacks.clear();
  if (loadTimer) { clearTimeout(loadTimer); loadTimer = null; }
}

// Uses the .gallery-scroll container as root so rootMargin works relative
// to the scroll container's visible area, not the viewport.
function getSharedObserver() {
  if (!sharedObserver) {
    const root = document.querySelector('.gallery-scroll');
    sharedObserver = new IntersectionObserver((entries) => {
      let changed = false;
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.isIntersecting) {
          pendingElements.add(entry.target);
          changed = true;
        } else {
          pendingElements.delete(entry.target);
        }
      }
      if (changed) {
        if (loadTimer) clearTimeout(loadTimer);
        loadTimer = setTimeout(processPending, 150);
      }
    }, { root, rootMargin: '500px' });
  }
  return sharedObserver;
}

function getUnloadObserver() {
  if (!unloadObserver) {
    const root = document.querySelector('.gallery-scroll');
    unloadObserver = new IntersectionObserver((entries) => {
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (!entry.isIntersecting) {
          loadingElements.delete(entry.target);
          const cbs = observerCallbacks.get(entry.target);
          if (cbs) cbs.unload();
        }
      }
    }, { root, rootMargin: '2000px' });
  }
  return unloadObserver;
}

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

interface GalleryThumbnailProps {
  attachment: ResolvedAttachment;
  mediaState: MediaState;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
  selectionMode: boolean;
  isSelected: boolean;
}

const GalleryThumbnail = memo(function GalleryThumbnail({
  attachment,
  mediaState,
  onClick,
  onDoubleClick,
  isSelected,
}: GalleryThumbnailProps) {
  const [url, setUrl] = useState<string | null>(null);
  const containerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const entry = attachment.mediaEntry || findMediaFile(mediaState, attachment.mediaPath);
    if (!entry) return;

    // Non-video items with a cached blob URL: show immediately, no observer needed
    const cached = blobCache.get(entry);
    if (cached && attachment.category !== 'videos') {
      setUrl(cached);
      return;
    }
    if (!cached && entry.url && attachment.category !== 'videos') {
      blobCache.put(entry, entry.url);
      setUrl(entry.url);
      return;
    }

    // Nothing to load (no cached URL and no file handle)
    if (!entry.url && !entry.handle) return;

    let isMounted = true;
    const el = containerRef.current;
    if (!el) return;

    observerCallbacks.set(el, {
      load: () => {
        const cachedUrl = blobCache.get(entry);
        if (cachedUrl) {
          if (isMounted) setUrl(cachedUrl);
          return;
        }
        if (!entry.handle) return;
        blobCache.getOrCreate(entry).then(blobUrl => {
          if (isMounted && blobUrl) setUrl(blobUrl);
        });
      },
      unload: () => {
        if (isMounted && attachment.category === 'videos') {
          setUrl(null);
        }
      }
    });

    getSharedObserver().observe(el);
    getUnloadObserver().observe(el);

    return () => { 
      isMounted = false;
      getSharedObserver().unobserve(el);
      getUnloadObserver().unobserve(el);
      observerCallbacks.delete(el);
      pendingElements.delete(el);
      loadingElements.delete(el);
    };
  }, [attachment, mediaState]);

  const cat = attachment.category;
  const filename = attachment.mediaPath.split('/').pop() || 'File';

  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleClick = (e: React.MouseEvent) => {
    if (e.detail === 2) {
      // Double click — cancel pending single click
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      onDoubleClick(e);
    } else if (e.detail === 1) {
      // Delay single click to see if double click follows
      clickTimerRef.current = setTimeout(() => {
        clickTimerRef.current = null;
        onClick(e);
      }, 200);
    }
  };

  const wrapperClass = `gallery-thumb ${cat === 'audio' || cat === 'files' ? 'gallery-thumb-file' : ''} ${isSelected ? 'selected' : ''}`;

  return (
    <button ref={containerRef} className={wrapperClass} onClick={handleClick} title={filename}>
      <div className="select-checkbox">
        {isSelected && <Check size={14} />}
      </div>
      
      {(cat === 'photos' || cat === 'gifs') ? (
        url ? (
          <img src={url} alt={filename} className="gallery-thumb-img" loading="lazy" />
        ) : (
          <div className="gallery-thumb-placeholder"><ImageIcon size={24} /></div>
        )
      ) : cat === 'videos' ? (
        url ? (
          <>
            <video src={url} className="gallery-thumb-img" preload="metadata" muted />
            <div className="gallery-thumb-play"><Play fill="currentColor" size={24} /></div>
          </>
        ) : (
          <div className="gallery-thumb-placeholder"><Film size={24} /></div>
        )
      ) : cat === 'audio' ? (
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
    </button>
  );
}, (prev, next) => {
  return prev.attachment === next.attachment &&
         prev.mediaState === next.mediaState &&
         prev.selectionMode === next.selectionMode &&
         prev.isSelected === next.isSelected;
});

// Group attachments by month for date separators
function groupByMonth(attachments: ResolvedAttachment[]): { label: string; items: ResolvedAttachment[] }[] {
  if (attachments.length === 0) return [];

  const groups: { label: string; items: ResolvedAttachment[] }[] = [];
  let currentLabel = '';

  // Attachments are in chronological order (oldest first); display newest first
  const reversed = [...attachments].reverse();

  for (const att of reversed) {
    const label = att.timestamp ? formatMonthYear(att.timestamp) : 'Unknown Date';
    if (label !== currentLabel) {
      currentLabel = label;
      groups.push({ label, items: [] });
    }
    groups[groups.length - 1].items.push(att);
  }

  return groups;
}

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
  const { all, getFiltered } = useAttachments(chatData, mediaState);

  // Persistent tab and scroll state
  const [activeTab, setActiveTab] = useState<AttachmentCategory>(defaultTab);
  const scrollPositions = useRef<Record<string, number>>({});
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  
  const [selectionMode, setSelectionMode] = useState(false);

  useEffect(() => {
    if (defaultTab) {
      setActiveTab(defaultTab);
    }
  }, [defaultTab]);
  
  useEffect(() => {
    if (selection.selectedCount > 0) {
      setSelectionMode(true);
    } else {
      setSelectionMode(false);
    }
  }, [selection.selectedCount]);

  // Reset observers on mount/unmount.
  // useLayoutEffect ensures reset runs BEFORE children's useEffect (which sets up observers).
  useLayoutEffect(() => {
    resetObservers();
    return () => resetObservers();
  }, []);

  // Media viewer state
  const [viewerState, setViewerState] = useState<{ open: boolean; index: number }>({ open: false, index: 0 });

  const currentItems = useMemo(() => getFiltered(activeTab), [activeTab, getFiltered]);
  const groups = useMemo(() => groupByMonth(currentItems), [currentItems]);

  // Save scroll position before switching tab
  const saveScrollPosition = useCallback(() => {
    if (scrollContainerRef.current) {
      scrollPositions.current[activeTab] = scrollContainerRef.current.scrollTop;
    }
  }, [activeTab]);

  // Restore scroll position on tab switch
  useEffect(() => {
    if (scrollContainerRef.current) {
      const saved = scrollPositions.current[activeTab];
      scrollContainerRef.current.scrollTop = saved || 0;
    }
  }, [activeTab]);

  const handleTabChange = useCallback((tab: AttachmentCategory) => {
    saveScrollPosition();
    setActiveTab(tab);
  }, [saveScrollPosition]);

  const openViewer = useCallback((attachment: ResolvedAttachment) => {
    const filtered = getFiltered(activeTab);
    const idx = filtered.indexOf(attachment);
    setViewerState({ open: true, index: idx >= 0 ? idx : 0 });
  }, [activeTab, getFiltered]);

  const handleThumbnailClick = useCallback((attachment: ResolvedAttachment) => {
    if (selectionMode) {
      selection.toggle(attachment);
    } else {
      openViewer(attachment);
    }
  }, [selectionMode, selection, openViewer]);
  
  const handleThumbnailDoubleClick = useCallback((attachment: ResolvedAttachment) => {
    if (selectionMode) {
      openViewer(attachment);
    }
  }, [selectionMode, openViewer]);

  const handleViewerJump = useCallback((messageIndex: number) => {
    setViewerState({ open: false, index: 0 });
    onJumpToMessage(messageIndex);
    onClose();
  }, [onJumpToMessage, onClose]);

  // Tab counts
  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = { all: all.length };
    for (const tab of TABS) {
      if (tab.key !== 'all') {
        counts[tab.key] = getFiltered(tab.key).length;
      }
    }
    return counts;
  }, [all, getFiltered]);

  return (
    <>
      {/* Header */}
      <div className="chat-header">
        <button
          className="gallery-back-btn"
          onClick={onClose}
          aria-label="Back to chat"
          title="Back to chat"
        ><ArrowLeft size={18} /></button>
        <h3>Attachments</h3>

        <button
          className={`gallery-select-mode-toggle ${selectionMode ? 'active' : ''}`}
          onClick={() => {
            if (selectionMode && selection.selectedCount > 0) {
              selection.deselectAll();
            }
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
        ><Info size={18} /></button>
      </div>

      {/* Tabs */}
      <div className="gallery-tabs">
        {TABS.map(tab => (
          <button
            key={tab.key}
            className={`gallery-tab ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => handleTabChange(tab.key)}
          >
            {tab.label}
            {tabCounts[tab.key] > 0 && (
              <span className="gallery-tab-count">{tabCounts[tab.key]}</span>
            )}
          </button>
        ))}
      </div>

      <div id="line" />

      {/* Grid */}
      <div className={`gallery-scroll ${selectionMode ? 'selection-mode-active' : ''}`} ref={scrollContainerRef}>
        {groups.length === 0 ? (
          <div className="gallery-empty">No attachments found</div>
        ) : (
          groups.map((group, gi) => (
            <div key={gi} className="gallery-group">
              <div className="gallery-date-separator">{group.label}</div>
              <div className="gallery-grid">
                {group.items.map((att, ai) => (
                  <GalleryThumbnail
                    key={`${att.messageIndex}-${att.mediaPath}-${gi}-${ai}`}
                    attachment={att}
                    mediaState={mediaState}
                    onClick={() => handleThumbnailClick(att)}
                    onDoubleClick={() => handleThumbnailDoubleClick(att)}
                    selectionMode={selectionMode}
                    isSelected={selection.isSelected(att)}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Media Viewer */}
      {viewerState.open && (
        <MediaViewer
          attachments={getFiltered(activeTab)}
          initialIndex={viewerState.index}
          mediaState={mediaState}
          onClose={() => setViewerState({ open: false, index: viewerState.index })}
          onJumpToMessage={handleViewerJump}
          selection={selection}
        />
      )}
    </>
  );
}

export const AttachmentGallery = memo(AttachmentGalleryBase, (prev, next) => {
  return prev.chatData === next.chatData &&
         prev.mediaState === next.mediaState &&
         prev.settings === next.settings &&
         prev.infoPanelOpen === next.infoPanelOpen &&
         prev.defaultTab === next.defaultTab &&
         prev.selection === next.selection;
});
