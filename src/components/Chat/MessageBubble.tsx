import React, { memo, useState, useEffect, useRef } from 'react';
import type { MessengerMessage, MediaState } from '../../types/messenger';
import { getMessageTimestamp, fixEncoding } from '../../services/parser';
import { findMediaFile, getMessageMediaItems, getMediaReferencePath, getMediaType } from '../../services/media';
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
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

function getReactionTimeText(ts: number): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function LazyMedia({ mediaPath, mediaFile }: { mediaPath: string, mediaFile: ReturnType<typeof findMediaFile> }) {
  const [fileURL, setFileURL] = useState<string | null>(mediaFile?.url || null);
  const containerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let isMounted = true;
    if (!mediaFile || mediaFile.url || !mediaFile.handle) return;
    
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        observer.disconnect();
        mediaFile.handle.getFile().then(file => {
          const url = URL.createObjectURL(file);
          mediaFile.url = url; // Cache it on the mediaFile object globally
          if (isMounted) setFileURL(url);
        }).catch(console.error);
      }
    }, { rootMargin: '500px' });

    observer.observe(el);

    return () => { 
      isMounted = false; 
      observer.disconnect();
    };
  }, [mediaFile]);

  const ext = mediaPath.split('.').pop()?.toLowerCase() || '';
  const mediaType = ext === 'mp4' || ext === 'webm' ? 'video' : (mediaFile?.type || getMediaType(mediaPath));

  const handleMediaLoad = (e: React.SyntheticEvent<HTMLElement>) => {
    const container = e.currentTarget.closest('#chat');
    if (container) {
      const mediaHeight = (e.currentTarget as HTMLElement).offsetHeight || 0;
      // If we are within the media height + 200px of the bottom, stick to bottom on media load
      const isAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + mediaHeight + 200;
      if (isAtBottom) {
        container.scrollTop = container.scrollHeight;
      }
    }
  };

  if (mediaType === 'image') {
    return fileURL
      ? <a href={fileURL} target="_blank" rel="noreferrer" className="media-preview">
          <img src={fileURL} alt="Image" className="preview" loading="lazy" onLoad={handleMediaLoad} />
        </a>
      : <span ref={containerRef} className="placeholder">[ Image not found ]</span>;
  }
  if (mediaType === 'video') {
    return fileURL
      ? <a href={fileURL} target="_blank" rel="noreferrer" className="media-preview">
          <video controls className="preview-video" onLoadedData={handleMediaLoad}>
            <source src={fileURL} type="video/mp4" />
          </video>
        </a>
      : <span ref={containerRef} className="placeholder">[ Video not found ]</span>;
  }
  if (mediaType === 'audio') {
    return fileURL
      ? <audio controls>
          <source src={fileURL} type="audio/mpeg" />
        </audio>
      : <span ref={containerRef} className="placeholder">[ Audio not found ]</span>;
  }
  
  const filename = mediaPath.split('/').pop() || 'File attachment';
  return fileURL
    ? <a href={fileURL} target="_blank" rel="noreferrer" className="media-file-link" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '8px 12px', background: 'rgba(0,0,0,0.08)', borderRadius: '8px', textDecoration: 'none', color: 'inherit', fontWeight: '500', margin: '4px 0', fontSize: '14px', border: '1px solid rgba(0,0,0,0.1)' }}>
        {filename}
      </a>
    : <span ref={containerRef} className="placeholder" style={{ width: 'auto', padding: '8px 12px' }}>[ File not found ]</span>;
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
              return <LazyMedia key={i} mediaPath={mediaPath} mediaFile={mediaFile} />;
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
