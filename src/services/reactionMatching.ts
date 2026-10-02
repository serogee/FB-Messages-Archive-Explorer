import type { MessengerMessage, MessengerThread } from '../types/messenger';
import { fixEncoding } from './parser';
import { getRecordedReactionTime, validReactionClock, type RecordedReactionTime, type ReactionEstimate, type ReactionGuessingMode } from './reactions';
import { assignReactionPairBlocks, findReactionActivityBoundaries, normalizeReactionEmoji, parseStrictReactionNoticeText, hasProtectedReactionPayload, isBroadReactionNoticeText, type ReactionActivityBoundary } from './reactionNoticeClassifier';
export const normalizeReactionName = (name: string) => fixEncoding(name).normalize('NFC').trim();
const groupKey = (actor: string, emoji: string) => JSON.stringify([actor, emoji]);
// These are the system-message forms emitted when the archive owner entered a
// group. Keep this deliberately narrow: an ordinary message must not change
// the recipient used for reaction matching.
const groupJoinNotice = /^(?:(?:.+?)\s+)?added you(?:\s+and\s+\d+\s+others?)?\s+to (?:the )?group[.!]?$|^you joined (?:the )?group[.!]?$/i;
export function getVerifiedMessageTime(msg: MessengerMessage): number | null {
  return !Object.hasOwn(msg, 'timestamp') && validReactionClock(msg.timestamp_ms) ? msg.timestamp_ms : null;
}
function authorOf(msg: MessengerMessage): string {
  const a = typeof msg.sender_name === 'string' ? normalizeReactionName(msg.sender_name) : '';
  const b = typeof msg.senderName === 'string' ? normalizeReactionName(msg.senderName) : '';
  return a && b && a !== b ? '' : a || b;
}
interface Target { mi: number; ri: number; t: number | null; author: string; key: string; time: RecordedReactionTime }
interface Notice { mi: number; t: number; key: string }
export interface CompactReactionThread {
  participants: string[]; targets: Target[]; notices: Notice[]; syntaxCount: number; hidingCandidates: number;
  messageCount: number; boundaries: ReactionActivityBoundary[]; joinBoundary: number | null; joinBoundaries: number[];
}
// Complete pending actor/emoji pairs beyond the activity cutoff, then close.
export function buildReactionBlocks(messages: MessengerMessage[], owner?: string): Int32Array {
  const compact = compactReactionThread({ messages } as MessengerThread);
  return assignReactionPairBlocks(compact.messageCount, compact.boundaries, compact.targets.filter(r => owner === undefined || r.author === owner), compact.notices);
}
export function compactReactionThread(data: MessengerThread): CompactReactionThread {
  const events = data.messages.map(msg => {
    const text = fixEncoding(msg.text || msg.content || '').trim();
    return { t: getVerifiedMessageTime(msg), notice: !!parseStrictReactionNoticeText(text), chars: text.length };
  });
  const out: CompactReactionThread = {
    participants: (data.participants || []).map(p => normalizeReactionName(p.name)).filter(Boolean), targets: [], notices: [], syntaxCount: 0, hidingCandidates: 0,
    messageCount: data.messages.length, boundaries: findReactionActivityBoundaries(events), joinBoundary: null, joinBoundaries: [],
  };
  data.messages.forEach((msg, mi) => {
    const t = getVerifiedMessageTime(msg), author = authorOf(msg);
    const text = fixEncoding(msg.text || msg.content || '');
    if (groupJoinNotice.test(text.trim()) && !hasProtectedReactionPayload(msg)) {
      if (out.joinBoundary === null) out.joinBoundary = mi;
      out.joinBoundaries.push(mi);
    }
    const parsed = parseStrictReactionNoticeText(text);
    if (!hasProtectedReactionPayload(msg) && isBroadReactionNoticeText(text)) out.hidingCandidates++;
    if (parsed) out.syntaxCount++;
    if (parsed && !hasProtectedReactionPayload(msg)) {
      if (t !== null && author) out.notices.push({ mi, t, key: groupKey(author, parsed.reaction) });
    }
    (msg.reactions || []).forEach((r, ri) => {
      const actor = normalizeReactionName(r.actor), emoji = normalizeReactionEmoji(fixEncoding(r.reaction));
      out.targets.push({ mi, ri, t, author, key: groupKey(actor, emoji), time: getRecordedReactionTime(r) });
    });
  });
  return out;
}
export function inferReactionOwner(threads: { participants: string[] }[]): string | null {
  const pairs = new Map<string, string[]>();
  for (const thread of threads) { const names = [...new Set(thread.participants)].sort(); if (names.length === 2) pairs.set(JSON.stringify(names), names); }
  if (pairs.size < 3) return null;
  const support = new Map<string, number>();
  for (const names of pairs.values()) for (const name of names) support.set(name, (support.get(name) || 0) + 1);
  const ordered = [...support].sort((a, b) => b[1] - a[1]);
  return ordered[0] && ordered[0][1] / pairs.size >= .95 && ordered[0][1] > (ordered[1]?.[1] || 0) ? ordered[0][0] : null;
}
function lower<T extends { t: number }>(items: T[], t: number): number {
  let lo = 0, hi = items.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (items[mid].t < t) lo = mid + 1; else hi = mid; }
  return lo;
}
type TimedTarget = Target & { t: number; block: number };
type BlockNotice = Notice & { block: number };
interface Group { rs: TimedTarget[]; ns: BlockNotice[]; incomplete: boolean }
export interface ThreadMatchingResult {
  estimates: ReactionEstimate[]; candidates: number; syntaxCount: number; hidingCandidates: number; usableNotices: number;
  suppressedGroups: number; recordedDisagreements: number;
  associations: { recorded: number; strict: number; local: number; cross: number };
}
function emptyResult(thread: CompactReactionThread): ThreadMatchingResult {
  return {
    estimates: [], candidates: 0, syntaxCount: thread.syntaxCount, hidingCandidates: thread.hidingCandidates, usableNotices: thread.notices.length,
    suppressedGroups: 0, recordedDisagreements: 0, associations: { recorded: 0, strict: 0, local: 0, cross: 0 },
  };
}
// Match one recipient in one contiguous part of a thread. Keeping the existing
// matcher intact at this level makes historical and current recipients obey the
// same recorded, local, cross-block, and ambiguity rules.
function matchRecipientSegment(thread: CompactReactionThread, recipient: string, mode: ReactionGuessingMode, start = 0, end = thread.messageCount): ThreadMatchingResult {
  const inSegment = (mi: number) => mi >= start && mi < end;
  const out = emptyResult(thread);
  if (mode === 'off') return out;
  const noticesInSegment = thread.notices.filter(n => inSegment(n.mi));
  const targetsInSegment = thread.targets.filter(r => inSegment(r.mi));
  const blocks = assignReactionPairBlocks(thread.messageCount, thread.boundaries, targetsInSegment.filter(r => r.author === recipient), noticesInSegment);
  const groups = new Map<string, Group>();
  const group = (key: string) => { let g = groups.get(key); if (!g) { g = { rs: [], ns: [], incomplete: false }; groups.set(key, g); } return g; };
  for (const n of noticesInSegment) group(n.key).ns.push({ ...n, block: blocks[n.mi] });
  const latestNotice = new Map<string, number>();
  for (const n of noticesInSegment) latestNotice.set(n.key, Math.max(n.t, latestNotice.get(n.key) || 0));
  for (const r of targetsInSegment) {
    const g = group(r.key);
    if (r.author === recipient) { if (r.t === null) g.incomplete = true; else g.rs.push({ ...r, t: r.t, block: blocks[r.mi] }); }
    else if (!r.author && latestNotice.has(r.key) && (r.t === null || r.t < latestNotice.get(r.key)!)) g.incomplete = true;
  }
  for (const g of groups.values()) {
    g.rs.sort((a, b) => a.t - b.t || a.mi - b.mi || a.ri - b.ri);
    g.ns.sort((a, b) => a.t - b.t || a.mi - b.mi);
    for (const n of g.ns) if (lower(g.rs, n.t) > 0) out.candidates++;
    if (g.incomplete) { out.suppressedGroups++; continue; }
    const usedR = new Set<Target>(), usedN = new Set<Notice>();
    const reserve = (n: Notice, r: Target, method: ReactionEstimate['method']) => {
      usedR.add(r); usedN.add(n);
      out.associations[method]++;
      if (r.time.kind === 'recorded' && (n.t < r.time.ms || n.t >= r.time.end)) out.recordedDisagreements++;
      if (r.time.kind === 'missing') out.estimates.push({ messageIndex: r.mi, reactionIndex: r.ri, noticeIndex: n.mi, timestamp: n.t, method });
    };
    const recorded = new Map<number, TimedTarget[]>(), notices = new Map<number, BlockNotice[]>();
    for (const r of g.rs) if (r.time.kind === 'recorded') { const key = Math.floor(r.time.ms / 1000); if (!recorded.has(key)) recorded.set(key, []); recorded.get(key)!.push(r); }
    for (const n of g.ns) { const key = Math.floor(n.t / 1000); if (!notices.has(key)) notices.set(key, []); notices.get(key)!.push(n); }
    const recordedPairs: [BlockNotice, TimedTarget][] = [];
    for (const n of g.ns) {
      const bucket = recorded.get(Math.floor(n.t / 1000)) || [];
      if (lower(bucket, n.t) !== 1) continue;
      const r = bucket[0], ns = notices.get(Math.floor(n.t / 1000))!;
      if (ns.length - lower(ns, r.t + 1) === 1) recordedPairs.push([n, r]);
    }
    for (const [n, r] of recordedPairs) { usedR.add(r); usedN.add(n); out.associations.recorded++; }
    const rs = g.rs.filter(r => !usedR.has(r)), ns = g.ns.filter(n => !usedN.has(n));
    const strictPairs: [BlockNotice, TimedTarget][] = [];
    for (const n of ns) if (lower(rs, n.t) === 1 && ns.length - lower(ns, rs[0].t + 1) === 1) strictPairs.push([n, rs[0]]);
    for (const [n, r] of strictPairs) reserve(n, r, 'strict');
    const process = (targets: TimedTarget[], pending: BlockNotice[], method: 'local' | 'cross') => {
      const parent = Int32Array.from({ length: targets.length + 1 }, (_, i) => i);
      const find = (x: number): number => { let root = x; while (parent[root] !== root) root = parent[root]; while (parent[x] !== x) { const next = parent[x]; parent[x] = root; x = next; } return root; };
      targets.forEach((r, i) => { if (usedR.has(r)) parent[i + 1] = find(i); });
      for (const n of pending) {
        if (usedN.has(n)) continue;
        let p = find(lower(targets, n.t));
        if (method === 'cross') {
          let lo = 0, hi = targets.length;
          while (lo < hi) { const mid = (lo + hi) >>> 1; if (targets[mid].block < n.block) lo = mid + 1; else hi = mid; }
          p = find(Math.min(lower(targets, n.t), lo));
        }
        if (p === 0) continue;
        const r = targets[p - 1], prev = find(p - 1);
        if (prev > 0 && targets[prev - 1].t === r.t && (method === 'local' || targets[prev - 1].block < n.block)) continue;
        reserve(n, r, method); parent[p] = find(p - 1);
      }
    };
    const local = new Map<number, { rs: TimedTarget[]; ns: BlockNotice[] }>();
    const byBlock = (b: number) => { if (!local.has(b)) local.set(b, { rs: [], ns: [] }); return local.get(b)!; };
    for (const r of g.rs) byBlock(r.block).rs.push(r);
    for (const n of g.ns) byBlock(n.block).ns.push(n);
    for (const block of local.values()) process(block.rs, [...block.ns].reverse(), 'local');
    if (mode === 'aggressive') process(g.rs, g.ns, 'cross');
  }
  return out;
}
function associationCount(result: ThreadMatchingResult): number {
  return result.associations.recorded + result.associations.strict + result.associations.local + result.associations.cross;
}
interface HistoricalSegment { recipient: string; boundary: number }
function inferHistoricalRecipient(thread: CompactReactionThread, owner: string, mode: ReactionGuessingMode): HistoricalSegment | null {
  if (!thread.joinBoundaries.length || mode === 'off') return null;
  const supported: (HistoricalSegment & { matches: number; coverage: number })[] = [];
  for (const boundary of thread.joinBoundaries) {
    if (boundary === 0) continue;
    const notices = thread.notices.filter(n => n.mi < boundary);
    if (!notices.length) continue;
    const latestNotice = new Map<string, number>();
    for (const n of notices) latestNotice.set(n.key, Math.max(n.t, latestNotice.get(n.key) || 0));
    // Consider only people with a reaction that could actually precede one of the
    // historical notices. This avoids work (and accidental inference) from every
    // participant in a large group.
    const authors = new Set<string>();
    for (const r of thread.targets) {
      if (r.mi < boundary && r.author && r.author !== owner && r.t !== null && (latestNotice.get(r.key) || 0) > r.t) authors.add(r.author);
    }
    const candidates = [...authors].map(author => ({ author, result: matchRecipientSegment(thread, author, mode, 0, boundary) }))
      .map(candidate => ({ ...candidate, matches: associationCount(candidate.result) }))
      .sort((a, b) => b.matches - a.matches || a.author.localeCompare(b.author));
    const best = candidates[0], next = candidates[1];
    // A single coincidental pair is not enough to reinterpret “your message”.
    // The observed exports have near-complete agreement; requiring 75% gives a
    // little room for unsupported notices while keeping that interpretation safe.
    if (!best || best.matches < 2 || best.matches / notices.length < .75 || best.matches === next?.matches) continue;
    supported.push({ recipient: best.author, boundary, matches: best.matches, coverage: best.matches / notices.length });
  }
  // A typed lookalike can precede the real system entry notice. Prefer the
  // boundary with the most corroborating history, then its coverage, rather
  // than allowing the first matching sentence to truncate that history.
  supported.sort((a, b) => b.matches - a.matches || b.coverage - a.coverage || b.boundary - a.boundary || a.recipient.localeCompare(b.recipient));
  return supported[0] || null;
}
function combineSegments(thread: CompactReactionThread, segments: ThreadMatchingResult[]): ThreadMatchingResult {
  const out: ThreadMatchingResult = {
    estimates: [], candidates: 0, syntaxCount: thread.syntaxCount, hidingCandidates: thread.hidingCandidates, usableNotices: thread.notices.length,
    suppressedGroups: 0, recordedDisagreements: 0, associations: { recorded: 0, strict: 0, local: 0, cross: 0 },
  };
  for (const segment of segments) {
    out.estimates.push(...segment.estimates);
    out.candidates += segment.candidates;
    out.suppressedGroups += segment.suppressedGroups;
    out.recordedDisagreements += segment.recordedDisagreements;
    out.associations.recorded += segment.associations.recorded;
    out.associations.strict += segment.associations.strict;
    out.associations.local += segment.associations.local;
    out.associations.cross += segment.associations.cross;
  }
  return out;
}
export function matchReactionThread(thread: CompactReactionThread, owner: string, mode: ReactionGuessingMode): ThreadMatchingResult {
  if (mode === 'off') return emptyResult(thread);
  const historical = inferHistoricalRecipient(thread, owner, mode);
  if (historical === null) return matchRecipientSegment(thread, owner, mode);
  return combineSegments(thread, [
    matchRecipientSegment(thread, historical.recipient, mode, 0, historical.boundary),
    matchRecipientSegment(thread, owner, mode, historical.boundary),
  ]);
}
