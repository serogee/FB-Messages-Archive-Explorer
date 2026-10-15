import { getMessageAttachmentReferences } from '../media';
import { parseMessengerExportJson } from './messengerExportParser';
import type { ReadableDirectoryHandle, ReadableFileHandle } from '../../types/fileSystem';
import { mapWithConcurrency } from '../concurrency';
import { performanceLimit } from '../performanceSettings';
import type { CalculationProgress } from '../calculationProgress';
import { readListedFile } from '../listedFileAccess';
import { getMessengerExportMediaSource } from './messengerExportMediaSource';
import {
  getMessengerMediaBasename,
  getMessengerMediaIdentity,
  type MessengerExportSizeMetadata,
} from './messengerExportIndex';

export type MediaSizeIndex = Map<string, number>;

function normalizeMediaPath(path: string): string {
  return String(path || '')
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .toLowerCase();
}

function getBasename(path: string): string {
  return getMessengerMediaBasename(path);
}

function isMessengerMediaRef(path: string): boolean {
  const normalized = normalizeMediaPath(path);
  return normalized.startsWith('media/') || /^[^/]+\.[a-z0-9]{2,5}$/i.test(normalized);
}

async function collectMediaSizes(
  dirHandle: ReadableDirectoryHandle,
  prefix: string,
  index: MediaSizeIndex,
  basenamePaths: Map<string, string>,
  ambiguousBasenames: Set<string>,
  signal?: AbortSignal,
  onFileChecked?: () => void,
  flatUpload = false,
  ambiguousNames: ReadonlySet<string> = new Set(),
): Promise<void> {
  let lastYield = performance.now();

  const files: Array<{ parent: ReadableDirectoryHandle; name: string; entry: ReadableFileHandle; path: string }> = [];
  const collect = async (parent: ReadableDirectoryHandle, directoryPath: string, flat: boolean) => {
    for await (const [name, entry] of parent.entries()) {
      throwIfAborted(signal);
      if (flat && (/\.json$/i.test(name) || ambiguousNames.has(name.toLowerCase()))) continue;
      const path = directoryPath ? `${directoryPath}/${name}` : name;
      if (entry.kind === 'file') files.push({ parent, name, entry, path });
      else await collect(entry, path, false);
      if (performance.now() - lastYield > 16) {
        await new Promise(resolve => setTimeout(resolve, 0));
        throwIfAborted(signal);
        lastYield = performance.now();
      }
    }
  };
  await collect(dirHandle, prefix, flatUpload);
  const sizes = await mapWithConcurrency(files, performanceLimit('sizes'), async ({ parent, name, entry }) => {
    throwIfAborted(signal);
    try {
      const file = await readListedFile(parent, name, entry, signal);
      throwIfAborted(signal);
      return file.size;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      return null;
    } finally {
      onFileChecked?.();
      if (performance.now() - lastYield > 16) {
        await new Promise(resolve => setTimeout(resolve, 0));
        throwIfAborted(signal);
        lastYield = performance.now();
      }
    }
  }, signal);
  for (let i = 0; i < files.length; i++) {
    const size = sizes[i];
    if (size === null) continue;
    const path = files[i].path;
    const normalizedPath = normalizeMediaPath(path);
    const sourcePath = path.replace(/\\/g, '/').replace(/^\.?\//, '');
    const basename = getBasename(path);
    index.set(normalizedPath, size);
    if (basename && !ambiguousBasenames.has(basename)) {
      const existingPath = basenamePaths.get(basename);
      if (existingPath && existingPath !== sourcePath) {
        basenamePaths.delete(basename);
        ambiguousBasenames.add(basename);
        index.delete(basename);
      } else if (!existingPath) {
        basenamePaths.set(basename, sourcePath);
        index.set(basename, size);
      }
    }
  }
}

export async function buildMessengerExportMediaSizeIndex(
  rootHandle: ReadableDirectoryHandle,
  signal?: AbortSignal,
  onProgress?: (progress: CalculationProgress) => void
): Promise<MediaSizeIndex> {
  const index: MediaSizeIndex = new Map();
  const basenamePaths = new Map<string, string>();
  const ambiguousBasenames = new Set<string>();
  let done = 0;
  const report = (finished = false) => onProgress?.({ stage: 'media-sizes', label: 'Calculating chat sizes', done, total: finished ? done : undefined, unit: 'files' });
  report();

  try {
    throwIfAborted(signal);
    const source = await getMessengerExportMediaSource(rootHandle, signal);
    throwIfAborted(signal);
    if (source) await collectMediaSizes(source.directory, source.prefix, index, basenamePaths, ambiguousBasenames, signal,
      () => { done++; report(); }, source.flatUpload, source.ambiguousNames);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
    // A Messenger export may validly omit media when it contains only JSON.
  }

  report(true);
  return index;
}

export async function computeMessengerExportChatSize(
  rootHandle: ReadableDirectoryHandle,
  jsonFileName: string,
  mediaSizeIndex?: MediaSizeIndex,
  signal?: AbortSignal
): Promise<number> {
  throwIfAborted(signal);
  const fileHandle = await rootHandle.getFileHandle(jsonFileName);
  const file = await fileHandle.getFile();
  throwIfAborted(signal);

  const index = mediaSizeIndex || await buildMessengerExportMediaSizeIndex(rootHandle, signal);
  const content = await file.text();
  throwIfAborted(signal);

  const thread = parseMessengerExportJson(content);
  const referencedMedia = new Set<string>();

  for (const msg of thread.messages || []) {
    for (const { path, shared } of getMessageAttachmentReferences(msg)) {
      if (shared) continue;
      if (!isMessengerMediaRef(path)) continue;
      const normalized = normalizeMediaPath(path);
      referencedMedia.add(normalized);
    }
  }

  let mediaSize = 0;
  for (const path of referencedMedia) {
    mediaSize += index.get(path) || index.get(getBasename(path)) || 0;
  }

  return file.size + mediaSize;
}

export function computeMessengerExportChatSizeFromIndex(
  jsonFileName: string,
  chatIndex: MessengerExportSizeMetadata,
  mediaSizeIndex: MediaSizeIndex
): number {
  const jsonSize = chatIndex.jsonSizes.get(jsonFileName);
  if (jsonSize == null) {
    throw new Error(`Missing indexed JSON size for ${jsonFileName}`);
  }

  let mediaSize = 0;
  for (const path of chatIndex.chatMediaPaths.get(jsonFileName) || []) {
    const identity = getMessengerMediaIdentity(path) || normalizeMediaPath(path);
    mediaSize += mediaSizeIndex.get(identity) || mediaSizeIndex.get(getBasename(path)) || 0;
  }
  return jsonSize + mediaSize;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}
