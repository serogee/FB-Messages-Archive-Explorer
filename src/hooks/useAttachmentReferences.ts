import { createContext, useContext } from 'react';
import type { AttachmentReferenceIndex } from '../services/attachmentReferenceIndex';
import { getMetaAttachmentIdentity } from '../services/metaAttachmentPaths';
import type { ResolvedAttachment } from '../types/messenger';
import { getMessengerMediaIdentity } from '../services/messengerExport/messengerExportIndex';

export const AttachmentReferencesContext = createContext<{
  index: AttachmentReferenceIndex | null;
  standaloneMessenger: boolean;
  chatId?: string;
  indexing?: boolean;
}>({ index: null, standaloneMessenger: false });

export function useAttachmentChatUsage(path: string, category?: ResolvedAttachment['category']): { count: number; complete: boolean } {
  const { index, standaloneMessenger, chatId } = useContext(AttachmentReferencesContext);
  const identity = standaloneMessenger ? getMessengerMediaIdentity(path) : getMetaAttachmentIdentity(path, chatId, category);
  return { count: identity ? index?.mediaOwners.get(identity)?.size || 0 : 0, complete: !!index?.complete };
}

export function useAttachmentReferencesIndexing(): boolean {
  return !!useContext(AttachmentReferencesContext).indexing;
}
