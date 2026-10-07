/** Shared Runway state contract. Browser-safe: no filesystem, network, or platform dependencies. */
export const FINANCE_SCHEMA = 'archi-runway/v1';
export const FINANCE_LIMITS = Object.freeze({ bills: 500, deadlines: 100, cards: 30, txns: 20_000,
  ledger: 50_000, imports: 200, accounts: 100, recurring: 500, ledgerText: 2000,
  csvBytes: 10 * 1024 * 1024, snapshotBytes: 2 * 1024 * 1024, storeBytes: 20 * 1024 * 1024, text: 300 });

/** Empty starting point. Dates are neutral placeholders until the user configures a plan. */
const deepFreeze = value => { for (const nested of Object.values(value)) if (nested && typeof nested === 'object') deepFreeze(nested); return Object.freeze(value); };
export const FINANCE_SEED = deepFreeze({
  schema: FINANCE_SCHEMA,
  settings: { checking: 0, checkingAsOf: '2000-01-01', buffer: 0, payAmt: 0, payDays: [], rent: 0, rentDay: 1,
    goalMonths: 3, startDate: '2000-01-01', goalDate: '2000-01-01' },
  bills: [], deadlines: [], cards: [],
  parents: { owed: 0, paid: 0 },
  caps: { 'Subscriptions': 0, 'Delivery & dining': 0, 'Groceries': 0, 'Gas & car': 0, 'Coffee': 0, 'Shopping': 0, 'Other': 0 },
  cancelled: [], txns: [],
});
const isDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const isTimestamp = value => isDate(value) || typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  && isDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
const isMoney = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 10_000_000;
const isText = (value, optional = true) => (optional && value === undefined) || (typeof value === 'string' && value.length <= FINANCE_LIMITS.text);
const isLedgerText = value => typeof value === 'string' && value.length <= FINANCE_LIMITS.ledgerText;
const isPlain = value => value && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const canonical = value => String(value || '').trim().toLowerCase();
const named = value => isText(value, false) && Boolean(value.trim());
const unique = (items, key) => new Set(items.map(item => key(item))).size === items.length;
function check(condition, message) { if (!condition) throw new Error(`Runway save rejected: ${message}.`); }

const emptyMonarch = () => ({ transactions: [], imports: [], accounts: [], recurring: [] });
function validateAccounts(accounts) {
  check(Array.isArray(accounts) && accounts.length <= FINANCE_LIMITS.accounts && accounts.every(a => isPlain(a)
    && isText(a.name, false) && a.name.trim() && ['checking', 'savings', 'credit', 'other'].includes(a.type)
    && isMoney(a.balance) && isDate(a.asOf) && isText(a.sourceUpdated) && isText(a.note)
    && (a.limit === undefined || isMoney(a.limit) && a.limit >= 0)), 'Monarch accounts');
  check(new Set(accounts.map(a => canonical(a.name))).size === accounts.length, 'duplicate Monarch accounts');
}
function validateRecurring(recurring) {
  check(Array.isArray(recurring) && recurring.length <= FINANCE_LIMITS.recurring && recurring.every(r => isPlain(r)
    && isText(r.name, false) && r.name.trim() && isMoney(r.amount) && isText(r.frequency, false) && r.frequency.trim()
    && (r.nextDate === undefined || isDate(r.nextDate)) && isText(r.account) && isText(r.note)
    && (r.status === undefined || ['suggested', 'confirmed'].includes(r.status))), 'Monarch recurring items');
  check(new Set(recurring.map(r => JSON.stringify([canonical(r.name), canonical(r.account)]))).size === recurring.length, 'duplicate Monarch recurring items');
}
function validateMonarch(monarch) {
  check(isPlain(monarch), 'Monarch data');
  const txns = monarch.transactions;
  check(Array.isArray(txns) && txns.length <= FINANCE_LIMITS.ledger && txns.every(t => isPlain(t)
    && isText(t.id, false) && t.id && isDate(t.date) && isMoney(t.amount)
    && ['merchant', 'category', 'account', 'notes', 'originalStatement', 'tags'].every(key => isLedgerText(t[key]))
    && ['income', 'expense', 'refund', 'transfer', 'payment'].includes(t.kind)
    && (t.capCategory === null || isText(t.capCategory, false))
    && (t.sourceId === undefined || isLedgerText(t.sourceId)) && (t.owner === undefined || isLedgerText(t.owner))
    && (t.reviewed === undefined || isLedgerText(t.reviewed))), 'Monarch transactions');
  check(new Set(txns.map(t => t.id)).size === txns.length, 'duplicate Monarch transaction IDs');
  if (monarch.excludedCaps !== undefined) {
    check(Array.isArray(monarch.excludedCaps) && monarch.excludedCaps.length <= FINANCE_LIMITS.ledger
      && monarch.excludedCaps.every(id => isText(id, false) && id.length > 0)
      && new Set(monarch.excludedCaps).size === monarch.excludedCaps.length, 'Monarch cap exclusions');
  }
  check(Array.isArray(monarch.imports) && monarch.imports.length <= FINANCE_LIMITS.imports && monarch.imports.every(i => isPlain(i)
    && isTimestamp(i.date) && (i.from === null || isDate(i.from)) && (i.to === null || isDate(i.to)) && isText(i.source, false)
    && ['total', 'valid', 'added', 'duplicates', 'purchasesAdded', 'invalid'].every(key => count(i[key]))), 'Monarch import history');
  validateAccounts(monarch.accounts); validateRecurring(monarch.recurring);
  check(monarch.observedAt === undefined || isTimestamp(monarch.observedAt), 'Monarch observation date');
  check(monarch.notes === undefined || isLedgerText(monarch.notes), 'Monarch notes');
}

export function validateFinance(state) {
  check(isPlain(state) && state.schema === FINANCE_SCHEMA, 'unknown format');
  const s = state.settings;
  check(isPlain(s) && ['checking', 'buffer', 'payAmt', 'rent'].every(key => isMoney(s[key])), 'settings');
  check(Array.isArray(s.payDays) && s.payDays.length <= 4 && s.payDays.every(day => Number.isInteger(day) && day >= 1 && day <= 31)
    && new Set(s.payDays).size === s.payDays.length, 'pay days');
  check(Number.isInteger(s.rentDay) && s.rentDay >= 1 && s.rentDay <= 31 && Number.isFinite(s.goalMonths) && s.goalMonths > 0 && s.goalMonths <= 24, 'rent day or goal');
  check(isDate(s.goalDate) && isDate(s.checkingAsOf) && (s.startDate === undefined || isDate(s.startDate)), 'dates');
  check(Array.isArray(state.bills) && state.bills.length <= FINANCE_LIMITS.bills && state.bills.every(bill => isPlain(bill)
    && named(bill.id) && isDate(bill.date) && named(bill.name) && isMoney(bill.amt) && typeof bill.paid === 'boolean' && isText(bill.note)
    && (bill.checkingAdjustment === undefined || isMoney(bill.checkingAdjustment))
    && (bill.checkingAdjustedOn === undefined || isDate(bill.checkingAdjustedOn))), 'bills');
  check(Array.isArray(state.deadlines) && state.deadlines.length <= FINANCE_LIMITS.deadlines && state.deadlines.every(item => isPlain(item)
    && named(item.id) && isDate(item.date) && named(item.name) && isMoney(item.amt) && (item.interest === undefined || isMoney(item.interest)) && isText(item.note)), 'deadlines');
  check(Array.isArray(state.cards) && state.cards.length <= FINANCE_LIMITS.cards && state.cards.every(card => isPlain(card)
    && named(card.name) && isMoney(card.apr) && card.apr >= 0 && isMoney(card.limit) && card.limit >= 0 && isMoney(card.bal)), 'cards');
  check(isPlain(state.parents) && isMoney(state.parents.owed) && isMoney(state.parents.paid), 'parents');
  check(isPlain(state.caps) && Object.keys(state.caps).length <= 20 && Object.entries(state.caps).every(([name, cap]) => named(name) && isMoney(cap) && cap >= 0), 'caps');
  check(Array.isArray(state.cancelled) && state.cancelled.length <= 500 && state.cancelled.every(name => isText(name, false)), 'cancelled list');
  check(Array.isArray(state.txns) && state.txns.length <= FINANCE_LIMITS.txns && state.txns.every(txn => isPlain(txn)
    && named(txn.id) && isDate(txn.date) && isMoney(txn.amt) && named(txn.cat) && isText(txn.who) && isText(txn.note)
    && isText(txn.monarchId)), 'purchases');
  if (state.monarch !== undefined) validateMonarch(state.monarch);
  for (const field of ['bills', 'deadlines', 'txns']) check(unique(state[field], item => item.id), `duplicate ${field} IDs`);
  check(unique(state.cards, item => canonical(item.name)), 'duplicate cards');
  return state;
}


export { isDate, isTimestamp, isMoney, isText, isLedgerText, isPlain, canonical, check, emptyMonarch, validateAccounts, validateRecurring };
