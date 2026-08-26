import type { ReadableDirectoryHandle, ReadableEntryHandle, ReadableFileHandle } from '../types/fileSystem';

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
    this.children.set(name, handle);
  }
}

export function createVirtualFileSystem(files: FileList | File[]): ReadableDirectoryHandle {
  const root = new VirtualDirectoryHandle('root');

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    // Folder uploads include the selected directory name; native handles expose its contents.
    const relativePath = file.webkitRelativePath;
    const parts = (relativePath || file.name).split('/').filter(Boolean);
    if (relativePath && parts.length > 1) parts.shift();
    
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
  }

  return root;
}

export async function openFolderPolyfill(): Promise<ReadableDirectoryHandle> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.webkitdirectory = true;
    input.setAttribute('directory', '');
    
    // File inputs do not reliably report cancellation across browsers. A later picker
    // request remains independent if this promise never settles.
    
    input.onchange = (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files || files.length === 0) {
        reject(new Error("No files selected"));
        return;
      }
      try {
        const root = createVirtualFileSystem(files);
        resolve(root);
      } catch (err) {
        reject(err);
      }
    };
    
    input.click();
  });
}
