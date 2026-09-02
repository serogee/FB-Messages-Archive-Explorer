import type { ResolvedAttachment, MediaState } from '../types/messenger';
import { findMediaFile } from './media';
import { isFileSystemAccessSupported } from './fileSystem';

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

function getOriginalFilename(attachment: ResolvedAttachment): string {
  return attachment.mediaPath.split('/').pop() || 'file';
}

function getExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf('.');
  return dotIndex > 0 ? filename.slice(dotIndex) : '';
}

export const DEFAULT_ATTACHMENT_FILENAME_TEMPLATE = '{-chat}_{date}_{time}_{ms}';
const MAX_CHAT_TITLE_LENGTH = 60;
const MAX_SENDER_LENGTH = 40;
const MAX_ORIGINAL_STEM_LENGTH = 80;
const DEFAULT_ATTACHMENT_FILENAME_LENGTH = 100;
const LONG_ATTACHMENT_FILENAME_LENGTH = 180;
const ALPHANUMERIC_CHARACTER = /^[\p{L}\p{N}]$/u;
const SAFE_FILENAME_CHARACTER = /^[\p{L}\p{N} _-]$/u;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function truncate(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join('');
}

function getSafeNameValue(
  value: string,
  fallback: string,
  maxLength: number,
  separator: ' ' | '_' | '-'
): string {
  const safeValue = Array.from((value || fallback).normalize('NFKD'))
    .filter(character => !/^\p{M}$/u.test(character))
    .map(character => ALPHANUMERIC_CHARACTER.test(character) ? character : separator)
    .join('')
    .replace(separator === '_' ? /_+/g : separator === '-' ? /-+/g : / +/g, separator)
    .replace(/^[\s._-]+|[\s._-]+$/g, '');
  return truncate(safeValue || fallback, maxLength).replace(/[\s._-]+$/g, '') || fallback;
}

function getSafeExtension(filename: string): string {
  return truncate(getExtension(filename).slice(1).replace(/[^a-z0-9]/gi, ''), 12);
}

function getSafeFilename(value: string, extension: string, maxFilenameLength: number): string {
  let safeFilename = Array.from(value)
    .filter(character => SAFE_FILENAME_CHARACTER.test(character))
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  const extensionSuffix = extension ? `.${extension}` : '';
  if (extensionSuffix && !safeFilename.toLowerCase().endsWith(extensionSuffix.toLowerCase())) {
    safeFilename = `${safeFilename}${extensionSuffix}`;
  }

  const stem = extensionSuffix ? safeFilename.slice(0, -extensionSuffix.length) : safeFilename;
  const maxStemLength = maxFilenameLength - Array.from(extensionSuffix).length;
  let limitedStem = truncate(stem, maxStemLength).replace(/[\s.]+$/g, '') || 'Attachment';
  if (WINDOWS_RESERVED_NAME.test(limitedStem)) {
    limitedStem = `_${truncate(limitedStem, maxStemLength - 1)}`;
  }
  return `${limitedStem}${extensionSuffix}`;
}

/** Builds a filesystem-safe name from the message timestamp in local time. */
export function getAttachmentDownloadName(
  attachment: ResolvedAttachment,
  useDateFilename = true,
  chatTitle = 'Chat',
  template = DEFAULT_ATTACHMENT_FILENAME_TEMPLATE,
  allowLongFilenames = false
): string {
  const originalName = getOriginalFilename(attachment);
  if (!useDateFilename) return originalName;

  const date = new Date(attachment.timestamp);
  if (!Number.isFinite(date.getTime())) return originalName;

  const extension = getSafeExtension(originalName);
  const originalStem = extension
    ? originalName.slice(0, -(extension.length + 1))
    : originalName;
  const values: Record<string, string> = {
    chat: getSafeNameValue(chatTitle, 'Chat', MAX_CHAT_TITLE_LENGTH, ' '),
    _chat: getSafeNameValue(chatTitle, 'Chat', MAX_CHAT_TITLE_LENGTH, '_'),
    '-chat': getSafeNameValue(chatTitle, 'Chat', MAX_CHAT_TITLE_LENGTH, '-'),
    sender: getSafeNameValue(attachment.sender, 'Unknown', MAX_SENDER_LENGTH, ' '),
    _sender: getSafeNameValue(attachment.sender, 'Unknown', MAX_SENDER_LENGTH, '_'),
    '-sender': getSafeNameValue(attachment.sender, 'Unknown', MAX_SENDER_LENGTH, '-'),
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`,
    ms: pad(date.getMilliseconds(), 3),
    original: getSafeNameValue(originalStem, 'Attachment', MAX_ORIGINAL_STEM_LENGTH, ' '),
  };
  const selectedTemplate = (template.trim() || DEFAULT_ATTACHMENT_FILENAME_TEMPLATE)
    .replace(/\.?\{ext\}/g, '');
  const rendered = selectedTemplate
    .replace(/\{(_chat|-chat|chat|_sender|-sender|sender|date|time|ms|original)\}/g, (_, key: string) => values[key])
    .replace(/\{[^{}]*\}/g, '');
  return getSafeFilename(
    rendered,
    extension,
    allowLongFilenames ? LONG_ATTACHMENT_FILENAME_LENGTH : DEFAULT_ATTACHMENT_FILENAME_LENGTH
  );
}

export function getUniqueAttachmentName(
  baseName: string,
  usedNames: Set<string>,
  maxFilenameLength = DEFAULT_ATTACHMENT_FILENAME_LENGTH
): string {
  const dotIndex = baseName.lastIndexOf('.');
  const hasExtension = dotIndex > 0;
  const stem = hasExtension ? baseName.slice(0, dotIndex) : baseName;
  const extension = hasExtension ? baseName.slice(dotIndex) : '';
  let name = baseName;
  let counter = 1;

  while (usedNames.has(name.toLowerCase())) {
    counter++;
    const suffix = `_${counter}`;
    const maxStemLength = maxFilenameLength
      - Array.from(suffix).length
      - Array.from(extension).length;
    name = `${truncate(stem, maxStemLength).replace(/[\s.]+$/g, '')}${suffix}${extension}`;
  }
  usedNames.add(name.toLowerCase());
  return name;
}

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

export async function saveToFolder(
  attachments: ResolvedAttachment[],
  mediaState: MediaState,
  onProgress: (done: number, total: number) => void,
  useDateFilenames = true,
  chatTitle = 'Chat',
  template = DEFAULT_ATTACHMENT_FILENAME_TEMPLATE,
  allowLongFilenames = false
): Promise<void> {
  if (!isFileSystemAccessSupported()) {
    throw new Error('Save to folder is not supported in this browser.');
  }

  const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  const total = attachments.length;
  let done = 0;
  onProgress(done, total);

  const usedNames = new Set<string>();

  for (const att of attachments) {
    const file = await getFileFromAttachment(att, mediaState);
    if (!file) {
      done++;
      onProgress(done, total);
      continue;
    }

    const name = getUniqueAttachmentName(
      getAttachmentDownloadName(att, useDateFilenames, chatTitle, template, allowLongFilenames),
      usedNames,
      allowLongFilenames ? LONG_ATTACHMENT_FILENAME_LENGTH : DEFAULT_ATTACHMENT_FILENAME_LENGTH
    );

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

export async function downloadSingle(
  attachment: ResolvedAttachment,
  mediaState: MediaState,
  useDateFilename = true,
  chatTitle = 'Chat',
  template = DEFAULT_ATTACHMENT_FILENAME_TEMPLATE,
  allowLongFilenames = false
): Promise<void> {
  const file = await getFileFromAttachment(attachment, mediaState);
  if (!file) return;

  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = getAttachmentDownloadName(attachment, useDateFilename, chatTitle, template, allowLongFilenames);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

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
  onProgress: (done: number, total: number) => void,
  useDateFilenames = true,
  template = DEFAULT_ATTACHMENT_FILENAME_TEMPLATE,
  allowLongFilenames = false
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

    const name = getUniqueAttachmentName(
      getAttachmentDownloadName(att, useDateFilenames, chatTitle, template, allowLongFilenames),
      usedNames,
      allowLongFilenames ? LONG_ATTACHMENT_FILENAME_LENGTH : DEFAULT_ATTACHMENT_FILENAME_LENGTH
    );

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

  const blob = new Blob(chunks, { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const safeTitle = getSafeNameValue(chatTitle, 'Chat', MAX_CHAT_TITLE_LENGTH, '-');
  a.download = `${safeTitle}-Attachments.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
