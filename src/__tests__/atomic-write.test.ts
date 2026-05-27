import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { atomicWriteSync } from '../util/atomic-write.js';

describe('atomicWriteSync', () => {
  it('writes data and the final file has the requested contents', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'atomic-write-'));
    try {
      const file = path.join(dir, 'config.json');
      atomicWriteSync(file, '{"hello":"world"}');
      assert.equal(readFileSync(file, 'utf8'), '{"hello":"world"}');
      // No tmp leftovers
      const leftovers = readdirSync(dir).filter((n) => n.includes('.tmp.'));
      assert.deepEqual(leftovers, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves the requested file mode on a freshly created file', () => {
    if (process.platform === 'win32') return; // mode bits are not portable
    const dir = mkdtempSync(path.join(tmpdir(), 'atomic-write-'));
    try {
      const file = path.join(dir, 'secret.json');
      atomicWriteSync(file, '{"token":"abc"}', { mode: 0o600 });
      const mode = statSync(file).mode & 0o777;
      assert.equal(mode, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('overwrites an existing file atomically (final contents match latest write)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'atomic-write-'));
    try {
      const file = path.join(dir, 'data.json');
      atomicWriteSync(file, 'first');
      atomicWriteSync(file, 'second');
      assert.equal(readFileSync(file, 'utf8'), 'second');
      const leftovers = readdirSync(dir).filter((n) => n.includes('.tmp.'));
      assert.deepEqual(leftovers, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cleans up the temp file and rethrows when writing to a bad target directory', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'atomic-write-'));
    try {
      const file = path.join(dir, 'nonexistent-subdir', 'data.json');
      assert.throws(() => atomicWriteSync(file, 'oops'));
      // Nothing leaked into the parent dir
      const leftovers = readdirSync(dir).filter((n) => n.includes('.tmp.'));
      assert.deepEqual(leftovers, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
