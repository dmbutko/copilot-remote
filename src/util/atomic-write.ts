import { renameSync, rmSync, writeFileSync, type WriteFileOptions } from 'node:fs';

/**
 * Write `data` to `filePath` atomically: write to a sibling temp file, then `rename` into place.
 * On the same filesystem, `rename(2)` is atomic — readers see either the old contents or the new
 * contents, never a partially-written truncated file.
 *
 * If `writeFileSync` throws (disk full, permission, etc.), the temp file is cleaned up.
 *
 * `opts` is forwarded to `writeFileSync` so callers can preserve file mode (e.g. `{ mode: 0o600 }`
 * for secrets) and encoding.
 */
export function atomicWriteSync(filePath: string, data: string | Uint8Array, opts?: WriteFileOptions): void {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, data, opts);
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}
