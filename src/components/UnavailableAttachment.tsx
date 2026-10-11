import { CircleAlert, FileX } from 'lucide-react';

interface UnavailableAttachmentProps {
  label: string;
  failedDownload?: boolean;
  className?: string;
  onActivate?: () => void;
}

/** A fixed-size icon; its surrounding slot retains the attachment's geometry. */
export function UnavailableAttachment({ label, failedDownload = false, className = '', onActivate }: UnavailableAttachmentProps) {
  const Icon = failedDownload ? CircleAlert : FileX;
  const classes = `unavailable-attachment ${className}`;
  const icon = <Icon size={24} aria-hidden="true" />;
  return onActivate ? (
    <button type="button" className={classes} aria-label={label} title={label} onClick={onActivate}>
      {icon}
    </button>
  ) : (
    <span className={classes} role="img" aria-label={label} title={label}>
      {icon}
    </span>
  );
}
