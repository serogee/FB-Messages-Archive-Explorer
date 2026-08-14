import React, { memo, useState, useEffect, useRef } from 'react';
import type { MessengerMessage, MediaState } from '../../types/messenger';
import { getMessageTimestamp, fixEncoding } from '../../services/parser';
import { findMediaFile, getMessageMediaItems, getMediaReferencePath, getMediaType } from '../../services/media';
import { blobCache } from '../../services/blobCache';
import { getReactionTimestamp } from '../../services/reactions';
import { highlightText } from '../../services/search';
import { escapeHtml } from '../../services/storage';
import { ReactionModal } from './ReactionModal';

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

function LazyMedia({ mediaPath, mediaFile, onMediaClick }: { mediaPath: string, mediaFile: ReturnType<typeof findMediaFile>, onMediaClick?: () => void }) {
  const [fileURL, setFileURL] = useState<string | null>(() => {
    if (!mediaFile) return null;
    return blobCache.get(mediaFile) || mediaFile.url || null;
  });
  const mediaRef = useRef<HTMLElement | null>(null);
  const prevHeight = useRef<number | null>(null);

  // 1. Intersection Observer for lazy loading
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

    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        observer.disconnect();
        blobCache.getOrCreate(mediaFile).then(url => {
          if (isMounted && url) setFileURL(url);
        });
      }
    }, { rootMargin: '500px' });

    observer.observe(el);

    return () => { 
      isMounted = false; 
      observer.disconnect();
    };
  }, [mediaFile, fileURL]);

  // 2. Resize Observer for robust scroll anchoring
  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const newHeight = entry.borderBoxSize ? entry.borderBoxSize[0].blockSize : entry.contentRect.height;
      
      const oldHeight = prevHeight.current;
      if (oldHeight !== null && oldHeight !== newHeight) {
        const delta = newHeight - oldHeight;
        const container = el.closest('#chat') as HTMLElement;
        
        if (container) {
          const scrollDir = container.dataset.scrollDir || 'up';
          const containerRect = container.getBoundingClientRect();
          const elRect = el.getBoundingClientRect();
          
          const isAtBottom = Math.abs(container.scrollHeight - container.scrollTop - container.clientHeight) < 10;

          let isAboveAnchor = false;
          if (isAtBottom) {
            isAboveAnchor = true; // Always adjust to stay stuck to bottom
          } else if (scrollDir === 'down') {
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
      prevHeight.current = newHeight;
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []); // Empty dependency array: NEVER unbind, the wrapper is permanent

  const ext = mediaPath.split('.').pop()?.toLowerCase() || '';
  const mediaType = ext === 'mp4' || ext === 'webm' ? 'video' : (mediaFile?.type || getMediaType(mediaPath));

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
          <audio controls>
            <source src={fileURL} type="audio/mpeg" />
          </audio>
          {onMediaClick && <button className="media-audio-expand" onClick={onMediaClick} title="Open in viewer">⛶</button>}
        </div>
      : <span className="placeholder">[ Audio not found ]</span>;
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
  const mediaItems = getMessageMediaItems(msg);

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
            {mediaItems.map((media, i) => {
              const mediaPath = getMediaReferencePath(media);
              const mediaFile = findMediaFile(mediaState, mediaPath);
              return <LazyMedia key={i} mediaPath={mediaPath} mediaFile={mediaFile} onMediaClick={onMediaClick ? () => onMediaClick(mediaPath, msgIndex) : undefined} />;
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
