interface DisableOfflineModalProps {
  busy: boolean;
  onCancel: () => void;
  onDisable: () => void;
}

export function DisableOfflineModal({ busy, onCancel, onDisable }: DisableOfflineModalProps) {
  return (
    <div className="delete-modal" role="dialog" aria-modal="true" aria-labelledby="disableOfflineTitle">
      <div className="delete-backdrop" onClick={busy ? undefined : onCancel} />
      <div className="delete-card">
        <h3 id="disableOfflineTitle">Disable offline support?</h3>
        <div className="delete-warning">
          <strong>The cached copy of this app will be deleted.</strong>
        </div>
        <p className="delete-meta" style={{ lineHeight: 1.6 }}>
          This browser will stop storing app files for offline use. Your messages and attachments will not be
          deleted. You will need an internet connection to reload the app and may need one to open chats after
          offline support is disabled.
        </p>
        <div className="delete-actions">
          <button className="btn btn-secondary" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn-danger" type="button" onClick={onDisable} disabled={busy}>
            {busy ? 'Disabling...' : 'Disable'}
          </button>
        </div>
      </div>
    </div>
  );
}
