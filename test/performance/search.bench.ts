import { beforeAll, bench, describe } from 'vitest';
import type * as searchModule from '../../src/services/search';
import { generateMessages } from './generatedData';

let search: typeof searchModule;
const messages = generateMessages(10_000);
let index: ReturnType<typeof searchModule.buildSearchIndex>;
const benchOptions = { time: 500, warmupTime: 100 };

beforeAll(async () => {
  Object.defineProperty(globalThis, 'window', {
    value: { location: { hostname: 'test' } },
    configurable: true,
  });
  search = await import('../../src/services/search');
  index = search.buildSearchIndex(messages);
});

describe('search performance', () => {
  bench('build search index for 10k messages', () => {
    search.buildSearchIndex(messages);
  }, benchOptions);

  bench('perform search over 10k indexed messages', async () => {
    await search.performSearch('archive search', index);
  }, benchOptions);
});
