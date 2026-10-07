/** Runway: a reusable local financial planning store. The caller explicitly owns its data directory. */
import { lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createLocalStore } from './local-store.mjs';

import { FINANCE_LIMITS, FINANCE_SEED, validateFinance, isDate, isTimestamp, isMoney, isText,
  isLedgerText, isPlain, canonical, check, emptyMonarch, validateAccounts, validateRecurring } from './finance-schema.mjs';
export { FINANCE_SCHEMA, FINANCE_LIMITS, FINANCE_SEED, validateFinance } from './finance-schema.mjs';
export function mapCategory(monarchCategory, merchant) {
  const text = `${monarchCategory || ''} ${merchant || ''}`.toLowerCase();
  // A utility's gas bill is not vehicle fuel; source categories outrank broad merchant guesses.
  if (/gas & electric|utilities|internet & cable|phone|water/.test(String(monarchCategory || '').toLowerCase())) return 'Other';
  if (/coffee|cafe|starbucks|coffy/.test(text)) return 'Coffee';
  if (/uber eats|doordash|grubhub|restaurant|dining|food & drink|\bbars?\b|takeout|delivery/.test(text)) return 'Delivery & dining';
  if (/grocer|erewhon|gelson|lassens|market|trader|whole foods/.test(text)) return 'Groceries';
  if (/\bgas\b|fuel|shell|arco|chevron|\b76\b|\bcar\b|auto|parking|uber trip|lyft|ride/.test(text)) return 'Gas & car';
  if (/subscription|netflix|spotify|hbo|prime|openai|chatgpt|midjourney|adobe|dropbox|onedrive|streaming|membership|software/.test(text)) return 'Subscriptions';
  if (/amazon|shopping|clothing|etsy|ebay|ikea|target/.test(text)) return 'Shopping';
  return 'Other';
}

export function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } } else field += c; }
    else if (c === '"') { if (field || closed) throw new Error('The CSV has a quote outside a quoted field.'); quoted = true; }
    else if (c === ',') { row.push(field); field = ''; closed = false; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; closed = false; }
    else { if (closed) throw new Error('The CSV has text after a quoted field.'); field += c; }
  }
  if (quoted) throw new Error('The CSV has an unfinished quoted field.');
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(cell => cell.trim()));
}

function csvDate(input) {
  let date = String(input || '').trim();
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(date);
  if (slash) date = `${slash[3].length === 2 ? `20${slash[3]}` : slash[3]}-${slash[1].padStart(2, '0')}-${slash[2].padStart(2, '0')}`;
  return isDate(date) ? date : null;
}
function csvAmount(input) {
  let text = String(input ?? '').trim(), negative = false;
  if (text.startsWith('(') && text.endsWith(')')) { negative = true; text = text.slice(1, -1).trim(); }
  text = text.replace(/^\$([+-])/, '$1$');
  const match = /^([+-]?)\$?(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match || negative && match[1]) return null;
  const cents = Number(match[2].replaceAll(',', '')) * 100 + Number((match[3] || '').padEnd(2, '0'));
  const value = (negative || match[1] === '-' ? -cents : cents) / 100;
  return isMoney(value) ? value : null;
}
function csvTable(text) {
  const rows = parseCsv(text.replace(/^\uFEFF/, ''));
  if (rows.length < 2) throw new Error('That file has no transactions or balances in it.');
  const header = rows[0].map(cell => cell.trim().toLowerCase());
  if (new Set(header).size !== header.length) throw new Error('The CSV has duplicate column names.');
  return { rows: rows.slice(1), header };
}
const identity = values => createHash('sha256').update(JSON.stringify(values)).digest('hex');
function classification(t) {
  const category = canonical(t.category), description = `${t.merchant} ${t.originalStatement}`.toLowerCase();
  if (/\b(?:credit card payment|loan repayment|debt payment|mortgage payment)\b/.test(category)
    || /\b(?:payment thank you|payment received|autopay payment|automatic payment thank you|banking payment to credit card)\b/.test(description)) return 'payment';
  if (/\b(?:transfer|balance adjustment|cash & atm)\b/.test(category)
    || /\b(?:mobile|internet|online) banking transfer\b|\b(?:od|overdraft) protection transfer\b|\btransfer (?:from|to) acct\b/.test(description)) return 'transfer';
  if (/\b(?:income|paychecks?|payroll|salary|wages|dividends?|interest earned)\b/.test(category)
    || t.amount > 0 && (/\binterest paid this period\b/.test(description)
      || category === 'financial fees' && /\b(?:mobile check deposit|deposit)\b/.test(description)
      || !category || category === 'uncategorized')) return 'income';
  return t.amount > 0 ? 'refund' : 'expense';
}
function capExclusion(t) {
  if (!['expense', 'refund'].includes(t.kind)) return t.kind;
  if (/\b(?:rent|mortgage|loan|debt|interest|financial fees|finance charge)\b/i.test(t.category)
    || /\b(?:purchase interest|interest charge|balance transfer interest|deferred interest)\b/i.test(`${t.merchant} ${t.originalStatement}`)) return 'fixedExpense';
  return null;
}
function coverage(transactions) {
  const dates = transactions.map(t => t.date).sort();
  return { from: dates[0] || null, to: dates.at(-1) || null, count: transactions.length };
}

/** Preserve the full signed ledger; cap purchases are a separate projection. */
export function monarchTransactions(text) {
  const { rows, header } = csvTable(text);
  const column = name => header.findIndex(cell => cell === name);
  const iDate = column('date'), iMerchant = column('merchant') >= 0 ? column('merchant') : column('description'),
    iCategory = column('category'), iAccount = column('account'), iAmount = column('amount');
  if (iDate < 0 || iAmount < 0) throw new Error('This does not look like a Monarch export. It needs Date and Amount columns.');
  const transactions = [], purchases = [], seen = new Map(), sourceRows = new Map(), skippedReasons = {};
  let invalid = 0;
  const skip = (reason, bad = false) => { skippedReasons[reason] = (skippedReasons[reason] || 0) + 1; if (bad) invalid++; };
  const iId = column('id') >= 0 ? column('id') : column('transaction id');
  for (const row of rows) {
    if (row.length > header.length || row.length <= Math.max(iDate, iAmount)) { skip('invalidRow', true); continue; }
    const date = csvDate(row[iDate]);
    if (!date) { skip('invalidDate', true); continue; }
    const amount = csvAmount(row[iAmount]);
    if (amount === null) { skip('invalidAmount', true); continue; }
    const cell = index => String(row[index] || '').trim();
    const t = { date, amount, merchant: cell(iMerchant), category: cell(iCategory), account: cell(iAccount),
      notes: cell(column('notes')), originalStatement: cell(column('original statement')), tags: cell(column('tags')) };
    if (iId >= 0 && cell(iId)) t.sourceId = cell(iId);
    if (column('owner') >= 0) t.owner = cell(column('owner'));
    if (column('reviewed') >= 0) t.reviewed = cell(column('reviewed'));
    if (Object.values(t).some(value => typeof value === 'string' && !isLedgerText(value))) { skip('textTooLong', true); continue; }
    const base = t.sourceId ? `monarch:id:${identity([t.sourceId])}`
      : `monarch:row:${identity([date, amount, canonical(t.account), canonical(t.merchant)])}`;
    const n = (seen.get(base) || 0) + 1; seen.set(base, n);
    t.id = !t.sourceId && n > 1 ? `${base}#${n}` : base;
    t.kind = classification(t);
    const reason = capExclusion(t);
    t.capCategory = reason ? null : mapCategory(t.category, t.merchant);
    if (t.sourceId) {
      const representation = JSON.stringify(t);
      if (sourceRows.has(t.id) && sourceRows.get(t.id) !== representation) throw new Error('The CSV contains conflicting rows with the same Monarch transaction ID. Nothing was changed.');
      sourceRows.set(t.id, representation);
    }
    transactions.push(t);
    if (reason) skip(reason);
    else purchases.push({ id: t.id, date, amt: -amount, cat: t.capCategory, who: t.account.slice(0, 120), note: t.merchant.slice(0, 120) });
  }
  return { transactions, purchases, skipped: rows.length - purchases.length, invalid, skippedReasons,
    coverage: coverage(transactions), total: rows.length };
}

/** Compatibility export used by the original Runway importer. */
export const monarchPurchases = monarchTransactions;

function accountType(name, balance, previous) {
  if (previous) return previous;
  if (/checking|cash management|debit/i.test(name)) return 'checking';
  if (/savings?|saver/i.test(name)) return 'savings';
  if (balance < 0 || /credit|card|visa|mastercard|amex/i.test(name)) return 'credit';
  return 'other';
}
export function monarchBalances(text, existing = []) {
  const { rows, header } = csvTable(text), di = header.indexOf('date'), bi = header.indexOf('balance'), ai = header.indexOf('account');
  if (di < 0 || bi < 0 || ai < 0) throw new Error('A Monarch balances export needs Date, Balance and Account columns.');
  const accounts = new Map(), dates = [], skippedReasons = {}; let invalid = 0;
  const skip = reason => { invalid++; skippedReasons[reason] = (skippedReasons[reason] || 0) + 1; };
  for (const row of rows) {
    if (row.length > header.length || row.length <= Math.max(di, bi, ai)) { skip('invalidRow'); continue; }
    const date = csvDate(row[di]), balance = csvAmount(row[bi]), name = String(row[ai] || '').trim();
    if (!date) { skip('invalidDate'); continue; }
    if (balance === null) { skip('invalidAmount'); continue; }
    if (!isText(name, false) || !name) { skip('invalidAccount'); continue; }
    dates.push({ date });
    const key = canonical(name), previous = existing.find(a => canonical(a.name) === key);
    const type = accountType(name, balance, previous?.type);
    const account = { name, type, balance: type === 'credit' ? -balance : balance, asOf: date };
    if (!accounts.has(key) || accounts.get(key).asOf <= date) accounts.set(key, account);
  }
  return { accounts: [...accounts.values()], invalid, skippedReasons, coverage: coverage(dates), total: rows.length };
}
function mergeAccounts(monarch, accounts) {
  let updated = 0;
  for (const next of accounts) {
    const index = monarch.accounts.findIndex(a => canonical(a.name) === canonical(next.name));
    if (index >= 0 && monarch.accounts[index].asOf > next.asOf) continue;
    const merged = { ...(index >= 0 ? monarch.accounts[index] : {}), ...next };
    if (index >= 0 && next.asOf !== monarch.accounts[index].asOf && next.sourceUpdated === undefined) delete merged.sourceUpdated;
    if (index < 0) { monarch.accounts.push(merged); updated++; }
    else if (JSON.stringify(monarch.accounts[index]) !== JSON.stringify(merged)) { monarch.accounts[index] = merged; updated++; }
  }
  return updated;
}
async function readImport(filename, limit, label) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error(`Choose a ${label} under ${limit / 1024 / 1024} MB.`);
  const bytes = await readFile(filename);
  if (bytes.length > limit) throw new Error(`The ${label} became too large while reading it.`);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
const legacyKey = t => JSON.stringify([t.date, t.amt, canonical(t.who), canonical(t.note)]);

export async function createFinanceStore(directory) {
  const store = await createLocalStore(directory, 'finance.json', FINANCE_SEED, validateFinance, FINANCE_LIMITS.storeBytes);
  return {
    snapshot() { const { value, error } = store.snapshot(); return { state: value, loadError: error }; },
    flush: store.flush,
    save(next, guard = () => {}) { return store.update(() => { guard(); return validateFinance(structuredClone(next)); }); },
    async importMonarch(filename, guard = () => {}) {
      const text = await readImport(filename, FINANCE_LIMITS.csvBytes, 'Monarch CSV');
      const { header } = csvTable(text);
      const balances = header.includes('balance') && !header.includes('amount');
      const parsed = balances ? monarchBalances(text, store.snapshot().value.monarch?.accounts || []) : monarchTransactions(text);
      if (!parsed.coverage.count) throw new Error('That export has no valid rows. Check its dates and amounts; nothing was changed.');
      let added = 0, ledgerAdded = 0, ledgerUpdated = 0, purchasesUpdated = 0, purchasesRemoved = 0, accountsUpdated = 0;
      const state = await store.update(current => {
        guard();
        const monarch = current.monarch ||= emptyMonarch();
        if (balances) accountsUpdated = mergeAccounts(monarch, parsed.accounts);
        else {
          const previous = new Map(monarch.transactions.map(t => [t.id, t]));
          const ledgerIndices = new Map(monarch.transactions.map((t, index) => [t.id, index]));
          for (const txn of parsed.transactions) {
            const index = ledgerIndices.get(txn.id);
            if (index === undefined) { ledgerIndices.set(txn.id, monarch.transactions.length); monarch.transactions.push(txn); ledgerAdded++; }
            else if (JSON.stringify(monarch.transactions[index]) !== JSON.stringify(txn)) { monarch.transactions[index] = txn; ledgerUpdated++; }
          }
          const incoming = new Map(parsed.transactions.map(t => [t.id, t]));
          const excludedCaps = new Set(monarch.excludedCaps || []);
          current.txns = current.txns.filter(t => {
            const id = t.monarchId || t.id;
            if (excludedCaps.has(id) || previous.has(id) && incoming.has(id) && incoming.get(id).capCategory === null) { purchasesRemoved++; return false; }
            return true;
          });
          const ids = new Set(current.txns.flatMap(t => [t.id, t.monarchId].filter(Boolean)));
          const capRecords = new Map(current.txns.map(t => [t.monarchId || t.id, t]));
          const legacy = new Map();
          for (const t of current.txns) if (t.id.startsWith('m:') && !t.monarchId) {
            const key = legacyKey(t); if (!legacy.has(key)) legacy.set(key, []); legacy.get(key).push(t);
          }
          for (const purchase of parsed.purchases) {
            if (excludedCaps.has(purchase.id)) continue;
            if (ids.has(purchase.id)) {
              const cap = capRecords.get(purchase.id), prior = previous.get(purchase.id);
              if (cap && prior) {
                const before = JSON.stringify(cap);
                // Refresh source-derived values; retain categories/notes the user changed in Runway.
                if (cap.amt === -prior.amount) cap.amt = purchase.amt;
                if (cap.cat === prior.capCategory) cap.cat = purchase.cat;
                if (cap.note === prior.merchant.slice(0, 120)) cap.note = purchase.note;
                if (cap.who === prior.account.slice(0, 120)) cap.who = purchase.who;
                if (cap.date === prior.date) cap.date = purchase.date;
                if (JSON.stringify(cap) !== before) purchasesUpdated++;
              }
              continue;
            }
            const old = legacy.get(legacyKey(purchase))?.shift();
            if (old) { old.monarchId = purchase.id; capRecords.set(purchase.id, old); } // preserve prior categories, manual notes and original IDs
            else { current.txns.push(purchase); capRecords.set(purchase.id, purchase); added++; }
            ids.add(purchase.id);
          }
        }
        monarch.imports.push({ date: new Date().toISOString(), from: parsed.coverage.from, to: parsed.coverage.to,
          source: path.basename(filename).slice(0, FINANCE_LIMITS.text), total: parsed.total, valid: parsed.coverage.count,
          added: ledgerAdded, duplicates: balances ? 0 : parsed.transactions.length - ledgerAdded,
          purchasesAdded: added, invalid: parsed.invalid, type: balances ? 'balances' : 'transactions', accountsUpdated,
          updated: ledgerUpdated, purchasesUpdated, purchasesRemoved });
        monarch.imports = monarch.imports.slice(-FINANCE_LIMITS.imports);
        return current;
      });
      return { state, added, duplicates: balances ? 0 : parsed.purchases.length - added,
        skipped: balances ? parsed.invalid : parsed.skipped, ledgerAdded,
        ledgerDuplicates: balances ? 0 : parsed.transactions.length - ledgerAdded, invalid: parsed.invalid,
        skippedReasons: parsed.skippedReasons, coverage: parsed.coverage, accountsUpdated, ledgerUpdated, purchasesUpdated, purchasesRemoved,
        importType: balances ? 'balances' : 'transactions' };
    },
    async importMonarchSnapshot(filename, guard = () => {}) {
      let snapshot;
      try { snapshot = JSON.parse(await readImport(filename, FINANCE_LIMITS.snapshotBytes, 'Monarch snapshot JSON')); }
      catch (error) { throw new Error(`Could not read the Monarch snapshot: ${error.message}`); }
      check(isPlain(snapshot) && ['accounts', 'recurring', 'observedAt', 'notes'].some(key => Object.hasOwn(snapshot, key)), 'Monarch snapshot');
      if (snapshot.accounts !== undefined) validateAccounts(snapshot.accounts);
      if (snapshot.recurring !== undefined) validateRecurring(snapshot.recurring);
      check(snapshot.observedAt === undefined || isTimestamp(snapshot.observedAt), 'Monarch observation date');
      check(snapshot.notes === undefined || isLedgerText(snapshot.notes), 'Monarch notes');
      let accountsUpdated = 0, recurringUpdated = 0;
      const state = await store.update(current => {
        guard();
        const monarch = current.monarch ||= emptyMonarch();
        if (snapshot.accounts) accountsUpdated = mergeAccounts(monarch, snapshot.accounts);
        for (const next of snapshot.recurring || []) {
          const index = monarch.recurring.findIndex(r => canonical(r.name) === canonical(next.name) && canonical(r.account) === canonical(next.account));
          const merged = { ...(index >= 0 ? monarch.recurring[index] : {}), ...next };
          if (index < 0) { monarch.recurring.push(merged); recurringUpdated++; }
          else if (JSON.stringify(monarch.recurring[index]) !== JSON.stringify(merged)) { monarch.recurring[index] = merged; recurringUpdated++; }
        }
        if (snapshot.observedAt !== undefined && (!monarch.observedAt || snapshot.observedAt >= monarch.observedAt)) monarch.observedAt = snapshot.observedAt;
        if (snapshot.notes !== undefined) monarch.notes = snapshot.notes;
        return current;
      });
      return { state, accountsUpdated, recurringUpdated };
    },
  };
}
