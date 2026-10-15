import type { ReadableDirectoryHandle, ReadableEntryHandle } from '../types/fileSystem';

interface FolderOperationFailure {
  stage: string;
  operation: string;
  folderDepth?: number;
  entriesRead?: number;
  reopenOperation?: string;
  reopenError?: string;
}

export class FolderOpenDiagnostics {
  stage = 'folder picker';
  pickerReturned = false;
  private readonly failures = new Map<unknown, FolderOperationFailure>();
  readonly permission: 'read' | 'readwrite';

  constructor(permission: 'read' | 'readwrite') {
    this.permission = permission;
  }

  async run<T>(operation: string, task: () => T | Promise<T>, folderDepth?: number): Promise<T> {
    const stage = this.stage;
    try {
      return await task();
    } catch (error) {
      // Keep the original exception: callers still need its type and identity
      // when ignoring missing layout markers or retrying another JSON file.
      if (!this.failures.has(error)) this.failures.set(error, { stage, operation, folderDepth });
      throw error;
    }
  }

  async *entries(handle: ReadableDirectoryHandle, folderDepth?: number): AsyncIterableIterator<[string, ReadableEntryHandle]> {
    const stage = this.stage;
    let entriesRead = 0;
    try {
      for await (const entry of handle.entries()) {
        entriesRead++;
        yield entry;
      }
    } catch (error) {
      if (!this.failures.has(error)) this.failures.set(error, { stage, operation: 'entries()', folderDepth, entriesRead });
      throw error;
    }
  }

  recordReopenFailure(original: unknown, reopenError: unknown): void {
    const failure = this.failures.get(original);
    if (!failure) return;
    failure.reopenOperation = this.failures.get(reopenError)?.operation;
    const name = (reopenError as { name?: unknown } | null)?.name;
    failure.reopenError = typeof name === 'string' ? name : 'unknown';
  }

  describe(error: unknown): string {
    const failure = this.failures.get(error);
    const errorName = (error as { name?: unknown } | null)?.name;
    return `Native folder details: stage=${failure?.stage ?? this.stage}; operation=${failure?.operation ?? 'archive validation'}; `
      + (failure?.folderDepth === undefined ? '' : `folder depth=${failure.folderDepth}; `)
      + (failure?.entriesRead === undefined ? '' : `entries read=${failure.entriesRead}; `)
      + (failure?.reopenError === undefined ? '' : `reopen operation=${failure.reopenOperation ?? 'unknown'}; reopen error=${failure.reopenError}; `)
      + `picker returned=${this.pickerReturned ? 'yes' : 'no'}; requested permission=${this.permission}; error=${typeof errorName === 'string' ? errorName : 'unknown'}.`;
  }
}

export async function runFolderOperation<T>(
  diagnostics: FolderOpenDiagnostics | undefined,
  operation: string,
  task: () => T | Promise<T>,
  folderDepth?: number,
): Promise<T> {
  return diagnostics ? diagnostics.run(operation, task, folderDepth) : task();
}
