import { describe, expect, it } from 'vitest';
import { formatMessageDateTime } from '../src/services/dateTime';

describe('message date formatting', () => {
  it('keeps the existing locale and time zone presentation', () => {
    const timestamp = 1_700_000_000_000;
    expect(formatMessageDateTime(timestamp)).toBe(new Date(timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }));
  });

  it('does not crash a message row with an out-of-range imported timestamp', () => {
    expect(formatMessageDateTime(1e20)).toBe('Invalid Date');
  });
});
