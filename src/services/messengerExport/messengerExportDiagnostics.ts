import type { MediaState, MessengerThread } from '../../types/messenger';
import type { ReadableDirectoryHandle } from '../../types/fileSystem';
import { normalizeAttachmentPath } from '../attachmentIdentity';
import { findMediaFile, getMessageAttachmentReferences } from '../media';
import { VirtualDirectoryHandle } from '../polyfill';

function errorName(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : 'unknown';
}

export async function checkMessengerAttachmentFiles(
  root: ReadableDirectoryHandle,
  thread: MessengerThread,
  state: MediaState,
  signal?: AbortSignal,
): Promise<string> {
  const checkAbort = () => { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); };
  checkAbort();
  const paths = new Map<string, string>();
  let lastYield = performance.now();
  for (const message of thread.messages) {
    checkAbort();
    for (const { path, shared } of getMessageAttachmentReferences(message, state)) {
      if (!shared) paths.set(normalizeAttachmentPath(path), path);
    }
    if (performance.now() - lastYield > 12) {
      await new Promise(resolve => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  }
  let matched = 0;
  let decodedMatches = 0;
  for (const path of paths.values()) {
    if (findMediaFile(state, path)) matched++;
    else {
      try { if (findMediaFile(state, decodeURIComponent(path))) decodedMatches++; }
      catch { /* A literal percent sign can be a valid filename. */ }
    }
  }

  let rootFiles = 0, rootFolders = 0;
  let mediaCaseVariant = false;
  let rootListing = 'OK';
  try {
    for await (const [name, entry] of root.entries()) {
      checkAbort();
      if (entry.kind === 'file') rootFiles++;
      else {
        rootFolders++;
        if (name.toLowerCase() === 'media' && name !== 'media') mediaCaseVariant = true;
      }
    }
  } catch (error) { checkAbort(); rootListing = errorName(error); }

  let mediaFolder = 'OK', mediaListing = 'OK', listedFiles = 0;
  const countFiles = async (directory: ReadableDirectoryHandle) => {
    for await (const [, entry] of directory.entries()) {
      checkAbort();
      if (entry.kind === 'file') listedFiles++;
      else await countFiles(entry);
      if (listedFiles > 0 && listedFiles % 256 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
  };
  try {
    const directory = await root.getDirectoryHandle('media');
    checkAbort();
    try { await countFiles(directory); }
    catch (error) { checkAbort(); mediaListing = errorName(error); }
  } catch (error) { checkAbort(); mediaFolder = errorName(error); mediaListing = 'not checked'; }

  const sample = [...paths.values()].map(path => findMediaFile(state, path)).find(entry => entry?.handle);
  let fileHandle = 'not checked (no matched file)';
  let fileBytes = 'not checked';
  if (sample?.handle) {
    try {
      const file = await sample.handle.getFile();
      checkAbort();
      fileHandle = 'OK';
      try {
        await file.slice(0, 1).arrayBuffer();
        checkAbort();
        fileBytes = file.size > 0 ? 'OK' : 'empty file';
      } catch (error) { checkAbort(); fileBytes = errorName(error); }
    } catch (error) { checkAbort(); fileHandle = errorName(error); }
  }
  checkAbort();
  return [
    `Attachment references: ${paths.size}`,
    `Indexed files: ${state.mediaFileCount}`,
    `Matched references: ${matched}`,
    `Additional matches after URL decoding: ${decodedMatches}`,
    `Attachment lookup: ${mediaFolder === 'OK' ? 'media folder' : root instanceof VirtualDirectoryHandle && rootFolders === 0 && state.mediaFileCount > 0 ? 'uploaded root files' : 'unavailable'}`,
    `Root listing: ${rootListing} (${rootFiles} files, ${rootFolders} folders)`,
    `Different capitalization of media folder: ${mediaCaseVariant ? 'yes' : 'no'}`,
    `Media folder lookup: ${mediaFolder}`,
    `Media listing: ${mediaListing} (${listedFiles} files)`,
    `Sample getFile(): ${fileHandle}`,
    `Sample file bytes: ${fileBytes}`,
  ].join('\n');
}
