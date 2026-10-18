// P12.T04 contra el fork: para claves y wallets al azar, el cálculo local (initializer + CREATE2 con el creation code
// fijado y el saltNonce de la wallet) coincide con WalletFactory.predictWalletAddress leído por quórum, y el
// config_hash es keccak256 del initializer que arma la propia factory (initializerFor).
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { walletFactoryAbi } from '../../src/chain/abis/index.ts';
import { predictSafeAddress, safeInitializer } from '../../src/chain/create2.ts';
import { RpcQuorumClient } from '../../src/chain/rpc-quorum.ts';
import { safeProxyInitCodeHash } from '../../src/chain/safe-proxy.ts';
import { createLogger } from '../../src/observability/logger.ts';
import { createMetrics } from '../../src/observability/metrics.ts';
import { loadPolicySnapshot, type BackendPolicySnapshot } from '../../src/policy/snapshot.ts';
import { walletSaltNonce } from '../../src/wallets/salt.ts';
import { deployedChain } from '../helpers/deploy.ts';
import { startAnvil, type AnvilInstance } from '../helpers/fork.ts';
import { edKey, writePolicySnapshot } from '../helpers/signer-shard.ts';

let anvil: AnvilInstance;
let rpc: RpcQuorumClient;
let snapshot: BackendPolicySnapshot;
let dir: string;

beforeAll(async () => {
  const chain = deployedChain();
  anvil = await startAnvil({ loadState: chain.statePath });
  dir = mkdtempSync(join(tmpdir(), 'mtw-predict-'));
  const key = edKey();
  snapshot = loadPolicySnapshot(writePolicySnapshot(dir, key, chain.system), key.publicKey, 'local');
  rpc = new RpcQuorumClient({
    primaryUrl: anvil.url,
    secondaryUrl: anvil.url,
    mode: 'local-single',
    chainId: 8453,
    timeoutMs: 30_000,
    healthIntervalMs: 60_000,
    maxHeadLagBlocks: 10,
    retries: 2,
    backoffMs: 100,
    logger: createLogger({ level: 'silent', service: 'test-predict' }),
    metrics: createMetrics({ defaultMetrics: false }),
  });
});
afterAll(async () => {
  await (rpc as RpcQuorumClient | undefined)?.stop();
  await (anvil as AnvilInstance | undefined)?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const randomKey = (): Address => privateKeyToAddress(generatePrivateKey());

describe('dirección esperada de la Safe', () => {
  it('cálculo local == WalletFactory.predictWalletAddress (por quórum) para wallets y claves al azar', async () => {
    for (let i = 0; i < 4; i++) {
      const keys = { userKey: randomKey(), recoveryKey: randomKey(), executor: randomKey() };
      const saltNonce = walletSaltNonce('mtw', randomUUID());
      const initializer = safeInitializer(keys, snapshot.contracts.safeBootstrap);
      const local = predictSafeAddress({
        safeProxyFactory: snapshot.contracts.safeProxyFactory,
        initCodeHash: safeProxyInitCodeHash(snapshot.contracts.safeL2Singleton),
        initializer,
        saltNonce,
      });
      const { value: onChain } = await rpc.readContract({
        address: snapshot.contracts.walletFactory,
        abi: walletFactoryAbi,
        functionName: 'predictWalletAddress',
        args: [keys.userKey, keys.recoveryKey, keys.executor, saltNonce],
      });
      expect(local).toBe(onChain);
      const { value: factoryInitializer } = await rpc.readContract({
        address: snapshot.contracts.walletFactory,
        abi: walletFactoryAbi,
        functionName: 'initializerFor',
        args: [keys.userKey, keys.recoveryKey, keys.executor],
      });
      expect(keccak256(initializer)).toBe(keccak256(factoryInitializer));
    }
  });

  it('el init code hash local es el que fija la factory y otro salt u otra clave cambian la Safe', async () => {
    const { value: initCodeHash } = await rpc.readContract({
      address: snapshot.contracts.walletFactory,
      abi: walletFactoryAbi,
      functionName: 'PROXY_INIT_CODE_HASH',
    });
    expect(safeProxyInitCodeHash(snapshot.contracts.safeL2Singleton)).toBe(initCodeHash);
    const keys = { userKey: randomKey(), recoveryKey: randomKey(), executor: randomKey() };
    const predict = (k: typeof keys, salt: bigint) =>
      predictSafeAddress({
        safeProxyFactory: snapshot.contracts.safeProxyFactory,
        initCodeHash,
        initializer: safeInitializer(k, snapshot.contracts.safeBootstrap),
        saltNonce: salt,
      });
    const base = predict(keys, 1n);
    expect(predict(keys, 2n)).not.toBe(base);
    expect(predict({ ...keys, recoveryKey: randomKey() }, 1n)).not.toBe(base);
  });
});
