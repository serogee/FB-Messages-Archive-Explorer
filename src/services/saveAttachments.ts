import type { ResolvedAttachment, MediaState } from '../types/messenger';
import { findMediaFile } from './media';
import { isFileSystemAccessSupported } from './fileSystem';

async function getFileFromAttachment(
  attachment: ResolvedAttachment,
  mediaState: MediaState
): Promise<File | null> {
  const entry = attachment.mediaEntry || findMediaFile(mediaState, attachment.mediaPath);
  if (!entry || !entry.handle) return null;
  try {
    return await entry.handle.getFile();
  } catch {
    return null;
  }
}

// ── Chromium: Save to Folder ────────────────────────────────────────

export async function saveToFolder(
  attachments: ResolvedAttachment[],
  mediaState: MediaState,
  onProgress: (done: number, total: number) => void
): Promise<void> {
  if (!isFileSystemAccessSupported()) {
    throw new Error('Save to folder is not supported in this browser.');
  }

  const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  const total = attachments.length;
  let done = 0;
  onProgress(done, total);

  // Keep track of used names to prevent overwriting
  const usedNames = new Set<string>();

  for (const att of attachments) {
    const file = await getFileFromAttachment(att, mediaState);
    if (!file) {
      done++;
      onProgress(done, total);
      continue;
    }

    let baseName = att.mediaPath.split('/').pop() || 'file';
    let name = baseName;
    let counter = 1;
    const parts = baseName.split('.');
    const ext = parts.length > 1 ? `.${parts.pop()}` : '';
    const stem = parts.join('.');

    while (usedNames.has(name.toLowerCase())) {
      counter++;
      name = `${stem} (${counter})${ext}`;
    }
    usedNames.add(name.toLowerCase());

    try {
      const fileHandle = await dirHandle.getFileHandle(name, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(file);
      await writable.close();
    } catch (e) {
      console.error(`Failed to save ${name}:`, e);
    }
    done++;
    onProgress(done, total);
  }
}

// ── Cross-browser: Download Single ──────────────────────────────────

export async function downloadSingle(
  attachment: ResolvedAttachment,
  mediaState: MediaState
): Promise<void> {
  const file = await getFileFromAttachment(attachment, mediaState);
  if (!file) return;

  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = attachment.mediaPath.split('/').pop() || 'download';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Cross-browser: Download ZIP ─────────────────────────────────────

function createCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
}

const crcTable = createCrcTable();

function crc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function downloadAsZip(
  attachments: ResolvedAttachment[],
  mediaState: MediaState,
  chatTitle: string,
  onProgress: (done: number, total: number) => void
): Promise<void> {
  const total = attachments.length;
  let done = 0;
  onProgress(done, total);

  const encoder = new TextEncoder();
  const fileRecords: {
    nameBytes: Uint8Array;
    data: Uint8Array;
    crc: number;
    offset: number;
  }[] = [];

  const usedNames = new Set<string>();
  let currentOffset = 0;
  const chunks: BlobPart[] = [];

  // 1. Write Local File Headers + File Data
  for (const att of attachments) {
    const file = await getFileFromAttachment(att, mediaState);
    if (!file) {
      done++;
      onProgress(done, total);
      continue;
    }

    const arrayBuffer = await file.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);
    const crc = crc32(data);

    let baseName = att.mediaPath.split('/').pop() || 'file';
    let name = baseName;
    let counter = 1;
    const parts = baseName.split('.');
    const ext = parts.length > 1 ? `.${parts.pop()}` : '';
    const stem = parts.join('.');
    while (usedNames.has(name.toLowerCase())) {
      counter++;
      name = `${stem} (${counter})${ext}`;
    }
    usedNames.add(name.toLowerCase());

    const nameBytes = encoder.encode(name);
    
    // Local File Header
    const header = new ArrayBuffer(30 + nameBytes.length);
    const view = new DataView(header);
    
    view.setUint32(0, 0x04034b50, true); // Signature
    view.setUint16(4, 10, true);         // Version needed
    view.setUint16(6, 0, true);          // Flags
    view.setUint16(8, 0, true);          // Compression (Store)
    view.setUint16(10, 0, true);         // Mod time (dummy)
    view.setUint16(12, 0, true);         // Mod date (dummy)
    view.setUint32(14, crc, true);       // CRC32
    view.setUint32(18, data.length, true); // Compressed size
    view.setUint32(22, data.length, true); // Uncompressed size
    view.setUint16(26, nameBytes.length, true); // Filename length
    view.setUint16(28, 0, true);         // Extra field length

    const headerBytes = new Uint8Array(header);
    headerBytes.set(nameBytes, 30);

    chunks.push(headerBytes);
    chunks.push(data);

    fileRecords.push({
      nameBytes,
      data,
      crc,
      offset: currentOffset
    });

    currentOffset += headerBytes.length + data.length;
    done++;
    onProgress(done, total);
  }

  // 2. Write Central Directory
  const cdOffset = currentOffset;
  let cdSize = 0;

  for (const record of fileRecords) {
    const cd = new ArrayBuffer(46 + record.nameBytes.length);
    const view = new DataView(cd);

    view.setUint32(0, 0x02014b50, true); // Signature
    view.setUint16(4, 10, true);         // Version made by
    view.setUint16(6, 10, true);         // Version needed
    view.setUint16(8, 0, true);          // Flags
    view.setUint16(10, 0, true);         // Compression (Store)
    view.setUint16(12, 0, true);         // Mod time
    view.setUint16(14, 0, true);         // Mod date
    view.setUint32(16, record.crc, true); // CRC32
    view.setUint32(20, record.data.length, true); // Compressed size
    view.setUint32(24, record.data.length, true); // Uncompressed size
    view.setUint16(28, record.nameBytes.length, true); // Filename length
    view.setUint16(30, 0, true);         // Extra field length
    view.setUint16(32, 0, true);         // Comment length
    view.setUint16(34, 0, true);         // Disk number start
    view.setUint16(36, 0, true);         // Internal file attr
    view.setUint32(38, 0, true);         // External file attr
    view.setUint32(42, record.offset, true); // Relative offset of local header

    const cdBytes = new Uint8Array(cd);
    cdBytes.set(record.nameBytes, 46);
    chunks.push(cdBytes);
    cdSize += cdBytes.length;
  }

  // 3. End of Central Directory
  const eocd = new ArrayBuffer(22);
  const viewEocd = new DataView(eocd);
  viewEocd.setUint32(0, 0x06054b50, true); // Signature
  viewEocd.setUint16(4, 0, true);          // Disk number
  viewEocd.setUint16(6, 0, true);          // CD Start Disk
  viewEocd.setUint16(8, fileRecords.length, true); // CD Records on disk
  viewEocd.setUint16(10, fileRecords.length, true); // CD Records total
  viewEocd.setUint32(12, cdSize, true);    // CD Size
  viewEocd.setUint32(16, cdOffset, true);  // CD Offset
  viewEocd.setUint16(20, 0, true);         // Comment length

  chunks.push(new Uint8Array(eocd));

  // 4. Download ZIP
  const blob = new Blob(chunks, { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const safeTitle = (chatTitle || 'Chat').replace(/[<>:"/\\|?*]+/g, '-').trim();
  a.download = `${safeTitle} - Attachments.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
