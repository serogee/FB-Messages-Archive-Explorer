import type { ReadableDirectoryHandle } from '../types/fileSystem';
import type { MetaAttachmentReferenceIndex } from './metaAttachmentAccumulator';
import { MetaAttachmentWorkerSession } from './metaAttachmentWorkerSession';
import { waitForAttachmentPreview } from './attachmentScanScheduling';
import { mapWithConcurrency } from './concurrency';
import type { CalculationProgress } from './calculationProgress';
import type { MetaArchivePlatform } from './metaAttachmentPaths';

export type { MetaAttachmentReferenceIndex } from './metaAttachmentAccumulator';

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

const SCAN_CONCURRENCY = 4;
const ATTACHMENT_DIRECTORIES = new Set(['photos', 'videos', 'audio', 'audio_files', 'gifs', 'files', 'media', 'stickers', 'stickers_used']);

/** Scan every conversation, including unreadable/unlisted chats and split files. */
export async function buildMetaAttachmentReferenceIndex(
  root: ReadableDirectoryHandle,
  signal?: AbortSignal,
  deletionSupported: MetaArchivePlatform | boolean = 'unknown',
  onProgress?: (progress: CalculationProgress) => void,
): Promise<MetaAttachmentReferenceIndex> {
  const session = new MetaAttachmentWorkerSession(deletionSupported, signal);
  const hostWarnings: Array<{ path: string; reason: string }> = [];
  let jsonFound = 0;
  let checkedFolders = 0;
  const reportDiscovery = (finished = false) => onProgress?.({
    stage: 'ownership', label: 'Scanning for shared attachments', done: checkedFolders,
    total: finished ? checkedFolders : undefined, unit: 'folders',
    jsonFound,
  });
  reportDiscovery();
  const incomplete = (path: string, reason: string) => {
    hostWarnings.push({ path, reason });
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
    await waitForAttachmentPreview(signal);
  };
  const directories: Array<{ handle: ReadableDirectoryHandle; path: string; attachments: boolean }> = [];
  const scan = async (directory: ReadableDirectoryHandle, directoryPath: string, attachments = false): Promise<void> => {
    throwIfAborted(signal);
    const childDirectories: Array<{ handle: ReadableDirectoryHandle; path: string; name: string }> = [];
    let isConversationDirectory = false;
    try {
      for await (const [name, handle] of directory.entries()) {
        throwIfAborted(signal);
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
        jsonFound++;
        reportDiscovery();
        try {
          const file = await handle.getFile();
          throwIfAborted(signal);
          if (await session.process(file, directoryPath, name, yieldIfNeeded)) isConversationDirectory = true;
        } catch (error) {
          throwIfAborted(signal);
          if (error instanceof DOMException && error.name === 'AbortError') throw error;
          incomplete(`${directoryPath}/${name}`, error instanceof Error ? error.message : 'Unreadable conversation');
        } finally {
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
  try {
    await scan(root, '');
    let nextDirectory = 0;
    while (nextDirectory < directories.length) {
      const batch = directories.slice(nextDirectory, nextDirectory + SCAN_CONCURRENCY);
      nextDirectory += batch.length;
      await mapWithConcurrency(batch, SCAN_CONCURRENCY, directory => scan(directory.handle, directory.path, directory.attachments), signal);
    }
    throwIfAborted(signal);
    reportDiscovery(true);
    await waitForAttachmentPreview(signal);
    const index = await session.finish();
    // The compact result is independent of the worker. Release its copy of
    // the index before the host verifies physical cross-folder files.
    session.dispose();
    for (const warning of hostWarnings) { index.complete = false; index.warnings.push(warning); }
    // Missing cross-folder files cannot be removed by deleting a folder. Keep
    // their usage counts, but exclude them from folder deletion dependencies.
    const crossFolderFiles = new Set([...index.folderReferences.values()].flatMap(identities => [...identities]));
    let verifiedFiles = 0;
    const reportVerification = () => onProgress?.({ stage: 'verification', label: 'Scanning for shared attachments', done: verifiedFiles, total: crossFolderFiles.size, unit: 'files', foldersChecked: checkedFolders, jsonFound });
    if (crossFolderFiles.size > 0) reportVerification();
    const missing = await mapWithConcurrency([...crossFolderFiles], 4, async identity => {
      await waitForAttachmentPreview(signal);
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
        index.complete = false;
        index.warnings.push({ path: identity, reason: error instanceof Error ? error.message : 'Cross-folder file could not be verified' });
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
  } finally { session.dispose(); }
}
