import React, { useRef, useImperativeHandle, forwardRef, useCallback } from 'react';
import type { MessengerThread, MediaState } from '../../types/messenger';
import type { Settings } from '../../hooks/useSettings';
import { isReactionNoticeMessage } from '../../services/reactions';
import { getMessageTimestamp } from '../../services/parser';
import { getMessageMediaItems } from '../../services/media';
import { chunkArray } from '../../services/storage';
import { MessageBubble } from './MessageBubble';

const CHUNK_SIZE = 50;
const CHUNK_ESTIMATED_MESSAGE_HEIGHT = 58;
const CHUNK_ESTIMATED_MEDIA_HEIGHT = 150;
const CHUNK_ESTIMATED_SEPARATOR_HEIGHT = 34;
const TIME_GAP_MS = 10 * 60 * 1000;

type Messages = MessengerThread['messages'];

interface MessageListProps {
  chatData: MessengerThread | null;
  mediaState: MediaState;
  selectedPerspective: string;
  settings: Settings;
  highlightQuery: string;
  onScrollSync: () => void;
  onMediaClick?: (mediaPath: string, msgIndex: number) => void;
}

export interface MessageListHandle {
  jumpToMessage: (index: number) => Promise<void>;
  getChatContainer: () => HTMLDivElement | null;
  scrollToBottom: () => void;
}

function findPreviousVisibleIndex(messages: Messages, fromIndex: number): number {
  for (let i = fromIndex - 1; i >= 0; i--) {
    if (!isReactionNoticeMessage(messages[i])) return i;
  }
  return -1;
}

function findNextVisibleIndex(messages: Messages, fromIndex: number): number {
  for (let i = fromIndex + 1; i < messages.length; i++) {
    if (!isReactionNoticeMessage(messages[i])) return i;
  }
  return -1;
}

function estimateChunkHeight(messages: Messages, chunkIndex: number, allMessages: Messages): number {
  let visibleCount = 0, mediaCount = 0, separatorCount = 0;
  messages.forEach((msg, localIdx) => {
    if (isReactionNoticeMessage(msg)) return;
    visibleCount++;
    mediaCount += getMessageMediaItems(msg).length;
    const globalIdx = chunkIndex * CHUNK_SIZE + localIdx;
    if (globalIdx === 0) { separatorCount++; return; }
    const prevIdx = findPreviousVisibleIndex(allMessages, globalIdx);
    const prevMsg = prevIdx >= 0 ? allMessages[prevIdx] : null;
    const prevTime = prevMsg ? (getMessageTimestamp(prevMsg) || 0) : 0;
    const currTime = getMessageTimestamp(msg) || 0;
    if (!prevMsg || Math.abs(currTime - prevTime) > TIME_GAP_MS) separatorCount++;
  });
  return Math.max(160,
    visibleCount * CHUNK_ESTIMATED_MESSAGE_HEIGHT +
    mediaCount * CHUNK_ESTIMATED_MEDIA_HEIGHT +
    separatorCount * CHUNK_ESTIMATED_SEPARATOR_HEIGHT
  );
}

function formatSeparatorDate(ts: number): string {
  return new Date(ts).toLocaleString([], {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

interface MessageChunkProps {
  chunkIndex: number;
  messages: Messages;
  allMessages: Messages;
  estimatedHeight: number;
  selectedPerspective: string;
  settings: Settings;
  mediaState: MediaState;
  highlightQuery: string;
  chatContainerRef: React.RefObject<HTMLDivElement | null>;
  onMediaClick?: (mediaPath: string, msgIndex: number) => void;
  forceRender?: boolean;
}

const MessageChunk = React.memo(function MessageChunk({
  chunkIndex,
  messages,
  allMessages,
  estimatedHeight,
  selectedPerspective,
  settings,
  mediaState,
  highlightQuery,
  chatContainerRef,
  onMediaClick,
  forceRender,
}: MessageChunkProps) {
  const chunkRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = React.useState(!!forceRender);

  React.useEffect(() => {
    const el = chunkRef.current;
    const container = chatContainerRef.current;
    if (!el || !container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting && !rendered) {
            setRendered(true);
          }
        });
      },
      { root: container, threshold: 0.01, rootMargin: '200px' }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [rendered, chatContainerRef]);

  React.useLayoutEffect(() => {
    if (rendered && chunkRef.current && chatContainerRef.current) {
      const actualHeight = chunkRef.current.offsetHeight;
      const delta = actualHeight - estimatedHeight;
      if (delta !== 0) {
        const container = chatContainerRef.current;
        const scrollDir = container.dataset.scrollDir || 'up';
        const chunkRect = chunkRef.current.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        
        const isAtBottom = Math.abs(container.scrollHeight - container.scrollTop - container.clientHeight) < 10;
        
        let isAboveAnchor = false;
        if (isAtBottom) {
          isAboveAnchor = true;
        } else if (scrollDir === 'down') {
          if (chunkRect.top < containerRect.top) isAboveAnchor = true;
        } else {
          if (chunkRect.top < containerRect.bottom) isAboveAnchor = true;
        }

        if (isAboveAnchor) {
          container.scrollTop += delta;
          container.dataset.lastScrollTop = String(container.scrollTop);
        }
      }
    }
  }, [rendered, estimatedHeight, chatContainerRef]);



  if (!rendered) {
    return (
      <div
        ref={chunkRef}
        className="message-chunk"
        data-chunk-index={chunkIndex}
        style={{ minHeight: estimatedHeight }}
      />
    );
  }

  const items: React.ReactNode[] = [];
  messages.forEach((msg, localIdx) => {
    if (isReactionNoticeMessage(msg)) return;
    const globalIdx = chunkIndex * CHUNK_SIZE + localIdx;

    let showSeparator = false;
    if (globalIdx === 0) {
      showSeparator = true;
    } else {
      const prevIdx = findPreviousVisibleIndex(allMessages, globalIdx);
      const prevMsg = prevIdx >= 0 ? allMessages[prevIdx] : null;
      const prevTime = prevMsg ? (getMessageTimestamp(prevMsg) || 0) : 0;
      const currTime = getMessageTimestamp(msg) || 0;
      if (!prevMsg || Math.abs(currTime - prevTime) > TIME_GAP_MS) showSeparator = true;
    }

    if (showSeparator) {
      const ts = getMessageTimestamp(msg) || 0;
      items.push(
        <div key={`sep-${globalIdx}`} className="time-separator">
          {ts ? formatSeparatorDate(ts) : ''}
        </div>
      );
    }

    const sender = msg.senderName || msg.sender_name || 'Unknown';
    const isMe = sender === selectedPerspective;

    let isFirstInClump = showSeparator;
    const prevIdx = findPreviousVisibleIndex(allMessages, globalIdx);
    if (prevIdx >= 0 && !showSeparator) {
      const prevMsg = allMessages[prevIdx];
      const prevSender = prevMsg.senderName || prevMsg.sender_name || 'Unknown';
      if (prevSender !== sender) isFirstInClump = true;
    }

    let isLastInClump = true;
    const nextIdx = findNextVisibleIndex(allMessages, globalIdx);
    if (nextIdx >= 0) {
      const nextMsg = allMessages[nextIdx];
      const nextSender = nextMsg.senderName || nextMsg.sender_name || 'Unknown';
      const currTime = getMessageTimestamp(msg) || 0;
      const nextTime = getMessageTimestamp(nextMsg) || 0;
      if (nextSender === sender && Math.abs(nextTime - currTime) <= TIME_GAP_MS) {
        isLastInClump = false;
      }
    }

    items.push(
      <MessageBubble
        key={globalIdx}
        msg={msg}
        isMe={isMe}
        showMyName={settings.showMyName}
        showTheirName={settings.showTheirName}
        showReactions={settings.showReactions}
        mediaState={mediaState}
        highlightQuery={highlightQuery}
        msgIndex={globalIdx}
        isFirstInClump={isFirstInClump}
        isLastInClump={isLastInClump}
        onMediaClick={onMediaClick}
      />
    );
  });

  return (
    <div ref={chunkRef} className="message-chunk" data-chunk-index={chunkIndex}>
      {items}
    </div>
  );
});

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(function MessageList(
  { chatData, mediaState, selectedPerspective, settings, highlightQuery, onScrollSync, onMediaClick },
  ref
) {
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useImperativeHandle(ref, () => ({
    jumpToMessage: async (index: number) => {
      const container = chatContainerRef.current;
      if (!container) return;

      let msgEl = container.querySelector(`.message[data-msg-index="${index}"]`) as HTMLElement | null;

      // If not rendered yet, scroll to chunk to trigger render
      if (!msgEl) {
        const chunkIndex = Math.floor(index / CHUNK_SIZE);
        const chunkEl = container.querySelector(`.message-chunk[data-chunk-index="${chunkIndex}"]`) as HTMLElement | null;
        if (chunkEl) {
          chunkEl.scrollIntoView({ block: 'start' });
        }
        // Wait for IntersectionObserver + useLayoutEffect
        await new Promise<void>(r => setTimeout(r, 80));
        msgEl = container.querySelector(`.message[data-msg-index="${index}"]`) as HTMLElement | null;
      }

      // Scroll exactly to the message
      if (msgEl) {
        const containerRect = container.getBoundingClientRect();
        const elRect = msgEl.getBoundingClientRect();
        container.scrollTop += elRect.top - containerRect.top - 120;

        msgEl.classList.add('highlight-target', 'temporary-highlight');
        setTimeout(() => msgEl.classList.remove('temporary-highlight'), 2200);
      }
    },
    getChatContainer: () => chatContainerRef.current,
    scrollToBottom: () => {
      const container = chatContainerRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    },
  }));

  const handleScroll = useCallback(() => {
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(onScrollSync, 80);

    const container = chatContainerRef.current;
    if (container) {
      const st = container.scrollTop;
      const lastSt = Number(container.dataset.lastScrollTop || st);
      if (st > lastSt) container.dataset.scrollDir = 'down';
      else if (st < lastSt) container.dataset.scrollDir = 'up';
      container.dataset.lastScrollTop = String(st);
    }
  }, [onScrollSync]);

  React.useLayoutEffect(() => {
    if (chatData && chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [chatData]);

  if (!chatData) return null;

  const allMessages = chatData.messages;
  const chunks = chunkArray(allMessages, CHUNK_SIZE);
  const chunkHeights = chunks.map((chunk, i) => estimateChunkHeight(chunk, i, allMessages));

  return (
    <div id="chat" ref={chatContainerRef} onScroll={handleScroll}>
      {chunks.map((chunk, i) => (
        <MessageChunk
          key={i}
          chunkIndex={i}
          messages={chunk}
          allMessages={allMessages}
          estimatedHeight={chunkHeights[i]}
          selectedPerspective={selectedPerspective}
          settings={settings}
          mediaState={mediaState}
          highlightQuery={highlightQuery}
          chatContainerRef={chatContainerRef}
          onMediaClick={onMediaClick}
          forceRender={i === chunks.length - 1}
        />
      ))}
    </div>
  );
});
