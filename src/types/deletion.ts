import type { ChatListEntry } from './messenger';
import type { MessengerExportDeletionInfo } from '../services/messengerExport';

export type DeleteProgressStage = 'preparing' | 'media' | 'chat' | 'bookmarks';

export interface DeleteProgress {
  stage: DeleteProgressStage;
  done: number;
  total: number;
}

export interface BatchDeleteResult {
  requested: number;
  deleted: ChatListEntry[];
  failed: Array<{
    entry: ChatListEntry;
    error: unknown;
    partial: boolean;
    removedMediaCount?: number;
    jsonRetained?: boolean;
  }>;
}

export type DeletePreparationState =
  | { status: 'loading'; info?: MessengerExportDeletionInfo; calculatingSizes: boolean }
  | { status: 'ready'; info: MessengerExportDeletionInfo }
  | {
      status: 'error';
      error: string;
      mediaSafetyUnavailable: boolean;
      info?: MessengerExportDeletionInfo;
    }
  | { status: 'skipped' };

export interface DeleteResultNotice {
  message: string;
  failures: BatchDeleteResult['failed'];
  bookmarkCleanupError?: string;
}
