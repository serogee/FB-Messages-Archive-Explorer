import { describe, expect, it } from 'vitest';
import { isAppPwaCache, PWA_CACHE_PREFIX } from '../src/services/pwa';

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
});
