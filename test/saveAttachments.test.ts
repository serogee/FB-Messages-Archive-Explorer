import { describe, expect, it } from 'vitest';
import type { ResolvedAttachment } from '../src/types/messenger';
import { getAttachmentDownloadName, getUniqueAttachmentName } from '../src/services/saveAttachments';

function attachment(timestamp: number, mediaPath = 'photos/original.photo.jpg'): ResolvedAttachment {
  return {
    mediaPath,
    category: 'photos',
    messageIndex: 0,
    timestamp,
    sender: 'Test',
    mediaEntry: null,
  };
}

describe('attachment download filenames', () => {
  it('uses the local message timestamp and preserves the final extension', () => {
    const timestamp = new Date(2026, 7, 17, 14, 32, 9, 427).getTime();
    expect(getAttachmentDownloadName(attachment(timestamp), true, 'Family Chat')).toBe('Family-Chat_2026-08-17_14-32-09_427.jpg');
  });

  it('keeps the original filename when date naming is disabled', () => {
    expect(getAttachmentDownloadName(attachment(0), false, 'Family Chat')).toBe('original.photo.jpg');
  });

  it('sanitizes and limits the chat title prefix', () => {
    const timestamp = new Date(2026, 7, 17, 14, 32, 9, 427).getTime();
    const longTitle = `${'A'.repeat(70)}/Friends`;
    expect(getAttachmentDownloadName(attachment(timestamp), true, longTitle)).toBe(
      `${'A'.repeat(60)}_2026-08-17_14-32-09_427.jpg`
    );
  });

  it('supports plain, underscore, and dash name placeholders without emoji or unsafe symbols', () => {
    const timestamp = new Date(2026, 7, 17, 14, 32, 9, 427).getTime();
    const item = { ...attachment(timestamp), sender: 'Jane 😀 Doe / Admin' };
    expect(getAttachmentDownloadName(
      item,
      true,
      'Family 😀 Chat',
      '{chat}_{_chat}_{-chat}_{sender}_{_sender}_{-sender}_{date}.{ext}'
    )).toBe('Family Chat_Family_Chat_Family-Chat_Jane Doe Admin_Jane_Doe_Admin_Jane-Doe-Admin_2026-08-17.jpg');
  });

  it('limits the complete customized filename to 100 characters by default', () => {
    const timestamp = new Date(2026, 7, 17, 14, 32, 9, 427).getTime();
    const name = getAttachmentDownloadName(
      attachment(timestamp),
      true,
      'A'.repeat(60),
      '{chat}{chat}{chat}{chat}.{ext}'
    );
    expect(Array.from(name)).toHaveLength(100);
    expect(name.endsWith('.jpg')).toBe(true);
  });

  it('allows filenames up to 180 characters when long filenames are enabled', () => {
    const timestamp = new Date(2026, 7, 17, 14, 32, 9, 427).getTime();
    const name = getAttachmentDownloadName(
      attachment(timestamp),
      true,
      'A'.repeat(60),
      '{chat}{chat}{chat}{chat}.{ext}',
      true
    );
    expect(Array.from(name)).toHaveLength(180);
    expect(name.endsWith('.jpg')).toBe(true);
  });

  it('avoids Windows reserved filenames produced by a custom template', () => {
    const timestamp = new Date(2026, 7, 17, 14, 32, 9, 427).getTime();
    expect(getAttachmentDownloadName(attachment(timestamp), true, 'CON', '{chat}.{ext}')).toBe('_CON.jpg');
  });

  it('uses the default template when the customized stem is empty', () => {
    const timestamp = new Date(2026, 7, 17, 14, 32, 9, 427).getTime();
    expect(getAttachmentDownloadName(attachment(timestamp), true, 'Family Chat', '')).toBe(
      'Family-Chat_2026-08-17_14-32-09_427.jpg'
    );
  });

  it('adds suffixes for duplicate names in batch downloads', () => {
    const used = new Set<string>();
    expect(getUniqueAttachmentName('2026-08-17_14-32-09_427.jpg', used)).toBe('2026-08-17_14-32-09_427.jpg');
    expect(getUniqueAttachmentName('2026-08-17_14-32-09_427.jpg', used)).toBe('2026-08-17_14-32-09_427_2.jpg');
  });
});
