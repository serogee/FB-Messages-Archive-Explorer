import type { ChatListEntry } from '../../types/messenger';
import type { DeleteProgress } from '../../types/deletion';
import { formatFileSize } from '../../services/storage';
import type { MessengerExportDeletionInfo } from '../../services/messengerExport';

interface DeleteConfirmModalProps {
  entry: ChatListEntry | ChatListEntry[];
  onConfirm: () => void;
  onDeleteJsonOnly?: () => void;
  onSkipCalculation?: () => void;
  onCancel: () => void;
  progress?: DeleteProgress | null;
  messengerDeletionInfo?: MessengerExportDeletionInfo | null;
  deletionInfoLoading?: boolean;
  deletionInfoSkipped?: boolean;
  mediaSafetyUnavailable?: boolean;
  preparingDeletion?: boolean;
  deleting?: boolean;
}

export function DeleteConfirmModal({
  entry,
  onConfirm,
  onDeleteJsonOnly,
  onSkipCalculation,
  onCancel,
  progress,
  messengerDeletionInfo,
  deletionInfoLoading,
  deletionInfoSkipped,
  mediaSafetyUnavailable,
  preparingDeletion,
  deleting,
}: DeleteConfirmModalProps) {
  const isMultiple = Array.isArray(entry);
  const title = isMultiple ? `Delete ${entry.length} Chats` : 'Delete Chat';
  const entries = isMultiple ? entry : [entry];
  const isMessenger = entries.some(e => e._messengerExport);
  const isDeleting = !!deleting || !!progress;
  const isBusy = !!preparingDeletion || isDeleting;
  const canSkipCalculation = !!deletionInfoLoading && !isMessenger && !deletionInfoSkipped && !messengerDeletionInfo && !isBusy;
  const canConfirm = !isBusy && (!!messengerDeletionInfo || !!deletionInfoSkipped);
  const canDeleteJsonOnly = !!mediaSafetyUnavailable && !!onDeleteJsonOnly && !isBusy;
  const pendingDetailText = mediaSafetyUnavailable
    ? 'Unavailable'
    : deletionInfoSkipped ? 'Skipped' : 'Calculating...';
  const progressLabel = progress?.stage === 'preparing'
    ? 'Preparing deletion...'
    : progress?.stage === 'media'
      ? 'Deleting media...'
      : progress?.stage === 'bookmarks'
        ? 'Cleaning bookmarks...'
        : 'Deleting chats...';
  const targetName = isMultiple
    ? `${entry.length} chats selected`
    : (entry._jsonFileName || entry.folderName);

  return (
    <div className="delete-modal" role="dialog" aria-modal="true" aria-labelledby="deleteTitle">
      <div className="delete-backdrop" onClick={isBusy ? undefined : onCancel} />
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
                : pendingDetailText}
            </strong>
          </div>
          <div className="delete-breakdown-row">
            <span>Media:</span>
            <strong>
              {messengerDeletionInfo
                ? `${formatFileSize(messengerDeletionInfo.mediaSize)} (${messengerDeletionInfo.exclusiveMediaCount} files)`
                : pendingDetailText}
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

        {mediaSafetyUnavailable && (
          <p className="delete-meta">
            <span style={{ color: 'var(--muted)', fontSize: '12px' }}>
              Media ownership could not be verified. You can delete only the chat JSON and keep all media.
            </span>
          </p>
        )}

        {progress && (
          <div style={{ marginTop: '16px', marginBottom: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '6px' }}>
              <span>{progressLabel}</span>
              {progress.total > 0 && <span>{progress.done} / {progress.total}</span>}
            </div>
            {progress.total > 0 && (
              <div style={{ width: '100%', height: '6px', background: 'var(--border)', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{ height: '100%', background: 'var(--accent)', width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
              </div>
            )}
          </div>
        )}
        <div className="delete-actions">
          {!isBusy && (
            <button className="btn btn-secondary" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button
            className={canSkipCalculation || canDeleteJsonOnly ? 'btn-warning' : 'btn-danger'}
            onClick={canSkipCalculation
              ? onSkipCalculation
              : canDeleteJsonOnly ? onDeleteJsonOnly : onConfirm}
            id="deleteConfirmBtn"
            disabled={canSkipCalculation
              ? !onSkipCalculation
              : canDeleteJsonOnly ? !onDeleteJsonOnly : !canConfirm}
          >
            {preparingDeletion
              ? 'Preparing deletion...'
              : isDeleting
                ? 'Deleting...'
                : canSkipCalculation
                  ? 'Skip calculation'
                  : canDeleteJsonOnly
                    ? 'Delete chat data only'
                  : deletionInfoLoading && !messengerDeletionInfo
                    ? 'Calculating...'
                    : 'Delete permanently'}
          </button>
        </div>
      </div>
    </div>
  );
}
