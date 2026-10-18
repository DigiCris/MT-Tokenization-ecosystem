// Deploy del sistema en un Anvil de prueba con los scripts reales (`scripts/deploy-core ci`: fondeo, DeployCore
// --broadcast y VerifyDeployment), LOCAL_SEED aleatoria y JSON en contracts/deployments/ci-<tag>.json, que se lee y se
// borra (no pisa el JSON del job de contratos ni el deploy local). El global setup lo hace una vez por corrida y
// vuelca el estado: cada archivo levanta su propio Anvil con `--load-state` (deployedChain()).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { inject } from 'vitest';
import { forkUpstreamUrl } from './fork.ts';

const WALLET_ROOT = resolve(import.meta.dirname, '../../../..');

export interface DeployedSystem {
  contracts: Record<string, string>;
  policy: { admin: string; guardians: string[]; mode: string };
}

export interface DeployedChain {
  /** Estado de Anvil con el sistema desplegado (para `startAnvil({ loadState })`). */
  statePath: string;
  system: DeployedSystem;
}

export async function deploySystem(anvilUrl: string): Promise<DeployedSystem> {
  const tag = `backend-${randomBytes(4).toString('hex')}`;
  const jsonPath = resolve(WALLET_ROOT, `contracts/deployments/ci-${tag}.json`);
  const env: Record<string, string | undefined> = {
    ...process.env,
    LOCAL_SEED: randomBytes(32).toString('hex'),
    LOCAL_RPC_URL: anvilUrl,
    DEPLOYER_KEY_SOURCE: 'local-seed',
    DEPLOYMENT_TAG: tag,
    FORK_RPC_URL: forkUpstreamUrl(),
  };
  delete env.GOVERNANCE_SAFE_ADDRESS;
  delete env.POLICY_GUARDIANS;
  try {
    const output = await new Promise<{ status: number | null; text: string }>((resolveRun, reject) => {
      const child = spawn('bash', [resolve(WALLET_ROOT, 'scripts/deploy-core'), 'ci'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let text = '';
      child.stdout.on('data', (chunk: Buffer) => (text += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (text += chunk.toString()));
      const timer = setTimeout(() => child.kill('SIGKILL'), 900_000);
      child.once('error', reject);
      child.once('close', (status) => {
        clearTimeout(timer);
        resolveRun({ status, text });
      });
    });
    if (output.status !== 0) {
      throw new Error(`deploy-core ci falló:\n${output.text.split('\n').slice(-25).join('\n')}`);
    }
    const json = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
      contracts: Record<string, { address: string }>;
      policy: DeployedSystem['policy'];
    };
    return {
      contracts: Object.fromEntries(Object.entries(json.contracts).map(([k, v]) => [k, v.address])),
      policy: json.policy,
    };
  } finally {
    rmSync(jsonPath, { force: true });
  }
}

/** El sistema desplegado una vez por corrida en el global setup. */
export function deployedChain(): DeployedChain {
  const chain = inject('chain');
  if (chain === null) throw new Error('el global setup no desplegó el sistema (¿sólo se corre el proyecto live?)');
  return chain;
}
