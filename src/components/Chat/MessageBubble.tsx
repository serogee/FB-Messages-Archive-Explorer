import React, { memo } from 'react';
import type { MessengerMessage, MediaState } from '../../types/messenger';
import { getMessageTimestamp, fixEncoding } from '../../services/parser';
import { findMediaFile, getMessageMediaItems, getMediaReferencePath, getMediaType } from '../../services/media';
import { getReactionTimestamp } from '../../services/reactions';
import { highlightText } from '../../services/search';
import { escapeHtml } from '../../services/storage';

interface MessageBubbleProps {
  msg: MessengerMessage;
  isMe: boolean;
  showMyName: boolean;
  showTheirName: boolean;
  showReactions: boolean;
  mediaState: MediaState;
  highlightQuery: string;
  msgIndex: number;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

function getReactionTimeText(ts: number): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
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
}: MessageBubbleProps) {
  const sender = msg.senderName || msg.sender_name || 'Unknown';
  const rawText = fixEncoding(msg?.text || msg?.content || '').trim();
  const timestamp = getMessageTimestamp(msg) || 0;
  const mediaItems = getMessageMediaItems(msg);

  const highlightedText = highlightQuery
    ? highlightText(rawText, highlightQuery)
    : escapeHtml(rawText);

  const showName = isMe ? showMyName : showTheirName;

  return (
    <div
      className={`message ${isMe ? 'from-me' : 'from-them'}`}
      data-msg-index={msgIndex}
    >
      {showName && (
        <div className="sender-name">{sender}</div>
      )}
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
              const fileURL = mediaFile?.url || null;
              const ext = mediaPath.split('.').pop()?.toLowerCase() || '';
              const mediaType = ext === 'mp4' || ext === 'webm' ? 'video' : (mediaFile?.type || getMediaType(mediaPath));

              const handleMediaLoad = (e: React.SyntheticEvent<HTMLElement>) => {
                const container = e.currentTarget.closest('#chat');
                if (container) {
                  // If we are within 200px of the bottom, stick to bottom on media load
                  const isAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 200;
                  if (isAtBottom) {
                    container.scrollTop = container.scrollHeight;
                  }
                }
              };

              if (mediaType === 'image') {
                return fileURL
                  ? <a key={i} href={fileURL} target="_blank" rel="noreferrer" className="media-preview">
                      <img src={fileURL} alt="Image" className="preview" loading="lazy" onLoad={handleMediaLoad} />
                    </a>
                  : <span key={i} className="placeholder">[ Image not found ]</span>;
              }
              if (mediaType === 'video') {
                return fileURL
                  ? <a key={i} href={fileURL} target="_blank" rel="noreferrer" className="media-preview">
                      <video controls className="preview-video" onLoadedData={handleMediaLoad}>
                        <source src={fileURL} type="video/mp4" />
                      </video>
                    </a>
                  : <span key={i} className="placeholder">[ Video not found ]</span>;
              }
              if (mediaType === 'audio') {
                return fileURL
                  ? <audio key={i} controls>
                      <source src={fileURL} type="audio/mpeg" />
                    </audio>
                  : <span key={i} className="placeholder">[ Audio not found ]</span>;
              }
              return null;
            })}

            {/* Reactions */}
            {showReactions && msg.reactions && msg.reactions.length > 0 && (
              <div className="reaction">
                {msg.reactions.map((r, i) => {
                  const reactionTs = getReactionTimestamp(r);
                  const timeText = getReactionTimeText(reactionTs);
                  return (
                    <React.Fragment key={i}>
                      {i > 0 && ', '}
                      <span
                        className="reaction-item"
                        data-reaction-time={timeText || undefined}
                        title={timeText || undefined}
                      >
                        {r.actor}: {r.reaction}
                      </span>
                    </React.Fragment>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* Timestamp (shown on hover via CSS) */}
        <div className="msg-timestamp">
          {timestamp ? formatTimestamp(timestamp) : ''}
        </div>
      </div>
    </div>
  );
});
