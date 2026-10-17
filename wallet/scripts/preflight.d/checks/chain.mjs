// PF-13…PF-18: RPC de Base (chainId, latencia, archive, codehashes en el bloque de fork), RPC
// secundario y servicios locales de docker compose. Nunca muestra URLs con credenciales (sólo host).
import { join } from 'node:path';
import { rpc, hostOf, fetchWithTimeout } from '../lib/net.mjs';
import { pgQuery } from '../lib/pg.mjs';
import { respCommands } from '../lib/resp.mjs';
import { run, runAsync } from '../lib/proc.mjs';
import { pass, fixed, fail, skip } from '../lib/report.mjs';

const hex = (n) => '0x' + Number(n).toString(16);
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

export async function rpcLatency(url, samples = 3) {
  await rpc(url, 'eth_chainId'); // calentamiento (DNS + TLS)
  const times = [];
  let chainId;
  for (let i = 0; i < samples; i++) {
    const r = await rpc(url, 'eth_chainId');
    chainId = r.result;
    times.push(r.ms);
  }
  return { chainId, ms: median(times) };
}

const COMPOSE_SERVICES = ['postgres', 'valkey', 'anvil', 'mailpit'];

function composeStatus(ctx) {
  const r = run('docker', ['compose', 'ps', '--all', '--format', 'json'], { cwd: ctx.root, timeoutMs: 30000 });
  const status = {};
  if (r.code !== 0) return status;
  for (const line of r.stdout.trim().split('\n').filter(Boolean)) {
    try {
      const items = JSON.parse(line);
      for (const it of Array.isArray(items) ? items : [items]) status[it.Service] = { state: it.State, health: it.Health ?? '' };
    } catch {
      /* ignorar */
    }
  }
  return status;
}

const healthy = (s) => s && s.state === 'running' && (s.health === 'healthy' || s.health === '');

export const chainChecks = [
  {
    id: 'PF-13',
    title: 'BASE_RPC_URL: chainId 8453 y latencia < 2 s',
    run: async (ctx) => {
      const url = ctx.env.BASE_RPC_URL;
      if (!url) return fail('BASE_RPC_URL ausente', { variable: 'BASE_RPC_URL', how: 'crear la app en Alchemy y cargar la URL en wallet/.env', anchor: 'base_rpc_url' });
      try {
        const { chainId, ms } = await rpcLatency(url);
        if (chainId !== '0x2105') return fail(`chainId ${chainId} (se esperaba 0x2105)`, { what: 'RPC de Base Mainnet', variable: 'BASE_RPC_URL', how: 'usar una app de Alchemy en la red Base Mainnet', anchor: 'base_rpc_url' });
        if (ms >= 2000) return fail(`latencia mediana ${ms.toFixed(0)} ms ≥ 2000 ms`, { what: 'RPC con latencia < 2 s', variable: 'BASE_RPC_URL', how: 'revisar la red o usar otra app/región de Alchemy', anchor: 'base_rpc_url' });
        return pass(`host ${hostOf(url)}, chainId 0x2105, latencia mediana ${ms.toFixed(0)} ms`);
      } catch (e) {
        return fail(e.message, { what: 'RPC de Base accesible', variable: 'BASE_RPC_URL', how: 'verificar la URL/clave de Alchemy', anchor: 'base_rpc_url' });
      }
    },
  },
  {
    id: 'PF-14',
    title: 'BASE_RPC_URL con datos archive en el bloque de fork',
    envs: ['local', 'ci'],
    run: async (ctx) => {
      const url = ctx.env.BASE_RPC_URL;
      const block = hex(ctx.chainConfig.fork.blockNumber);
      try {
        const { result: code } = await rpc(url, 'eth_getCode', [ctx.chainConfig.contracts.usdc.address, block]);
        if (!code || code === '0x') return fail('eth_getCode(USDC) vacío en el bloque de fork', { what: 'RPC con datos archive', variable: 'BASE_RPC_URL', how: 'usar Alchemy (incluye archive)', anchor: 'base_rpc_url' });
        await rpc(url, 'eth_getBalance', [ctx.chainConfig.contracts.safeL2Singleton.address, block]);
        return pass(`estado histórico disponible en ${ctx.chainConfig.fork.blockNumber}`);
      } catch (e) {
        return fail(e.message, { what: 'RPC con datos archive', variable: 'BASE_RPC_URL', how: 'usar Alchemy (incluye archive)', anchor: 'base_rpc_url' });
      }
    },
  },
  {
    id: 'PF-15',
    title: 'Bloque de fork finalizado y codehashes esperados',
    envs: ['local', 'ci'],
    run: async (ctx) => {
      const url = ctx.env.BASE_RPC_URL;
      const cfg = ctx.chainConfig;
      const block = hex(cfg.fork.blockNumber);
      try {
        const { result: fin } = await rpc(url, 'eth_getBlockByNumber', ['finalized', false]);
        if (Number(fin.number) < cfg.fork.blockNumber) return fail(`FORK_BLOCK_NUMBER ${cfg.fork.blockNumber} > finalizado ${Number(fin.number)}`, { what: 'bloque de fork finalizado', variable: 'FORK_BLOCK_NUMBER', how: 'usar un bloque ≤ finalized (runbooks/fork.md)', anchor: 'variables-de-configuración-local' });
        const { result: b } = await rpc(url, 'eth_getBlockByNumber', [block, false]);
        if (b.hash !== cfg.fork.blockHash) return fail('el hash del bloque de fork no coincide con config/chains/base-mainnet.json', { what: 'bloque de fork verificado', variable: 'FORK_BLOCK_NUMBER', how: 're-verificar el bloque (P03)', anchor: 'variables-de-configuración-local' });
        // Codehash de cada contrato externo (y de la implementación de los proxies de token) con
        // scripts/verify-external (P03.T04), que nunca imprime la URL del RPC.
        const r = await runAsync('bash', [join(ctx.root, 'scripts/verify-external'), '--block', String(cfg.fork.blockNumber), '--quiet'], {
          env: { ...process.env, BASE_RPC_URL: url },
          timeoutMs: 600000,
        });
        if (r.code !== 0) {
          const mismatches = [...(r.stderr + r.stdout).matchAll(/FALLA (\S+?):/g)].map((m) => m[1]);
          return fail(`codehash distinto en: ${mismatches.join(', ') || 'verify-external falló'}`, { what: 'contratos externos con el codehash verificado', variable: 'config/chains/base-mainnet.json', how: 're-verificar contra la fuente oficial (P03, scripts/verify-external); no continuar con direcciones no verificadas', anchor: 'auto-discovered' });
        }
        return pass(`bloque ${cfg.fork.blockNumber} ≤ finalized ${Number(fin.number)}; ${Object.keys(cfg.contracts).length} codehashes OK`);
      } catch (e) {
        return fail(e.message, { what: 'verificación on-chain del bloque de fork', variable: 'BASE_RPC_URL', how: 'verificar el RPC', anchor: 'base_rpc_url' });
      }
    },
  },
  {
    id: 'PF-16',
    title: 'BASE_RPC_URL_SECONDARY: chainId, sincronía y proveedor distinto',
    run: async (ctx) => {
      const url2 = ctx.env.BASE_RPC_URL_SECONDARY;
      if (!url2) return ctx.envName === 'local' ? skip('no definida (opcional en local)') : fail('BASE_RPC_URL_SECONDARY ausente', { variable: 'BASE_RPC_URL_SECONDARY', how: 'crear el endpoint en QuickNode', anchor: 'base_rpc_url_secondary' });
      try {
        const { result: chainId } = await rpc(url2, 'eth_chainId');
        if (chainId !== '0x2105') return fail(`chainId ${chainId}`, { what: 'RPC secundario de Base Mainnet', variable: 'BASE_RPC_URL_SECONDARY', how: 'endpoint de QuickNode en Base Mainnet', anchor: 'base_rpc_url_secondary' });
        const [a, b] = await Promise.all([rpc(ctx.env.BASE_RPC_URL, 'eth_blockNumber'), rpc(url2, 'eth_blockNumber')]);
        const diff = Math.abs(Number(a.result) - Number(b.result));
        if (diff > 10) return fail(`head a ${diff} bloques del primario`, { what: 'RPC secundario sincronizado', variable: 'BASE_RPC_URL_SECONDARY', how: 'revisar el estado del endpoint', anchor: 'base_rpc_url_secondary' });
        if (hostOf(url2).split('.').slice(-2).join('.') === hostOf(ctx.env.BASE_RPC_URL).split('.').slice(-2).join('.')) return fail('mismo proveedor que BASE_RPC_URL', { what: 'proveedor distinto (ADR-017)', variable: 'BASE_RPC_URL_SECONDARY', how: 'usar QuickNode', anchor: 'base_rpc_url_secondary' });
        return pass(`host ${hostOf(url2)}, diferencia ${diff} bloques`);
      } catch (e) {
        return fail(e.message, { what: 'RPC secundario accesible', variable: 'BASE_RPC_URL_SECONDARY', how: 'verificar la URL de QuickNode', anchor: 'base_rpc_url_secondary' });
      }
    },
  },
  {
    id: 'PF-17',
    title: 'Servicios compose: Postgres ≥ 18, Valkey, Anvil y Mailpit',
    envs: ['local'],
    run: async (ctx) => {
      let st = composeStatus(ctx);
      let wasFixed = false;
      if (!COMPOSE_SERVICES.every((s) => healthy(st[s]))) {
        if (!ctx.fix) return fail(`servicios no saludables: ${COMPOSE_SERVICES.filter((s) => !healthy(st[s])).join(', ')}`, { what: 'stack local levantado', how: 'cd wallet && docker compose up -d', anchor: 'servicios-locales-docker-compose' });
        ctx.log('  auto-remediación: docker compose up -d (espera hasta que estén healthy)');
        const up = await runAsync('docker', ['compose', 'up', '-d', '--wait', '--wait-timeout', '900'], { cwd: ctx.root, timeoutMs: 1000000 });
        st = composeStatus(ctx);
        if (up.code !== 0 || !COMPOSE_SERVICES.every((s) => healthy(st[s]))) {
          const bad = COMPOSE_SERVICES.filter((s) => !healthy(st[s]));
          return fail(`no levantaron: ${bad.join(', ') || 'ver docker compose logs'}`, { what: 'stack local levantado', how: `docker compose logs ${bad.join(' ')}`, anchor: 'servicios-locales-docker-compose' });
        }
        wasFixed = true;
      }
      const e = ctx.env;
      const problems = [];
      try {
        const admin = `postgres://${encodeURIComponent(e.POSTGRES_USER)}:${encodeURIComponent(e.POSTGRES_PASSWORD)}@127.0.0.1:${e.POSTGRES_HOST_PORT}/${encodeURIComponent(e.POSTGRES_DB)}`;
        const [[ver]] = await pgQuery(admin, 'show server_version');
        if (parseInt(ver, 10) < 18) problems.push(`Postgres ${ver} < 18`);
      } catch (err) {
        problems.push(`Postgres: ${err.message}`);
      }
      try {
        const [pong, policy, aof] = await respCommands(e.REDIS_URL, [['PING'], ['CONFIG', 'GET', 'maxmemory-policy'], ['CONFIG', 'GET', 'appendonly']]);
        if (pong !== 'PONG') problems.push('Valkey no responde PONG');
        if (policy?.[1] !== 'noeviction') problems.push('Valkey sin maxmemory-policy noeviction');
        if (aof?.[1] !== 'yes') problems.push('Valkey sin appendonly yes');
      } catch (err) {
        problems.push(`Valkey: ${err.message}`);
      }
      try {
        const { result: chainId } = await rpc(e.LOCAL_RPC_URL, 'eth_chainId');
        const { result: info } = await rpc(e.LOCAL_RPC_URL, 'anvil_nodeInfo');
        const { result: code } = await rpc(e.LOCAL_RPC_URL, 'eth_getCode', [ctx.chainConfig.contracts.usdc.address, 'latest']);
        if (chainId !== '0x2105') problems.push(`Anvil chainId ${chainId}`);
        if (Number(info?.forkConfig?.forkBlockNumber) !== ctx.chainConfig.fork.blockNumber) problems.push(`Anvil forkBlockNumber ${info?.forkConfig?.forkBlockNumber}`);
        if (!code || code === '0x') problems.push('USDC sin código en el fork');
      } catch (err) {
        problems.push(`Anvil: ${err.message}`);
      }
      try {
        const r = await fetchWithTimeout(`http://127.0.0.1:${e.MAILPIT_UI_PORT}/api/v1/info`, {}, 5000);
        if (!r.ok) problems.push(`Mailpit API HTTP ${r.status}`);
      } catch (err) {
        problems.push(`Mailpit: ${err.message}`);
      }
      if (problems.length) return fail(problems.join('; '), { what: 'servicios locales correctos', how: 'docker compose logs <servicio>; si la config cambió: docker compose down -v && docker compose up -d', anchor: 'servicios-locales-docker-compose' });
      return wasFixed ? fixed('stack levantado y verificado') : pass('Postgres 18, Valkey (noeviction, AOF), Anvil (fork 8453), Mailpit');
    },
  },
  {
    id: 'PF-18',
    title: 'DATABASE_URL y REDIS_URL conectan desde el host',
    run: async (ctx) => {
      const e = ctx.env;
      const problems = [];
      for (const k of ['DATABASE_URL', 'DATABASE_MIGRATION_URL', 'SIGNER_DATABASE_URL']) {
        if (!e[k]) {
          problems.push(`${k} ausente`);
          continue;
        }
        try {
          const [[one]] = await pgQuery(e[k], 'select 1');
          if (one !== '1') problems.push(`${k}: respuesta inesperada`);
        } catch (err) {
          problems.push(`${k}: ${err.message}`);
        }
      }
      try {
        const [pong] = await respCommands(e.REDIS_URL, [['PING']]);
        if (pong !== 'PONG') problems.push('REDIS_URL: sin PONG');
      } catch (err) {
        problems.push(`REDIS_URL: ${err.message}`);
      }
      if (problems.length) return fail(problems.join('; '), { what: 'conexión a Postgres y Valkey', variable: 'DATABASE_URL, DATABASE_MIGRATION_URL, SIGNER_DATABASE_URL, REDIS_URL', how: ctx.envName === 'local' ? 'pnpm secrets:local y docker compose up -d' : 'verificar los secrets del entorno', anchor: 'servicios-locales-docker-compose' });
      return pass('roles mtw_app, mtw_migrator, mtw_signer y Valkey conectan');
    },
  },
];

export const _internal = { composeStatus, COMPOSE_SERVICES, join };
