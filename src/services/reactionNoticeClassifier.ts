// Shared pure classifier for browsing, worker matching and sample evaluation.
const broadNoticeWording = /^(?:.+?\s+)?reacted\s+(.+?)\s+to your message(?:[.!:].*)?$/i;
const strictNoticeWording = /^(?:.+?\s+)?reacted\s+(.+?)\s+to your message[.!:]?$/i;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const BLOCK_CLASSIFIER_VERSION = 'block-notice-strict-v3-pairs';

// Keep compact field names shared with matching and worker records.
export interface ReactionBlockEvent {
  t: number | null;
  notice: boolean;
  chars: number;
}
export interface ReactionActivityBoundary {
  mi: number;
  hard: boolean;
}
export interface ReactionBlockRecord {
  mi: number;
  t: number | null;
  key: string;
}

export function findReactionActivityBoundaries(events: ReactionBlockEvent[], preset = { sessionGapMs: 30 * 60_000, maxOrdinary: 50, maxChars: 20_000 }): ReactionActivityBoundary[] {
  const boundaries: ReactionActivityBoundary[] = [];
  let ordinaryMessageCount = 0;
  let ordinaryCharacterCount = 0;
  let previousTimestamp: number | null = null;
  events.forEach((event, messageIndex) => {
    const isHardBoundary = event.t === null || previousTimestamp === null;
    const startsNewActivityBlock = messageIndex > 0 && (
      isHardBoundary || event.t! - previousTimestamp! > preset.sessionGapMs ||
      (!event.notice && (ordinaryMessageCount >= preset.maxOrdinary || ordinaryCharacterCount >= preset.maxChars))
    );
    if (startsNewActivityBlock) {
      boundaries.push({ mi: messageIndex, hard: isHardBoundary });
      ordinaryMessageCount = 0;
      ordinaryCharacterCount = 0;
    }
    if (!event.notice) {
      ordinaryMessageCount++;
      ordinaryCharacterCount += event.chars;
    }
    previousTimestamp = event.t;
  });
  return boundaries;
}

// Freeze the original boundaries before counting pairs. Extension admits only
// notices and ordinary conversation; new reaction targets start the next block.
export function assignReactionPairBlocks(messageCount: number, boundaries: ReactionActivityBoundary[], reactions: ReactionBlockRecord[], notices: ReactionBlockRecord[]): Int32Array {
  const blockAssignments = new Int32Array(messageCount);
  // The same array holds boundary markers until each message gets its block ID.
  for (const boundary of boundaries) blockAssignments[boundary.mi] = boundary.hard ? 2 : 1;
  const reactionsByMessage = new Map<number, ReactionBlockRecord[]>();
  for (const reaction of reactions) {
    if (!reactionsByMessage.has(reaction.mi)) reactionsByMessage.set(reaction.mi, []);
    reactionsByMessage.get(reaction.mi)!.push(reaction);
  }
  const noticesByMessage = new Map(notices.map(notice => [notice.mi, notice]));
  const pendingPairs = new Map<string, { times: number[]; consumed: number }>();
  let blockIndex = 0;
  let extendingBlock = false;
  let closeBeforeNextMessage = false;
  for (let messageIndex = 0; messageIndex < messageCount; messageIndex++) {
    const boundaryMarker = blockAssignments[messageIndex];
    const messageReactions = reactionsByMessage.get(messageIndex);
    const startsNewPairBlock = messageIndex > 0 && (
      closeBeforeNextMessage || boundaryMarker === 2 ||
      ((boundaryMarker === 1 || extendingBlock) && (!pendingPairs.size || messageReactions))
    );
    if (startsNewPairBlock) {
      blockIndex++;
      pendingPairs.clear();
      extendingBlock = false;
      closeBeforeNextMessage = false;
    } else if (boundaryMarker === 1 && pendingPairs.size) extendingBlock = true;
    blockAssignments[messageIndex] = blockIndex;
    for (const target of messageReactions || []) {
      if (target.t === null) continue;
      if (!pendingPairs.has(target.key)) pendingPairs.set(target.key, { times: [], consumed: 0 });
      pendingPairs.get(target.key)!.times.push(target.t);
    }
    const notice = noticesByMessage.get(messageIndex);
    const pendingPairQueue = notice && pendingPairs.get(notice.key);
    if (notice && notice.t !== null && pendingPairQueue && pendingPairQueue.times[pendingPairQueue.consumed] < notice.t) {
      pendingPairQueue.consumed++;
      if (pendingPairQueue.consumed === pendingPairQueue.times.length) pendingPairs.delete(notice.key);
    }
    if (extendingBlock && !pendingPairs.size) closeBeforeNextMessage = true;
  }
  return blockAssignments;
}

export function assignReactionActivityBlocks(events: ReactionBlockEvent[], preset = { sessionGapMs: 30 * 60_000, maxOrdinary: 50, maxChars: 20_000 }, reactions: ReactionBlockRecord[] = [], notices: ReactionBlockRecord[] = []): Int32Array {
  return assignReactionPairBlocks(events.length, findReactionActivityBoundaries(events, preset), reactions, notices);
}

export function normalizeReactionEmoji(value: string): string {
  return value.normalize('NFC').replace(/[\uFE0E\uFE0F]/g, '').trim();
}

export function parseStrictReactionNoticeText(text: string): { reaction: string } | null {
  const wordingMatch = text.trim().match(strictNoticeWording);
  if (!wordingMatch) return null;
  const reaction = normalizeReactionEmoji(wordingMatch[1]);
  const graphemeCount = [...graphemeSegmenter.segment(reaction)].length;
  if (graphemeCount !== 1 || !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(reaction)) return null;
  return { reaction };
}

export function isBroadReactionNoticeText(text: string): boolean {
  return broadNoticeWording.test(text.trim());
}

export function hasProtectedReactionPayload(message: object): boolean {
  const payload = message as Record<string, unknown>;
  if ((payload.bumped_message_metadata as { is_bumped?: unknown } | undefined)?.is_bumped === true) return true;
  if (/\bhttps?:\/\/\S+/i.test(String(payload.text || payload.content || ''))) return true;
  return ['photos', 'videos', 'audio', 'audio_files', 'gifs', 'files', 'media', 'sticker', 'share', 'links', 'link', 'href', 'reactions']
    .some(fieldName => Object.hasOwn(payload, fieldName) && (!Array.isArray(payload[fieldName]) || payload[fieldName].length > 0));
}
