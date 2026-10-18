// P02: gate de cobertura (parseo de lcov y umbrales) y mapeo de rutas cambiadas a áreas del gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RATE_LIMITED, summarize, THRESHOLDS } from '../scripts/coverage-gate.mjs';
import { compareBaseline, suppressedFindings } from '../scripts/slither-baseline.mjs';

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

test('coverage-gate y ci-contracts sólo reintentan ante un límite de ritmo del RPC del fork', () => {
  for (const out of [
    'Error: Failed to create fork: HTTP error 429 with body: {"code":429,"message":"Your app has exceeded its compute units per second capacity"}',
    'server returned an error response: error code 429: Too Many Requests',
  ]) assert.ok(RATE_LIMITED.test(out), out);
  for (const out of ['[FAIL: InsufficientOutput()] test_swap() (gas: 42934)', 'assertion failed: 1429 != 1430']) {
    assert.ok(!RATE_LIMITED.test(out), out);
  }
  const script = spawnSync('bash', ['-c', `grep -o "RATE_LIMITED='[^']*'" ${join(CI, 'scripts/ci-contracts.sh')}`], { encoding: 'utf8' }).stdout.trim();
  assert.equal(script, `RATE_LIMITED='${RATE_LIMITED.source}'`);
});

test('match-areas respeta la semántica de * y ** de GitHub Actions', () => {
  const run = (input) => spawnSync('python3', ['-I', join(CI, 'scripts/match-areas.py'), join(CI, 'areas.json')], { input, encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
  assert.deepEqual(run('README.md\nsrc/index.ts\n'), []);
  // Los tests de backend y signer despliegan los contratos en el fork: un cambio en src/ también los dispara.
  assert.deepEqual(run('wallet/contracts/src/SecurityGuard.sol\n'), ['wallet-contracts', 'wallet-backend', 'wallet-signer', 'wallet-security']);
  assert.deepEqual(run('wallet/contracts/test/unit/SecurityGuard.t.sol\n'), ['wallet-contracts', 'wallet-security']);
  assert.deepEqual(run('.github/workflows/wallet-signer.yml\n'), ['wallet-signer', 'wallet-security']);
  assert.deepEqual(run('.github/workflows/otro.yml\n'), []);
  assert.ok(run('wallet/frontend/recovery/src/main.tsx\n').includes('wallet-repro-build'));
});

test('slither-baseline: suprimidos = todos − visibles, ubicación estable y diferencias contra el baseline', () => {
  const fn = (contract, name) => ({ type: 'function', name, type_specific_fields: { parent: { name: contract } } });
  const variable = { type: 'variable', name: 'predecessor', type_specific_fields: { parent: { name: 'constructor', type_specific_fields: { parent: { name: 'SecurityGuard' } } } } };
  const all = [
    { id: 'a1', check: 'reentrancy-balance', impact: 'High', description: 'Reentrancy in X.swap() (src/X.sol#1-9):\n', elements: [fn('X', 'swap')] },
    { id: 'b2', check: 'missing-zero-check', impact: 'Low', description: 'G.constructor().predecessor (src/G.sol#3) lacks a zero-check', elements: [variable] },
    { id: 'c3', check: 'timestamp', impact: 'Low', description: 'visible', elements: [fn('T', 'f')] },
  ];
  const visible = [all[2]];
  const current = suppressedFindings(all, visible);
  assert.deepEqual(current.map((f) => [f.id, f.location]), [['b2', 'SecurityGuard.constructor.predecessor'], ['a1', 'X.swap']]);
  assert.equal(current[1].summary, 'Reentrancy in X.swap():');
  assert.deepEqual(compareBaseline(current, current), { added: [], removed: [] });
  const changed = compareBaseline([{ ...current[0], id: 'zz' }, current[1]], current);
  assert.deepEqual(changed.added.map((f) => f.id), ['zz']);
  assert.deepEqual(changed.removed.map((f) => f.id), ['b2']);
});
