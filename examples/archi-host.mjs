// Minimal host adapter example; no existing ARCHi data is loaded.
import electron from 'electron';
import path from 'node:path';
import { registerRunwayScheme, createRunwayExtension } from '../src/electron-extension.mjs';
const { app, protocol, Menu } = electron;
app.setName('Runway host example');
app.setPath('userData', path.join(app.getPath('home'), '.runway-host-example'));
registerRunwayScheme(protocol);
await app.whenReady();
const runway = await createRunwayExtension({ electron,
  dataDirectory: path.join(app.getPath('userData'), 'extensions', 'runway'),
});
Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Tools', submenu: [
  { label: 'Runway', click: () => void runway.open() }, { type: 'separator' }, { role: 'quit' },
] }, { role: 'editMenu' }]));
let drained = false;
app.on('before-quit', event => {
  if (!drained) { event.preventDefault(); void runway.flush().then(() => { drained = true; app.quit(); }); }
});
app.on('window-all-closed', () => app.quit());
await runway.open();
