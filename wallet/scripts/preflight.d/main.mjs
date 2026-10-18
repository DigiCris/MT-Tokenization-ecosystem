#!/usr/bin/env node
// Preflight de wallet/ (P00): detect → auto-remediar → verificar. Imprime exactamente
// "PREFLIGHT PASSED" si todo lo obligatorio pasa; si no, STOP con qué falta, variable, cómo
// obtenerla y documento interno, y sale con código ≠ 0. Nunca imprime valores de variables.
//
// Uso: node scripts/preflight.d/main.mjs [--env local|staging|production] [--json] [--no-fix]
//                                        [--only PF-01,PF-13] [--env-file <ruta>]
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parseEnv, readEnvFile } from './lib/env.mjs';
import { run } from './lib/proc.mjs';
import { render, fail, PASS, FAIL } from './lib/report.mjs';
import { systemChecks } from './checks/system.mjs';
import { configChecks } from './checks/config.mjs';
import { chainChecks } from './checks/chain.mjs';
import { externalChecks } from './checks/external.mjs';

export const WALLET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Orden de ejecución: primero lo que habilita al resto (toolchain, .env, secretos, Docker).
export const ORDER = ['PF-01', 'PF-02', 'PF-03', 'PF-04', 'PF-05', 'PF-06', 'PF-07', 'PF-10', 'PF-11', 'PF-12', 'PF-09', 'PF-27', 'PF-28', 'PF-13', 'PF-14', 'PF-15', 'PF-16', 'PF-17', 'PF-18', 'PF-19', 'PF-20', 'PF-21', 'PF-22', 'PF-30', 'PF-31', 'PF-32', 'PF-08', 'PF-23', 'PF-24', 'PF-25', 'PF-26', 'PF-29'];

export function allChecks() {
  const byId = new Map([...systemChecks, ...configChecks, ...chainChecks, ...externalChecks].map((c) => [c.id, c]));
  return ORDER.map((id) => {
    const c = byId.get(id);
    if (!c) throw new Error(`check ${id} no definido`);
    return c;
  });
}

function parseArgs(argv) {
  const out = { env: null, json: false, fix: true, only: null, envFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--no-fix') out.fix = false;
    else if (a === '--env') out.env = argv[++i];
    else if (a.startsWith('--env=')) out.env = a.slice(6);
    else if (a === '--only') out.only = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--env-file') out.envFile = argv[++i];
    else if (a === '--') continue;
    else throw new Error(`argumento desconocido: ${a}`);
  }
  return out;
}

/** Variables conocidas (de .env.example) que pueden venir del entorno del proceso (CI). */
function knownKeys(root) {
  const example = join(root, '.env.example');
  return existsSync(example) ? Object.keys(parseEnv(readFileSync(example, 'utf8'))) : [];
}

/** .env + overrides del proceso (`processEnv`, por defecto process.env) + convención <VAR>_FILE (ADR-030). */
export function loadEnv(envFile, root = WALLET_ROOT, { processEnv = process.env } = {}) {
  const fileEnv = readEnvFile(envFile) ?? {};
  const env = { ...fileEnv };
  for (const k of knownKeys(root)) if (processEnv[k] !== undefined && processEnv[k] !== '') env[k] = processEnv[k];
  for (const [k, val] of Object.entries({ ...env, ...processEnv })) {
    if (!k.endsWith('_FILE') || !val) continue;
    const base = k.slice(0, -5);
    if (!env[base] && existsSync(val)) env[base] = readFileSync(val, 'utf8').trim();
  }
  return env;
}

export function makeContext({ envName, fix, envFile, root = WALLET_ROOT, log, processEnv = process.env }) {
  const repoRoot = run('git', ['rev-parse', '--show-toplevel'], { cwd: root }).stdout.trim() || resolve(root, '..');
  const ctx = {
    root,
    repoRoot,
    envName,
    fix,
    envFile,
    versions: JSON.parse(readFileSync(join(root, 'scripts/tools/versions.json'), 'utf8')),
    chainConfig: JSON.parse(readFileSync(join(root, 'config/chains/base-mainnet.json'), 'utf8')),
    env: loadEnv(envFile, root, { processEnv }),
    log: log ?? ((m) => process.stderr.write(m + '\n')),
  };
  ctx.reloadEnv = () => {
    ctx.env = loadEnv(envFile, root, { processEnv });
  };
  return ctx;
}

export async function runChecks(ctx, checks) {
  const results = [];
  for (const c of checks) {
    if (c.envs && !c.envs.includes(ctx.envName)) {
      results.push({ id: c.id, title: c.title, status: 'SKIP', detail: `no aplica a ${ctx.envName}` });
      continue;
    }
    ctx.log(`… ${c.id} ${c.title}`);
    let r;
    try {
      r = await c.run(ctx);
    } catch (e) {
      r = fail(`error inesperado: ${e.message}`, { what: c.title, how: 'reportar el error (el check no debería lanzar)' });
    }
    results.push({ id: c.id, title: c.title, ...r });
  }
  const failed = results.filter((r) => r.status === FAIL).length;
  results.push({ id: 'PF-33', title: 'Resumen final y código de salida', status: failed ? FAIL : PASS, detail: failed ? `${failed} check(s) en FAIL` : `${results.length} checks evaluados`, ...(failed ? { fix: { what: 'resolver los FAIL anteriores', variable: '—', how: 'ver cada bloque de STOP', doc: 'docs/SETUP_EXTERNAL_SERVICES.md' } } : {}) });
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envFile = resolve(args.envFile ?? process.env.MTW_ENV_FILE ?? join(WALLET_ROOT, '.env'));
  const fileEnv = readEnvFile(envFile) ?? {};
  const envName = args.env ?? process.env.APP_ENV ?? fileEnv.APP_ENV ?? 'local';
  if (!['local', 'staging', 'production'].includes(envName)) throw new Error(`--env inválido: ${envName}`);
  const ctx = makeContext({ envName, fix: args.fix, envFile, log: args.json ? () => {} : undefined });
  let checks = allChecks();
  if (args.only) checks = checks.filter((c) => args.only.includes(c.id));
  const results = await runChecks(ctx, checks);
  process.stdout.write(render(results, { json: args.json }));
  process.exit(results.some((r) => r.status === FAIL) ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`preflight: ${e.message}\n`);
    process.exit(2);
  });
}
