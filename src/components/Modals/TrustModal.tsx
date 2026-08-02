import { useRef, useEffect } from 'react';
import type { Settings } from '../../hooks/useSettings';

interface TrustModalProps {
  settings: Settings;
  setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

export function TrustModal({ settings, setSetting }: TrustModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const checkboxRef = useRef<HTMLInputElement>(null);

  const isHidden = settings.dontShowTrustModal;

  const close = () => {
    if (checkboxRef.current?.checked) {
      setSetting('dontShowTrustModal', true as Settings['dontShowTrustModal']);
    }
    setSetting('dontShowTrustModal', true as Settings['dontShowTrustModal']);
  };

  useEffect(() => {
    if (!isHidden) {
      setTimeout(() => closeRef.current?.focus(), 60);
    }
  }, [isHidden]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isHidden) close();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  });

  if (isHidden) return null;

  return (
    <div className="trust-modal" role="dialog" aria-modal="true" aria-labelledby="trustTitle">
      <div className="trust-backdrop" onClick={close} />
      <div className="trust-card">
        <div className="trust-header">
          <h2 id="trustTitle">Privacy &amp; Trust Notice</h2>
        </div>
        <div className="trust-body">
          <p>
            This tool runs entirely in your browser. <strong>No data is uploaded anywhere.</strong>{' '}
            Your Facebook archive files stay on your device.
          </p>
          <p>
            To view your messages, you'll be asked to grant this page read access to a folder on
            your computer using the browser's native File System Access API. You can revoke
            access at any time by closing the tab or refreshing the page.
          </p>
          <p>
            If you enable chat deletion in settings, write access will be requested separately
            at that time.
          </p>
        </div>
        <div className="trust-row">
          <input type="checkbox" id="dontShowTrustModal" ref={checkboxRef} />
          <label htmlFor="dontShowTrustModal">Don't show this again</label>
        </div>
        <div className="trust-footer">
          <div />
          <div className="trust-actions">
            <button id="trustClose" ref={closeRef} className="btn btn-primary" onClick={close}>
              Got it
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
