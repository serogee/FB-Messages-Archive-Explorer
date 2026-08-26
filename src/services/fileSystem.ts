import type { ChatListEntry, MessengerThread } from '../types/messenger';
import { parseMessengerJsonContent, getOrderedMessageFileNames, getMessageTimestamp } from './parser';
import { processMediaFromDirectory, createMediaState } from './media';
import type { MediaState } from '../types/messenger';
import type { ReadableDirectoryHandle, WritableDirectoryHandle } from '../types/fileSystem';

const SELECTED_MESSAGES_DIRECTORY = [] as const;
const FACEBOOK_EXPORT_MESSAGES_DIRECTORY = ['messages'] as const;
const ACCOUNTS_CENTER_MESSAGES_DIRECTORY = ['your_facebook_activity', 'messages'] as const;
const FACEBOOK_MESSAGES_ROOT_PATHS = [
  SELECTED_MESSAGES_DIRECTORY,
  FACEBOOK_EXPORT_MESSAGES_DIRECTORY,
  ACCOUNTS_CENTER_MESSAGES_DIRECTORY,
] as const;
const FACEBOOK_CONVERSATION_SECTIONS = ['inbox', 'archived_threads'] as const;

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

async function containsFacebookConversations(handle: ReadableDirectoryHandle): Promise<boolean> {
  for (const section of FACEBOOK_CONVERSATION_SECTIONS) {
    try {
      await handle.getDirectoryHandle(section);
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
  for (const path of FACEBOOK_MESSAGES_ROOT_PATHS) {
    try {
      let current = handle;
      for (const segment of path) {
        current = await current.getDirectoryHandle(segment);
      }
      if (await containsFacebookConversations(current)) return current;
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }
  return null;
}

// ── Browser support detection ──────────────────────────────────────

export function isFileSystemAccessSupported(): boolean {
  return typeof window.showDirectoryPicker === 'function';
}

export function isWriteAccessSupported(): boolean {
  return isFileSystemAccessSupported();
}

// ── Folder pickers ─────────────────────────────────────────────────

import { openFolderPolyfill } from './polyfill';

export async function pickMessagesFolder(): Promise<ReadableDirectoryHandle> {
  if (!isFileSystemAccessSupported()) {
    return openFolderPolyfill();
  }
  return window.showDirectoryPicker({ id: 'messages-folder', mode: 'read' });
}

export async function pickFolderWithWriteAccess(): Promise<ReadableDirectoryHandle> {
  if (!isFileSystemAccessSupported()) {
    // Write access is not supported via polyfill, but we can still read
    return openFolderPolyfill();
  }
  return window.showDirectoryPicker({ id: 'messages-folder', mode: 'readwrite' });
}

// ── List chat folders ──────────────────────────────────────────────

export async function listChatFolders(
  parentHandle: ReadableDirectoryHandle,
  subfolderName: 'inbox' | 'archived_threads' | 'message_requests' | 'e2ee_cutover',
  source: 'inbox' | 'archived' | 'requests' | 'e2ee',
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<ChatListEntry[]> {
  let subfolderDir: ReadableDirectoryHandle;
  try {
    subfolderDir = await parentHandle.getDirectoryHandle(subfolderName);
  } catch {
    if (onProgress) onProgress(0, 0);
    return [];
  }

  const entries: ChatListEntry[] = [];
  const handles: { name: string; handle: ReadableDirectoryHandle }[] = [];

  for await (const [name, handle] of subfolderDir.entries()) {
    if (signal?.aborted) return entries;
    if (handle.kind === 'directory') {
      handles.push({ name, handle });
    }
  }

  const total = handles.length;
  if (onProgress) onProgress(0, total);

  for (let i = 0; i < handles.length; i++) {
    if (signal?.aborted) return entries;
    const { name, handle: chatDir } = handles[i];

    try {
      const fileHandle = await chatDir.getFileHandle('message_1.json');
      const file = await fileHandle.getFile();
      const content = await file.text();
      const parsed = parseMessengerJsonContent(content);

      const participants = (parsed.participants || []).map(p => p.name).filter(Boolean);

      // Last message: after parseMessengerJsonContent the messages are reversed so
      // the array is chronological (oldest first). Last item = newest message.
      const msgs = parsed.messages || [];
      const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
      const isGroup = participants.length > 2;

      let lastMessage: string | undefined;
      if (lastMsg) {
        const textContent = ((lastMsg.content || lastMsg.text || '') as string).trim();
        const senderFull = (lastMsg.senderName || lastMsg.sender_name || '').trim();
        const firstName = senderFull.split(/\s+/)[0] || senderFull;

        if (textContent) {
          lastMessage = isGroup ? `${firstName}: ${textContent.slice(0, 100)}` : textContent.slice(0, 100);
        } else {
          const attachType =
            (lastMsg.photos?.length) ? 'an image' :
            (lastMsg.videos?.length) ? 'a video' :
            (lastMsg.audio?.length || lastMsg.audio_files?.length) ? 'an audio message' :
            (lastMsg.gifs?.length) ? 'a GIF' :
            (lastMsg.files?.length) ? 'a file' :
            (lastMsg.media?.length) ? 'an attachment' : null;
          if (attachType) {
            lastMessage = isGroup ? `${firstName} sent ${attachType}` : `Sent ${attachType}`;
          }
        }
      }
      const lastTimestamp = lastMsg ? getMessageTimestamp(lastMsg) ?? undefined : undefined;

      let jsonFileCount = 0;
      for await (const [entryName, entryHandle] of chatDir.entries()) {
        if (entryHandle.kind === 'file' && /message_\d+\.json$/i.test(entryName)) {
          jsonFileCount++;
        }
      }

      entries.push({
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
      });
    } catch {
      // Skip unreadable folders
    }

    if (onProgress) onProgress(i + 1, total);
    // Yield occasionally to prevent UI freezes
    if (i % 10 === 0) {
      await new Promise(r => setTimeout(r, 0));
    }
  }

  entries.sort((a, b) => {
    if (a.lastTimestamp == null && b.lastTimestamp == null) return 0;
    if (a.lastTimestamp == null) return 1;
    if (b.lastTimestamp == null) return -1;
    return b.lastTimestamp - a.lastTimestamp;
  });

  return entries;
}

// ── Load full chat ─────────────────────────────────────────────────

export async function loadChatMessages(
  chatDirHandle: ReadableDirectoryHandle,
  onProgress?: (progress: number, statusText: string) => void,
  signal?: AbortSignal
): Promise<MessengerThread> {
  // Yield immediately to let the browser paint the loading state
  await new Promise(r => setTimeout(r, 10));
  onProgress?.(0, "Scanning files...");

  const fileNames: string[] = [];
  for await (const [name, handle] of chatDirHandle.entries()) {
    if (handle.kind === 'file') fileNames.push(name);
  }

  const orderedNames = getOrderedMessageFileNames(fileNames);
  if (!orderedNames.length) {
    throw new Error('No readable message files found in this chat folder.');
  }

  const files: File[] = [];
  for (let i = 0; i < orderedNames.length; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const name = orderedNames[i];
    try {
      const fileHandle = await chatDirHandle.getFileHandle(name);
      files.push(await fileHandle.getFile());
    } catch { /* skip */ }
    // Scanning files is fast, but update progress so user knows it's working
    onProgress?.(0.05 * (i + 1) / orderedNames.length, "Preparing files...");
  }

  if (!files.length) {
    throw new Error('No readable message files found in this chat folder.');
  }

  onProgress?.(0.10, "Processing data in background...");

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./parserWorker.ts', import.meta.url), { type: 'module' });
    
    const abortHandler = () => {
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
      if (signal) signal.removeEventListener('abort', abortHandler);
      if (e.data.type === 'success') {
        resolve(e.data.data);
      } else {
        reject(new Error(e.data.error || 'Worker parsing failed'));
      }
      worker.terminate();
    };
    
    worker.onerror = (e) => {
      if (signal) signal.removeEventListener('abort', abortHandler);
      reject(new Error(`Worker error: ${e.message}`));
      worker.terminate();
    };
    
    worker.postMessage({ files });
  });
}

// ── Compute folder size ────────────────────────────────────────────

export async function computeFolderSize(dirHandle: ReadableDirectoryHandle): Promise<number> {
  let total = 0;
  for await (const [, entry] of dirHandle.entries()) {
    if (entry.kind === 'file') {
      try {
        const file = await entry.getFile();
        total += file.size;
      } catch { /* ignore */ }
    } else if (entry.kind === 'directory') {
      total += await computeFolderSize(entry);
    }
  }
  return total;
}

// ── Delete a chat folder ───────────────────────────────────────────

export async function deleteChat(
  parentHandle: WritableDirectoryHandle,
  subfolderName: string,
  chatFolderName: string
): Promise<void> {
  const subDir = await parentHandle.getDirectoryHandle(subfolderName);
  await subDir.removeEntry(chatFolderName, { recursive: true });
}

// ── Load media for a chat ─────────────────────────────────────────

export async function loadChatMedia(
  chatDirHandle: ReadableDirectoryHandle
): Promise<MediaState> {
  const state = createMediaState();
  await processMediaFromDirectory(chatDirHandle, state);
  return state;
}
