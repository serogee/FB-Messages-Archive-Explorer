import { describe, expect, it } from 'vitest';
import { GenerationScopedAsyncCache } from '../src/services/generationScopedAsyncCache';

describe('GenerationScopedAsyncCache', () => {
  it('shares one in-flight build for the same key and generation', async () => {
    const cache = new GenerationScopedAsyncCache<object, string>();
    const key = {};
    let builds = 0;
    let release: ((value: string) => void) | undefined;
    const build = () => {
      builds++;
      return new Promise<string>(resolve => { release = resolve; });
    };

    const first = cache.getOrCreate(key, 1, build, () => true);
    const second = cache.getOrCreate(key, 1, build, () => true);

    expect(second).toBe(first);
    expect(builds).toBe(1);
    release?.('shared');
    await expect(Promise.all([first, second])).resolves.toEqual(['shared', 'shared']);
    expect(cache.get(key, 1)).toBe('shared');
  });

  it('does not let an older generation overwrite the current cached value', async () => {
    const cache = new GenerationScopedAsyncCache<object, string>();
    const oldKey = {};
    const newKey = {};
    let currentGeneration = 1;
    let releaseOld: ((value: string) => void) | undefined;
    let releaseNew: ((value: string) => void) | undefined;

    const oldBuild = cache.getOrCreate(
      oldKey,
      1,
      () => new Promise<string>(resolve => { releaseOld = resolve; }),
      () => currentGeneration === 1
    );
    currentGeneration = 2;
    cache.clear();
    const newBuild = cache.getOrCreate(
      newKey,
      2,
      () => new Promise<string>(resolve => { releaseNew = resolve; }),
      () => currentGeneration === 2
    );

    releaseOld?.('old');
    await oldBuild;
    expect(cache.get(oldKey, 1)).toBeUndefined();

    releaseNew?.('new');
    await newBuild;
    expect(cache.get(newKey, 2)).toBe('new');
  });
});
