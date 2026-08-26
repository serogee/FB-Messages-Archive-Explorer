import type { MessengerMessage, Reaction } from '../types/messenger';
import { fixEncoding } from './parser';
import { getMessageMediaItems } from './media';


function normalizeReactionValue(value: string): string {
  return String(value || '')
    .normalize('NFC')
    .replace(/[\uFE0E\uFE0F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function parseReactionNotice(
  msg: MessengerMessage
): { actor: string; reaction: string; timestamp: number } | null {
  if (!isReactionNoticeMessage(msg)) return null;
  const text = fixEncoding(msg?.text || msg?.content || '').trim();
  const match = text.match(/^(?:(.+?)\s+)?reacted\s+(.+?)\s+to your message(?:[.:].*)?$/i);
  if (!match) return null;
  return {
    actor: (match[1] || msg.senderName || msg.sender_name || '').trim(),
    reaction: (match[2] || '').trim(),
    timestamp: msg.timestamp_ms || msg.timestamp || 0,
  };
}


export function isReactionNoticeMessage(msg: MessengerMessage): boolean {
  if (typeof msg._isReactionNotice === 'boolean') return msg._isReactionNotice;

  const text = fixEncoding(msg?.text || msg?.content || '').trim();
  if (!text) {
    msg._isReactionNotice = false;
    return false;
  }
  if (getMessageMediaItems(msg).length > 0) {
    msg._isReactionNotice = false;
    return false;
  }

  msg._isReactionNotice = /^(?:.+?\s+)?reacted\s+.+?\s+to your message(?:[.:].*)?$/i.test(text);
  return msg._isReactionNotice;
}

export async function enrichReactionTimestamps(
  messages: MessengerMessage[],
  onProgress?: (progress: number) => void,
  signal?: AbortSignal
): Promise<void> {
  if (!Array.isArray(messages)) return;

  let lastYieldTime = performance.now();
  const total = messages.length;

  for (let index = 0; index < total; index++) {
    if (signal?.aborted) return;

    if (performance.now() - lastYieldTime > 16) {
      if (onProgress) onProgress(index / total);
      await new Promise(r => setTimeout(r, 0));
      lastYieldTime = performance.now();
      if (signal?.aborted) return;
    }

    const msg = messages[index];
    const notice = parseReactionNotice(msg);
    if (!notice || !notice.timestamp || !notice.reaction) continue;

    for (let i = index - 1; i >= 0; i--) {
      const target = messages[i];
      if (!target || isReactionNoticeMessage(target) || !Array.isArray(target.reactions)) continue;

      const noticeActor = normalizeReactionValue(notice.actor);
      const noticeReaction = normalizeReactionValue(notice.reaction);

      let match: Reaction | undefined = target.reactions.find(r => {
        const sameActor = !noticeActor || normalizeReactionValue(r.actor) === noticeActor;
        return sameActor && normalizeReactionValue(r.reaction) === noticeReaction && !getReactionTimestamp(r);
      });

      if (!match) {
        match = target.reactions.find(r =>
          normalizeReactionValue(r.reaction) === noticeReaction && !getReactionTimestamp(r)
        );
      }

      if (match) {
        match.__timestamp = notice.timestamp;
        break;
      }
    }
  }
}

export function getReactionTimestamp(reaction: Reaction): number {
  return reaction?.timestamp || reaction?.timestamp_ms || reaction?.__timestamp || 0;
}
