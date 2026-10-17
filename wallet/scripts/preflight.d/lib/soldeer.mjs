// Verificación de dependencias Solidity fijadas con Soldeer (PF-25): cada entrada de `[dependencies]` de
// foundry.toml tiene en soldeer.lock la misma versión y, según su origen, checksum + integrity (registry)
// o el mismo commit (git). Lector mínimo de TOML para estas dos formas, sin dependencias externas.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const unquote = (s) => s.trim().replace(/^"(.*)"$/, '$1');

/** `[dependencies]` de foundry.toml → { nombre: { version, git?, rev? } }. */
export function declaredDependencies(foundryToml) {
  const deps = {};
  let inDeps = false;
  for (const raw of foundryToml.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    if (line.startsWith('[')) {
      inDeps = line === '[dependencies]';
      continue;
    }
    if (!inDeps) continue;
    const m = line.match(/^("?[^"=]+"?)\s*=\s*(.+)$/);
    if (!m) continue;
    const name = unquote(m[1]);
    const value = m[2].trim();
    if (value.startsWith('{')) {
      const fields = {};
      for (const f of value.replace(/^\{|\}$/g, '').split(',')) {
        const kv = f.match(/^\s*([a-z_]+)\s*=\s*(.+?)\s*$/);
        if (kv) fields[kv[1]] = unquote(kv[2]);
      }
      deps[name] = fields;
    } else {
      deps[name] = { version: unquote(value) };
    }
  }
  return deps;
}

/** Entradas `[[dependencies]]` de soldeer.lock → { nombre: { version, url?, checksum?, integrity?, git?, rev? } }. */
export function lockedDependencies(lockText) {
  const deps = {};
  let cur = null;
  for (const raw of lockText.split('\n')) {
    const line = raw.trim();
    if (line === '[[dependencies]]') {
      cur = {};
      continue;
    }
    const m = line.match(/^([a-z_]+)\s*=\s*(.+)$/);
    if (!m || !cur) continue;
    cur[m[1]] = unquote(m[2]);
    if (m[1] === 'name') deps[cur.name] = cur;
  }
  return deps;
}

/** Problemas de consistencia entre foundry.toml, soldeer.lock y `dependencies/` instaladas. */
export function soldeerProblems(dir, { requireInstalled = true } = {}) {
  const problems = [];
  if (!existsSync(join(dir, 'soldeer.lock'))) return ['falta soldeer.lock'];
  const declared = declaredDependencies(readFileSync(join(dir, 'foundry.toml'), 'utf8'));
  const locked = lockedDependencies(readFileSync(join(dir, 'soldeer.lock'), 'utf8'));
  if (!Object.keys(declared).length) problems.push('foundry.toml sin [dependencies]');
  for (const [name, d] of Object.entries(declared)) {
    const l = locked[name];
    if (!l) {
      problems.push(`${name} no está en soldeer.lock`);
      continue;
    }
    if (!/^\d+\.\d+\.\d+$/.test(d.version ?? '')) problems.push(`${name}: versión no exacta en foundry.toml`);
    if (l.version !== d.version) problems.push(`${name}: soldeer.lock fija ${l.version}, foundry.toml pide ${d.version}`);
    if (d.git) {
      if (!/^[0-9a-f]{40}$/.test(d.rev ?? '')) problems.push(`${name}: dependencia git sin commit exacto`);
      if (l.git !== d.git || l.rev !== d.rev) problems.push(`${name}: repo o commit distinto en soldeer.lock`);
    } else if (!/^[0-9a-f]{64}$/.test(l.checksum ?? '') || !/^[0-9a-f]{64}$/.test(l.integrity ?? '')) {
      problems.push(`${name}: sin checksum/integrity en soldeer.lock`);
    }
    if (requireInstalled && !existsSync(join(dir, 'dependencies', `${name}-${d.version}`))) {
      problems.push(`${name}: no instalada (forge soldeer install)`);
    }
  }
  for (const name of Object.keys(locked)) if (!declared[name]) problems.push(`${name}: en soldeer.lock pero no declarada`);
  return problems;
}
