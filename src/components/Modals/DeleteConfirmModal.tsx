import type { ChatListEntry } from '../../types/messenger';
import { formatFileSize } from '../../services/storage';
import type { MessengerExportDeletionInfo } from '../../services/messengerExport';

interface DeleteConfirmModalProps {
  entry: ChatListEntry | ChatListEntry[];
  onConfirm: () => void;
  onCancel: () => void;
  progress?: { done: number; total: number } | null;
  messengerDeletionInfo?: MessengerExportDeletionInfo | null;
  deletionInfoLoading?: boolean;
}

export function DeleteConfirmModal({
  entry,
  onConfirm,
  onCancel,
  progress,
  messengerDeletionInfo,
  deletionInfoLoading,
}: DeleteConfirmModalProps) {
  const isMultiple = Array.isArray(entry);
  const title = isMultiple ? `Delete ${entry.length} Chats` : 'Delete Chat';
  const entries = isMultiple ? entry : [entry];
  const isMessenger = entries.some(e => e._messengerExport);
  const targetName = isMultiple
    ? `${entry.length} chats selected`
    : (entry._jsonFileName || entry.folderName);

  return (
    <div className="delete-modal" role="dialog" aria-modal="true" aria-labelledby="deleteTitle">
      <div className="delete-backdrop" onClick={onCancel} />
      <div className="delete-card">
        <h3 id="deleteTitle">{title}</h3>
        <div className="delete-warning">
          <strong>This action is permanent and cannot be undone.</strong>
        </div>
        <div className="delete-breakdown">
          <div className="delete-breakdown-row">
            <span>Folder/File:</span>
            <strong title={targetName}>{targetName}</strong>
          </div>
          <div className="delete-breakdown-row">
            <span>Chat Data:</span>
            <strong>
              {messengerDeletionInfo
                ? `${formatFileSize(messengerDeletionInfo.jsonSize)}${!isMessenger ? ` (${messengerDeletionInfo.chatFileCount} files)` : ''}`
                : 'Calculating...'}
            </strong>
          </div>
          <div className="delete-breakdown-row">
            <span>Media:</span>
            <strong>
              {messengerDeletionInfo
                ? `${formatFileSize(messengerDeletionInfo.mediaSize)} (${messengerDeletionInfo.exclusiveMediaCount} files)`
                : 'Calculating...'}
            </strong>
          </div>
        </div>

        {isMultiple ? (
          <div className="delete-multiple-list">
            <div style={{ maxHeight: '150px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '6px', padding: '8px', marginBottom: '12px', background: 'var(--bg)' }}>
              {entry.map((e, idx) => (
                <div key={e.folderName} style={{ padding: '4px 0', borderBottom: idx < entry.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.title}
                  </div>
                  <div style={{ color: 'var(--muted)', fontSize: '12px' }}>
                    Folder: {e.folderName}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {deletionInfoLoading && (
          <p className="delete-meta">
            <span style={{ color: 'var(--muted)', fontSize: '12px' }}>Calculating deletion details...</span>
          </p>
        )}

        {messengerDeletionInfo && messengerDeletionInfo.sharedMediaCount > 0 && (
          <p className="delete-meta">
            <span style={{ color: 'var(--muted)', fontSize: '12px' }}>
              {messengerDeletionInfo.sharedMediaCount} media files shared with other chats will be kept.
            </span>
          </p>
        )}

        {progress && (
          <div style={{ marginTop: '16px', marginBottom: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '6px' }}>
              <span>Deleting...</span>
              <span>{progress.done} / {progress.total}</span>
            </div>
            <div style={{ width: '100%', height: '6px', background: 'var(--border)', borderRadius: '3px', overflow: 'hidden' }}>
              <div style={{ height: '100%', background: 'var(--accent)', width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
            </div>
          </div>
        )}
        <div className="delete-actions">
          <button className="btn btn-secondary" onClick={onCancel} disabled={!!progress}>
            Cancel
          </button>
          <button className="btn-danger" onClick={onConfirm} id="deleteConfirmBtn" disabled={!!progress || !!deletionInfoLoading || !messengerDeletionInfo}>
            {progress ? 'Deleting...' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </div>
  );
}
