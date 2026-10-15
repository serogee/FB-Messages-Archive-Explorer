import type { ChatListEntry, MessengerThread } from '../../types/messenger';
import type { ReadableDirectoryHandle, ReadableFileHandle } from '../../types/fileSystem';
import { runFolderOperation, type FolderOpenDiagnostics } from '../folderOpenDiagnostics';
import { readListedFile } from '../listedFileAccess';
import { mapWithConcurrency } from '../concurrency';
import { performanceLimit } from '../performanceSettings';
import { getMessageTimestamp } from '../parser';
import { getMessageBump } from '../messageBump';
import {
  classifyMessengerExportJson,
  getMessengerExportLastMessage,
} from './messengerExportParser';
import {
  addConversationToChatIndex,
  addConversationToSizeMetadata,
  createMessengerExportChatIndex,
  createMessengerExportSizeMetadata,
  markMessengerExportIndexIncomplete,
  mergeMessengerExportChatIndex,
  type MessengerExportChatIndex,
  type MessengerExportSizeMetadata,
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
  const bump = getMessageBump(lastMsg);
  if (bump) {
    lastMessage = bump.label;
    if (isGroup) lastMessage = bump.text ? `${firstName} bumped a message` : `${firstName}: ${bump.label}`;
  } else if (text) {
    lastMessage = isGroup ? `${firstName}: ${text.slice(0, 100)}` : text.slice(0, 100);
  } else {
    const attachType =
      lastMsg.photos?.length ? 'an image' :
      lastMsg.videos?.length ? 'a video' :
      (lastMsg.audio?.length || lastMsg.audio_files?.length) ? 'an audio message' :
      lastMsg.gifs?.length ? 'a GIF' :
      lastMsg.files?.length ? 'a file' :
      (lastMsg.media?.length || lastMsg.failedMediaCount) ? 'an attachment' : null;
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
  sizeMetadata: MessengerExportSizeMetadata;
  chatIndex?: MessengerExportChatIndex;
}

export interface MessengerExportListingOptions {
  diagnostics?: FolderOpenDiagnostics;
  collectOwnership?: boolean;
  ownershipSignal?: AbortSignal;
}

export function listMessengerExportChatsIndexed(handle: ReadableDirectoryHandle,
  onProgress?: (done: number, total: number) => void, signal?: AbortSignal,
): Promise<MessengerExportListingResult & { chatIndex: MessengerExportChatIndex }>;
export function listMessengerExportChatsIndexed(handle: ReadableDirectoryHandle,
  onProgress: ((done: number, total: number) => void) | undefined, signal: AbortSignal | undefined,
  options: MessengerExportListingOptions,
): Promise<MessengerExportListingResult>;
export async function listMessengerExportChatsIndexed(
  handle: ReadableDirectoryHandle,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
  options: MessengerExportListingOptions = {},
): Promise<MessengerExportListingResult> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const diagnostics = options.diagnostics;
  const sizeMetadata = createMessengerExportSizeMetadata();
  let chatIndex = options.collectOwnership !== false && !options.ownershipSignal?.aborted
    ? createMessengerExportChatIndex(sizeMetadata) : undefined;
  const cancelOwnership = () => { chatIndex = undefined; };
  options.ownershipSignal?.addEventListener('abort', cancelOwnership, { once: true });
  try {
    const fileHandles: Array<{ name: string; handle: ReadableFileHandle }> = [];

    for await (const [name, entry] of diagnostics ? diagnostics.entries(handle) : handle.entries()) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (entry.kind === 'file' && /\.json$/i.test(name)) {
        fileHandles.push({ name, handle: entry });
      }
    }

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const entries: ChatListEntry[] = [];
    onProgress?.(0, fileHandles.length);

    let done = 0;
    const results = await mapWithConcurrency(fileHandles, performanceLimit('archiveReads'), async ({ name, handle: fileHandle }, i) => {
      try {
        const file = await readListedFile(handle, name, fileHandle, signal, diagnostics);
        const content = await runFolderOperation(diagnostics, 'File.text()', () => file.text());
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const classification = await runFolderOperation(diagnostics, 'JSON.parse()', () => classifyMessengerExportJson(content));
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (classification.kind === 'malformed-conversation') {
          return { kind: 'warning', reason: 'malformed-conversation' } as const;
        } else if (classification.kind === 'conversation') {
          const thread = classification.thread;
          const { lastMessage, lastTimestamp } = describeLastMessage(thread);
          const metadata = createMessengerExportSizeMetadata();
          const index = chatIndex ? createMessengerExportChatIndex(metadata) : undefined;
          if (index) addConversationToChatIndex(index, name, file.size, thread);
          else addConversationToSizeMetadata(metadata, name, file.size, thread);

          const entry: ChatListEntry = {
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
          };
          // Retain only metadata and reference summaries, never the full thread.
          return { kind: 'conversation', entry, metadata, index } as const;
        }
        return null;
      } catch {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        // One malformed conversation must not hide other chats in the export.
        return { kind: 'warning', reason: 'unreadable' } as const;
      } finally {
        if (!signal?.aborted) onProgress?.(++done, fileHandles.length);
        if (i % 10 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
    }, signal);
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (!result) continue;
      const name = fileHandles[i].name;
      if (result.kind === 'warning') {
        if (chatIndex) markMessengerExportIndexIncomplete(chatIndex, { jsonFileName: name, reason: result.reason });
      } else {
        entries.push(result.entry);
        for (const [fileName, size] of result.metadata.jsonSizes) sizeMetadata.jsonSizes.set(fileName, size);
        for (const [fileName, paths] of result.metadata.chatMediaPaths) sizeMetadata.chatMediaPaths.set(fileName, paths);
        if (chatIndex && result.index) mergeMessengerExportChatIndex(chatIndex, result.index);
      }
    }

    entries.sort((a, b) => {
      if (a.lastTimestamp == null && b.lastTimestamp == null) return 0;
      if (a.lastTimestamp == null) return 1;
      if (b.lastTimestamp == null) return -1;
      return b.lastTimestamp - a.lastTimestamp;
    });

    return { entries, sizeMetadata, chatIndex };
  } finally { options.ownershipSignal?.removeEventListener('abort', cancelOwnership); }
}

export async function listMessengerExportChats(
  handle: ReadableDirectoryHandle,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<ChatListEntry[]> {
  return (await listMessengerExportChatsIndexed(handle, onProgress, signal, { collectOwnership: false })).entries;
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
