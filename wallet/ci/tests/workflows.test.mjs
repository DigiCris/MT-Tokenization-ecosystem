// P02: los workflows wallet-* siguen las reglas de CI (acciones por SHA, permisos mínimos, sin
// pull_request_target, checkout sin credenciales persistidas) y sus filtros `paths` coinciden con
// ci/areas.json, que usa el gate de la protección de main.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WALLET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WF_DIR = join(WALLET_ROOT, '../.github/workflows');
const workflows = readdirSync(WF_DIR).filter((f) => /^wallet-.*\.yml$/.test(f));
const read = (f) => readFileSync(join(WF_DIR, f), 'utf8');
const areas = JSON.parse(readFileSync(join(WALLET_ROOT, 'ci/areas.json'), 'utf8')).areas;

/** Listas `paths:` bajo `push:` y `pull_request:` (formato de lista YAML simple). */
function pathFilters(text) {
  const out = {};
  let event = null;
  let inPaths = false;
  for (const line of text.split('\n')) {
    const ev = line.match(/^ {2}(push|pull_request):\s*$/);
    if (ev) { event = ev[1]; inPaths = false; continue; }
    if (/^ {2}\S/.test(line) || /^\S/.test(line)) { if (!ev) { event = /^ {2}/.test(line) ? null : event; } inPaths = false; }
    if (event && /^ {4}paths:\s*$/.test(line)) { inPaths = true; out[event] = []; continue; }
    if (inPaths) {
      const m = line.match(/^ {6}- "([^"]+)"\s*$/);
      if (m) out[event].push(m[1]);
      else inPaths = false;
    }
  }
  return out;
}

test('existen los 8 workflows del planner más el gate', () => {
  for (const f of ['contracts', 'backend', 'signer', 'frontend-wallet', 'frontend-recovery', 'security', 'e2e', 'repro-build', 'ci-gate']) {
    assert.ok(workflows.includes(`wallet-${f}.yml`), `falta wallet-${f}.yml`);
  }
});

test('acciones fijadas por SHA de commit (o acción local de wallet/ci/actions)', () => {
  const actionFiles = [...workflows.map((f) => join(WF_DIR, f)), join(WALLET_ROOT, 'ci/actions/setup-toolchain/action.yml')];
  for (const file of actionFiles) {
    for (const m of readFileSync(file, 'utf8').matchAll(/uses:\s*(\S+)/g)) {
      const ref = m[1];
      assert.ok(/^\.\/wallet\/ci\/actions\/[a-z-]+$/.test(ref) || /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(ref), `${file}: ${ref} no está fijada por SHA`);
    }
  }
});

test('permisos mínimos, sin pull_request_target y checkout sin credenciales persistidas', () => {
  for (const f of workflows) {
    const text = read(f);
    assert.match(text, /^permissions:\n {2}contents: read\n/m, `${f}: permissions por defecto`);
    assert.doesNotMatch(text, /pull_request_target/, `${f}: pull_request_target prohibido`);
    assert.doesNotMatch(text, /write-all|: write\b/, `${f}: permisos de escritura`);
    const checkouts = text.split('uses: actions/checkout@').length - 1;
    const persisted = (text.match(/persist-credentials: false/g) || []).length;
    assert.equal(persisted, checkouts, `${f}: cada checkout debe usar persist-credentials: false`);
    assert.match(text, /^concurrency:\n {2}group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/m, `${f}: concurrency por ref`);
  }
});

test('los filtros paths de cada workflow coinciden con ci/areas.json', () => {
  for (const [name, globs] of Object.entries(areas)) {
    const filters = pathFilters(read(`${name}.yml`));
    assert.deepEqual(filters.push, globs, `${name}: paths de push`);
    assert.deepEqual(filters.pull_request, globs, `${name}: paths de pull_request`);
  }
});

test('ningún workflow despliega ni usa secretos en el gate', () => {
  for (const f of workflows) {
    const text = read(f);
    assert.doesNotMatch(text, /\b(deploy|forge script .*--broadcast|docker push|ssh )/i, `${f}: no debe desplegar`);
  }
  assert.doesNotMatch(read('wallet-ci-gate.yml'), /secrets\./, 'el gate no usa secretos');
});
