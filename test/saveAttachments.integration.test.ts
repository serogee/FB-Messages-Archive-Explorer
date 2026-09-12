import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMediaState } from '../src/services/media';
import { downloadAsZip, downloadSingle, saveToFolder } from '../src/services/saveAttachments';
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
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(new TextDecoder().decode(bytes)).toContain('report_2.txt');
    expect(progress).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(revoke).toHaveBeenCalledWith('blob:zip');
  });
});
