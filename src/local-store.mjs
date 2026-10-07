/** Explicit-directory local stores. Invalid reads and outside edits never become empty saves. */
import { mkdir, lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const writers = new Map();
function serialized(filename, operation) {
  const key = process.platform === 'win32' ? filename.toLowerCase() : filename;
  const result = (writers.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  writers.set(key, result);
  const remove = () => { if (writers.get(key) === result) writers.delete(key); };
  result.then(remove, remove);
  return result;
}

export async function createLocalStore(directory, name, initial, validate, maxBytes = 8_000_000) {
  if (typeof directory !== 'string' || !directory.trim() || typeof name !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(name) || typeof validate !== 'function'
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Choose a local directory, a JSON filename, and a supported file size.');
  const absolute = path.resolve(directory), filename = path.join(absolute, name);
  const backup = path.join(absolute, name.replace(/\.json$/, '.backup.json'));
  let value = structuredClone(initial), previous = null, error = null, queue = Promise.resolve();
  validate(value);
  async function read(file = filename) {
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > maxBytes) throw new Error('Invalid local file.');
      const bytes = await readFile(file);
      if (bytes.length > maxBytes) throw new Error('Local file too large.');
      return bytes;
    } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  }
  const same = bytes => bytes === null ? previous === null : previous !== null && bytes.equals(previous);
  await serialized(filename, async () => {
    try {
      previous = await read();
      if (previous !== null) { const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(previous)); validate(decoded); value = decoded; }
    } catch { error = `${name} could not be read. The original is preserved. Repair it and reopen Runway before saving.`; }
  });
  async function stage(bytes, suffix) {
    const temporary = path.join(absolute, `${name}.${randomUUID()}.${suffix}`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); }
    catch (error) { await file.close(); await unlink(temporary).catch(() => {}); throw error; }
    await file.close(); return temporary;
  }
  return Object.freeze({
    snapshot: () => ({ value: structuredClone(value), error }),
    flush: () => queue,
    update(change) {
      const result = serialized(filename, async () => {
        if (error) throw new Error(error);
        if (typeof change !== 'function') throw new TypeError('A store update function is required.');
        const next = change(structuredClone(value)); validate(next);
        const bytes = Buffer.from(JSON.stringify(next, null, 2) + '\n');
        if (bytes.length > maxBytes) throw new Error(`${name} is full. Preserve the file before starting a new history.`);
        let temporary, backupTemporary;
        try {
          await mkdir(absolute, { recursive: true });
          if (!same(await read())) throw new Error(`${name} changed outside this Runway instance. Reopen before saving.`);
          temporary = await stage(bytes, 'pending');
          if (previous !== null) {
            await read(backup); // Never replace a linked or malformed destination.
            backupTemporary = await stage(previous, 'backup-pending');
          }
          if (!same(await read())) throw new Error(`${name} changed outside this Runway instance. Reopen before saving.`);
          if (backupTemporary) { await rename(backupTemporary, backup); backupTemporary = null; }
          await rename(temporary, filename); temporary = null;
          value = structuredClone(next); previous = bytes;
          return structuredClone(value);
        } finally {
          if (temporary) await unlink(temporary).catch(() => {});
          if (backupTemporary) await unlink(backupTemporary).catch(() => {});
        }
      });
      queue = result.catch(() => {});
      return result;
    },
  });
}
