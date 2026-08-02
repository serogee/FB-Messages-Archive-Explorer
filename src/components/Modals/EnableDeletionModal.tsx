interface EnableDeletionModalProps {
  onConfirm: () => void;
  onCancel: () => void;
}

export function EnableDeletionModal({ onConfirm, onCancel }: EnableDeletionModalProps) {
  return (
    <div className="delete-modal" role="dialog" aria-modal="true" aria-labelledby="enableDelTitle">
      <div className="delete-backdrop" onClick={onCancel} />
      <div className="delete-card">
        <h3 id="enableDelTitle">Enable chat deletion?</h3>
        <div className="delete-warning">
          <strong>This lets you choose chat folders to delete from your storage.</strong>
        </div>
        <p className="delete-meta" style={{ lineHeight: 1.6 }}>
          When enabled, a <em>Delete chat</em> option will appear on each conversation.
          Deleting a chat removes its folder and all its files — messages, photos, videos,
          and audio — directly from your device.<br /><br />
          <strong style={{ color: 'var(--text)' }}>Once deleted, the files cannot be recovered.</strong> There is no
          recycle bin or recovery option. Make sure you have a backup before deleting anything.
        </p>
        <div className="delete-actions">
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn-danger" onClick={onConfirm} id="enableDelConfirmBtn">
            I understand, enable deletion
          </button>
        </div>
      </div>
    </div>
  );
}
