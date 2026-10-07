import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const root = new URL('../', import.meta.url), output = new URL('dist/', root);
await mkdir(output, { recursive: true });
const sources = { 'index.html': 'mobile.html', 'finance.css': 'finance.css', 'finance-ui.js': 'finance-ui.js',
  'finance-schema.mjs': 'finance-schema.mjs', 'browser-store.mjs': 'browser-store.mjs', 'mobile-bridge.mjs': 'mobile-bridge.mjs',
  'manifest.webmanifest': 'manifest.webmanifest', 'icon.svg': 'icon.svg' };
const assets = new Map();
for (const [name, source] of Object.entries(sources)) assets.set(name, await readFile(new URL('src/' + source, root)));

// A tiny code-drawn launcher icon, with no external artwork or build dependency.
function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = x * 512 / size, py = y * 512 / size;
    const runway = py >= 148 && py < 364 && px >= 224 - (py - 148) * 80 / 216 && px < 288 + (py - 148) * 80 / 216;
    const center = py >= 190 && py < 365 && Math.abs(px - 256) < 10 && (Math.floor((py - 190) / 40) % 2 === 0);
    const color = center ? [21,23,28] : runway ? [143,179,230] : [21,23,28];
    const at = y * (size * 4 + 1) + 1 + x * 4;
    raw[at] = color[0]; raw[at+1] = color[1]; raw[at+2] = color[2]; raw[at+3] = 255;
  }
  const crc = data => { let c = 0xffffffff; for (const b of data) { c ^= b; for (let i=0;i<8;i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (name, bytes) => { const type = Buffer.from(name), length = Buffer.alloc(4), sum = Buffer.alloc(4); length.writeUInt32BE(bytes.length); sum.writeUInt32BE(crc(Buffer.concat([type,bytes]))); return Buffer.concat([length,type,bytes,sum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size,4); header[8]=8; header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
for (const size of [192, 512]) assets.set(`icon-${size}.png`, png(size));
const version = createHash('sha256'); for (const [name,bytes] of assets) { version.update(name); version.update(bytes); }
const cache = `runway-shell-${version.digest('hex').slice(0,16)}`;
const worker = `// Cache only public application assets. Financial records remain in IndexedDB.
const CACHE = ${JSON.stringify(cache)};
const FILES = ${JSON.stringify([...assets.keys()])};
const ROOT = new URL('./', self.location.href);
const ALLOWED = new Set(FILES.map(name => new URL(name, ROOT).href));
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  for (const name of FILES) {
    const url = new URL(name, ROOT).href, response = await fetch(url, {cache:'no-store',credentials:'same-origin'});
    if (!response.ok || response.redirected) throw new Error('Runway shell is not available for offline installation.');
    await cache.put(url, response);
  }
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith('runway-shell-') && name !== CACHE) await caches.delete(name);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== ROOT.origin || url.search) return;
  const isHome = event.request.mode === 'navigate' && [ROOT.pathname, new URL('index.html',ROOT).pathname].includes(url.pathname);
  if (!isHome && !ALLOWED.has(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE), key = isHome ? new URL('index.html',ROOT).href : url.href;
    const cached = await cache.match(key);
    return cached || fetch(event.request);
  })());
});
`;
assets.set('sw.js', Buffer.from(worker));
for (const [name, bytes] of assets) await writeFile(new URL(name, output), bytes);
console.log(`Built ${assets.size} mobile shell assets in dist; no user records included.`);
