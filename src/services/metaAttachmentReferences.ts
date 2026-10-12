import type { ReadableDirectoryHandle } from '../types/fileSystem';
import { addAttachmentOwner, createAttachmentReferenceIndex, type AttachmentReferenceIndex } from './attachmentReferenceIndex';
import { fixEncoding } from './parser';
import { mapWithConcurrency } from './concurrency';
import type { CalculationProgress } from './calculationProgress';
import {
  getAttachmentFolderChatId, getMetaAttachmentPath, getSharedStickerFileName, isRemoteAttachmentPath,
} from './metaAttachmentPaths';

export interface MetaAttachmentReferenceIndex extends AttachmentReferenceIndex {
  deletionSupported: boolean;
  chatTitles: Map<string, string>;
  /** Only dependencies crossing chat folders; local files do not duplicate this index. */
  folderReferences: Map<string, Set<string>>;
  warnings: Array<{ path: string; reason: string }>;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

const ATTACHMENT_FIELDS = ['photos', 'videos', 'audio', 'audio_files', 'gifs', 'files', 'media', 'sticker'];
const PATH_FIELDS = ['uri', 'filename', 'path', 'name'];
const SCAN_CONCURRENCY = 4;
const REFERENCE_CACHE_LIMIT = 512;
const ATTACHMENT_DIRECTORIES = new Set(['photos', 'videos', 'audio', 'audio_files', 'gifs', 'files', 'media', 'stickers', 'stickers_used']);

/** Scan every conversation, including unreadable/unlisted chats and split files. */
export async function buildMetaAttachmentReferenceIndex(
  root: ReadableDirectoryHandle,
  signal?: AbortSignal,
  deletionSupported = true,
  onProgress?: (progress: CalculationProgress) => void,
): Promise<MetaAttachmentReferenceIndex> {
  const index: MetaAttachmentReferenceIndex = {
    ...createAttachmentReferenceIndex(), deletionSupported, chatTitles: new Map(), folderReferences: new Map(), warnings: [],
  };
  const warningKeys = new Set<string>();
  let checkedFiles = 0;
  let checkedFolders = 0;
  let discoveredEntries = 0;
  const reportDiscovery = (finished = false) => onProgress?.({
    stage: 'ownership', label: 'Scanning chat folders', done: checkedFolders,
    total: finished ? checkedFolders : undefined, unit: 'folders',
    detail: `${checkedFiles.toLocaleString()} JSON files checked · ${discoveredEntries.toLocaleString()} entries discovered`,
  });
  reportDiscovery();
  const incomplete = (path: string, reason: string) => {
    index.complete = false;
    const key = `${path}:${reason}`;
    if (!warningKeys.has(key)) { warningKeys.add(key); index.warnings.push({ path, reason }); }
  };
  let lastYield = performance.now();
  let pendingYield: Promise<void> | undefined;
  const yieldIfNeeded = async () => {
    if (!pendingYield && performance.now() - lastYield > 16) {
      pendingYield = new Promise<void>(resolve => setTimeout(resolve, 0)).then(() => {
        lastYield = performance.now();
        pendingYield = undefined;
      });
    }
    if (pendingYield) await pendingYield;
    throwIfAborted(signal);
  };
  const directories: Array<{ handle: ReadableDirectoryHandle; path: string; attachments: boolean }> = [];
  const scan = async (directory: ReadableDirectoryHandle, directoryPath: string, attachments = false): Promise<void> => {
    throwIfAborted(signal);
    const childDirectories: Array<{ handle: ReadableDirectoryHandle; path: string; name: string }> = [];
    let isConversationDirectory = false;
    // Keep caches local to a chat: identical relative names in different chats
    // must still resolve to different files. Bound memory even in large chats.
    const referenceCaches = new Map<string, Map<string, { identity: string; filePath: string; folderId: string | null }>>();
    const chatIdLower = directoryPath.toLowerCase();
    try {
      for await (const [name, handle] of directory.entries()) {
        throwIfAborted(signal);
        discoveredEntries++;
        if (discoveredEntries % 64 === 0) reportDiscovery();
        await yieldIfNeeded();
        if (handle.kind === 'directory') {
          if (!directoryPath && name.toLowerCase() === 'stickers_used') continue;
          childDirectories.push({ handle, path: directoryPath ? `${directoryPath}/${name}` : name, name });
          continue;
        }
        if (!/\.json$/i.test(name)) continue;
        // Ordinary JSON below a conversation's media folders is an attached
        // document. Still inspect export-named JSON there: unusual retained
        // conversations must not lose their ownership protection.
        if (attachments && !/^message_\d+\.json$/i.test(name)) continue;
        // A malformed or unreadable conversation must still protect retained
        // files, even when its contents cannot confirm this folder's role.
        if (/^message_\d+\.json$/i.test(name)) isConversationDirectory = true;
        try {
          const file = await handle.getFile();
          throwIfAborted(signal);
          const raw: unknown = JSON.parse(await file.text());
          throwIfAborted(signal);
          if (!raw || typeof raw !== 'object' || !('messages' in raw) || !Array.isArray(raw.messages)) {
            if (/^message_\d+\.json$/i.test(name) || (raw && typeof raw === 'object' && 'messages' in raw)) incomplete(`${directoryPath}/${name}`, 'Malformed conversation');
            continue;
          }
          isConversationDirectory = true;
          const chatId = directoryPath;
          const title = 'title' in raw && typeof raw.title === 'string' ? fixEncoding(raw.title) : chatId;
          index.chatTitles.set(chatId, title || chatId);
          let identities = index.chatMedia.get(chatId);
          if (!identities) { identities = new Set(); index.chatMedia.set(chatId, identities); }
          for (let messageIndex = 0; messageIndex < raw.messages.length; messageIndex++) {
            if (messageIndex % 256 === 0) await yieldIfNeeded();
            const message = raw.messages[messageIndex];
            if (!message || typeof message !== 'object' || Array.isArray(message)) { incomplete(`${directoryPath}/${name}`, 'Malformed message'); continue; }
            for (const field of ATTACHMENT_FIELDS) {
              const value = message[field];
              if (value == null) continue;
              const items = field === 'sticker' ? [value] : value;
              if (!Array.isArray(items)) { incomplete(`${directoryPath}/${name}`, `Malformed ${field} container`); continue; }
              for (const item of items) {
                if (!item || typeof item !== 'object' || Array.isArray(item)) { incomplete(`${directoryPath}/${name}`, `Malformed ${field} attachment`); continue; }
                let firstPath: unknown;
                let ambiguous = false;
                for (const key of PATH_FIELDS) {
                  const path = item[key];
                  if (path == null) continue;
                  if (typeof path !== 'string' || (firstPath !== undefined && path !== firstPath)) ambiguous = true;
                  firstPath = path;
                }
                if (ambiguous) incomplete(`${directoryPath}/${name}`, 'Ambiguous attachment fields');
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
                  if (/^(?:\.\/)?your_instagram_activity[\\/]messages[\\/]/i.test(reference)) index.deletionSupported = false;
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
        } catch (error) {
          throwIfAborted(signal);
          if (error instanceof DOMException && error.name === 'AbortError') throw error;
          incomplete(`${directoryPath}/${name}`, error instanceof Error ? error.message : 'Unreadable conversation');
        } finally {
          checkedFiles++;
          reportDiscovery();
        }
        await yieldIfNeeded();
      }
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      incomplete(directoryPath, error instanceof Error ? error.message : 'Unreadable directory');
    } finally {
      checkedFolders++;
      reportDiscovery();
    }
    // Decide after reading the parent's JSON: directory enumeration can list
    // "files" before message_1.json. The attachment role continues through
    // nested media folders, but top-level and unlisted chat sections stay open.
    for (const child of childDirectories) {
      directories.push({ handle: child.handle, path: child.path,
        attachments: attachments || (isConversationDirectory && ATTACHMENT_DIRECTORIES.has(child.name.toLowerCase())),
      });
    }
  };
  // Enumerate the root first, then drain the growing directory queue. Keep
  // unexpected conversation sections, but do not parse ordinary attached JSON.
  await scan(root, '');
  let nextDirectory = 0;
  while (nextDirectory < directories.length) {
    const batch = directories.slice(nextDirectory, nextDirectory + SCAN_CONCURRENCY);
    nextDirectory += batch.length;
    await mapWithConcurrency(batch, SCAN_CONCURRENCY, directory => scan(directory.handle, directory.path, directory.attachments), signal);
  }
  throwIfAborted(signal);
  reportDiscovery(true);
  // Missing cross-folder files cannot be removed by deleting a folder. Keep
  // their usage counts, but exclude them from folder deletion dependencies.
  const crossFolderFiles = new Set([...index.folderReferences.values()].flatMap(identities => [...identities]));
  let verifiedFiles = 0;
  const reportVerification = () => onProgress?.({ stage: 'verification', label: 'Verifying shared files', done: verifiedFiles, total: crossFolderFiles.size, unit: 'files' });
  if (crossFolderFiles.size > 0) reportVerification();
  const missing = await mapWithConcurrency([...crossFolderFiles], 4, async identity => {
    const parts = index.mediaFiles.get(identity)!.split('/');
    try {
      let directory = root;
      for (const part of parts.slice(0, -1)) {
        throwIfAborted(signal);
        directory = await directory.getDirectoryHandle(part);
      }
      await directory.getFileHandle(parts[parts.length - 1]);
      throwIfAborted(signal);
      return null;
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof DOMException && error.name === 'NotFoundError') return identity;
      incomplete(identity, error instanceof Error ? error.message : 'Cross-folder file could not be verified');
      return null;
    } finally {
      verifiedFiles++;
      reportVerification();
    }
  }, signal);
  for (const identity of missing) if (identity) {
    for (const references of index.folderReferences.values()) references.delete(identity);
  }
  return index;
}
