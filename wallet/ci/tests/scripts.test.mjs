// P02: gate de cobertura (parseo de lcov y umbrales) y mapeo de rutas cambiadas a áreas del gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize, THRESHOLDS } from '../scripts/coverage-gate.mjs';

const CI = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('coverage-gate suma sólo src/ (sin interfaces) y calcula porcentajes', () => {
  const lcov = [
    'TN:', 'SF:src/A.sol', 'LF:100', 'LH:96', 'BRF:20', 'BRH:19', 'end_of_record',
    'SF:src/interfaces/I.sol', 'LF:10', 'LH:0', 'BRF:0', 'BRH:0', 'end_of_record',
    'SF:test/T.sol', 'LF:50', 'LH:1', 'end_of_record',
    'SF:/abs/path/contracts/src/libraries/L.sol', 'LF:100', 'LH:100', 'BRF:0', 'BRH:0', 'end_of_record',
  ].join('\n');
  const s = summarize(lcov);
  assert.deepEqual(s.files.map((f) => f.file), ['src/A.sol', 'src/libraries/L.sol']);
  assert.equal(s.lines, 98);
  assert.equal(s.branches, 95);
  assert.deepEqual(THRESHOLDS, { lines: 95, branches: 90 });
});

test('match-areas respeta la semántica de * y ** de GitHub Actions', () => {
  const run = (input) => spawnSync('python3', ['-I', join(CI, 'scripts/match-areas.py'), join(CI, 'areas.json')], { input, encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
  assert.deepEqual(run('README.md\nsrc/index.ts\n'), []);
  assert.deepEqual(run('wallet/contracts/src/SecurityGuard.sol\n'), ['wallet-contracts', 'wallet-security']);
  assert.deepEqual(run('.github/workflows/wallet-signer.yml\n'), ['wallet-signer', 'wallet-security']);
  assert.deepEqual(run('.github/workflows/otro.yml\n'), []);
  assert.ok(run('wallet/frontend/recovery/src/main.tsx\n').includes('wallet-repro-build'));
});
