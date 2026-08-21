type MockTree = Record<string, MockTree | string | Uint8Array>;

class MockFileHandle implements FileSystemFileHandle {
  readonly kind = 'file' as const;
  readonly name: string;
  private readonly content: string | Uint8Array;

  constructor(name: string, content: string | Uint8Array) {
    this.name = name;
    this.content = content;
  }

  async getFile(): Promise<File> {
    return new File([this.content], this.name);
  }

  async createWritable(): Promise<FileSystemWritableFileStream> {
    throw new DOMException('Not supported in mock filesystem', 'NotSupportedError');
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return other === this;
  }

  async queryPermission(): Promise<PermissionState> {
    return 'granted';
  }

  async requestPermission(): Promise<PermissionState> {
    return 'granted';
  }
}

class MockDirectoryHandle implements FileSystemDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly name: string;
  private readonly children = new Map<string, FileSystemDirectoryHandle | FileSystemFileHandle>();

  constructor(name: string, tree: MockTree = {}) {
    this.name = name;

    for (const [childName, value] of Object.entries(tree)) {
      this.children.set(
        childName,
        value instanceof Uint8Array || typeof value === 'string'
          ? new MockFileHandle(childName, value)
          : new MockDirectoryHandle(childName, value)
      );
    }
  }

  async getDirectoryHandle(name: string): Promise<FileSystemDirectoryHandle> {
    const child = this.children.get(name);
    if (!child || child.kind !== 'directory') {
      throw new DOMException(`Directory not found: ${name}`, 'NotFoundError');
    }
    return child;
  }

  async getFileHandle(name: string): Promise<FileSystemFileHandle> {
    const child = this.children.get(name);
    if (!child || child.kind !== 'file') {
      throw new DOMException(`File not found: ${name}`, 'NotFoundError');
    }
    return child;
  }

  async removeEntry(name: string, options?: FileSystemRemoveOptions): Promise<void> {
    const child = this.children.get(name);
    if (!child) {
      throw new DOMException(`Entry not found: ${name}`, 'NotFoundError');
    }
    if (child.kind === 'directory' && !options?.recursive) {
      throw new DOMException(`Directory is not empty: ${name}`, 'InvalidModificationError');
    }
    this.children.delete(name);
  }

  async *entries(): AsyncIterableIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]> {
    for (const entry of this.children.entries()) {
      yield entry;
    }
  }

  async *keys(): AsyncIterableIterator<string> {
    for (const key of this.children.keys()) {
      yield key;
    }
  }

  async *values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle> {
    for (const value of this.children.values()) {
      yield value;
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]> {
    return this.entries();
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return other === this;
  }

  async queryPermission(): Promise<PermissionState> {
    return 'granted';
  }

  async requestPermission(): Promise<PermissionState> {
    return 'granted';
  }

  async resolve(): Promise<string[] | null> {
    return null;
  }
}

export function createMockDirectoryHandle(
  name: string,
  tree: MockTree
): FileSystemDirectoryHandle {
  return new MockDirectoryHandle(name, tree);
}
