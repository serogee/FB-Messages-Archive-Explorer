import type { ChatListEntry } from './messenger';

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
  }>;
}
