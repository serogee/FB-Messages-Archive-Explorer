import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { MoreVertical, ExternalLink, Download, X, ChevronLeft, ChevronRight, Check, CheckSquare, SquareX, Paperclip, Music, FileText } from 'lucide-react';
import type { ResolvedAttachment } from '../../types/messenger';
import { findMediaFile } from '../../services/media';
import { blobCache } from '../../services/blobCache';
import type { MediaState } from '../../types/messenger';
import type { useSelection } from '../../hooks/useSelection';
import { downloadSingle } from '../../services/saveAttachments';

interface MediaViewerProps {
  attachments: ResolvedAttachment[];
  initialIndex: number;
  mediaState: MediaState;
  onClose: () => void;
  onJumpToMessage: (messageIndex: number) => void;
  onJumpToAttachment?: (attachment: ResolvedAttachment) => void;
  selection?: ReturnType<typeof useSelection>;
  selectionMode?: boolean;
  reverseNavigation?: boolean;
}

type MediaUrlState = { url: string | null; status: 'loading' | 'ready' | 'missing' };

function useResolvedUrl(attachment: ResolvedAttachment | null, mediaState: MediaState): MediaUrlState {
  const [state, setState] = useState<MediaUrlState>({ url: null, status: 'loading' });

  useEffect(() => {
    if (!attachment) { setState({ url: null, status: 'missing' }); return; }

    const entry = attachment.mediaEntry || findMediaFile(mediaState, attachment.mediaPath);
    if (!entry) { setState({ url: null, status: 'missing' }); return; }

    const cached = blobCache.get(entry);
    if (cached) { setState({ url: cached, status: 'ready' }); return; }
    if (entry.url) {
      blobCache.put(entry, entry.url);
      setState({ url: entry.url, status: 'ready' });
      return;
    }

    if (entry.handle) {
      let cancelled = false;
      setState({ url: null, status: 'loading' });
      blobCache.getOrCreate(entry).then(blobUrl => {
        if (!cancelled) {
          setState(blobUrl
            ? { url: blobUrl, status: 'ready' }
            : { url: null, status: 'missing' });
        }
      });
      return () => { cancelled = true; };
    }
    setState({ url: null, status: 'missing' });
  }, [attachment, mediaState]);

  return state;
}

function getDisplayType(attachment: ResolvedAttachment): 'image' | 'video' | 'audio' | 'file' {
  const cat = attachment.category;
  if (cat === 'photos' || cat === 'gifs') return 'image';
  if (cat === 'videos') return 'video';
  if (cat === 'audio') return 'audio';
  return 'file';
}

export function MediaViewer({
  attachments,
  initialIndex,
  mediaState,
  onClose,
  onJumpToMessage,
  onJumpToAttachment,
  selection,
  selectionMode = false,
  reverseNavigation = false,
}: MediaViewerProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const mediaElementRef = useRef<HTMLMediaElement | null>(null);
  const currentAttachmentRef = useRef<ResolvedAttachment | null>(null);
  const selectionRef = useRef(selection);
  const selectionModeRef = useRef(selectionMode);

  const attachment = attachments[currentIndex] || null;
  const { url, status: urlStatus } = useResolvedUrl(attachment, mediaState);
  const displayType = attachment ? getDisplayType(attachment) : 'file';
  const isSelected = !!(attachment && selection?.isSelected(attachment));
  currentAttachmentRef.current = attachment;
  selectionRef.current = selection;
  selectionModeRef.current = selectionMode;

  const hasLeft = reverseNavigation
    ? currentIndex < attachments.length - 1
    : currentIndex > 0;
  const hasRight = reverseNavigation
    ? currentIndex > 0
    : currentIndex < attachments.length - 1;

  const goLeft = useCallback(() => {
    setCurrentIndex(index => reverseNavigation
      ? Math.min(attachments.length - 1, index + 1)
      : Math.max(0, index - 1));
    setMenuOpen(false);
  }, [attachments.length, reverseNavigation]);

  const goRight = useCallback(() => {
    setCurrentIndex(index => reverseNavigation
      ? Math.max(0, index - 1)
      : Math.min(attachments.length - 1, index + 1));
    setMenuOpen(false);
  }, [attachments.length, reverseNavigation]);

  const handleJump = useCallback(() => {
    if (attachment) {
      onJumpToMessage(attachment.messageIndex);
      onClose();
    }
  }, [attachment, onJumpToMessage, onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.key === ' ' || e.code === 'Space') && selectionModeRef.current) {
        const currentAttachment = currentAttachmentRef.current;
        const currentSelection = selectionRef.current;
        if (currentAttachment && currentSelection) {
          e.preventDefault();
          e.stopPropagation();
          currentSelection.toggle(currentAttachment);
        }
        return;
      }
      if (e.key === ' ' || e.code === 'Space') {
        const target = e.target as HTMLElement | null;
        const isFocusedControl = !!target?.closest('button, a, input, select, textarea');
        const mediaElement = mediaElementRef.current;
        if (mediaElement && !isFocusedControl) {
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
      if (e.key === 'Escape') { onClose(); return; }
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
  }, [onClose, hasLeft, hasRight, goLeft, goRight]);

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

  const filename = attachment?.mediaPath.split('/').pop() || 'Attachment';

  return createPortal(
    <div className="media-viewer-overlay" onClick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="media-viewer-topbar">
        <div className="media-viewer-top-left">
          <div className="media-viewer-counter">
            {attachments.length > 0 && `${currentIndex + 1} / ${attachments.length}`}
          </div>
          {attachment && (
            <div className="media-viewer-meta">
              <span className="media-viewer-sender">{attachment.sender}</span>
              <span className="media-viewer-date">
                {new Date(attachment.timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
              </span>
            </div>
          )}
        </div>
        <div className="media-viewer-actions">
          {selectionMode && attachment && selection && (
            <button
              className={`media-viewer-btn media-viewer-select-toggle ${isSelected ? 'selected' : ''}`}
              onClick={() => selection.toggle(attachment)}
              title="Select (Space)"
              aria-label={isSelected ? 'Deselect attachment' : 'Select attachment'}
              aria-pressed={isSelected}
            >
              {isSelected && <Check size={18} />}
            </button>
          )}
          <div className="media-viewer-menu-wrap" ref={menuRef}>
            <button
              className="media-viewer-btn media-viewer-menu-btn"
              onClick={() => setMenuOpen(!menuOpen)}
              aria-label="More options"
              title="More options"
            >
              <MoreVertical size={20} />
            </button>
            {menuOpen && (
              <div className="media-viewer-menu-dropdown">
                {attachment && selection && (
                  <button className="media-viewer-menu-item" onClick={() => {
                    if (selectionMode) selection.deselectAll();
                    else selection.toggle(attachment);
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
                {attachment && onJumpToAttachment && (
                  <button className="media-viewer-menu-item" onClick={() => {
                    onJumpToAttachment(attachment);
                    setMenuOpen(false);
                  }}>
                    <Paperclip size={16} className="media-viewer-menu-icon" />
                    Jump to attachment
                  </button>
                )}
                {attachment && (
                  <button className="media-viewer-menu-item" onClick={() => {
                    downloadSingle(attachment, mediaState);
                    setMenuOpen(false);
                  }}>
                    <Download size={16} className="media-viewer-menu-icon" />
                    Download
                  </button>
                )}
              </div>
            )}
          </div>
          <button
            className="media-viewer-btn media-viewer-close-btn"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <X size={20} />
          </button>
        </div>
      </div>

      {hasLeft && (
        <button
          className="media-viewer-nav media-viewer-nav-prev"
          onClick={goLeft}
          aria-label={reverseNavigation ? 'Newer attachment' : 'Previous attachment'}
        >
          <ChevronLeft size={36} />
        </button>
      )}
      {hasRight && (
        <button
          className="media-viewer-nav media-viewer-nav-next"
          onClick={goRight}
          aria-label={reverseNavigation ? 'Older attachment' : 'Next attachment'}
        >
          <ChevronRight size={36} />
        </button>
      )}

      <div className={`media-viewer-content ${isSelected ? 'viewer-selected' : ''}`}>
        {!attachment ? (
          <div className="media-viewer-empty">No attachment</div>
        ) : urlStatus === 'loading' ? (
          <div className="media-viewer-placeholder">
            <div className="media-viewer-file-icon"><Paperclip size={48} /></div>
            <div className="media-viewer-file-name">{filename}</div>
            <div className="media-viewer-file-status">Loading attachment…</div>
          </div>
        ) : !url ? (
          <div className="media-viewer-placeholder">
            <div className="media-viewer-file-icon"><Paperclip size={48} /></div>
            <div className="media-viewer-file-name">{filename}</div>
            <div className="media-viewer-file-status">File not found</div>
          </div>
        ) : displayType === 'image' ? (
          <img
            key={currentIndex}
            src={url}
            alt={filename}
            className="media-viewer-image"
            draggable={false}
          />
        ) : displayType === 'video' ? (
          <video
            ref={mediaElementRef as React.RefObject<HTMLVideoElement>}
            key={currentIndex}
            src={url}
            controls
            autoPlay={!selectionMode}
            className="media-viewer-video"
          />
        ) : displayType === 'audio' ? (
          <div className="media-viewer-audio-wrap">
            <div className="media-viewer-audio-icon"><Music size={48} /></div>
            <div className="media-viewer-file-name">{filename}</div>
            <audio
              ref={mediaElementRef as React.RefObject<HTMLAudioElement>}
              key={currentIndex}
              controls
              autoPlay={!selectionMode}
              src={url}
              className="media-viewer-audio"
            />
          </div>
        ) : (
          <div className="media-viewer-placeholder">
            <div className="media-viewer-file-icon"><FileText size={48} /></div>
            <div className="media-viewer-file-name">{filename}</div>
            <div className="media-viewer-file-actions">
              <a href={url} target="_blank" rel="noreferrer" className="media-viewer-download-btn">
                <ExternalLink size={16} /> Open file
              </a>
              <a href={url} download={filename} className="media-viewer-download-btn media-viewer-download-secondary">
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
