import { useState, useRef, useEffect } from 'react';
interface HeaderMenuProps {
  onViewArchived: () => void;
  hasArchived: boolean;
  onViewRequests: () => void;
  hasRequests: boolean;
}

export function HeaderMenu({ onViewArchived, hasArchived, onViewRequests, hasRequests }: HeaderMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="header-menu-wrap" ref={wrapRef}>
      <button
        className="header-menu-btn"
        aria-label="More options"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
        title="More options"
      >
        ⋮
      </button>
      <div className={`header-menu-dropdown ${open ? '' : 'hidden'}`} role="menu">
        <button
          className="header-menu-item"
          role="menuitem"
          disabled={!hasArchived}
          onClick={() => { setOpen(false); onViewArchived(); }}
        >
          Archived threads
          {!hasArchived && <span style={{ marginLeft: 4, fontSize: 11, color: 'var(--muted)' }}>(none found)</span>}
        </button>
        <button
          className="header-menu-item"
          role="menuitem"
          disabled={!hasRequests}
          onClick={() => { setOpen(false); onViewRequests(); }}
        >
          Message requests
          {!hasRequests && <span style={{ marginLeft: 4, fontSize: 11, color: 'var(--muted)' }}>(none found)</span>}
        </button>
      </div>
    </div>
  );
}
