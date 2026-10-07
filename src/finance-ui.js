'use strict';
// Runway: safe-to-spend, bills, spending caps, promo deadlines and runway goal.
// The host bridge owns storage; this view renders state and requests validated saves.
(() => {
const api = window.runway;
let S = null, loadError = null, view = 'today', saving = Promise.resolve(), capabilities = {};
let spendMonth = '', billAction = null, editingTxn = null, ledgerLimit = 100, importReport = null, ledgerFiltersOpen = false;
const ledgerFilter = { month: '', account: '', category: '', query: '', from: '', to: '', review: false };

const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = n => (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n)).toLocaleString();
const cash = n => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(Number(n) || 0);
// local calendar date (toISOString is UTC and rolls over to tomorrow every evening)
const iso = x => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
const today = () => iso(new Date());
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return iso(x); };
const fmt = d => new Date(d + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const dateLabel = d => /^\d{4}-\d{2}-\d{2}/.test(d || '') ? new Date(d.slice(0, 10) + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Date unavailable';
const monthLabel = m => new Date(m + '-15T12:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const shiftMonth = (m, n) => { const d = new Date(m + '-15T12:00:00'); d.setMonth(d.getMonth() + n); return iso(d).slice(0, 7); };
const daysUntil = d => Math.round((new Date(d + 'T12:00:00') - new Date(today() + 'T12:00:00')) / 864e5);
const uid = () => Math.random().toString(36).slice(2, 9);
const tone = (good, warn) => good ? 'c-good' : warn ? 'c-warn' : 'c-bad';
const bar = (pct, cls = '') => `<div class="bar"><i class="${cls}" data-w="${Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0)).toFixed(1)}"></i></div>`;
const cats = () => Object.keys(S.caps);
const capTotal = () => Object.values(S.caps).reduce((a, b) => a + b, 0);
const canImport = () => capabilities.imports !== false;
const monarch = () => S.monarch || { transactions: [], imports: [], accounts: [], recurring: [] };
const ledger = () => monarch().transactions || [];
const ledgerMonths = () => [...new Set(ledger().map(t => t.date.slice(0, 7)))].sort().reverse();
const capSpent = (month, cat) => S.txns.filter(t => t.date.slice(0, 7) === month && (!cat || t.cat === cat)).reduce((a, t) => a + t.amt, 0);
function toast(m, duration = 1800) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); setTimeout(() => t.classList.remove('on'), duration); }
function describe(error) { return String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }

async function save() {
  const snapshot = structuredClone(S);
  saving = saving.then(() => api.save(snapshot)).then(result => { loadError = null; return result; })
    .catch(async error => {
      toast('Not saved');
      loadError = describe(error);
      const fresh = await api.getState().catch(() => null);
      if (fresh && Object.prototype.hasOwnProperty.call(fresh, 'state')) S = fresh.state;
      if (fresh?.capabilities) capabilities = fresh.capabilities;
      render();
      return false;
    });
  return saving;
}

// recurring events between two dates
function recurring(from, to) {
  const out = [], s = S.settings;
  const d = new Date(from + 'T12:00:00'), end = new Date(to + 'T12:00:00');
  while (d <= end) {
    const ds = iso(d), day = d.getDate();
    // A balance entered today is a snapshot; same-day standing events may already be reflected.
    if (s.payAmt > 0 && ds > s.checkingAsOf && s.payDays.includes(day)) out.push({ date: ds, name: 'Paycheck', amt: -s.payAmt, income: true, rec: true });
    if (s.rent > 0 && ds > s.checkingAsOf && day === s.rentDay) out.push({ date: ds, name: 'Rent', amt: s.rent, rec: true });
    d.setDate(d.getDate() + 1);
  }
  return out;
}
function nextPayday() {
  if (!S.settings.payDays.length || !(S.settings.payAmt > 0)) return null;
  let d = today();
  for (let i = 1; i < 65; i++) { d = addDays(d, 1); if (S.settings.payDays.includes(new Date(d + 'T12:00:00').getDate())) return d; }
  return null;
}
function timeline(days) {
  const from = today(), to = addDays(from, days);
  const items = [...recurring(from, to), ...S.bills.filter(b => b.date <= to && !b.paid).map(b => ({ ...b, overdue: b.date < from }))];
  items.sort((a, b) => a.date.localeCompare(b.date) || (a.income ? -1 : 1));
  let bal = S.settings.checking; const rows = [];
  for (const it of items) { bal -= it.amt; rows.push({ ...it, after: bal }); }
  return rows;
}
function safeToSpend() {
  const np = nextPayday();
  if (!np) return { amt: null, np: null, due: null };
  const due = timeline(65).filter(r => r.date < np && !r.income).reduce((a, r) => a + r.amt, 0);
  return { amt: S.settings.checking - due - S.settings.buffer, np, due };
}
function spentThisMonth(cat) {
  return capSpent(today().slice(0, 7), cat);
}
function monthlyFixed() {
  const s = S.settings, caps = capTotal();
  const debt = S.bills.filter(b => b.date >= today() && b.date <= addDays(today(), 90) && !b.paid).reduce((sum, b) => sum + b.amt, 0) / 3;
  return { rent: s.rent, debt, caps, total: s.rent + debt + caps };
}
// merchants charged in 2+ different months at a steady amount: likely subscriptions
function recurringCharges() {
  const by = {};
  for (const t of S.txns) { const k = (t.note || '').trim().toLowerCase(); if (k && t.amt > 0) (by[k] ||= []).push(t); }
  const out = [];
  for (const [k, ts] of Object.entries(by)) {
    const months = [...new Set(ts.map(t => t.date.slice(0, 7)))];
    if (months.length < 2) continue;
    const last = [...ts].sort((a, b) => b.date.localeCompare(a.date))[0];
    if (ts.filter(t => Math.abs(t.amt - last.amt) <= Math.max(2, last.amt * 0.15)).length < 2) continue;
    out.push({ key: k, name: last.note, amt: last.amt, last: last.date, months: months.length, cancelled: S.cancelled.includes(k) });
  }
  return out.sort((a, b) => a.cancelled - b.cancelled || b.amt - a.amt);
}

// ---------- views ----------
const TABS = [['today', 'Today'], ['bills', 'Bills'], ['spend', 'Spend'], ['monarch', 'Cash flow'], ['debt', 'Debt'], ['goal', 'Goal']];
function render() {
  $('#nav').innerHTML = TABS.map(([k, l]) => `<button aria-current="${view === k ? 'page' : 'false'}" data-v="${k}">${l}</button>`).join('');
  $('#nav').querySelectorAll('button').forEach(b => b.onclick = () => { view = b.dataset.v; render(); window.scrollTo(0, 0); });
  if (!S) {
    $('#app').innerHTML = `<h1>Runway</h1><div class="banner" role="alert">${esc(loadError || 'Runway could not open.')}</div><div class="button-row"><button id="retryLoad">Try again</button>${capabilities.backup && typeof api.restoreBackup === 'function' ? '<button id="backupRestore" class="primary">Restore backup</button>' : ''}</div>`;
    wire(); return;
  }
  $('#app').innerHTML = `<div class="topbar"><p class="tiny">Saved on this device</p>${capabilities.openProjects && typeof api.showYah === 'function' ? '<button class="small" id="toYah">Back to projects</button>' : ''}</div>`
    + (loadError ? `<div class="banner" role="alert">${esc(loadError)}<button class="small mt8" id="reloadState">Reload saved data</button></div>` : '')
    + ({ today: vToday, bills: vBills, spend: vSpend, monarch: vMonarch, debt: vDebt, goal: vGoal })[view]();
  document.querySelectorAll('.bar i[data-w]').forEach(i => { i.style.width = i.dataset.w + '%'; });
  wire();
}

function row(name, detail, right) {
  return `<div class="row"><div class="l"><div class="n">${name}</div>${detail ? `<div class="d">${detail}</div>` : ''}</div>${right}</div>`;
}
function timelineRow(r, attrs = '') {
  return `<div class="row" ${attrs}><div class="l"><div class="n">${esc(r.name)}${r.overdue ? '<span class="flag bad">Overdue · unpaid</span>' : ''}</div><div class="d">${fmt(r.date)}${r.note ? ' · ' + esc(r.note) : ''}</div></div>
    <div><div class="amt ${r.income ? 'in' : ''}">${r.income ? '+' : ''}${money(Math.abs(r.amt))}</div><div class="d right ${r.after < 0 ? 'c-bad' : ''}">→ ${money(r.after)}</div></div></div>`;
}

function vToday() {
  const st = safeToSpend(), cls = st.amt > S.settings.buffer ? 'good' : st.amt > 0 ? 'warn' : 'bad';
  const tl = timeline(45), low = tl.reduce((m, r) => Math.min(m, r.after), S.settings.checking);
  const lowRow = tl.find(r => r.after === low);
  const spent = spentThisMonth(), cap = capTotal();
  const cappedSpent = cats().filter(c => S.caps[c] > 0).reduce((sum, c) => sum + spentThisMonth(c), 0), pct = cap ? cappedSpent / cap * 100 : 0;
  const hasBalance = S.settings.checkingAsOf !== '2000-01-01';
  const stale = hasBalance && daysUntil(S.settings.checkingAsOf) < -3;
  return `
  <h1>Runway</h1>
  <p class="sub">Your money, one day at a time.</p>
  <div class="panel forecast-hero">
    <div class="tiny">${st.np && hasBalance ? `Estimated available until ${fmt(st.np)}` : 'Set up your checking forecast'}</div>
    <div class="big ${st.np && hasBalance ? cls : ''}">${st.np && hasBalance ? money(st.amt) : '—'}</div>
    <p class="note">${hasBalance ? `Checking ${cash(S.settings.checking)} · ${st.np ? `${daysUntil(st.np)} days until payday` : 'Add your income schedule in Bills'}` : 'Start with your balance. Add income and bills when ready.'}</p>
    ${stale ? `<p class="note c-warn">Balance last updated ${fmt(S.settings.checkingAsOf)}.</p>` : ''}
    <details class="balance-editor"><summary>${hasBalance ? 'Update checking balance' : 'Enter checking balance'}</summary>
    <div class="grid2">
      <div><label for="chk">Checking now</label><input id="chk" type="number" step="0.01" inputmode="decimal" value="${S.settings.checking}"></div>
      <div><label for="buf">Keep as a buffer</label><input id="buf" type="number" min="0" step="0.01" inputmode="decimal" value="${S.settings.buffer}"></div>
    </div>
    <button class="primary wfull mt10" id="saveChk">Update balance</button></details>
    <details class="finance-help"><summary>How this estimate works</summary>
      <p class="note">${st.np && hasBalance ? `Checking ${money(S.settings.checking)} − bills due before payday ${money(st.due)} − ${money(S.settings.buffer)} buffer.` : 'Enter a checking balance, paycheck amount, pay days and scheduled bills to enable this estimate.'}</p>
      <p class="note">Manual purchases track spending caps only; they do not adjust checking or imported cash flow. Update checking from your account. A balance dated today is assumed to include today's paycheck and rent; add an unpaid same-day item in Bills.</p>
      <button class="small mt8" data-go="bills">Set income & bills</button></details>
  </div>
  ${vQuickPurchase()}
  ${vStoragePanel()}
  <div class="panel">
    ${row('Lowest forecast in next 45 days', hasBalance ? (lowRow ? fmt(lowRow.date) + ' after ' + esc(lowRow.name) : 'No scheduled changes') : 'Enter a checking balance first', `<div class="amt">${hasBalance ? money(low) : '—'}</div>`)}
    ${row('Purchases in caps this month', cap > 0 ? `Configured caps total ${money(cap)}; zero means unset` : 'No spending caps configured yet', `<div class="amt">${cash(spent)}</div>`)}
    ${cap > 0 ? bar(pct, pct > 100 ? 'bad' : pct > 80 ? 'warn' : '') : '<button class="small mt8" data-go="spend">Set spending caps</button>'}
  </div>
  ${vSourceSummary()}
  <h2>Next 14 days</h2>
  <div class="panel">${tl.filter(r => daysUntil(r.date) <= 14).map(r => timelineRow(r)).join('') || '<div class="tiny">Nothing scheduled.</div>'}</div>
  ${vUpcomingRecurring()}`;
}

function vQuickPurchase() {
  return `<div class="panel quick-purchase">
    <h2>Quick add a purchase</h2>
    <div class="grid2 mt6">
      <input id="qa" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="Amount" aria-label="Amount">
      <select id="qc" aria-label="Category">${cats().map(c => `<option>${esc(c)}</option>`).join('')}</select>
    </div>
    <input id="qn" class="mt8" maxlength="120" placeholder="What was it? (optional)" aria-label="What was it">
    <details class="purchase-options"><summary>Date & account</summary>
    <div class="grid2"><div><label for="qd">Date</label><input id="qd" type="date" value="${today()}"></div><div><label for="qw">Account (optional)</label><input id="qw" maxlength="120" placeholder="Account label"></div></div>
    </details>
    <p class="note">Tracks spending caps; checking stays unchanged.</p>
    <button class="primary wfull mt8" id="qadd">Log purchase</button>
    ${canImport() ? '<details class="finance-help"><summary>About imported purchases</summary><p class="note">Later imports may include the same purchase. Remove one cap entry if duplicated.</p></details>' : ''}
  </div>`;
}

function vStoragePanel() {
  const browser = capabilities.storage === 'browser';
  if (!browser && !capabilities.backup) return '';
  const backup = capabilities.backup && typeof api.exportBackup === 'function' && typeof api.restoreBackup === 'function';
  return `<details class="panel storage-panel"><summary>Data & backups</summary>
    <p class="note">Saved on this device. There is no automatic sync with other devices.</p>
    ${browser ? '<p class="note">Clearing browser data erases these records. Export a backup regularly and before switching browsers or devices.</p>' : ''}
    ${backup ? '<div class="button-row mt12"><button id="backupExport" class="primary">Export backup</button><button id="backupRestore">Restore backup</button></div><p class="note">Backups contain your financial records. Keep the downloaded file somewhere private.</p>' : ''}
    ${browser && typeof api.requestPersistence === 'function' ? '<button class="small mt10" id="requestStorage">Keep browser storage</button><p class="tiny">Asks the browser to retain data when space is low. It does not prevent manual clearing.</p>' : ''}
  </details>`;
}

function vBills() {
  const months = {};
  timeline(100).forEach(r => { (months[r.date.slice(0, 7)] ||= []).push(r); });
  const selected = S.bills.find(b => b.id === billAction);
  return `
  <h1>Bills</h1>
  <p class="sub">Every scheduled dollar, with your checking balance after each one. Select a bill to mark it paid.</p>
  <p class="note">Unpaid overdue bills remain reserved. Imported account balances are snapshots, not statement amounts due.</p>
  ${selected ? `<div class="panel bill-action"><div class="n">${esc(selected.name)} · ${cash(selected.amt)}</div><p class="note">How should this payment affect the checking balance shown in Runway?</p><button class="primary wfull mt10" data-paid-mode="subtract">Mark paid & subtract from checking</button><button class="wfull mt8" data-paid-mode="reflected">Mark paid · already in checking balance</button>
    <details><summary>Edit scheduled bill</summary><label for="beName">Name</label><input id="beName" maxlength="120" value="${esc(selected.name)}"><div class="grid2"><div><label for="beAmount">Amount</label><input id="beAmount" type="number" step="0.01" value="${selected.amt}"></div><div><label for="beDate">Date</label><input id="beDate" type="date" value="${selected.date}"></div></div><label for="beNote">Note</label><input id="beNote" maxlength="300" value="${esc(selected.note || '')}"><div class="button-row mt10"><button id="saveBill">Save changes</button><button id="removeBill">Remove bill</button></div></details><button class="small mt8" id="cancelBillAction">Cancel</button></div>` : ''}
  ${Object.entries(months).map(([m, rows]) => `
    <h2>${new Date(m + '-15T12:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
    <div class="panel">${rows.map(r => timelineRow(r, r.id ? `data-pay="${esc(r.id)}" role="button" tabindex="0"` : '')).join('')}</div>`).join('')}
  <h2>Paid</h2>
  <div class="panel">${S.bills.filter(b => b.paid).map(b => `<div class="row paid" data-unpay="${esc(b.id)}" role="button" tabindex="0"><div class="l"><div class="n">${esc(b.name)}</div><div class="d">${fmt(b.date)}${b.checkingAdjustment === 0 ? ' · Already reflected in balance' : ''}</div></div><div class="amt">${cash(b.amt)}</div></div>`).join('') || '<div class="tiny">Nothing yet.</div>'}</div>
  <h2>Add a bill</h2>
  <div class="panel">
    <div class="grid2"><div><label for="bd">Date</label><input id="bd" type="date" value="${today()}"></div><div><label for="ba">Amount</label><input id="ba" type="number" inputmode="decimal"></div></div>
    <label for="bn">Name</label><input id="bn" maxlength="120" placeholder="e.g. Card statement">
    <label for="bo">Note</label><input id="bo" maxlength="300" placeholder="optional">
    <button class="primary wfull mt10" id="badd">Add bill</button>
  </div>
  <h2>Income & rent</h2>
  <div class="panel">
    <div class="grid2">
      <div><label for="sp">Paycheck</label><input id="sp" type="number" value="${S.settings.payAmt}"></div>
      <div><label for="spd">Pay days (comma separated)</label><input id="spd" value="${S.settings.payDays.join(',')}" placeholder="Days of month, e.g. 1,15"></div>
      <div><label for="sr">Rent</label><input id="sr" type="number" value="${S.settings.rent}"></div>
      <div><label for="srd">Rent day</label><input id="srd" type="number" value="${S.settings.rentDay}"></div>
    </div>
    <p class="note">Leave pay days blank if you do not want recurring paychecks. A zero paycheck or rent amount disables that scheduled item.</p>
    <button class="wfull mt10" id="ssave">Save income & rent</button>
  </div>`;
}

function vRecurring() {
  const r = recurringCharges(); if (!r.length) return '';
  return `<h2>Possible repeat purchases</h2>
  <div class="panel">${r.slice(0, 40).map(x => `
    <div class="row ${x.cancelled ? 'paid' : ''}"><div class="l"><div class="n">${esc(x.name)}</div><div class="d">Last ${fmt(x.last)} · seen in ${x.months} months</div></div>
    <div class="amt">${cash(x.amt)}</div><button class="small" data-cancel="${esc(encodeURIComponent(x.key))}">${x.cancelled ? 'Undo' : 'Dismiss'}</button></div>`).join('')}
    <p class="note">Candidates from purchases with similar merchant names and amounts across at least two months. Amounts shown are the last purchase, not a monthly total. These are not confirmed subscriptions and do not create forecast bills.${r.length > 40 ? ' Showing the first 40 candidates.' : ''}</p>
  </div>`;
}

function vSpend() {
  const m = spendMonth || today().slice(0, 7), current = m === today().slice(0, 7);
  const txns = S.txns.filter(t => t.date.slice(0, 7) === m).sort((a, b) => b.date.localeCompare(a.date));
  const total = txns.reduce((a, t) => a + t.amt, 0), cap = capTotal();
  const budgetSpent = txns.filter(t => S.caps[t.cat] > 0).reduce((a, t) => a + t.amt, 0), left = cap - budgetSpent;
  const now = new Date(), dIn = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(), daysLeft = dIn - now.getDate() + 1;
  const par = cap * now.getDate() / dIn, gap = budgetSpent - par;
  return `
  <h1>Spend</h1>
  <p class="sub">Purchases and refunds assigned to caps. Current caps are used for historical comparisons. A zero cap means no limit is configured.</p>
  <div class="month-nav"><button class="small" data-spend-shift="-1" aria-label="Previous month">‹</button><label class="sr-only" for="spendMonth">Spending month</label><input type="month" id="spendMonth" value="${esc(m)}"><button class="small" data-spend-shift="1" aria-label="Next month">›</button><button class="small" id="spendCurrent">Today</button></div>
  <div class="panel">
    <div class="tiny">${monthLabel(m)} · ${cap > 0 ? 'left in configured caps' : 'recorded spending'}</div>
    <div class="big ${cap > 0 ? (left > cap * 0.3 ? 'good' : left > 0 ? 'warn' : 'bad') : ''}">${cash(cap > 0 ? left : total)}</div>
    ${cap > 0 && current ? `<div class="note ${tone(gap <= 0, gap <= 50)}">${gap > 0 ? money(gap) + ' ahead of pace' : money(-gap) + ' under pace'} in configured categories · ${money(Math.max(0, left / daysLeft))} a day for ${daysLeft} days</div>` : `<div class="note">${cap > 0 ? `${cash(budgetSpent)} recorded against ${money(cap)} in configured caps.` : 'Enter monthly category caps below to enable remaining-budget estimates.'}</div>`}
    <p class="note">${cash(total)} total recorded. Categories without a cap are excluded from remaining-budget estimates.</p>
  </div>
  <div class="panel">${cats().map(c => {
    const s = capSpent(m, c), p = S.caps[c] ? s / S.caps[c] * 100 : 0;
    return `<div class="row"><div class="l"><div class="n">${esc(c)}</div>${S.caps[c] > 0 ? bar(p, p > 100 ? 'bad' : p > 80 ? 'warn' : '') : ''}<div class="d ${S.caps[c] > 0 && s > S.caps[c] ? 'c-bad' : ''}">${S.caps[c] > 0 ? `${cash(Math.abs(S.caps[c] - s))} ${s > S.caps[c] ? 'over cap' : 'left'}` : 'No cap configured'}</div></div>
      <div class="amt cap">${money(s)} <span class="d">/ </span><input data-cap="${esc(c)}" type="number" value="${S.caps[c]}" aria-label="${esc(c)} cap"></div></div>`;
  }).join('')}</div>
  ${vTransactionEditor()}
  <h2>${monthLabel(m)} · ${txns.length.toLocaleString()} purchases</h2>
  <div class="panel">${txns.slice(0, 200).map(t => `<div class="row"><div class="l"><div class="n">${esc(t.note || t.cat)}</div><div class="d">${fmt(t.date)} · ${esc(t.cat)}${t.who ? ' · ' + esc(t.who) : ''}</div><div class="button-row mt6"><button class="small" data-edit-txn="${esc(t.id)}">Edit cap entry</button><button class="small" data-del="${esc(t.id)}">Remove from caps</button></div></div><div class="amt">${cash(t.amt)}</div></div>`).join('') || `<div class="tiny">No purchases recorded for this month. Add one on Today${canImport() ? ' or import a Monarch CSV' : ''}.</div>`}${txns.length > 200 ? '<p class="note">Showing the newest 200. Search the full imported history in Cash flow.</p>' : ''}</div>
  ${vRecurring()}
  ${canImport() ? `<h2>Import from Monarch</h2>
  <div class="panel">
    <p class="tiny pnote">In Monarch: Transactions → Download CSV. The complete ledger keeps income, expenses, payments, and transfers; eligible purchases and refunds also appear in caps. Reimported rows are deduplicated.</p>
    <button class="primary wfull" id="imp">Choose Monarch CSV…</button>
    <p class="note">${S.txns.length.toLocaleString()} purchases saved in total.</p>
  </div>` : ''}`;
}

function vTransactionEditor() {
  const t = S.txns.find(t => t.id === editingTxn);
  if (!t) return '';
  return `<div class="panel" id="txnEditor"><h2>Edit cap entry</h2><p class="note">Changes affect spending caps only. Imported cash flow and checking stay unchanged. Use a negative amount for a refund.</p>
    <div class="grid2"><div><label for="teAmount">Amount</label><input id="teAmount" type="number" step="0.01" value="${t.amt}"></div><div><label for="teDate">Date</label><input id="teDate" type="date" value="${t.date}"></div></div>
    <label for="teCategory">Category</label><select id="teCategory">${cats().map(c => `<option${t.cat === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>
    <label for="teNote">Description</label><input id="teNote" maxlength="120" value="${esc(t.note || '')}">
    <label for="teAccount">Account label</label><input id="teAccount" maxlength="120" value="${esc(t.who || '')}">
    <div class="button-row mt10"><button class="primary" id="saveTxn">Save cap entry</button><button id="cancelTxn">Cancel</button></div></div>`;
}

function vSourceSummary() {
  const m = monarch(), dates = ledger().map(t => t.date).sort(), latest = dates[dates.length - 1];
  return `<div class="panel source-summary"><div class="n">Your money history</div><p class="note">${dates.length ? `Activity through ${dateLabel(latest)} · ${dates.length.toLocaleString()} transactions.${daysUntil(latest) < -3 ? ' Recent activity may be missing.' : ''}` : 'No transaction history imported yet. Cap purchases from older imports may still appear in Spend.'}</p><div class="button-row mt8"><button class="small" data-go="monarch">Explore cash flow</button><button class="small" data-go="spend">Review spending caps</button></div></div>`;
}

function filteredLedger() {
  const f = ledgerFilter, q = f.query.trim().toLowerCase();
  return ledger().filter(t => (!f.month || t.date.startsWith(f.month)) && (!f.from || t.date >= f.from) && (!f.to || t.date <= f.to) && (!f.account || t.account === f.account) && (!f.category || (t.category || 'Uncategorized') === f.category) && (!f.review || /needs review/i.test(t.reviewed || '')) && (!q || [t.merchant, t.category, t.account, t.notes, t.originalStatement, t.owner, t.reviewed, ...(Array.isArray(t.tags) ? t.tags : [t.tags]), t.kind, t.capCategory].join(' ').toLowerCase().includes(q))).sort((a, b) => b.date.localeCompare(a.date));
}

function vMonarch() {
  const m = monarch(), all = ledger(), rows = filteredLedger();
  const months = [...new Set([...ledgerMonths(), ...(ledgerFilter.month ? [ledgerFilter.month] : [])])].sort().reverse();
  const accounts = [...new Set(all.map(t => t.account).filter(Boolean))].sort();
  const sourceCategories = [...new Set(all.map(t => t.category || 'Uncategorized'))].sort();
  const total = kind => rows.filter(t => t.kind === kind).reduce((sum, t) => sum + t.amount, 0);
  const income = total('income'), expenses = -total('expense') - total('refund'), net = income - expenses;
  const paymentDebits = rows.filter(t => t.kind === 'payment' && t.amount < 0).reduce((sum, t) => sum - t.amount, 0);
  const paymentCredits = rows.filter(t => t.kind === 'payment' && t.amount > 0).reduce((sum, t) => sum + t.amount, 0);
  const transfers = rows.filter(t => t.kind === 'transfer').length;
  const needsReview = all.filter(t => /needs review/i.test(t.reviewed || '')).length;
  const groups = {};
  rows.filter(t => ['expense', 'refund'].includes(t.kind)).forEach(t => { const key = t.category || 'Uncategorized'; groups[key] = (groups[key] || 0) - t.amount; });
  const categories = Object.entries(groups).sort((a, b) => b[1] - a[1]);
  const dates = all.map(t => t.date).sort(), imports = [...(m.imports || [])].sort((a, b) => b.date.localeCompare(a.date));
  const sourcePanel = `<details class="panel"><summary>Data coverage & updates</summary>
  <div class="panel"><div class="n">${all.length.toLocaleString()} transactions imported</div>
    <p class="note">${dates.length ? `${dateLabel(dates[0])}–${dateLabel(dates[dates.length - 1])}. This is the observed date span; it does not guarantee every day or account is complete.` : canImport() ? 'Import a transaction CSV to calculate cash flow. Account snapshots and recurring items alone do not establish income or spending.' : 'No imported cash-flow history on this device. Manual purchases appear in Spend; they do not populate this view.'}</p>
    ${m.observedAt ? `<p class="note">Account / recurring snapshot observed ${dateLabel(m.observedAt)}.</p>` : ''}
    ${m.notes ? `<p class="note">${esc(m.notes)}</p>` : ''}
    ${canImport() ? '<div class="grid2 mt10"><button class="primary" id="imp">Import transaction CSV…</button><button id="impSnapshot">Import account snapshot…</button></div><p class="note">Local imports only. This does not maintain a live connection to Monarch. Snapshots do not change your plan until you apply a balance.</p>' : '<p class="note">CSV and account-snapshot imports are available in the desktop app. Devices do not sync automatically.</p>'}
    ${importReport ? `<p class="note import-report" role="status">${esc(importReport)}</p>` : ''}
    <details><summary>Import history</summary>${canImport() ? '<p class="note">Export transactions from Monarch → Transactions → Download CSV. A snapshot JSON can contain accounts and recurring items; it is separate from transaction history.</p>' : ''}${imports.slice(0, 8).map(i => `<div class="row"><div class="l"><div class="n">${esc(i.source || 'Monarch CSV')}</div><div class="d">Imported ${dateLabel(i.date)} · ${i.valid || 0} valid rows${i.from && i.to ? ` · ${dateLabel(i.from)}–${dateLabel(i.to)}` : ''}</div><div class="d">${i.added || 0} ledger entries added · ${i.duplicates || 0} already present${i.invalid ? ` · ${i.invalid} invalid rows` : ''}</div></div></div>`).join('') || '<p class="note">No transaction imports recorded.</p>'}</details>
  </div>
  </details>`;
  return `<h1>Cash flow</h1><p class="sub">See what came in, what went out, and what's changing.</p>
  <div class="panel">
    <div class="grid2"><div><label for="ledgerMonth">Month</label><select id="ledgerMonth"><option value="">All imported dates</option>${months.map(month => `<option value="${esc(month)}"${month === ledgerFilter.month ? ' selected' : ''}>${monthLabel(month)}</option>`).join('')}</select></div><div><label for="ledgerAccount">Account</label><select id="ledgerAccount"><option value="">All accounts</option>${accounts.map(a => `<option${a === ledgerFilter.account ? ' selected' : ''}>${esc(a)}</option>`).join('')}</select></div></div>
    <div class="cashflow-grid mt12"><div><div class="tiny">Classified income</div><div class="amt c-good">${rows.length ? cash(income) : '—'}</div></div><div><div class="tiny">Expenses, net refunds</div><div class="amt">${rows.length ? cash(expenses) : '—'}</div></div><div><div class="tiny">Net cash flow</div><div class="amt ${net >= 0 ? 'c-good' : 'c-bad'}">${rows.length ? cash(net) : '—'}</div></div></div>
    <details id="ledgerFilters"${ledgerFiltersOpen ? ' open' : ''}><summary>Filter transactions${ledgerFilter.from || ledgerFilter.to || ledgerFilter.category || ledgerFilter.query || ledgerFilter.review ? ' · active' : ''}</summary>
    <div class="grid2"><div><label for="ledgerFrom">From</label><input id="ledgerFrom" type="date" value="${esc(ledgerFilter.from)}"></div><div><label for="ledgerTo">Through</label><input id="ledgerTo" type="date" value="${esc(ledgerFilter.to)}"></div></div>
    <label for="ledgerCategory">Category</label><select id="ledgerCategory"><option value="">All source categories</option>${sourceCategories.map(c => `<option${c === ledgerFilter.category ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>
    <label for="ledgerSearch">Search merchants, categories, accounts & notes</label><input type="search" id="ledgerSearch" placeholder="Search imported history" value="${esc(ledgerFilter.query)}">
    <label class="check-label" for="ledgerReview"><input id="ledgerReview" type="checkbox"${ledgerFilter.review ? ' checked' : ''}>Needs review in Monarch (${needsReview})</label>
    ${ledgerFilter.from && ledgerFilter.to && ledgerFilter.from > ledgerFilter.to ? '<p class="note c-warn">The end date is before the start date.</p>' : ''}
    </details>
    <p class="note">${rows.length.toLocaleString()} matching entries. Transfers and card payments are excluded above to avoid counting purchases twice. Card payment debits: ${cash(paymentDebits)} · credits: ${cash(paymentCredits)}. ${transfers.toLocaleString()} transfer entries excluded. Filters also change these totals.</p>
    <details><summary>How these totals are counted</summary><p class="note">Cash flow uses imported categories and recognizable payment / transfer descriptions. Misclassified source transactions can change these totals. Review source details; cash flow does not replace your checking balance, statement dues, or scheduled forecast.</p></details>
  </div>
  ${vCashflowTrend()}
  ${categories.length ? `<h2>Spending by category</h2><div class="panel">${categories.slice(0, 12).map(([name, amount]) => `<button class="row category-row" data-ledger-category="${esc(name)}"><span class="l"><span class="n">${esc(name)}</span>${bar(amount / Math.max(1, categories[0][1]) * 100, 'spending')}</span><span class="amt">${cash(amount)}</span></button>`).join('')}<p class="note">Select a category to see its transactions.${categories.length > 12 ? ` Top 12 of ${categories.length} matching categories.` : ''}</p></div>` : ''}
  <details class="section-details"><summary>Account balances · ${(m.accounts || []).length}</summary>${vAccountSnapshots()}</details>
  <details class="section-details"><summary>Recurring payments · ${(m.recurring || []).length}</summary>${vImportedRecurring()}</details>
  <h2>Transaction history</h2><div class="panel ledger">${rows.slice(0, ledgerLimit).map(ledgerRow).join('') || `<p class="tiny">${all.length ? 'No transactions match these filters.' : 'No transaction ledger imported yet.'}</p>`}${rows.length > ledgerLimit ? `<button id="ledgerMore" class="wfull mt10">Show ${Math.min(100, rows.length - ledgerLimit)} more (${ledgerLimit} of ${rows.length.toLocaleString()})</button>` : ''}</div>
  ${sourcePanel}`;
}

function ledgerRow(t) {
  const metadata = [['Statement', t.originalStatement], ['Notes', t.notes], ['Tags', Array.isArray(t.tags) ? t.tags.join(', ') : t.tags], ['Owner', t.owner], ['Review status', t.reviewed], ['Mapped cap', t.capCategory]].filter(([, value]) => value);
  const excluded = (monarch().excludedCaps || []).includes(t.id);
  return `<div class="row"><div class="l"><div class="n">${esc(t.merchant || 'Unnamed transaction')}<span class="flag">${esc(t.kind)}</span>${/needs review/i.test(t.reviewed || '') ? '<span class="flag warn">Needs review</span>' : ''}</div><div class="d">${dateLabel(t.date)} · ${esc(t.category || 'Uncategorized')} · ${esc(t.account || 'Account unavailable')}</div>${metadata.length || excluded ? `<details><summary>Source details</summary>${metadata.map(([name, value]) => `<p class="note">${name}: ${esc(value)}</p>`).join('')}${excluded ? `<p class="note">Excluded from spending caps. The source transaction stays in cash flow.</p>${t.capCategory && ['expense', 'refund'].includes(t.kind) ? `<button class="small mt8" data-restore-cap="${esc(t.id)}">Restore to caps</button>` : ''}` : ''}</details>` : ''}</div><div class="amt ${t.amount > 0 ? 'c-good' : ''}">${cash(t.amount)}</div></div>`;
}

function vCashflowTrend() {
  const months = ledgerMonths();
  if (!months.length) return '';
  const scope = ledger().filter(t => (!ledgerFilter.account || t.account === ledgerFilter.account));
  const summarize = entries => ({ income: entries.filter(t => t.kind === 'income').reduce((s, t) => s + t.amount, 0), spent: entries.filter(t => ['expense', 'refund'].includes(t.kind)).reduce((s, t) => s - t.amount, 0), count: entries.length });
  const recent = Array.from({ length: 6 }, (_, i) => shiftMonth(months[0], i - 5));
  const series = recent.map(month => ({ month, ...summarize(scope.filter(t => t.date.startsWith(month))) }));
  const max = Math.max(1, ...series.flatMap(x => [x.income, x.spent]));
  const selected = ledgerFilter.month, current = selected === today().slice(0, 7);
  let comparison = '';
  if (selected) {
    const selectedEntries = scope.filter(t => t.date.startsWith(selected)), last = selectedEntries.map(t => t.date).sort().at(-1);
    const cutoff = current && last ? Math.min(Number(today().slice(8)), Number(last.slice(8))) : 31;
    const period = month => scope.filter(t => t.date.startsWith(month) && Number(t.date.slice(8)) <= cutoff);
    const a = summarize(period(selected)), b = summarize(period(shiftMonth(selected, -1)));
    if (a.count && b.count) comparison = `<div class="trend-comparison"><div class="tiny">${monthLabel(selected)} vs previous month${current ? ` · through day ${cutoff}` : ''}</div><div class="n ${a.spent <= b.spent ? 'c-good' : 'c-warn'}">Spending ${cash(Math.abs(a.spent - b.spent))} ${a.spent <= b.spent ? 'lower' : 'higher'}</div><p class="note">Net cash flow ${cash(a.income - a.spent)} vs ${cash(b.income - b.spent)}.</p></div>`;
    else comparison = `<p class="note trend-comparison">Previous-month comparison unavailable: no imported activity for ${monthLabel(a.count ? shiftMonth(selected, -1) : selected)} in this comparison period.</p>`;
  }
  return `<h2>Six-month trend</h2><div class="panel"><div class="trend-legend"><span class="c-good">● Income</span><span class="c-muted">● Spending, net refunds</span></div>${series.map(x => `<button class="trend-row" data-trend-month="${x.month}" aria-label="View ${esc(monthLabel(x.month))}"><span class="trend-month">${new Date(x.month + '-15T12:00:00').toLocaleDateString(undefined, { month: 'short' })}</span>${x.count ? `<span class="trend-bars">${bar(x.income / max * 100)}${bar(x.spent / max * 100, 'spending')}</span><span class="trend-values">${cash(x.income)}<br><span class="c-muted">${cash(x.spent)}</span></span>` : '<span class="tiny">No imported activity</span>'}</button>`).join('')}${comparison}<p class="note">${ledgerFilter.account ? esc(ledgerFilter.account) : 'All accounts'} · imported activity only. Search and custom date filters do not change this overview; missing imports and month-boundary charges can affect comparisons.</p></div>`;
}

function vAccountSnapshots() {
  const accounts = monarch().accounts || [];
  return `<h2>Account snapshots</h2><div class="panel"><p class="note pnote">Point-in-time balances. Credit balances are not statement dues. Apply checking only when its balance and date are the baseline you want for your forecast.</p>${accounts.slice(0, 100).map((a, i) => `
    <div class="account-snapshot"><div class="row"><div class="l"><div class="n">${esc(a.name)}<span class="flag">${esc(a.type)}</span></div><div class="d">As of ${dateLabel(a.asOf)}${a.sourceUpdated ? ` · Source: ${esc(a.sourceUpdated)}` : ''}${a.limit != null ? ` · Limit ${cash(a.limit)}` : ''}</div></div><div class="amt">${cash(a.balance)}</div></div>
    ${a.note ? `<p class="note">${esc(a.note)}</p>` : ''}
    ${a.type === 'checking' ? `<button class="small mt8" data-apply-checking="${i}">Use as Runway checking balance</button>` : a.type === 'credit' ? `<div class="snapshot-action"><label class="sr-only" for="cardTarget${i}">Runway card for ${esc(a.name)}</label><select id="cardTarget${i}"><option value="">Choose a Runway card…</option>${S.cards.map((c, index) => `<option value="${index}">${esc(c.name)}</option>`).join('')}</select><button class="small" data-apply-card="${i}">Apply</button></div>${a.limit != null ? `<label class="check-label"><input type="checkbox" id="applyLimit${i}">Also apply the ${cash(a.limit)} source limit</label>` : ''}` : ''}</div>`).join('') || '<p class="tiny">No account snapshots imported.</p>'}</div>`;
}

function vImportedRecurring() {
  const items = monarch().recurring || [];
  return `<h2>Recurring items from Monarch</h2><div class="panel"><p class="note pnote">Suggested items need review. Card purchases do not immediately leave checking: schedule only the payment actually due from checking, and avoid adding a purchase already covered by a card bill. Adding an item below creates one scheduled checking payment.</p>${items.slice(0, 100).map((r, i) => `<div class="recurring-item"><div class="row"><div class="l"><div class="n">${esc(r.name)}<span class="flag">${r.status === 'confirmed' ? 'Confirmed in source' : 'Suggested'}</span></div><div class="d">${esc(r.frequency)}${r.nextDate ? ` · Next ${dateLabel(r.nextDate)}` : ''}${r.account ? ` · ${esc(r.account)}` : ''}</div>${r.note ? `<p class="note">${esc(r.note)}</p>` : ''}</div><div class="amt ${r.amount > 0 ? 'c-good' : ''}">${cash(r.amount)}</div></div>${r.amount < 0 && r.nextDate ? `<button class="small mt8" data-recurring-bill="${i}">Review next payment in Bills</button>` : ''}</div>`).join('') || '<p class="tiny">No source recurring items imported.</p>'}</div>`;
}

function vUpcomingRecurring() {
  const next = (monarch().recurring || []).filter(r => r.amount < 0 && r.nextDate && r.nextDate >= today() && r.nextDate <= addDays(today(), 14)).sort((a, b) => a.nextDate.localeCompare(b.nextDate)).slice(0, 4);
  if (!next.length) return '';
  return `<h2>Recurring payments to review</h2><div class="panel">${next.map(r => row(esc(r.name), `${fmt(r.nextDate)}${r.account ? ` · ${esc(r.account)}` : ''}${r.status !== 'confirmed' ? ' · Suggested' : ''}`, `<div class="amt">${cash(-r.amount)}</div>`)).join('')}<p class="note">From the Monarch snapshot. These affect the forecast only after you add a payment to Bills.</p><button class="small mt8" id="reviewRecurring">Review recurring payments</button></div>`;
}

function vDebt() {
  const dl = [...S.deadlines].sort((a, b) => a.date.localeCompare(b.date));
  const totalInt = dl.reduce((a, d) => a + (d.interest || 0), 0);
  return `
  <h1>Debt</h1>
  <p class="sub">Track promotional deadlines separately from current card balances. Confirm terms and amounts due on your statements.</p>
  <div class="panel">${dl.map(d => { const n = daysUntil(d.date); return `
    <div class="row" data-dl="${esc(d.id)}" role="button" tabindex="0"><div class="l"><div class="n">${esc(d.name)}</div><div class="d">Due ${fmt(d.date)} · ${n} days${d.interest ? ' · ' + money(d.interest) + ' back interest at risk' : ''}${d.note ? '<br>' + esc(d.note) : ''}</div></div>
    <div class="amt ${n < 30 ? 'c-bad' : n < 60 ? 'c-warn' : ''}">${money(d.amt)}</div></div>`; }).join('') || '<div class="tiny">No promotional deadlines entered.</div>'}
    ${dl.length ? `<p class="note">Select a deadline once it is fully paid. ${money(totalInt)} of recorded potential interest is associated with these deadlines.</p>` : ''}
  </div>
  <h2>Add a deadline</h2>
  <div class="panel"><label for="dn">Name</label><input id="dn" maxlength="120" placeholder="Promotional balance">
    <div class="grid2"><div><label for="dd">Due date</label><input id="dd" type="date"></div><div><label for="da">Balance due</label><input id="da" type="number" min="0" step="0.01"></div></div>
    <label for="di">Potential interest (optional)</label><input id="di" type="number" min="0" step="0.01" value="0">
    <label for="dnote">Note</label><input id="dnote" maxlength="300">
    <p class="note">A deadline is a reminder. Add its checking payment separately in Bills.</p><button id="dadd" class="primary wfull mt10">Add deadline</button></div>
  <h2>Cards</h2>
  <div class="panel">${S.cards.map((c, i) => { const p = c.limit ? c.bal / c.limit * 100 : 0; return `
    <div class="row"><div class="l"><div class="n">${esc(c.name)} <span class="flag">${c.apr}% APR</span></div>${bar(p, p > 90 ? 'bad' : p > 70 ? 'warn' : '')}<div class="d">${money(c.limit - c.bal)} room of ${money(c.limit)}</div></div>
    <input class="card-bal" data-card="${i}" type="number" value="${c.bal}" aria-label="${esc(c.name)} balance"></div><details><summary>Edit ${esc(c.name)} details</summary><label for="ceName${i}">Name</label><input id="ceName${i}" maxlength="120" value="${esc(c.name)}"><div class="grid2"><div><label for="ceLimit${i}">Limit</label><input id="ceLimit${i}" type="number" min="0" step="0.01" value="${c.limit}"></div><div><label for="ceApr${i}">APR (%)</label><input id="ceApr${i}" type="number" min="0" step="0.01" value="${c.apr}"></div></div><div class="button-row mt10"><button class="small" data-save-card="${i}">Save details</button><button class="small" data-remove-card="${i}">Remove card</button></div></details>`; }).join('') || '<p class="tiny">No cards entered.</p>'}
    <p class="note">Update balances manually or apply an account snapshot in Monarch. Card balances do not change scheduled bills or promotional deadlines.</p>
  </div>
  <h2>Add a card</h2>
  <div class="panel"><label for="cn">Card name</label><input id="cn" maxlength="120" placeholder="Your card label">
    <div class="grid2"><div><label for="cb">Current balance</label><input id="cb" type="number" step="0.01" value="0"></div><div><label for="cl">Credit limit</label><input id="cl" type="number" min="0" step="0.01" value="0"></div></div>
    <label for="ca">APR (%)</label><input id="ca" type="number" min="0" step="0.01" value="0"><button id="cadd" class="primary wfull mt10">Add card</button></div>
  <h2>Other debt</h2>
  <div class="panel">
    ${row('Owed', 'Tracked separately from card balances and scheduled bills', `<div class="amt">${money(S.parents.owed - S.parents.paid)}</div>`)}
    <div class="grid2"><div><label for="po">Original amount owed</label><input id="po" type="number" min="0" step="0.01" value="${S.parents.owed}"></div><div><label for="pp">Paid so far</label><input id="pp" type="number" min="0" step="0.01" value="${S.parents.paid}"></div></div><button id="ppsave" class="wfull mt10">Save other debt</button>
  </div>`;
}

function vGoal() {
  const f = monthlyFixed(), s = S.settings;
  const runway = f.total ? Math.max(0, s.checking / f.total) : 0;
  const target = f.total * s.goalMonths, pct = target ? s.checking / target * 100 : 0;
  const ms = [
    { t: 'Checking balance entered', on: s.checkingAsOf !== '2000-01-01' },
    { t: 'Monthly costs or spending caps entered', on: f.total > 0 },
    { t: 'Target date chosen', on: s.goalDate !== '2000-01-01' },
    { t: `${s.goalMonths} months of planned costs covered`, on: target > 0 && s.checkingAsOf !== '2000-01-01' && s.checking >= target },
  ];
  const done = ms.filter(m => m.on).length;
  return `
  <h1>Goal</h1>
  <p class="sub">Plan a cash cushion using the costs you enter. Target: ${s.goalMonths} months${s.goalDate !== '2000-01-01' ? ` by ${fmt(s.goalDate)}` : '; choose a date below'}.</p>
  <div class="panel">
    <div class="tiny">Estimated months covered by checking</div>
    <div class="big ${f.total > 0 ? (runway >= s.goalMonths ? 'good' : runway >= 1 ? 'warn' : 'bad') : ''}">${f.total > 0 && s.checkingAsOf !== '2000-01-01' ? runway.toFixed(1) : '—'}</div>
    ${f.total > 0 ? bar(pct, pct < 34 ? 'bad' : pct < 67 ? 'warn' : '') : '<p class="note">Enter monthly costs in Bills or spending caps in Spend to calculate a target.</p>'}
    <div class="note">${money(s.checking)} in checking toward ${money(target)}. Monthly planning estimate ${money(f.total)}: rent ${money(f.rent)}, next 90 days of unpaid bills divided by three ${money(f.debt)}, and spending caps ${money(f.caps)}.</div>
    <div class="note">This estimate depends on the bills and caps you've entered; it is not a measured spending average. Avoid including the same rent or purchase in both bills and caps.</div>
    <div class="grid2 mt8"><div><label for="gm">Months to bank</label><input id="gm" type="number" min="1" max="24" step="1" value="${s.goalMonths}"></div><div><label for="gd">Target date</label><input id="gd" type="date" value="${s.goalDate === '2000-01-01' ? '' : s.goalDate}"></div></div>
    <button class="wfull mt8" id="gsave">Save goal</button>
  </div>
  <h2>Milestones · ${done} of ${ms.length}</h2>
  <div class="panel">${ms.map(m => `<div class="ms"><div class="box ${m.on ? 'on' : ''}">${m.on ? '✓' : ''}</div><div><div class="n">${esc(m.t)}</div>${m.d ? `<div class="d">${esc(m.d)}</div>` : ''}</div></div>`).join('')}</div>
  ${vSourceSummary()}`;
}

// ---------- wiring ----------
function change(fn, message) {
  try { fn(); } catch (error) { toast(describe(error), 5000); return; }
  const pending = save(); render();
  pending.then(result => { if (result !== false && message) toast(message); });
}
function setCheckingBalance(amount, asOf) {
  S.settings.checking = amount;
  S.settings.checkingAsOf = asOf;
  // A new baseline includes prior posted payments; undoing their status must not inflate it.
  S.bills.filter(b => b.paid).forEach(b => { b.checkingAdjustment = 0; delete b.checkingAdjustedOn; });
}
function snapshotCanReplaceChecking(account) {
  const lastAdjustment = S.bills.filter(b => b.paid && b.checkingAdjustment > 0).map(b => b.checkingAdjustedOn || today()).sort().at(-1);
  return account.asOf >= S.settings.checkingAsOf && (!lastAdjustment || account.asOf > lastAdjustment);
}
function wire() {
  const on = (sel, ev, fn) => document.querySelectorAll(sel).forEach(el => el.addEventListener(ev, fn));
  const num = sel => Number($(sel).value);
  on('#toYah', 'click', () => api.showYah().catch(error => toast(describe(error))));
  on('#reloadState', 'click', loadState);
  on('#retryLoad', 'click', loadState);
  on('#backupExport', 'click', async e => {
    const button = e.currentTarget; button.disabled = true;
    try { await saving; const result = await api.exportBackup(); if (!result?.canceled) toast('Backup download started'); }
    catch (error) { loadError = describe(error); render(); }
    finally { button.disabled = false; }
  });
  on('#backupRestore', 'click', async e => {
    const button = e.currentTarget; button.disabled = true;
    try {
      await saving; const result = await api.restoreBackup();
      if (!result || result.canceled || !result.state) return;
      S = result.state; loadError = null; billAction = null; editingTxn = null; importReport = null;
      ledgerFilter.month = ledgerMonths()[0] || ''; render(); toast('Backup restored');
    } catch (error) { loadError = describe(error); render(); }
    finally { button.disabled = false; }
  });
  on('#requestStorage', 'click', async e => {
    const button = e.currentTarget; button.disabled = true;
    try { const result = await api.requestPersistence(); toast(result === true || result?.persisted ? 'Browser storage retention enabled. Keep backups too.' : 'Browser retention was not enabled. Keep exported backups.', 6000); }
    catch (error) { toast(describe(error), 5000); }
    finally { button.disabled = false; }
  });
  on('[data-go]', 'click', e => { view = e.currentTarget.dataset.go; render(); window.scrollTo(0, 0); });
  on('#saveChk', 'click', () => { if (num('#buf') < 0) return toast('Buffer must be zero or more'); change(() => { setCheckingBalance(num('#chk') || 0, today()); S.settings.buffer = num('#buf') || 0; }, 'Balance updated'); });
  on('#qadd', 'click', () => { const a = num('#qa'); if (!(a > 0) || !$('#qd').value || !$('#qc').value) return toast('Enter a positive amount, date and category'); change(() => S.txns.push({ id: uid(), date: $('#qd').value, amt: a, cat: $('#qc').value, who: $('#qw').value.trim().slice(0, 120), note: $('#qn').value.slice(0, 120) }), 'Purchase saved to caps'); });
  on('[data-edit-txn]', 'click', e => { editingTxn = e.currentTarget.dataset.editTxn; render(); $('#txnEditor')?.scrollIntoView({ block: 'start' }); });
  on('#cancelTxn', 'click', () => { editingTxn = null; render(); });
  on('#saveTxn', 'click', () => { const t = S.txns.find(t => t.id === editingTxn); if (!t) return; const amount = num('#teAmount'); if (!Number.isFinite(amount) || !amount || !$('#teDate').value) return toast('Enter a nonzero amount and date'); change(() => { Object.assign(t, { amt: amount, date: $('#teDate').value, cat: $('#teCategory').value, note: $('#teNote').value.trim(), who: $('#teAccount').value.trim() }); editingTxn = null; }, 'Cap entry updated'); });
  on('[data-pay]', 'click', e => { billAction = e.currentTarget.dataset.pay; render(); $('.bill-action')?.scrollIntoView({ block: 'nearest' }); });
  on('#cancelBillAction', 'click', () => { billAction = null; render(); });
  on('#saveBill', 'click', () => { const b = S.bills.find(b => b.id === billAction); if (!b || !$('#beName').value.trim() || !(num('#beAmount') > 0) || !$('#beDate').value) return toast('Enter a name, positive amount and date'); change(() => { Object.assign(b, { name: $('#beName').value.trim(), amt: num('#beAmount'), date: $('#beDate').value, note: $('#beNote').value.trim() }); billAction = null; }, 'Bill updated'); });
  on('#removeBill', 'click', () => { const b = S.bills.find(b => b.id === billAction); if (b && confirm(`Remove scheduled bill ${b.name}?`)) change(() => { S.bills = S.bills.filter(b => b.id !== billAction); billAction = null; }, 'Bill removed'); });
  on('[data-paid-mode]', 'click', e => { const b = S.bills.find(x => x.id === billAction); if (!b || b.paid) return; const subtract = e.currentTarget.dataset.paidMode === 'subtract'; change(() => { b.paid = true; b.checkingAdjustment = subtract ? b.amt : 0; if (subtract) b.checkingAdjustedOn = today(); else delete b.checkingAdjustedOn; S.settings.checking -= b.checkingAdjustment; billAction = null; }, 'Payment recorded'); });
  on('[data-unpay]', 'click', e => { const b = S.bills.find(x => x.id === e.currentTarget.dataset.unpay); if (!b) return; const adjustment = b.checkingAdjustment || 0; if (confirm(`Mark "${b.name}" unpaid? ${adjustment ? `${cash(adjustment)} will be added back to checking.` : 'The current checking balance will stay the same.'}`)) change(() => { b.paid = false; S.settings.checking += adjustment; b.checkingAdjustment = 0; delete b.checkingAdjustedOn; }, 'Marked unpaid'); });
  on('#badd', 'click', () => { const a = num('#ba'), n = $('#bn').value.trim(); if (!(a > 0) || !n || !$('#bd').value) return; change(() => S.bills.push({ id: uid(), date: $('#bd').value, name: n, amt: a, paid: false, note: $('#bo').value }), 'Bill added'); });
  on('#ssave', 'click', () => { const payDays = [...new Set($('#spd').value.split(',').map(x => x.trim()).filter(Boolean).map(Number))]; if (payDays.length > 4 || payDays.some(d => !Number.isInteger(d) || d < 1 || d > 31) || num('#sp') < 0 || num('#sr') < 0 || !Number.isInteger(num('#srd')) || num('#srd') < 1 || num('#srd') > 31) return toast('Use nonnegative amounts and up to four calendar pay days (1–31)', 5000); change(() => { const s = S.settings; s.payAmt = num('#sp') || 0; s.payDays = payDays; s.rent = num('#sr') || 0; s.rentDay = num('#srd'); }, 'Income & rent saved'); });
  on('[data-cap]', 'change', e => { const value = Number(e.target.value); if (!Number.isFinite(value) || value < 0) { e.target.value = S.caps[e.target.dataset.cap]; return toast('Cap must be zero or more'); } change(() => { S.caps[e.target.dataset.cap] = value; }); });
  on('[data-del]', 'click', e => change(() => { const txn = S.txns.find(t => t.id === e.currentTarget.dataset.del); if (!txn) return; const sourceId = txn.monarchId || txn.id; if (ledger().some(t => t.id === sourceId)) { const exclusions = S.monarch.excludedCaps ||= []; if (!exclusions.includes(sourceId)) exclusions.push(sourceId); } S.txns = S.txns.filter(t => t.id !== txn.id); }, 'Removed from caps'));
  on('[data-restore-cap]', 'click', e => { const t = ledger().find(t => t.id === e.currentTarget.dataset.restoreCap); if (!t?.capCategory || !['expense', 'refund'].includes(t.kind)) return; change(() => { S.monarch.excludedCaps = (S.monarch.excludedCaps || []).filter(id => id !== t.id); if (!S.txns.some(p => p.id === t.id || p.monarchId === t.id)) S.txns.push({ id: t.id, date: t.date, amt: -t.amount, cat: t.capCategory, who: (t.account || '').slice(0, 120), note: (t.merchant || '').slice(0, 120) }); }, 'Restored to spending caps'); });
  on('[data-cancel]', 'click', e => { const k = decodeURIComponent(e.currentTarget.dataset.cancel); change(() => { const i = S.cancelled.indexOf(k); i < 0 ? S.cancelled.push(k) : S.cancelled.splice(i, 1); }); });
  on('#spendMonth', 'change', e => { if (e.target.value) spendMonth = e.target.value; render(); });
  on('[data-spend-shift]', 'click', e => { spendMonth = shiftMonth(spendMonth || today().slice(0, 7), Number(e.currentTarget.dataset.spendShift)); render(); });
  on('#spendCurrent', 'click', () => { spendMonth = today().slice(0, 7); render(); });
  on('#ledgerFilters', 'toggle', e => { ledgerFiltersOpen = e.currentTarget.open; });
  for (const [selector, key] of [['#ledgerMonth', 'month'], ['#ledgerAccount', 'account'], ['#ledgerCategory', 'category'], ['#ledgerFrom', 'from'], ['#ledgerTo', 'to']]) on(selector, 'change', e => { ledgerFilter[key] = e.target.value; if (['category', 'from', 'to'].includes(key)) ledgerFiltersOpen = true; if (key === 'month') { ledgerFilter.from = ''; ledgerFilter.to = ''; } if (key === 'from' || key === 'to') ledgerFilter.month = ''; ledgerLimit = 100; render(); });
  on('#ledgerReview', 'change', e => { ledgerFilter.review = e.target.checked; ledgerFiltersOpen = true; ledgerLimit = 100; render(); });
  on('#ledgerSearch', 'input', e => { const at = e.target.selectionStart; ledgerFilter.query = e.target.value; ledgerFiltersOpen = true; ledgerLimit = 100; render(); $('#ledgerSearch').focus(); $('#ledgerSearch').setSelectionRange(at, at); });
  on('#ledgerMore', 'click', () => { ledgerLimit += 100; render(); });
  on('[data-trend-month]', 'click', e => { ledgerFilter.month = e.currentTarget.dataset.trendMonth; ledgerFilter.from = ''; ledgerFilter.to = ''; ledgerLimit = 100; render(); });
  on('[data-ledger-category]', 'click', e => { ledgerFilter.category = e.currentTarget.dataset.ledgerCategory; ledgerFiltersOpen = true; ledgerLimit = 100; render(); $('.ledger')?.scrollIntoView({ block: 'start' }); });
  on('[data-apply-checking]', 'click', e => { const a = monarch().accounts[Number(e.currentTarget.dataset.applyChecking)]; if (!a) return; if (!snapshotCanReplaceChecking(a)) return toast('This snapshot is older than your balance or may omit recorded payments. Enter the current balance on Today.', 6000); if (confirm(`Use ${a.name}: ${cash(a.balance)}, as of ${dateLabel(a.asOf)}, as Runway's checking balance? This replaces the forecast baseline; it does not mark bills paid.`)) change(() => setCheckingBalance(a.balance, a.asOf), 'Checking snapshot applied'); });
  on('[data-apply-card]', 'click', e => { const i = Number(e.currentTarget.dataset.applyCard), a = monarch().accounts[i], target = $('#cardTarget' + i).value; if (!a || target === '') return toast('Choose a Runway card first'); const card = S.cards[Number(target)], useLimit = $('#applyLimit' + i)?.checked; if (card && confirm(`Set ${card.name} to ${cash(a.balance)} from ${a.name}, as of ${dateLabel(a.asOf)}?${useLimit ? ` Also set its limit to ${cash(a.limit)}.` : ''} Statement bills and promo deadlines stay separate.`)) change(() => { card.bal = a.balance; if (useLimit) card.limit = a.limit; }, 'Card balance applied'); });
  on('[data-recurring-bill]', 'click', e => { const r = monarch().recurring[Number(e.currentTarget.dataset.recurringBill)]; if (!r) return; view = 'bills'; render(); $('#bd').value = r.nextDate; $('#ba').value = (-r.amount).toFixed(2); $('#bn').value = r.name; $('#bo').value = `Monarch recurring snapshot · ${r.frequency}${r.account ? ' · ' + r.account : ''} · Confirm this is due from checking; card purchases may already be covered by a card bill.`; $('#bn').scrollIntoView({ block: 'center' }); $('#bn').focus(); toast('Confirm payment is due from checking'); });
  on('#reviewRecurring', 'click', () => { view = 'monarch'; render(); const sections = document.querySelectorAll('.section-details'); if (sections[1]) { sections[1].open = true; sections[1].scrollIntoView({ block: 'start' }); } });
  on('#imp', 'click', async e => {
    e.currentTarget.disabled = true;
    try {
      await saving;
      const result = await api.importMonarch();
      if (!result || result.canceled || !result.state) return render();
      S = result.state; loadError = null; render();
      importReport = result.importType === 'balances' ? `Updated ${result.accountsUpdated} account snapshots. Apply any balance you want to use in your plan.` : `${result.ledgerAdded ?? result.added} ledger entries added; ${result.ledgerUpdated || 0} refreshed; ${Math.max(0, (result.ledgerDuplicates ?? result.duplicates ?? 0) - (result.ledgerUpdated || 0))} unchanged. Caps: ${result.added} added, ${result.purchasesUpdated || 0} updated, ${result.purchasesRemoved || 0} removed.${result.invalid ? ` ${result.invalid} invalid rows skipped.` : ''}`;
      render(); toast('Monarch import complete');
    } catch (error) { loadError = describe(error); render(); }
  });
  on('#impSnapshot', 'click', async e => { e.currentTarget.disabled = true; try { await saving; const result = await api.importMonarchSnapshot(); if (!result || result.canceled || !result.state) return render(); S = result.state; loadError = null; importReport = `${result.accountsUpdated} account snapshots and ${result.recurringUpdated} recurring items updated. Apply balances explicitly to change your plan.`; render(); toast('Snapshot imported'); } catch (error) { loadError = describe(error); render(); } });
  on('[data-dl]', 'click', e => { const d = S.deadlines.find(x => x.id === e.currentTarget.dataset.dl); if (d && confirm(`"${d.name}" fully paid? This removes the deadline.`)) change(() => { S.deadlines = S.deadlines.filter(x => x.id !== d.id); }, 'Deadline cleared'); });
  on('[data-card]', 'change', e => change(() => { S.cards[+e.target.dataset.card].bal = Number(e.target.value) || 0; }));
  on('#cadd', 'click', () => { const name = $('#cn').value.trim(); if (!name || num('#cl') < 0 || num('#ca') < 0) return toast('Enter a card name, nonnegative limit and APR'); if (S.cards.length >= 30) return toast('Card limit reached'); change(() => S.cards.push({ name, bal: num('#cb') || 0, limit: num('#cl') || 0, apr: num('#ca') || 0 }), 'Card added'); });
  on('[data-save-card]', 'click', e => { const i = Number(e.currentTarget.dataset.saveCard), name = $('#ceName' + i).value.trim(), limit = num('#ceLimit' + i), apr = num('#ceApr' + i); if (!name || limit < 0 || apr < 0) return toast('Enter a name, nonnegative limit and APR'); change(() => Object.assign(S.cards[i], { name, limit, apr }), 'Card details updated'); });
  on('[data-remove-card]', 'click', e => { const index = Number(e.currentTarget.dataset.removeCard); if (confirm(`Remove ${S.cards[index].name}? Scheduled bills and deadlines remain separate.`)) change(() => S.cards.splice(index, 1), 'Card removed'); });
  on('#dadd', 'click', () => { const name = $('#dn').value.trim(), date = $('#dd').value, amt = num('#da'); if (!name || !date || !(amt > 0) || num('#di') < 0) return toast('Enter a name, date and positive balance'); change(() => S.deadlines.push({ id: uid(), name, date, amt, interest: num('#di') || 0, note: $('#dnote').value.trim() }), 'Deadline added'); });
  on('#ppsave', 'click', () => { if (num('#po') < 0 || num('#pp') < 0 || num('#pp') > num('#po')) return toast('Paid amount must be between zero and original debt'); change(() => { S.parents.owed = num('#po') || 0; S.parents.paid = num('#pp') || 0; }, 'Other debt saved'); });
  on('#gsave', 'click', () => change(() => { S.settings.goalMonths = Math.min(24, Math.max(1, num('#gm') || 3)); if ($('#gd').value) S.settings.goalDate = $('#gd').value; }, 'Goal saved'));
  document.querySelectorAll('[role=button]').forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } }));
}

async function loadState() {
  try {
    await saving;
    const result = await api.getState();
    S = result.state; loadError = result.loadError; capabilities = result.capabilities || {};
    if (S) ledgerFilter.month = ledgerMonths()[0] || '';
    render();
  } catch (error) { loadError = describe(error); render(); }
}
loadState();
})();
