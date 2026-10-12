import type { AttachmentReferenceScan } from '../../services/attachmentReferenceIndex';
import { CalculationProgressBar } from '../CalculationProgressBar';

/** Progress updates stay separate from chat and thumbnail rendering. */
export function AttachmentScanStatus({ scan }: { scan: AttachmentReferenceScan }) {
  return (
    <div className="sidebar-attachment-scan" role="status" aria-label="Shared attachment scan">
      <div className="sidebar-attachment-scan-heading">
        <span>Checking shared attachments</span>
      </div>
      {scan.progress && <CalculationProgressBar source={scan.progress} label="Shared attachment calculation progress" />}
    </div>
  );
}
