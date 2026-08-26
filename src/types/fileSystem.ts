export interface ReadableFileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
}

export type ReadableEntryHandle = ReadableDirectoryHandle | ReadableFileHandle;

export interface ReadableDirectoryHandle {
  readonly kind: 'directory';
  readonly name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<ReadableDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<ReadableFileHandle>;
  entries(): AsyncIterableIterator<[string, ReadableEntryHandle]>;
}

export interface WritableDirectoryHandle extends ReadableDirectoryHandle {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<WritableDirectoryHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

export function isWritableDirectoryHandle(
  handle: ReadableDirectoryHandle
): handle is WritableDirectoryHandle {
  return 'removeEntry' in handle && typeof handle.removeEntry === 'function';
}
