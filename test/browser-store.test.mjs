import test from 'node:test';
import assert from 'node:assert/strict';
import { FINANCE_SEED, FINANCE_LIMITS, validateFinance } from '../src/finance-schema.mjs';
import { FINANCE_SEED as desktopSeed, validateFinance as validateDesktop } from '../src/finance-data.mjs';
import { BACKUP_SCHEMA, createBrowserFinanceStore, decodeFinanceBackup } from '../src/browser-store.mjs';

test('desktop and browser use the same finance contract and neutral defaults', () => {
  assert.equal(FINANCE_SEED, desktopSeed); assert.equal(validateFinance, validateDesktop);
  const state = structuredClone(FINANCE_SEED); validateFinance(state);
  assert.deepEqual(state.txns, []); assert(Object.values(state.caps).every(amount => amount === 0));
});

test('backup preview accepts full browser backup and raw desktop state without mutating their values', () => {
  const state = structuredClone(FINANCE_SEED); state.settings.checking = 42;
  state.txns.push({ id: 'synthetic', date: '2041-06-01', amt: 3, cat: 'Coffee', who: '', note: 'Example' });
  const raw = JSON.stringify(state);
  assert.deepEqual(decodeFinanceBackup(raw), state);
  assert.deepEqual(decodeFinanceBackup(JSON.stringify({ schema: BACKUP_SCHEMA, exportedAt: '2041-06-01T12:00:00.000Z', state })), state);
  const decoded = decodeFinanceBackup(raw); decoded.settings.checking = 99;
  assert.equal(decodeFinanceBackup(raw).settings.checking, 42);
});

test('backup preview rejects invalid, unsupported, and oversized data before a restore can be offered', () => {
  for (const text of ['{unfinished', '{}', 'null', JSON.stringify({ schema: 'future-format', state: FINANCE_SEED }),
    JSON.stringify({ schema: BACKUP_SCHEMA, state: { ...FINANCE_SEED, txns: [{ id: 'broken' }] } })])
    assert.throws(() => decodeFinanceBackup(text), error => error.code === 'invalid');
  assert.throws(() => decodeFinanceBackup('x'.repeat(FINANCE_LIMITS.storeBytes + 4097)), error => error.code === 'too-large');
  const oversized = { ...structuredClone(FINANCE_SEED), extra: 'x'.repeat(FINANCE_LIMITS.storeBytes) };
  assert.throws(() => decodeFinanceBackup(JSON.stringify(oversized)), error => error.code === 'too-large');
});

test('unavailable or blocked IndexedDB never becomes an in-memory save fallback', async () => {
  await assert.rejects(createBrowserFinanceStore({ indexedDB: null }), error => error.code === 'unavailable');
  await assert.rejects(createBrowserFinanceStore({ indexedDB: { open() { throw new Error('Storage denied'); } } }), /Storage denied/);
  await assert.rejects(createBrowserFinanceStore({ indexedDB: { open() { const request = {}; queueMicrotask(() => request.onblocked()); return request; } } }), error => error.code === 'blocked');
});

test('database names are validated before opening storage', async () => {
  let opened = false;
  const indexedDB = { open() { opened = true; } };
  await assert.rejects(createBrowserFinanceStore({ indexedDB, name: '' }), error => error.code === 'invalid');
  assert.equal(opened, false);
});
