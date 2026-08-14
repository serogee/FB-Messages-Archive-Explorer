import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ResolvedAttachment } from '../../types/messenger';
import { findMediaFile } from '../../services/media';
import type { MediaState } from '../../types/messenger';

interface MediaViewerProps {
  attachments: ResolvedAttachment[];
  initialIndex: number;
  mediaState: MediaState;
  onClose: () => void;
  onJumpToMessage: (messageIndex: number) => void;
}

function useResolvedUrl(attachment: ResolvedAttachment | null, mediaState: MediaState): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!attachment) { setUrl(null); return; }

    const entry = attachment.mediaEntry || findMediaFile(mediaState, attachment.mediaPath);
    if (!entry) { setUrl(null); return; }
    if (entry.url) { setUrl(entry.url); return; }
    if (entry.handle) {
      let cancelled = false;
      entry.handle.getFile().then(file => {
        const blobUrl = URL.createObjectURL(file);
        entry.url = blobUrl;
        if (!cancelled) setUrl(blobUrl);
      }).catch(() => { if (!cancelled) setUrl(null); });
      return () => { cancelled = true; };
    }
    setUrl(null);
  }, [attachment, mediaState]);

  return url;
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
}: MediaViewerProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const attachment = attachments[currentIndex] || null;
  const url = useResolvedUrl(attachment, mediaState);
  const displayType = attachment ? getDisplayType(attachment) : 'file';

  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < attachments.length - 1;

  const goPrev = useCallback(() => {
    setCurrentIndex(i => Math.max(0, i - 1));
    setMenuOpen(false);
  }, []);

  const goNext = useCallback(() => {
    setCurrentIndex(i => Math.min(attachments.length - 1, i + 1));
    setMenuOpen(false);
  }, [attachments.length]);

  const handleJump = useCallback(() => {
    if (attachment) {
      onJumpToMessage(attachment.messageIndex);
      onClose();
    }
  }, [attachment, onJumpToMessage, onClose]);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowLeft' && hasPrev) { goPrev(); return; }
      if (e.key === 'ArrowRight' && hasNext) { goNext(); return; }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, hasPrev, hasNext, goPrev, goNext]);

  // Close menu on outside click
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
      {/* Top bar */}
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
          <div className="media-viewer-menu-wrap" ref={menuRef}>
            <button
              className="media-viewer-btn media-viewer-menu-btn"
              onClick={() => setMenuOpen(!menuOpen)}
              aria-label="More options"
              title="More options"
            >⋯</button>
            {menuOpen && (
              <div className="media-viewer-menu-dropdown">
                <button className="media-viewer-menu-item" onClick={handleJump}>
                  <span className="media-viewer-menu-icon">↗</span>
                  Jump to message
                </button>
                {url && displayType !== 'audio' && (
                  <a href={url} download={filename} className="media-viewer-menu-item" onClick={() => setMenuOpen(false)}>
                    <span className="media-viewer-menu-icon">↓</span>
                    Download
                  </a>
                )}
              </div>
            )}
          </div>
          <button
            className="media-viewer-btn media-viewer-close-btn"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >✕</button>
        </div>
      </div>

      {/* Navigation arrows */}
      {hasPrev && (
        <button className="media-viewer-nav media-viewer-nav-prev" onClick={goPrev} aria-label="Previous">
          ‹
        </button>
      )}
      {hasNext && (
        <button className="media-viewer-nav media-viewer-nav-next" onClick={goNext} aria-label="Next">
          ›
        </button>
      )}

      {/* Media display */}
      <div className="media-viewer-content">
        {!attachment ? (
          <div className="media-viewer-empty">No attachment</div>
        ) : !url ? (
          <div className="media-viewer-placeholder">
            <div className="media-viewer-file-icon">📎</div>
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
            key={currentIndex}
            src={url}
            controls
            autoPlay
            className="media-viewer-video"
          />
        ) : displayType === 'audio' ? (
          <div className="media-viewer-audio-wrap">
            <div className="media-viewer-audio-icon">🎵</div>
            <div className="media-viewer-file-name">{filename}</div>
            <audio key={currentIndex} controls autoPlay src={url} className="media-viewer-audio" />
          </div>
        ) : (
          <div className="media-viewer-placeholder">
            <div className="media-viewer-file-icon">📄</div>
            <div className="media-viewer-file-name">{filename}</div>
            <a href={url} download={filename} className="media-viewer-download-btn">
              Download
            </a>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
