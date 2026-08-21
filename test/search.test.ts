import { beforeAll, describe, expect, it } from 'vitest';
import type * as searchModule from '../src/services/search';
import type { MessengerMessage } from '../src/types/messenger';

let search: typeof searchModule;

beforeAll(async () => {
  Object.defineProperty(globalThis, 'window', {
    value: { location: { hostname: 'test' } },
    configurable: true,
  });
  search = await import('../src/services/search');
});

describe('search service', () => {
  it('normalizes case, whitespace, and diacritics', () => {
    expect(search.normalizeForSearch('  Cafe\u0301   AU   LAIT  ')).toBe('cafe au lait');
  });

  it('highlights matches and escapes HTML', () => {
    expect(search.highlightText('<script>cafe</script>', 'cafe')).toBe(
      '&lt;script&gt;<span class="search-highlight">cafe</span>&lt;/script&gt;'
    );
  });

  it('builds an index from text and attachment names', () => {
    const messages: MessengerMessage[] = [
      {
        sender_name: 'Alice',
        timestamp_ms: 1,
        content: 'hello',
        photos: [{ uri: 'photos/pic.jpg' }],
      },
      {
        sender_name: 'Bob',
        timestamp_ms: 2,
        content: 'Bob reacted \u{1f44d} to your message',
      },
    ];

    const index = search.buildSearchIndex(messages);
    expect(index).toHaveLength(1);
    expect(index[0].text).toContain('hello');
    expect(index[0].text).toContain('pic.jpg');
  });

  it('performs diacritic-insensitive searches', async () => {
    const index = search.buildSearchIndex([
      { sender_name: 'Alice', timestamp_ms: 1, content: 'café plans' },
    ]);

    const results = await search.performSearch('cafe', index);
    expect(results).toHaveLength(1);
  });

  it('respects already-aborted signals', async () => {
    const index = search.buildSearchIndex([
      { sender_name: 'Alice', timestamp_ms: 1, content: 'hello' },
    ]);
    const controller = new AbortController();
    controller.abort();

    await expect(search.performSearch('hello', index, undefined, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
