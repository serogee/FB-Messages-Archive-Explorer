import type { MessengerMessage } from '../types/messenger';
import { fixEncoding } from './parser';

const BUMPED_MESSAGE_LABEL = 'Bumped a message';
const UNKNOWN_BUMPED_MESSAGE_LABEL = 'Bumped a message: Unknown';

export function getMessageBump(message: MessengerMessage): { text: string; label: string } | null {
  if (message.is_unsent || message.bumped_message_metadata?.is_bumped !== true) return null;
  const quote = message.bumped_message_metadata.bumped_message;
  const text = typeof quote === 'string' ? fixEncoding(quote).trim() : '';
  // Formatting characters alone do not supply a visible quote.
  const hasQuote = /[^\s\p{Cf}\uFE00-\uFE0F\u{E0100}-\u{E01EF}\u2800]/u.test(text);
  return { text: hasQuote ? text : '', label: hasQuote ? BUMPED_MESSAGE_LABEL : UNKNOWN_BUMPED_MESSAGE_LABEL };
}
