export class VirtualFileHandle {
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

export class VirtualDirectoryHandle {
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
      throw new Error(`Directory not found: ${name}`);
    }
    if (child.kind !== 'directory') {
      throw new Error(`${name} is a file, not a directory`);
    }
    return child;
  }

  async getFileHandle(name: string, _options?: { create?: boolean }): Promise<VirtualFileHandle> {
    const child = this.children.get(name);
    if (!child) {
      throw new Error(`File not found: ${name}`);
    }
    if (child.kind !== 'file') {
      throw new Error(`${name} is a directory, not a file`);
    }
    return child;
  }

  async *entries(): AsyncIterableIterator<[string, VirtualFileHandle | VirtualDirectoryHandle]> {
    for (const [name, handle] of this.children.entries()) {
      yield [name, handle];
    }
  }

  async removeEntry(_name: string, _options?: { recursive?: boolean }): Promise<void> {
    throw new Error('Deletion is not supported in fallback mode.');
  }

  addChild(name: string, handle: VirtualFileHandle | VirtualDirectoryHandle) {
    this.children.set(name, handle);
  }
}

export function createVirtualFileSystem(files: FileList | File[]): FileSystemDirectoryHandle {
  const root = new VirtualDirectoryHandle('root');

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    // webkitRelativePath contains the full path e.g. "facebook-xxx/messages/inbox/chat/message_1.json"
    // If not present, fallback to just the file name (though this won't work for folder structures)
    const path = file.webkitRelativePath || file.name;
    const parts = path.split('/');
    
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

  // Cast to the native interface so TypeScript accepts it throughout the app
  return root as unknown as FileSystemDirectoryHandle;
}

export async function openFolderPolyfill(): Promise<FileSystemDirectoryHandle> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.webkitdirectory = true;
    input.setAttribute('directory', '');
    
    // In some browsers, if the user cancels, the change event never fires.
    // Unfortunately, there's no reliable cross-browser way to detect cancel on file inputs.
    // The promise will just hang if they cancel, which is acceptable because they can just click the button again.
    
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
