import type { ReadableDirectoryHandle, ReadableEntryHandle, ReadableFileHandle } from '../types/fileSystem';

interface FolderUploadInfo {
  files: number;
  jsonFileNames: number;
  jsonPaths: number;
  rootJsonFiles: number;
  missingRelativePaths: number;
}

const folderUploads = new WeakMap<ReadableDirectoryHandle, FolderUploadInfo>();

export function getFolderUploadInfo(handle: ReadableDirectoryHandle): Readonly<FolderUploadInfo> | undefined {
  return folderUploads.get(handle);
}

function createUploadRoot(): VirtualDirectoryHandle {
  const root = new VirtualDirectoryHandle('root');
  folderUploads.set(root, { files: 0, jsonFileNames: 0, jsonPaths: 0, rootJsonFiles: 0, missingRelativePaths: 0 });
  return root;
}

export class VirtualFileHandle implements ReadableFileHandle {
  kind = 'file' as const;
  name: string;
  private file: File;

  constructor(name: string, file: File) {
    this.name = name;
    this.file = file;
  }

  async getFile(): Promise<File> {
    return this.file;
  }
}

export class VirtualDirectoryHandle implements ReadableDirectoryHandle {
  kind = 'directory' as const;
  name: string;
  private children: Map<string, VirtualFileHandle | VirtualDirectoryHandle> = new Map();

  constructor(name: string) {
    this.name = name;
  }

  async getDirectoryHandle(name: string, _options?: { create?: boolean }): Promise<VirtualDirectoryHandle> {
    const child = this.children.get(name);
    if (!child) {
      if (_options?.create) {
        const newDir = new VirtualDirectoryHandle(name);
        this.children.set(name, newDir);
        return newDir;
      }
      throw new DOMException(`Directory not found: ${name}`, 'NotFoundError');
    }
    if (child.kind !== 'directory') {
      throw new DOMException(`${name} is a file, not a directory`, 'TypeMismatchError');
    }
    return child;
  }

  async getFileHandle(name: string, _options?: { create?: boolean }): Promise<VirtualFileHandle> {
    const child = this.children.get(name);
    if (!child) {
      throw new DOMException(`File not found: ${name}`, 'NotFoundError');
    }
    if (child.kind !== 'file') {
      throw new DOMException(`${name} is a directory, not a file`, 'TypeMismatchError');
    }
    return child;
  }

  async *entries(): AsyncIterableIterator<[string, ReadableEntryHandle]> {
    for (const [name, handle] of this.children.entries()) {
      yield [name, handle];
    }
  }

  addChild(name: string, handle: VirtualFileHandle | VirtualDirectoryHandle) {
    if (!name || name === '.' || name === '..' || this.children.has(name)) {
      throw new Error(`Path collision or invalid path segment: ${name || '(empty)'}`);
    }
    this.children.set(name, handle);
  }
}

function getUploadedPathParts(file: File, relativePath: string): string[] {
  const androidPath = /^(?:content:\/\/[^/]+\/)?tree\/([^/]*%3[aA][^/]*)\/document\/([^/]+)$/.exec(relativePath);
  let parts: string[];
  if (androidPath) {
    // Some Android providers return document URIs instead of relative paths.
    // Decode the IDs once, then retain only descendants of the selected tree.
    let tree: string, document: string;
    try {
      tree = decodeURIComponent(androidPath[1]);
      document = decodeURIComponent(androidPath[2]);
    } catch {
      throw new Error(`Invalid uploaded file path: ${relativePath}`);
    }
    if (!tree.includes(':') || !document.startsWith(`${tree}/`)) {
      throw new Error(`Invalid uploaded file path: ${relativePath}`);
    }
    parts = document.slice(tree.length + 1).split('/');
    if (parts[parts.length - 1] !== file.name) {
      throw new Error(`Invalid uploaded file path: ${relativePath}`);
    }
  } else {
    parts = (relativePath || file.name).split('/');
  }
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid uploaded file path: ${relativePath || file.name}`);
  }
  // Ordinary folder uploads include the selected directory name.
  if (!androidPath && relativePath && parts.length > 1) parts.shift();
  return parts;
}

function addUploadedFile(root: VirtualDirectoryHandle, file: File): void {
  const relativePath = file.webkitRelativePath;
  const parts = getUploadedPathParts(file, relativePath);

  let currentDir = root;
  for (let j = 0; j < parts.length - 1; j++) {
    const part = parts[j];
    let nextDir = currentDir['children'].get(part);
    if (!nextDir) {
      nextDir = new VirtualDirectoryHandle(part);
      currentDir.addChild(part, nextDir);
    } else if (nextDir.kind !== 'directory') {
      throw new Error(`Path collision: ${part} is a file`);
    }
    currentDir = nextDir as VirtualDirectoryHandle;
  }
  const fileName = parts[parts.length - 1];
  currentDir.addChild(fileName, new VirtualFileHandle(fileName, file));
  const info = folderUploads.get(root)!;
  info.files++;
  if (/\.json$/i.test(file.name)) info.jsonFileNames++;
  if (/\.json$/i.test(fileName)) {
    info.jsonPaths++;
    if (parts.length === 1) info.rootJsonFiles++;
  }
  if (!relativePath) info.missingRelativePaths++;
}

export function createVirtualFileSystem(files: FileList | File[]): ReadableDirectoryHandle {
  const root = createUploadRoot();
  for (let i = 0; i < files.length; i++) addUploadedFile(root, files[i]);
  return root;
}

async function prepareUploadedFolder(files: FileList | File[], onProgress?: (done: number, total: number) => void): Promise<ReadableDirectoryHandle> {
  onProgress?.(0, files.length);
  // Paint preparation feedback before processing the browser's file list.
  await new Promise<void>(resolve => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(resolve, 0));
    else setTimeout(resolve, 0);
  });
  const root = createUploadRoot();
  let lastYield = performance.now();
  for (let i = 0; i < files.length; i++) {
    addUploadedFile(root, files[i]);
    if ((i + 1) % 256 === 0 && performance.now() - lastYield >= 8) {
      onProgress?.(i + 1, files.length);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  }
  onProgress?.(files.length, files.length);
  return root;
}

export async function openFolderPolyfill(onProgress?: (done: number, total: number) => void): Promise<ReadableDirectoryHandle> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.webkitdirectory = true;
    input.setAttribute('directory', '');
    
    input.addEventListener('cancel', () => reject(new DOMException('Folder selection cancelled', 'AbortError')), { once: true });
    
    input.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files || files.length === 0) {
        reject(new Error("No files selected"));
        return;
      }
      try {
        const root = await prepareUploadedFolder(files, onProgress);
        resolve(root);
      } catch (err) {
        reject(err);
      }
    };
    
    input.click();
  });
}
