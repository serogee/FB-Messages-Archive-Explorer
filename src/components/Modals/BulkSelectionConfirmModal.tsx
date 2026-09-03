import { useEffect } from 'react';

interface BulkSelectionConfirmModalProps {
  count: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export function BulkSelectionConfirmModal({ count, onConfirm, onCancel }: BulkSelectionConfirmModalProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  return (
    <div className="delete-modal" role="dialog" aria-modal="true" aria-labelledby="bulkSelectionTitle">
      <div className="delete-backdrop" onClick={onCancel} />
      <div className="delete-card">
        <h3 id="bulkSelectionTitle">Add {count.toLocaleString()} items to the selection?</h3>
        <p className="delete-warning">
          This is a large selection and may make subsequent bookmark or download actions take longer.
        </p>
        <div className="delete-actions">
          <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" onClick={onConfirm} autoFocus>Add all</button>
        </div>
      </div>
    </div>
  );
}
