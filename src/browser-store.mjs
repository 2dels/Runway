/** Device-local browser persistence. No requests, account connections, or in-memory save fallback. */
import { FINANCE_SCHEMA, FINANCE_SEED, FINANCE_LIMITS, validateFinance } from './finance-schema.mjs';

export const BROWSER_DATABASE = 'runway-local';
export const BROWSER_RECORD_SCHEMA = 'runway-browser-record/v1';
export const BACKUP_SCHEMA = 'runway-backup/v1';
const STORE = 'finance', CURRENT = 'current', PREVIOUS = 'previous', INITIALIZED = 'initialized';
const BACKUP_BYTES = FINANCE_LIMITS.storeBytes + 4096;
const encoder = new TextEncoder();

export class BrowserFinanceError extends Error {
  constructor(code, message) { super(message); this.name = 'BrowserFinanceError'; this.code = code; }
}
const fail = (code, message) => { throw new BrowserFinanceError(code, message); };
const validRevision = revision => Number.isSafeInteger(revision) && revision >= 1;
function boundedText(text, limit) {
  if (typeof text !== 'string') fail('invalid', 'Choose a JSON Runway backup.');
  if (text.length > limit || encoder.encode(text).byteLength > limit)
    fail('too-large', 'These records exceed Runway’s supported backup size. The saved records are unchanged.');
  return text;
}
function checkedState(input) {
  try {
    const candidate = structuredClone(input);
    validateFinance(candidate);
    const text = boundedText(JSON.stringify(candidate), FINANCE_LIMITS.storeBytes);
    // Keep the stored value JSON-compatible so export and restore reproduce the same records.
    const state = JSON.parse(text); validateFinance(state); return state;
  } catch (error) {
    if (error instanceof BrowserFinanceError) throw error;
    throw new BrowserFinanceError('invalid', `Runway data is invalid. ${error.message || 'The saved records are unchanged.'}`);
  }
}

/** Accept a full Runway backup or the existing desktop finance.json format. */
export function decodeFinanceBackup(text) {
  boundedText(text, BACKUP_BYTES);
  let value;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { fail('invalid', 'That file is not a complete JSON Runway backup.'); }
  if (value?.schema === BACKUP_SCHEMA) return checkedState(value.state);
  if (value?.schema === FINANCE_SCHEMA) return checkedState(value);
  fail('invalid', 'This backup uses an unsupported Runway format.');
}

function inspect(record, hasSavedRecords = false) {
  if (record === undefined && !hasSavedRecords) return { state: structuredClone(FINANCE_SEED), loadError: null, revision: 0 };
  const revision = validRevision(record?.revision) ? record.revision : null;
  try {
    if (!record || record.schema !== BROWSER_RECORD_SCHEMA || revision === null)
      throw new Error('Unsupported local storage record.');
    return { state: checkedState(record.state), loadError: null, revision };
  } catch {
    return { state: null, revision,
      loadError: 'Your saved Runway records could not be read. They have been preserved. Restore a verified backup to replace them explicitly.' };
  }
}
function storageError(error) {
  if (error instanceof BrowserFinanceError) return error;
  if (error?.name === 'QuotaExceededError') return new BrowserFinanceError('quota', 'This browser has no space to save Runway. Your previous records are unchanged. Free space or export a backup before trying again.');
  return new BrowserFinanceError('storage', `Runway could not complete its local storage operation. ${error?.message || 'Your previous records are unchanged.'}`);
}

async function openDatabase(factory, name) {
  if (!factory || typeof factory.open !== 'function') fail('unavailable', 'This browser does not provide IndexedDB storage. Open Runway in a supported browser; nothing can be saved here.');
  if (typeof name !== 'string' || !name.trim() || name.length > 120) fail('invalid', 'Choose a valid Runway database name.');
  return new Promise((resolve, reject) => {
    let request, settled = false;
    const rejectOnce = error => { if (!settled) { settled = true; reject(storageError(error)); } };
    try { request = factory.open(name, 1); } catch (error) { rejectOnce(error); return; }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onerror = () => rejectOnce(request.error);
    request.onblocked = () => rejectOnce(new BrowserFinanceError('blocked', 'Another Runway tab is blocking the storage upgrade. Close other Runway tabs and reopen this one.'));
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) { db.close(); rejectOnce(new BrowserFinanceError('corrupt', 'The Runway database is missing its records store. The database was preserved.')); return; }
      settled = true; resolve(db);
    };
  });
}

/**
 * Read-modify-write uses one IndexedDB transaction and compares the stored revision.
 * Concurrent tabs cannot both overwrite a state they read at the same revision.
 * A write resolves only after IndexedDB commits current and previous together.
 */
export async function createBrowserFinanceStore({ name = BROWSER_DATABASE, indexedDB = globalThis.indexedDB } = {}) {
  const db = await openDatabase(indexedDB, name);
  let closed = false;
  const close = () => { if (!closed) { closed = true; db.close(); } };
  db.onversionchange = close;
  db.onclose = () => { closed = true; };

  function transaction(mode, operation) {
    if (closed) return Promise.reject(new BrowserFinanceError('closed', 'Runway’s database connection closed. Reload the page before saving.'));
    return new Promise((resolve, reject) => {
      let tx, result, failure;
      const abort = error => {
        failure = storageError(error);
        try { tx.abort(); } catch { reject(failure); }
      };
      try {
        tx = mode === 'readwrite' ? db.transaction(STORE, mode, { durability: 'strict' }) : db.transaction(STORE, mode);
        tx.oncomplete = () => resolve(result);
        tx.onerror = event => { if (!failure) failure = storageError(event.target?.error || tx.error); };
        tx.onabort = () => reject(failure || storageError(tx.error));
        const store = tx.objectStore(STORE), request = store.get(CURRENT), keysRequest = store.getAllKeys();
        let completedReads = 0, raw, keys;
        const finishRead = () => {
          if (++completedReads !== 2) return;
          try { result = operation(raw, store, keys.length > 0); }
          catch (error) { abort(error); }
        };
        request.onerror = () => { failure = storageError(request.error); };
        request.onsuccess = () => { raw = request.result; finishRead(); };
        keysRequest.onerror = () => { failure = storageError(keysRequest.error); };
        keysRequest.onsuccess = () => { keys = keysRequest.result; finishRead(); };
      } catch (error) { if (tx) abort(error); else reject(storageError(error)); }
    });
  }

  function write(next, expectedRevision, restore) {
    const state = checkedState(next);
    if (!(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0) && !(restore && expectedRevision === null))
      return Promise.reject(new BrowserFinanceError('conflict', 'Reload your saved Runway records before making this change.'));
    return transaction('readwrite', (record, store, hasSavedRecords) => {
      const previous = inspect(record, hasSavedRecords);
      if (previous.loadError && !restore) fail('corrupt', previous.loadError);
      if (previous.revision !== expectedRevision)
        fail('conflict', 'Runway changed in another tab. Reload the latest records before saving this change.');
      const revision = (previous.revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) fail('full', 'Runway has reached its revision limit. Preserve a backup before continuing.');
      if (record !== undefined) store.put(record, PREVIOUS);
      store.put({ schema: BROWSER_RECORD_SCHEMA, revision, state }, CURRENT);
      store.put(true, INITIALIZED);
      return { state: structuredClone(state), revision, loadError: null };
    });
  }

  return Object.freeze({
    getState: () => transaction('readonly', (record, _store, hasSavedRecords) => inspect(record, hasSavedRecords)),
    save: async (next, expectedRevision) => write(next, expectedRevision, false),
    async exportBackup() {
      const snapshot = await transaction('readonly', (record, _store, hasSavedRecords) => inspect(record, hasSavedRecords));
      if (snapshot.loadError) fail('corrupt', snapshot.loadError);
      return boundedText(JSON.stringify({ schema: BACKUP_SCHEMA, exportedAt: new Date().toISOString(), state: snapshot.state }), BACKUP_BYTES);
    },
    async restoreBackup(text, expectedRevision, { confirmed = false } = {}) {
      if (confirmed !== true) fail('confirmation', 'Confirm replacement of the current Runway records before restoring this backup.');
      return write(decodeFinanceBackup(text), expectedRevision, true);
    },
    close,
  });
}
