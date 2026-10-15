import { LoaderCircle } from 'lucide-react';

export function LoadingLabel({ label, showSpinner = true }: { label: string; showSpinner?: boolean }) {
  return <span className="loading-label">
    {showSpinner && <span className="loading-spinner" aria-hidden="true"><LoaderCircle size={16} /></span>}
    <span>{label}<span className="loading-dots" aria-hidden="true">...</span></span>
  </span>;
}
