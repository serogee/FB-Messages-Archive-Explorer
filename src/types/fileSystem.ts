export interface ReadableFileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
}

export interface WritableFileHandle extends ReadableFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>;
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
  getFileHandle(name: string, options?: { create?: boolean }): Promise<WritableFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

export function isWritableDirectoryHandle(
  handle: ReadableDirectoryHandle
): handle is WritableDirectoryHandle {
  return 'removeEntry' in handle && typeof handle.removeEntry === 'function';
}

interface PermissionCapableDirectoryHandle extends ReadableDirectoryHandle {
  queryPermission(options?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(options?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

export async function requestDirectoryWritePermission(
  handle: ReadableDirectoryHandle
): Promise<boolean> {
  const permissionHandle = handle as Partial<PermissionCapableDirectoryHandle>;
  if (!permissionHandle.queryPermission || !permissionHandle.requestPermission) return false;
  if (await permissionHandle.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
  return await permissionHandle.requestPermission({ mode: 'readwrite' }) === 'granted';
}
