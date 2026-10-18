#!/usr/bin/env node
// Gate de cobertura de contratos (P02.T02): corre `forge coverage` en wallet/contracts y exige
// ≥ 95 % de líneas y ≥ 90 % de ramas sobre src/ (las interfaces no tienen código ejecutable).
// Uso: node ci/scripts/coverage-gate.mjs contracts [--lcov <archivo existente>]
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const THRESHOLDS = { lines: 95, branches: 90 };
const WALLET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** Falla por límite de ritmo del RPC del fork (compartido con otros jobs de CI): se reintenta la corrida. */
export const RATE_LIMITED = /HTTP error 429|error code 429|429 Too Many|too many requests|compute units per second|rate limit/i;
const COVERAGE_ATTEMPTS = 3;

/** Agrega un reporte lcov por archivo (sólo `src/`, sin `src/interfaces/`). */
export function summarize(lcov) {
  const files = [];
  let cur = null;
  for (const raw of lcov.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) cur = { file: line.slice(3), lf: 0, lh: 0, brf: 0, brh: 0 };
    else if (!cur) continue;
    else if (line.startsWith('LF:')) cur.lf = Number(line.slice(3));
    else if (line.startsWith('LH:')) cur.lh = Number(line.slice(3));
    else if (line.startsWith('BRF:')) cur.brf = Number(line.slice(4));
    else if (line.startsWith('BRH:')) cur.brh = Number(line.slice(4));
    else if (line === 'end_of_record') {
      const f = cur.file.replace(/^.*?(?=src\/)/, '');
      if (f.startsWith('src/') && !f.startsWith('src/interfaces/')) files.push({ ...cur, file: f });
      cur = null;
    }
  }
  const total = files.reduce((a, f) => ({ lf: a.lf + f.lf, lh: a.lh + f.lh, brf: a.brf + f.brf, brh: a.brh + f.brh }), { lf: 0, lh: 0, brf: 0, brh: 0 });
  const pct = (h, t) => (t === 0 ? 100 : (100 * h) / t);
  return { files, total, lines: pct(total.lh, total.lf), branches: pct(total.brh, total.brf), pct };
}

function main() {
  const [area, flag, lcovArg] = process.argv.slice(2);
  if (area !== 'contracts') {
    console.error('uso: coverage-gate.mjs contracts [--lcov <archivo>]');
    process.exit(2);
  }
  const dir = join(WALLET_ROOT, 'contracts');
  let lcovPath = flag === '--lcov' ? resolve(lcovArg) : join(dir, 'coverage/lcov.info');
  if (flag !== '--lcov') {
    mkdirSync(join(dir, 'coverage'), { recursive: true });
    for (let attempt = 1; ; attempt++) {
      const r = spawnSync('forge', ['coverage', '--report', 'lcov', '--report-file', lcovPath, '--no-match-coverage', '(test|script|dependencies)/'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: process.env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      process.stdout.write(r.stdout ?? '');
      process.stderr.write(r.stderr ?? '');
      if (r.status === 0) break;
      // Sólo un 429 del RPC del fork se reintenta (con espera creciente); cualquier otra falla corta.
      if (attempt >= COVERAGE_ATTEMPTS || !RATE_LIMITED.test(`${r.stdout ?? ''}${r.stderr ?? ''}`)) {
        console.error('forge coverage falló');
        process.exit(1);
      }
      console.error(`forge coverage: límite de ritmo del RPC del fork, reintento ${attempt}/${COVERAGE_ATTEMPTS - 1}`);
      spawnSync('sleep', [String(attempt * 30)]);
    }
  }
  const s = summarize(readFileSync(lcovPath, 'utf8'));
  if (s.files.length === 0) {
    console.error('el reporte no incluye archivos de src/');
    process.exit(1);
  }
  console.log('\nArchivo                                   Líneas            Ramas');
  for (const f of s.files) {
    const l = `${s.pct(f.lh, f.lf).toFixed(2)} % (${f.lh}/${f.lf})`;
    const b = `${s.pct(f.brh, f.brf).toFixed(2)} % (${f.brh}/${f.brf})`;
    console.log(`${f.file.padEnd(42)}${l.padEnd(18)}${b}`);
  }
  console.log(`${'TOTAL src/'.padEnd(42)}${`${s.lines.toFixed(2)} %`.padEnd(18)}${s.branches.toFixed(2)} %`);
  const fails = [];
  if (s.lines < THRESHOLDS.lines) fails.push(`líneas ${s.lines.toFixed(2)} % < ${THRESHOLDS.lines} %`);
  if (s.branches < THRESHOLDS.branches) fails.push(`ramas ${s.branches.toFixed(2)} % < ${THRESHOLDS.branches} %`);
  if (fails.length) {
    console.error(`COBERTURA INSUFICIENTE: ${fails.join('; ')}`);
    process.exit(1);
  }
  console.log(`COBERTURA OK (líneas ≥ ${THRESHOLDS.lines} %, ramas ≥ ${THRESHOLDS.branches} %)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
