import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FINANCE_SEED, createFinanceStore, validateFinance, parseCsv, monarchTransactions, monarchPurchases,
  monarchBalances, mapCategory } from '../src/finance-data.mjs';

// All examples are invented. No personal finance exports or captured accounts are fixtures.
const header = ['Date', 'Merchant', 'Category', 'Account', 'Original Statement', 'Notes', 'Amount', 'Tags', 'Id'];
const csv = rows => [header, ...rows].map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n');
const row = (id, amount = '-12.34', extra = {}) => [extra.date ?? '2041-06-01', extra.merchant ?? 'Sample Cafe',
  extra.category ?? 'Coffee Shops', extra.account ?? 'Card A', extra.statement ?? '', extra.note ?? '', amount, extra.tags ?? '', id];
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'runway-test-'));
  const store = await createFinanceStore(directory);
  const file = path.join(directory, 'synthetic.csv');
  return { directory, store, file, snapshotFile: path.join(directory, 'synthetic-snapshot.json') };
}
const bytes = f => readFile(path.join(f.directory, 'finance.json'));

test('fresh Runway starts blank with zero money and immutable neutral defaults', async () => {
  const { store } = await fixture(); const state = store.snapshot().state;
  assert.equal(store.snapshot().loadError, null); validateFinance(state);
  for (const key of ['checking', 'buffer', 'payAmt', 'rent']) assert.equal(state.settings[key], 0);
  assert.deepEqual(state.settings.payDays, []);
  for (const key of ['checkingAsOf', 'startDate', 'goalDate']) assert.equal(state.settings[key], '2000-01-01');
  for (const key of ['bills', 'deadlines', 'cards', 'txns', 'cancelled']) assert.deepEqual(state[key], []);
  assert.deepEqual(state.parents, { owed: 0, paid: 0 }); assert(Object.values(state.caps).every(cap => cap === 0));
  assert.throws(() => { FINANCE_SEED.settings.checking = 1; }, TypeError);
  state.settings.checking = 55; assert.equal(store.snapshot().state.settings.checking, 0);
});

test('save/reopen preserves entered values and the exact prior backup; bad data cannot replace them', async () => {
  const f = await fixture(); const state = f.store.snapshot().state;
  state.settings.checking = 55.5; await f.store.save(state); const original = await bytes(f);
  state.settings.checking = 61; await f.store.save(state);
  assert.deepEqual(await readFile(path.join(f.directory, 'finance.backup.json')), original);
  const reopened = await createFinanceStore(f.directory); assert.equal(reopened.snapshot().state.settings.checking, 61);
  const before = await bytes(f); state.bills = [{ id: 'incomplete' }];
  await assert.rejects(f.store.save(state), /bills/); assert.deepEqual(await bytes(f), before);
});

test('CSV quoting preserves commas, escaped quotes and newlines while rejecting malformed tables', () => {
  assert.deepEqual(parseCsv('name,note\r\n"Sample, A","say ""hello""\nthen stop"\r\n'),
    [['name', 'note'], ['Sample, A', 'say "hello"\nthen stop']]);
  for (const malformed of ['a,b\n"unfinished,x', 'a,b\nx"q,y', 'a,b\n"x"tail,y']) assert.throws(() => parseCsv(malformed), /CSV/);
  assert.throws(() => monarchTransactions('Date,Amount,Date\n2041-06-01,-1,2041-06-01'), /duplicate column/);
  assert.throws(() => monarchTransactions('Date,Merchant\n2041-06-01,Shop'), /Date and Amount/);
});

test('full ledger keeps signs while spending caps include purchases/refunds and exclude income/transfers/payments', () => {
  const data = csv([row('p'), row('r', '2.34'), row('i', '800', { category: 'Paychecks', merchant: 'Example employer' }),
    row('t', '-50', { category: 'Transfer' }), row('c', '-20', { category: 'Credit Card Payment' }),
    row('h', '-100', { category: 'Rent', merchant: 'Example housing' })]);
  const parsed = monarchTransactions(data);
  assert.deepEqual(parsed.transactions.map(item => item.kind), ['expense', 'refund', 'income', 'transfer', 'payment', 'expense']);
  assert.deepEqual(parsed.purchases.map(item => item.amt), [12.34, -2.34]);
  assert.equal(parsed.purchases.reduce((sum, item) => sum + item.amt, 0), 10);
  assert.deepEqual(parsed.skippedReasons, { income: 1, transfer: 1, payment: 1, fixedExpense: 1 });
  assert.deepEqual(monarchPurchases(data), parsed);
});

test('import preserves repeated purchases but is idempotent across overlapping CSVs', async () => {
  const f = await fixture();
  await writeFile(f.file, csv([row('', '-4'), row('', '-4'), row('named', '-7')]));
  const first = await f.store.importMonarch(f.file); assert.equal(first.added, 3); assert.equal(first.ledgerAdded, 3);
  assert.equal(new Set(first.state.txns.map(item => item.id)).size, 3);
  const again = await f.store.importMonarch(f.file); assert.equal(again.added, 0); assert.equal(again.ledgerAdded, 0);
  assert.equal(again.state.txns.length, 3); assert.equal(again.state.monarch.transactions.length, 3);
  assert.equal(again.state.settings.checking, 0);
});

test('source-ID corrections refresh source values and retain manual edits', async () => {
  const f = await fixture(); await writeFile(f.file, csv([row('one')]));
  const first = await f.store.importMonarch(f.file); first.state.txns[0].cat = 'Other'; first.state.txns[0].note = 'My edited note';
  await f.store.save(first.state);
  await writeFile(f.file, csv([row('one', '-18', { merchant: 'Corrected shop', category: 'Shopping', date: '2041-06-02' })]));
  const next = await f.store.importMonarch(f.file);
  assert.equal(next.ledgerAdded, 0); assert.equal(next.ledgerUpdated, 1); assert.equal(next.purchasesUpdated, 1);
  assert.equal(next.state.txns.length, 1); assert.equal(next.state.txns[0].amt, 18);
  assert.equal(next.state.txns[0].date, '2041-06-02'); assert.equal(next.state.txns[0].cat, 'Other');
  assert.equal(next.state.txns[0].note, 'My edited note');
});

test('reclassified payments and explicit cap exclusions remove spending projections without losing ledger data', async () => {
  const f = await fixture(); await writeFile(f.file, csv([row('one'), row('two')]));
  const first = await f.store.importMonarch(f.file); first.state.monarch.excludedCaps = [first.state.monarch.transactions[1].id];
  await f.store.save(first.state);
  await writeFile(f.file, csv([row('one', '-12.34', { category: 'Credit Card Payment' }), row('two', '-9')]));
  const changed = await f.store.importMonarch(f.file);
  assert.equal(changed.state.txns.length, 0); assert.equal(changed.state.monarch.transactions.length, 2);
  await writeFile(f.file, csv([row('two', '-15')]));
  const again = await f.store.importMonarch(f.file); assert.equal(again.state.txns.length, 0);
  assert.equal(again.state.monarch.transactions.find(item => item.sourceId === 'two').amount, -15);
});

test('conflicting duplicate source IDs fail atomically', async () => {
  const f = await fixture(); await f.store.save(f.store.snapshot().state); const before = await bytes(f);
  await writeFile(f.file, csv([row('same', '-3'), row('same', '-4')]));
  await assert.rejects(f.store.importMonarch(f.file), /conflicting rows/); assert.deepEqual(await bytes(f), before);
});

test('legacy matching preserves prior manual categories and distinguishes accounts from new purchases', async () => {
  const f = await fixture(); const state = f.store.snapshot().state;
  state.txns = [
    { id: 'm:legacy', date: '2041-06-01', amt: 12.34, cat: 'Other', who: 'Card A', note: 'Sample Cafe' },
    { id: 'manual-one', date: '2041-06-01', amt: 12.34, cat: 'Coffee', who: 'Card B', note: 'Sample Cafe' },
  ];
  await f.store.save(state); await writeFile(f.file, csv([row('source-one')]));
  const imported = await f.store.importMonarch(f.file);
  assert.equal(imported.added, 0); assert.equal(imported.state.txns.length, 2);
  assert.equal(imported.state.txns[0].id, 'm:legacy'); assert.equal(imported.state.txns[0].cat, 'Other');
  assert(imported.state.txns[0].monarchId); assert.equal(imported.state.txns[1].monarchId, undefined);
});

test('dates and monetary strings are parsed strictly; invalid rows are counted rather than coerced', () => {
  const parsed = monarchTransactions(csv([row('a', '($1,234.50)'), row('b', '+$2.00'), row('c', '-1.234'),
    row('d', '12 dollars'), row('e', '-1', { date: '2041-02-29' }), row('f', '-1', { date: '2041-13-01' })]));
  assert.deepEqual(parsed.transactions.map(item => item.amount), [-1234.5, 2]); assert.equal(parsed.invalid, 4);
  assert.equal(mapCategory('Utilities', 'Gas utility'), 'Other'); assert.equal(mapCategory('Groceries', 'Sample market'), 'Groceries');
});

test('balance CSV uses latest account observations and preserves credit sign semantics', async () => {
  const f = await fixture();
  await writeFile(f.file, 'Date,Account,Balance\n2041-06-01,Checking A,40\n2041-06-02,Checking A,50\n2041-06-02,Credit card A,-25\n');
  const imported = await f.store.importMonarch(f.file);
  assert.equal(imported.importType, 'balances'); assert.equal(imported.accountsUpdated, 2);
  assert.equal(imported.state.monarch.accounts.find(account => account.name === 'Checking A').balance, 50);
  assert.equal(imported.state.monarch.accounts.find(account => account.type === 'credit').balance, 25);
  assert.equal(imported.state.settings.checking, 0); assert.deepEqual(imported.state.cards, []);
  const credit = monarchBalances('Date,Account,Balance\n2041-06-03,Credit card A,5\n');
  assert.equal(credit.accounts[0].balance, -5);
});

test('snapshot import merges only supplied fields, preserves unrelated data, and ignores older balances', async () => {
  const f = await fixture(); await writeFile(f.file, csv([row('one')])); const baseline = await f.store.importMonarch(f.file);
  await writeFile(f.snapshotFile, JSON.stringify({ observedAt: '2041-06-02', notes: 'Synthetic snapshot.',
    accounts: [{ name: 'Checking A', type: 'checking', balance: 75, asOf: '2041-06-02', sourceUpdated: '1 hour ago' }],
    recurring: [{ name: 'Example service', amount: -8, frequency: 'monthly', account: 'Card A', status: 'suggested' }] }));
  const imported = await f.store.importMonarchSnapshot(f.snapshotFile);
  assert.equal(imported.accountsUpdated, 1); assert.equal(imported.recurringUpdated, 1);
  for (const key of ['settings', 'bills', 'deadlines', 'cards', 'parents', 'txns']) assert.deepEqual(imported.state[key], baseline.state[key]);
  await writeFile(f.snapshotFile, JSON.stringify({ accounts: [{ name: 'Checking A', type: 'checking', balance: 2, asOf: '2041-06-01' }] }));
  const older = await f.store.importMonarchSnapshot(f.snapshotFile); assert.equal(older.state.monarch.accounts[0].balance, 75);
  await writeFile(f.snapshotFile, JSON.stringify({ accounts: [{ name: 'Checking A', type: 'checking', balance: 80, asOf: '2041-06-03' }] }));
  const newer = await f.store.importMonarchSnapshot(f.snapshotFile); assert.equal(newer.state.monarch.accounts[0].sourceUpdated, undefined);
  assert.deepEqual(newer.state.monarch.recurring, imported.state.monarch.recurring);
});

test('invalid imports, malformed UTF-8, and unsupported snapshots preserve saved bytes', async () => {
  const f = await fixture(); await f.store.save(f.store.snapshot().state); const before = await bytes(f);
  await writeFile(f.file, 'Date,Amount\n2041-02-30,-1\n2041-06-01,invalid');
  await assert.rejects(f.store.importMonarch(f.file), /no valid rows/);
  await writeFile(f.file, Buffer.from([0xff, 0xfe])); await assert.rejects(f.store.importMonarch(f.file));
  await writeFile(f.snapshotFile, JSON.stringify({ settings: { checking: 99 } })); await assert.rejects(f.store.importMonarchSnapshot(f.snapshotFile), /Monarch snapshot/);
  await writeFile(f.snapshotFile, JSON.stringify({ accounts: [{ name: 'A', type: 'checking', balance: 1, asOf: '2041-02-30' }] }));
  await assert.rejects(f.store.importMonarchSnapshot(f.snapshotFile), /accounts/); assert.deepEqual(await bytes(f), before);
});

test('validation rejects duplicate IDs, impossible dates, negative caps, and duplicate paydays', () => {
  const state = structuredClone(FINANCE_SEED);
  state.bills.push({ id: 'bill-a', date: '2041-06-01', name: 'Example bill', amt: 10, paid: false }); validateFinance(state);
  for (const change of [value => value.bills.push({ ...value.bills[0] }), value => { value.bills[0].id = ' '; },
    value => { value.settings.startDate = '2041-02-30'; }, value => { value.settings.payDays = [5, 5]; },
    value => { value.caps.Other = -1; }, value => { value.bills[0].checkingAdjustedOn = '2041-02-30'; }]) {
    const invalid = structuredClone(state); change(invalid); assert.throws(() => validateFinance(invalid), /Runway save rejected/);
  }
  const cards = structuredClone(FINANCE_SEED);
  cards.cards = [{ name: 'Example Card', apr: 12, limit: 100, bal: 20 }, { name: ' example card ', apr: 10, limit: 50, bal: 5 }];
  assert.throws(() => validateFinance(cards), /duplicate cards/);
});

test('queued write guards abort saves and imports after a window loses authorization', async () => {
  const f = await fixture(); await f.store.save(f.store.snapshot().state); const original = await bytes(f);
  const guard = () => { throw new Error('The selected window is no longer active.'); };
  const next = f.store.snapshot().state; next.settings.checking = 10;
  await assert.rejects(f.store.save(next, guard), /no longer active/);
  await writeFile(f.file, csv([row('guarded')]));
  await assert.rejects(f.store.importMonarch(f.file, guard), /no longer active/);
  await writeFile(f.snapshotFile, JSON.stringify({ accounts: [{ name: 'Example Checking', type: 'checking', balance: 10, asOf: '2041-06-01' }] }));
  await assert.rejects(f.store.importMonarchSnapshot(f.snapshotFile, guard), /no longer active/);
  assert.deepEqual(await bytes(f), original); assert.equal(f.store.snapshot().state.settings.checking, 0);
});
