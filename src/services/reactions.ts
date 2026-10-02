import type { MessengerMessage, Reaction } from '../types/messenger';
import { fixEncoding } from './parser';
import { hasProtectedReactionPayload, isBroadReactionNoticeText } from './reactionNoticeClassifier';
import { formatMessageDateTime } from './dateTime';
const noticeCache = new WeakMap<MessengerMessage, boolean>();
export function isReactionNoticeMessage(msg: MessengerMessage): boolean {
  const cached = noticeCache.get(msg);
  if (cached !== undefined) return cached;
  const value = isBroadReactionNoticeText(fixEncoding(msg.text || msg.content || '')) && !hasProtectedReactionPayload(msg);
  noticeCache.set(msg, value);
  return value;
}
export const MAX_REACTION_TIME = 8_640_000_000_000_000;
export function validReactionClock(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= MAX_REACTION_TIME;
}
export type RecordedReactionTime = { kind: 'missing' | 'invalid' } | { kind: 'recorded'; ms: number; end: number };
export function getRecordedReactionTime(reaction: Reaction): RecordedReactionTime {
  if (!Object.hasOwn(reaction, 'timestamp') && !Object.hasOwn(reaction, 'timestamp_ms')) return { kind: 'missing' };
  if (Object.hasOwn(reaction, 'timestamp_ms') || !validReactionClock(reaction.timestamp) || !validReactionClock(reaction.timestamp * 1000)) return { kind: 'invalid' };
  const ms = reaction.timestamp * 1000;
  return { kind: 'recorded', ms, end: Math.min(ms + 1000, MAX_REACTION_TIME + 1) };
}
export function getReactionTimestamp(reaction: Reaction, standalone = false): number {
  if (standalone) { const value = reaction.timestamp_ms ?? reaction.timestamp; return validReactionClock(value) ? value : 0; }
  const time = getRecordedReactionTime(reaction);
  return time.kind === 'recorded' ? time.ms : 0;
}
export type ReactionGuessingMode = 'off' | 'near' | 'aggressive';
export interface ReactionEstimate {
  messageIndex: number; reactionIndex: number; noticeIndex: number; timestamp: number; method: 'strict' | 'local' | 'cross';
}
export function formatReactionTime(timestamp: number, method?: ReactionEstimate['method']): string {
  if (!timestamp) return '';
  return `${method === 'cross' ? '~~ ' : method ? '~ ' : ''}${formatMessageDateTime(timestamp)}`;
}
