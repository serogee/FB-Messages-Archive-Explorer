import React, { memo, useState, useEffect, useRef } from 'react';
import type { MessengerMessage, MediaState } from '../../types/messenger';
import { getMessageTimestamp, fixEncoding } from '../../services/parser';
import { findMediaFile, getMediaReferencePath, getMediaType } from '../../services/media';
import { blobCache, openMediaEntryInNewTab } from '../../services/blobCache';
import { chatImagePreviewCache, getChatPreviewPixelSize, type ChatImagePreview } from '../../services/chatImagePreviewCache';
import { chatVideoPosterCache } from '../../services/videoPosterCache';
import type { TaskSubscription } from '../../services/subscribableTaskQueue';
import { getReactionTimestamp } from '../../services/reactions';
import { highlightText } from '../../services/search';
import { escapeHtml } from '../../services/storage';
import { getMessageLinks, MESSAGE_URL_PATTERN, normalizeExternalUrl, trimTrailingUrlPunctuation } from '../../services/messageLinks';
import { ReactionModal } from './ReactionModal';
import { MediaFileSize } from '../MediaFileSize';
import { FileText, Image as ImageIcon, Info, Link as LinkIcon, Music2, Pause, Play, Video, Volume2, VolumeX } from 'lucide-react';

const lazyMediaVisibleCallbacks = new Map<Element, (inside: boolean) => void>();
const lazyMediaPreloadCallbacks = new Map<Element, (inside: boolean) => void>();
const lazyMediaRetentionCallbacks = new Map<Element, (inside: boolean) => void>();
const lazyMediaResizeCallbacks = new Map<Element, (entry: ResizeObserverEntry) => void>();
const lazyMediaObserverPairs = new WeakMap<Element, LazyMediaObserverPair>();
let viewportLazyMediaObserverPair: LazyMediaObserverPair | null = null;
let sharedLazyMediaResizeObserver: ResizeObserver | null = null;
const MEDIA_PRELOAD_MARGIN_PX = 2_000;
const MEDIA_RETENTION_MARGIN_PX = 5_000;
const MEDIA_PRIORITY_VISIBLE = 0;
const MEDIA_PRIORITY_PRELOAD = 1;
const MEDIA_PRIORITY_RETENTION = 2;

interface LazyMediaObserverPair {
  visible: IntersectionObserver;
  preload: IntersectionObserver;
  retention: IntersectionObserver;
}

function createRangeObserver(
  root: Element | null,
  margin: number,
  callbacks: Map<Element, (inside: boolean) => void>,
): IntersectionObserver {
  return new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      callbacks.get(entry.target)?.(entry.isIntersecting);
    });
  }, { root, rootMargin: `${margin}px 0px` });
}

function createLazyMediaObserverPair(root: Element | null): LazyMediaObserverPair {
  return {
    visible: createRangeObserver(root, 0, lazyMediaVisibleCallbacks),
    preload: createRangeObserver(root, MEDIA_PRELOAD_MARGIN_PX, lazyMediaPreloadCallbacks),
    retention: createRangeObserver(root, MEDIA_RETENTION_MARGIN_PX, lazyMediaRetentionCallbacks),
  };
}

function getSharedLazyMediaObservers(root: Element | null): LazyMediaObserverPair {
  if (!root) {
    if (!viewportLazyMediaObserverPair) viewportLazyMediaObserverPair = createLazyMediaObserverPair(null);
    return viewportLazyMediaObserverPair;
  }

  let observers = lazyMediaObserverPairs.get(root);
  if (!observers) {
    observers = createLazyMediaObserverPair(root);
    lazyMediaObserverPairs.set(root, observers);
  }
  return observers;
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

function compensateMediaHeightChange(el: Element, oldHeight: number, newHeight: number): void {
  if (oldHeight === newHeight) return;

  const appContainer = el.closest('.container');
  if (appContainer?.classList.contains('resizing') || appContainer?.classList.contains('resize-settling')) return;

  const container = el.closest('#chat') as HTMLElement | null;
  if (!container) return;

  if (container.dataset.isAtBottom === 'true') {
    container.scrollTop = container.scrollHeight;
    container.dataset.lastScrollTop = String(container.scrollTop);
    return;
  }

  const scrollDir = container.dataset.scrollDir || 'up';
  const containerRect = container.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const isAboveAnchor = scrollDir === 'down'
    ? elRect.top < containerRect.top
    : elRect.top < containerRect.bottom;

  if (isAboveAnchor) {
    container.scrollTop += newHeight - oldHeight;
    container.dataset.lastScrollTop = String(container.scrollTop);
  }
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

type MediaLoadState = 'dormant' | 'loading' | 'ready' | 'failed';

function MediaLoadingPlaceholder({
  label,
  icon,
  audio = false,
  active = true,
}: {
  label: string;
  icon: React.ReactNode;
  audio?: boolean;
  active?: boolean;
}) {
  return (
    <span
      className={`placeholder media-loading-placeholder${audio ? ' audio-placeholder' : ''}`}
      role={active ? 'status' : undefined}
      aria-label={active ? label : undefined}
    >
      {icon}
    </span>
  );
}

function ChatImageAttachment({
  url,
  state,
  isSticker,
  dimensions,
  onActivate,
  onReady,
  onFailed,
}: {
  url: string | null;
  state: MediaLoadState;
  isSticker: boolean;
  dimensions: Pick<ChatImagePreview, 'sourceWidth' | 'sourceHeight'> | null;
  onActivate?: () => void;
  onReady: () => void;
  onFailed: () => void;
}) {
  if (!url) {
    return state !== 'failed'
      ? <MediaLoadingPlaceholder active={state === 'loading'} label={isSticker ? 'Loading sticker' : 'Loading image'} icon={<ImageIcon aria-hidden="true" size={24} />} />
      : <span className="placeholder">[ Image not found ]</span>;
  }

  return (
    <div className={`media-preview${isSticker ? ' sticker-preview' : ''}${state === 'loading' ? ' media-preview-loading' : ''}`} onClick={onActivate} role="button" tabIndex={0} style={{ cursor: 'pointer' }}>
      <img
        src={url}
        alt={isSticker ? 'Sticker' : 'Image'}
        className="preview"
        width={dimensions?.sourceWidth}
        height={dimensions?.sourceHeight}
        onLoad={onReady}
        onError={onFailed}
      />
      {state === 'loading' && <MediaLoadingPlaceholder label={isSticker ? 'Loading sticker' : 'Loading image'} icon={<ImageIcon aria-hidden="true" size={24} />} />}
    </div>
  );
}

function ChatVideoAttachment({
  url,
  state,
  dimensions,
  onActivate,
  onReady,
  onFailed,
}: {
  url: string | null;
  state: MediaLoadState;
  dimensions: Pick<ChatImagePreview, 'sourceWidth' | 'sourceHeight'> | null;
  onActivate: () => void;
  onReady: () => void;
  onFailed: () => void;
}) {
  if (!url) {
    return state !== 'failed'
      ? <MediaLoadingPlaceholder active={state === 'loading'} label="Loading video" icon={<Video aria-hidden="true" size={24} />} />
      : <button type="button" className="placeholder chat-video-fallback" onClick={onActivate}>
          <Video aria-hidden="true" size={24} />
          <span>Open video</span>
        </button>;
  }

  return (
    <div
      className={`media-preview${state === 'loading' ? ' media-preview-loading' : ''}`}
      onClick={onActivate}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onActivate();
      }}
      role="button"
      tabIndex={0}
      style={{ cursor: 'pointer' }}
    >
      <img
        src={url}
        className="preview-video chat-video-poster"
        alt="Video preview"
        width={dimensions?.sourceWidth}
        height={dimensions?.sourceHeight}
        onLoad={onReady}
        onError={onFailed}
      />
      <span className="chat-video-play" aria-hidden="true"><Play fill="currentColor" size={26} /></span>
      {state === 'loading' && <MediaLoadingPlaceholder label="Loading video" icon={<Video aria-hidden="true" size={24} />} />}
    </div>
  );
}

function ChatAudioAttachment({ url, state, onOpenViewer }: { url: string | null; state: MediaLoadState; onOpenViewer?: () => void }) {
  if (!url) {
    return state !== 'failed'
      ? <MediaLoadingPlaceholder active={state === 'loading'} label="Loading audio" icon={<Music2 aria-hidden="true" size={20} />} audio />
      : <span className="placeholder audio-placeholder">[ Audio not found ]</span>;
  }

  return (
    <div className="media-audio-wrap">
      <InlineAudioPlayer src={url} />
      {onOpenViewer && <button className="media-audio-expand" onClick={onOpenViewer} aria-label="Open audio in viewer" title="Open in viewer"><Info size={15} /></button>}
    </div>
  );
}

function ChatFileAttachment({ mediaPath, mediaFile, onOpenViewer }: {
  mediaPath: string;
  mediaFile: ReturnType<typeof findMediaFile>;
  onOpenViewer?: () => void;
}) {
  const filename = mediaPath.split('/').pop() || 'File attachment';
  if (!mediaFile) return <span className="placeholder" style={{ width: 'auto', padding: '8px 12px' }}>[ File not found ]</span>;

  return (
    <div className="media-file-card">
      <button type="button" className="media-file-open" onClick={() => openMediaEntryInNewTab(mediaFile)} title={`Open ${filename} in a new tab`}>
        <FileText size={17} />
        <span className="media-file-copy">
          <span className="media-file-name">{filename}</span>
          <MediaFileSize entry={mediaFile} className="media-file-size" />
        </span>
      </button>
      {onOpenViewer && (
        <button type="button" className="media-file-info" onClick={onOpenViewer} aria-label={`View information for ${filename}`} title="Open in viewer">
          <Info size={15} />
        </button>
      )}
    </div>
  );
}

function LazyMedia({
  mediaPath,
  mediaFile,
  preferredType,
  isSticker = false,
  isGrid = false,
  onMediaClick,
}: {
  mediaPath: string;
  mediaFile: ReturnType<typeof findMediaFile>;
  preferredType?: 'image' | 'video' | 'audio';
  isSticker?: boolean;
  isGrid?: boolean;
  onMediaClick?: () => void;
}) {
  const ext = mediaPath.split('.').pop()?.toLowerCase() || '';
  const mediaType = preferredType || (ext === 'mp4' || ext === 'webm' ? 'video' : (mediaFile?.type || getMediaType(mediaPath)));
  const usesGeneratedPreview = mediaType === 'image' && !isSticker && ext !== 'gif';
  const [fileURL, setFileURL] = useState<string | null>(null);
  const [previewDimensions, setPreviewDimensions] = useState<Pick<ChatImagePreview, 'sourceWidth' | 'sourceHeight'> | null>(null);
  const [loadState, setLoadState] = useState<MediaLoadState>(() => {
    if (!mediaFile) return 'failed';
    return 'dormant';
  });
  const [reservedSize, setReservedSize] = useState<{ width: number; height: number } | null>(null);
  const mediaRef = useRef<HTMLElement | null>(null);
  const prevHeight = useRef<number | null>(null);
  const activateVideo = onMediaClick || (() => openMediaEntryInNewTab(mediaFile));

  // Preload near the viewport, then dehydrate media only after it leaves the
  // larger retention range. The gap between both ranges prevents scroll churn.
  useEffect(() => {
    let isMounted = true;
    let retained = true;
    let inVisibleRange = false;
    let inPreloadRange = false;
    let hydrated = false;
    let loadingStarted = false;
    let requestGeneration = 0;
    let loadPriority = MEDIA_PRIORITY_RETENTION;
    let loadSubscription: TaskSubscription | null = null;
    if (!mediaFile) {
      setFileURL(null);
      setPreviewDimensions(null);
      setLoadState('failed');
      return;
    }

    setPreviewDimensions(null);
    const el = mediaRef.current;
    if (!el) return;
    if (mediaType !== 'image' && mediaType !== 'video' && mediaType !== 'audio') {
      setLoadState('ready');
      return;
    }

    const canApply = (generation: number) => (
      isMounted && retained && generation === requestGeneration
    );
    const finishLoad = (generation: number) => {
      if (generation === requestGeneration) loadingStarted = false;
    };
    const showUrl = (url: string, generation: number) => {
      if (!canApply(generation)) return;
      hydrated = true;
      finishLoad(generation);
      setFileURL(url);
      setLoadState('loading');
    };
    const loadOriginal = (generation: number) => {
      const cached = blobCache.get(mediaFile);
      if (cached) {
        showUrl(cached, generation);
        return;
      }
      if (mediaFile.url) {
        blobCache.put(mediaFile, mediaFile.url);
        showUrl(mediaFile.url, generation);
        return;
      }
      if (!mediaFile.handle) {
        finishLoad(generation);
        setFileURL(null);
        setLoadState('failed');
        return;
      }
      void blobCache.getOrCreate(mediaFile).then(url => {
        if (!canApply(generation)) return;
        finishLoad(generation);
        if (url) {
          hydrated = true;
          setFileURL(url);
          setLoadState('loading');
        } else {
          setFileURL(null);
          setLoadState('failed');
        }
      });
    };

    const startLoad = () => {
      if (!isMounted || !retained || loadingStarted || hydrated) return;
      loadingStarted = true;
      setLoadState('loading');
      const generation = ++requestGeneration;

      if (mediaType === 'video') {
        loadSubscription = chatVideoPosterCache.subscribe(mediaFile, poster => {
          if (!canApply(generation)) return;
          finishLoad(generation);
          if (!poster) {
            setFileURL(null);
            setLoadState('failed');
            return;
          }
          hydrated = true;
          setPreviewDimensions(poster.sourceWidth && poster.sourceHeight ? {
            sourceWidth: poster.sourceWidth,
            sourceHeight: poster.sourceHeight,
          } : null);
          setFileURL(poster.url);
          setLoadState('loading');
        }, loadPriority);
        return;
      }

      if (!usesGeneratedPreview) {
        loadOriginal(generation);
        return;
      }

      const ratio = window.devicePixelRatio || 1;
      const wrapperWidth = el.getBoundingClientRect().width;
      const messageWidth = el.closest('.message-wrapper')?.getBoundingClientRect().width || wrapperWidth * 2;
      const cssWidth = isGrid ? wrapperWidth : Math.max(wrapperWidth, messageWidth * 0.5);
      const cssHeight = isGrid ? wrapperWidth : 300;
      const options = {
        width: getChatPreviewPixelSize(cssWidth, ratio),
        height: getChatPreviewPixelSize(cssHeight, ratio),
        fit: isGrid ? 'cover' as const : 'contain' as const,
      };

      loadSubscription = chatImagePreviewCache.subscribe(mediaFile, options, preview => {
        if (!canApply(generation)) return;
        if (!preview) {
          // Unsupported image formats still remain viewable through the original path.
          loadOriginal(generation);
          return;
        }

        const decoded = new Image();
        decoded.decoding = 'async';
        decoded.src = preview.url;
        void decoded.decode().then(() => {
          if (!canApply(generation)) return;
          hydrated = true;
          finishLoad(generation);
          setPreviewDimensions(preview);
          setFileURL(preview.url);
          setLoadState('ready');
        }, () => {
          if (!canApply(generation)) return;
          hydrated = true;
          finishLoad(generation);
          // Let the mounted image's load event be the compatibility fallback.
          setPreviewDimensions(preview);
          setFileURL(preview.url);
          setLoadState('loading');
        });
      }, loadPriority);
    };

    const reprioritizeLoad = (priority: number) => {
      loadPriority = priority;
      loadSubscription?.setPriority(priority);
    };
    const cancelLoad = () => {
      requestGeneration++;
      loadingStarted = false;
      loadSubscription?.();
      loadSubscription = null;
    };
    const dehydrate = () => {
      retained = false;
      cancelLoad();
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setReservedSize({ width: rect.width, height: rect.height });
      }
      hydrated = false;
      setFileURL(null);
      setLoadState('dormant');
    };

    const observers = getSharedLazyMediaObservers(el.closest('#chat'));
    lazyMediaVisibleCallbacks.set(el, inside => {
      inVisibleRange = inside;
      if (inside) {
        retained = true;
        reprioritizeLoad(MEDIA_PRIORITY_VISIBLE);
        startLoad();
      } else {
        reprioritizeLoad(inPreloadRange ? MEDIA_PRIORITY_PRELOAD : MEDIA_PRIORITY_RETENTION);
      }
    });
    lazyMediaPreloadCallbacks.set(el, inside => {
      inPreloadRange = inside;
      if (inside) {
        retained = true;
        reprioritizeLoad(inVisibleRange ? MEDIA_PRIORITY_VISIBLE : MEDIA_PRIORITY_PRELOAD);
        startLoad();
      } else if (!inVisibleRange) {
        reprioritizeLoad(MEDIA_PRIORITY_RETENTION);
      }
    });
    lazyMediaRetentionCallbacks.set(el, inside => {
      retained = inside;
      if (!inside) dehydrate();
      else if (inPreloadRange) startLoad();
    });
    setFileURL(null);
    setLoadState('dormant');
    observers.visible.observe(el);
    observers.preload.observe(el);
    observers.retention.observe(el);

    return () => {
      isMounted = false;
      cancelLoad();
      observers.visible.unobserve(el);
      observers.preload.unobserve(el);
      observers.retention.unobserve(el);
      lazyMediaVisibleCallbacks.delete(el);
      lazyMediaPreloadCallbacks.delete(el);
      lazyMediaRetentionCallbacks.delete(el);
    };
  }, [isGrid, mediaFile, mediaType, usesGeneratedPreview]);

  // Compensate for lazy media height changes so the user's scroll anchor stays stable.
  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;

    const observer = getSharedLazyMediaResizeObserver();
    lazyMediaResizeCallbacks.set(el, (entry) => {
      const newHeight = entry.borderBoxSize ? entry.borderBoxSize[0].blockSize : entry.contentRect.height;

      // Grid cells reserve their final square geometry with aspect-ratio. The
      // grid changes height once per row, so compensating every child would
      // apply the same layout change multiple times and push the viewport.
      if (el.closest('.message-media-grid')) {
        prevHeight.current = newHeight;
        return;
      }

      const oldHeight = prevHeight.current;
      if (oldHeight !== null && oldHeight !== newHeight) {
        compensateMediaHeightChange(el, oldHeight, newHeight);
      }
      prevHeight.current = newHeight;
    });

    observer.observe(el);
    return () => {
      observer.unobserve(el);
      lazyMediaResizeCallbacks.delete(el);
    };
  }, []);

  let content: React.ReactNode;
  if (mediaType === 'image') {
    content = <ChatImageAttachment
      url={fileURL}
      state={loadState}
      isSticker={isSticker}
      dimensions={previewDimensions}
      onActivate={onMediaClick}
      onReady={() => setLoadState('ready')}
      onFailed={() => { setFileURL(null); setLoadState('failed'); }}
    />;
  } else if (mediaType === 'video') {
    content = <ChatVideoAttachment
      url={fileURL}
      state={loadState}
      dimensions={previewDimensions}
      onActivate={activateVideo}
      onReady={() => setLoadState('ready')}
      onFailed={() => { setFileURL(null); setLoadState('failed'); }}
    />;
  } else if (mediaType === 'audio') {
    content = <ChatAudioAttachment url={fileURL} state={loadState} onOpenViewer={onMediaClick} />;
  } else {
    content = <ChatFileAttachment mediaPath={mediaPath} mediaFile={mediaFile} onOpenViewer={onMediaClick} />;
  }

  return (
    <div
      ref={mediaRef as React.RefObject<HTMLDivElement>}
      className={`lazy-media-wrapper${loadState === 'dormant' ? ' media-dehydrated' : ''}`}
      style={!isGrid && !fileURL && reservedSize ? {
        width: reservedSize.width,
        maxWidth: '100%',
        aspectRatio: `${reservedSize.width} / ${reservedSize.height}`,
      } : undefined}
    >
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
  const mediaGridRef = useRef<HTMLDivElement | null>(null);
  const mediaGridPrevHeight = useRef<number | null>(null);

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

  useEffect(() => {
    const grid = mediaGridRef.current;
    if (!grid || !hasMediaGrid) return;

    const observer = getSharedLazyMediaResizeObserver();
    lazyMediaResizeCallbacks.set(grid, entry => {
      const newHeight = entry.borderBoxSize ? entry.borderBoxSize[0].blockSize : entry.contentRect.height;
      const oldHeight = mediaGridPrevHeight.current;
      if (oldHeight !== null) compensateMediaHeightChange(grid, oldHeight, newHeight);
      mediaGridPrevHeight.current = newHeight;
    });
    observer.observe(grid);

    return () => {
      observer.unobserve(grid);
      lazyMediaResizeCallbacks.delete(grid);
      mediaGridPrevHeight.current = null;
    };
  }, [hasMediaGrid]);

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
              <div ref={mediaGridRef} className="message-media-grid">
                {previewMediaItems.map(({ preferredType, mediaPath, mediaFile, isSticker }, i) => (
                  <LazyMedia
                    key={`${mediaPath}:${i}`}
                    mediaPath={mediaPath}
                    mediaFile={mediaFile}
                    preferredType={preferredType}
                    isSticker={isSticker}
                    isGrid
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
