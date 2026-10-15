import { useEffect, useState, type ButtonHTMLAttributes } from 'react';
import { Check } from 'lucide-react';

export function ResetButton({ children = 'Reset', className = '', onClick, ...props }:
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'type'> & { children?: string }) {
  const [confirmation, setConfirmation] = useState(0);
  useEffect(() => {
    if (!confirmation) return;
    const timer = setTimeout(() => setConfirmation(0), 1600);
    return () => clearTimeout(timer);
  }, [confirmation]);

  return <button {...props} type="button" aria-label={props['aria-label'] ?? children}
    className={`btn btn-secondary reset-button ${className}`} data-confirmed={confirmation > 0}
    onClick={event => {
      onClick?.(event);
      if (!event.defaultPrevented) setConfirmation(previous => previous + 1);
    }}>
    <span className="reset-button-label">{children}</span>
    <span className="reset-button-confirmation" aria-hidden="true"><Check size={16} /></span>
    <span className="reset-button-status" role="status">{confirmation > 0 ? 'Reset to defaults.' : ''}</span>
  </button>;
}
