import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRunwayExtension, registerRunwayScheme, RUNWAY_CSP, RUNWAY_URL } from '../src/electron-extension.mjs';

// All records and selected files below are invented, disposable test inputs.
function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

function mockElectron({ ready = true } = {}) {
  const handlers = new Map(), protocolHandlers = new Map(), windows = [], partitions = [], dialogs = [];
  const isolated = {
    protocol: {
      async isProtocolHandled(scheme) { return protocolHandlers.has(scheme); },
      handle(scheme, handler) {
        if (protocolHandlers.has(scheme)) throw new Error('Duplicate scheme');
        protocolHandlers.set(scheme, handler);
      },
      unhandle(scheme) { protocolHandlers.delete(scheme); },
    },
    setPermissionRequestHandler(handler) { this.requestPermission = handler; },
    setPermissionCheckHandler(handler) { this.checkPermission = handler; },
  };
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options; this.destroyed = false; this.minimized = false;
      this.shown = 0; this.focused = 0; this.restored = 0;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: '' };
      this.webContents.setWindowOpenHandler = handler => { this.popupHandler = handler; };
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; this.restored++; }
    show() { this.shown++; }
    focus() { this.focused++; }
    async loadURL(url) { this.webContents.mainFrame.url = url; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const electron = {
    app: { isReady: () => ready }, BrowserWindow,
    ipcMain: {
      handle(channel, handler) {
        if (handlers.has(channel)) throw new Error('Duplicate channel');
        handlers.set(channel, handler);
      },
      removeHandler(channel) { handlers.delete(channel); },
    },
    session: { fromPartition(name) { partitions.push(name); return isolated; } },
    dialog: {
      async showOpenDialog(window, options) {
        dialogs.push({ window, options });
        return electron.dialog.selection(window, options);
      },
      selection: () => ({ canceled: true, filePaths: [] }),
    },
  };
  return { electron, handlers, protocolHandlers, windows, partitions, isolated, dialogs };
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'runway-adapter-test-'));
  const mock = mockElectron();
  const extension = await createRunwayExtension({ electron: mock.electron, dataDirectory: directory, ...options });
  const window = await extension.open();
  t.after(async () => {
    await extension.dispose();
    const target = path.resolve(directory), base = path.resolve(tmpdir());
    if (!target.startsWith(`${base}${path.sep}`) || !path.basename(target).startsWith('runway-adapter-test-'))
      throw new Error('Refusing an unexpected test cleanup target.');
    await rm(target, { recursive: true, force: true });
  });
  const event = () => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  const invoke = (name, input, from = event()) => mock.handlers.get(`runway:${name}`)(from, input);
  return { ...mock, directory, extension, window, event, invoke, filename: path.join(directory, 'finance.json') };
}

test('adapter requires readiness, an explicit absolute directory, and a valid optional callback', async () => {
  const calls = [];
  registerRunwayScheme({ registerSchemesAsPrivileged: value => calls.push(value) });
  assert.deepEqual(calls, [[{ scheme: 'runway', privileges: { standard: true, secure: true } }]]);
  await assert.rejects(createRunwayExtension(), /after Electron is ready/);
  await assert.rejects(createRunwayExtension({ electron: mockElectron({ ready: false }).electron, dataDirectory: tmpdir() }), /after Electron is ready/);
  const mock = mockElectron();
  for (const dataDirectory of [undefined, '', 'relative-profile'])
    await assert.rejects(createRunwayExtension({ electron: mock.electron, dataDirectory }), /explicit absolute/);
  await assert.rejects(createRunwayExtension({ electron: mock.electron, dataDirectory: tmpdir(), onOpenProjects: true }), /must be a function/);
  assert.equal(mock.handlers.size, 0); assert.equal(mock.protocolHandlers.size, 0);
});

test('sandboxed window serves only interface assets with CSP and denies browser permissions and navigation', async t => {
  const f = await fixture(t);
  const preferences = f.window.options.webPreferences;
  assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.sandbox, true); assert.equal(preferences.webSecurity, true);
  assert.equal(preferences.session, f.isolated); assert.equal(path.basename(preferences.preload), 'preload.cjs');
  assert.deepEqual(f.partitions, ['runway-extension']);
  let permitted;
  f.isolated.requestPermission(null, 'media', value => { permitted = value; });
  assert.equal(permitted, false); assert.equal(f.isolated.checkPermission(null, 'notifications'), false);
  assert.deepEqual(f.window.popupHandler({ url: 'https://example.invalid' }), { action: 'deny' });
  let prevented = 0;
  for (const name of ['will-navigate', 'will-attach-webview'])
    f.window.webContents.emit(name, { preventDefault() { prevented++; } });
  assert.equal(prevented, 2);
  const serve = f.protocolHandlers.get('runway');
  for (const name of ['finance.html', 'finance.css', 'finance-ui.js']) {
    const response = await serve({ method: 'GET', url: `runway://app/${name}` });
    assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Security-Policy'), RUNWAY_CSP);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff'); assert((await response.text()).length > 0);
  }
  assert.match(RUNWAY_CSP, /connect-src 'none'/);
  for (const url of ['runway://other/finance.html', 'runway://app/finance.html?file=private',
    'runway://app/finance-data.mjs', 'runway://app/main.cjs', 'runway://app/finance.json', 'runway://app/%2e%2e/package.json'])
    assert.equal((await serve({ method: 'GET', url })).status, 404);
  assert.equal((await serve({ method: 'POST', url: RUNWAY_URL })).status, 404);
  assert.deepEqual(await readdir(f.directory), [], 'opening the interface does not seed a finance file');
  f.window.minimized = true;
  assert.equal(await f.extension.open(), f.window); assert.equal(f.windows.length, 1); assert.equal(f.window.restored, 1);
});

test('IPC requires its exact current main frame and rechecks ownership before deferred work', async t => {
  const f = await fixture(t);
  const state = await f.invoke('state');
  assert.equal(state.loadError, null); assert.deepEqual(state.state.txns, []);
  await assert.rejects(f.invoke('state', undefined, { sender: {}, senderFrame: f.window.webContents.mainFrame }), /inside Runway/);
  await assert.rejects(f.invoke('state', undefined, { sender: f.window.webContents, senderFrame: { url: RUNWAY_URL } }), /inside Runway/);
  const pending = f.invoke('save', state.state);
  f.window.webContents.mainFrame.url = 'runway://app/other.html';
  await assert.rejects(pending, /inside Runway/);
  await assert.rejects(f.invoke('state'), /inside Runway/);
  f.window.webContents.mainFrame.url = RUNWAY_URL;
  assert.deepEqual(await readdir(f.directory), []);
});

test('renderer-supplied import paths are ignored; cancellation preserves state and only native selections import', async t => {
  const f = await fixture(t);
  const initial = (await f.invoke('state')).state;
  await f.invoke('save', initial); const original = await readFile(f.filename);
  const rendererPath = path.join(f.directory, 'unselected.csv');
  await writeFile(rendererPath, 'Date,Amount\n2041-06-01,-999');
  for (const kind of ['import-csv', 'import-snapshot']) {
    assert.deepEqual(await f.invoke(kind, { filePath: rendererPath }), { canceled: true });
    assert.deepEqual(await readFile(f.filename), original);
  }
  assert.equal(f.dialogs.length, 2);
  assert(f.dialogs.every(call => call.window === f.window && call.options.properties.includes('openFile')));
  const nativePath = path.join(f.directory, 'selected.csv');
  await writeFile(nativePath, 'Date,Merchant,Category,Account,Amount,Id\n2041-06-01,Example Store,Groceries,Example Checking,-12,native-1');
  f.electron.dialog.selection = () => ({ canceled: false, filePaths: [nativePath] });
  const result = await f.invoke('import-csv', { filePath: rendererPath });
  assert.equal(result.state.monarch.transactions.length, 1);
  assert.equal(result.state.monarch.transactions[0].amount, -12);
  const snapshotPath = path.join(f.directory, 'selected.json');
  await writeFile(snapshotPath, JSON.stringify({ accounts: [{ name: 'Example Checking', type: 'checking', balance: 35, asOf: '2041-06-01' }] }));
  f.electron.dialog.selection = () => ({ canceled: false, filePaths: [snapshotPath] });
  const imported = await f.invoke('import-snapshot', { filePath: rendererPath });
  assert.equal(imported.state.monarch.accounts[0].balance, 35);
  assert.equal(imported.state.settings.checking, 0, 'an imported balance does not silently replace the plan');
});

test('a window retired during a native picker cannot import after selection', async t => {
  const f = await fixture(t);
  await f.invoke('save', (await f.invoke('state')).state); const original = await readFile(f.filename);
  const nativePath = path.join(f.directory, 'selected.csv');
  await writeFile(nativePath, 'Date,Amount\n2041-06-01,-12');
  const entered = deferred(), selection = deferred();
  f.electron.dialog.selection = () => { entered.resolve(); return selection.promise; };
  const pending = f.invoke('import-csv');
  await entered.promise;
  f.window.webContents.mainFrame.url = 'runway://app/retired.html';
  selection.resolve({ canceled: false, filePaths: [nativePath] });
  await assert.rejects(pending, /inside Runway/);
  assert.deepEqual(await readFile(f.filename), original);
});

test('optional project callback advertises its capability without exposing other host operations', async t => {
  let opened = 0;
  const f = await fixture(t, { onOpenProjects: () => { opened++; return 'host-projects'; } });
  assert.deepEqual((await f.invoke('state')).capabilities, { openProjects: true });
  assert.equal(await f.invoke('open-projects'), 'host-projects'); assert.equal(opened, 1);
  assert.equal(f.handlers.size, 5);
  const standalone = await fixture(t);
  assert.deepEqual((await standalone.invoke('state')).capabilities, { openProjects: false });
  await assert.rejects(standalone.invoke('open-projects'), /No project host/);
});

test('duplicate installation is rejected and disposal removes handlers, protocol, window and stale access', async t => {
  const f = await fixture(t);
  await assert.rejects(createRunwayExtension({ electron: f.electron, dataDirectory: f.directory }), /already installed/);
  assert.equal(f.handlers.size, 5); assert.equal(f.protocolHandlers.size, 1);
  const retainedHandler = f.handlers.get('runway:state'), oldEvent = f.event();
  await f.extension.dispose();
  assert.equal(f.handlers.size, 0); assert.equal(f.protocolHandlers.size, 0); assert.equal(f.window.isDestroyed(), true);
  await assert.rejects(retainedHandler(oldEvent), /inside Runway/);
  await assert.rejects(f.extension.open(), /disposed/);
  await f.extension.flush();
});
