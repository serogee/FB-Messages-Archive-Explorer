// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disableOfflineSupport, isAppPwaCache, PWA_CACHE_PREFIX } from '../src/services/pwa';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('PWA cache ownership', () => {
  it('matches only cache names owned by this app', () => {
    expect(isAppPwaCache(`${PWA_CACHE_PREFIX}precache-v2-test`)).toBe(true);
    expect(isAppPwaCache('workbox-precache-v2-other-app')).toBe(false);
    expect(isAppPwaCache('fb-messages-archive-precache')).toBe(false);
  });

  it('matches the legacy Workbox cache only when it belongs to this app scope', () => {
    const scope = 'https://example.com/FB-Messages-Archive-Explorer/';
    expect(isAppPwaCache(`workbox-precache-v2-${scope}`, scope)).toBe(true);
    expect(isAppPwaCache('workbox-precache-v2-https://example.com/another-app/', scope)).toBe(false);
  });

  it('disables only this application service worker and caches', async () => {
    const expectedScope = new URL(import.meta.env.BASE_URL, window.location.origin).href;
    const unregisterOwned = vi.fn(async () => true);
    const unregisterOther = vi.fn(async () => true);
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistrations: vi.fn(async () => [
          { scope: expectedScope, unregister: unregisterOwned },
          { scope: 'https://example.com/another-app/', unregister: unregisterOther },
        ]),
      },
    });
    const deleteCache = vi.fn(async () => true);
    vi.stubGlobal('caches', {
      keys: vi.fn(async () => [
        `${PWA_CACHE_PREFIX}precache-current`,
        `workbox-precache-v2-${expectedScope}`,
        'workbox-precache-v2-https://example.com/another-app/',
        'unrelated-runtime-cache',
      ]),
      delete: deleteCache,
    });

    await disableOfflineSupport();

    expect(unregisterOwned).toHaveBeenCalledOnce();
    expect(unregisterOther).not.toHaveBeenCalled();
    expect(deleteCache.mock.calls.map(([name]) => name)).toEqual([
      `${PWA_CACHE_PREFIX}precache-current`,
      `workbox-precache-v2-${expectedScope}`,
    ]);
  });

  it('tolerates browsers without service worker and Cache APIs', async () => {
    vi.stubGlobal('navigator', {});
    Reflect.deleteProperty(window, 'caches');

    await expect(disableOfflineSupport()).resolves.toBeUndefined();
  });
});
