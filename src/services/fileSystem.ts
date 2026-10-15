import type { ChatListEntry, MessengerThread } from '../types/messenger';
import { parseMessengerJsonContent, getOrderedMessageFileNames, getMessageTimestamp } from './parser';
import { processMediaFromDirectory, createMediaState } from './media';
import type { MediaState } from '../types/messenger';
import type { FolderAccessMode, ReadableDirectoryHandle, WritableDirectoryHandle } from '../types/fileSystem';
import { getMessageBump } from './messageBump';
import type { MetaArchivePlatform } from './metaAttachmentPaths';
import { runFolderOperation, type FolderOpenDiagnostics } from './folderOpenDiagnostics';
import { createConcurrencyLimiter, mapWithConcurrency, type ConcurrencyLimiter } from './concurrency';
import { performanceLimit } from './performanceSettings';

const SELECTED_MESSAGES_DIRECTORY = [] as const;
const FACEBOOK_EXPORT_MESSAGES_DIRECTORY = ['messages'] as const;
const ACCOUNTS_CENTER_MESSAGES_DIRECTORY = ['your_facebook_activity', 'messages'] as const;
const INSTAGRAM_MESSAGES_DIRECTORY = ['your_instagram_activity', 'messages'] as const;
const FACEBOOK_MESSAGES_ROOT_PATHS = [
  SELECTED_MESSAGES_DIRECTORY,
  FACEBOOK_EXPORT_MESSAGES_DIRECTORY,
  ACCOUNTS_CENTER_MESSAGES_DIRECTORY,
  INSTAGRAM_MESSAGES_DIRECTORY,
] as const;
const FACEBOOK_CONVERSATION_SECTIONS = ['inbox', 'archived_threads', 'message_requests', 'e2ee_cutover'] as const;

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

async function containsFacebookConversations(handle: ReadableDirectoryHandle, diagnostics?: FolderOpenDiagnostics, depth = 0): Promise<boolean> {
  for (const section of FACEBOOK_CONVERSATION_SECTIONS) {
    try {
      await runFolderOperation(diagnostics, 'getDirectoryHandle()', () => handle.getDirectoryHandle(section), depth);
      return true;
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }
  return false;
}

export async function resolveFacebookMessagesRoot(
  handle: ReadableDirectoryHandle
): Promise<ReadableDirectoryHandle | null> {
  return (await resolveFacebookMessagesRootInfo(handle))?.handle || null;
}

export async function resolveFacebookMessagesRootInfo(
  handle: ReadableDirectoryHandle,
  diagnostics?: FolderOpenDiagnostics,
): Promise<{ handle: ReadableDirectoryHandle; instagram: boolean; platform: MetaArchivePlatform } | null> {
  for (const path of FACEBOOK_MESSAGES_ROOT_PATHS) {
    try {
      let current = handle;
      for (let depth = 0; depth < path.length; depth++) {
        const parent = current;
        current = await runFolderOperation(diagnostics, 'getDirectoryHandle()', () => parent.getDirectoryHandle(path[depth]), depth);
      }
      if (await containsFacebookConversations(current, diagnostics, path.length)) {
        const activity = path[0] === 'your_instagram_activity' || path[0] === 'your_facebook_activity'
          ? path[0] : handle.name;
        const platform = activity === 'your_instagram_activity' ? 'instagram'
          : activity === 'your_facebook_activity' ? 'facebook' : 'unknown';
        return { handle: current, instagram: platform === 'instagram', platform };
      }
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }
  return null;
}


export function isFileSystemAccessSupported(): boolean {
  return typeof window.showDirectoryPicker === 'function';
}

export function isWriteAccessSupported(): boolean {
  return isFileSystemAccessSupported();
}


import { openFolderPolyfill } from './polyfill';

export async function pickMessagesFolder(accessMode: FolderAccessMode = 'native', onPreparationProgress?: (done: number, total: number) => void): Promise<ReadableDirectoryHandle> {
  if (accessMode === 'upload' || !isFileSystemAccessSupported()) {
    return openFolderPolyfill(onPreparationProgress);
  }
  return window.showDirectoryPicker({ id: 'messages-folder', mode: 'read' });
}

export async function pickFolderWithWriteAccess(accessMode: FolderAccessMode = 'native', onPreparationProgress?: (done: number, total: number) => void): Promise<ReadableDirectoryHandle> {
  if (accessMode === 'upload' || !isFileSystemAccessSupported()) {
    // Upload fallback handles are read-only but still support archive browsing.
    return openFolderPolyfill(onPreparationProgress);
  }
  return window.showDirectoryPicker({ id: 'messages-folder', mode: 'readwrite' });
}


export async function listChatFolders(
  parentHandle: ReadableDirectoryHandle,
  subfolderName: 'inbox' | 'archived_threads' | 'message_requests' | 'e2ee_cutover',
  source: 'inbox' | 'archived' | 'requests' | 'e2ee',
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
  diagnostics?: FolderOpenDiagnostics,
  limitRead: ConcurrencyLimiter = createConcurrencyLimiter(performanceLimit('archiveReads')),
): Promise<ChatListEntry[]> {
  throwIfAborted(signal);
  let subfolderDir: ReadableDirectoryHandle;
  try {
    subfolderDir = await runFolderOperation(diagnostics, 'getDirectoryHandle()', () => parentHandle.getDirectoryHandle(subfolderName));
  } catch {
    throwIfAborted(signal);
    if (onProgress) onProgress(0, 0);
    return [];
  }

  const handles: { name: string; handle: ReadableDirectoryHandle }[] = [];

  for await (const [name, handle] of diagnostics ? diagnostics.entries(subfolderDir) : subfolderDir.entries()) {
    throwIfAborted(signal);
    if (handle.kind === 'directory') {
      handles.push({ name, handle });
    }
  }

  throwIfAborted(signal);
  const total = handles.length;
  if (onProgress) onProgress(0, total);

  let done = 0;
  const results = await mapWithConcurrency(handles, performanceLimit('archiveReads'), ({ name, handle: chatDir }, i) => limitRead(async (): Promise<ChatListEntry | null> => {
    try {
      const fileHandle = await runFolderOperation(diagnostics, 'getFileHandle()', () => chatDir.getFileHandle('message_1.json'));
      throwIfAborted(signal);
      const file = await runFolderOperation(diagnostics, 'getFile()', () => fileHandle.getFile());
      throwIfAborted(signal);
      const content = await runFolderOperation(diagnostics, 'File.text()', () => file.text());
      throwIfAborted(signal);
      const parsed = await runFolderOperation(diagnostics, 'JSON.parse()', () => parseMessengerJsonContent(content));
      throwIfAborted(signal);

      const participants = (parsed.participants || []).map(p => p.name).filter(Boolean);

      // Parsing normalizes messages oldest-first, so the final item supplies the preview.
      const msgs = parsed.messages || [];
      const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
      const isGroup = participants.length > 2;

      let lastMessage: string | undefined;
      if (lastMsg) {
        const textContent = ((lastMsg.content || lastMsg.text || '') as string).trim();
        const senderFull = (lastMsg.senderName || lastMsg.sender_name || '').trim();
        const firstName = senderFull.split(/\s+/)[0] || senderFull;

        const bump = getMessageBump(lastMsg);
        if (bump) {
          lastMessage = bump.label;
          if (isGroup) lastMessage = bump.text ? `${firstName} bumped a message` : `${firstName}: ${bump.label}`;
        } else if (textContent) {
          lastMessage = isGroup ? `${firstName}: ${textContent.slice(0, 100)}` : textContent.slice(0, 100);
        } else {
          const attachType =
            (lastMsg.photos?.length) ? 'an image' :
            (lastMsg.videos?.length) ? 'a video' :
            (lastMsg.audio?.length || lastMsg.audio_files?.length) ? 'an audio message' :
            (lastMsg.gifs?.length) ? 'a GIF' :
            (lastMsg.files?.length) ? 'a file' :
            lastMsg.sticker ? 'a sticker' :
            (lastMsg.media?.length) ? 'an attachment' : null;
          if (attachType) {
            lastMessage = isGroup ? `${firstName} sent ${attachType}` : `Sent ${attachType}`;
          }
        }
      }
      const lastTimestamp = lastMsg ? getMessageTimestamp(lastMsg) ?? undefined : undefined;

      let jsonFileCount = 0;
      for await (const [entryName, entryHandle] of diagnostics ? diagnostics.entries(chatDir) : chatDir.entries()) {
        throwIfAborted(signal);
        if (entryHandle.kind === 'file' && /message_\d+\.json$/i.test(entryName)) {
          jsonFileCount++;
        }
      }

      return {
        folderName: name,
        title: parsed.title || name,
        participants,
        lastMessage,
        lastTimestamp,
        messageCount: msgs.length,
        folderSize: 0,
        dirHandle: chatDir,
        jsonFileCount,
        source,
      };
    } catch {
      throwIfAborted(signal);
      // One inaccessible conversation must not prevent listing the rest of the archive.
      return null;
    } finally {
      if (!signal?.aborted) onProgress?.(++done, total);
      // Bound uninterrupted listing work so large archives remain responsive.
      if (i % 10 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
  }, signal), signal);
  const entries = results.filter((entry): entry is ChatListEntry => entry !== null);

  entries.sort((a, b) => {
    if (a.lastTimestamp == null && b.lastTimestamp == null) return 0;
    if (a.lastTimestamp == null) return 1;
    if (b.lastTimestamp == null) return -1;
    return b.lastTimestamp - a.lastTimestamp;
  });

  return entries;
}


const loadedReactionFiles = new WeakMap<MessengerThread, File[]>();
export const getLoadedReactionFiles = (data: MessengerThread): File[] | undefined => loadedReactionFiles.get(data);

export async function loadChatMessages(
  chatDirHandle: ReadableDirectoryHandle,
  onProgress?: (progress: number, statusText: string) => void,
  signal?: AbortSignal
): Promise<MessengerThread> {
  // Let the browser paint the loading state before file scanning begins.
  await new Promise(r => setTimeout(r, 10));
  throwIfAborted(signal);
  onProgress?.(0, "Scanning files...");

  const fileNames: string[] = [];
  for await (const [name, handle] of chatDirHandle.entries()) {
    throwIfAborted(signal);
    if (handle.kind === 'file') fileNames.push(name);
  }

  throwIfAborted(signal);
  const orderedNames = getOrderedMessageFileNames(fileNames);
  if (!orderedNames.length) {
    throw new Error('No readable message files found in this chat folder.');
  }

  let complete = true;
  let prepared = 0;
  const snapshots = await mapWithConcurrency(orderedNames, performanceLimit('archiveReads'), async name => {
    try {
      const fileHandle = await chatDirHandle.getFileHandle(name);
      throwIfAborted(signal);
      const file = await fileHandle.getFile();
      throwIfAborted(signal);
      return file;
    } catch {
      throwIfAborted(signal);
      complete = false;
      return null; // Keep readable messages; estimates require the full inventory.
    } finally {
      if (!signal?.aborted) onProgress?.(0.05 * ++prepared / orderedNames.length, "Preparing files...");
    }
  }, signal);
  const files = snapshots.filter((file): file is File => file !== null);

  if (!files.length) {
    throw new Error('No readable message files found in this chat folder.');
  }

  onProgress?.(0.10, "Processing data in background...");

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./parserWorker.ts', import.meta.url), { type: 'module' });
    const limit = performanceLimit('archiveReads');
    const stopUpdates = limit.subscribe(() => worker.postMessage({ type: 'concurrency', concurrency: limit.get() }));
    
    const abortHandler = () => {
      stopUpdates();
      worker.terminate();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    
    if (signal) {
      if (signal.aborted) {
        abortHandler();
        return;
      }
      signal.addEventListener('abort', abortHandler);
    }
    
    worker.onmessage = (e) => {
      stopUpdates();
      if (signal) signal.removeEventListener('abort', abortHandler);
      if (e.data.type === 'success') {
        const data = e.data.data as MessengerThread;
        delete data._reactionSnapshot;
        data._reactionInputComplete = complete && e.data.complete !== false;
        data._standaloneMessenger = false;
        loadedReactionFiles.set(data, files);
        resolve(data);
      } else {
        reject(new Error(e.data.error || 'Worker parsing failed'));
      }
      worker.terminate();
    };
    
    worker.onerror = (e) => {
      stopUpdates();
      if (signal) signal.removeEventListener('abort', abortHandler);
      reject(new Error(`Worker error: ${e.message}`));
      worker.terminate();
    };
    
    try { worker.postMessage({ files, concurrency: limit.get() }); }
    catch (error) {
      stopUpdates();
      signal?.removeEventListener('abort', abortHandler);
      worker.terminate();
      reject(error);
    }
  });
}


export async function computeFolderSize(
  dirHandle: ReadableDirectoryHandle,
  signal?: AbortSignal,
  limitRead?: ConcurrencyLimiter,
): Promise<number> {
  throwIfAborted(signal);
  let total = 0;
  for await (const [, entry] of dirHandle.entries()) {
    throwIfAborted(signal);
    if (entry.kind === 'file') {
      try {
        throwIfAborted(signal);
        const file = limitRead ? await limitRead(() => entry.getFile(), signal) : await entry.getFile();
        throwIfAborted(signal);
        total += file.size;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        /* Ignore unreadable files. */
      }
    } else if (entry.kind === 'directory') {
      total += await computeFolderSize(entry, signal, limitRead);
    }
  }
  throwIfAborted(signal);
  return total;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}


export async function deleteChat(
  parentHandle: WritableDirectoryHandle,
  subfolderName: string,
  chatFolderName: string,
  beforeRemove?: () => void,
): Promise<void> {
  const subDir = await parentHandle.getDirectoryHandle(subfolderName);
  beforeRemove?.();
  await subDir.removeEntry(chatFolderName, { recursive: true });
}


export async function loadChatMedia(
  chatDirHandle: ReadableDirectoryHandle
): Promise<MediaState> {
  const state = createMediaState();
  await processMediaFromDirectory(chatDirHandle, state);
  return state;
}
