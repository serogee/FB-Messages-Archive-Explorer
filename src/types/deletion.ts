import type { ChatListEntry } from './messenger';
import type { MessengerExportDeletionInfo } from '../services/messengerExport';
import type { CalculationProgressStore } from '../services/calculationProgress';

export type DeleteProgressStage = 'preparing' | 'media' | 'chat' | 'bookmarks';

export interface DeleteProgress {
  stage: DeleteProgressStage;
  done: number;
  total: number;
}

export interface ChatDeletionDependency {
  chatId: string;
  title: string;
}

export interface ChatDeletionBlockDetails {
  chatId: string;
  title: string;
  reason: string;
  kind: 'shared-files' | 'unverified' | 'cycle';
  dependencies: ChatDeletionDependency[];
}

export interface DeleteChatsOptions {
  /** Explicit user override: chat-folder removal may break retained attachments. */
  allowSharedAttachmentLoss?: boolean;
  /** Explicit user override: skip ownership checks and preserve all global stickers. */
  skipAttachmentCheck?: boolean;
}

export interface DeleteInfoOptions {
  /** Only size/count estimation is skipped; ownership is still checked. */
  skipSizes?: boolean;
  /** Discard a completed Meta ownership index and read attachment references again. */
  forceOwnershipCheck?: boolean;
  progress?: CalculationProgressStore;
}

export interface BatchDeleteResult {
  requested: number;
  sharedMediaCleanupFailures?: Array<{ fileName: string; error: unknown }>;
  deleted: ChatListEntry[];
  failed: Array<{
    entry: ChatListEntry;
    error: unknown;
    partial: boolean;
    blocked?: boolean;
    removedMediaCount?: number;
    jsonRetained?: boolean;
  }>;
}

export type DeletePreparationState =
  | { status: 'loading'; info?: MessengerExportDeletionInfo; calculatingSizes: boolean; sizesSkipped?: boolean; progress?: CalculationProgressStore }
  | { status: 'ready'; info: MessengerExportDeletionInfo }
  | {
      status: 'error';
      error: string;
      mediaSafetyUnavailable: boolean;
      info?: MessengerExportDeletionInfo;
    }
  | { status: 'skipped'; info?: MessengerExportDeletionInfo }
  | { status: 'unchecked' };

export interface DeleteResultNotice {
  message: string;
  failures: BatchDeleteResult['failed'];
  bookmarkCleanupError?: string;
}
