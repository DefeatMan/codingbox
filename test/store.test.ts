import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';

test('rooms and session hashes survive restarting storage', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codingbox-store-'));
  let store = new Store(directory);
  try {
    const room = store.createRoom('Persistent', 'go', 60);
    const token = store.session({ kind: 'admin', roomId: null, name: '', expiresAt: Date.now() + 60_000, wedeToken: null });
    store.close(); store = new Store(directory);
    assert.equal(store.byCode(room.code.toLowerCase())?.id, room.id);
    assert.equal(store.getSession(token, 'admin')?.kind, 'admin');
    assert.equal(store.getSession(token, 'room'), undefined);
    store.deleteSession(token); assert.equal(store.getSession(token, 'admin'), undefined);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
