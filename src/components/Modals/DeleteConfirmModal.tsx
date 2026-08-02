import type { ChatListEntry } from '../../types/messenger';
import { formatFileSize } from '../../services/storage';

interface DeleteConfirmModalProps {
  entry: ChatListEntry;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteConfirmModal({ entry, onConfirm, onCancel }: DeleteConfirmModalProps) {
  return (
    <div className="delete-modal" role="dialog" aria-modal="true" aria-labelledby="deleteTitle">
      <div className="delete-backdrop" onClick={onCancel} />
      <div className="delete-card">
        <h3 id="deleteTitle">Delete Chat</h3>
        <div className="delete-warning">
          <strong>This action is permanent and cannot be undone.</strong>
        </div>
        <p className="delete-meta">
          <strong>{entry.title}</strong>
          {entry.folderSize > 0 && (
            <> &nbsp;·&nbsp; {formatFileSize(entry.folderSize)}</>
          )}
          <br />
          <span style={{ color: 'var(--muted)', fontSize: '12px' }}>Folder: {entry.folderName}</span>
        </p>
        <div className="delete-actions">
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn-danger" onClick={onConfirm} id="deleteConfirmBtn">
            Delete permanently
          </button>
        </div>
      </div>
    </div>
  );
}
