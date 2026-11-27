// @vitest-environment node
import { it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.mjs';
it('persists a recoverable encrypted journal without plaintext credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'updown-journal-'));
  try {
    const store = createStore(dir); const round = { id: 'test', credential: { secretKey: 'sensitive-test-value' } };
    store.save([round]);
    expect(readFileSync(join(dir, 'rounds.enc')).includes(Buffer.from('sensitive-test-value'))).toBe(false);
    expect(createStore(dir).load()).toEqual([round]);
  } finally { rmSync(dir, { recursive: true }); }
});
