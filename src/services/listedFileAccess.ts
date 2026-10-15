import type { ReadableDirectoryHandle, ReadableFileHandle } from '../types/fileSystem';
import { runFolderOperation, type FolderOpenDiagnostics } from './folderOpenDiagnostics';

const namedLookupDirectories = new WeakSet<ReadableDirectoryHandle>();

export function needsNamedFileLookup(directory: ReadableDirectoryHandle): boolean {
  return namedLookupDirectories.has(directory);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

export async function readListedFile(
  directory: ReadableDirectoryHandle,
  name: string,
  listedHandle: ReadableFileHandle,
  signal?: AbortSignal,
  diagnostics?: FolderOpenDiagnostics,
  depth?: number,
): Promise<File> {
  throwIfAborted(signal);
  const readByName = async () => {
    const handle = await runFolderOperation(diagnostics, 'getFileHandle()', () => directory.getFileHandle(name, { create: false }), depth);
    throwIfAborted(signal);
    const file = await runFolderOperation(diagnostics, 'getFile()', () => handle.getFile(), depth);
    throwIfAborted(signal);
    return file;
  };
  if (needsNamedFileLookup(directory)) return readByName();

  try {
    const file = await runFolderOperation(diagnostics, 'getFile()', () => listedHandle.getFile(), depth);
    throwIfAborted(signal);
    return file;
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name !== 'NotFoundError') throw error;
    throwIfAborted(signal);
    // Android's directory iterator and filename lookup can produce different
    // document handles. Reopen once, without creating or modifying anything.
    try {
      const file = await readByName();
      namedLookupDirectories.add(directory);
      return file;
    } catch (reopenError) {
      if ((reopenError as { name?: unknown } | null)?.name === 'AbortError') throw reopenError;
      diagnostics?.recordReopenFailure(error, reopenError);
      throw error;
    }
  }
}
