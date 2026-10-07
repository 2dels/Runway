import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { FINANCE_SEED, validateFinance } from '../src/finance-data.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const allowed = new Set([
  '.gitignore', '.nvmrc', '.github/workflows/test.yml', 'LICENSE', 'README.md', 'PRIVACY.md', 'THIRD_PARTY_NOTICES.md',
  'package.json', 'package-lock.json', 'extension.json', 'docs/ARCHI-INTEGRATION.md', 'examples/archi-host.mjs',
  'src/finance-data.mjs', 'src/local-store.mjs', 'src/finance.html', 'src/finance.css', 'src/finance-ui.js',
  'src/preload.cjs', 'src/main.cjs', 'src/electron-extension.mjs', 'scripts/launch.mjs', 'scripts/check-release.mjs',
  'test/finance-data.test.mjs', 'test/local-store.test.mjs', 'test/electron-extension.test.mjs', 'test/smoke.mjs',
  'src/finance-schema.mjs', 'src/browser-store.mjs', 'src/mobile-bridge.mjs', 'src/mobile.html', 'src/icon.svg',
  'src/manifest.webmanifest', 'scripts/build-mobile.mjs', 'test/browser-store.test.mjs', 'test/mobile-smoke.mjs', 'docs/MOBILE.md',
]);
let files;
try {
  const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().replaceAll('\\', '/').toLowerCase();
  if (gitRoot !== root.replace(/[\\/]+$/, '').replaceAll('\\', '/').toLowerCase()) throw new Error('Not an independent Git checkout yet.');
  files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
} catch {
  const walk = async directory => (await Promise.all((await readdir(new URL(directory, new URL('../', import.meta.url)), { withFileTypes: true }))
    .filter(item => !['.git', '.runtime', 'node_modules'].includes(item.name))
    .map(item => item.isDirectory() ? walk(directory + item.name + '/') : directory + item.name))).flat();
  files = await walk('');
}
assert(files.length > 0, 'A release must contain source files.');
for (const file of files) {
  assert(allowed.has(file), `Unexpected release file: ${file}`);
  const contents = await readFile(new URL(file, new URL('../', import.meta.url)), 'utf8');
  // Deliberately no personal source-value denylist: those values must never ship.
  assert(!/[A-Z]:[\\/](?:Users|Documents and Settings)[\\/][^\s"']+/i.test(contents), `Absolute user path in ${file}`);
  assert(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(contents), `Private key in ${file}`);
  assert(!/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-proj-[A-Za-z0-9_-]{30,})\b/.test(contents), `Credential pattern in ${file}`);
  assert(!/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(contents), `Email address in ${file}`);
}
validateFinance(FINANCE_SEED);
for (const key of ['bills', 'deadlines', 'cards', 'cancelled', 'txns']) assert.deepEqual(FINANCE_SEED[key], [], `Empty ${key} required`);
assert(!FINANCE_SEED.monarch, 'Imported records must not be seeded');
assert.deepEqual(FINANCE_SEED.settings.payDays, []);
for (const key of ['checking', 'buffer', 'payAmt', 'rent']) assert.equal(FINANCE_SEED.settings[key], 0);
assert.equal(FINANCE_SEED.parents.owed, 0); assert.equal(FINANCE_SEED.parents.paid, 0);
assert(Object.values(FINANCE_SEED.caps).every(value => value === 0));
console.log(`Release boundary passed: ${files.length} allowlisted text files; empty financial defaults; no credential, email, or absolute user path patterns.`);
