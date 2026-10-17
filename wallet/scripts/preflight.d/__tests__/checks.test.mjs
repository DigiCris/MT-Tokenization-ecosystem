import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { configChecks, validateVars } from '../checks/config.mjs';
import { chainChecks } from '../checks/chain.mjs';
import { ctxWithEnv, validLocalEnv, tmp } from './helpers.mjs';

const byId = (list, id) => list.find((c) => c.id === id);

test('variable faltante → FAIL con el ancla correcta de SETUP', async () => {
  const text = validLocalEnv().replace(/^GOOGLE_CLIENT_ID_WALLET=.*$/m, 'GOOGLE_CLIENT_ID_WALLET=');
  const { ctx } = ctxWithEnv(text);
  const r = await byId(configChecks, 'PF-11').run(ctx);
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /GOOGLE_CLIENT_ID_WALLET ausente/);
  assert.equal(r.fix.doc, 'docs/SETUP_EXTERNAL_SERVICES.md#google_client_id_wallet');
});

test('formato inválido de URL / ID → FAIL', async () => {
  const text = validLocalEnv({ BASE_RPC_URL: 'http://no-es-https.example', WALLETCONNECT_PROJECT_ID: 'xyz' });
  const { ctx } = ctxWithEnv(text);
  const r = await byId(configChecks, 'PF-11').run(ctx);
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /BASE_RPC_URL con formato inválido/);
  assert.match(r.detail, /WALLETCONNECT_PROJECT_ID con formato inválido/);
  assert.equal(r.fix.doc, 'docs/SETUP_EXTERNAL_SERVICES.md#base_rpc_url');
});

test('todas las variables de local válidas → PASS', async () => {
  const { ctx } = ctxWithEnv(validLocalEnv());
  assert.deepEqual(validateVars(ctx.env, 'local'), []);
  const r = await byId(configChecks, 'PF-11').run(ctx);
  assert.equal(r.status, 'PASS');
});

function rpcServer(chainIdHex) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const { id } = JSON.parse(body);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: chainIdHex }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('RPC con chainId incorrecto → FAIL', async () => {
  const srv = await rpcServer('0x1');
  try {
    const { ctx } = ctxWithEnv(validLocalEnv());
    ctx.env.BASE_RPC_URL = `http://127.0.0.1:${srv.address().port}/`;
    const r = await byId(chainChecks, 'PF-13').run(ctx);
    assert.equal(r.status, 'FAIL');
    assert.match(r.detail, /chainId 0x1/);
    assert.equal(r.fix.doc, 'docs/SETUP_EXTERNAL_SERVICES.md#base_rpc_url');
  } finally {
    srv.close();
  }
});

test('RPC con chainId 0x2105 → PASS y no expone la URL', async () => {
  const srv = await rpcServer('0x2105');
  try {
    const { ctx } = ctxWithEnv(validLocalEnv());
    ctx.env.BASE_RPC_URL = `http://127.0.0.1:${srv.address().port}/v2/CLAVE-SECRETA`;
    const r = await byId(chainChecks, 'PF-13').run(ctx);
    assert.equal(r.status, 'PASS');
    assert.doesNotMatch(JSON.stringify(r), /CLAVE-SECRETA/);
  } finally {
    srv.close();
  }
});

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

test('puerto ocupado por otro proceso → FAIL', async () => {
  const port = await freePort();
  const outsider = tmp('mtw-outsider-');
  const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${port}, '127.0.0.1', () => console.log('ready'))`], { cwd: outsider, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((r) => child.stdout.once('data', r));
  try {
    const { ctx } = ctxWithEnv(validLocalEnv());
    ctx.portsOverride = [port];
    const r = await byId(configChecks, 'PF-09').run(ctx);
    assert.equal(r.status, 'FAIL');
    assert.match(r.detail, new RegExp(String(port)));
    assert.equal(r.fix.doc, 'docs/SETUP_EXTERNAL_SERVICES.md#puertos-locales-ocupados');
  } finally {
    child.kill();
  }
});

test('los puertos verificados salen de wallet/.env (un puerto movido se respeta)', async () => {
  const { localPorts } = await import('../checks/config.mjs');
  const ports = localPorts({ POSTGRES_HOST_PORT: '55433', WALLET_ORIGIN: 'http://localhost:5180', METRICS_PORT: '9500' });
  assert.ok(ports.includes(55433) && !ports.includes(55432));
  assert.ok(ports.includes(5180) && ports.includes(5174));
  assert.deepEqual(ports.slice(-7), [9500, 9501, 9502, 9503, 9504, 9505, 9506]);
  assert.equal(localPorts({}).length, 17);
});

test('puerto libre → PASS', async () => {
  const { ctx } = ctxWithEnv(validLocalEnv());
  ctx.portsOverride = [await freePort()];
  const r = await byId(configChecks, 'PF-09').run(ctx);
  assert.equal(r.status, 'PASS');
});

function gitRepo({ ignoreEnv }) {
  const repo = tmp('mtw-repo-');
  spawnSync('git', ['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, 'wallet'));
  if (ignoreEnv) writeFileSync(join(repo, 'wallet/.gitignore'), '.env\n');
  writeFileSync(join(repo, 'wallet/.env'), 'APP_ENV=local\n');
  return repo;
}

test('.env no ignorado por git → FAIL', async () => {
  const repo = gitRepo({ ignoreEnv: false });
  const { ctx } = ctxWithEnv(validLocalEnv());
  Object.assign(ctx, { repoRoot: repo, envFile: join(repo, 'wallet/.env') });
  const r = await byId(configChecks, 'PF-10').run(ctx);
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /NO está ignorado/);
});

test('.env ignorado por git → PASS', async () => {
  const repo = gitRepo({ ignoreEnv: true });
  const { ctx } = ctxWithEnv(validLocalEnv());
  Object.assign(ctx, { repoRoot: repo, envFile: join(repo, 'wallet/.env') });
  const r = await byId(configChecks, 'PF-10').run(ctx);
  assert.equal(r.status, 'PASS');
});

test('secretos locales faltantes sin --fix → FAIL apuntando a AUTO-GENERATED', async () => {
  const { ctx } = ctxWithEnv(validLocalEnv());
  const r = await byId(configChecks, 'PF-12').run(ctx);
  assert.equal(r.status, 'FAIL');
  assert.equal(r.fix.doc, 'docs/SETUP_EXTERNAL_SERVICES.md#auto-generated');
  assert.match(r.fix.how, /secrets:local/);
});
