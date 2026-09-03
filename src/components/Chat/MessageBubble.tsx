import React, { memo, useState, useEffect, useRef } from 'react';
import type { MessengerMessage, MediaState } from '../../types/messenger';
import { getMessageTimestamp, fixEncoding } from '../../services/parser';
import { findMediaFile, getMediaReferencePath, getMediaType } from '../../services/media';
import { blobCache, openMediaEntryInNewTab } from '../../services/blobCache';
import { getReactionTimestamp } from '../../services/reactions';
import { highlightText } from '../../services/search';
import { escapeHtml } from '../../services/storage';
import { getMessageLinks, MESSAGE_URL_PATTERN, normalizeExternalUrl, trimTrailingUrlPunctuation } from '../../services/messageLinks';
import { ReactionModal } from './ReactionModal';
import { MediaFileSize } from '../MediaFileSize';
import { FileText, Info, Link as LinkIcon, Pause, Play, Volume2, VolumeX } from 'lucide-react';

const lazyMediaLoadCallbacks = new Map<Element, () => void>();
const lazyMediaResizeCallbacks = new Map<Element, (entry: ResizeObserverEntry) => void>();
const lazyMediaVisibilityCallbacks = new Map<Element, (isVisible: boolean) => void>();
let sharedLazyMediaObserver: IntersectionObserver | null = null;
let sharedLazyMediaResizeObserver: ResizeObserver | null = null;
let sharedLazyMediaVisibilityObserver: IntersectionObserver | null = null;

function getSharedLazyMediaObserver() {
  if (!sharedLazyMediaObserver) {
    sharedLazyMediaObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;

        const callback = lazyMediaLoadCallbacks.get(entry.target);
        if (callback) callback();
        sharedLazyMediaObserver?.unobserve(entry.target);
        lazyMediaLoadCallbacks.delete(entry.target);
      });
    }, { rootMargin: '500px' });
  }
  return sharedLazyMediaObserver;
}

function getSharedLazyMediaResizeObserver() {
  if (!sharedLazyMediaResizeObserver) {
    sharedLazyMediaResizeObserver = new ResizeObserver((entries) => {
      entries.forEach(entry => {
        const callback = lazyMediaResizeCallbacks.get(entry.target);
        if (callback) callback(entry);
      });
    });
  }
  return sharedLazyMediaResizeObserver;
}

function getSharedLazyMediaVisibilityObserver() {
  if (!sharedLazyMediaVisibilityObserver) {
    sharedLazyMediaVisibilityObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        const callback = lazyMediaVisibilityCallbacks.get(entry.target);
        if (callback) callback(entry.isIntersecting);
      });
    }, { threshold: 0 });
  }
  return sharedLazyMediaVisibilityObserver;
}

interface MessageBubbleProps {
  msg: MessengerMessage;
  isMe: boolean;
  showMyName: boolean;
  showTheirName: boolean;
  showReactions: boolean;
  mediaState: MediaState;
  highlightQuery: string;
  msgIndex: number;
  isFirstInClump: boolean;
  isLastInClump: boolean;
  onMediaClick?: (mediaPath: string, msgIndex: number) => void;
  onLinkClick?: (url: string, msgIndex: number) => void;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

function getReactionTimeText(ts: number): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function renderHighlightedText(text: string, highlightQuery: string, key: string) {
  const html = highlightQuery ? highlightText(text, highlightQuery) : escapeHtml(text);
  return <React.Fragment key={key}><span dangerouslySetInnerHTML={{ __html: html }} /></React.Fragment>;
}

function MessageText({ text, highlightQuery }: { text: string; highlightQuery: string }) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  MESSAGE_URL_PATTERN.lastIndex = 0;

  while ((match = MESSAGE_URL_PATTERN.exec(text)) !== null) {
    const label = trimTrailingUrlPunctuation(match[0]);
    if (!label) continue;

    const start = match.index;
    const end = start + label.length;
    if (start > lastIndex) parts.push(renderHighlightedText(text.slice(lastIndex, start), highlightQuery, `text:${lastIndex}`));

    const href = normalizeExternalUrl(label);
    parts.push(href ? (
      <a key={`link:${start}`} href={href} target="_blank" rel="noreferrer" className="message-inline-link">
        {renderHighlightedText(label, highlightQuery, `label:${start}`)}
      </a>
    ) : renderHighlightedText(label, highlightQuery, `invalid:${start}`));
    lastIndex = end;
    MESSAGE_URL_PATTERN.lastIndex = end;
  }

  if (lastIndex < text.length) parts.push(renderHighlightedText(text.slice(lastIndex), highlightQuery, `text:${lastIndex}`));
  return <>{parts}</>;
}

function SharedLinkPreview({ link, label, onOpenViewer }: { link: string; label?: string; onOpenViewer?: () => void }) {
  const href = normalizeExternalUrl(link);
  if (!href) return null;

  const hostname = new URL(href).hostname.replace(/^www\./i, '');
  return (
    <span className="message-shared-link" title={href}>
      <a href={href} target="_blank" rel="noreferrer" className="message-shared-link-main">
        <span className="message-shared-link-icon"><LinkIcon size={17} /></span>
        <span className="message-shared-link-copy">
          <strong>{hostname}</strong>
          <span>{label || href}</span>
        </span>
      </a>
      {onOpenViewer && (
        <button type="button" className="media-file-info" onClick={onOpenViewer} aria-label="Open link in viewer" title="Open in viewer">
          <Info size={15} />
        </button>
      )}
    </span>
  );
}

function formatPlayerTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
    : `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

function InlineAudioPlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    setPlaying(false);
    setMuted(false);
    setCurrentTime(0);
    setDuration(0);
    return () => audio?.pause();
  }, [src]);

  const togglePlayback = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => setPlaying(false));
    else audio.pause();
  };

  const toggleMuted = () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = !audio.muted;
    setMuted(audio.muted);
  };

  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div className="media-audio-control">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={event => setCurrentTime(event.currentTarget.currentTime)}
        onDurationChange={event => {
          const nextDuration = event.currentTarget.duration;
          setDuration(Number.isFinite(nextDuration) ? nextDuration : 0);
        }}
      />
      <button type="button" className="media-audio-button" onClick={togglePlayback} aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
      </button>
      <input
        type="range"
        className="media-audio-seek"
        min={0}
        max={duration || 0}
        step={0.1}
        value={Math.min(currentTime, duration || 0)}
        disabled={duration <= 0}
        aria-label="Seek audio"
        style={{ '--audio-progress': `${progress}%` } as React.CSSProperties}
        onChange={event => {
          const nextTime = Number(event.target.value);
          if (audioRef.current) audioRef.current.currentTime = nextTime;
          setCurrentTime(nextTime);
        }}
      />
      <span className="media-audio-time">{formatPlayerTime(currentTime)} / {formatPlayerTime(duration)}</span>
      <button type="button" className="media-audio-button" onClick={toggleMuted} aria-label={muted ? 'Unmute' : 'Mute'}>
        {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
      </button>
    </div>
  );
}

function LazyMedia({
  mediaPath,
  mediaFile,
  preferredType,
  isSticker = false,
  onMediaClick,
}: {
  mediaPath: string;
  mediaFile: ReturnType<typeof findMediaFile>;
  preferredType?: 'image' | 'video' | 'audio';
  isSticker?: boolean;
  onMediaClick?: () => void;
}) {
  const [fileURL, setFileURL] = useState<string | null>(() => {
    if (!mediaFile) return null;
    return blobCache.get(mediaFile) || mediaFile.url || null;
  });
  const mediaRef = useRef<HTMLElement | null>(null);
  const prevHeight = useRef<number | null>(null);
  const ext = mediaPath.split('.').pop()?.toLowerCase() || '';
  const mediaType = preferredType || (ext === 'mp4' || ext === 'webm' ? 'video' : (mediaFile?.type || getMediaType(mediaPath)));

  // Sharing observers keeps message-heavy chats from allocating one per attachment.
  useEffect(() => {
    let isMounted = true;
    if (!mediaFile || !mediaFile.handle || fileURL) return;

    const cached = blobCache.get(mediaFile);
    if (cached) {
      setFileURL(cached);
      return;
    }
    if (mediaFile.url) {
      blobCache.put(mediaFile, mediaFile.url);
      setFileURL(mediaFile.url);
      return;
    }

    const el = mediaRef.current;
    if (!el) return;

    const observer = getSharedLazyMediaObserver();
    lazyMediaLoadCallbacks.set(el, () => {
      blobCache.getOrCreate(mediaFile).then(url => {
        if (isMounted && url) setFileURL(url);
      });
    });
    observer.observe(el);

    return () => { 
      isMounted = false; 
      observer.unobserve(el);
      lazyMediaLoadCallbacks.delete(el);
    };
  }, [mediaFile, fileURL]);

  // Compensate for lazy media height changes so the user's scroll anchor stays stable.
  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;

    const observer = getSharedLazyMediaResizeObserver();
    lazyMediaResizeCallbacks.set(el, (entry) => {
      const newHeight = entry.borderBoxSize ? entry.borderBoxSize[0].blockSize : entry.contentRect.height;

      const appContainer = el.closest('.container');
      if (appContainer?.classList.contains('resizing') || appContainer?.classList.contains('resize-settling')) {
        prevHeight.current = newHeight;
        return;
      }
      
      const oldHeight = prevHeight.current;
      if (oldHeight !== null && oldHeight !== newHeight) {
        const delta = newHeight - oldHeight;
        const container = el.closest('#chat') as HTMLElement;
        
        if (container) {
          const scrollDir = container.dataset.scrollDir || 'up';
          const containerRect = container.getBoundingClientRect();
          const elRect = el.getBoundingClientRect();
          
          const isAtBottom = container.dataset.isAtBottom === 'true';

          let isAboveAnchor = false;
          if (isAtBottom) {
            container.scrollTop = container.scrollHeight;
            container.dataset.lastScrollTop = String(container.scrollTop);
          } else {
            // Anchor to the top edge while scrolling down and the bottom edge while scrolling up.
            if (scrollDir === 'down') {
              if (elRect.top < containerRect.top) isAboveAnchor = true;
            } else {
              if (elRect.top < containerRect.bottom) isAboveAnchor = true;
            }

            if (isAboveAnchor) {
              container.scrollTop += delta;
              container.dataset.lastScrollTop = String(container.scrollTop);
            }
          }
        }
      }
      prevHeight.current = newHeight;
    });

    observer.observe(el);
    return () => {
      observer.unobserve(el);
      lazyMediaResizeCallbacks.delete(el);
    };
  }, []);

  useEffect(() => {
    const el = mediaRef.current;
    if (!el || mediaType !== 'video') return;

    const observer = getSharedLazyMediaVisibilityObserver();
    lazyMediaVisibilityCallbacks.set(el, (isVisible) => {
      if (isVisible) return;

      const video = el.querySelector('video');
      if (video && !video.paused) {
        video.pause();
      }
    });
    observer.observe(el);

    return () => {
      observer.unobserve(el);
      lazyMediaVisibilityCallbacks.delete(el);
    };
  }, [mediaType]);

  let content: React.ReactNode;
  if (mediaType === 'image') {
    content = fileURL
      ? <div className={`media-preview${isSticker ? ' sticker-preview' : ''}`} onClick={onMediaClick} role="button" tabIndex={0} style={{ cursor: 'pointer' }}>
          <img src={fileURL} alt={isSticker ? 'Sticker' : 'Image'} className="preview" />
        </div>
      : <span className="placeholder">[ Image not found ]</span>;
  } else if (mediaType === 'video') {
    content = fileURL
      ? <div className="media-preview" onClick={onMediaClick} role="button" tabIndex={0} style={{ cursor: 'pointer' }}>
          <video controls className="preview-video" onClick={(e) => { e.preventDefault(); onMediaClick?.(); }}>
            <source src={fileURL} type="video/mp4" />
          </video>
        </div>
      : <span className="placeholder">[ Video not found ]</span>;
  } else if (mediaType === 'audio') {
    content = fileURL
      ? <div className="media-audio-wrap">
          <InlineAudioPlayer src={fileURL} />
          {onMediaClick && <button className="media-audio-expand" onClick={onMediaClick} aria-label="Open audio in viewer" title="Open in viewer"><Info size={15} /></button>}
        </div>
      : <span className="placeholder audio-placeholder">[ Audio not found ]</span>;
  } else {
    const filename = mediaPath.split('/').pop() || 'File attachment';
    content = mediaFile
      ? <div className="media-file-card">
          <button
            type="button"
            className="media-file-open"
            onClick={() => openMediaEntryInNewTab(mediaFile)}
            title={`Open ${filename} in a new tab`}
          >
            <FileText size={17} />
            <span className="media-file-copy">
              <span className="media-file-name">{filename}</span>
              <MediaFileSize entry={mediaFile} className="media-file-size" />
            </span>
          </button>
          {onMediaClick && (
            <button
              type="button"
              className="media-file-info"
              onClick={onMediaClick}
              aria-label={`View information for ${filename}`}
              title="Open in viewer"
            >
              <Info size={15} />
            </button>
          )}
        </div>
      : <span className="placeholder" style={{ width: 'auto', padding: '8px 12px' }}>[ File not found ]</span>;
  }

  return (
    <div ref={mediaRef as React.RefObject<HTMLDivElement>} className="lazy-media-wrapper">
      {content}
    </div>
  );
}

export const MessageBubble = memo(function MessageBubble({
  msg,
  isMe,
  showMyName,
  showTheirName,
  showReactions,
  mediaState,
  highlightQuery,
  msgIndex,
  isFirstInClump,
  isLastInClump,
  onMediaClick,
  onLinkClick,
}: MessageBubbleProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);

  const sender = msg.senderName || msg.sender_name || 'Unknown';
  const rawText = fixEncoding(msg?.text || msg?.content || '').trim();
  const timestamp = getMessageTimestamp(msg) || 0;
  const seenMediaPaths = new Set<string>();
  const mediaItems = [
    ...(msg.photos || []).map(media => ({ media, preferredType: 'image' as const, isSticker: false })),
    ...(msg.videos || []).map(media => ({ media, preferredType: 'video' as const, isSticker: false })),
    ...(msg.audio || []).map(media => ({ media, preferredType: 'audio' as const, isSticker: false })),
    ...(msg.audio_files || []).map(media => ({ media, preferredType: 'audio' as const, isSticker: false })),
    ...(msg.gifs || []).map(media => ({ media, preferredType: 'image' as const, isSticker: false })),
    ...(msg.files || []).map(media => ({ media, preferredType: undefined, isSticker: false })),
    ...(msg.media || []).map(media => ({ media, preferredType: undefined, isSticker: false })),
    ...(msg.sticker ? [{ media: msg.sticker, preferredType: 'image' as const, isSticker: true }] : []),
  ].filter(({ media }) => {
    const mediaPath = getMediaReferencePath(media).toLowerCase();
    if (!mediaPath || seenMediaPaths.has(mediaPath)) return false;
    seenMediaPaths.add(mediaPath);
    return true;
  });

  const resolvedMediaItems = mediaItems.map(({ media, preferredType, isSticker }) => {
    const mediaPath = getMediaReferencePath(media);
    const ext = mediaPath.split('.').pop()?.toLowerCase() || '';
    const mediaFile = findMediaFile(mediaState, mediaPath);
    const mediaType = preferredType || (ext === 'mp4' || ext === 'webm' ? 'video' : (mediaFile?.type || getMediaType(mediaPath)));
    return { media, preferredType, mediaPath, mediaFile, mediaType, isSticker };
  });

  const previewMediaItems = resolvedMediaItems.filter(item => item.mediaType === 'image' || item.mediaType === 'video');
  const otherMediaItems = resolvedMediaItems.filter(item => item.mediaType !== 'image' && item.mediaType !== 'video');
  const hasMediaPreview = previewMediaItems.length > 0;
  const hasMediaGrid = previewMediaItems.length > 1;
  const hasOddMediaGrid = hasMediaGrid && previewMediaItems.length % 2 === 1;

  const messageLinks = getMessageLinks(msg).map(link => ({
    ...link,
    label: link.label ? fixEncoding(link.label) : undefined,
  }));
  const isMediaOnly = hasMediaPreview && !rawText && messageLinks.length === 0 && otherMediaItems.length === 0;

  const showName = isMe ? showMyName : showTheirName;
  
  const hasReactions = !!(showReactions && msg.reactions && msg.reactions.length > 0);
  let uniqueEmojis: string[] = [];
  if (hasReactions) {
    uniqueEmojis = Array.from(new Set(msg.reactions!.map(r => r.reaction))).slice(0, 3);
  }

  return (
    <div className={`message-wrapper ${isMe ? 'from-me-wrapper' : 'from-them-wrapper'}`}>
      {showName && isFirstInClump && (
        <div className="sender-name">{sender}</div>
      )}
      <div
        className={`message ${isMe ? 'from-me' : 'from-them'} ${isFirstInClump ? 'clump-first' : ''} ${isLastInClump ? 'clump-last' : ''} ${hasReactions ? 'has-reactions' : ''} ${hasMediaPreview ? 'has-media-preview' : ''} ${hasMediaGrid ? 'has-media-grid' : ''} ${hasOddMediaGrid ? 'has-odd-media-grid' : ''} ${isMediaOnly ? 'media-only' : ''}`}
        data-msg-index={msgIndex}
      >
        <div className="message-content">
        {msg.is_unsent ? (
          <span className="msg-unsent">Message unsent</span>
        ) : (
          <>
            {rawText && (
              <span className="message-text">
                <MessageText text={rawText} highlightQuery={highlightQuery} />
              </span>
            )}

            {messageLinks.length > 0 && (
              <div className="message-link-list">
                {messageLinks.map(link => (
                  <SharedLinkPreview
                    key={link.url}
                    link={link.url}
                    label={link.label}
                    onOpenViewer={onLinkClick ? () => onLinkClick(link.url, msgIndex) : undefined}
                  />
                ))}
              </div>
            )}

            {hasMediaGrid ? (
              <div className="message-media-grid">
                {previewMediaItems.map(({ preferredType, mediaPath, mediaFile, isSticker }, i) => (
                  <LazyMedia
                    key={`${mediaPath}:${i}`}
                    mediaPath={mediaPath}
                    mediaFile={mediaFile}
                    preferredType={preferredType}
                    isSticker={isSticker}
                    onMediaClick={onMediaClick ? () => onMediaClick(mediaPath, msgIndex) : undefined}
                  />
                ))}
              </div>
            ) : (
              previewMediaItems.map(({ preferredType, mediaPath, mediaFile, isSticker }, i) => (
                <LazyMedia
                  key={`${mediaPath}:${i}`}
                  mediaPath={mediaPath}
                  mediaFile={mediaFile}
                  preferredType={preferredType}
                  isSticker={isSticker}
                  onMediaClick={onMediaClick ? () => onMediaClick(mediaPath, msgIndex) : undefined}
                />
              ))
            )}

            {otherMediaItems.map(({ preferredType, mediaPath, mediaFile, isSticker }, i) => (
              <LazyMedia
                key={`${mediaPath}:other:${i}`}
                mediaPath={mediaPath}
                mediaFile={mediaFile}
                preferredType={preferredType}
                isSticker={isSticker}
                onMediaClick={onMediaClick ? () => onMediaClick(mediaPath, msgIndex) : undefined}
              />
            ))}

            {hasReactions && (
              <div 
                className="reaction-bubble"
                onClick={() => setIsModalOpen(true)}
                style={{ cursor: 'pointer' }}
              >
                {uniqueEmojis.map((emoji, i) => (
                  <span key={i} className="reaction-emoji-simple">
                    {emoji}
                  </span>
                ))}
                {msg.reactions!.length > 1 && (
                  <span className="reaction-count">{msg.reactions!.length}</span>
                )}
                
                <div className="reaction-popover">
                  {msg.reactions!.map((r, i) => {
                    const reactionTs = getReactionTimestamp(r);
                    const timeText = getReactionTimeText(reactionTs);
                    return (
                      <div 
                        key={i} 
                        className="reaction-popover-item"
                        title={timeText || undefined}
                      >
                        <span className="popover-emoji">{r.reaction}</span>
                        <span className={`popover-actor ${timeText ? 'has-time-info' : ''}`}>{r.actor}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            
            {isModalOpen && msg.reactions && (
              <ReactionModal 
                reactions={msg.reactions} 
                onClose={() => setIsModalOpen(false)} 
              />
            )}
          </>
        )}

        <div className="msg-timestamp">
          {timestamp ? formatTimestamp(timestamp) : ''}
        </div>
      </div>
    </div>
    </div>
  );
});
