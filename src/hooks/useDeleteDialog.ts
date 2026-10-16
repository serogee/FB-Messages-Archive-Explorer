import { useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import type { ChatListEntry } from '../types/messenger';
import type { ReadableDirectoryHandle } from '../types/fileSystem';
import { requestDirectoryWritePermission } from '../types/fileSystem';
import type { BatchDeleteResult, DeleteChatsOptions, DeleteInfoOptions, DeletePreparationState, DeleteProgress, DeleteResultNotice } from '../types/deletion';
import { MessengerExportIndexIncompleteError, MessengerExportMediaSizeUnavailableError, type MessengerExportDeletionInfo } from '../services/messengerExport';
import { formatBatchDeleteResult, getBookmarkCleanupEntries, getDeleteRetryEntries } from '../services/deletionResults';
import { createProgressThrottle } from '../services/progressThrottle';
import { CalculationProgressStore } from '../services/calculationProgress';
import { SingleFlightGuard } from '../services/singleFlight';

export type DeleteConfirmationMode = 'normal' | 'json-only' | 'override' | 'unchecked';
type DeleteTarget = ChatListEntry | ChatListEntry[];

interface DeletePreparationOptions {
  preserveResult?: boolean;
  skipSizes?: boolean;
  forceOwnershipCheck?: boolean;
  skipAttachmentCheck?: boolean;
}

interface DeleteDialogInputs {
  deletionEnabled: boolean;
  permissionRoot: ReadableDirectoryHandle | null;
  getDeleteInfo: (
    target: DeleteTarget,
    signal?: AbortSignal,
    onOwnershipReady?: (info: MessengerExportDeletionInfo) => void,
    options?: DeleteInfoOptions,
  ) => Promise<MessengerExportDeletionInfo>;
  updateFolderSize: (entry: ChatListEntry, size: number, includesMedia?: boolean) => void;
  suspendSizeWork: () => Promise<void>;
  resumeSizeWork: () => void;
  deleteChats: (entries: ChatListEntry[], onProgress?: (progress: DeleteProgress) => void, options?: DeleteChatsOptions) => Promise<BatchDeleteResult>;
  deleteMessengerChatsJsonOnly: (entries: ChatListEntry[], onProgress?: (progress: DeleteProgress) => void) => Promise<BatchDeleteResult>;
  removeBookmarks: (entries: ChatListEntry[]) => Promise<void>;
  onDeleted: (entries: readonly ChatListEntry[]) => void;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected error occurred.';
}

export function useDeleteDialog({
  deletionEnabled, permissionRoot, getDeleteInfo, updateFolderSize, suspendSizeWork, resumeSizeWork,
  deleteChats, deleteMessengerChatsJsonOnly, removeBookmarks, onDeleted,
}: DeleteDialogInputs) {
  const [deleteTarget, setDeleteTarget] = useState<ChatListEntry | ChatListEntry[] | null>(null);
  const [deleteProgress, setDeleteProgress] = useState<DeleteProgress | null>(null);
  const [deletePreparation, setDeletePreparation] = useState<DeletePreparationState>({
    status: 'loading',
    calculatingSizes: false,
  });
  const [deleteResultNotice, setDeleteResultNotice] = useState<DeleteResultNotice | null>(null);
  const [deletePreparing, setDeletePreparing] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteToast, setDeleteToast] = useState<string | null>(null);
  const deleteInfoRequestRef = useRef(0);
  const deleteInfoAbortRef = useRef<AbortController | null>(null);
  const deleteCalculationProgressRef = useRef<CalculationProgressStore | null>(null);
  const [deleteVerificationProgress, setDeleteVerificationProgress] = useState<CalculationProgressStore | null>(null);
  const deleteToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deleteOperationGuardRef = useRef(new SingleFlightGuard());
  const deletionPolicyRef = useRef({ enabled: deletionEnabled, revision: 0 });
  useLayoutEffect(() => {
    if (deletionPolicyRef.current.enabled === deletionEnabled) return;
    deletionPolicyRef.current = { enabled: deletionEnabled, revision: deletionPolicyRef.current.revision + 1 };
  }, [deletionEnabled]);
  useEffect(() => {
    if (deletionEnabled) return;
    deleteInfoRequestRef.current++;
    deleteInfoAbortRef.current?.abort();
    deleteInfoAbortRef.current = null;
    deleteCalculationProgressRef.current?.dispose();
    setDeleteTarget(null);
    setDeleteResultNotice(null);
  }, [deletionEnabled]);

  useEffect(() => {
    return () => {
      deleteInfoAbortRef.current?.abort();
      if (deleteToastTimerRef.current) clearTimeout(deleteToastTimerRef.current);
    };
  }, []);

  const prepareDeleteTarget = useCallback((
    target: ChatListEntry | ChatListEntry[],
    {
      preserveResult = false,
      skipSizes = false,
      forceOwnershipCheck = false,
      skipAttachmentCheck = false,
    }: DeletePreparationOptions = {},
  ) => {
    if (!deletionPolicyRef.current.enabled) return;
    deleteCalculationProgressRef.current?.dispose();
    deleteInfoAbortRef.current?.abort();
    const abortCtrl = new AbortController();
    deleteInfoAbortRef.current = abortCtrl;
    const requestId = deleteInfoRequestRef.current + 1;
    deleteInfoRequestRef.current = requestId;
    const progress = new CalculationProgressStore();
    const isMessenger = (Array.isArray(target) ? target : [target]).some(entry => entry._messengerExport);
    progress.report(skipAttachmentCheck
      ? { stage: 'sizes', label: 'Calculating chat sizes', done: 0, unit: 'files' }
      : { stage: 'ownership', label: 'Scanning for shared attachments', done: 0,
        unit: isMessenger ? 'files' : 'folders', jsonFound: isMessenger ? undefined : 0 });
    deleteCalculationProgressRef.current = progress;
    setDeleteTarget(target);
    if (!preserveResult) setDeleteResultNotice(null);
    setDeletePreparing(false);
    setDeleteBusy(false);
    setDeletePreparation(current => ({
      status: 'loading', calculatingSizes: skipAttachmentCheck && !skipSizes, sizesSkipped: skipSizes,
      attachmentCheckSkipped: skipAttachmentCheck,
      info: !skipAttachmentCheck && preserveResult && 'info' in current ? current.info : undefined, progress,
    }));
    getDeleteInfo(target, abortCtrl.signal, ownershipInfo => {
      if (deleteInfoRequestRef.current !== requestId) return;
      setDeletePreparation({ status: 'loading', info: ownershipInfo, calculatingSizes: !skipSizes, sizesSkipped: skipSizes, progress });
    }, { skipSizes, forceOwnershipCheck, skipAttachmentCheck, progress })
      .then(info => {
        if (deleteInfoRequestRef.current !== requestId) return;
        setDeletePreparation(skipSizes
          ? skipAttachmentCheck ? { status: 'unchecked', attachmentCheckSkipped: true } : { status: 'skipped', info }
          : { status: 'ready', info, attachmentCheckSkipped: skipAttachmentCheck });
        if (!skipSizes && !Array.isArray(target) && !target._messengerExport && target.folderSize <= 0) {
          updateFolderSize(target, info.totalSize - (info.stickerSize || 0));
        }
      })
      .catch(error => {
        if (deleteInfoRequestRef.current !== requestId) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (error instanceof MessengerExportIndexIncompleteError) {
          setDeletePreparation({
            status: 'error',
            error: 'Media ownership could not be verified for every conversation.',
            mediaSafetyUnavailable: true,
          });
        } else if (error instanceof MessengerExportMediaSizeUnavailableError) {
          setDeletePreparation({
            status: 'error',
            error: 'Media byte totals could not be calculated. Ownership is verified, so deletion is still safe.',
            mediaSafetyUnavailable: false,
            info: error.safeInfo,
          });
        } else {
          setDeletePreparation(current => ({
            status: 'error',
            error: getErrorMessage(error),
            mediaSafetyUnavailable: false,
            info: 'info' in current ? current.info : undefined,
            attachmentCheckSkipped: skipAttachmentCheck,
          }));
        }
        console.error('Failed to prepare delete details:', error);
      })
      .finally(() => {
        progress.dispose();
        if (deleteInfoRequestRef.current !== requestId) return;
        if (deleteInfoAbortRef.current === abortCtrl) {
          deleteInfoAbortRef.current = null;
        }
      });
  }, [getDeleteInfo, updateFolderSize]);

  const handleDeleteRequest = useCallback((target: ChatListEntry | ChatListEntry[]) => {
    prepareDeleteTarget(target);
  }, [prepareDeleteTarget]);

  const handleDeleteConfirm = useCallback(async (mode: DeleteConfirmationMode) => {
    if (!deleteTarget || !deletionPolicyRef.current.enabled) return;
    const policyRevision = deletionPolicyRef.current.revision;
    const assertPolicyCurrent = () => {
      if (!deletionPolicyRef.current.enabled || deletionPolicyRef.current.revision !== policyRevision) {
        throw new DOMException('Chat deletion was disabled or superseded.', 'AbortError');
      }
    };
    const jsonOnly = mode === 'json-only';
    const operationToken = deleteOperationGuardRef.current.tryBegin();
    if (!operationToken) return;
    const progressReporter = createProgressThrottle<DeleteProgress>(
      setDeleteProgress,
      75,
      progress => progress.stage
    );
    deleteCalculationProgressRef.current?.dispose();
    deleteInfoAbortRef.current?.abort();
    deleteInfoAbortRef.current = null;
    setDeleteResultNotice(null);
    setDeletePreparing(true);
    setDeleteProgress({ stage: 'preparing', done: 0, total: 0 });
    const verificationProgress = new CalculationProgressStore();
    setDeleteVerificationProgress(mode === 'normal' || mode === 'override' ? verificationProgress : null);
    deleteInfoRequestRef.current++;
    const targets = Array.isArray(deleteTarget) ? deleteTarget : [deleteTarget];
    let retryTargets: ChatListEntry[] | null = null;
    let sizeWorkSuspended = false;
    try {
      if (!permissionRoot || !await requestDirectoryWritePermission(permissionRoot)) {
        throw new DOMException('Write access is required to delete these chats.', 'NotAllowedError');
      }
      assertPolicyCurrent();
      sizeWorkSuspended = true;
      await suspendSizeWork();
      assertPolicyCurrent();
      setDeletePreparing(false);
      setDeleteBusy(true);
      setDeleteProgress(null);
      const result = jsonOnly
        ? await deleteMessengerChatsJsonOnly(targets, progress => {
            progressReporter.report(progress, progress.total > 0 && progress.done >= progress.total);
          })
        : await deleteChats(targets, progress => {
            setDeleteVerificationProgress(null);
            progressReporter.report(progress, progress.total > 0 && progress.done >= progress.total);
          }, { allowSharedAttachmentLoss: mode === 'override', skipAttachmentCheck: mode === 'unchecked', verificationProgress });
      progressReporter.flush();

      let bookmarkCleanupError: string | undefined;
      const bookmarkCleanupEntries = getBookmarkCleanupEntries(result);
      if (bookmarkCleanupEntries.length > 0) {
        setDeleteProgress({ stage: 'bookmarks', done: 0, total: 1 });
        try {
          await removeBookmarks(bookmarkCleanupEntries);
        } catch (error) {
          bookmarkCleanupError = 'Chats were deleted, but their bookmarks could not be removed.';
          console.error(bookmarkCleanupError, error);
        } finally {
          setDeleteProgress({ stage: 'bookmarks', done: 1, total: 1 });
        }
      }

      if (result.deleted.length > 0) onDeleted(result.deleted);

      for (const failure of result.failed) {
        console.error(`Failed to delete ${failure.entry.folderName}`, failure.error);
      }
      const resultMessage = formatBatchDeleteResult(result, jsonOnly);
      setDeleteToast(bookmarkCleanupError
        ? `${resultMessage}; bookmark cleanup failed`
        : resultMessage);
      if (deleteToastTimerRef.current) clearTimeout(deleteToastTimerRef.current);
      deleteToastTimerRef.current = setTimeout(() => setDeleteToast(null), 3200);

      const failedEntries = getDeleteRetryEntries(result);
      if (failedEntries.length > 0) {
        retryTargets = failedEntries;
        setDeleteResultNotice({
          message: resultMessage,
          failures: result.failed,
          bookmarkCleanupError,
        });
      } else {
        setDeleteTarget(null);
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        console.error('Delete failed:', error);
        const message = error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'Write access was not granted. The chats were not deleted.'
          : `Deletion failed: ${getErrorMessage(error)}`;
        setDeleteResultNotice({ message, failures: [] });
      }
    } finally {
      if (sizeWorkSuspended) resumeSizeWork();
      progressReporter.cancel();
      verificationProgress.dispose();
      setDeleteVerificationProgress(null);
      deleteOperationGuardRef.current.finish(operationToken);
      setDeletePreparing(false);
      setDeleteBusy(false);
      setDeleteProgress(null);
    }

    if (retryTargets && retryTargets.length > 0) {
      const retryTarget = retryTargets.length === 1 ? retryTargets[0] : retryTargets;
      prepareDeleteTarget(retryTarget, { preserveResult: true });
    }
  }, [deleteTarget, permissionRoot, suspendSizeWork, resumeSizeWork, deleteChats, deleteMessengerChatsJsonOnly, removeBookmarks, onDeleted, prepareDeleteTarget]);

  const retry = useCallback(() => {
    if (deleteTarget) prepareDeleteTarget(deleteTarget, { preserveResult: true });
  }, [deleteTarget, prepareDeleteTarget]);

  const skipSizes = useCallback(() => {
    deleteCalculationProgressRef.current?.dispose();
    deleteInfoAbortRef.current?.abort();
    deleteInfoAbortRef.current = null;
    deleteInfoRequestRef.current++;
    setDeleteResultNotice(null);
    setDeletePreparation(current => current.attachmentCheckSkipped
      ? { status: 'unchecked', attachmentCheckSkipped: true }
      : { status: 'skipped', info: 'info' in current ? current.info : undefined });
  }, []);

  const checkAttachments = useCallback(() => {
    if (deleteTarget) prepareDeleteTarget(deleteTarget, {
      skipSizes: deletePreparation.status === 'skipped', forceOwnershipCheck: true,
    });
  }, [deleteTarget, deletePreparation.status, prepareDeleteTarget]);

  const skipCheck = useCallback(() => {
    if (deleteTarget) prepareDeleteTarget(deleteTarget, { skipAttachmentCheck: true });
  }, [deleteTarget, prepareDeleteTarget]);

  const cancel = useCallback(() => {
    if (!deleteProgress && !deleteBusy) {
      deleteCalculationProgressRef.current?.dispose();
      deleteInfoAbortRef.current?.abort();
      deleteInfoAbortRef.current = null;
      setDeleteTarget(null);
      setDeletePreparation({ status: 'loading', calculatingSizes: false });
      setDeleteResultNotice(null);
      deleteInfoRequestRef.current++;
    }
  }, [deleteProgress, deleteBusy]);

  const abortForPickedFolder = useCallback(() => {
    deleteInfoAbortRef.current?.abort();
    deleteInfoAbortRef.current = null;
  }, []);

  const resetAfterHandledOpen = useCallback(() => {
    deleteInfoRequestRef.current++;
    setDeleteTarget(null);
    setDeletePreparation({ status: 'loading', calculatingSizes: false });
    setDeleteResultNotice(null);
    setDeletePreparing(false);
    setDeleteBusy(false);
    setDeleteProgress(null);
  }, []);

  return {
    target: deleteTarget,
    preparation: deletePreparation,
    progress: deleteProgress,
    verificationProgress: deleteVerificationProgress,
    resultNotice: deleteResultNotice,
    preparing: deletePreparing,
    busy: deleteBusy,
    toast: deleteToast,
    request: handleDeleteRequest,
    confirm: handleDeleteConfirm,
    retry, skipSizes, checkAttachments, skipCheck, cancel, abortForPickedFolder, resetAfterHandledOpen,
  };
}
