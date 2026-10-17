// Deploy del sistema en un Anvil de prueba con los scripts reales (`scripts/deploy-core ci`: fondeo, DeployCore
// --broadcast y VerifyDeployment), LOCAL_SEED aleatoria y JSON en contracts/deployments/ci-<tag>.json, que se lee y se
// borra (no pisa el JSON del job de contratos ni el deploy local).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { forkUpstreamUrl } from './fork.ts';

const WALLET_ROOT = resolve(import.meta.dirname, '../../../..');

export interface DeployedSystem {
  contracts: Record<string, string>;
  policy: { admin: string; guardians: string[]; mode: string };
}

export function deploySystem(anvilUrl: string): DeployedSystem {
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
    const result = spawnSync('bash', [resolve(WALLET_ROOT, 'scripts/deploy-core'), 'ci'], {
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 900_000,
    });
    if (result.status !== 0) {
      throw new Error(
        `deploy-core ci falló:\n${`${result.stdout}\n${result.stderr}`.split('\n').slice(-25).join('\n')}`,
      );
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
