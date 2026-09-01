import { describe, expect, it } from 'vitest';
import { extractLinksFromText, getMessageLinks, normalizeExternalUrl } from '../src/services/messageLinks';

describe('message link extraction', () => {
  it('normalizes external http, https, and www links', () => {
    expect(normalizeExternalUrl('https://example.com/path')).toBe('https://example.com/path');
    expect(normalizeExternalUrl('http://example.com/path')).toBe('http://example.com/path');
    expect(normalizeExternalUrl('www.example.com/path')).toBe('https://www.example.com/path');
    expect(normalizeExternalUrl('ftp://example.com/path')).toBeNull();
  });

  it('extracts inline https links and trims sentence punctuation', () => {
    expect(extractLinksFromText('Look at https://example.com/path). Also www.test.com!')).toEqual([
      { url: 'https://example.com/path', label: 'https://example.com/path' },
      { url: 'https://www.test.com/', label: 'www.test.com' },
    ]);
  });

  it('combines Messenger share links with inline text links without duplicates', () => {
    const links = getMessageLinks({
      sender_name: 'Alice',
      timestamp_ms: 1,
      text: 'same https://example.com/a plus https://openai.com',
      share: {
        link: 'https://example.com/a',
        share_text: 'Example',
      },
    });

    expect(links).toEqual([
      { url: 'https://example.com/a', label: 'Example' },
      { url: 'https://openai.com/', label: 'https://openai.com' },
    ]);
  });
});
