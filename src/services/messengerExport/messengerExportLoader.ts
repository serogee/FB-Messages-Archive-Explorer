import type { ChatListEntry, MessengerThread } from '../../types/messenger';
import type { ReadableDirectoryHandle, ReadableFileHandle } from '../../types/fileSystem';
import { getMessageTimestamp } from '../parser';
import {
  classifyMessengerExportJson,
  getMessengerExportLastMessage,
} from './messengerExportParser';
import {
  addConversationToChatIndex,
  createMessengerExportChatIndex,
  markMessengerExportIndexIncomplete,
  type MessengerExportChatIndex,
} from './messengerExportIndex';

function jsonStem(fileName: string): string {
  return fileName.replace(/\.json$/i, '');
}

function describeLastMessage(thread: MessengerThread): { lastMessage?: string; lastTimestamp?: number } {
  const lastMsg = getMessengerExportLastMessage(thread);
  if (!lastMsg) return {};

  const text = String(lastMsg.content || lastMsg.text || '').trim();
  const sender = String(lastMsg.senderName || lastMsg.sender_name || '').trim();
  const firstName = sender.split(/\s+/)[0] || sender;
  const isGroup = (thread.participants || []).length > 2;

  let lastMessage: string | undefined;
  if (text) {
    lastMessage = isGroup ? `${firstName}: ${text.slice(0, 100)}` : text.slice(0, 100);
  } else {
    const attachType =
      lastMsg.photos?.length ? 'an image' :
      lastMsg.videos?.length ? 'a video' :
      (lastMsg.audio?.length || lastMsg.audio_files?.length) ? 'an audio message' :
      lastMsg.gifs?.length ? 'a GIF' :
      lastMsg.files?.length ? 'a file' :
      lastMsg.media?.length ? 'an attachment' : null;
    if (attachType) {
      lastMessage = isGroup ? `${firstName} sent ${attachType}` : `Sent ${attachType}`;
    }
  }

  return {
    lastMessage,
    lastTimestamp: getMessageTimestamp(lastMsg) ?? undefined,
  };
}

export interface MessengerExportListingResult {
  entries: ChatListEntry[];
  chatIndex: MessengerExportChatIndex;
}

export async function listMessengerExportChatsIndexed(
  handle: ReadableDirectoryHandle,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<MessengerExportListingResult> {
  const fileHandles: Array<{ name: string; handle: ReadableFileHandle }> = [];

  for await (const [name, entry] of handle.entries()) {
    if (signal?.aborted) return { entries: [], chatIndex: createMessengerExportChatIndex() };
    if (entry.kind === 'file' && /\.json$/i.test(name)) {
      fileHandles.push({ name, handle: entry });
    }
  }

  const entries: ChatListEntry[] = [];
  const chatIndex = createMessengerExportChatIndex();
  onProgress?.(0, fileHandles.length);

  for (let i = 0; i < fileHandles.length; i++) {
    if (signal?.aborted) return { entries, chatIndex };
    const { name, handle: fileHandle } = fileHandles[i];

    try {
      const file = await fileHandle.getFile();
      const content = await file.text();
      if (signal?.aborted) return { entries, chatIndex };
      const classification = classifyMessengerExportJson(content);
      if (classification.kind === 'malformed-conversation') {
        markMessengerExportIndexIncomplete(chatIndex, {
          jsonFileName: name,
          reason: 'malformed-conversation',
        });
      } else if (classification.kind === 'conversation') {
        const thread = classification.thread;
        const { lastMessage, lastTimestamp } = describeLastMessage(thread);
        addConversationToChatIndex(chatIndex, name, file.size, thread);

        entries.push({
          folderName: jsonStem(name),
          title: thread.title || jsonStem(name),
          participants: (thread.participants || []).map(participant => participant.name).filter(Boolean),
          lastMessage,
          lastTimestamp,
          messageCount: thread.messages?.length || 0,
          folderSize: file.size,
          dirHandle: handle,
          jsonFileCount: 1,
          source: 'inbox',
          _messengerExport: true,
          _jsonFileName: name,
          _sizeIncludesMedia: false,
        });
      }
    } catch {
      markMessengerExportIndexIncomplete(chatIndex, { jsonFileName: name, reason: 'unreadable' });
      // One malformed conversation must not hide other chats in the export.
    }

    onProgress?.(i + 1, fileHandles.length);
    if (i % 10 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  entries.sort((a, b) => {
    if (a.lastTimestamp == null && b.lastTimestamp == null) return 0;
    if (a.lastTimestamp == null) return 1;
    if (b.lastTimestamp == null) return -1;
    return b.lastTimestamp - a.lastTimestamp;
  });

  return { entries, chatIndex };
}

export async function listMessengerExportChats(
  handle: ReadableDirectoryHandle,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<ChatListEntry[]> {
  return (await listMessengerExportChatsIndexed(handle, onProgress, signal)).entries;
}

export async function loadMessengerExportChat(
  handle: ReadableDirectoryHandle,
  jsonFileName: string,
  onProgress?: (progress: number, statusText: string) => void,
  signal?: AbortSignal
): Promise<MessengerThread> {
  await new Promise(resolve => setTimeout(resolve, 10));
  onProgress?.(0, 'Reading conversation...');

  const fileHandle = await handle.getFileHandle(jsonFileName);
  const file = await fileHandle.getFile();

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  onProgress?.(0.10, 'Processing data in background...');

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./messengerExportWorker.ts', import.meta.url), { type: 'module' });

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

    worker.onmessage = (event) => {
      if (signal) signal.removeEventListener('abort', abortHandler);
      if (event.data.type === 'success') {
        onProgress?.(0.90, 'Loading messages...');
        resolve(event.data.data);
      } else {
        reject(new Error(event.data.error || 'Worker parsing failed'));
      }
      worker.terminate();
    };

    worker.onerror = (event) => {
      if (signal) signal.removeEventListener('abort', abortHandler);
      reject(new Error(`Worker error: ${event.message}`));
      worker.terminate();
    };

    worker.postMessage({ file });
  });
}
