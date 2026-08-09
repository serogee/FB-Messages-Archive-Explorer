import type { MessengerMessage, SearchIndexEntry, SearchResult } from '../types/messenger';
import { escapeHtml } from './storage';
import { fixEncoding } from './parser';
import { isReactionNoticeMessage } from './reactions';

// ── Internal helpers ───────────────────────────────────────────────

function buildNormalizedMap(original: string): { normalized: string; mapping: number[] } {
  const mapping: number[] = [];
  let normalized = '';
  for (let i = 0; i < original.length; i++) {
    const ch = original[i];
    const n = ch.normalize('NFD').replace(/\p{Diacritic}/gu, '');
    for (let k = 0; k < n.length; k++) {
      mapping.push(i);
      normalized += n[k];
    }
  }
  return { normalized: normalized.toLowerCase(), mapping };
}

function findRangesForToken(original: string, tokenNorm: string): [number, number][] {
  const { normalized, mapping } = buildNormalizedMap(original);
  const ranges: [number, number][] = [];
  let start = 0;
  while (true) {
    const idx = normalized.indexOf(tokenNorm, start);
    if (idx === -1) break;
    const origStart = mapping[idx];
    const origEnd = mapping[idx + tokenNorm.length - 1] + 1;
    ranges.push([origStart, origEnd]);
    start = idx + tokenNorm.length;
  }
  return ranges;
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  if (!ranges.length) return [];
  ranges.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [ranges[0].slice() as [number, number]];
  for (let i = 1; i < ranges.length; i++) {
    const cur = ranges[i];
    const last = out[out.length - 1];
    if (cur[0] <= last[1]) {
      last[1] = Math.max(last[1], cur[1]);
    } else {
      out.push(cur.slice() as [number, number]);
    }
  }
  return out;
}

function getMessageText(msg: MessengerMessage): string {
  return fixEncoding(msg?.text || msg?.content || '').trim();
}

// ── Exported functions ─────────────────────────────────────────────

export function normalizeForSearch(str: string): string {
  if (!str) return '';
  const normalized = str.normalize('NFD').replace(/\p{Diacritic}/gu, '');
  return normalized.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function highlightText(original: string, query: string): string {
  if (!query || !original) return escapeHtml(original);
  const qNorm = normalizeForSearch(query);
  if (!qNorm) return escapeHtml(original);
  const allRanges = findRangesForToken(original, qNorm);
  if (!allRanges.length) return escapeHtml(original);
  const merged = mergeRanges(allRanges);
  let out = '';
  let lastIdx = 0;
  for (const [s, e] of merged) {
    out += escapeHtml(original.slice(lastIdx, s));
    out += '<span class="search-highlight">' + escapeHtml(original.slice(s, e)) + '</span>';
    lastIdx = e;
  }
  out += escapeHtml(original.slice(lastIdx));
  return out;
}

export function buildSearchIndex(
  messages: MessengerMessage[],
  isReactionNotice: (msg: MessengerMessage) => boolean = isReactionNoticeMessage
): SearchIndexEntry[] {
  const idx: SearchIndexEntry[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (isReactionNotice(m)) continue;

    const parts: string[] = [];
    const messageText = getMessageText(m);
    if (messageText) parts.push(messageText);

    const mediaArrays = [
      m.photos,
      m.videos,
      m.audio,
      m.audio_files,
      m.gifs,
      m.files,
      m.media,
    ];

    for (const arr of mediaArrays) {
      if (arr) {
        for (const item of arr) {
          const name = item.filename || item.name || item.path || item.uri;
          if (name) {
            const decoded = fixEncoding(name);
            const baseName = decoded.split(/[/\\]/).pop();
            if (baseName) parts.push(baseName);
          }
        }
      }
    }

    const text = parts.join(' ');
    idx.push({
      text,
      normalized: normalizeForSearch(text),
      sender: m.senderName || m.sender_name || 'Unknown',
      timestamp: m.timestamp_ms || m.timestamp || 0,
      idx: i,
    });
  }
  return idx;
}

export async function performSearch(
  query: string,
  index: SearchIndexEntry[],
  onProgress?: (percent: number) => void,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const normalizedQuery = normalizeForSearch(query);
  if (!normalizedQuery) return results;

  let lastYieldTime = performance.now();
  const YIELD_INTERVAL_MS = 15;

  for (let i = 0; i < index.length; i++) {
    if (signal?.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }

    const item = index[i];
    if (item.normalized.includes(normalizedQuery)) {
      results.push({ item });
    }

    // Check elapsed time periodically to avoid excessive performance.now() calls
    if (i % 500 === 0) {
      const now = performance.now();
      if (now - lastYieldTime > YIELD_INTERVAL_MS) {
        if (onProgress) onProgress(Math.min(100, Math.round(((i + 1) / index.length) * 100)));
        await new Promise<void>(r => setTimeout(r, 0));
        lastYieldTime = performance.now();
      }
    }
  }

  if (onProgress) onProgress(100);
  return results;
}
