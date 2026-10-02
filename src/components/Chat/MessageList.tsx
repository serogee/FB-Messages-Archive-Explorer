import React, { useRef, useImperativeHandle, forwardRef, useCallback } from 'react';
import type { MediaEntry, MessengerThread, MediaState } from '../../types/messenger';
import type { Settings } from '../../hooks/useSettings';
import { isReactionNoticeMessage } from '../../services/reactions';
import { useReactionContext } from '../../hooks/useReactionFeature';
import { useThreadData } from '../../hooks/useThreadData';
import { getMessageTimestamp } from '../../services/parser';
import { getMediaReferencePath, getMediaType, getMessageMediaItems, resolveMessageMediaItems } from '../../services/media';
import { scanMediaDimensions } from '../../services/mediaDimensions';
import { chunkArray } from '../../services/storage';
import { resolveMessageJumpTarget } from '../../services/messageJump';
import { getVisibleMessageNeighbors } from '../../services/messageVisibility';
import { MessageBubble } from './MessageBubble';
import { ReactionVisibilityAnchor } from './ReactionVisibilityAnchor';
import {
  captureChatScrollAnchor,
  hasPendingMediaBeforeJumpTarget,
  prepareChatScrollAnchorForJump,
  recordChatScroll,
  resetChatScrollAnchor,
  stabilizeChatScrollAnchor,
} from './chatScrollAnchoring';

const CHUNK_SIZE = 50;
const CHUNKS_PER_RENDER_GROUP = 40;
const CHUNK_ESTIMATED_MESSAGE_HEIGHT = 58;
const CHUNK_ESTIMATED_MEDIA_HEIGHT = 150;
const CHUNK_ESTIMATED_SEPARATOR_HEIGHT = 34;
const CHUNK_PRELOAD_MARGIN_PX = 2_000;
const TIME_GAP_MS = 10 * 60 * 1000;
const JUMP_HIGHLIGHT_SCROLL_THRESHOLD = 24;
const JUMP_SETTLING_CHECK_MS = 250;
const JUMP_SETTLING_QUIET_MS = 350;
const JUMP_SETTLING_MAX_MS = 8_000;
const CHAT_OPENING_CHECK_MS = 50;
const CHAT_OPENING_QUIET_MS = 150;
const CHAT_OPENING_MAX_MS = 8_000;
const CHAT_OPENING_MEDIA_MARGIN_PX = 2_000;
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

type Messages = MessengerThread['messages'];

// Keep thread-sized arrays in one context. Passing them to every chunk also
// makes React's development performance tracks inspect the whole history for
// each chunk when a visibility setting changes.
const ChunkMessageContext = React.createContext<{
  allMessages: Messages;
  chunks: Messages[];
  visibility: Uint8Array;
  neighbors: ReturnType<typeof getVisibleMessageNeighbors>;
} | null>(null);

interface MessageListProps {
  chatData?: MessengerThread | null;
  mediaState: MediaState;
  selectedPerspective: string;
  settings: Settings;
  highlightQuery: string;
  onScrollSync: () => void;
  onMediaClick?: (mediaPath: string, msgIndex: number) => void;
  onLinkClick?: (url: string, msgIndex: number) => void;
  onHiddenCountChange?: (count: number) => void;
}

export interface MessageListHandle {
  jumpToMessage: (index: number) => Promise<void>;
  getChatContainer: () => HTMLDivElement | null;
  scrollToBottom: () => void;
}

function estimateChunkHeight(messages: Messages, chunkIndex: number, allMessages: Messages, visibility: Uint8Array, previous: Int32Array): number {
  let visibleCount = 0, mediaCount = 0, separatorCount = 0;
  messages.forEach((msg, localIdx) => {
    if (visibility[chunkIndex * CHUNK_SIZE + localIdx]) return;
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
    const prevIdx = previous[globalIdx];
    const prevMsg = prevIdx >= 0 ? allMessages[prevIdx] : null;
    const prevTime = prevMsg ? (getMessageTimestamp(prevMsg) || 0) : 0;
    const currTime = getMessageTimestamp(msg) || 0;
    if (!prevMsg || Math.abs(currTime - prevTime) > TIME_GAP_MS) separatorCount++;
  });
  if (visibleCount === 0) return 0;
  return Math.max(160,
    visibleCount * CHUNK_ESTIMATED_MESSAGE_HEIGHT +
    mediaCount * CHUNK_ESTIMATED_MEDIA_HEIGHT +
    separatorCount * CHUNK_ESTIMATED_SEPARATOR_HEIGHT
  );
}

function formatSeparatorDate(ts: number): string {
  const date = new Date(ts);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const messageDay = new Date(ts);
  messageDay.setHours(0, 0, 0, 0);
  if (messageDay.getTime() === today.getTime()) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (messageDay.getTime() === yesterday.getTime()) {
    return `Yesterday, ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  return date.toLocaleString([], {
    weekday: 'short', month: 'short', day: 'numeric',
    ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
    hour: 'numeric', minute: '2-digit'
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

async function waitForDimensionPreflight(entries: readonly MediaEntry[], priority: number): Promise<void> {
  if (entries.length === 0) return;
  await scanMediaDimensions(entries, priority);
}

interface ChunkViewData {
  selectedPerspective: string;
  settings: Settings;
  mediaState: MediaState;
  highlightQuery: string;
  chatContainerRef: React.RefObject<HTMLDivElement | null>;
  onMediaClick?: (mediaPath: string, msgIndex: number) => void;
  onLinkClick?: (url: string, msgIndex: number) => void;
  onRendered: (chunkIndex: number) => void;
  onHeightMeasured: (chunkIndex: number, height: number) => void;
  getChunkHeight: (chunkIndex: number) => number;
  lastVisibleChunk: number;
  forcedChunkIndex: number | null;
}

const ChunkViewContext = React.createContext<ChunkViewData | null>(null);

interface MessageChunkProps {
  chunkIndex: number;
  estimatedHeight: number;
  forceRender: boolean;
  dimensionPriority: number;
}

const MessageChunk = React.memo(function MessageChunk({
  chunkIndex,
  estimatedHeight,
  forceRender,
  dimensionPriority,
}: MessageChunkProps) {
  const {
    selectedPerspective,
    settings,
    mediaState,
    highlightQuery,
    chatContainerRef,
    onMediaClick,
    onLinkClick,
    onRendered,
    onHeightMeasured,
  } = React.useContext(ChunkViewContext)!;
  const { allMessages, chunks, visibility, neighbors } = React.useContext(ChunkMessageContext)!;
  const messages = chunks[chunkIndex];
  const chunkRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = React.useState(false);
  const preparationRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);
  const nearbyRef = useRef(false);
  const forcedRef = useRef(forceRender);
  forcedRef.current = forceRender;
  const measuredRef = useRef<{ visibility: Uint8Array; height: number } | null>(null);
  const shouldRender = rendered;

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const prepareAndRender = React.useCallback((priority = dimensionPriority): Promise<void> => {
    if (rendered) return Promise.resolve();
    // Resolve media only for nearby or explicitly requested chunks.
    const dimensionEntries = getChunkDimensionEntries(messages, mediaState);
    if (preparationRef.current) {
      // A visible or jump-target chunk can promote reads that started as preload work.
      void scanMediaDimensions(dimensionEntries, priority);
      return preparationRef.current;
    }
    const preparation = waitForDimensionPreflight(dimensionEntries, priority)
      .then(() => {
        if (mountedRef.current && (nearbyRef.current || forcedRef.current)) {
          const container = chatContainerRef.current;
          // The chunk itself is about to change height, so it is only an
          // exclusion boundary; anchoring chooses stable content in the viewport.
          if (container) captureChatScrollAnchor(container, false, chunkRef.current);
          setRendered(true);
        }
      }).finally(() => { preparationRef.current = null; });
    preparationRef.current = preparation;
    return preparation;
  }, [chatContainerRef, messages, mediaState, dimensionPriority, rendered]);

  React.useEffect(() => {
    if (forceRender) void prepareAndRender();
  }, [forceRender, prepareAndRender]);

  React.useEffect(() => {
    const el = chunkRef.current;
    const container = chatContainerRef.current;
    if (!el || !container) return;

    const preloadObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          nearbyRef.current = entry.isIntersecting;
          if (entry.isIntersecting) void prepareAndRender();
          else if (!forcedRef.current && rendered) {
            // Keep its measured space while releasing message DOM outside the
            // preload margin. Visited chunks must not accumulate forever.
            measuredRef.current = { visibility, height: el.offsetHeight };
            setRendered(false);
          }
        });
      },
      { root: container, threshold: 0.01, rootMargin: `${CHUNK_PRELOAD_MARGIN_PX}px 0px` }
    );
    const visibleObserver = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting && !rendered) void prepareAndRender(0);
        });
      },
      { root: container, threshold: 0.01 },
    );

    preloadObserver.observe(el);
    visibleObserver.observe(el);
    return () => {
      preloadObserver.disconnect();
      visibleObserver.disconnect();
    };
  }, [rendered, chatContainerRef, prepareAndRender, visibility, forceRender]);

  React.useLayoutEffect(() => {
    if (shouldRender && chunkRef.current && chatContainerRef.current) {
      const actualHeight = chunkRef.current.offsetHeight;
      measuredRef.current = { visibility, height: actualHeight };
      const container = chatContainerRef.current;
      onHeightMeasured(chunkIndex, actualHeight);
      stabilizeChatScrollAnchor(container);
      onRendered(chunkIndex);
    }
  }, [rendered, shouldRender, visibility, chatContainerRef, chunkIndex, onHeightMeasured, onRendered]);

  React.useEffect(() => {
    const element = chunkRef.current;
    if (!rendered || !element) return;
    const observer = new ResizeObserver(() => {
      measuredRef.current = { visibility, height: element.offsetHeight };
      onHeightMeasured(chunkIndex, element.offsetHeight);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [rendered, visibility, chunkIndex, onHeightMeasured]);
  if (!shouldRender) {
    return (
      <div
        ref={chunkRef}
        className="message-chunk"
        data-chunk-index={chunkIndex}
        data-start-msg-index={chunkIndex * CHUNK_SIZE}
        data-end-msg-index={Math.min(allMessages.length - 1, (chunkIndex + 1) * CHUNK_SIZE - 1)}
        data-rendered="false"
        style={{ minHeight: measuredRef.current?.visibility === visibility ? measuredRef.current.height : estimatedHeight }}
      />
    );
  }

  const items: React.ReactNode[] = [];
  messages.forEach((msg, localIdx) => {
    if (visibility[chunkIndex * CHUNK_SIZE + localIdx]) return;
    const globalIdx = chunkIndex * CHUNK_SIZE + localIdx;

    let showSeparator = false;
    if (globalIdx === 0) {
      showSeparator = true;
    } else {
      const prevIdx = neighbors.previous[globalIdx];
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
    const prevIdx = neighbors.previous[globalIdx];
    if (prevIdx >= 0 && !showSeparator) {
      const prevMsg = allMessages[prevIdx];
      const prevSender = prevMsg.senderName || prevMsg.sender_name || 'Unknown';
      if (prevSender !== sender) isFirstInClump = true;
    }

    let isLastInClump = true;
    const nextIdx = neighbors.next[globalIdx];
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
      data-rendered="true"
    >
      {items}
    </div>
  );
});

// React can yield between groups. Building every placeholder and estimating
// every message inside MessageList's render would block even in a transition.
const MessageChunkGroup = React.memo(function MessageChunkGroup({ start }: { start: number }) {
  const { chunks } = React.useContext(ChunkMessageContext)!;
  const { getChunkHeight, lastVisibleChunk, forcedChunkIndex } = React.useContext(ChunkViewContext)!;
  const items = [];
  for (let i = start; i < Math.min(chunks.length, start + CHUNKS_PER_RENDER_GROUP); i++) {
    const height = getChunkHeight(i);
    if (height === 0) continue;
    const forced = i === lastVisibleChunk || i === forcedChunkIndex;
    items.push(<MessageChunk key={i} chunkIndex={i} estimatedHeight={height} forceRender={forced} dimensionPriority={forced ? 0 : 1} />);
  }
  return <>{items}</>;
});

const MessageListBase = forwardRef<MessageListHandle, MessageListProps>(function MessageList(
  { chatData: providedThread, mediaState, selectedPerspective, settings, highlightQuery, onScrollSync, onMediaClick, onLinkClick, onHiddenCountChange },
  ref
) {
  const chatData = useThreadData(providedThread);
  const reactionFeature = useReactionContext();
  const [revealed, setRevealed] = React.useState<{ data: MessengerThread | null; hide: boolean; indices: Set<number> }>({ data: null, hide: false, indices: new Set() });
  const visibility = React.useMemo(() => {
    const messages = chatData?.messages || [];
    const result = new Uint8Array(messages.length);
    if (!reactionFeature.hide) return result;
    const exceptions = revealed.data === chatData && revealed.hide === reactionFeature.hide ? revealed.indices : null;
    for (let index = 0; index < messages.length; index++) {
      if (!exceptions?.has(index) && isReactionNoticeMessage(messages[index])) result[index] = 1;
    }
    return result;
  }, [chatData, reactionFeature.hide, revealed]);
  const neighbors = React.useMemo(() => getVisibleMessageNeighbors(visibility), [visibility]);
  // A fresh token for each loaded thread keeps snapshot comparisons cheap.
  const threadIdentity = React.useMemo(() => ({ threadPath: chatData?.thread_path }), [chatData]);
  const getVisibility = useCallback(() => visibility, [visibility]);
  const chunks = React.useMemo(() => chatData ? chunkArray(chatData.messages, CHUNK_SIZE) : [], [chatData]);
  const chunkMessageData = React.useMemo(() => ({ allMessages: chatData?.messages || [], chunks, visibility, neighbors }), [chatData, chunks, visibility, neighbors]);
  React.useEffect(() => {
    onHiddenCountChange?.(visibility.reduce((sum, value) => sum + value, 0));
  }, [visibility, onHiddenCountChange]);
  React.useEffect(() => {
    setRevealed(prev => prev.indices.size > 0 && (prev.data !== chatData || prev.hide !== reactionFeature.hide) ? { data: chatData, hide: reactionFeature.hide, indices: new Set() } : prev);
  }, [chatData, reactionFeature.hide]);
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
  const [readyChat, setReadyChat] = React.useState<MessengerThread | null>(null);

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
    const wasSettling = container.dataset.jumpInProgress === 'true';
    delete container.dataset.jumpInProgress;
    delete container.dataset.jumpAnchorOffset;
    delete container.dataset.jumpTargetIndex;
    if (wasSettling) resetChatScrollAnchor(container);
  }, []);

  const beginJumpSettling = useCallback((container: HTMLDivElement, targetIndex: number, anchorOffset: number) => {
    clearJumpSettling();
    container.dataset.jumpInProgress = 'true';
    container.dataset.jumpAnchorOffset = String(anchorOffset);
    container.dataset.jumpTargetIndex = String(targetIndex);
    resetChatScrollAnchor(container);
    const deadline = Date.now() + JUMP_SETTLING_MAX_MS;

    const checkSettling = () => {
      if (container !== chatContainerRef.current || container.dataset.jumpInProgress !== 'true') {
        jumpSettlingTimerRef.current = null;
        return;
      }
      if (hasPendingMediaBeforeJumpTarget(container) && Date.now() < deadline) {
        jumpSettlingTimerRef.current = setTimeout(checkSettling, JUMP_SETTLING_CHECK_MS);
        return;
      }
      delete container.dataset.jumpInProgress;
      delete container.dataset.jumpAnchorOffset;
      delete container.dataset.jumpTargetIndex;
      resetChatScrollAnchor(container);
      jumpSettlingTimerRef.current = null;
    };

    jumpSettlingTimerRef.current = setTimeout(checkSettling, JUMP_SETTLING_QUIET_MS);
  }, [clearJumpSettling]);

  const handleJumpKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (SCROLL_KEYS.has(event.key)) clearJumpSettling();
  }, [clearJumpSettling]);

  useImperativeHandle(ref, () => ({
    jumpToMessage: async (index: number) => {
      const container = chatContainerRef.current;
      if (!container) return;
      if (chatData) setReadyChat(chatData);
      clearJumpHighlight();
      clearJumpSettling();
      const requestId = ++jumpRequestIdRef.current;
      cancelPendingChunkRender();
      const findMessage = () => (
        container.querySelector(`.message[data-msg-index="${index}"]`) as HTMLElement | null
      );
      const isCurrent = () => (
        requestId === jumpRequestIdRef.current && container === chatContainerRef.current
      );
      const chunkIndex = Math.floor(index / CHUNK_SIZE);
      if (visibility[index] && chatData) {
        setRevealed(prev => ({ data: chatData, hide: reactionFeature.hide, indices: new Set([...(prev.data === chatData && prev.hide === reactionFeature.hide ? prev.indices : []), index]) }));
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        if (!isCurrent()) return;
      }
      const dimensionEntries = chatData
        ? getChunkDimensionEntries(
            chatData.messages.slice(chunkIndex * CHUNK_SIZE, (chunkIndex + 1) * CHUNK_SIZE),
            mediaState,
          )
        : [];
      if (dimensionEntries.length > 0) {
        await scanMediaDimensions(dimensionEntries, 0);
        if (!isCurrent()) return;
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        if (!isCurrent()) return;
      }
      prepareChatScrollAnchorForJump(container);

      const msgEl = await resolveMessageJumpTarget({
        findMessage,
        isCurrent,
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
        beginJumpSettling(container, index, landedMessageRect.top - landedContainerRect.top);

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
        if (chatData) setReadyChat(chatData);
        clearJumpSettling();
        container.dataset.isAtBottom = 'true';
        container.scrollTop = container.scrollHeight;
        resetChatScrollAnchor(container);
      }
    },
  }), [beginJumpSettling, cancelPendingChunkRender, chatData, clearJumpHighlight, clearJumpSettling, mediaState, renderChunk, visibility, reactionFeature.hide]);

  const handleScroll = useCallback(() => {
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(onScrollSync, 80);

    const container = chatContainerRef.current;
    if (container) {
      const st = container.scrollTop;
      recordChatScroll(container);
      
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
      resetChatScrollAnchor(chatContainerRef.current);
    }
  }, [chatData, cancelPendingChunkRender, clearJumpHighlight, clearJumpSettling]);

  React.useEffect(() => () => {
    jumpRequestIdRef.current++;
    cancelPendingChunkRender();
    clearJumpHighlight();
    clearJumpSettling();
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
  }, [cancelPendingChunkRender, clearJumpHighlight, clearJumpSettling]);

  const chunkHeights = React.useMemo(() => ({ visibility, values: new Map<number, number>() }), [visibility]);
  const getChunkHeight = useCallback((index: number) => {
    const cached = chunkHeights.values.get(index);
    if (cached !== undefined) return cached;
    const height = estimateChunkHeight(chunks[index], index, chatData!.messages, visibility, neighbors.previous);
    chunkHeights.values.set(index, height);
    return height;
  }, [chunkHeights, chunks, chatData, visibility, neighbors]);

  const lastVisibleChunk = React.useMemo(() => {
    for (let i = visibility.length - 1; i >= 0; i--) if (!visibility[i]) return Math.floor(i / CHUNK_SIZE);
    return -1;
  }, [visibility]);

  const opening = !!chatData && readyChat !== chatData;

  React.useEffect(() => {
    if (!chatData || readyChat === chatData) return;
    const openingChat = chatData;
    const startedAt = Date.now();
    let quietSince: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let revealFrame: number | null = null;
    let cancelled = false;

    const finishOpening = (container: HTMLDivElement) => {
      container.dataset.isAtBottom = 'true';
      container.scrollTop = container.scrollHeight;
      resetChatScrollAnchor(container);
      revealFrame = requestAnimationFrame(() => {
        if (cancelled || openingChat !== chatData || container !== chatContainerRef.current) return;
        container.scrollTop = container.scrollHeight;
        setReadyChat(openingChat);
      });
    };

    const checkOpening = () => {
      if (cancelled || openingChat !== chatData) return;
      const container = chatContainerRef.current;
      if (!container) {
        timer = setTimeout(checkOpening, CHAT_OPENING_CHECK_MS);
        return;
      }

      container.dataset.isAtBottom = 'true';
      container.scrollTop = container.scrollHeight;
      const lastChunkIndex = lastVisibleChunk;
      const lastChunkReady = lastChunkIndex < 0 || !!container.querySelector(
        `.message-chunk[data-chunk-index="${lastChunkIndex}"][data-rendered="true"]`,
      );
      const viewport = container.getBoundingClientRect();
      const pendingNearbyMedia = [...container.querySelectorAll(
        '.lazy-media-wrapper[data-media-geometry-pending="true"]',
      )].some(element => {
        const mediaRect = element.getBoundingClientRect();
        return mediaRect.bottom > viewport.top - CHAT_OPENING_MEDIA_MARGIN_PX
          && mediaRect.top < viewport.bottom + CHAT_OPENING_MEDIA_MARGIN_PX;
      });
      const now = Date.now();

      if (lastChunkReady && !pendingNearbyMedia) {
        quietSince ??= now;
        if (now - quietSince >= CHAT_OPENING_QUIET_MS) {
          finishOpening(container);
          return;
        }
      } else {
        quietSince = null;
      }

      if (now - startedAt >= CHAT_OPENING_MAX_MS) {
        finishOpening(container);
        return;
      }
      timer = setTimeout(checkOpening, CHAT_OPENING_CHECK_MS);
    };

    timer = setTimeout(checkOpening, 0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (revealFrame !== null) cancelAnimationFrame(revealFrame);
    };
  }, [chatData, chunks.length, readyChat, lastVisibleChunk]);

  const handleChunkHeightMeasured = useCallback((chunkIndex: number, height: number) => {
    chunkHeights.values.set(chunkIndex, height);
  }, [chunkHeights]);
  const chunkViewData = React.useMemo(() => ({
    selectedPerspective, settings, mediaState, highlightQuery, chatContainerRef,
    onMediaClick, onLinkClick, onRendered: handleChunkRendered,
    onHeightMeasured: handleChunkHeightMeasured, getChunkHeight, lastVisibleChunk, forcedChunkIndex,
  }), [selectedPerspective, settings, mediaState, highlightQuery, onMediaClick, onLinkClick,
    handleChunkRendered, handleChunkHeightMeasured, getChunkHeight, lastVisibleChunk, forcedChunkIndex]);
  const renderGroups = React.useMemo(() => Array.from({ length: Math.ceil(chunks.length / CHUNKS_PER_RENDER_GROUP) }, (_, index) => index * CHUNKS_PER_RENDER_GROUP), [chunks.length]);

  if (!chatData) return null;

  return (
    <div
      id="chat"
      ref={chatContainerRef}
      aria-busy={opening}
      data-opening={opening ? 'true' : undefined}
      onScroll={handleScroll}
      onWheel={clearJumpSettling}
      onTouchStart={clearJumpSettling}
      onPointerDown={clearJumpSettling}
      onKeyDown={handleJumpKeyDown}
    >
      {opening && <div className="chat-opening-status" role="status">Preparing messages...</div>}
      {lastVisibleChunk < 0 && <div className="reaction-empty-chat">All messages are hidden. <button type="button" onClick={reactionFeature.showAll}>Show all</button></div>}
      <ChunkMessageContext value={chunkMessageData}>
      <ChunkViewContext value={chunkViewData}>
      <ReactionVisibilityAnchor data={threadIdentity} getVisibility={getVisibility} containerRef={chatContainerRef}>
      <div className="message-list-content" key={chatData.thread_path || chatData.title}>
        {renderGroups.map(start => <MessageChunkGroup key={start} start={start} />)}
      </div>
      </ReactionVisibilityAnchor>
      </ChunkViewContext>
      </ChunkMessageContext>
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
         prev.settings.hideLikelyReactionNotices === next.settings.hideLikelyReactionNotices &&
         prev.onHiddenCountChange === next.onHiddenCountChange &&
         prev.onMediaClick === next.onMediaClick &&
         prev.onLinkClick === next.onLinkClick;
});
