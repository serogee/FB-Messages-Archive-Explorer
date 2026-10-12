import { describe, expect, it } from 'vitest';
import { prioritizeAttachmentPreview, waitForAttachmentPreview } from '../src/services/attachmentScanScheduling';

describe('ownership scan read scheduling', () => {
  it('waits for all foreground jobs and releases canceled previews immediately', async () => {
    const controller = new AbortController();
    const first = prioritizeAttachmentPreview();
    const second = prioritizeAttachmentPreview(controller.signal);
    let resumed = false;
    const scan = waitForAttachmentPreview().then(() => { resumed = true; });
    first(); first();
    await Promise.resolve();
    expect(resumed).toBe(false);
    controller.abort();
    await scan;
    expect(resumed).toBe(true);
    second();
    await waitForAttachmentPreview();
  });

  it('cancels a waiting scan without waiting for the foreground read', async () => {
    const release = prioritizeAttachmentPreview();
    const controller = new AbortController();
    const scan = waitForAttachmentPreview(controller.signal);
    controller.abort();
    await expect(scan).rejects.toMatchObject({ name: 'AbortError' });
    release();
  });
});
