// Date.toLocaleString constructs an Intl formatter each time. Message rows
// share one formatter using the browser's locale and time zone.
const dateTimeFormatter = new Intl.DateTimeFormat([], { dateStyle: 'medium', timeStyle: 'short' });

export function formatMessageDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? date.toString() : dateTimeFormatter.format(date);
}

/** Format a message date with the same relative rules as chat separators. */
export function formatMessageSeparatorDate(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return date.toString();

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const messageDay = new Date(timestamp);
  messageDay.setHours(0, 0, 0, 0);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (messageDay.getTime() === today.getTime()) return time;

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (messageDay.getTime() === yesterday.getTime()) return `Yesterday, ${time}`;

  return date.toLocaleString([], {
    weekday: 'short', month: 'short', day: 'numeric',
    ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
    hour: 'numeric', minute: '2-digit',
  });
}
