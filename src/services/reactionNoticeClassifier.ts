// Shared pure classifier for browsing, worker matching and sample evaluation.
const wording = /^(?:.+?\s+)?reacted\s+(.+?)\s+to your message(?:[.!:].*)?$/i;
const strictWording = /^(?:.+?\s+)?reacted\s+(.+?)\s+to your message[.!:]?$/i;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const BLOCK_CLASSIFIER_VERSION = 'block-notice-strict-v3-pairs';
export interface ReactionBlockEvent { t: number | null; notice: boolean; chars: number }
export interface ReactionActivityBoundary { mi: number; hard: boolean }
export interface ReactionBlockRecord { mi: number; t: number | null; key: string }
export function findReactionActivityBoundaries(events: ReactionBlockEvent[], preset = { sessionGapMs: 30 * 60_000, maxOrdinary: 50, maxChars: 20_000 }): ReactionActivityBoundary[] {
  const boundaries: ReactionActivityBoundary[] = [];
  let ordinary = 0, chars = 0, previousTime: number | null = null;
  events.forEach((event, i) => {
    const hard = event.t === null || previousTime === null;
    if (i > 0 && (hard || event.t! - previousTime! > preset.sessionGapMs ||
        (!event.notice && (ordinary >= preset.maxOrdinary || chars >= preset.maxChars)))) {
      boundaries.push({ mi: i, hard }); ordinary = 0; chars = 0;
    }
    if (!event.notice) { ordinary++; chars += event.chars; }
    previousTime = event.t;
  });
  return boundaries;
}
// Freeze the original boundaries before counting pairs. Extension admits only
// notices and ordinary conversation; new reaction targets start the next block.
export function assignReactionPairBlocks(messageCount: number, boundaries: ReactionActivityBoundary[], reactions: ReactionBlockRecord[], notices: ReactionBlockRecord[]): Int32Array {
  const blocks = new Int32Array(messageCount);
  for (const boundary of boundaries) blocks[boundary.mi] = boundary.hard ? 2 : 1;
  const byMessage = new Map<number, ReactionBlockRecord[]>();
  for (const reaction of reactions) {
    if (!byMessage.has(reaction.mi)) byMessage.set(reaction.mi, []);
    byMessage.get(reaction.mi)!.push(reaction);
  }
  const byNotice = new Map(notices.map(notice => [notice.mi, notice]));
  const pending = new Map<string, { times: number[]; consumed: number }>();
  let block = 0, extending = false, closeNext = false;
  for (let mi = 0; mi < messageCount; mi++) {
    const boundary = blocks[mi], targets = byMessage.get(mi);
    if (mi > 0 && (closeNext || boundary === 2 || ((boundary === 1 || extending) && (!pending.size || targets)))) {
      block++; pending.clear(); extending = false; closeNext = false;
    } else if (boundary === 1 && pending.size) extending = true;
    blocks[mi] = block;
    for (const target of targets || []) {
      if (target.t === null) continue;
      if (!pending.has(target.key)) pending.set(target.key, { times: [], consumed: 0 });
      pending.get(target.key)!.times.push(target.t);
    }
    const notice = byNotice.get(mi), queue = notice && pending.get(notice.key);
    if (notice && notice.t !== null && queue && queue.times[queue.consumed] < notice.t) {
      queue.consumed++;
      if (queue.consumed === queue.times.length) pending.delete(notice.key);
    }
    if (extending && !pending.size) closeNext = true;
  }
  return blocks;
}
export function assignReactionActivityBlocks(events: ReactionBlockEvent[], preset = { sessionGapMs: 30 * 60_000, maxOrdinary: 50, maxChars: 20_000 }, reactions: ReactionBlockRecord[] = [], notices: ReactionBlockRecord[] = []): Int32Array {
  return assignReactionPairBlocks(events.length, findReactionActivityBoundaries(events, preset), reactions, notices);
}
export function normalizeReactionEmoji(value: string): string {
  return value.normalize('NFC').replace(/[\uFE0E\uFE0F]/g, '').trim();
}
export function parseStrictReactionNoticeText(text: string): { reaction: string } | null {
  const match = text.trim().match(strictWording);
  if (!match) return null;
  const reaction = normalizeReactionEmoji(match[1]);
  if ([...graphemes.segment(reaction)].length !== 1 || !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(reaction)) return null;
  return { reaction };
}
export function isBroadReactionNoticeText(text: string): boolean { return wording.test(text.trim()); }
export function hasProtectedReactionPayload(message: object): boolean {
  const raw = message as Record<string, unknown>;
  if (/\bhttps?:\/\/\S+/i.test(String(raw.text || raw.content || ''))) return true;
  return ['photos', 'videos', 'audio', 'audio_files', 'gifs', 'files', 'media', 'sticker', 'share', 'links', 'link', 'href', 'reactions']
    .some(key => Object.hasOwn(raw, key) && (!Array.isArray(raw[key]) || raw[key].length > 0));
}
