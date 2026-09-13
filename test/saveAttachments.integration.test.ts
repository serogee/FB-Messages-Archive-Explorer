import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMediaState } from '../src/services/media';
import {
  assertClassicZipLimits,
  CLASSIC_ZIP_MAX_ENTRIES,
  CLASSIC_ZIP_MAX_VALUE,
  downloadAsZip,
  downloadSingle,
  saveToFolder,
} from '../src/services/saveAttachments';
import type { MediaEntry, ResolvedAttachment } from '../src/types/messenger';

function attachment(path: string, content?: string): ResolvedAttachment {
  const mediaEntry: MediaEntry | null = content === undefined ? null : {
    type: 'unknown',
    handle: {
      kind: 'file',
      name: path.split('/').at(-1)!,
      getFile: async () => new File([content], path.split('/').at(-1)!),
    },
  };
  return { mediaPath: path, category: 'files', messageIndex: 0, timestamp: 0, sender: 'Alice', mediaEntry };
}

function parseStoreOnlyZip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = bytes.length - 22;
  expect(view.getUint32(eocdOffset, true)).toBe(0x06054b50);
  const recordCount = view.getUint16(eocdOffset + 10, true);
  const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);
  expect(centralDirectoryOffset + centralDirectorySize).toBe(eocdOffset);

  const decoder = new TextDecoder();
  const entries: Array<{ name: string; content: string; crc: number; size: number; offset: number }> = [];
  let cursor = centralDirectoryOffset;
  for (let index = 0; index < recordCount; index++) {
    expect(view.getUint32(cursor, true)).toBe(0x02014b50);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    expect(view.getUint32(localOffset + 14, true)).toBe(crc);
    expect(view.getUint32(localOffset + 18, true)).toBe(compressedSize);
    expect(view.getUint32(localOffset + 22, true)).toBe(uncompressedSize);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    entries.push({
      name,
      content: decoder.decode(bytes.slice(dataOffset, dataOffset + compressedSize)),
      crc,
      size: uncompressedSize,
      offset: localOffset,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  expect(cursor).toBe(eocdOffset);
  return { recordCount, centralDirectoryOffset, centralDirectorySize, entries };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('attachment output integration', () => {
  it('writes readable files with unique names, skips missing media, and continues after a write failure', async () => {
    const writes = new Map<string, Blob>();
    const requestedNames: string[] = [];
    const directory = {
      getFileHandle: vi.fn(async (name: string) => {
        requestedNames.push(name);
        if (name.endsWith('_2.txt')) throw new Error('disk full');
        return {
          createWritable: async () => ({
            write: async (value: Blob) => { writes.set(name, value); },
            close: async () => {},
          }),
        };
      }),
    };
    vi.stubGlobal('window', { showDirectoryPicker: vi.fn(async () => directory) });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const progress: Array<[number, number]> = [];

    await saveToFolder(
      [attachment('one/report.txt', 'one'), attachment('two/report.txt', 'two'), attachment('missing.txt')],
      createMediaState(),
      (done, total) => progress.push([done, total]),
      false,
    );

    expect(requestedNames).toEqual(['report.txt', 'report_2.txt']);
    expect(await writes.get('report.txt')?.text()).toBe('one');
    expect(console.error).toHaveBeenCalledOnce();
    expect(progress).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]]);
  });

  it('rejects folder saving when the native picker is unavailable', async () => {
    vi.stubGlobal('window', {});
    await expect(saveToFolder([], createMediaState(), () => {})).rejects.toThrow(
      'Save to folder is not supported in this browser.'
    );
  });

  it('downloads one file and revokes its object URL after the cleanup delay', async () => {
    vi.useFakeTimers();
    const click = vi.fn();
    const anchor = { href: '', download: '', click };
    vi.stubGlobal('document', { createElement: vi.fn(() => anchor) });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:single');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    await downloadSingle(attachment('docs/report.txt', 'body'), createMediaState(), false);

    expect(anchor).toMatchObject({ href: 'blob:single', download: 'report.txt' });
    expect(click).toHaveBeenCalledOnce();
    expect(revoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(revoke).toHaveBeenCalledWith('blob:single');
  });

  it('builds a valid ZIP containing unique readable attachments and reports skipped files', async () => {
    vi.useFakeTimers();
    const click = vi.fn();
    const anchor = { href: '', download: '', click };
    vi.stubGlobal('document', { createElement: vi.fn(() => anchor) });
    let output: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
      output = blob as Blob;
      return 'blob:zip';
    });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const progress: Array<[number, number]> = [];

    await downloadAsZip(
      [attachment('one/report.txt', 'one'), attachment('two/report.txt', 'two'), attachment('missing.txt')],
      createMediaState(),
      'Project Chat',
      (done, total) => progress.push([done, total]),
      false,
    );

    expect(anchor).toMatchObject({ href: 'blob:zip', download: 'Project-Chat-Attachments.zip' });
    expect(click).toHaveBeenCalledOnce();
    expect(output?.type).toBe('application/zip');
    const bytes = new Uint8Array(await output!.arrayBuffer());
    const archive = parseStoreOnlyZip(bytes);
    expect(archive.recordCount).toBe(2);
    expect(archive.entries).toEqual([
      { name: 'report.txt', content: 'one', crc: 0x7a6c86f1, size: 3, offset: 0 },
      { name: 'report_2.txt', content: 'two', crc: 0x11ca8a66, size: 3, offset: 43 },
    ]);
    expect(archive.entries.map(entry => entry.name)).not.toContain('missing.txt');
    expect(progress).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(revoke).toHaveBeenCalledWith('blob:zip');
  });

  it('rejects classic ZIP values that require ZIP64', () => {
    expect(() => assertClassicZipLimits(CLASSIC_ZIP_MAX_ENTRIES, 0, CLASSIC_ZIP_MAX_VALUE - 22))
      .not.toThrow();
    expect(() => assertClassicZipLimits(CLASSIC_ZIP_MAX_ENTRIES + 1, 0, 0)).toThrow(/65,535 files/);
    expect(() => assertClassicZipLimits(1, CLASSIC_ZIP_MAX_VALUE + 1, 0)).toThrow(/4 GiB/);
    expect(() => assertClassicZipLimits(1, 0, CLASSIC_ZIP_MAX_VALUE + 1)).toThrow(/4 GiB/);
    expect(() => assertClassicZipLimits(1, 23, CLASSIC_ZIP_MAX_VALUE - 44)).toThrow(/4 GiB/);
  });
});
