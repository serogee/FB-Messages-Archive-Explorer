import { useCallback, useEffect, useRef, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { storageGet, storageRemove, storageSet } from '../services/storage';

const DEFERRED_UPDATE_KEY = 'pwaUpdateDeferred';

interface ReloadPromptProps {
  canAutoReload: boolean;
}

export function ReloadPrompt({ canAutoReload }: ReloadPromptProps) {
  const autoReloadStarted = useRef(false);
  const [autoReloadFailed, setAutoReloadFailed] = useState(false);
  const [updateDeferred, setUpdateDeferred] = useState(
    () => storageGet(DEFERRED_UPDATE_KEY) === '1'
  );
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError(error) {
      console.error('Service worker registration failed:', error);
    },
  });

  const deferUpdate = useCallback(() => {
    storageSet(DEFERRED_UPDATE_KEY, '1');
    setUpdateDeferred(true);
    setNeedRefresh(false);
  }, [setNeedRefresh]);

  const acceptUpdate = useCallback(() => {
    storageRemove(DEFERRED_UPDATE_KEY);
    setUpdateDeferred(false);
    void updateServiceWorker(true);
  }, [updateServiceWorker]);

  useEffect(() => {
    if (!updateDeferred || !('serviceWorker' in navigator)) return;
    void navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL).then(registration => {
      if (registration?.waiting) return;
      storageRemove(DEFERRED_UPDATE_KEY);
      setUpdateDeferred(false);
    });
  }, [updateDeferred]);

  useEffect(() => {
    if (!offlineReady || needRefresh) return;
    const timer = window.setTimeout(() => setOfflineReady(false), 10_000);
    return () => window.clearTimeout(timer);
  }, [needRefresh, offlineReady, setOfflineReady]);

  useEffect(() => {
    if (!needRefresh || (canAutoReload && !updateDeferred)) return;
    const timer = window.setTimeout(deferUpdate, 10_000);
    return () => window.clearTimeout(timer);
  }, [canAutoReload, deferUpdate, needRefresh, updateDeferred]);

  useEffect(() => {
    if (!needRefresh || !canAutoReload || updateDeferred || autoReloadStarted.current) return;
    autoReloadStarted.current = true;
    void updateServiceWorker(true).catch(error => {
      console.error('Automatic service worker update failed:', error);
      setAutoReloadFailed(true);
    });
  }, [canAutoReload, needRefresh, updateDeferred, updateServiceWorker]);

  if (needRefresh && canAutoReload && !updateDeferred && !autoReloadFailed) return null;

  if (needRefresh) {
    return (
      <div className="pwa-toast" role="status" aria-live="polite">
        <span>A new version is available.</span>
        <div className="pwa-toast-actions">
          <button className="btn btn-primary" type="button" onClick={acceptUpdate}>
            Reload
          </button>
          <button className="btn btn-secondary" type="button" onClick={deferUpdate}>
            Later
          </button>
        </div>
      </div>
    );
  }

  if (!offlineReady) return null;

  return (
    <div className="pwa-toast" role="status" aria-live="polite">
      <span>Ready for offline use</span>
      <button
        className="btn btn-secondary"
        type="button"
        aria-label="Dismiss offline-ready notification"
        onClick={() => setOfflineReady(false)}
      >
        Dismiss
      </button>
    </div>
  );
}
