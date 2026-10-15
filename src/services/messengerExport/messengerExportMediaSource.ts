import type { ReadableDirectoryHandle } from '../../types/fileSystem';
import { VirtualDirectoryHandle } from '../polyfill';

export async function getMessengerExportMediaSource(root: ReadableDirectoryHandle, signal?: AbortSignal) {
  const checkAbort = () => { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); };
  checkAbort();
  try {
    const directory = await root.getDirectoryHandle('media');
    checkAbort();
    return { directory, prefix: 'media', flatUpload: false, ambiguousNames: new Set<string>() };
  } catch (error) {
    checkAbort();
    if (!(root instanceof VirtualDirectoryHandle) || (error as { name?: string })?.name !== 'NotFoundError') throw error;
  }

  // Some Android uploads expose every file beside the conversation JSON.
  // Use their filenames only when the uploaded directory has no subfolders.
  const names = new Set<string>();
  const ambiguousNames = new Set<string>();
  let checked = 0;
  for await (const [name, entry] of root.entries()) {
    checkAbort();
    if (entry.kind !== 'file') return null;
    if (/\.json$/i.test(name)) continue;
    const normalized = name.toLowerCase();
    if (names.has(normalized)) ambiguousNames.add(normalized);
    names.add(normalized);
    if (++checked % 256 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  checkAbort();
  return { directory: root, prefix: '', flatUpload: true, ambiguousNames };
}
