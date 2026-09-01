import type { MessengerMessage } from '../types/messenger';

export interface MessageLink {
  url: string;
  label?: string;
}

export const MESSAGE_URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;

const TRAILING_URL_PUNCTUATION = /[.,!?;:)\]}]$/;

export function trimTrailingUrlPunctuation(value: string): string {
  let trimmed = value;
  while (trimmed.length > 0 && TRAILING_URL_PUNCTUATION.test(trimmed)) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

export function normalizeExternalUrl(value: string): string | null {
  const candidate = /^www\./i.test(value) ? `https://${value}` : value;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

export function extractLinksFromText(text: string): MessageLink[] {
  const links: MessageLink[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  MESSAGE_URL_PATTERN.lastIndex = 0;

  while ((match = MESSAGE_URL_PATTERN.exec(text)) !== null) {
    const label = trimTrailingUrlPunctuation(match[0]);
    const url = normalizeExternalUrl(label);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    links.push({ url, label });
  }

  return links;
}

export function getMessageLinks(msg: MessengerMessage): MessageLink[] {
  const links: MessageLink[] = [];
  const seen = new Set<string>();
  const add = (link: MessageLink) => {
    if (seen.has(link.url)) return;
    seen.add(link.url);
    links.push(link);
  };

  const sharedUrl = normalizeExternalUrl((msg.share?.link || msg.share?.href || '').trim());
  if (sharedUrl) {
    const label = msg.share?.share_text?.trim();
    add({ url: sharedUrl, label: label || undefined });
  }

  const text = (msg.text || msg.content || '').trim();
  for (const link of extractLinksFromText(text)) add(link);

  return links;
}
