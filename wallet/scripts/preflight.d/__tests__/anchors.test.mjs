// P00.T07: toda ancla que el preflight cita en sus mensajes existe en SETUP_EXTERNAL_SERVICES.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WALLET_ROOT, setupSlugs } from './helpers.mjs';

function citedAnchors() {
  const dir = join(WALLET_ROOT, 'scripts/preflight.d');
  const files = [...readdirSync(join(dir, 'checks')).map((f) => join(dir, 'checks', f)), join(WALLET_ROOT, 'scripts/preflight'), join(dir, 'lib/report.mjs')];
  const anchors = new Set();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/anchor:\s*'([^']+)'/g)) anchors.add(m[1]);
    for (const m of src.matchAll(/_ANCHOR\s*=\s*'([^']+)'/g)) anchors.add(m[1]);
    for (const m of src.matchAll(/^\s+\w+:\s*'([a-z0-9_ó-]+(?:--[a-z0-9_-]+)*)',?$/gm)) if (/[_-]/.test(m[1])) anchors.add(m[1]);
    for (const m of src.matchAll(/SETUP_EXTERNAL_SERVICES\.md#([^\s)"'`]+)/g)) anchors.add(m[1]);
  }
  return anchors;
}

test('cada ancla citada por el preflight existe en SETUP_EXTERNAL_SERVICES.md', () => {
  const slugs = setupSlugs();
  const missing = [...citedAnchors()].filter((a) => !slugs.has(a));
  assert.deepEqual(missing, []);
});
