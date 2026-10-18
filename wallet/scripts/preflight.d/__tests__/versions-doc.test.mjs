// P01.T01–T02: docs/VERSIONS.md refleja exactamente scripts/tools/versions.json (versiones, checksums por
// plataforma, mínimos del sistema e imágenes por digest) y no contiene rangos de versión.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WALLET_ROOT } from './helpers.mjs';

const versions = JSON.parse(readFileSync(join(WALLET_ROOT, 'scripts/tools/versions.json'), 'utf8'));
const doc = readFileSync(join(WALLET_ROOT, 'docs/VERSIONS.md'), 'utf8');
const rows = doc.split('\n').filter((l) => l.startsWith('| ') && !/^\|[-| ]+\|$/.test(l));

function rowFor(label) {
  const row = rows.find((l) => l.split('|')[1].trim().startsWith(label));
  assert.ok(row, `falta la fila "${label}" en docs/VERSIONS.md`);
  return row;
}

test('versiones y checksums de la toolchain local coinciden con versions.json', () => {
  const tools = [
    ['Node.js', versions.node.version, Object.values(versions.node.dist).map((d) => d.sha256)],
    ['pnpm', versions.pnpm.version, [versions.pnpm.integrity]],
    ['Foundry', versions.foundry.version, Object.values(versions.foundry.dist).map((d) => d.sha256)],
    ['gitleaks', versions.gitleaks.version, Object.values(versions.gitleaks.dist).map((d) => d.sha256)],
    ['Slither', versions.slither.version, [versions.slither.pipWheel.sha256]],
  ];
  for (const [label, version, hashes] of tools) {
    const row = rowFor(label);
    assert.equal(row.split('|')[2].trim(), version, `versión de ${label}`);
    for (const h of hashes) assert.ok(row.includes(h), `${label}: falta el checksum ${h.slice(0, 16)}…`);
  }
  assert.ok(rowFor('Slither').includes(`pip ${versions.slither.pipWheel.version}`), 'versión del wheel de pip');
});

test('los mínimos del sistema de PF-01 están documentados', () => {
  const m = versions.minimums;
  assert.ok(doc.includes(`bash ≥ ${m.bash}, git ≥ ${m.git}, python ≥ ${m.python}`));
});

test('toda imagen fijada en versions.json figura con el mismo digest', () => {
  const refs = [versions.images, versions.testImages, versions.securityImages, versions.fallbackImages]
    .flatMap((group) => Object.entries(group).filter(([k]) => !k.startsWith('$')).map(([, ref]) => ref));
  assert.ok(refs.length >= 11);
  for (const ref of refs) {
    assert.match(ref, /^[a-z0-9./-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/, `referencia sin digest: ${ref}`);
    assert.ok(doc.includes(`\`${ref}\``), `falta ${ref.split('@')[0]} en docs/VERSIONS.md`);
  }
});

test('ninguna columna de versión usa rangos ni "latest"', () => {
  for (const row of rows) {
    const cells = row.split('|').slice(1, -1).map((c) => c.trim());
    for (const cell of cells) {
      assert.doesNotMatch(cell, /(^|\s)[\^~]\d|^latest$|@latest|\bx\.x\b|\d+\.x\b/, `rango de versión en: ${row}`);
    }
  }
});
