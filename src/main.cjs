const electron = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, protocol, Menu, dialog } = electron;
app.setName('Runway');
const testMode = process.env.RUNWAY_TEST_MODE === '1';
const dataDirectory = testMode && process.env.RUNWAY_TEST_PROFILE
  ? path.resolve(process.env.RUNWAY_TEST_PROFILE) : path.join(app.getPath('home'), '.runway');
app.setPath('userData', dataDirectory);
// Register synchronously, before app readiness; hosts can use registerRunwayScheme().
protocol.registerSchemesAsPrivileged([{ scheme: 'runway', privileges: { standard: true, secure: true } }]);
let extension, drained = false;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => void extension?.open());
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (extension && !drained) { event.preventDefault(); void extension.flush().then(() => { drained = true; app.quit(); }); }
  });
  app.whenReady().then(async () => {
    const { createRunwayExtension } = await import(pathToFileURL(path.join(__dirname, 'electron-extension.mjs')).href);
    extension = await createRunwayExtension({ electron, dataDirectory });
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Runway', submenu: [
      { label: 'Open Runway', click: () => void extension.open() }, { type: 'separator' }, { role: 'quit' },
    ] }, { role: 'editMenu' }, { role: 'viewMenu' }]));
    await extension.open();
  }).catch(error => { console.error(error.message); dialog.showErrorBox('Runway could not start', error.message); app.quit(); });
}
