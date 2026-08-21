import { describe, expect, it } from 'vitest';
import { sanitizeFileName } from '../src/services/parser';

describe('test setup', () => {
  it('imports TypeScript service modules', () => {
    expect(sanitizeFileName('Alice/Bob')).toBe('Alice-Bob');
  });
});
