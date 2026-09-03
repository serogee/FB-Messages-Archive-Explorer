import { useEffect } from 'react';

interface BulkSelectionConfirmModalProps {
  count: number;
  action: 'select' | 'deselect';
  onConfirm: () => void;
  onCancel: () => void;
}

export function BulkSelectionConfirmModal({ count, action, onConfirm, onCancel }: BulkSelectionConfirmModalProps) {
  const isDeselecting = action === 'deselect';

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
        <h3 id="bulkSelectionTitle">
          {isDeselecting ? 'Unselect' : 'Select'} {count.toLocaleString()} items?
        </h3>
        <p className="delete-warning">
          {isDeselecting
            ? 'This will remove a large number of items from the selection.'
            : 'This is a large selection and may make subsequent bookmark or download actions take longer.'}
        </p>
        <div className="delete-actions">
          <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" onClick={onConfirm} autoFocus>
            {isDeselecting ? 'Unselect all' : 'Select all'}
          </button>
        </div>
      </div>
    </div>
  );
}
