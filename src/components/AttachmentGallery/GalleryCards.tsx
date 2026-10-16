import { memo, useEffect, useState } from 'react';
import type { MediaState, ResolvedAttachment, ResolvedLink, SelectableItem } from '../../types/messenger';
import { Image as ImageIcon, Film, Music, FileText, Play, Check, Info, ExternalLink, Link as LinkIcon, MessageSquare, UserRound, Bookmark } from 'lucide-react';
import { AttachmentUsageIndicators } from '../AttachmentUsageIndicators';
import { findMediaFile } from '../../services/media';
import { imageThumbnailCache } from '../../services/imageThumbnailCache';
import { videoPosterCache } from '../../services/videoPosterCache';
import { blobCache } from '../../services/blobCache';
import { formatAudioDuration } from '../../services/audioMetadata';
import { useAudioMetadata } from '../../hooks/useAudioMetadata';
import { formatFileSize } from '../../services/storage';
import { MediaFileSize } from '../MediaFileSize';
import { UnavailableAttachment } from '../UnavailableAttachment';

interface GalleryThumbnailProps {
  mobile: boolean;
  attachment: ResolvedAttachment;
  mediaState: MediaState;
  onOpen: (attachment: ResolvedAttachment) => void;
  onOpenFile: (attachment: ResolvedAttachment) => void;
  onJumpToMessage: (messageIndex: number, item?: SelectableItem) => void;
  onSelect: (attachment: ResolvedAttachment) => void;
  selectionMode: boolean;
  isSelected: boolean;
  isBookmarked: boolean;
  isJumpHighlighted: boolean;
  compactFileCard: boolean;
  compactAudioCard: boolean;
  showAuthorAndSize: boolean;
}

function AudioCardMetadata({ attachment, mediaState }: { attachment: ResolvedAttachment; mediaState: MediaState }) {
  const metadata = useAudioMetadata(attachment, mediaState);

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
  const metadata = useAudioMetadata(attachment, mediaState);

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

export const GalleryThumbnail = memo(function GalleryThumbnail({
  mobile,
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
  const [thumbnailFailed, setThumbnailFailed] = useState(false);

  useEffect(() => {
    setThumbnailFailed(false);
    if (attachment.category !== 'photos' && attachment.category !== 'gifs' && attachment.category !== 'videos' && attachment.category !== 'stickers') {
      setUrl(null);
      setVideoDuration(null);
      return;
    }

    const entry = attachment.mediaEntry || findMediaFile(mediaState, attachment.mediaPath);
    if (!entry) {
      setUrl(null);
      setVideoDuration(null);
      setThumbnailFailed(true);
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
        if (mounted) {
          setUrl(stickerUrl);
          setThumbnailFailed(!stickerUrl);
        }
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
        setThumbnailFailed(!details);
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
      setThumbnailFailed(!thumbnailUrl);
      if (thumbnailUrl) setUrl(thumbnailUrl);
    });
  }, [attachment, mediaState]);

  const category = attachment.category;
  const usageCount = attachment.usageCount ?? 1;
  const filename = attachment.mediaPath.split('/').pop() || 'File';
  const missingFile = !(attachment.mediaEntry || findMediaFile(mediaState, attachment.mediaPath));

  const activate = (event: React.MouseEvent | React.KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (selectionMode) onSelect(attachment);
    else if (category === 'files' && !mobile) onOpenFile(attachment);
    else onOpen(attachment);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === ' ' || event.key === 'Enter') activate(event);
  };

  return (
    <div
      className={`gallery-thumb ${usageCount > 1 ? 'has-reuses' : ''} ${category === 'audio' || category === 'files' ? 'gallery-thumb-file' : ''} ${category === 'stickers' ? 'gallery-thumb-sticker' : ''} ${compactFileCard ? 'gallery-thumb-file-compact' : ''} ${compactAudioCard ? 'gallery-thumb-audio-compact' : ''} ${isSelected ? 'selected' : ''} ${isJumpHighlighted ? 'jump-highlight' : ''}`}
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
          ? <img src={url} alt={filename} className="gallery-thumb-img" onError={() => { setUrl(null); setThumbnailFailed(true); }} />
          : thumbnailFailed
            ? <UnavailableAttachment label={`${missingFile ? 'File not found' : 'Preview unavailable'}: ${filename}`} className="gallery-thumb-placeholder" />
            : <div className="gallery-thumb-placeholder"><ImageIcon size={24} /></div>
      ) : category === 'videos' ? (
        <>
          {url
            ? <img src={url} alt={filename} className="gallery-thumb-img" onError={() => { setUrl(null); setThumbnailFailed(true); }} />
            : thumbnailFailed
              ? <UnavailableAttachment label={`${missingFile ? 'Video not found' : 'Video preview unavailable'}: ${filename}`} className="gallery-thumb-placeholder" />
              : <div className="gallery-thumb-placeholder"><Film size={24} /></div>}
          {videoDuration !== null && <div className="gallery-video-duration">{formatAudioDuration(videoDuration)}</div>}
          <div className="gallery-thumb-play"><Play fill="currentColor" size={24} /></div>
        </>
      ) : category === 'audio' ? (
        <>
          <div className="gallery-thumb-icon">{missingFile ? <UnavailableAttachment label={`Audio not found: ${filename}`} /> : <Music size={24} />}</div>
          <div className="gallery-thumb-name">{filename}</div>
          {compactAudioCard && <AudioCardMetadata attachment={attachment} mediaState={mediaState} />}
          {showAuthorAndSize && <AudioAuthorDurationAndSize attachment={attachment} mediaState={mediaState} />}
        </>
      ) : (
        <>
          <div className="gallery-thumb-icon">{missingFile ? <UnavailableAttachment label={`File not found: ${filename}`} /> : <FileText size={24} />}</div>
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
              {!selectionMode && !mobile && (
                <span className="gallery-file-open"><FileText size={12} /> Open file</span>
              )}
            </div>
          )}
        </>
      )}

      {selectionMode && !mobile && (
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

      {!selectionMode && !mobile && category === 'files' && (
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

      {!selectionMode && !mobile && (
        <button
          type="button"
          className="gallery-link-message"
          onClick={event => {
            event.preventDefault();
            event.stopPropagation();
            onJumpToMessage(attachment.messageIndex, attachment);
          }}
          title="Jump to message"
          aria-label={`Jump to message containing ${filename}`}
        >
          <MessageSquare size={14} />
        </button>
      )}

      <AttachmentUsageIndicators attachment={attachment} />

      {isBookmarked && (
        <span className="gallery-bookmark-indicator" title="Bookmarked" aria-label="Bookmarked attachment">
          <Bookmark size={15} fill="currentColor" />
        </span>
      )}
    </div>
  );
}, (previous, next) => (
  previous.attachment === next.attachment
  && previous.mobile === next.mobile
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

export const GalleryLinkCard = memo(function GalleryLinkCard({
  mobile,
  squareCard,
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
  mobile: boolean;
  squareCard: boolean;
  link: ResolvedLink;
  onJumpToMessage: (messageIndex: number, item?: SelectableItem) => void;
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
      <span className="gallery-link-url" data-url={!link.label || link.label === link.url}>{link.label || link.url}</span>
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
      className={`gallery-thumb gallery-link-card ${squareCard ? 'gallery-link-card-square' : ''} ${isSelected ? 'selected' : ''} ${isJumpHighlighted ? 'jump-highlight' : ''}`}
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
      {!mobile && (selectionMode || !openViewerOnCard) && (
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
      {!selectionMode && !mobile && <button
        type="button"
        className="gallery-link-message"
        onClick={event => {
          event.preventDefault();
          event.stopPropagation();
          onJumpToMessage(link.messageIndex, link);
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
