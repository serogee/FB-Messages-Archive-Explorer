export function mp4Box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(8 + parts.reduce((size, part) => size + part.length, 0));
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set(new TextEncoder().encode(type), 4);
  let offset = 8;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

export function mp4Track(handler: string): Uint8Array {
  const data = new Uint8Array(12);
  data.set(new TextEncoder().encode(handler), 8);
  return mp4Box('trak', mp4Box('mdia', mp4Box('hdlr', data)));
}
