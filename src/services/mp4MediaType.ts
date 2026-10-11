/** Read track handlers from movie metadata without decoding media. */
const MAX_MOVIE_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_TOP_LEVEL_BOXES = 128;
const MAX_CHILD_BOXES = 4096;

interface Box {
  type: string;
  body: number;
  end: number;
}

function ascii(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

function readBox(bytes: Uint8Array, offset: number, end: number, allowToEnd = false): Box | null {
  if (offset + 8 > bytes.length || offset + 8 > end) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size = view.getUint32(offset);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > bytes.length || offset + 16 > end) return null;
    const extendedSize = view.getBigUint64(offset + 8);
    if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(extendedSize);
    headerSize = 16;
  } else if (size === 0) {
    if (!allowToEnd) return null;
    size = end - offset;
  }
  if (size < headerSize || size > end - offset) return null;
  return { type: ascii(bytes, offset + 4), body: offset + headerSize, end: offset + size };
}

function children(bytes: Uint8Array, start: number, end: number): Box[] | null {
  const result: Box[] = [];
  for (let offset = start; offset < end;) {
    if (result.length >= MAX_CHILD_BOXES) return null;
    const box = readBox(bytes, offset, end);
    if (!box) return null;
    result.push(box);
    offset = box.end;
  }
  return result;
}

function classifyMovie(bytes: Uint8Array): 'audio' | 'video' | null {
  const boxes = children(bytes, 0, bytes.length);
  if (!boxes) return null;
  let hasAudio = false;
  let hasVideo = false;
  for (const track of boxes.filter(box => box.type === 'trak')) {
    const trackBoxes = children(bytes, track.body, track.end);
    const media = trackBoxes?.find(box => box.type === 'mdia');
    if (!media) return null;
    const mediaBoxes = children(bytes, media.body, media.end);
    const handler = mediaBoxes?.find(box => box.type === 'hdlr');
    // Full-box header, predefined value, then handler_type (vide / soun).
    if (!handler || handler.body + 12 > handler.end || bytes[handler.body] !== 0) return null;
    const type = ascii(bytes, handler.body + 8);
    hasVideo ||= type === 'vide';
    hasAudio ||= type === 'soun';
  }
  return hasVideo ? 'video' : hasAudio ? 'audio' : null;
}

export async function readMp4MediaType(file: Blob, signal?: AbortSignal): Promise<'audio' | 'video' | null> {
  try {
    let offset = 0;
    for (let count = 0; offset + 8 <= file.size && count < MAX_TOP_LEVEL_BOXES; count++) {
      if (signal?.aborted) return null;
      const header = new Uint8Array(await file.slice(offset, offset + 16).arrayBuffer());
      const box = readBox(header, 0, file.size - offset, true);
      if (!box) return null;
      if (box.type === 'moov') {
        const metadataSize = box.end - box.body;
        if (metadataSize > MAX_MOVIE_METADATA_BYTES) return null;
        const metadata = new Uint8Array(await file.slice(offset + box.body, offset + box.end).arrayBuffer());
        return signal?.aborted ? null : classifyMovie(metadata);
      }
      offset += box.end;
    }
  } catch {
    // Missing, unsupported, or incomplete metadata keeps the export's classification.
  }
  return null;
}
