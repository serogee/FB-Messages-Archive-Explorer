import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatMessageDateTime, formatMessageSeparatorDate } from '../src/services/dateTime';

describe('message date formatting', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps the existing locale and time zone presentation', () => {
    const timestamp = 1_700_000_000_000;
    expect(formatMessageDateTime(timestamp)).toBe(new Date(timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }));
  });

  it('does not crash a message row with an out-of-range imported timestamp', () => {
    expect(formatMessageDateTime(1e20)).toBe('Invalid Date');
  });

  it('uses separator rules for hover and tap message dates', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 26, 12));
    const today = new Date(2026, 8, 26, 8, 5);
    const yesterday = new Date(2026, 8, 25, 8, 5);
    const thisYear = new Date(2026, 6, 9, 8, 5);
    const lastYear = new Date(2025, 6, 9, 8, 5);

    expect(formatMessageSeparatorDate(today.getTime())).toBe(today.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    expect(formatMessageSeparatorDate(yesterday.getTime())).toBe(`Yesterday, ${yesterday.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
    expect(formatMessageSeparatorDate(thisYear.getTime())).toBe(thisYear.toLocaleString([], {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }));
    expect(formatMessageSeparatorDate(lastYear.getTime())).toBe(lastYear.toLocaleString([], {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    }));
  });
});
