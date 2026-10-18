// pnpm policy:build [--env local] [--out <ruta>] [--successors <archivo JSON>] [--deployment <archivo>]
// Arma el snapshot de policy [B-POL-01] desde las direcciones y codehashes del deploy (local:
// contracts/deployments/local.json; ensayos: contracts/deployments/fork/<entorno>.json, P25.T07; `--deployment` lo
// fija, p. ej. el deploy del stack aislado de los tests de navegador) y config/chains/base-mainnet.json, con los valores V1
// (ADR-025) y los topes del gas tank del entorno (GAS_TOPUP_TARGET_WEI, GAS_TANK_DAILY_CAP_WEI). Si el contenido no
// cambió conserva el archivo (y su firma); si cambió, versión + 1 y hay que volver a firmar (`pnpm policy:sign`).
// `--successors` fija los Guards/module guards sucesores ya activos en el PolicyRegistry ([C-GRD-17]):
// `{"guards": [{"guard": "0x…", "rotationTimelock": "0x…"}], "moduleGuards": ["0x…"]}` (runbook guard-upgrade.md).
// Las rutas relativas se resuelven desde donde se invocó pnpm (INIT_CWD).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parseDotenv } from '../src/config/dotenv.ts';
import { WALLET_ROOT } from '../src/config/env.ts';
import { args, fail, output, run } from '../src/cli/common.ts';
import { buildSnapshot, serializeSnapshot } from '../src/policy/build.ts';

await run(() => {
  const { values } = args({
    env: { type: 'string', default: 'local' },
    out: { type: 'string' },
    successors: { type: 'string' },
    deployment: { type: 'string' },
  });
  const environment = values.env;
  if (environment !== 'local' && environment !== 'staging' && environment !== 'production')
    fail('--env local | staging | production');
  const base = process.env.INIT_CWD ?? process.cwd();
  const out =
    values.out === undefined
      ? resolve(WALLET_ROOT, `config/policy/${environment}/policy-snapshot.json`)
      : isAbsolute(values.out)
        ? values.out
        : resolve(base, values.out);
  const deploymentFile =
    values.deployment === undefined
      ? resolve(
          WALLET_ROOT,
          environment === 'local'
            ? 'contracts/deployments/local.json'
            : `contracts/deployments/fork/${environment}.json`,
        )
      : isAbsolute(values.deployment)
        ? values.deployment
        : resolve(base, values.deployment);
  if (!existsSync(deploymentFile)) fail(`falta ${deploymentFile} (local: pnpm deploy-local)`);
  const deployment = JSON.parse(readFileSync(deploymentFile, 'utf8')) as {
    contracts: Record<string, { address: string; codehash: string }>;
  };
  const chain = JSON.parse(readFileSync(resolve(WALLET_ROOT, 'config/chains/base-mainnet.json'), 'utf8')) as {
    contracts: Record<string, { address: string; codehash?: string; proxyRuntimeCodehash?: string }>;
  };
  const env = {
    ...(environment === 'local' && existsSync(resolve(WALLET_ROOT, '.env'))
      ? parseDotenv(readFileSync(resolve(WALLET_ROOT, '.env'), 'utf8'))
      : {}),
    ...process.env,
  };
  const topup = env.GAS_TOPUP_TARGET_WEI;
  const dailyCap = env.GAS_TANK_DAILY_CAP_WEI;
  if (topup === undefined || dailyCap === undefined) fail('faltan GAS_TOPUP_TARGET_WEI y GAS_TANK_DAILY_CAP_WEI');
  const chainValue = (name: string, field: 'address' | 'codehash' | 'proxyRuntimeCodehash'): string => {
    const value = chain.contracts[name]?.[field];
    if (value === undefined) fail(`config/chains/base-mainnet.json sin ${name}.${field}`);
    return value;
  };
  const chainAddress = (name: string): string => chainValue(name, 'address');
  const successorsFile =
    values.successors === undefined
      ? undefined
      : isAbsolute(values.successors)
        ? values.successors
        : resolve(base, values.successors);
  const successors =
    successorsFile === undefined
      ? undefined
      : (JSON.parse(readFileSync(successorsFile, 'utf8')) as {
          guards: { guard: string; rotationTimelock: string }[];
          moduleGuards: string[];
        });
  const previous = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>) : undefined;
  const make = (version: number, issuedAt?: Date) =>
    buildSnapshot({
      environment,
      version,
      platformId: env.PLATFORM_ID ?? 'mtw',
      ...(issuedAt === undefined ? {} : { issuedAt }),
      deployment: Object.fromEntries(Object.entries(deployment.contracts).map(([k, v]) => [k, v.address])),
      deploymentCodehashes: Object.fromEntries(Object.entries(deployment.contracts).map(([k, v]) => [k, v.codehash])),
      chain: {
        safeL2Singleton: chainAddress('safeL2Singleton'),
        safeProxyFactory: chainAddress('safeProxyFactory'),
        usdc: chainAddress('usdc'),
        usdt: chainAddress('usdt'),
        safeL2SingletonCodehash: chainValue('safeL2Singleton', 'codehash'),
        safeProxyFactoryCodehash: chainValue('safeProxyFactory', 'codehash'),
        safeProxyRuntimeCodehash: chainValue('safeProxyFactory', 'proxyRuntimeCodehash'),
      },
      gasTank: { topupMaxWei: topup, dailyCapWei: dailyCap },
      ...(successors === undefined ? {} : { successors }),
    });
  if (previous !== undefined) {
    const same = make(previous.version as number, new Date(previous.issuedAt as string));
    if (JSON.stringify(same) === JSON.stringify(previous)) {
      output({ path: out, version: previous.version, changed: false });
      return;
    }
  }
  const version = previous === undefined ? 1 : (previous.version as number) + 1;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, serializeSnapshot(make(version)));
  rmSync(`${out}.sig`, { force: true });
  output({ path: out, version, changed: true, next: 'pnpm --dir backend/signer policy:sign' });
});
