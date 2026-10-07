import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const profile = path.join(root, '.runtime', `smoke-${randomUUID()}`);
await mkdir(profile, { recursive: true });
const errors = [], requests = [], checks = [];
const date = new Date().toLocaleDateString('en-CA');
let app, page;
async function launch() {
  const env = { ...process.env, RUNWAY_TEST_MODE: '1', RUNWAY_TEST_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: electronPath, args: [path.join(root, 'src/main.cjs')], cwd: root, env });
  app.on('window', surface => {
    surface.on('pageerror', error => errors.push(error.message));
    surface.on('request', request => requests.push(request.url()));
  });
  page = await app.firstWindow(); page.setDefaultTimeout(30000);
  await page.waitForURL('runway://app/finance.html');
  await page.waitForSelector('#qa');
  assert.equal(path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))), profile);
}
async function state() { return (await page.evaluate(() => window.runway.getState())).state; }
async function saved(predicate) {
  // Fixed test predicates run in Node, not inside the renderer's restricted CSP.
  const check = Function('s', `return (${predicate})`), deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (check(await state())) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.fail(`Save did not complete: ${predicate}`);
}
const nav = name => page.locator(`[data-v="${name}"]`).click();
async function openImports() { await page.locator('details').filter({ has: page.locator('#imp') }).locator('summary').first().click(); }
try {
  await launch();
  const initial = await state();
  for (const key of ['bills', 'cards', 'deadlines', 'txns']) assert.equal(initial[key].length, 0);
  assert.equal(initial.settings.checking, 0);
  assert.equal(await page.locator('#toYah').count(), 0);
  assert((await page.locator('#app').innerText()).includes('Set up your checking forecast'));
  await page.screenshot({ path: path.join(root, '.runtime', 'runway-empty.png') });
  checks.push('empty local profile and honest first-run interface');

  await page.locator('.balance-editor summary').click();
  await page.locator('#chk').fill('1234.50'); await page.locator('#buf').fill('150'); await page.locator('#saveChk').click();
  await saved('s.settings.checking === 1234.5');
  await page.locator('#qa').fill('12.50'); await page.locator('#qn').fill('Synthetic workshop purchase');
  await page.locator('.purchase-options summary').click();
  await page.locator('#qw').fill('Example cash'); await page.locator('#qadd').click();
  await saved('s.txns.length === 1');
  assert.equal((await state()).settings.checking, 1234.5);
  await nav('spend');
  await page.locator('[data-edit-txn]').first().click(); await page.locator('#teAmount').fill('13.50');
  await page.locator('#saveTxn').click(); await saved('s.txns[0].amt === 13.5');
  checks.push('checking setup and editable cap-only purchase');

  await nav('bills');
  await page.locator('#sp').fill('2000'); await page.locator('#spd').fill('5,20');
  await page.locator('#sr').fill('500'); await page.locator('#srd').fill('1'); await page.locator('#ssave').click();
  await saved('s.settings.payAmt === 2000');
  await page.locator('#bn').fill('Synthetic scheduled bill'); await page.locator('#ba').fill('40');
  await page.locator('#bd').fill(date); await page.locator('#badd').click(); await saved('s.bills.length === 1');
  await page.locator('[data-pay]').first().click(); await page.locator('[data-paid-mode="subtract"]').click();
  await saved('s.bills[0].paid && s.settings.checking === 1194.5');
  checks.push('income schedule, bill creation and explicit checking payment');

  await nav('debt');
  await page.locator('#cn').fill('Example card'); await page.locator('#cb').fill('500');
  await page.locator('#cl').fill('2000'); await page.locator('#ca').fill('12');
  await page.locator('#cadd').click(); await saved('s.cards.length === 1');
  await page.locator('#po').fill('800'); await page.locator('#pp').fill('100');
  await page.locator('#ppsave').click(); await saved('s.parents.owed === 800 && s.parents.paid === 100');
  await page.locator('#dn').fill('Example payment deadline'); await page.locator('#dd').fill('2041-06-01');
  await page.locator('#da').fill('100'); await page.locator('#dadd').click(); await saved('s.deadlines.length === 1');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(root, '.runtime', 'runway-debt.png') });
  checks.push('new cards, other debt and payment deadlines');

  await nav('monarch');
  await openImports();
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await page.locator('#imp').click(); await page.waitForSelector('#imp:not([disabled])', { state: 'attached' });
  assert.equal((await state()).cards.length, 1);
  const csv = path.join(profile, 'synthetic-import.csv');
  await writeFile(csv, 'Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags,Transaction ID\n2041-05-01,Example Market,Groceries,Example checking,Example Market,Synthetic fixture,-23.45,,fixture-001\n');
  await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, csv);
  await openImports();
  await page.locator('#imp').click(); await saved('s.monarch?.transactions.length === 1');
  await openImports();
  await page.locator('#imp').click(); await page.waitForSelector('#imp:not([disabled])', { state: 'attached' });
  assert.equal((await state()).monarch.transactions.length, 1);
  const imported = await state();
  assert.equal(imported.settings.checking, 1194.5);
  checks.push('native import cancellation, synthetic CSV and duplicate import protection');
  await app.close(); app = null;

  await launch();
  const restarted = await state();
  assert.deepEqual(restarted, imported);
  assert.equal(JSON.parse(await readFile(path.join(profile, 'finance.json'), 'utf8')).cards.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(profile, 'finance.backup.json'), 'utf8')).cards.length, 1);
  assert.deepEqual(errors, []);
  assert(!requests.some(url => /^https?:/.test(url)), 'The interface must not request remote content');
  checks.push('cold restart, previous-save backup, no page errors or remote content requests');
  console.log(JSON.stringify({ passed: checks, profile: '.runtime/smoke-<disposable>', screenshots: ['.runtime/runway-empty.png', '.runtime/runway-debt.png'] }, null, 2));
} finally { if (app) await app.close(); }
