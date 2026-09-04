import React, { useRef, useImperativeHandle, forwardRef, useCallback } from 'react';
import type { MediaEntry, MessengerThread, MediaState } from '../../types/messenger';
import type { Settings } from '../../hooks/useSettings';
import { isReactionNoticeMessage } from '../../services/reactions';
import { getMessageTimestamp } from '../../services/parser';
import { getMediaReferencePath, getMediaType, getMessageMediaItems, resolveMessageMediaItems } from '../../services/media';
import { scanMediaDimensions } from '../../services/mediaDimensions';
import { chunkArray } from '../../services/storage';
import { resolveMessageJumpTarget } from '../../services/messageJump';
import { MessageBubble } from './MessageBubble';
import { shouldCompensateHeightChange } from './chatScrollAnchoring';

const CHUNK_SIZE = 50;
const CHUNK_ESTIMATED_MESSAGE_HEIGHT = 58;
const CHUNK_ESTIMATED_MEDIA_HEIGHT = 150;
const CHUNK_ESTIMATED_SEPARATOR_HEIGHT = 34;
const CHUNK_PRELOAD_MARGIN_PX = 2_000;
const CHUNK_DIMENSION_PREFLIGHT_BUDGET_MS = 50;
const TIME_GAP_MS = 10 * 60 * 1000;
const JUMP_HIGHLIGHT_SCROLL_THRESHOLD = 24;
const JUMP_SETTLING_MS = 1_500;
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

type Messages = MessengerThread['messages'];

interface MessageListProps {
  chatData: MessengerThread | null;
  mediaState: MediaState;
  selectedPerspective: string;
  settings: Settings;
  highlightQuery: string;
  onScrollSync: () => void;
  onMediaClick?: (mediaPath: string, msgIndex: number) => void;
  onLinkClick?: (url: string, msgIndex: number) => void;
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
    const mediaItems = getMessageMediaItems(msg);
    let previewCount = 0;
    let otherCount = 0;
    mediaItems.forEach(item => {
      const mediaType = getMediaType(getMediaReferencePath(item));
      if (mediaType === 'image' || mediaType === 'video') previewCount++;
      else otherCount++;
    });
    // Preview media renders in two columns, so estimate its rows instead of
    // charging a complete row for every item. Keep non-preview media unchanged.
    mediaCount += (previewCount > 1 ? Math.ceil(previewCount / 2) : previewCount) + otherCount;
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

function getChunksAndHeights(chatData: MessengerThread) {
  const chunks = chunkArray(chatData.messages, CHUNK_SIZE);
  if (!chatData._chunkHeights || chatData._chunkHeights.length !== chunks.length) {
    chatData._chunkHeights = chunks.map((chunk, i) => estimateChunkHeight(chunk, i, chatData.messages));
  }
  return { chunks, chunkHeights: chatData._chunkHeights };
}

function formatSeparatorDate(ts: number): string {
  return new Date(ts).toLocaleString([], {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function getChunkDimensionEntries(messages: Messages, mediaState: MediaState): MediaEntry[] {
  const entries = new Set<MediaEntry>();
  for (const message of messages) {
    const previewItems = resolveMessageMediaItems(message, mediaState)
      .filter(item => item.mediaType === 'image' || item.mediaType === 'video');
    if (previewItems.length !== 1) continue;
    const item = previewItems[0];
    if (item.mediaType === 'image' && !item.isSticker && item.mediaFile) entries.add(item.mediaFile);
  }
  return [...entries];
}

async function waitForDimensionPreflight(entries: readonly MediaEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const scan = scanMediaDimensions(entries);
  let timeout: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    scan,
    new Promise<void>(resolve => {
      timeout = setTimeout(resolve, CHUNK_DIMENSION_PREFLIGHT_BUDGET_MS);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
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
  onLinkClick?: (url: string, msgIndex: number) => void;
  forceRender?: boolean;
  onRendered: (chunkIndex: number) => void;
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
  onLinkClick,
  forceRender,
  onRendered,
}: MessageChunkProps) {
  const chunkRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = React.useState(false);
  const preparationRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);
  const shouldRender = rendered;

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const prepareAndRender = React.useCallback((): Promise<void> => {
    if (rendered) return Promise.resolve();
    if (preparationRef.current) return preparationRef.current;
    const preparation = waitForDimensionPreflight(getChunkDimensionEntries(messages, mediaState))
      .then(() => {
        if (mountedRef.current) setRendered(true);
      });
    preparationRef.current = preparation;
    return preparation;
  }, [mediaState, messages, rendered]);

  React.useEffect(() => {
    if (forceRender) void prepareAndRender();
  }, [forceRender, prepareAndRender]);

  React.useEffect(() => {
    const el = chunkRef.current;
    const container = chatContainerRef.current;
    if (!el || !container || shouldRender) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting && !rendered) void prepareAndRender();
        });
      },
      { root: container, threshold: 0.01, rootMargin: `${CHUNK_PRELOAD_MARGIN_PX}px 0px` }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [rendered, shouldRender, chatContainerRef, prepareAndRender]);

  React.useLayoutEffect(() => {
    if (shouldRender && chunkRef.current && chatContainerRef.current) {
      const actualHeight = chunkRef.current.offsetHeight;
      const delta = actualHeight - estimatedHeight;
      if (delta !== 0) {
        const container = chatContainerRef.current;
        const scrollDir = container.dataset.scrollDir === 'down' ? 'down' : 'up';
        const chunkRect = chunkRef.current.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        
        const isAtBottom = container.dataset.isAtBottom === 'true';
        
        let isAboveAnchor = false;
        if (isAtBottom) {
          container.scrollTop = container.scrollHeight;
          container.dataset.lastScrollTop = String(container.scrollTop);
        } else {
          const jumpAnchorOffset = container.dataset.jumpInProgress === 'true'
            ? Number(container.dataset.jumpAnchorOffset)
            : Number.NaN;
          isAboveAnchor = shouldCompensateHeightChange({
            direction: scrollDir,
            elementTop: chunkRect.top,
            viewportTop: containerRect.top,
            viewportBottom: containerRect.bottom,
            jumpAnchorTop: Number.isFinite(jumpAnchorOffset)
              ? containerRect.top + jumpAnchorOffset
              : undefined,
          });
          if (isAboveAnchor) {
            container.scrollTop += delta;
            container.dataset.lastScrollTop = String(container.scrollTop);
          }
        }
      }
      onRendered(chunkIndex);
    }
  }, [rendered, shouldRender, estimatedHeight, chatContainerRef, chunkIndex, onRendered]);



  if (!shouldRender) {
    return (
      <div
        ref={chunkRef}
        className="message-chunk"
        data-chunk-index={chunkIndex}
        data-start-msg-index={chunkIndex * CHUNK_SIZE}
        data-end-msg-index={Math.min(allMessages.length - 1, (chunkIndex + 1) * CHUNK_SIZE - 1)}
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
        onLinkClick={onLinkClick}
      />
    );
  });

  return (
    <div
      ref={chunkRef}
      className="message-chunk"
      data-chunk-index={chunkIndex}
      data-start-msg-index={chunkIndex * CHUNK_SIZE}
      data-end-msg-index={Math.min(allMessages.length - 1, (chunkIndex + 1) * CHUNK_SIZE - 1)}
    >
      {items}
    </div>
  );
});

const MessageListBase = forwardRef<MessageListHandle, MessageListProps>(function MessageList(
  { chatData, mediaState, selectedPerspective, settings, highlightQuery, onScrollSync, onMediaClick, onLinkClick },
  ref
) {
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jumpSettlingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightedMessageRef = useRef<HTMLElement | null>(null);
  const highlightScrollTopRef = useRef<number | null>(null);
  const jumpRequestIdRef = useRef(0);
  const pendingChunkRenderRef = useRef<{
    chunkIndex: number;
    resolve: (rendered: boolean) => void;
  } | null>(null);
  const [forcedChunkIndex, setForcedChunkIndex] = React.useState<number | null>(null);

  const cancelPendingChunkRender = useCallback(() => {
    const pending = pendingChunkRenderRef.current;
    pendingChunkRenderRef.current = null;
    pending?.resolve(false);
  }, []);

  const renderChunk = useCallback((chunkIndex: number): Promise<boolean> => {
    cancelPendingChunkRender();
    return new Promise(resolve => {
      pendingChunkRenderRef.current = { chunkIndex, resolve };
      setForcedChunkIndex(chunkIndex);
    });
  }, [cancelPendingChunkRender]);

  const handleChunkRendered = useCallback((chunkIndex: number) => {
    const pending = pendingChunkRenderRef.current;
    if (!pending || pending.chunkIndex !== chunkIndex) return;
    pendingChunkRenderRef.current = null;
    pending.resolve(true);
  }, []);

  const clearJumpHighlight = useCallback(() => {
    if (highlightTimerRef.current) {
      clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
    highlightedMessageRef.current?.classList.remove('highlight-target', 'temporary-highlight');
    highlightedMessageRef.current = null;
    highlightScrollTopRef.current = null;
  }, []);

  const clearJumpSettling = useCallback(() => {
    if (jumpSettlingTimerRef.current) {
      clearTimeout(jumpSettlingTimerRef.current);
      jumpSettlingTimerRef.current = null;
    }
    const container = chatContainerRef.current;
    if (!container) return;
    delete container.dataset.jumpInProgress;
    delete container.dataset.jumpAnchorOffset;
  }, []);

  const beginJumpSettling = useCallback((container: HTMLDivElement, anchorOffset: number) => {
    clearJumpSettling();
    container.dataset.jumpInProgress = 'true';
    container.dataset.jumpAnchorOffset = String(anchorOffset);
    jumpSettlingTimerRef.current = setTimeout(() => {
      if (container === chatContainerRef.current) {
        delete container.dataset.jumpInProgress;
        delete container.dataset.jumpAnchorOffset;
      }
      jumpSettlingTimerRef.current = null;
    }, JUMP_SETTLING_MS);
  }, [clearJumpSettling]);

  const handleJumpKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (SCROLL_KEYS.has(event.key)) clearJumpSettling();
  }, [clearJumpSettling]);

  useImperativeHandle(ref, () => ({
    jumpToMessage: async (index: number) => {
      const container = chatContainerRef.current;
      if (!container) return;
      clearJumpHighlight();
      clearJumpSettling();
      const requestId = ++jumpRequestIdRef.current;
      cancelPendingChunkRender();
      const findMessage = () => (
        container.querySelector(`.message[data-msg-index="${index}"]`) as HTMLElement | null
      );
      const chunkIndex = Math.floor(index / CHUNK_SIZE);

      const msgEl = await resolveMessageJumpTarget({
        findMessage,
        isCurrent: () => requestId === jumpRequestIdRef.current && container === chatContainerRef.current,
        renderChunk: () => {
          const chunkEl = container.querySelector(
            `.message-chunk[data-chunk-index="${chunkIndex}"]`
          ) as HTMLElement | null;
          if (!chunkEl) return Promise.resolve(false);
          chunkEl.scrollIntoView({ block: 'start' });
          container.dataset.isAtBottom = 'false';
          container.dataset.lastScrollTop = String(container.scrollTop);
          return renderChunk(chunkIndex);
        },
      });

      if (msgEl) {
        const containerRect = container.getBoundingClientRect();
        const elRect = msgEl.getBoundingClientRect();
        container.scrollTop += elRect.top - containerRect.top - 120;
        container.dataset.lastScrollTop = String(container.scrollTop);
        container.dataset.isAtBottom = String(
          Math.abs(container.scrollHeight - container.scrollTop - container.clientHeight) < 20,
        );

        const landedContainerRect = container.getBoundingClientRect();
        const landedMessageRect = msgEl.getBoundingClientRect();
        beginJumpSettling(container, landedMessageRect.top - landedContainerRect.top);

        msgEl.classList.add('highlight-target', 'temporary-highlight');
        highlightedMessageRef.current = msgEl;
        highlightScrollTopRef.current = container.scrollTop;
        highlightTimerRef.current = setTimeout(() => {
          msgEl.classList.remove('temporary-highlight');
          highlightTimerRef.current = null;
        }, 2200);
      }
    },
    getChatContainer: () => chatContainerRef.current,
    scrollToBottom: () => {
      const container = chatContainerRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    },
  }), [beginJumpSettling, cancelPendingChunkRender, clearJumpHighlight, clearJumpSettling, renderChunk]);

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
      
      const isAtBottom = Math.abs(container.scrollHeight - st - container.clientHeight) < 20;
      container.dataset.isAtBottom = String(isAtBottom);

      const highlightScrollTop = highlightScrollTopRef.current;
      if (
        highlightedMessageRef.current &&
        highlightScrollTop !== null &&
        Math.abs(st - highlightScrollTop) >= JUMP_HIGHLIGHT_SCROLL_THRESHOLD
      ) {
        clearJumpHighlight();
      }
    }
  }, [clearJumpHighlight, onScrollSync]);

  React.useLayoutEffect(() => {
    jumpRequestIdRef.current++;
    cancelPendingChunkRender();
    clearJumpHighlight();
    clearJumpSettling();
    setForcedChunkIndex(null);
    if (chatData && chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
      chatContainerRef.current.dataset.isAtBottom = 'true';
    }
  }, [chatData, cancelPendingChunkRender, clearJumpHighlight, clearJumpSettling]);

  React.useEffect(() => () => {
    jumpRequestIdRef.current++;
    cancelPendingChunkRender();
    clearJumpHighlight();
    clearJumpSettling();
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
  }, [cancelPendingChunkRender, clearJumpHighlight, clearJumpSettling]);

  const { chunks, chunkHeights } = React.useMemo(
    () => chatData ? getChunksAndHeights(chatData) : { chunks: [], chunkHeights: [] },
    [chatData]
  );

  if (!chatData) return null;

  const allMessages = chatData.messages;

  return (
    <div
      id="chat"
      ref={chatContainerRef}
      onScroll={handleScroll}
      onWheel={clearJumpSettling}
      onTouchStart={clearJumpSettling}
      onPointerDown={clearJumpSettling}
      onKeyDown={handleJumpKeyDown}
    >
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
          onLinkClick={onLinkClick}
          forceRender={i === chunks.length - 1 || i === forcedChunkIndex}
          onRendered={handleChunkRendered}
        />
      ))}
    </div>
  );
});

export const MessageList = React.memo(MessageListBase, (prev, next) => {
  return prev.chatData === next.chatData &&
         prev.mediaState === next.mediaState &&
         prev.highlightQuery === next.highlightQuery &&
         prev.selectedPerspective === next.selectedPerspective &&
         prev.settings.showMyName === next.settings.showMyName &&
         prev.settings.showTheirName === next.settings.showTheirName &&
         prev.settings.showReactions === next.settings.showReactions &&
         prev.onMediaClick === next.onMediaClick &&
         prev.onLinkClick === next.onLinkClick;
});
