#!/usr/bin/env node
// Valida la documentación de wallet/ (P01.T06.a), sin dependencias:
//  - anclas internas y links relativos (archivo y ancla) de todos los .md;
//  - IDs de especificación ([C-…], [B-…], [F-…], [W-…]) numerados definidos en el planner;
//  - ADR-0NN citados existen como archivo en docs/adr/ y en la tabla §4;
//  - tareas Pxx.Tyy citadas existen; cada tarea del planner tiene "Verificación:";
//  - cada fase del planner tiene todos sus campos y su CHECKPOINT completo.
// Imprime "DOCS OK" o la lista de errores (código 1).
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLANNER = join(ROOT, 'docs/PLANNER_WALLET_WEB.md');
// Dependencias de terceros (node_modules, contracts/dependencies de Soldeer) y artefactos no son documentación propia.
const SKIP_DIRS = new Set(['node_modules', '.tools', '.git', 'lib', 'dependencies', 'out', 'out-noopt', 'cache', 'cache-noopt', 'broadcast', 'dist', 'coverage', 'prompts', '.secrets', 'playwright-report', 'test-results', 'blob-report']);

export function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

const stripCode = (text) => text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');

function mdFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) mdFiles(p, out);
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

function headings(text) {
  const set = new Set();
  const counts = new Map();
  for (const m of stripCodeBlocks(text).matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const s = slug(m[1]);
    const n = counts.get(s) ?? 0;
    set.add(n ? `${s}-${n}` : s);
    counts.set(s, n + 1);
  }
  return set;
}
const stripCodeBlocks = (text) => text.replace(/```[\s\S]*?```/g, '');

export function checkDocs(root = ROOT) {
  const errors = [];
  const files = mdFiles(root);
  const cache = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
  const heads = new Map(files.map((f) => [f, headings(cache.get(f))]));

  // 1. Links internos y relativos.
  for (const f of files) {
    const text = stripCode(cache.get(f));
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [path, anchor] = target.split('#');
      const file = path ? resolve(dirname(f), decodeURIComponent(path)) : f;
      if (path && !existsSync(file)) {
        errors.push(`${relative(root, f)}: link roto a ${target}`);
        continue;
      }
      if (anchor && file.endsWith('.md')) {
        const h = heads.get(file) ?? headings(readFileSync(file, 'utf8'));
        if (!h.has(decodeURIComponent(anchor))) errors.push(`${relative(root, f)}: ancla inexistente #${anchor}${path ? ` en ${path}` : ''}`);
      }
    }
  }

  // 2. IDs, ADRs y tareas contra el planner.
  const planner = cache.get(PLANNER) ?? readFileSync(PLANNER, 'utf8');
  const specDefs = new Set([...planner.matchAll(/\*\*\[([CBFW]-[A-Z]+(?:-[0-9]+)?|W-[0-9]+)\]/g)].map((m) => m[1]));
  const taskDefs = new Set([...planner.matchAll(/\*\*(P\d\d\.T\d\d(?:\.[a-z])?)\*\*/g)].map((m) => m[1]));
  const adrTable = new Set([...planner.matchAll(/^\| (ADR-0\d\d) \|/gm)].map((m) => m[1]));
  const adrDir = join(root, 'docs/adr');
  const adrFiles = new Set(existsSync(adrDir) ? readdirSync(adrDir).map((n) => n.match(/^(ADR-0\d\d)-/)?.[1]).filter(Boolean) : []);
  for (const f of files) {
    const text = cache.get(f);
    const rel = relative(root, f);
    for (const m of text.matchAll(/\[([CBFW]-[A-Z]+-[0-9]+)\]/g)) if (!specDefs.has(m[1])) errors.push(`${rel}: ID de especificación no definido ${m[1]}`);
    for (const m of text.matchAll(/\b(P\d\d\.T\d\d(?:\.[a-z])?)\b/g)) if (!taskDefs.has(m[1])) errors.push(`${rel}: tarea no definida ${m[1]}`);
    for (const m of text.matchAll(/\bADR-0\d\d\b/g)) {
      if (!adrTable.has(m[0])) errors.push(`${rel}: ${m[0]} no está en la tabla §4 del planner`);
      if (adrFiles.size && !adrFiles.has(m[0])) errors.push(`${rel}: falta el archivo docs/adr/${m[0]}-*.md`);
    }
  }

  // 3. Estructura del planner.
  const parts = planner.split(/^### (P\d\d) — /m);
  const REQ = ['**Objetivo:**', '**Archivos/componentes:**', '**Dependencias:**', '**Implementación requerida:**', '**Tests a implementar:**', '**Checks manuales:**', '**Acceptance criteria:**', '**Security checks:**', '#### CHECKPOINT'];
  const CK = ['build pasa:', 'tests pasan:', 'security tests pasan:', 'integración anterior sigue funcionando:', 'documentación actualizada:', 'no secrets committed:', 'git status revisado:'];
  for (let i = 1; i < parts.length; i += 2) {
    const id = parts[i];
    const body = parts[i + 1].split('\n## 12.')[0];
    for (const r of REQ) if (!body.includes(r)) errors.push(`planner ${id}: falta ${r}`);
    if (!/\*\*Condici[oó]n (para pasar|de cierre)/.test(body)) errors.push(`planner ${id}: falta la condición de avance`);
    for (const code of ['TST', 'MAN', 'SEC']) if (!new RegExp(`^\\s*- \\[[ x]\\] \\*\\*${id}\\.${code}`, 'm').test(body)) errors.push(`planner ${id}: falta ${id}.${code}`);
    const ck = body.split('#### CHECKPOINT').at(-1);
    for (const c of CK) if (!new RegExp(`^- \\[[ x]\\] ${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\S`, 'm').test(ck)) errors.push(`planner ${id}: CHECKPOINT sin "${c}"`);
  }
  const lines = planner.split('\n');
  const TASK = /^- \[[ x]\] \*\*(P\d\d\.T\d\d(?:\.[a-z])?|P\d\d\.(?:TST|MAN|SEC)(?:\.[a-z])?)\*\*/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TASK);
    if (!m) continue;
    let k = i + 1;
    let found = false;
    while (k < lines.length && lines[k].startsWith('      ')) {
      if (lines[k].includes('Verificación:')) found = true;
      k++;
    }
    if (!found) errors.push(`planner: ${m[1]} sin línea "Verificación:"`);
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = checkDocs();
  if (errors.length) {
    for (const e of [...new Set(errors)]) console.error(`ERROR ${e}`);
    console.error(`${new Set(errors).size} error(es)`);
    process.exit(1);
  }
  console.log('DOCS OK');
}
