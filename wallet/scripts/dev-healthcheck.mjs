#!/usr/bin/env node
// Health del entorno local de `pnpm dev` (P21.T02/P21.TST): servicios del compose, Anvil (fork de Base, chainId 8453),
// contratos del deploy local con código en el fork, API de Wallet y de Recovery (/health/ready), shards del signer
// (puertos mTLS), métricas del worker y del gas tank, integrity monitor y los dos frontends. Sale 1 si algo falla.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = (name, fallback) =>
  spawnSync('node', [join(ROOT, 'scripts/lib/env-value.mjs'), name], { encoding: 'utf8' }).stdout.trim() || fallback;
const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push([true, name, detail ?? '']);
  } catch (error) {
    results.push([false, name, error instanceof Error ? error.message : String(error)]);
  }
};
const get = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
};
const port = (p) =>
  new Promise((ok, ko) => {
    const socket = connect({ host: '127.0.0.1', port: Number(p) });
    socket.once('connect', () => {
      socket.destroy();
      ok(`puerto ${p}`);
    });
    socket.once('error', () => ko(new Error(`puerto ${p} cerrado`)));
  });
const rpc = env('LOCAL_RPC_URL', 'http://127.0.0.1:8545');

await check('docker compose (postgres, valkey, anvil, mailpit)', () => {
  const lines = execFileSync('docker', ['compose', 'ps', '--format', '{{.Service}} {{.Health}} {{.State}}'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
  for (const service of ['postgres', 'valkey', 'anvil', 'mailpit']) {
    const line = lines.find((l) => l.startsWith(`${service} `));
    if (!line || !/running/.test(line) || /unhealthy/.test(line)) throw new Error(`${service}: ${line ?? 'no está'}`);
  }
  return lines.length + ' servicios';
});
await check('Anvil sobre el fork de Base', async () => {
  const body = await (await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' })).json();
  if (body.result !== '0x2105') throw new Error(`chainId ${body.result}`);
  return 'chainId 8453';
});
await check('contratos del deploy local', () => {
  const deployment = JSON.parse(readFileSync(join(ROOT, 'contracts/deployments/local.json'), 'utf8'));
  for (const [name, { address }] of Object.entries(deployment.contracts)) {
    const code = execFileSync('cast', ['code', address, '--rpc-url', rpc], { encoding: 'utf8' }).trim();
    if (code === '0x') throw new Error(`${name} sin código`);
  }
  return `${Object.keys(deployment.contracts).length} contratos con código`;
});
for (const [name, url] of [
  ['API de Wallet', `${env('API_PUBLIC_URL_WALLET', 'http://localhost:8080')}/api/v1/health/ready`],
  ['API de Recovery', `${env('API_PUBLIC_URL_RECOVERY', 'http://localhost:8081')}/api/v1/health/ready`],
  ['métricas del worker', `http://127.0.0.1:${env('WORKER_METRICS_PORT', '9465')}/metrics`],
  ['métricas del gas tank', `http://127.0.0.1:${env('GAS_TANK_METRICS_PORT', '9466')}/metrics`],
  ['integrity monitor', 'http://127.0.0.1:8092/health'],
  ['frontend Wallet', env('WALLET_ORIGIN', 'http://localhost:5173')],
  ['frontend Recovery', env('RECOVERY_ORIGIN', 'http://localhost:5174')],
]) {
  await check(name, async () => `HTTP ${(await get(url)).status}`);
}
await check('shard dev-1 del signer (mTLS)', () => port(env('SIGNER_PORT', '8090')));
await check('shard platform del signer (mTLS)', () => port(env('SIGNER_PLATFORM_PORT', '8091')));

for (const [ok, name, detail] of results) process.stdout.write(`${ok ? 'OK  ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}\n`);
const failed = results.filter(([ok]) => !ok).length;
process.stdout.write(failed === 0 ? 'HEALTHCHECK OK\n' : `HEALTHCHECK: ${failed} fallas\n`);
process.exit(failed === 0 ? 0 : 1);
