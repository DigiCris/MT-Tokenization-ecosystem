// PF-25 con Soldeer: foundry.toml y soldeer.lock consistentes (versión exacta, checksums o commit exacto).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, WALLET_ROOT } from './helpers.mjs';
import { declaredDependencies, lockedDependencies, soldeerProblems } from '../lib/soldeer.mjs';

const TOML = `[profile.default]\nsrc = "src"\n\n[dependencies]\nforge-std = "1.17.0"\n"@openzeppelin-contracts" = "5.6.1"\nsafe-smart-account = { version = "1.5.0", git = "https://github.com/safe-fndn/safe-smart-account.git", rev = "dc437e8fba8b4805d76bcbd1c668c9fd3d1e83be" }\n`;
const LOCK = (overrides = '') => `version = 2\n\n[[dependencies]]\nname = "forge-std"\nversion = "1.17.0"\nurl = "https://example/forge-std.zip"\nchecksum = "${'a'.repeat(64)}"\nintegrity = "${'b'.repeat(64)}"\n\n[[dependencies]]\nname = "@openzeppelin-contracts"\nversion = "5.6.1"\nurl = "https://example/oz.zip"\nchecksum = "${'c'.repeat(64)}"\nintegrity = "${'d'.repeat(64)}"\n\n[[dependencies]]\nname = "safe-smart-account"\nversion = "1.5.0"\ngit = "https://github.com/safe-fndn/safe-smart-account.git"\nrev = "dc437e8fba8b4805d76bcbd1c668c9fd3d1e83be"\n${overrides}`;

function project(lock, installed = ['forge-std-1.17.0', '@openzeppelin-contracts-5.6.1', 'safe-smart-account-1.5.0']) {
  const dir = tmp('mtw-soldeer-');
  writeFileSync(join(dir, 'foundry.toml'), TOML);
  if (lock !== null) writeFileSync(join(dir, 'soldeer.lock'), lock);
  for (const d of installed) mkdirSync(join(dir, 'dependencies', d), { recursive: true });
  return dir;
}

test('lee [dependencies] y soldeer.lock', () => {
  const d = declaredDependencies(TOML);
  assert.equal(d['@openzeppelin-contracts'].version, '5.6.1');
  assert.equal(d['safe-smart-account'].rev, 'dc437e8fba8b4805d76bcbd1c668c9fd3d1e83be');
  assert.equal(lockedDependencies(LOCK())['forge-std'].checksum, 'a'.repeat(64));
});

test('consistente → sin problemas', () => {
  assert.deepEqual(soldeerProblems(project(LOCK())), []);
});

test('falta soldeer.lock, versión distinta, sin checksum, commit distinto o sin instalar → problemas', () => {
  assert.deepEqual(soldeerProblems(project(null)), ['falta soldeer.lock']);
  assert.ok(soldeerProblems(project(LOCK().replace('version = "5.6.1"', 'version = "5.6.0"'))).some((p) => p.includes('5.6.0')));
  assert.ok(soldeerProblems(project(LOCK().replace(`checksum = "${'a'.repeat(64)}"`, ''))).some((p) => p.includes('checksum')));
  assert.ok(soldeerProblems(project(LOCK().replace('rev = "dc437e8fba8b4805d76bcbd1c668c9fd3d1e83be"', `rev = "${'0'.repeat(40)}"`))).some((p) => p.includes('commit')));
  assert.ok(soldeerProblems(project(LOCK(), ['forge-std-1.17.0'])).some((p) => p.includes('no instalada')));
});

test('el proyecto real de contratos es consistente', { skip: !existsSync(join(WALLET_ROOT, 'contracts/foundry.toml')) && 'contracts/ se crea en P03' }, () => {
  assert.deepEqual(soldeerProblems(join(WALLET_ROOT, 'contracts'), { requireInstalled: false }), []);
});
