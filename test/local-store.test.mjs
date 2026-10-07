import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, mkdir, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalStore } from '../src/local-store.mjs';

const validate = value => { if (!value || !Number.isSafeInteger(value.count) || value.count < 0 || typeof value.note !== 'string') throw new Error('Invalid test state'); };
const empty = { count: 0, note: '' };
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'runway-store-test-'));
  const store = await createLocalStore(directory, 'state.json', empty, validate, 512);
  return { directory, store, filename: path.join(directory, 'state.json') };
}

test('opening a fresh store is read-only and its snapshots cannot mutate saved state', async () => {
  const f = await fixture(); assert.deepEqual(await readdir(f.directory), []);
  f.store.snapshot().value.count = 20; assert.equal(f.store.snapshot().value.count, 0);
  let held;
  await f.store.update(value => { held = value; value.count = 1; return value; }); held.count = 50;
  assert.equal(f.store.snapshot().value.count, 1);
});

test('queued updates all commit, and a rejected update does not poison subsequent work', async () => {
  const f = await fixture();
  await Promise.all(Array.from({ length: 10 }, () => f.store.update(value => ({ ...value, count: value.count + 1 }))));
  await assert.rejects(f.store.update(value => ({ ...value, count: -1 })), /Invalid test state/);
  await f.store.update(value => ({ ...value, count: value.count + 1 })); await f.store.flush();
  assert.equal(f.store.snapshot().value.count, 11); assert.equal(JSON.parse(await readFile(f.filename, 'utf8')).count, 11);
  assert.equal((await readdir(f.directory)).filter(name => name.endsWith('pending')).length, 0);
});

test('two store instances serialize but a stale writer cannot overwrite the first commit', async () => {
  const f = await fixture(); const second = await createLocalStore(f.directory, 'state.json', empty, validate, 512);
  const results = await Promise.allSettled([f.store.update(() => ({ count: 1, note: 'first' })), second.update(() => ({ count: 2, note: 'second' }))]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
  assert.match(results[1].reason.message, /changed outside/); assert.equal(JSON.parse(await readFile(f.filename, 'utf8')).count, 1);
});

test('external file edits are detected without changing either the file or in-memory state', async () => {
  const f = await fixture(); await f.store.update(() => ({ count: 1, note: '' }));
  const external = JSON.stringify({ count: 9, note: 'outside edit' }); await writeFile(f.filename, external);
  await assert.rejects(f.store.update(value => ({ ...value, count: 2 })), /changed outside/);
  assert.equal(await readFile(f.filename, 'utf8'), external); assert.equal(f.store.snapshot().value.count, 1);
});

test('corrupt and malformed UTF-8 files block writes rather than silently reseeding', async () => {
  for (const original of [Buffer.from('{invalid'), Buffer.from([123,34,110,111,116,101,34,58,34,255,34,44,34,99,111,117,110,116,34,58,49,125])]) {
    const f = await fixture(); await writeFile(f.filename, original);
    const store = await createLocalStore(f.directory, 'state.json', empty, validate, 512);
    assert.match(store.snapshot().error, /could not be read/); await assert.rejects(store.update(() => empty), /could not be read/);
    assert.deepEqual(await readFile(f.filename), original);
  }
});

test('file size limits and nonregular backup destinations fail without replacing the current file', async () => {
  const f = await fixture(); await f.store.update(() => ({ count: 1, note: '' })); const original = await readFile(f.filename);
  await assert.rejects(f.store.update(() => ({ count: 2, note: 'x'.repeat(600) })), /is full/);
  await mkdir(path.join(f.directory, 'state.backup.json'));
  await assert.rejects(f.store.update(() => ({ count: 2, note: '' })), /Invalid local file/);
  assert.deepEqual(await readFile(f.filename), original);
  assert.equal((await readdir(f.directory)).filter(name => name.endsWith('pending')).length, 0);
});

test('hard-linked stores are rejected and prior-save backup retains exact original bytes', async () => {
  const f = await fixture(); await f.store.update(() => ({ count: 1, note: 'first' })); const first = await readFile(f.filename);
  await f.store.update(() => ({ count: 2, note: 'second' }));
  assert.deepEqual(await readFile(path.join(f.directory, 'state.backup.json')), first);
  await link(f.filename, path.join(f.directory, 'alias.json'));
  const linked = await createLocalStore(f.directory, 'state.json', empty, validate, 512);
  assert.match(linked.snapshot().error, /could not be read/); await assert.rejects(linked.update(() => empty));
});

test('explicit directory and safe filename are required by the reusable store API', async () => {
  const f = await fixture();
  for (const name of ['../outside.json', '/outside.json', 'nested/state.json', 'state', '..'])
    await assert.rejects(createLocalStore(f.directory, name, empty, validate), /JSON filename/);
  await assert.rejects(createLocalStore('', 'state.json', empty, validate), /local directory/);
});
