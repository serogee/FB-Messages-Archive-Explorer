import type { ReadableDirectoryHandle } from '../../types/fileSystem';
import { runFolderOperation, type FolderOpenDiagnostics } from '../folderOpenDiagnostics';
import { readListedFile } from '../listedFileAccess';

function classifyConversationJson(content: string): 'conversation' | 'other' | 'invalid' {
  try {
    const data = JSON.parse(content);
    return (
      data &&
      typeof data === 'object' &&
      typeof data.threadName === 'string' &&
      Array.isArray(data.participants) &&
      data.participants.some((participant: unknown) => typeof participant === 'string') &&
      Array.isArray(data.messages)
    ) ? 'conversation' : 'other';
  } catch (error) {
    if (error instanceof SyntaxError) return 'invalid';
    throw error;
  }
}

export function isConversationJsonContent(content: string): boolean {
  return classifyConversationJson(content) === 'conversation';
}

export interface MessengerExportDetectionInfo {
  files: number;
  directories: number;
  jsonFiles: number;
  invalidJsonFiles: number;
  otherJsonFiles: number;
  emptyJsonFiles: number;
}

export async function isMessengerExport(handle: ReadableDirectoryHandle, info?: MessengerExportDetectionInfo, diagnostics?: FolderOpenDiagnostics, depth = 0, signal?: AbortSignal): Promise<boolean> {
  try {
    await runFolderOperation(diagnostics, 'getDirectoryHandle()', () => handle.getDirectoryHandle('inbox'), depth);
    return false;
  } catch { /* Continue checking the remaining Facebook root markers. */ }

  try {
    await runFolderOperation(diagnostics, 'getDirectoryHandle()', () => handle.getDirectoryHandle('archived_threads'), depth);
    return false;
  } catch { /* No Facebook root markers found; inspect standalone Messenger JSON. */ }

  let firstReadError: { error: unknown } | undefined;
  for await (const [name, entry] of diagnostics ? diagnostics.entries(handle, depth) : handle.entries()) {
    if (entry.kind !== 'file') {
      if (info) info.directories++;
      continue;
    }
    if (info) info.files++;
    if (!/\.json$/i.test(name)) continue;
    if (info) info.jsonFiles++;

    try {
      const file = await readListedFile(handle, name, entry, signal, diagnostics, depth);
      const content = await runFolderOperation(diagnostics, 'File.text()', () => file.text(), depth);
      if (info && !content.length) info.emptyJsonFiles++;
      const kind = await runFolderOperation(diagnostics, 'JSON.parse()', () => classifyConversationJson(content), depth);
      if (kind === 'conversation') return true;
      if (info) {
        if (kind === 'invalid') info.invalidJsonFiles++;
        else info.otherJsonFiles++;
      }
    } catch (error) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      firstReadError ??= { error };
      continue;
    }
  }

  if (firstReadError) throw firstReadError.error;
  return false;
}

export async function resolveMessengerExportRoot(
  handle: ReadableDirectoryHandle,
  info?: MessengerExportDetectionInfo,
  signal?: AbortSignal,
  diagnostics?: FolderOpenDiagnostics,
): Promise<ReadableDirectoryHandle | null> {
  let current = handle;
  const visited = new Set<ReadableDirectoryHandle>();

  // Android folder paths can retain extra parent directories. Follow only
  // unambiguous wrappers so conversations and their media keep the same root.
  for (let depth = 0; depth < 32 && !visited.has(current); depth++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    visited.add(current);
    const recognized = await isMessengerExport(current, depth === 0 ? info : undefined, diagnostics, depth, signal);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (recognized) return current;

    let child: ReadableDirectoryHandle | undefined;
    for await (const [, entry] of diagnostics ? diagnostics.entries(current, depth) : current.entries()) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (entry.kind !== 'directory' || child) return null;
      child = entry;
    }
    if (!child) return null;
    current = child;
  }
  return null;
}
