import type { ChatListEntry, MessengerThread } from '../types/messenger';
import { parseMessengerJsonContent, mergeMessengerData, normalizeMessengerData, getOrderedMessageFileNames, getMessageTimestamp } from './parser';
import { processMediaFromDirectory, createMediaState } from './media';
import type { MediaState } from '../types/messenger';

// ── Browser support detection ──────────────────────────────────────

export function isFileSystemAccessSupported(): boolean {
  return typeof window.showDirectoryPicker === 'function';
}

export function isWriteAccessSupported(): boolean {
  return isFileSystemAccessSupported();
}

// ── Folder pickers ─────────────────────────────────────────────────

export async function pickMessagesFolder(): Promise<FileSystemDirectoryHandle> {
  return window.showDirectoryPicker({ id: 'messages-folder', mode: 'read' });
}

export async function pickFolderWithWriteAccess(): Promise<FileSystemDirectoryHandle> {
  return window.showDirectoryPicker({ id: 'messages-folder', mode: 'readwrite' });
}

// ── List chat folders ──────────────────────────────────────────────

export async function listChatFolders(
  parentHandle: FileSystemDirectoryHandle,
  subfolderName: 'inbox' | 'archived_threads' | 'message_requests' | 'e2ee_cutover',
  source: 'inbox' | 'archived' | 'requests' | 'e2ee'
): Promise<ChatListEntry[]> {
  let subfolderDir: FileSystemDirectoryHandle;
  try {
    subfolderDir = await parentHandle.getDirectoryHandle(subfolderName);
  } catch {
    return [];
  }

  const entries: ChatListEntry[] = [];

  for await (const [name, handle] of subfolderDir.entries()) {
    if (handle.kind !== 'directory') continue;
    const chatDir = handle as FileSystemDirectoryHandle;

    try {
      // Read message_1.json header
      const fileHandle = await chatDir.getFileHandle('message_1.json');
      const file = await fileHandle.getFile();
      const content = await file.text();
      const parsed = parseMessengerJsonContent(content);

      // Extract participants
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
          // Detect attachment type
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

      // Count JSON files
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
  }

  // Sort by lastTimestamp descending; entries with no timestamp go last
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
  chatDirHandle: FileSystemDirectoryHandle,
  onProgress?: (done: number, total: number) => void
): Promise<MessengerThread> {
  // Collect all file names
  const fileNames: string[] = [];
  for await (const [name, handle] of chatDirHandle.entries()) {
    if (handle.kind === 'file') fileNames.push(name);
  }

  const orderedNames = getOrderedMessageFileNames(fileNames);
  const parsedFiles: MessengerThread[] = [];
  const total = orderedNames.length;

  for (let i = 0; i < orderedNames.length; i++) {
    const name = orderedNames[i];
    try {
      const fileHandle = await chatDirHandle.getFileHandle(name);
      const file = await fileHandle.getFile();
      const content = await file.text();
      parsedFiles.push(parseMessengerJsonContent(content));
    } catch { /* skip failed files */ }
    onProgress?.(i + 1, total);
  }

  if (!parsedFiles.length) {
    throw new Error('No readable message files found in this chat folder.');
  }

  const merged = mergeMessengerData(parsedFiles);
  return normalizeMessengerData(merged);
}

// ── Compute folder size ────────────────────────────────────────────

export async function computeFolderSize(dirHandle: FileSystemDirectoryHandle): Promise<number> {
  let total = 0;
  for await (const [, entry] of dirHandle.entries()) {
    if (entry.kind === 'file') {
      try {
        const file = await (entry as FileSystemFileHandle).getFile();
        total += file.size;
      } catch { /* ignore */ }
    } else if (entry.kind === 'directory') {
      total += await computeFolderSize(entry as FileSystemDirectoryHandle);
    }
  }
  return total;
}

// ── Delete a chat folder ───────────────────────────────────────────

export async function deleteChat(
  parentHandle: FileSystemDirectoryHandle,
  subfolderName: string,
  chatFolderName: string
): Promise<void> {
  const subDir = await parentHandle.getDirectoryHandle(subfolderName);
  await subDir.removeEntry(chatFolderName, { recursive: true });
}

// ── Load media for a chat ─────────────────────────────────────────

export async function loadChatMedia(
  chatDirHandle: FileSystemDirectoryHandle
): Promise<MediaState> {
  const state = createMediaState();
  await processMediaFromDirectory(chatDirHandle, state);
  return state;
}
