import { addAttachmentOwner, createAttachmentReferenceIndex, type AttachmentReferenceIndex } from './attachmentReferenceIndex';
import { fixEncoding } from './parser';
import { getAttachmentFolderChatId, getMetaAttachmentPath, getSharedStickerFileName, isRemoteAttachmentPath, type MetaArchivePlatform } from './metaAttachmentPaths';

export interface MetaAttachmentReferenceIndex extends AttachmentReferenceIndex {
  deletionSupported: boolean;
  chatTitles: Map<string, string>;
  /** Only dependencies crossing chat folders; local files do not duplicate this index. */
  folderReferences: Map<string, Set<string>>;
  warnings: Array<{ path: string; reason: string }>;
}

const ATTACHMENT_FIELDS = ['photos', 'videos', 'audio', 'audio_files', 'gifs', 'files', 'media', 'sticker'];
const PATH_FIELDS = ['uri', 'filename', 'path', 'name'];
const REFERENCE_CACHE_LIMIT = 512;

/** Shared by the worker and the non-browser fallback; never returns message bodies. */
export function createMetaAttachmentAccumulator(platform: MetaArchivePlatform | boolean) {
  let facebookSeen = platform === 'facebook' || platform === true;
  let instagramSeen = platform === 'instagram' || platform === false;
  const index: MetaAttachmentReferenceIndex = {
    ...createAttachmentReferenceIndex(), deletionSupported: facebookSeen && !instagramSeen,
    chatTitles: new Map(), folderReferences: new Map(), warnings: [],
  };
  const warningKeys = new Set<string>();
  const incomplete = (path: string, reason: string) => {
    index.complete = false;
    const key = `${path}:${reason}`;
    if (!warningKeys.has(key)) { warningKeys.add(key); index.warnings.push({ path, reason }); }
  };
  const process = async (raw: unknown, chatId: string, name: string, yieldIfNeeded: () => Promise<void> = async () => {}): Promise<boolean> => {
    const conversationPath = `${chatId}/${name}`;
    if (!raw || typeof raw !== 'object' || !('messages' in raw) || !Array.isArray(raw.messages)) {
      if (/^message_\d+\.json$/i.test(name) || (raw && typeof raw === 'object' && 'messages' in raw)) incomplete(conversationPath, 'Malformed conversation');
      return false;
    }
    const referenceCaches = new Map<string, Map<string, { identity: string; filePath: string; folderId: string | null }>>();
    const chatIdLower = chatId.toLowerCase();
    const title = 'title' in raw && typeof raw.title === 'string' ? fixEncoding(raw.title) : chatId;
    index.chatTitles.set(chatId, title || chatId);
    let identities = index.chatMedia.get(chatId);
    if (!identities) { identities = new Set(); index.chatMedia.set(chatId, identities); }
    for (let messageIndex = 0; messageIndex < raw.messages.length; messageIndex++) {
      if (messageIndex % 256 === 0) await yieldIfNeeded();
      const message = raw.messages[messageIndex];
      if (!message || typeof message !== 'object' || Array.isArray(message)) { incomplete(conversationPath, 'Malformed message'); continue; }
      for (const field of ATTACHMENT_FIELDS) {
        const value = message[field];
        if (value == null) continue;
        const items = field === 'sticker' ? [value] : value;
        if (!Array.isArray(items)) { incomplete(conversationPath, `Malformed ${field} container`); continue; }
        for (const item of items) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) { incomplete(conversationPath, `Malformed ${field} attachment`); continue; }
          let firstPath: unknown;
          let ambiguous = false;
          for (const key of PATH_FIELDS) {
            const path = item[key];
            if (path == null) continue;
            if (typeof path !== 'string' || (firstPath !== undefined && path !== firstPath)) ambiguous = true;
            firstPath = path;
          }
          if (ambiguous) incomplete(conversationPath, 'Ambiguous attachment fields');
          const rawReference = String(item.uri || item.filename || item.path || item.name || '');
          // Export placeholders without a path do not refer to a file.
          if (!rawReference) continue;
          let cache = referenceCaches.get(field);
          if (!cache) { cache = new Map(); referenceCaches.set(field, cache); }
          let resolved = cache.get(rawReference);
          if (!resolved) {
            const reference = fixEncoding(rawReference);
            // A URL refers to a remote asset, never a local deletion target.
            if (isRemoteAttachmentPath(reference)) continue;
            if (/^(?:\.\/)?your_instagram_activity[\\/]messages[\\/]/i.test(reference)) instagramSeen = true;
            if (/^(?:\.\/)?your_facebook_activity[\\/]messages[\\/]/i.test(reference)) facebookSeen = true;
            index.deletionSupported = facebookSeen && !instagramSeen;
            const stickerName = getSharedStickerFileName(reference);
            if ((field === 'sticker' || /stickers_used/i.test(reference)) && !stickerName) incomplete(reference, 'Unsupported local sticker path');
            const relativePath = getMetaAttachmentPath(reference, chatId, field);
            if (!relativePath) { incomplete(reference, 'Unsupported local attachment path'); continue; }
            const containingChat = getAttachmentFolderChatId(relativePath)?.toLowerCase();
            resolved = {
              identity: relativePath.toLowerCase(), filePath: stickerName || relativePath,
              folderId: containingChat && containingChat !== chatIdLower ? containingChat : null,
            };
            if (cache.size < REFERENCE_CACHE_LIMIT) cache.set(rawReference, resolved);
          }
          const { identity, filePath, folderId } = resolved;
          const existing = index.mediaFiles.get(identity);
          if (existing && existing !== filePath) incomplete(identity, `Ambiguous local paths: ${existing} / ${filePath}`);
          index.mediaFiles.set(identity, filePath);
          if (identities.has(identity)) continue;
          identities.add(identity);
          addAttachmentOwner(index, identity, chatId);
          if (folderId) {
            let dependencies = index.folderReferences.get(folderId);
            if (!dependencies) { dependencies = new Set(); index.folderReferences.set(folderId, dependencies); }
            dependencies.add(identity);
          }
        }
      }
    }
    return true;
  };
  return { index, incomplete, process };
}
