// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatRelativeTime } from '../src/services/storage';

describe('chat-list date formatting', () => {
  afterEach(() => vi.useRealTimers());

  it('includes the year for dates outside the current year', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 26, 12));

    expect(formatRelativeTime(new Date(2025, 6, 9, 12).getTime())).toBe('Jul 9, 2025');
  });

  it('omits the year for older dates in the current year', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 26, 12));

    expect(formatRelativeTime(new Date(2026, 6, 9, 12).getTime())).toBe('Jul 9');
  });
});
