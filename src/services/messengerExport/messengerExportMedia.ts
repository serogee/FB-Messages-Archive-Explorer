import type { MediaEntry, MediaState } from '../../types/messenger';
import type { ReadableDirectoryHandle, ReadableFileHandle } from '../../types/fileSystem';
import { addMediaToIndex, getMediaType } from '../media';
import { readListedFile } from '../listedFileAccess';
import { getMessengerExportMediaSource } from './messengerExportMediaSource';

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.?\//, '');
}

async function collectMediaFiles(
  dirHandle: ReadableDirectoryHandle,
  prefix: string,
  files: Array<{ handle: ReadableFileHandle; path: string }>,
  signal?: AbortSignal,
  flatUpload = false,
): Promise<void> {
  let lastYield = performance.now();

  for await (const [name, entry] of dirHandle.entries()) {
    if (signal?.aborted) return;
    // Root JSON files describe conversations, rather than uploaded media.
    if (flatUpload && /\.json$/i.test(name)) continue;

    const path = prefix ? `${prefix}/${name}` : name;
    if (entry.kind === 'file') {
      // Android filename lookups can be slow. Index listed handles now and
      // recover inaccessible handles only when an attachment is actually read.
      let snapshot: Promise<File> | undefined;
      const handle: ReadableFileHandle = {
        kind: 'file', name,
        getFile: () => {
          // Dimensions, previews, and downloads share this chat's snapshot.
          snapshot ??= readListedFile(dirHandle, name, entry).catch(error => {
            snapshot = undefined;
            throw error;
          });
          return snapshot;
        },
      };
      files.push({ handle, path });
    } else if (entry.kind === 'directory') {
      await collectMediaFiles(entry, path, files, signal);
    }

    if (performance.now() - lastYield > 16) {
      await new Promise(resolve => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  }
}

export async function processMessengerExportMedia(
  rootHandle: ReadableDirectoryHandle,
  state: MediaState,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<void> {
  let source: Awaited<ReturnType<typeof getMessengerExportMediaSource>>;
  try {
    source = await getMessengerExportMediaSource(rootHandle, signal);
  } catch {
    onProgress?.(0, 0);
    return;
  }
  if (!source) {
    onProgress?.(0, 0);
    return;
  }

  const files: Array<{ handle: ReadableFileHandle; path: string }> = [];
  await collectMediaFiles(source.directory, source.prefix, files, signal, source.flatUpload);
  if (signal?.aborted) return;

  const total = files.length;
  state.mediaFileCount = total;
  const BATCH_SIZE = 30;
  let done = 0;
  let lastYield = performance.now();
  onProgress?.(0, total);

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    if (signal?.aborted) return;
    const batch = files.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async ({ handle, path }) => {
      try {
        const normalizedPath = normalizeRelativePath(path);
        if (source.ambiguousNames.has(normalizedPath.toLowerCase())) {
          state.ambiguousBasenames.add(normalizedPath.toLowerCase());
          return;
        }
        const type = getMediaType(handle.name);
        const entry: MediaEntry = { handle, type };

        state.types[normalizedPath] = type;
        addMediaToIndex(state, normalizedPath, entry);
      } catch { /* ignore individual media failures */ }

    }));

    done += batch.length;
    onProgress?.(done, total);

    if (performance.now() - lastYield > 16) {
      await new Promise(resolve => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  }
}
