import type { ChatListEntry } from '../../types/messenger';
import type { DeletePreparationState, DeleteProgress, DeleteResultNotice } from '../../types/deletion';
import { formatFileSize } from '../../services/storage';

interface DeleteConfirmModalProps {
  entry: ChatListEntry | ChatListEntry[];
  onConfirm: () => void;
  onDeleteJsonOnly?: () => void;
  onRetryCalculation?: () => void;
  onSkipCalculation?: () => void;
  onCancel: () => void;
  progress?: DeleteProgress | null;
  preparation: DeletePreparationState;
  resultNotice?: DeleteResultNotice | null;
  preparingDeletion?: boolean;
  deleting?: boolean;
}

export function DeleteConfirmModal({
  entry,
  onConfirm,
  onDeleteJsonOnly,
  onRetryCalculation,
  onSkipCalculation,
  onCancel,
  progress,
  preparation,
  resultNotice,
  preparingDeletion,
  deleting,
}: DeleteConfirmModalProps) {
  const isMultiple = Array.isArray(entry);
  const title = isMultiple ? `Delete ${entry.length} Chats` : 'Delete Chat';
  const entries = isMultiple ? entry : [entry];
  const isMessenger = entries.some(item => item._messengerExport);
  const isDeleting = !!deleting || !!progress;
  const isBusy = !!preparingDeletion || isDeleting;
  const info = preparation.status === 'ready'
    ? preparation.info
    : preparation.status === 'loading' || preparation.status === 'error'
      ? preparation.info
      : undefined;
  const canSkipCalculation = preparation.status === 'loading' && !isMessenger && !isBusy;
  const canConfirm = !isBusy && (
    preparation.status === 'ready'
    || preparation.status === 'skipped'
    || (preparation.status === 'error' && (!isMessenger || (!preparation.mediaSafetyUnavailable && !!info)))
  );
  const canDeleteJsonOnly = preparation.status === 'error'
    && preparation.mediaSafetyUnavailable
    && !!onDeleteJsonOnly
    && !isBusy;
  const pendingDetailText = preparation.status === 'error' && preparation.mediaSafetyUnavailable
    ? 'Unavailable'
    : preparation.status === 'skipped'
      ? 'Skipped'
      : preparation.status === 'error'
        ? 'Unknown'
        : 'Calculating...';
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
  const mediaDetails = info
    ? preparation.status === 'ready'
      ? `${formatFileSize(info.mediaSize)} (${info.exclusiveMediaCount} files)`
      : `${pendingDetailText} (${info.exclusiveMediaCount} files)`
    : pendingDetailText;
  const confirmLabel = preparingDeletion
    ? 'Preparing deletion...'
    : isDeleting
      ? 'Deleting...'
      : resultNotice
        ? 'Retry deletion'
        : preparation.status === 'error' && !isMessenger
          ? 'Delete without size details'
          : 'Delete permanently';

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
              {info
                ? `${formatFileSize(info.jsonSize)}${!isMessenger ? ` (${info.chatFileCount} files)` : ''}`
                : pendingDetailText}
            </strong>
          </div>
          <div className="delete-breakdown-row">
            <span>Media:</span>
            <strong>{mediaDetails}</strong>
          </div>
        </div>

        {isMultiple ? (
          <div className="delete-multiple-list">
            <div style={{ maxHeight: '150px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '6px', padding: '8px', marginBottom: '12px', background: 'var(--bg)' }}>
              {entry.map((item, index) => (
                <div key={`${item.source}:${item._jsonFileName || item.folderName}`} style={{ padding: '4px 0', borderBottom: index < entry.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.title}
                  </div>
                  <div style={{ color: 'var(--muted)', fontSize: '12px' }}>
                    Folder: {item.folderName}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {preparation.status === 'loading' && (
          <p className="delete-meta">
            {preparation.calculatingSizes ? 'Calculating sizes...' : 'Preparing deletion details...'}
          </p>
        )}

        {info && info.sharedMediaCount > 0 && (
          <p className="delete-meta">
            {info.sharedMediaCount} media files shared with other chats will be kept.
          </p>
        )}

        {preparation.status === 'error' && (
          <div className="delete-result-notice" role="alert">
            <strong>Could not calculate all deletion details.</strong>
            <div>{preparation.error}</div>
            {preparation.mediaSafetyUnavailable && (
              <div>Normal media deletion is blocked. You can keep all media and delete only the chat JSON.</div>
            )}
          </div>
        )}

        {resultNotice && (
          <div className="delete-result-notice" role="alert">
            <strong>{resultNotice.message}</strong>
            {resultNotice.failures.filter(failure => failure.partial).map(failure => (
              <div key={`${failure.entry.source}:${failure.entry._jsonFileName || failure.entry.folderName}`}>
                {failure.entry.title}: Chat JSON remains
                {failure.removedMediaCount
                  ? `, but ${failure.removedMediaCount} media ${failure.removedMediaCount === 1 ? 'file was' : 'files were'} removed. Some attachments may be missing.`
                  : '. Some attachments may already be missing.'}
              </div>
            ))}
            {resultNotice.bookmarkCleanupError && <div>{resultNotice.bookmarkCleanupError}</div>}
          </div>
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
          {!isBusy && <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>}
          {preparation.status === 'error' && !isBusy && (
            <button className="btn btn-secondary" onClick={onRetryCalculation} disabled={!onRetryCalculation}>
              Retry calculation
            </button>
          )}
          {canSkipCalculation && (
            <button className="btn-warning" onClick={onSkipCalculation} disabled={!onSkipCalculation}>
              Skip calculation
            </button>
          )}
          {canDeleteJsonOnly && (
            <button className="btn-warning" onClick={onDeleteJsonOnly}>
              Delete chat JSON only; keep all media
            </button>
          )}
          {!canDeleteJsonOnly && (
            <button className="btn-danger" onClick={onConfirm} id="deleteConfirmBtn" disabled={!canConfirm}>
              {preparation.status === 'loading' && !isBusy
                ? preparation.calculatingSizes ? 'Calculating sizes...' : 'Preparing...'
                : confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
