import type { MessengerMessage, SearchIndexEntry, SearchResult } from '../types/messenger';
import { escapeHtml } from './storage';
import { fixEncoding } from './parser';
import { isReactionNoticeMessage } from './reactions';
import { getMessageMediaItems } from './media';

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

    const sender = m.senderName || m.sender_name || '';
    if (sender) parts.push(sender);

    if (m.reactions?.length) {
      parts.push(m.reactions.map(r => r.reaction + ' ' + (r.actor || '')).join(' '));
    }

    getMessageMediaItems(m).forEach(mi => { if (mi?.uri) parts.push(mi.uri); });

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

  const BATCH = 500;
  for (let i = 0; i < index.length; i += BATCH) {
    if (signal?.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }
    const batch = index.slice(i, i + BATCH);
    for (const item of batch) {
      if (item.normalized.includes(normalizedQuery)) results.push({ item });
    }
    if (onProgress) onProgress(Math.min(100, Math.round(((i + BATCH) / index.length) * 100)));
    await new Promise<void>(r => setTimeout(r, 0));
  }
  return results;
}
