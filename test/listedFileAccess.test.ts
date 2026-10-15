import { describe, expect, it, vi } from 'vitest';
import { FolderOpenDiagnostics } from '../src/services/folderOpenDiagnostics';
import { needsNamedFileLookup, readListedFile } from '../src/services/listedFileAccess';
import { createMockDirectoryHandle } from './helpers/mockFileSystem';

function fixture() {
  const directory = createMockDirectoryHandle('export', { 'chat.json': '{}' });
  const listed = { kind: 'file' as const, name: 'chat.json', getFile: vi.fn(async () => new File(['{}'], 'chat.json')) };
  return { directory, listed, lookup: vi.spyOn(directory, 'getFileHandle') };
}

describe('listed file access recovery', () => {
  it('keeps successful reads on the existing handle', async () => {
    const { directory, listed, lookup } = fixture();
    await expect(readListedFile(directory, 'chat.json', listed)).resolves.toHaveProperty('size', 2);
    expect(listed.getFile).toHaveBeenCalledOnce();
    expect(lookup).not.toHaveBeenCalled();
    expect(needsNamedFileLookup(directory)).toBe(false);
  });

  it('reopens a missing listed handle once and uses name lookup for subsequent reads', async () => {
    const { directory, listed, lookup } = fixture();
    listed.getFile.mockRejectedValue(new DOMException('Listed document not found', 'NotFoundError'));

    await expect(readListedFile(directory, 'chat.json', listed)).resolves.toHaveProperty('size', 2);
    await expect(readListedFile(directory, 'chat.json', listed)).resolves.toHaveProperty('size', 2);

    expect(listed.getFile).toHaveBeenCalledOnce();
    expect(lookup.mock.calls).toEqual([['chat.json', { create: false }], ['chat.json', { create: false }]]);
    expect(needsNamedFileLookup(directory)).toBe(true);
  });

  it.each(['NotAllowedError', 'NotReadableError', 'AbortError'])('does not retry %s', async name => {
    const { directory, listed, lookup } = fixture();
    const error = new DOMException('Read failed', name);
    listed.getFile.mockRejectedValue(error);
    await expect(readListedFile(directory, 'chat.json', listed)).rejects.toBe(error);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(['lookup', 'read'])('retains the original error and identifies a failed reopen %s', async step => {
    const { directory, listed, lookup } = fixture();
    const original = new DOMException('Listed document not found', 'NotFoundError');
    listed.getFile.mockRejectedValue(original);
    if (step === 'lookup') lookup.mockRejectedValue(new DOMException('Document lookup failed', 'NotFoundError'));
    else vi.spyOn(await directory.getFileHandle('chat.json'), 'getFile').mockRejectedValue(new DOMException('Document read failed', 'NotFoundError'));
    lookup.mockClear();
    const diagnostics = new FolderOpenDiagnostics('read');
    diagnostics.stage = 'Messenger detection';

    await expect(readListedFile(directory, 'chat.json', listed, undefined, diagnostics, 0)).rejects.toBe(original);

    expect(lookup).toHaveBeenCalledExactlyOnceWith('chat.json', { create: false });
    expect(diagnostics.describe(original)).toContain('operation=getFile(); folder depth=0');
    expect(diagnostics.describe(original)).toContain(`reopen operation=${step === 'lookup' ? 'getFileHandle()' : 'getFile()'}; reopen error=NotFoundError`);
    expect(needsNamedFileLookup(directory)).toBe(false);
  });

  it('does not reopen a listed file after cancellation', async () => {
    const { directory, listed, lookup } = fixture();
    const controller = new AbortController();
    listed.getFile.mockImplementation(async () => {
      controller.abort();
      throw new DOMException('Listed document not found', 'NotFoundError');
    });
    await expect(readListedFile(directory, 'chat.json', listed, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('does not read a reopened file after cancellation', async () => {
    const { directory, listed, lookup } = fixture();
    const controller = new AbortController();
    const handle = await directory.getFileHandle('chat.json');
    const getFile = vi.spyOn(handle, 'getFile');
    listed.getFile.mockRejectedValue(new DOMException('Listed document not found', 'NotFoundError'));
    lookup.mockImplementation(async () => { controller.abort(); return handle; });
    await expect(readListedFile(directory, 'chat.json', listed, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(getFile).not.toHaveBeenCalled();
    expect(needsNamedFileLookup(directory)).toBe(false);
  });
});
