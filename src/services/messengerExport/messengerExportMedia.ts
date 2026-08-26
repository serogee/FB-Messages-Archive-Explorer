import type { MediaEntry, MediaState } from '../../types/messenger';
import type { ReadableDirectoryHandle, ReadableFileHandle } from '../../types/fileSystem';
import { addMediaToIndex, getMediaType } from '../media';

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.?\//, '');
}

async function collectMediaFiles(
  dirHandle: ReadableDirectoryHandle,
  prefix: string,
  files: Array<{ handle: ReadableFileHandle; path: string }>,
  signal?: AbortSignal
): Promise<void> {
  let lastYield = performance.now();

  for await (const [name, entry] of dirHandle.entries()) {
    if (signal?.aborted) return;

    const path = prefix ? `${prefix}/${name}` : name;
    if (entry.kind === 'file') {
      files.push({ handle: entry, path });
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
  let mediaHandle: ReadableDirectoryHandle;
  try {
    mediaHandle = await rootHandle.getDirectoryHandle('media');
  } catch {
    onProgress?.(0, 0);
    return;
  }

  const files: Array<{ handle: ReadableFileHandle; path: string }> = [];
  await collectMediaFiles(mediaHandle, 'media', files, signal);
  if (signal?.aborted) return;

  const total = files.length;
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
        const type = getMediaType(handle.name);
        const entry: MediaEntry = { handle, type };

        state.types[normalizedPath] = type;
        addMediaToIndex(state, normalizedPath, entry);
        addMediaToIndex(state, `./${normalizedPath}`, entry);
        addMediaToIndex(state, handle.name, entry);
      } catch { /* ignore individual media failures */ }

      done++;
      onProgress?.(done, total);
    }));

    if (performance.now() - lastYield > 16) {
      await new Promise(resolve => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  }
}
