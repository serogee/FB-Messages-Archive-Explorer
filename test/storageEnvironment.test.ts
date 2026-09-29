// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('imports storage and safely handles unavailable browser storage', async () => {
  vi.stubGlobal('window', undefined);
  vi.stubGlobal('document', undefined);
  vi.stubGlobal('localStorage', undefined);

  const { storageGet, storageSet, storageRemove } = await import('../src/services/storage');
  expect(storageGet('perspective')).toBeNull();
  expect(() => storageSet('perspective', 'Alice')).not.toThrow();
  expect(() => storageRemove('perspective')).not.toThrow();
  expect(storageGet('perspective')).toBeNull();
});
