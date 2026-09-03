export const PWA_CACHE_PREFIX = 'fb-messages-archive-explorer-';

export function isAppPwaCache(cacheName: string, scope = ''): boolean {
  if (cacheName.startsWith(PWA_CACHE_PREFIX)) return true;
  // Remove precaches created before this app received its unique cache ID.
  return !!scope && cacheName.startsWith('workbox-precache-') && cacheName.endsWith(scope);
}

export async function disableOfflineSupport(): Promise<void> {
  const expectedScope = new URL(import.meta.env.BASE_URL, window.location.origin).href;

  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      registrations
        .filter(registration => registration.scope === expectedScope)
        .map(registration => registration.unregister())
    );
  }

  if ('caches' in window) {
    const cacheNames = await window.caches.keys();
    await Promise.all(
      cacheNames
        .filter(cacheName => isAppPwaCache(cacheName, expectedScope))
        .map(cacheName => window.caches.delete(cacheName))
    );
  }
}
