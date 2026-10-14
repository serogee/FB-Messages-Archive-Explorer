import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { MoreVertical, ExternalLink, Download, Copy, X, ChevronLeft, ChevronRight, Check, CheckSquare, SquareX, Paperclip, Music, FileText, Bookmark, Link as LinkIcon, UserRound, Eye, EyeOff } from 'lucide-react';
import type { MediaEntry, ResolvedAttachment, SelectableItem } from '../../types/messenger';
import { findMediaFile } from '../../services/media';
import { blobCache } from '../../services/blobCache';
import type { MediaState } from '../../types/messenger';
import type { useSelection } from '../../hooks/useSelection';
import { downloadSingle, getAttachmentDownloadName } from '../../services/saveAttachments';
import { MediaFileSize } from '../MediaFileSize';
import { UnavailableAttachment } from '../UnavailableAttachment';
import { findNextNavigableIndex } from './mediaViewerNavigation';
import { useViewerSwipe } from '../../hooks/useViewerSwipe';

interface MediaViewerProps {
  mobile?: boolean;
  navigationVisible?: boolean;
  onToggleNavigation?: () => void;
  items: SelectableItem[];
  initialIndex: number;
  mediaState: MediaState;
  onClose: () => void;
  onCurrentItemChange?: (item: SelectableItem) => void;
  onJumpToMessage: (messageIndex: number) => void;
  onJumpToAttachment?: (item: SelectableItem) => void;
  selection?: ReturnType<typeof useSelection>;
  selectionMode?: boolean;
  reverseNavigation?: boolean;
  selectedNavigation?: boolean;
  useDateFilename?: boolean;
  chatTitle?: string;
  filenameTemplate?: string;
  allowLongFilenames?: boolean;
  attachmentBookmarkingEnabled?: boolean;
  isBookmarked?: (item: SelectableItem) => boolean;
  onToggleBookmark?: (item: SelectableItem) => Promise<void>;
  bookmarkBusy?: boolean;
}

type MediaUrlState = { url: string | null; status: 'loading' | 'ready' | 'missing' };

function useResolvedUrl(attachment: ResolvedAttachment | null, mediaState: MediaState): MediaUrlState {
  const entry = attachment ? attachment.mediaEntry || findMediaFile(mediaState, attachment.mediaPath) : null;
  const [state, setState] = useState<MediaUrlState & { entry: MediaEntry | null }>({ entry: null, url: null, status: 'loading' });

  useEffect(() => {
    if (!entry) { setState({ entry, url: null, status: 'missing' }); return; }

    const cached = blobCache.get(entry);
    if (cached) { setState({ entry, url: cached, status: 'ready' }); return; }
    if (entry.url) {
      blobCache.put(entry, entry.url);
      setState({ entry, url: entry.url, status: 'ready' });
      return;
    }

    if (entry.handle) {
      let cancelled = false;
      setState({ entry, url: null, status: 'loading' });
      blobCache.getOrCreate(entry).then(blobUrl => {
        if (!cancelled) {
          setState(blobUrl
            ? { entry, url: blobUrl, status: 'ready' }
            : { entry, url: null, status: 'missing' });
        }
      });
      return () => { cancelled = true; };
    }
    setState({ entry, url: null, status: 'missing' });
  }, [entry, mediaState]);

  if (!entry) return { url: null, status: 'missing' };
  // Effects run after the render; never display the previous entry's URL meanwhile.
  return state.entry === entry ? state : { url: null, status: 'loading' };
}

function prepareViewerImage(image: HTMLImageElement | null) {
  if (!image?.complete || !image.naturalWidth || !image.naturalHeight || image.dataset.imageReady) return;
  image.style.setProperty('--media-image-ratio', String(image.naturalWidth / image.naturalHeight));
  image.style.setProperty('--media-image-natural-width', `${image.naturalWidth}px`);
  // Settle the fitted width while initial transitions are disabled, then reveal it.
  // The ref also handles decoded images from the browser cache before the first paint.
  image.getBoundingClientRect();
  image.dataset.imageReady = 'true';
}

function getDisplayType(attachment: ResolvedAttachment): 'image' | 'video' | 'audio' | 'file' {
  const cat = attachment.category;
  if (cat === 'photos' || cat === 'gifs' || cat === 'stickers') return 'image';
  if (cat === 'videos') return 'video';
  if (cat === 'audio') return 'audio';
  return 'file';
}

export function MediaViewer({
  mobile = false,
  navigationVisible,
  onToggleNavigation,
  items,
  initialIndex,
  mediaState,
  onClose,
  onCurrentItemChange,
  onJumpToMessage,
  onJumpToAttachment,
  selection,
  selectionMode = false,
  reverseNavigation = false,
  selectedNavigation = false,
  useDateFilename = true,
  chatTitle = 'Chat',
  filenameTemplate,
  allowLongFilenames = false,
  attachmentBookmarkingEnabled = false,
  isBookmarked: isAttachmentBookmarked,
  onToggleBookmark,
  bookmarkBusy = false,
}: MediaViewerProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [menuOpen, setMenuOpen] = useState(false);
  const [navigationOverride, setNavigationOverride] = useState<boolean | undefined>();
  const showNavigation = navigationVisible ?? navigationOverride ?? !mobile;
  const toggleNavigation = () => {
    if (onToggleNavigation) onToggleNavigation();
    else setNavigationOverride(!showNavigation);
    setMenuOpen(false);
  };
  const [expandedImage, setExpandedImage] = useState<SelectableItem | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [filenameCopiedFor, setFilenameCopiedFor] = useState<ResolvedAttachment | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const topbarRef = useRef<HTMLDivElement>(null);
  const navigationRef = useRef<HTMLDivElement>(null);
  const imageElementRef = useRef<HTMLImageElement>(null);
  const mediaElementRef = useRef<HTMLMediaElement | null>(null);
  const currentItemRef = useRef<SelectableItem | null>(null);
  const selectionRef = useRef(selection);
  const selectionModeRef = useRef(selectionMode);
  const bookmarkToggleRef = useRef(onToggleBookmark);
  const bookmarkingEnabledRef = useRef(attachmentBookmarkingEnabled);
  const closeRef = useRef(onClose);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeViewer = useCallback(() => {
    const media = mediaElementRef.current;
    if (media) {
      media.pause();
      media.removeAttribute('src');
    }
    onClose();
  }, [onClose]);

  const item = items[currentIndex] || null;
  useEffect(() => setCurrentIndex(initialIndex), [initialIndex]);
  useEffect(() => { if (item) onCurrentItemChange?.(item); }, [item, onCurrentItemChange]);
  const attachment = item && item.category !== 'links' ? item : null;
  const filename = attachment?.mediaPath.split('/').pop() || 'Attachment';
  const filenameCopied = !!attachment && filenameCopiedFor === attachment;
  const link = item?.category === 'links' ? item : null;
  const mediaEntry = attachment
    ? attachment.mediaEntry || findMediaFile(mediaState, attachment.mediaPath)
    : null;
  const { url, status: urlStatus } = useResolvedUrl(attachment, mediaState);
  // Track the item identity so an error cannot carry over when navigating.
  const [failedItem, setFailedItem] = useState<SelectableItem | null>(null);
  const decodeFailed = failedItem === item;
  const displayType = attachment ? getDisplayType(attachment) : 'file';
  const imageExpanded = mobile && expandedImage === item && !!item && displayType === 'image' && urlStatus !== 'missing' && !decodeFailed;
  const toggleImage = () => {
    setExpandedImage(imageExpanded ? null : item);
    setMenuOpen(false);
  };
  const isSelected = !!(item && selection?.isSelected(item));
  const bookmarked = !!(item && isAttachmentBookmarked?.(item));
  currentItemRef.current = item;
  selectionRef.current = selection;
  selectionModeRef.current = selectionMode;
  bookmarkToggleRef.current = onToggleBookmark;
  bookmarkingEnabledRef.current = attachmentBookmarkingEnabled;
  closeRef.current = closeViewer;

  useEffect(() => setExpandedImage(null), [mobile]);

  useEffect(() => {
    overlayRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (items.length === 0) {
      closeRef.current();
      return;
    }
    setCurrentIndex(index => Math.min(index, items.length - 1));
  }, [items.length]);

  useEffect(() => {
    setLinkCopied(false);
    setFilenameCopiedFor(null);
    if (copyTimerRef.current != null) {
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
    return () => {
      if (copyTimerRef.current != null) clearTimeout(copyTimerRef.current);
    };
  }, [currentIndex]);

  const findNavigableIndex = useCallback((startIndex: number, step: number) => {
    return findNextNavigableIndex(
      items,
      startIndex,
      step,
      candidate => !selectedNavigation || !!selection?.isSelected(candidate),
    );
  }, [items, selectedNavigation, selection]);

  const leftStep = reverseNavigation ? 1 : -1;
  const rightStep = -leftStep;
  const leftIndex = findNavigableIndex(currentIndex, leftStep);
  const rightIndex = findNavigableIndex(currentIndex, rightStep);
  const hasLeft = leftIndex >= 0;
  const hasRight = rightIndex >= 0;
  const navigationRendered = showNavigation && (hasLeft || hasRight);
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    if (!mobile) { prepareViewerImage(imageElementRef.current); return; }
    const measure = () => {
      const viewport = overlay.getBoundingClientRect();
      const top = Math.max(0, (topbarRef.current?.getBoundingClientRect().bottom ?? viewport.top) - viewport.top + 12);
      const footer = navigationRef.current;
      const bottom = footer ? viewport.bottom - footer.getBoundingClientRect().top + 12
        : 12 + (parseFloat(getComputedStyle(overlay).paddingBottom) || 0);
      for (const [name, value] of Object.entries({
        '--viewer-content-top': top, '--viewer-content-bottom': bottom,
        '--viewer-content-height': Math.max(0, viewport.height - top - bottom),
      })) {
        const pixels = `${value}px`;
        if (overlay.style.getPropertyValue(name) !== pixels) overlay.style.setProperty(name, pixels);
      }
    };
    measure();
    // Reveal cached images only after the current chrome has been measured.
    prepareViewerImage(imageElementRef.current);
    // Chrome stays independent of the content we resize, avoiding observer feedback.
    const observer = new ResizeObserver(measure);
    observer.observe(overlay);
    if (topbarRef.current) observer.observe(topbarRef.current);
    if (navigationRef.current) observer.observe(navigationRef.current);
    return () => {
      observer.disconnect();
      for (const name of ['--viewer-content-top', '--viewer-content-bottom', '--viewer-content-height']) overlay.style.removeProperty(name);
    };
  }, [mobile, navigationRendered, item, url]);
  const selectedItemCount = selectedNavigation && selection
    ? items.filter(candidate => selection.isSelected(candidate)).length
    : 0;

  const goToIndex = useCallback((index: number, preserveExpanded = false) => {
    setMenuOpen(false);
    if (index < 0) return;
    const nextItem = items[index];
    setExpandedImage(preserveExpanded && imageExpanded && nextItem.category !== 'links' && getDisplayType(nextItem) === 'image'
      ? nextItem : null);
    setCurrentIndex(index);
  }, [imageExpanded, items]);

  const goLeft = useCallback(() => goToIndex(leftIndex), [goToIndex, leftIndex]);
  const goRight = useCallback(() => goToIndex(rightIndex), [goToIndex, rightIndex]);
  const swipe = useViewerSwipe({
    enabled: mobile,
    item,
    onPrevious: () => goToIndex(leftIndex, true),
    onNext: () => goToIndex(rightIndex, true),
    onImageTap: toggleImage,
  });

  const handleJump = useCallback(() => {
    if (item) {
      onJumpToMessage(item.messageIndex);
    }
  }, [item, onJumpToMessage]);

  const handleCopyLink = useCallback(async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setLinkCopied(true);
      if (copyTimerRef.current != null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        copyTimerRef.current = null;
        setLinkCopied(false);
      }, 1800);
    } catch {
      window.prompt('Copy link:', link.url);
    }
  }, [link]);

  const handleCopyFilename = useCallback(async () => {
    if (!attachment) return;
    try {
      await navigator.clipboard.writeText(filename);
      setFilenameCopiedFor(attachment);
      if (copyTimerRef.current != null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        copyTimerRef.current = null;
        setFilenameCopiedFor(null);
      }, 1800);
    } catch {
      window.prompt('Copy filename:', filename);
    }
  }, [attachment, filename]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '\\' && bookmarkingEnabledRef.current) {
        const target = e.target as HTMLElement | null;
        if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
        const currentItem = currentItemRef.current;
        if (currentItem && bookmarkToggleRef.current) {
          e.preventDefault();
          e.stopPropagation();
          void bookmarkToggleRef.current(currentItem).catch(() => {});
        }
        return;
      }
      if (e.key === 'Enter' && selectionModeRef.current) {
        const target = e.target as HTMLElement | null;
        if (target?.closest('button, [role="button"], a, input, select, textarea, [contenteditable="true"]')) return;
        const currentItem = currentItemRef.current;
        const currentSelection = selectionRef.current;
        if (currentItem && currentSelection) {
          e.preventDefault();
          e.stopPropagation();
          currentSelection.toggle(currentItem);
        }
        return;
      }
      if (e.key === ' ' || e.code === 'Space') {
        if (e.target instanceof Element && e.target.closest('button, a, input, select, textarea, [role="button"]')) return;
        const mediaElement = mediaElementRef.current;
        if (mediaElement) {
          e.preventDefault();
          e.stopPropagation();
          if (mediaElement.paused) {
            void mediaElement.play().catch(() => {});
          } else {
            mediaElement.pause();
          }
        }
        return;
      }
      if (e.key === ',' || e.code === 'Comma' || e.key === '.' || e.code === 'Period') {
        const mediaElement = mediaElementRef.current;
        if (mediaElement) {
          e.preventDefault();
          e.stopPropagation();
          const direction = e.key === ',' || e.code === 'Comma' ? -1 : 1;
          const nextTime = Math.max(0, mediaElement.currentTime + direction * 5);
          mediaElement.currentTime = Number.isFinite(mediaElement.duration)
            ? Math.min(mediaElement.duration, nextTime)
            : nextTime;
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (imageExpanded) setExpandedImage(null);
        else if (menuOpen) {
          setMenuOpen(false);
          menuRef.current?.querySelector<HTMLButtonElement>('.media-viewer-menu-btn')?.focus({ preventScroll: true });
        }
        else closeViewer();
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        if (hasLeft) goLeft();
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        if (hasRight) goRight();
        return;
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [closeViewer, hasLeft, hasRight, goLeft, goRight, imageExpanded, menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const linkHostname = link ? (() => {
    try { return new URL(link.url).hostname.replace(/^www\./i, '') || link.url; }
    catch { return link.url; }
  })() : '';

  return createPortal(
    <div
      ref={overlayRef}
      className={`media-viewer-overlay${imageExpanded ? ' image-expanded' : ''}${showNavigation ? ' navigation-visible' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Attachment viewer"
      tabIndex={-1}
      {...swipe}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeViewer();
      }}
    >
      <div ref={topbarRef} className="media-viewer-topbar" inert={imageExpanded || undefined} aria-hidden={imageExpanded || undefined}>
        <div className="media-viewer-top-left">
          <div className="media-viewer-counter">
            {items.length > 0 && (selectedNavigation
              ? `${currentIndex + 1} / ${items.length} · ${selectedItemCount} selected`
              : `${currentIndex + 1} / ${items.length}`)}
          </div>
          {item && (
            <div className="media-viewer-meta">
              <span className="media-viewer-sender">{item.sender}</span>
              <span className="media-viewer-date">
                {new Date(item.timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
              </span>
            </div>
          )}
        </div>
        <div className="media-viewer-actions">
          {selectionMode && item && selection && (
            <button
              className={`media-viewer-btn media-viewer-select-toggle ${isSelected ? 'selected' : ''}`}
              onClick={() => selection.toggle(item)}
              title="Select (Enter)"
              aria-label={isSelected ? 'Deselect item' : 'Select item'}
              aria-pressed={isSelected}
            >
              {isSelected && <Check size={18} />}
            </button>
          )}
          {attachmentBookmarkingEnabled && item && onToggleBookmark && (
            <button
              className={`media-viewer-btn media-viewer-bookmark-toggle ${bookmarked ? 'bookmarked' : ''}`}
              onClick={() => void onToggleBookmark(item).catch(() => {})}
              title={bookmarked ? 'Remove bookmark (\\)' : 'Bookmark (\\)'}
              aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark item'}
              aria-pressed={bookmarked}
              disabled={bookmarkBusy}
            >
              <Bookmark size={19} fill={bookmarked ? 'currentColor' : 'none'} />
            </button>
          )}
          <div className="media-viewer-menu-wrap" ref={menuRef}>
            <button
              className="media-viewer-btn media-viewer-menu-btn"
              onClick={() => setMenuOpen(!menuOpen)}
              aria-label="More options"
              aria-expanded={menuOpen}
              title="More options"
            >
              <MoreVertical size={20} />
            </button>
            {menuOpen && (
              <div className="media-viewer-menu-dropdown">
                <button type="button" className="media-viewer-menu-item" onClick={toggleNavigation}>
                  {showNavigation ? <EyeOff size={16} className="media-viewer-menu-icon" /> : <Eye size={16} className="media-viewer-menu-icon" />}
                  {showNavigation ? 'Hide Navigation' : 'Show Navigation'}
                </button>
                {item && selection && (
                  <button className="media-viewer-menu-item" onClick={() => {
                    if (selectionMode) selection.deselectAll();
                    else selection.toggle(item);
                    setMenuOpen(false);
                  }}>
                    {selectionMode
                      ? <SquareX size={16} className="media-viewer-menu-icon" />
                      : <CheckSquare size={16} className="media-viewer-menu-icon" />}
                    {selectionMode ? 'Deselect all' : 'Select'}
                  </button>
                )}
                <button className="media-viewer-menu-item" onClick={handleJump}>
                  <ExternalLink size={16} className="media-viewer-menu-icon" />
                  Jump to message
                </button>
                {item && onJumpToAttachment && (
                  <button className="media-viewer-menu-item" onClick={() => {
                    onJumpToAttachment(item);
                    setMenuOpen(false);
                  }}>
                    <Paperclip size={16} className="media-viewer-menu-icon" />
                    Jump to attachment
                  </button>
                )}
                {link && (
                  <a className="media-viewer-menu-item" href={link.url} target="_blank" rel="noreferrer">
                    <ExternalLink size={16} className="media-viewer-menu-icon" />
                    Open link
                  </a>
                )}
                {attachment && (
                  <button className="media-viewer-menu-item" onClick={() => {
                    downloadSingle(
                      attachment,
                      mediaState,
                      useDateFilename,
                      chatTitle,
                      filenameTemplate,
                      allowLongFilenames
                    );
                    setMenuOpen(false);
                  }}>
                    <Download size={16} className="media-viewer-menu-icon" />
                    Download
                  </button>
                )}
                {attachment && (
                  <button className="media-viewer-menu-item" onClick={() => void handleCopyFilename()}>
                    {filenameCopied ? <Check size={16} className="media-viewer-menu-icon" /> : <Copy size={16} className="media-viewer-menu-icon" />}
                    <span aria-live="polite">{filenameCopied ? 'Filename copied' : 'Copy filename'}</span>
                  </button>
                )}
              </div>
            )}
          </div>
          <button
            className="media-viewer-btn media-viewer-close-btn"
            onClick={closeViewer}
            aria-label="Close"
            title="Close"
          >
            <X size={20} />
          </button>
        </div>
      </div>

      {navigationRendered && <div ref={navigationRef} className="media-viewer-navigation" aria-label="Attachment navigation"
        inert={imageExpanded || undefined} aria-hidden={imageExpanded || undefined}>
        <button
          type="button"
          className="media-viewer-nav media-viewer-nav-prev"
          disabled={!hasLeft}
          onClick={goLeft}
          aria-label={reverseNavigation ? 'Newer item' : 'Previous item'}
        >
          <ChevronLeft size={mobile ? 22 : 36} /><span>{reverseNavigation ? 'Newer' : 'Previous'}</span>
        </button>
        <button
          type="button"
          className="media-viewer-nav media-viewer-nav-next"
          disabled={!hasRight}
          onClick={goRight}
          aria-label={reverseNavigation ? 'Older item' : 'Next item'}
        >
          <span>{reverseNavigation ? 'Older' : 'Next'}</span><ChevronRight size={mobile ? 22 : 36} />
        </button>
      </div>}

      <div className={`media-viewer-content ${isSelected ? 'viewer-selected' : ''}`}>
        {!item ? (
          <div className="media-viewer-empty">No item</div>
        ) : link ? (
          <div className="media-viewer-link-card">
            <LinkIcon size={48} className="media-viewer-link-icon" />
            <strong className="media-viewer-link-host">{linkHostname}</strong>
            <span className="media-viewer-link-text" data-url={!link.label || link.label === link.url}>{link.label || link.url}</span>
            <span className="media-viewer-item-sender" title={`Sent by ${link.sender}`}>
              <UserRound size={12} />
              <span>{link.sender}</span>
            </span>
            <div className="media-viewer-file-actions">
              <a href={link.url} target="_blank" rel="noreferrer" className="media-viewer-download-btn">
                <ExternalLink size={16} /> Open link
              </a>
              <button
                type="button"
                className="media-viewer-download-btn media-viewer-download-secondary media-viewer-copy-link-btn"
                onClick={() => void handleCopyLink()}
                aria-label={linkCopied ? 'Link copied' : 'Copy link'}
              >
                {linkCopied ? <Check size={16} /> : <Copy size={16} />}
                <span className="media-viewer-copy-link-label" aria-hidden="true">
                  <span className={linkCopied ? 'hidden' : ''}>Copy link</span>
                  <span className={linkCopied ? '' : 'hidden'}>Copied</span>
                </span>
              </button>
            </div>
          </div>
        ) : urlStatus === 'loading' ? (
          <div className="media-viewer-placeholder">
            <div className="media-viewer-file-icon"><Paperclip size={48} /></div>
            <div className="media-viewer-file-name">{filename}</div>
            <div className="media-viewer-file-status">Loading attachment…</div>
          </div>
        ) : !url || decodeFailed ? (
          <div className="media-viewer-placeholder">
            <div className="media-viewer-file-icon"><UnavailableAttachment label={decodeFailed ? 'Attachment could not be displayed' : 'File not found'} /></div>
            <div className="media-viewer-file-name">{filename}</div>
            <div className="media-viewer-file-status">{decodeFailed ? 'Attachment could not be displayed' : 'File not found'}</div>
            {url && (
              <a href={url} target="_blank" rel="noreferrer" className="media-viewer-download-btn">
                <ExternalLink size={16} /> Open file
              </a>
            )}
          </div>
        ) : displayType === 'image' ? (
          <img
            key={`${currentIndex}:${url}`}
            ref={imageElementRef}
            src={url}
            alt={filename}
            className={`media-viewer-image${attachment?.category === 'stickers' ? ' media-viewer-sticker' : ''}`}
            draggable={false}
            role={mobile ? 'button' : undefined}
            tabIndex={mobile ? 0 : undefined}
            aria-label={mobile ? (imageExpanded ? 'Restore image controls' : 'Expand image') : undefined}
            aria-pressed={mobile ? imageExpanded : undefined}
            onClick={mobile ? toggleImage : undefined}
            onKeyDown={mobile ? event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggleImage();
              }
            } : undefined}
            onLoad={event => prepareViewerImage(event.currentTarget)}
            onError={() => setFailedItem(item)}
          />
        ) : displayType === 'video' ? (
          <video
            ref={mediaElementRef as React.RefObject<HTMLVideoElement>}
            key={currentIndex}
            src={url}
            controls
            autoPlay
            className="media-viewer-video"
            onError={() => setFailedItem(item)}
          />
        ) : displayType === 'audio' ? (
          <div className="media-viewer-audio-wrap">
            <div className="media-viewer-audio-icon"><Music size={48} /></div>
            <div className="media-viewer-file-name">{filename}</div>
            <div className="media-viewer-item-meta">
              <span className="media-viewer-item-sender" title={`Sent by ${item.sender}`}>
                <UserRound size={12} />
                <span>{item.sender}</span>
              </span>
              <MediaFileSize entry={mediaEntry} className="media-viewer-item-size" />
            </div>
            <audio
              ref={mediaElementRef as React.RefObject<HTMLAudioElement>}
              key={currentIndex}
              controls
              autoPlay
              src={url}
              className="media-viewer-audio"
              onError={() => setFailedItem(item)}
            />
          </div>
        ) : (
          <div className="media-viewer-placeholder">
            <div className="media-viewer-file-icon"><FileText size={48} /></div>
            <div className="media-viewer-file-name">{filename}</div>
            <div className="media-viewer-item-meta">
              <span className="media-viewer-item-sender" title={`Sent by ${item.sender}`}>
                <UserRound size={12} />
                <span>{item.sender}</span>
              </span>
              <MediaFileSize entry={mediaEntry} className="media-viewer-item-size" />
            </div>
            <div className="media-viewer-file-actions">
              <a href={url} target="_blank" rel="noreferrer" className="media-viewer-download-btn">
                <ExternalLink size={16} /> Open file
              </a>
              <a
                href={url}
                download={getAttachmentDownloadName(attachment!, useDateFilename, chatTitle, filenameTemplate, allowLongFilenames)}
                className="media-viewer-download-btn media-viewer-download-secondary"
              >
                <Download size={16} /> Download
              </a>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
