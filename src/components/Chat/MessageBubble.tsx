import React, { memo, useState, useEffect, useRef } from 'react';
import type { MessengerMessage, MediaState } from '../../types/messenger';
import { getMessageTimestamp, fixEncoding } from '../../services/parser';
import { findMediaFile, getMediaReferencePath, getMediaType } from '../../services/media';
import { blobCache } from '../../services/blobCache';
import { getReactionTimestamp } from '../../services/reactions';
import { highlightText } from '../../services/search';
import { escapeHtml } from '../../services/storage';
import { ReactionModal } from './ReactionModal';

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
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

function getReactionTimeText(ts: number): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function getAudioSourceType(mediaPath: string): string {
  return mediaPath.toLowerCase().endsWith('.mp4') ? 'audio/mp4' : 'audio/mpeg';
}

function LazyMedia({
  mediaPath,
  mediaFile,
  preferredType,
  onMediaClick,
}: {
  mediaPath: string;
  mediaFile: ReturnType<typeof findMediaFile>;
  preferredType?: 'image' | 'video' | 'audio';
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

  // 1. Shared IntersectionObserver for lazy loading
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

  // 2. Shared ResizeObserver for robust scroll anchoring
  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;

    const observer = getSharedLazyMediaResizeObserver();
    lazyMediaResizeCallbacks.set(el, (entry) => {
      const newHeight = entry.borderBoxSize ? entry.borderBoxSize[0].blockSize : entry.contentRect.height;
      
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
            if (scrollDir === 'down') {
              if (elRect.top < containerRect.top) isAboveAnchor = true; // Anchor on top
            } else {
              if (elRect.top < containerRect.bottom) isAboveAnchor = true; // Anchor on bottom
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
  }, []); // Empty dependency array: NEVER unbind, the wrapper is permanent

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
      ? <div className="media-preview" onClick={onMediaClick} role="button" tabIndex={0} style={{ cursor: 'pointer' }}>
          <img src={fileURL} alt="Image" className="preview" />
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
          <audio controls className="media-audio-control">
            <source src={fileURL} type={getAudioSourceType(mediaPath)} />
          </audio>
          {onMediaClick && <button className="media-audio-expand" onClick={onMediaClick} title="Open in viewer">⛶</button>}
        </div>
      : <span className="placeholder audio-placeholder">[ Audio not found ]</span>;
  } else {
    const filename = mediaPath.split('/').pop() || 'File attachment';
    content = fileURL
      ? <div className="media-file-link" onClick={onMediaClick} role="button" tabIndex={0} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '8px 12px', background: 'rgba(0,0,0,0.08)', borderRadius: '8px', textDecoration: 'none', color: 'inherit', fontWeight: '500', margin: '4px 0', fontSize: '14px', border: '1px solid rgba(0,0,0,0.1)', cursor: 'pointer' }}>
          {filename}
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
}: MessageBubbleProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);

  const sender = msg.senderName || msg.sender_name || 'Unknown';
  const rawText = fixEncoding(msg?.text || msg?.content || '').trim();
  const timestamp = getMessageTimestamp(msg) || 0;
  const seenMediaPaths = new Set<string>();
  const mediaItems = [
    ...(msg.photos || []).map(media => ({ media, preferredType: 'image' as const })),
    ...(msg.videos || []).map(media => ({ media, preferredType: 'video' as const })),
    ...(msg.audio || []).map(media => ({ media, preferredType: 'audio' as const })),
    ...(msg.audio_files || []).map(media => ({ media, preferredType: 'audio' as const })),
    ...(msg.gifs || []).map(media => ({ media, preferredType: 'image' as const })),
    ...(msg.files || []).map(media => ({ media, preferredType: undefined })),
    ...(msg.media || []).map(media => ({ media, preferredType: undefined })),
  ].filter(({ media }) => {
    const mediaPath = getMediaReferencePath(media).toLowerCase();
    if (!mediaPath || seenMediaPaths.has(mediaPath)) return false;
    seenMediaPaths.add(mediaPath);
    return true;
  });

  const highlightedText = highlightQuery
    ? highlightText(rawText, highlightQuery)
    : escapeHtml(rawText);

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
        className={`message ${isMe ? 'from-me' : 'from-them'} ${isFirstInClump ? 'clump-first' : ''} ${isLastInClump ? 'clump-last' : ''} ${hasReactions ? 'has-reactions' : ''}`}
        data-msg-index={msgIndex}
      >
        <div className="message-content">
        {msg.is_unsent ? (
          <span className="msg-unsent">Message unsent</span>
        ) : (
          <>
            {rawText && (
              <span dangerouslySetInnerHTML={{ __html: highlightedText }} />
            )}

            {/* Media */}
            {mediaItems.map(({ media, preferredType }, i) => {
              const mediaPath = getMediaReferencePath(media);
              const mediaFile = findMediaFile(mediaState, mediaPath);
              return (
                <LazyMedia
                  key={i}
                  mediaPath={mediaPath}
                  mediaFile={mediaFile}
                  preferredType={preferredType}
                  onMediaClick={onMediaClick ? () => onMediaClick(mediaPath, msgIndex) : undefined}
                />
              );
            })}

            {/* Reactions (Floating Bubble) */}
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
            
            {/* Expanded Reaction Modal */}
            {isModalOpen && msg.reactions && (
              <ReactionModal 
                reactions={msg.reactions} 
                onClose={() => setIsModalOpen(false)} 
              />
            )}
          </>
        )}

        {/* Timestamp (shown on hover via CSS) */}
        <div className="msg-timestamp">
          {timestamp ? formatTimestamp(timestamp) : ''}
        </div>
      </div>
    </div>
    </div>
  );
});
