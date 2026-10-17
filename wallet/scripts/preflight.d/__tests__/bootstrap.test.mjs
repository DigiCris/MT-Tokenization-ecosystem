// ADR-032: una descarga alterada (checksum distinto) aborta el bootstrap y se borra.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WALLET_ROOT, tmp } from './helpers.mjs';

const common = join(WALLET_ROOT, 'scripts/lib/common.sh');

test('verify_sha256 aborta y borra el archivo si el checksum no coincide', () => {
  const f = join(tmp(), 'descarga.tar.gz');
  writeFileSync(f, 'contenido alterado');
  const r = spawnSync('bash', ['-c', `source "${common}"; verify_sha256 "${f}" 0000000000000000000000000000000000000000000000000000000000000000`], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /checksum inválido/);
  assert.equal(existsSync(f), false);
});

test('verify_sha256 acepta el checksum correcto', () => {
  const f = join(tmp(), 'ok.bin');
  writeFileSync(f, 'abc');
  const r = spawnSync('bash', ['-c', `source "${common}"; verify_sha256 "${f}" ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad && echo OK`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK/);
});

test('verify_sri_sha512 aborta con integridad npm distinta', () => {
  const f = join(tmp(), 'pkg.tgz');
  writeFileSync(f, 'x');
  const r = spawnSync('bash', ['-c', `source "${common}"; verify_sri_sha512 "${f}" sha512-AAAA`], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /integridad inválida/);
});

test('versions.json fija exactamente las versiones exigidas (ADR-032)', () => {
  const v = JSON.parse(readFileSync(join(WALLET_ROOT, 'scripts/tools/versions.json'), 'utf8'));
  assert.equal(readFileSync(join(WALLET_ROOT, '.node-version'), 'utf8').trim(), v.node.version);
  assert.equal(JSON.parse(readFileSync(join(WALLET_ROOT, 'package.json'), 'utf8')).packageManager, `pnpm@${v.pnpm.version}`);
  assert.equal(v.foundry.version, 'v1.8.5');
  assert.equal(v.slither.version, '0.11.6');
  assert.equal(v.gitleaks.version, '8.30.1');
  for (const ref of [...Object.values(v.images), ...Object.values(v.securityImages)]) assert.match(ref, /@sha256:[0-9a-f]{64}$/);
  const compose = readFileSync(join(WALLET_ROOT, 'docker-compose.yml'), 'utf8');
  for (const ref of Object.values(v.images)) assert.ok(compose.includes(ref), `docker-compose.yml no usa ${ref}`);
});
