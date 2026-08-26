import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { MessengerThread } from '../../types/messenger';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Settings } from '../../hooks/useSettings';
import { isReactionNoticeMessage } from '../../services/reactions';
import { getMessageTimestamp } from '../../services/parser';
import { escapeHtml, padDatePart } from '../../services/storage';

type DateScale = 'month' | 'week' | 'day';

interface DateBucket {
  key: string;
  index: number;
  timestamp: number;
  count: number;
  label: string;
}

type BucketsByScale = Record<DateScale, DateBucket[]>;

const DATE_NAV_SYNC_LOCK_MS = 900;

function getLocalDateKey(date: Date): string {
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
}
function getLocalMonthKey(date: Date): string {
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}`;
}
function getWeekStartDate(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const offset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - offset);
  return d;
}
function getBucketLabel(scale: DateScale, timestamp: number): string {
  const date = new Date(timestamp);
  if (scale === 'month') return date.toLocaleDateString([], { month: 'short', year: 'numeric' });
  if (scale === 'week') {
    const start = getWeekStartDate(date);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })}-${end.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function getBucketKey(scale: DateScale, timestamp: number): string {
  const date = new Date(timestamp);
  if (scale === 'month') return getLocalMonthKey(date);
  if (scale === 'week') return getLocalDateKey(getWeekStartDate(date));
  return getLocalDateKey(date);
}

function buildDateBuckets(messages: MessengerThread['messages']): BucketsByScale {
  const maps: Record<DateScale, Map<string, DateBucket>> = {
    month: new Map(), week: new Map(), day: new Map(),
  };
  messages.forEach((msg, index) => {
    if (isReactionNoticeMessage(msg)) return;
    const timestamp = getMessageTimestamp(msg);
    if (timestamp === null) return;
    (['month', 'week', 'day'] as DateScale[]).forEach(scale => {
      const key = getBucketKey(scale, timestamp);
      if (!maps[scale].has(key)) {
        maps[scale].set(key, { key, index, timestamp, count: 0, label: getBucketLabel(scale, timestamp) });
      }
      maps[scale].get(key)!.count++;
    });
  });
  return {
    month: Array.from(maps.month.values()),
    week: Array.from(maps.week.values()),
    day: Array.from(maps.day.values()),
  };
}

function getBucketKeyForMessageIndex(buckets: DateBucket[], msgIndex: number): string | null {
  if (buckets.length === 0) return null;

  let lo = 0;
  let hi = buckets.length - 1;
  let best = 0;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (buckets[mid].index <= msgIndex) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return buckets[best].key;
}

function findClosestChunkIndex(container: HTMLDivElement, activeLine: number): number | null {
  const chunks = Array.from(container.querySelectorAll('.message-chunk[data-start-msg-index]')) as HTMLElement[];
  if (chunks.length === 0) return null;

  let lo = 0;
  let hi = chunks.length - 1;
  let candidate = chunks.length - 1;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const rect = chunks[mid].getBoundingClientRect();
    if (rect.bottom >= activeLine) {
      candidate = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  const chunk = chunks[candidate];
  const chunkRect = chunk.getBoundingClientRect();
  const attr = activeLine > chunkRect.bottom ? chunk.dataset.endMsgIndex : chunk.dataset.startMsgIndex;
  const index = Number(attr);
  return Number.isFinite(index) ? index : null;
}

function findMessageIndexAtActiveLine(container: HTMLDivElement): number | null {
  const containerRect = container.getBoundingClientRect();
  const activeLine = containerRect.top + Math.max(60, containerRect.height * 0.2);
  const x = containerRect.left + Math.max(1, Math.min(containerRect.width - 1, containerRect.width * 0.5));
  const sampleYs = [activeLine, activeLine + 24, activeLine - 24, activeLine + 60, activeLine - 60];

  for (const y of sampleYs) {
    if (y < containerRect.top || y > containerRect.bottom) continue;
    const el = document.elementFromPoint(x, y);
    if (!el || !container.contains(el)) continue;

    const msgEl = el.closest('.message[data-msg-index]') as HTMLElement | null;
    if (msgEl) {
      const index = Number(msgEl.dataset.msgIndex);
      if (Number.isFinite(index)) return index;
    }

    const chunkEl = el.closest('.message-chunk[data-start-msg-index]') as HTMLElement | null;
    if (chunkEl) {
      const index = Number(chunkEl.dataset.startMsgIndex);
      if (Number.isFinite(index)) return index;
    }
  }

  return findClosestChunkIndex(container, activeLine);
}

interface DateNavigatorProps {
  chatData: MessengerThread | null;
  settings: Settings;
  onJumpToMessage: (index: number) => Promise<void>;
  chatContainerRef: React.RefObject<HTMLDivElement | null>;
}

export function DateNavigator({ chatData, settings: _settings, onJumpToMessage, chatContainerRef }: DateNavigatorProps) {
  const [scale, setScale] = useState<DateScale>('month');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [buckets, setBuckets] = useState<BucketsByScale>({ month: [], week: [], day: [] });
  const [manualCollapse, setManualCollapse] = useState(false);
  const syncingRef = useRef(false);
  const sliderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const activeKeyRef = useRef<string | null>(null);
  const currentBucketsRef = useRef<DateBucket[]>([]);

  useEffect(() => {
    if (!chatData?.messages) {
      setBuckets({ month: [], week: [], day: [] });
      setActiveKey(null);
      return;
    }
    const built = buildDateBuckets(chatData.messages);
    setBuckets(built);
    setScale('month');
    setActiveKey(built.month[0]?.key ?? null);
  }, [chatData]);

  const currentBuckets = React.useMemo(() => buckets[scale] || [], [buckets, scale]);
  const activeIndex = currentBuckets.findIndex(b => b.key === activeKey);
  const activeBucket = activeIndex >= 0 ? currentBuckets[activeIndex] : currentBuckets[0];
  const hasDates = currentBuckets.length > 0;
  const maxCount = Math.max(1, ...currentBuckets.map(b => b.count));

  useEffect(() => {
    activeKeyRef.current = activeKey;
  }, [activeKey]);

  useEffect(() => {
    currentBucketsRef.current = currentBuckets;
  }, [currentBuckets]);

  const updateFromScroll = useCallback(() => {
    if (syncingRef.current) return;
    const container = chatContainerRef.current;
    const bucketsForScale = currentBucketsRef.current;
    if (!container || bucketsForScale.length === 0) return;

    const msgIndex = findMessageIndexAtActiveLine(container);
    if (msgIndex === null) return;

    const key = getBucketKeyForMessageIndex(bucketsForScale, msgIndex);
    if (key && key !== activeKeyRef.current) setActiveKey(key);
  }, [chatContainerRef]);

  useEffect(() => {
    const container = chatContainerRef.current;
    if (!container) return;
    const handler = () => updateFromScroll();
    container.addEventListener('scroll', handler, { passive: true });
    return () => container.removeEventListener('scroll', handler);
  }, [updateFromScroll, chatContainerRef]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!hasDates) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      const cb = async (direction: number) => {
        const cur = currentBuckets.findIndex(b => b.key === activeKey);
        const fallback = direction > 0 ? -1 : currentBuckets.length;
        const next = Math.min(currentBuckets.length - 1, Math.max(0, (cur >= 0 ? cur : fallback) + direction));
        const bucket = currentBuckets[next];
        if (!bucket) return;
        syncingRef.current = true;
        setActiveKey(bucket.key);
        await onJumpToMessage(bucket.index);
        setTimeout(() => { syncingRef.current = false; }, DATE_NAV_SYNC_LOCK_MS);
      };

      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); cb(-1); }
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); cb(1); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [hasDates, currentBuckets, activeKey, onJumpToMessage]);

  const step = async (direction: number) => {
    const cur = currentBuckets.findIndex(b => b.key === activeKey);
    const fallback = direction > 0 ? -1 : currentBuckets.length;
    const next = Math.min(currentBuckets.length - 1, Math.max(0, (cur >= 0 ? cur : fallback) + direction));
    const bucket = currentBuckets[next];
    if (!bucket) return;
    syncingRef.current = true;
    setActiveKey(bucket.key);
    await onJumpToMessage(bucket.index);
    setTimeout(() => { syncingRef.current = false; }, DATE_NAV_SYNC_LOCK_MS);
  };

  const handleScaleChange = (newScale: DateScale) => {
    setScale(newScale);
    const newBuckets = buckets[newScale];
    const firstBucket = newBuckets[0];
    setActiveKey(firstBucket?.key ?? null);
  };

  const handleBucketClick = async (bucket: DateBucket) => {
    syncingRef.current = true;
    setActiveKey(bucket.key);
    await onJumpToMessage(bucket.index);
    setTimeout(() => { syncingRef.current = false; }, DATE_NAV_SYNC_LOCK_MS);
    if (trackRef.current && scale === 'month') {
      const activeEl = trackRef.current.querySelector(`[data-date-key="${CSS.escape(bucket.key)}"]`);
      if (activeEl) activeEl.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    }
  };

  const handleSliderChange = (value: number) => {
    const bucket = currentBuckets[value];
    if (!bucket) return;
    setActiveKey(bucket.key);
    if (sliderTimerRef.current) clearTimeout(sliderTimerRef.current);
    sliderTimerRef.current = setTimeout(async () => {
      syncingRef.current = true;
      await onJumpToMessage(bucket.index);
      setTimeout(() => { syncingRef.current = false; }, DATE_NAV_SYNC_LOCK_MS);
    }, 120);
  };

  if (!hasDates) return null;

  return (
    <div className={`date-nav-controls${hasDates ? ' active' : ''}${manualCollapse && !_settings.autoCollapseDateNav ? ' manual-collapsed' : ''}`} id="dateNavControls">
      <div className="date-nav-scale">
        {(['month', 'week', 'day'] as DateScale[]).map(s => (
          <button
            key={s}
            data-date-scale={s}
            className={scale === s ? 'active' : ''}
            onClick={() => handleScaleChange(s)}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      <div className="date-nav-steps">
        <button
          id="dateNavPrev"
          onClick={() => step(-1)}
          disabled={activeIndex <= 0}
          title="Previous"
          aria-label="Previous period"
        >
          <ChevronLeft size={16} />
        </button>
        <button
          id="dateNavNext"
          onClick={() => step(1)}
          disabled={activeIndex >= currentBuckets.length - 1}
          title="Next"
          aria-label="Next period"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <button
        className="date-nav-current-box"
        disabled={_settings.autoCollapseDateNav}
        onClick={() => { if (!_settings.autoCollapseDateNav) setManualCollapse(v => !v); }}
        title={!_settings.autoCollapseDateNav ? (manualCollapse ? 'Show date navigator' : 'Hide date navigator') : ''}
        id="dateNavCurrentBox"
        aria-live="polite"
      >
        <span className="date-nav-current" id="dateNavCurrent">
          {activeBucket?.label || ''}
        </span>
      </button>

      {/* Track — shown when header hovered (CSS handles auto-collapse), or toggled manually */}
      {scale === 'month' ? (
        <div className="date-nav-track" id="dateNavTrack" ref={trackRef}>
          {currentBuckets.map(bucket => (
            <button
              key={bucket.key}
              type="button"
              className={`date-nav-item${activeKey === bucket.key ? ' active' : ''}`}
              data-date-key={bucket.key}
              data-msg-index={bucket.index}
              title={`${escapeHtml(bucket.label)} — ${bucket.count} message${bucket.count === 1 ? '' : 's'}`}
              onClick={() => handleBucketClick(bucket)}
            >
              <span className="date-nav-label">{bucket.label}</span>
              <span className="date-nav-count">{bucket.count} msg{bucket.count !== 1 ? 's' : ''}</span>
              <span className="date-nav-density" aria-hidden="true">
                <span style={{ width: `${Math.max(8, Math.round((bucket.count / maxCount) * 100))}%` }} />
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="date-nav-track slider-mode" id="dateNavTrack" ref={trackRef}>
          <div className="date-nav-slider-wrap">
            <input
              id="dateNavSlider"
              className="date-nav-slider"
              type="range"
              min={0}
              max={Math.max(0, currentBuckets.length - 1)}
              value={Math.max(0, activeIndex)}
              step={1}
              disabled={currentBuckets.length <= 1}
              onChange={e => handleSliderChange(Number(e.target.value))}
            />
            <div className="date-nav-slider-labels">
              <span>{currentBuckets[0]?.label || ''}</span>
              <span>{currentBuckets[currentBuckets.length - 1]?.label || ''}</span>
            </div>
            <div id="dateNavSliderMeta" className="date-nav-slider-meta">
              {activeBucket ? `${activeBucket.count} message${activeBucket.count !== 1 ? 's' : ''}` : ''}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
