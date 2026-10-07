/** Optional host adapter. Hosts must explicitly select a new data directory. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFinanceStore } from './finance-data.mjs';

const source = fileURLToPath(new URL('./', import.meta.url));
export const RUNWAY_URL = 'runway://app/finance.html';
const channels = ['state', 'save', 'import-csv', 'import-snapshot', 'open-projects'].map(name => `runway:${name}`);
const allowed = new Set(['finance.html', 'finance.css', 'finance-ui.js']);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
export const RUNWAY_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

/** Call once before Electron app.whenReady(). */
export function registerRunwayScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{ scheme: 'runway', privileges: { standard: true, secure: true } }]);
}

/** One Runway adapter per process; call after Electron is ready. */
export async function createRunwayExtension({ electron, dataDirectory, onOpenProjects } = {}) {
  if (!electron?.app?.isReady()) throw new Error('Create Runway after Electron is ready.');
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)) throw new Error('Choose an explicit absolute Runway data directory.');
  if (onOpenProjects !== undefined && typeof onOpenProjects !== 'function') throw new Error('onOpenProjects must be a function.');
  const { BrowserWindow, ipcMain, session, dialog } = electron;
  const isolated = session.fromPartition('runway-extension');
  if (isolated.protocol.isProtocolHandled && await isolated.protocol.isProtocolHandled('runway')) throw new Error('Runway is already installed in this process.');
  const store = await createFinanceStore(dataDirectory);
  let window = null, disposed = false;
  const pending = new Set();
  const capabilities = Object.freeze({ openProjects: Boolean(onOpenProjects) });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.protocol.handle('runway', async request => {
    const url = new URL(request.url), name = url.pathname.slice(1);
    if (request.method !== 'GET' || url.hostname !== 'app' || url.search || !allowed.has(name)) return new Response('Not found', { status: 404 });
    try { return new Response(await readFile(path.join(source, name)), { headers: {
      'Content-Type': types[path.extname(name)], 'Content-Security-Policy': RUNWAY_CSP, 'X-Content-Type-Options': 'nosniff',
    } }); } catch { return new Response('Not found', { status: 404 }); }
  });
  function guard(event) {
    if (disposed || !window || window.isDestroyed() || event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== RUNWAY_URL)
      throw new Error('This action is only available inside Runway.');
  }
  const register = (name, action) => ipcMain.handle(`runway:${name}`, async (event, input) => {
    guard(event);
    const operation = Promise.resolve().then(() => { guard(event); return action(event, input); });
    pending.add(operation);
    try { return await operation; } finally { pending.delete(operation); }
  });
  register('state', () => ({ ...store.snapshot(), capabilities }));
  register('save', (event, state) => store.save(state, () => guard(event)));
  async function importFile(event, kind) {
    const snapshot = kind === 'snapshot';
    const result = await dialog.showOpenDialog(window, { title: snapshot ? 'Import account snapshot' : 'Import Monarch CSV',
      properties: ['openFile'], filters: [{ name: snapshot ? 'JSON snapshot' : 'CSV export', extensions: [snapshot ? 'json' : 'csv'] }] });
    guard(event);
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    return snapshot ? store.importMonarchSnapshot(result.filePaths[0], () => guard(event)) : store.importMonarch(result.filePaths[0], () => guard(event));
  }
  register('import-csv', event => importFile(event, 'csv'));
  register('import-snapshot', event => importFile(event, 'snapshot'));
  register('open-projects', () => {
    if (!onOpenProjects) throw new Error('No project host is connected.');
    return onOpenProjects();
  });
  return Object.freeze({
    async open() {
      if (disposed) throw new Error('Runway has been disposed.');
      if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); return window; }
      window = new BrowserWindow({ title: 'Runway', width: 1060, height: 860, minWidth: 390, minHeight: 600,
        backgroundColor: '#111820', webPreferences: { preload: path.join(source, 'preload.cjs'),
          session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.on('will-attach-webview', event => event.preventDefault());
      window.on('closed', () => { window = null; });
      await window.loadURL(RUNWAY_URL);
      return window;
    },
    async flush() { await Promise.allSettled([...pending]); await store.flush(); },
    async dispose() {
      disposed = true;
      await Promise.allSettled([...pending]); await store.flush();
      for (const channel of channels) ipcMain.removeHandler(channel);
      isolated.protocol.unhandle('runway');
      if (window && !window.isDestroyed()) window.destroy();
    },
  });
}
