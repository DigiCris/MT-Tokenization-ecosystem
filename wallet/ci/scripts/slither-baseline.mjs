#!/usr/bin/env node
// Baseline de hallazgos de Slither suprimidos en el código (P07.MAN, docs/security/slither-triage.md).
//
// Slither suprime un hallazgo si cualquiera de sus elementos cae en una línea con `slither-disable`, y agrupa en el
// mismo hallazgo los efectos posteriores a una llamada: una supresión puede absorber un problema nuevo sin que el gate
// (--fail-medium) lo vea. Este script obtiene los suprimidos (todos los hallazgos con --show-ignored-findings menos los
// visibles) y los compara por `id` (Slither lo calcula sin números de línea: cambia cuando cambia el código de la
// función afectada) con contracts/slither-suppressed.json. Cualquier diferencia falla: un suprimido nuevo o cambiado se
// revisa, se justifica en el triage y se actualiza el baseline.
//
// Uso (desde wallet/, con el proyecto ya compilado): node ci/scripts/slither-baseline.mjs check | update
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WALLET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONTRACTS = join(WALLET_ROOT, 'contracts');
const BASELINE = join(CONTRACTS, 'slither-suppressed.json');

function slither(extra) {
  const r = spawnSync(
    'slither',
    ['.', '--config-file', 'slither.config.json', '--ignore-compile', '--fail-none', '--json', '-', ...extra],
    { cwd: CONTRACTS, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(`slither terminó con ${r.status}: ${r.stderr.slice(-2000)}`);
  const out = JSON.parse(r.stdout);
  if (!out.success) throw new Error(`slither: ${out.error}`);
  return out.results?.detectors ?? [];
}

/** Resumen estable de un hallazgo (sin números de línea). */
export function summarize(d) {
  const fn = d.elements.find((e) => e.type === 'function');
  let location;
  if (fn) {
    location = `${fn.type_specific_fields?.parent?.name ?? ''}.${fn.name}`;
  } else {
    // p. ej. una variable: contrato.función.variable
    const first = d.elements[0];
    const parent = first?.type_specific_fields?.parent;
    location = [parent?.type_specific_fields?.parent?.name, parent?.name, first?.name].filter(Boolean).join('.');
  }
  return {
    id: d.id,
    check: d.check,
    impact: d.impact,
    location,
    summary: d.description.split('\n')[0].replace(/\s*\(src\/[^)]*\)/g, '').slice(0, 200),
  };
}

/** Suprimidos = todos − visibles (por id), ordenados de forma estable. */
export function suppressedFindings(all, visible) {
  const visibleIds = new Set(visible.map((d) => d.id));
  return all
    .filter((d) => !visibleIds.has(d.id))
    .map(summarize)
    .sort((a, b) => `${a.check}|${a.location}|${a.id}`.localeCompare(`${b.check}|${b.location}|${b.id}`));
}

/** Diferencias entre los suprimidos actuales y el baseline. */
export function compareBaseline(current, baseline) {
  const base = new Map(baseline.map((f) => [f.id, f]));
  const now = new Map(current.map((f) => [f.id, f]));
  return {
    added: current.filter((f) => !base.has(f.id)),
    removed: baseline.filter((f) => !now.has(f.id)),
  };
}

function main() {
  const mode = process.argv[2];
  if (mode !== 'check' && mode !== 'update') {
    console.error('uso: node ci/scripts/slither-baseline.mjs check | update');
    process.exit(2);
  }
  const current = suppressedFindings(slither(['--show-ignored-findings']), slither([]));
  if (mode === 'update') {
    writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`baseline actualizado: ${current.length} hallazgos suprimidos (contracts/slither-suppressed.json)`);
    return;
  }
  const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : [];
  const { added, removed } = compareBaseline(current, baseline);
  const byImpact = current.reduce((acc, f) => ({ ...acc, [f.impact]: (acc[f.impact] ?? 0) + 1 }), {});
  if (added.length || removed.length) {
    for (const f of added) console.error(`NUEVO suprimido [${f.impact}] ${f.check} en ${f.location} (${f.id.slice(0, 12)}): ${f.summary}`);
    for (const f of removed) console.error(`YA NO suprimido [${f.impact}] ${f.check} en ${f.location} (${f.id.slice(0, 12)})`);
    console.error('Revisar cada diferencia, justificarla en docs/security/slither-triage.md y correr: node ci/scripts/slither-baseline.mjs update');
    process.exit(1);
  }
  console.log(`SLITHER BASELINE OK: ${current.length} suprimidos (${Object.entries(byImpact).map(([k, v]) => `${v} ${k}`).join(', ')}), sin cambios`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (e) {
    console.error(`slither-baseline: ${e.message}`);
    process.exit(1);
  }
}
