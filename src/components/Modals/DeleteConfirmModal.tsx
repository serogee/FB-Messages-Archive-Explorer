import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { ChatListEntry } from '../../types/messenger';
import type { DeletePreparationState, DeleteProgress, DeleteResultNotice } from '../../types/deletion';
import { formatFileSize } from '../../services/storage';
import { getMetaChatId } from '../../services/metaAttachmentPaths';
import { MetaChatDeletionBlockedError } from '../../services/metaChatDeletion';
import { CalculationProgressBar } from '../CalculationProgressBar';

interface DeleteConfirmModalProps {
  entry: ChatListEntry | ChatListEntry[];
  onConfirm: () => void;
  onDeleteAnyway?: () => void;
  onDeleteJsonOnly?: () => void;
  onRetryCalculation?: () => void;
  onSkipCalculation?: () => void;
  onSkipCheck?: () => void;
  onCheckAttachments?: () => void;
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
  onDeleteAnyway,
  onDeleteJsonOnly,
  onRetryCalculation,
  onSkipCalculation,
  onSkipCheck,
  onCheckAttachments,
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
  const initialHeight = useRef(isMultiple ? 580 : 350).current;
  const [expandedHeight, setExpandedHeight] = useState<number | null>(null);
  const [allowSharedAttachmentLoss, setAllowSharedAttachmentLoss] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const hasExceptionalContent = preparation.status === 'error' || !!resultNotice
    || preparation.status === 'unchecked'
    || ('info' in preparation && !!preparation.info?.blockedChats?.length);
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
  const info = 'info' in preparation ? preparation.info : undefined;
  const unchecked = preparation.status === 'unchecked';
  const sizesSkipped = unchecked || preparation.status === 'skipped' || (preparation.status === 'loading' && preparation.sizesSkipped);
  const canSkipCalculation = preparation.status === 'loading' && !sizesSkipped && !isMessenger && !isBusy;
  const canSkipCheck = preparation.status === 'loading' && sizesSkipped && !info && !isMessenger && !isBusy && !!onSkipCheck;
  const canCheckAttachmentsAfterSizeSkip = preparation.status === 'skipped'
    && !!info && !isMessenger && !isBusy && !!onCheckAttachments;
  const allChatsBlocked = info?.deletableChatCount === 0 && !!info.blockedChats?.length;
  const overrideEnabled = allowSharedAttachmentLoss && !isMessenger && !!onDeleteAnyway && !!info?.blockedChats?.length;
  const canConfirm = !isBusy && (!allChatsBlocked || overrideEnabled) && (
    preparation.status === 'ready'
    || (preparation.status === 'skipped' && !!info)
    || (preparation.status === 'error' && (!isMessenger || (!preparation.mediaSafetyUnavailable && !!info)))
    || overrideEnabled
    || (unchecked && !isMessenger)
  );
  const canDeleteJsonOnly = preparation.status === 'error'
    && preparation.mediaSafetyUnavailable
    && !!onDeleteJsonOnly
    && !isBusy;
  const pendingDetailText = preparation.status === 'error' && preparation.mediaSafetyUnavailable
    ? 'Unavailable'
    : sizesSkipped
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
  const mediaDetails = info && !sizesSkipped && (isMessenger || preparation.status === 'ready')
    ? preparation.status === 'ready'
      ? `${formatFileSize(info.mediaSize)} (${info.exclusiveMediaCount} files)`
      : `${pendingDetailText} (${info.exclusiveMediaCount} files)`
    : pendingDetailText;
  const confirmLabel = preparingDeletion
    ? 'Preparing...'
    : isDeleting
      ? 'Deleting...'
      : allChatsBlocked && !overrideEnabled
        ? 'Deletion blocked'
        : resultNotice
        ? 'Retry deletion'
        : 'Delete permanently';
  const primaryActionLabel = preparation.status === 'loading' && !isBusy && !overrideEnabled
    ? preparation.calculatingSizes ? 'Calculating sizes...' : 'Preparing...'
    : confirmLabel;
  const showWarning = !resultNotice && preparation.status !== 'error';
  const showBreakdown = !resultNotice && (preparation.status !== 'error' || !!info);
  const partialFailures = resultNotice?.failures.filter(failure => failure.partial) || [];
  const protectedFailures = resultNotice?.failures.filter(failure => failure.blocked) || [];
  const blockedChats = info?.blockedChats ?? protectedFailures.flatMap(failure => {
    if (!(failure.error instanceof MetaChatDeletionBlockedError)) return [];
    const block = failure.error.block;
    return [{ chatId: getMetaChatId(block.entry), title: block.entry.title,
      reason: block.reason, kind: block.kind, dependencies: block.dependencies }];
  });
  const selectedChatIds = new Set(entries.map(getMetaChatId));
  const blockedChatIds = new Set(blockedChats.map(block => block.chatId));
  const canDeleteAnyway = !isMessenger && !!info && blockedChats.length > 0 && !!onDeleteAnyway && !isBusy;
  const retryableFailures = resultNotice?.failures.filter(failure => !failure.partial && !failure.blocked) || [];
  const removedMediaCount = partialFailures.reduce(
    (total, failure) => total + (failure.removedMediaCount || 0),
    0
  );
  const preparationMessage = overrideEnabled ? 'Folder protection is overridden for this deletion.'
    : allChatsBlocked ? 'These chat folders will be kept to protect shared attachments.' : preparation.status === 'loading'
    ? `${preparation.calculatingSizes ? 'Calculating sizes...' : 'Checking shared attachments...'}${info?.sharedMediaCount ? ` ${info.sharedMediaCount} shared media files will be kept.` : ''}`
    : preparation.status === 'ready'
      ? preparation.info.sharedMediaCount > 0
        ? `${preparation.info.sharedMediaCount} media files shared with other chats will be kept.`
        : 'Ready to delete.'
      : preparation.status === 'skipped'
        ? 'Size calculation was skipped. Shared attachments were checked.'
        : unchecked ? 'Shared attachment check and size calculation were skipped.' : null;
  const stickerSafetyMessage = info?.stickersPreservedForSafety
    ? 'Shared stickers will be kept because their ownership or export format could not be verified.' : null;

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
              {info && (!sizesSkipped && (isMessenger || preparation.status === 'ready'))
                ? `${formatFileSize(info.jsonSize)}${!isMessenger ? ` (${info.chatFileCount} files)` : ''}`
                : pendingDetailText}
            </strong>
          </div>
          <div className="delete-breakdown-row">
            <span>Media:</span>
            <strong>{mediaDetails}</strong>
          </div>
          {!isMessenger && (
            <div className="delete-breakdown-row">
              <span>Shared stickers:</span>
              <strong>{info && preparation.status === 'ready' ? `${formatFileSize(info.stickerSize || 0)} (${info.stickerCount || 0} files)` : pendingDetailText}</strong>
            </div>
          )}
          <div className="delete-breakdown-row">
            <span>Recoverable:</span>
            <strong>{info && preparation.status === 'ready' ? formatFileSize(info.totalSize) : pendingDetailText}</strong>
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
        {!isBusy && preparation.status === 'loading' && preparation.progress && (
          <CalculationProgressBar source={preparation.progress} label="Deletion calculation progress" />
        )}
        {!progress && stickerSafetyMessage && <p className="delete-meta">{stickerSafetyMessage}</p>}
        {!progress && unchecked && (
          <div className="delete-result-notice" role="alert" id="deleteUncheckedWarning">
            <strong>Shared attachment protection is bypassed.</strong>
            <div>“Delete permanently” will remove the selected chat folders without checking dependencies. Other chats may lose attachments. Shared stickers outside these folders will be kept.</div>
          </div>
        )}
        {!progress && blockedChats.length > 0 && (
          <section className="delete-result-notice delete-dependencies" role="alert" aria-label="Shared attachment dependencies">
            <strong>{blockedChats.length} {blockedChats.length === 1 ? 'chat is' : 'chats are'} protected.</strong>
            <div className="delete-dependencies-scroll" role="region" aria-label="Protected chats and their dependencies" tabIndex={0}>
              {blockedChats.map(block => (
                <article className="delete-dependency-group" key={block.chatId}>
                  <div className="delete-dependency-source"><span>Protected chat:</span> <strong>{block.title}</strong></div>
                  <div className="delete-dependency-path">Folder: {block.chatId}</div>
                  <p>{block.kind === 'shared-files'
                    ? 'Files in this folder are still used by these chats:'
                    : block.kind === 'cycle'
                      ? 'These selected chats depend on files in each other’s folders:'
                      : 'Attachment ownership could not be verified for every conversation.'}</p>
                  {block.dependencies.length > 0 && (
                    <ul className="delete-dependency-list" aria-label={`Chats depending on ${block.title}`}>
                      {block.dependencies.map(dependency => (
                        <li key={dependency.chatId}>
                          <div><strong>{dependency.title}</strong><div className="delete-dependency-path">{dependency.chatId}</div></div>
                          <span className="delete-dependency-status">{selectedChatIds.has(dependency.chatId)
                            ? blockedChatIds.has(dependency.chatId) ? 'Selected, protected' : 'Selected'
                            : 'Not selected'}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
              ))}
            </div>
            {!allChatsBlocked && info && <div>Normal deletion removes only the other {info.deletableChatCount} selected chats. Recoverable space excludes protected folders.</div>}
            {!!onDeleteAnyway && <div id="deleteOverrideWarning">{overrideEnabled
              ? '“Delete permanently” will remove all selected chat folders, including protected folders.'
              : '“Delete anyway” unlocks “Delete permanently” for all selected chat folders, including protected folders.'} Other chats may lose attachments. Shared stickers outside these folders remain protected.</div>}
          </section>
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
            {protectedFailures.filter(failure => !(failure.error instanceof MetaChatDeletionBlockedError)).map(failure => (
              <div key={`${failure.entry.source}:${failure.entry.folderName}`}>
                {failure.error instanceof Error ? failure.error.message : `${failure.entry.title} was kept to protect shared files.`}
              </div>
            ))}
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
            {retryableFailures.length > 0 && (
              <div>
                {retryableFailures.length === 1
                  ? 'The chat could not be deleted and remains available for retry.'
                  : `${retryableFailures.length} chats could not be deleted and remain available for retry.`}
              </div>
            )}
            {resultNotice.bookmarkCleanupError && <div>{resultNotice.bookmarkCleanupError}</div>}
          </div>
        )}

        {progress && (
          <div className="calculation-progress" role="status" aria-label="Deletion progress">
            <div className="calculation-progress-details">
              <span>{progressLabel}</span>
              {progress.total > 0 && <span className="calculation-progress-count">{progress.done.toLocaleString()} / {progress.total.toLocaleString()}</span>}
            </div>
          </div>
        )}
        </div>
        <div className="delete-actions">
          <div className="delete-preparation-actions">
              {canSkipCalculation && (
                <button className="btn-warning delete-skip-action" onClick={onSkipCalculation} disabled={!onSkipCalculation}>Skip calculation</button>
              )}
              {canDeleteAnyway && (
                <button className="btn-warning delete-override-action" onClick={() => setAllowSharedAttachmentLoss(!overrideEnabled)}
                  aria-pressed={overrideEnabled} aria-describedby="deleteOverrideWarning">
                  {overrideEnabled ? 'Keep protection' : 'Delete anyway'}
                </button>
              )}
              {canSkipCheck && <button className="btn-warning delete-skip-check-action" onClick={onSkipCheck}>Skip check</button>}
              {canCheckAttachmentsAfterSizeSkip && <button className="btn-warning" onClick={onCheckAttachments}>Check attachments</button>}
              {unchecked && !isBusy && <button className="btn-warning" onClick={onRetryCalculation} disabled={!onRetryCalculation}>Check attachments</button>}
          </div>
          <div className="delete-confirm-actions">
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
            <button className="btn-danger delete-primary-action" onClick={() => {
              if (overrideEnabled) { setAllowSharedAttachmentLoss(false); onDeleteAnyway?.(); }
              else onConfirm();
            }} id="deleteConfirmBtn" disabled={!canConfirm} aria-describedby={unchecked ? 'deleteUncheckedWarning' : overrideEnabled ? 'deleteOverrideWarning' : undefined}>
              <span className="delete-primary-action-sizer" aria-hidden="true">Delete permanently</span>
              <span className="delete-primary-action-label">{primaryActionLabel}</span>
            </button>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
