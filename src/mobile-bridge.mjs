import { createBrowserFinanceStore, decodeFinanceBackup } from './browser-store.mjs';
import { FINANCE_LIMITS } from './finance-schema.mjs';

let store, revision = 0, startupError = null;
try { store = await createBrowserFinanceStore(); }
catch (error) { startupError = 'Phone storage could not open. ' + error.message; }
const capabilities = Object.freeze({ storage: 'browser', openProjects: false, imports: false, backup: true });
function ready() { if (!store) throw new Error(startupError || 'Phone storage is unavailable.'); return store; }
async function getState() {
  if (!store) return { state: null, loadError: startupError, capabilities };
  const result = await store.getState(); revision = result.revision;
  return { ...result, capabilities };
}
function chooseBackup() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,application/json'; input.hidden = true;
    const finish = file => { input.remove(); resolve(file); };
    input.addEventListener('change', () => finish(input.files?.[0] || null), { once: true });
    input.addEventListener('cancel', () => finish(null), { once: true });
    document.body.append(input); input.click();
  });
}
window.runway = Object.freeze({
  getState,
  async save(next) {
    const result = await ready().save(next, revision); revision = result.revision; return result.state;
  },
  async exportBackup() {
    const text = await ready().exportBackup();
    const blob = new Blob([text], { type: 'application/json' }), url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url;
    link.download = `Runway-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return { saved: true };
  },
  async restoreBackup() {
    const file = await chooseBackup();
    if (!file) return { canceled: true };
    if (file.size > FINANCE_LIMITS.storeBytes + 4096) throw new Error('Choose a Runway JSON backup under 20 MB.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    decodeFinanceBackup(text);
    if (!window.confirm('Replace the Runway plan on this device with this backup? Export your current plan first if you need to keep it.')) return { canceled: true };
    const result = await ready().restoreBackup(text, revision, { confirmed: true });
    revision = result.revision; return result;
  },
  async requestPersistence() { return Boolean(await navigator.storage?.persist?.()); },
});

// Define the limited browser bridge before starting the shared interface.
await import('./finance-ui.js');

const status = { installed: false, error: null };
window.runwayOfflineStatus = () => ({ ...status });
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js', { scope: './' }).then(async () => {
    await navigator.serviceWorker.ready; status.installed = true;
  }).catch(error => { status.error = error.message; });
}
