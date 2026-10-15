import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function SettingsInfoRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="shortcut-row">
      <span className="shortcut-keys"><kbd>{label}</kbd></span>
      <span>{children}</span>
    </div>
  );
}

export function SettingsInfoModal({ title, children, onClose }: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const trigger = document.activeElement;
    closeRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
      } else if (event.key === 'Tab') {
        const controls = cardRef.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex="0"]',
        );
        if (!controls?.length) return;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  return (
    <div className="shortcuts-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="shortcuts-backdrop" onClick={onClose} />
      <div ref={cardRef} className="shortcuts-card">
        <div className="shortcuts-header">
          <h3 id={titleId}>{title}</h3>
          <button ref={closeRef} type="button" className="shortcuts-close" onClick={onClose}
            aria-label={`Close ${title.toLowerCase()} information`}>
            <X size={18} />
          </button>
        </div>
        <div className="shortcuts-body settings-info-body" tabIndex={0}>{children}</div>
      </div>
    </div>
  );
}
