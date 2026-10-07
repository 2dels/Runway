import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// Disposable browser contexts and invented records only; never uses a normal browser profile.
const root = fileURLToPath(new URL('../', import.meta.url));
const distribution = path.join(root, 'dist');
const artifacts = path.join(root, '.runtime', `mobile-smoke-${randomUUID()}`);
const mount = '/Runway/'; // Also exercise a GitHub Pages project subpath.
const checks = [], errors = [], requests = [];
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
await access(path.join(distribution, 'index.html'));
await mkdir(artifacts, { recursive: true });
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (request.method !== 'GET' || !url.pathname.startsWith(mount)) {
      response.writeHead(404); response.end('Not found'); return;
    }
    const relative = decodeURIComponent(url.pathname.slice(mount.length)) || 'index.html';
    const filename = path.resolve(distribution, relative);
    if (!filename.startsWith(`${path.resolve(distribution)}${path.sep}`)) {
      response.writeHead(404); response.end('Not found'); return;
    }
    const bytes = await readFile(filename);
    response.writeHead(200, { 'Content-Type': mime[path.extname(filename)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache' });
    response.end(bytes);
  } catch { response.writeHead(404); response.end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const home = origin + mount;
let browser, context, page;
async function launchBrowser() {
  if (process.env.RUNWAY_CHROMIUM_EXECUTABLE)
    return chromium.launch({ headless: true, executablePath: process.env.RUNWAY_CHROMIUM_EXECUTABLE });
  const failures = [];
  for (const channel of process.platform === 'win32' ? ['chrome', 'msedge', undefined] : [undefined, 'chrome', 'msedge']) {
    try { return await chromium.launch({ headless: true, ...(channel ? { channel } : {}) }); }
    catch (error) { failures.push(`${channel ?? 'bundled Chromium'}: ${error.message.split('\n')[0]}`); }
  }
  throw new Error(`No installed Chromium browser could launch. ${failures.join('; ')}`);
}
async function newContext() {
  const created = await browser.newContext({ viewport: { width: 390, height: 844 },
    isMobile: true, hasTouch: true, deviceScaleFactor: 1, colorScheme: 'light', acceptDownloads: true });
  created.on('page', surface => {
    surface.setDefaultTimeout(20_000);
    surface.on('pageerror', error => errors.push(error.message));
    surface.on('request', request => requests.push(request.url()));
  });
  return created;
}
async function openHome(owner) {
  const surface = await owner.newPage();
  await surface.goto(home, { waitUntil: 'domcontentloaded' });
  await surface.waitForSelector('#qa');
  return surface;
}
async function reveal(locator) {
  const closed = locator.locator('xpath=ancestor::details[not(@open)]');
  while (await closed.count()) await closed.last().locator(':scope > summary').click();
}
const state = surface => surface.evaluate(() => window.runway.getState());
async function saved(predicate) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (predicate((await state(page)).state)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Expected mobile save did not complete.');
}
async function auditStore(surface) {
  await surface.evaluate(async () => {
    const { createBrowserFinanceStore } = await import('./browser-store.mjs');
    window.mobileAuditStore = await createBrowserFinanceStore();
  });
}
async function rawRecord(surface, operation, value) {
  return surface.evaluate(({ operation, value }) => new Promise((resolve, reject) => {
    const opening = indexedDB.open('runway-local', 1);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const database = opening.result;
      const transaction = database.transaction('finance', ['put', 'delete'].includes(operation) ? 'readwrite' : 'readonly');
      const store = transaction.objectStore('finance');
      const request = operation === 'put' ? store.put(value, 'current') : operation === 'delete' ? store.delete('current')
        : store.get(operation === 'previous' ? 'previous' : 'current');
      let result;
      request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => { database.close(); resolve(result); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  }), { operation, value });
}

try {
  browser = await launchBrowser();
  context = await newContext(); page = await openHome(context);
  const initial = await state(page);
  assert.equal(initial.loadError, null);
  for (const key of ['bills', 'cards', 'deadlines', 'txns']) assert.deepEqual(initial.state[key], []);
  assert.equal(initial.state.settings.checking, 0);
  assert.equal(await page.locator('#imp').count(), 0);
  assert.equal(await page.locator('#toYah').count(), 0);
  const appearance = await page.evaluate(() => ({
    scheme: getComputedStyle(document.documentElement).colorScheme,
    body: getComputedStyle(document.body).backgroundColor,
    overflow: document.documentElement.scrollWidth > innerWidth + 1,
  }));
  assert.match(appearance.scheme, /dark/);
  const rgb = appearance.body.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  assert(rgb && rgb.every(channel => channel < 100), 'mobile background must stay dark with a light OS preference');
  assert.equal(appearance.overflow, false, '390px mobile page must not scroll sideways');
  const quickBox = await page.locator('#qadd').boundingBox();
  assert(quickBox && quickBox.y + quickBox.height <= 844, 'the quick purchase action must fit on the first mobile screen');
  await page.setViewportSize({ width: 360, height: 844 });
  for (const name of ['today', 'bills', 'spend', 'monarch', 'debt', 'goal']) {
    await page.locator(`[data-v="${name}"]`).click();
    const layout = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      smallButtons: [...document.querySelectorAll('button')].filter(button => {
        const rect = button.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.height < 43.5;
      }).map(button => button.id || button.getAttribute('aria-label') || button.textContent.trim()),
    }));
    assert.equal(layout.overflow, false, `${name} must fit a 360px viewport`);
    assert.deepEqual(layout.smallButtons, [], `${name} visible buttons must have at least 44px touch height`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-v="today"]').click();
  await page.screenshot({ path: path.join(artifacts, 'empty-dark-mobile.png'), fullPage: true });
  checks.push('empty isolated mobile profile, explicit dark theme under light OS, narrow layout');

  await reveal(page.locator('#chk'));
  await page.locator('#chk').fill('1200.50'); await page.locator('#buf').fill('100');
  await page.locator('#saveChk').click(); await saved(value => value.settings.checking === 1200.5);
  await page.locator('#qa').fill('12.50'); await page.locator('#qn').fill('Synthetic mobile purchase');
  await reveal(page.locator('#qw'));
  await page.locator('#qw').fill('Example cash'); await page.locator('#qadd').click();
  await saved(value => value.txns.length === 1);
  assert.equal((await state(page)).state.settings.checking, 1200.5);
  await page.locator('[data-v="debt"]').click();
  await page.locator('#cn').fill('Example mobile card'); await page.locator('#cb').fill('200');
  await page.locator('#cl').fill('1000'); await page.locator('#ca').fill('12');
  await page.locator('#cadd').click(); await saved(value => value.cards.length === 1);
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('#qa');
  const persisted = (await state(page)).state;
  assert.equal(persisted.settings.checking, 1200.5); assert.equal(persisted.txns[0].amt, 12.5);
  assert.equal(persisted.cards[0].bal, 200);
  checks.push('mobile checking, cap purchase and card debt save through UI and persist after reload');

  const other = await openHome(context);
  const firstCopy = await state(page), staleCopy = await state(other);
  firstCopy.state.settings.buffer = 110; staleCopy.state.settings.buffer = 999;
  await page.evaluate(value => window.runway.save(value), firstCopy.state);
  const staleError = await other.evaluate(async value => {
    try { await window.runway.save(value); return null; } catch (error) { return error.message; }
  }, staleCopy.state);
  assert(staleError, 'a stale second tab must be refused instead of replacing the first tab');
  assert.equal((await state(page)).state.settings.buffer, 110);
  await other.close();
  checks.push('second-tab stale save rejected without losing the first tab update');

  await auditStore(page);
  const backup = await page.evaluate(() => window.mobileAuditStore.exportBackup());
  assert.equal(JSON.parse(backup).schema, 'runway-backup/v1');
  const beforeRestore = await rawRecord(page, 'get');
  const backupChecks = await page.evaluate(async text => {
    const store = window.mobileAuditStore, { revision } = await store.getState();
    const attempt = async (...args) => { try { await store.restoreBackup(...args); return false; } catch { return true; } };
    return {
      cancelled: await attempt(text, revision, { confirmed: false }),
      malformed: await attempt('{not-json', revision, { confirmed: true }),
      wrongSchema: await attempt(JSON.stringify({ schema: 'other/v1', state: {} }), revision, { confirmed: true }),
      invalidState: await attempt(JSON.stringify({ schema: 'runway-backup/v1', exportedAt: new Date().toISOString(), state: {} }), revision, { confirmed: true }),
    };
  }, backup);
  assert(Object.values(backupChecks).every(Boolean));
  assert.deepEqual(await rawRecord(page, 'get'), beforeRestore);
  const restored = await page.evaluate(async text => {
    const store = window.mobileAuditStore;
    let current = await store.getState(); current.state.settings.checking = 25;
    await store.save(current.state, current.revision); current = await store.getState();
    return store.restoreBackup(text, current.revision, { confirmed: true });
  }, backup);
  assert.equal(restored.state.settings.checking, 1200.5);
  assert(restored.revision > beforeRestore.revision);
  checks.push('backup export, cancelled/invalid restore preservation and confirmed validated restore');

  // Exercise the actual mobile download/file-picker bridge as well as the store contract.
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('#qa');
  await reveal(page.locator('#backupExport'));
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#backupExport').click()]);
  const downloadPath = await download.path(); assert(downloadPath);
  const downloaded = await readFile(downloadPath, 'utf8');
  assert.equal(JSON.parse(downloaded).schema, 'runway-backup/v1');
  const beforeCancel = await rawRecord(page, 'get');
  page.once('dialog', dialog => dialog.dismiss());
  const [cancelChooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#backupRestore').click()]);
  await cancelChooser.setFiles({ name: 'synthetic-backup.json', mimeType: 'application/json', buffer: Buffer.from(downloaded) });
  await page.waitForFunction(() => !document.getElementById('backupRestore').disabled);
  assert.deepEqual(await rawRecord(page, 'get'), beforeCancel);
  const altered = (await state(page)).state; altered.settings.checking = 30;
  await page.evaluate(value => window.runway.save(value), altered);
  page.once('dialog', dialog => dialog.accept());
  const [restoreChooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#backupRestore').click()]);
  await restoreChooser.setFiles({ name: 'synthetic-backup.json', mimeType: 'application/json', buffer: Buffer.from(downloaded) });
  await saved(value => value.settings.checking === 1200.5);
  checks.push('mobile backup downloads restore through the real file picker; cancelled confirmation changes nothing');

  const corruptContext = await newContext(), corruptPage = await openHome(corruptContext);
  const corrupt = { schema: 'runway-browser-record/v1', revision: 4, state: { syntheticCorruptMarker: true } };
  await rawRecord(corruptPage, 'put', corrupt);
  await corruptPage.reload({ waitUntil: 'domcontentloaded' });
  await corruptPage.waitForFunction(async () => Boolean((await window.runway?.getState())?.loadError));
  const broken = await state(corruptPage);
  assert.equal(broken.state, null); assert(broken.loadError);
  const blockedSave = await corruptPage.evaluate(async value => {
    try { await window.runway.save(value); return false; } catch { return true; }
  }, initial.state);
  assert.equal(blockedSave, true); assert.deepEqual(await rawRecord(corruptPage, 'get'), corrupt);
  assert.equal(await corruptPage.locator('#backupExport').count(), 0);
  corruptPage.once('dialog', dialog => dialog.dismiss());
  const [cancelRepair] = await Promise.all([corruptPage.waitForEvent('filechooser'), corruptPage.locator('#backupRestore').click()]);
  await cancelRepair.setFiles({ name: 'synthetic-backup.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
  await corruptPage.waitForFunction(() => !document.getElementById('backupRestore').disabled);
  assert.deepEqual(await rawRecord(corruptPage, 'get'), corrupt);
  corruptPage.once('dialog', dialog => dialog.accept());
  const [repairChooser] = await Promise.all([corruptPage.waitForEvent('filechooser'), corruptPage.locator('#backupRestore').click()]);
  await repairChooser.setFiles({ name: 'synthetic-backup.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
  await corruptPage.waitForSelector('#qa');
  assert.deepEqual(await rawRecord(corruptPage, 'previous'), corrupt);
  assert.equal((await state(corruptPage)).state.settings.checking, 1200.5);
  await rawRecord(corruptPage, 'delete');
  await corruptPage.reload({ waitUntil: 'domcontentloaded' });
  await corruptPage.waitForFunction(async () => Boolean((await window.runway?.getState())?.loadError));
  assert.equal((await state(corruptPage)).state, null, 'missing current with prior history must not silently reseed');
  assert.deepEqual(await rawRecord(corruptPage, 'previous'), corrupt);
  await corruptContext.close();
  checks.push('corrupt IndexedDB blocks saves; real backup repair/cancel retains prior bytes; missing current never silently reseeds');

  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('#qa');
  await page.evaluate(() => Promise.race([navigator.serviceWorker.ready,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Offline worker did not become ready.')), 20_000))]));
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('#qa');
  assert(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)));
  const registration = await page.evaluate(async () => {
    const item = await navigator.serviceWorker.ready;
    return { scope: item.scope, script: item.active?.scriptURL };
  });
  assert.equal(registration.scope, home); assert.equal(registration.script, home + 'sw.js');
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('#qa');
  assert.equal((await state(page)).state.settings.checking, 1200.5);
  await page.locator('#qa').fill('3.25'); await page.locator('#qn').fill('Synthetic offline purchase');
  await reveal(page.locator('#qw'));
  await page.locator('#qw').fill('Example cash'); await page.locator('#qadd').click();
  await saved(value => value.txns.length === 2);
  await page.screenshot({ path: path.join(artifacts, 'offline-mobile.png'), fullPage: true });
  await context.setOffline(false); await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('#qa');
  assert.equal((await state(page)).state.txns.length, 2);
  checks.push('project-subpath PWA controls the page, reloads offline and persists offline edits');

  assert.deepEqual(errors, [], 'browser must not raise unhandled page errors');
  assert(requests.every(url => url.startsWith(origin) || /^(?:blob:|data:)/.test(url)), 'the mobile app must not request an external service');
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ ok: true, checks, browser: browser.version(), errors }, null, 2));
  console.log(JSON.stringify({ ok: true, checks, artifacts }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ ok: false, checks, error: error.message, errors }, null, 2));
  console.error(error); process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
