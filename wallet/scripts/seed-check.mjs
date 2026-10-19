#!/usr/bin/env node
// Chequeo del seed local (P21.T04/P21.TST): el usuario de prueba inicia sesión por la API (como un navegador: Origin de
// Wallet y cookies), su wallet está ACTIVE con la Safe del seed, el destino de prueba está activo en la cadena y los
// saldos on-chain de USDC/USDT llegan a los objetivos. Con --report <archivo> escribe un reporte estable (direcciones y
// saldos, sin secretos) para comparar dos `pnpm dev:fresh`. Sale 1 si algo falla.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const value = (name) =>
  process.env[name] ||
  execFileSync('node', [join(ROOT, 'scripts/lib/env-value.mjs'), name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const fail = (message) => {
  process.stderr.write(`seed-check: ${message}\n`);
  process.exit(1);
};

const credentials = JSON.parse(readFileSync(join(ROOT, '.secrets/seed/credentials.json'), 'utf8'));
const deployment = JSON.parse(readFileSync(join(ROOT, 'contracts/deployments/local.json'), 'utf8'));
const chain = JSON.parse(readFileSync(join(ROOT, 'config/chains/base-mainnet.json'), 'utf8'));
const seed = deployment.seed;
const api = value('API_PUBLIC_URL_WALLET') || 'http://localhost:8080';
const rpc = value('LOCAL_RPC_URL') || 'http://127.0.0.1:8545';
const origin = value('WALLET_ORIGIN') || 'http://localhost:5173';

const jar = new Map();
async function call(method, path, body) {
  const headers = { Origin: origin, 'content-type': 'application/json' };
  if (jar.size > 0) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const response = await fetch(`${api}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(';');
    const index = pair.indexOf('=');
    jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  return { status: response.status, json: await response.json().catch(() => ({})) };
}
const castCall = (to, signature, ...args) =>
  execFileSync('cast', ['call', to, signature, ...args, '--rpc-url', rpc], { encoding: 'utf8' }).trim().split(/\s/)[0];

const login = await call('POST', '/auth/login', { email: credentials.email, password: credentials.accountPassword });
if (login.status !== 200) fail(`login del usuario seed: HTTP ${login.status}`);
const wallets = await call('GET', '/wallets/me');
const wallet = wallets.json.wallet ?? wallets.json;
if (wallets.status !== 200 || wallet.status !== 'ACTIVE') fail(`wallet del seed: HTTP ${wallets.status}, ${wallet.status}`);
if (wallet.id !== seed.walletId || wallet.safe?.toLowerCase() !== seed.safe.toLowerCase()) fail('la wallet ACTIVE no es la del seed');
const usdc = BigInt(castCall(chain.contracts.usdc.address, 'balanceOf(address)(uint256)', seed.safe));
const usdt = BigInt(castCall(chain.contracts.usdt.address, 'balanceOf(address)(uint256)', seed.safe));
if (usdc < BigInt(seed.balances.usdc) || usdt < BigInt(seed.balances.usdt)) fail('saldos on-chain por debajo del seed');
const whitelist = deployment.contracts.DestinationWhitelist.address;
if (castCall(whitelist, 'isWhitelisted(address,address)(bool)', seed.safe, seed.destination) !== 'true') {
  fail('el destino de prueba no está activo en la whitelist');
}
const report = {
  contracts: Object.fromEntries(Object.entries(deployment.contracts).map(([name, c]) => [name, c.address])),
  walletId: seed.walletId,
  safe: seed.safe,
  userKey: seed.userKey,
  recoveryKey: seed.recoveryKey,
  executor: seed.executor,
  destination: seed.destination,
  balances: { usdc: usdc.toString(), usdt: usdt.toString() },
};
const at = process.argv.indexOf('--report');
if (at > 0) writeFileSync(process.argv[at + 1], `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`seed-check OK: ${credentials.email} inicia sesión, wallet ${seed.walletId} ACTIVE (Safe ${seed.safe}), destino activo, ${usdc} USDC y ${usdt} USDT\n`);
