// Date.toLocaleString constructs an Intl formatter each time. Message rows
// share one formatter using the browser's locale and time zone.
const dateTimeFormatter = new Intl.DateTimeFormat([], { dateStyle: 'medium', timeStyle: 'short' });

export function formatMessageDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? date.toString() : dateTimeFormatter.format(date);
}
