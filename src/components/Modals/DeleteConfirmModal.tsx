import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
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
  const initialHeight = useRef(isMultiple ? 520 : 270).current;
  const [expandedHeight, setExpandedHeight] = useState<number | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const hasExceptionalContent = preparation.status === 'error' || !!resultNotice;
  const measuringExceptionalContent = hasExceptionalContent && expandedHeight === null;

  useLayoutEffect(() => {
    if (!hasExceptionalContent || !cardRef.current) return;
    const body = cardRef.current.querySelector<HTMLElement>('.delete-card-body');
    const actions = cardRef.current.querySelector<HTMLElement>('.delete-actions');
    const hiddenOverflow = Math.max(0, (body?.scrollHeight || 0) - (body?.clientHeight || 0))
      + Math.max(0, (actions?.scrollHeight || 0) - (actions?.clientHeight || 0));
    const viewportLimit = Math.max(0, window.innerHeight - 32);
    const requiredHeight = Math.ceil(cardRef.current.getBoundingClientRect().height + hiddenOverflow);
    setExpandedHeight(currentHeight => {
      const nextHeight = Math.min(viewportLimit, Math.max(initialHeight, requiredHeight));
      return currentHeight !== null && currentHeight >= nextHeight ? currentHeight : nextHeight;
    });
  }, [hasExceptionalContent, initialHeight, preparation, resultNotice]);

  const cardStyle = {
    '--delete-card-height': `${expandedHeight || initialHeight}px`,
  } as CSSProperties & Record<'--delete-card-height', string>;
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
    ? 'Preparing...'
    : isDeleting
      ? 'Deleting...'
      : resultNotice
        ? 'Retry deletion'
        : preparation.status === 'error' && !isMessenger
          ? 'Delete anyway'
          : 'Delete permanently';
  const primaryActionLabel = preparation.status === 'loading' && !isBusy
    ? preparation.calculatingSizes ? 'Calculating sizes...' : 'Preparing...'
    : confirmLabel;
  const showWarning = !resultNotice && preparation.status !== 'error';
  const showBreakdown = !resultNotice && (preparation.status !== 'error' || !!info);
  const partialFailures = resultNotice?.failures.filter(failure => failure.partial) || [];
  const removedMediaCount = partialFailures.reduce(
    (total, failure) => total + (failure.removedMediaCount || 0),
    0
  );
  const preparationMessage = preparation.status === 'loading'
    ? `${preparation.calculatingSizes ? 'Calculating sizes...' : 'Preparing deletion details...'}${info?.sharedMediaCount ? ` ${info.sharedMediaCount} shared media files will be kept.` : ''}`
    : preparation.status === 'ready'
      ? preparation.info.sharedMediaCount > 0
        ? `${preparation.info.sharedMediaCount} media files shared with other chats will be kept.`
        : 'Ready to delete.'
      : preparation.status === 'skipped'
        ? 'Size calculation was skipped.'
        : null;

  return (
    <div className="delete-modal" role="dialog" aria-modal="true" aria-labelledby="deleteTitle">
      <div className="delete-backdrop" onClick={isBusy ? undefined : onCancel} />
      <div
        ref={cardRef}
        className={`delete-card ${isMultiple ? 'delete-card-batch' : 'delete-card-single'}${measuringExceptionalContent ? ' delete-card-measuring-error' : ''}${expandedHeight !== null ? ' delete-card-expanded' : ''}`}
        style={cardStyle}
      >
        <h3 id="deleteTitle">{title}</h3>
        <div className="delete-card-body">
        {showWarning && (
          <div className="delete-warning">
            <strong>This action is permanent and cannot be undone.</strong>
          </div>
        )}
        {showBreakdown && <div className="delete-breakdown">
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
        </div>}

        {isMultiple ? (
          <div className="delete-multiple-list">
            <div className="delete-multiple-list-scroll">
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

        {!progress && preparationMessage && <p className="delete-meta">{preparationMessage}</p>}

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
            {isMultiple && partialFailures.length > 0 ? (
              <div>
                {partialFailures.length} chat JSON {partialFailures.length === 1 ? 'file remains' : 'files remain'}.
                {removedMediaCount > 0
                  ? ` ${removedMediaCount} media ${removedMediaCount === 1 ? 'file was' : 'files were'} removed; some attachments may be missing.`
                  : ' Some attachments may already be missing.'}
              </div>
            ) : partialFailures.map(failure => (
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
        </div>
        <div className="delete-actions">
          {canSkipCalculation && (
            <button className="btn-warning delete-skip-action" onClick={onSkipCalculation} disabled={!onSkipCalculation}>
              Skip calculation
            </button>
          )}
          {!isBusy && <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>}
          {preparation.status === 'error' && !isBusy && (
            <button className="btn btn-secondary" onClick={onRetryCalculation} disabled={!onRetryCalculation}>
              Retry calculation
            </button>
          )}
          {canDeleteJsonOnly && (
            <button className="btn-warning" onClick={onDeleteJsonOnly}>
              Delete JSON only; keep media
            </button>
          )}
          {!canDeleteJsonOnly && (
            <button className="btn-danger delete-primary-action" onClick={onConfirm} id="deleteConfirmBtn" disabled={!canConfirm}>
              <span className="delete-primary-action-sizer" aria-hidden="true">Delete permanently</span>
              <span className="delete-primary-action-label">{primaryActionLabel}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
