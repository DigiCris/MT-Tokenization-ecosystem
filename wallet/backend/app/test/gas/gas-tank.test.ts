// P11.T09 [B-SIG-05] contra el fork: el gas tank del backend usa la cuenta del shard `platform` (proceso real del
// signer) para desplegar Safes por la WalletFactory real (sólo con una S atestada por un signer), recargar la S vigente
// de una Safe registrada hasta el objetivo (tope diario en el backend y, aparte, en el signer) y retransmitir
// cancelaciones de rotación firmadas por U; todo queda en chain_transactions / gas_topups y en las métricas.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { iSafeAbi, rotationTimelockAbi, walletFactoryAbi } from '../../src/chain/abis/index.ts';
import { cancelRotationDigest } from '../../src/chain/eip712.ts';
import { RpcQuorumClient } from '../../src/chain/rpc-quorum.ts';
import { safeTxHash, type SafeTx } from '../../src/chain/safe-tx.ts';
import { PasswordHasher } from '../../src/auth/password.ts';
import { GasTankService } from '../../src/gas/gas-tank.ts';
import { addressToBuffer } from '../../src/lib/bytes.ts';
import { createLogger } from '../../src/observability/logger.ts';
import { createMetrics } from '../../src/observability/metrics.ts';
import { loadPolicySnapshot, type BackendPolicySnapshot } from '../../src/policy/snapshot.ts';
import { testConfig } from '../helpers/config.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';
import { deployedChain, type DeployedSystem } from '../helpers/deploy.ts';
import { startAnvil, type AnvilInstance } from '../helpers/fork.ts';
import {
  createPki,
  edKey,
  startSignerShard,
  writePolicySnapshot,
  type Pki,
  type SignerShard,
} from '../helpers/signer-shard.ts';

const TARGET = 1_000_000_000_000_000n; // 0,001 ETH (≤ topupMaxWei del snapshot)
const MIN = 200_000_000_000_000n;
let anvil: AnvilInstance;
let db: TestDatabase;
let pki: Pki;
let platform: SignerShard;
let executorShard: SignerShard;
let system: DeployedSystem;
let snapshot: BackendPolicySnapshot;
let rpc: RpcQuorumClient;
let dir: string;
const metrics = createMetrics({ defaultMetrics: false });
const logger = createLogger({ level: 'silent', service: 'test-gas' });
const keys = { attestation: edKey(), policy: edKey(), issuer: edKey() };

function service(overrides: Partial<{ dailyCapWei: bigint }> = {}): GasTankService {
  return new GasTankService({
    db: db.app,
    rpc,
    platform: platform.client,
    policy: () => snapshot,
    config: { topupMinWei: MIN, topupTargetWei: TARGET, dailyCapWei: overrides.dailyCapWei ?? 2_500_000_000_000_000n },
    logger,
    metrics,
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mtw-gas-'));
  const chain = deployedChain();
  system = chain.system;
  [anvil, db] = await Promise.all([startAnvil({ loadState: chain.statePath }), createTestDatabase()]);
  pki = createPki();
  const snapshotPath = writePolicySnapshot(dir, keys.policy, system.contracts);
  snapshot = loadPolicySnapshot(snapshotPath, keys.policy.publicKey, 'local');
  const started = await Promise.all([
    startSignerShard({ shardId: 'platform', anvilUrl: anvil.url, pki, keys, snapshotPath }),
    startSignerShard({ shardId: 'dev-1', anvilUrl: anvil.url, pki, keys, snapshotPath }),
  ]);
  platform = started[0]!;
  executorShard = started[1]!;
  rpc = new RpcQuorumClient({
    primaryUrl: anvil.url,
    secondaryUrl: anvil.url,
    mode: 'local-single',
    chainId: 8453,
    timeoutMs: 20_000,
    healthIntervalMs: 60_000,
    maxHeadLagBlocks: 10,
    retries: 2,
    backoffMs: 100,
    logger,
    metrics,
  });
  // El gas tank arranca con 0,01 ETH (como lo fondea el operador).
  await anvil.rpc('anvil_setBalance', [platform.created.gasTank, '0x2386f26fc10000']);
});
afterAll(async () => {
  // Si el beforeAll falló a mitad de camino, algo puede no existir.
  const maybe = <T>(value: T) => value as T | undefined;
  await Promise.all([maybe(platform)?.stop(), maybe(executorShard)?.stop()]);
  await maybe(rpc)?.stop();
  await maybe(db)?.close();
  await maybe(anvil)?.stop();
  maybe(pki)?.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const publicClient = () => createPublicClient({ chain: base, transport: http(anvil.url) });
const U = privateKeyToAccount(generatePrivateKey());
const R = privateKeyToAccount(generatePrivateKey());
let safe: Address;
let S: Address;
let walletId: string;

async function balance(address: Address): Promise<bigint> {
  return publicClient().getBalance({ address });
}

describe('deploy de Safes por el gas tank', () => {
  it('createWallet con una S atestada: la Safe queda registrada y la tx en chain_transactions', async () => {
    walletId = crypto.randomUUID();
    const key = await executorShard.client.createKey({ walletId, reason: 'ONBOARDING' });
    S = getAddress(key.address);
    const tank = service();
    expect(await tank.address()).toBe(getAddress(platform.created.gasTank!));
    const tx = await tank.deploySafe({
      walletId,
      userKey: U.address,
      recoveryKey: R.address,
      executor: S,
      saltNonce: 0n,
      executorAttestation: key.attestation!,
    });
    expect(tx.status).toBe('MINED');
    safe = await publicClient().readContract({
      address: system.contracts.WalletFactory as Address,
      abi: walletFactoryAbi,
      functionName: 'predictWalletAddress',
      args: [U.address, R.address, S, 0n],
    });
    expect(
      await publicClient().readContract({
        address: system.contracts.WalletFactory as Address,
        abi: walletFactoryAbi,
        functionName: 'isWallet',
        args: [safe],
      }),
    ).toBe(true);
    const row = await db.app
      .selectFrom('chain_transactions')
      .select(['purpose', 'status', 'receipt_status'])
      .where('id', '=', tx.txId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ purpose: 'DEPLOY', status: 'MINED', receipt_status: 1 });
  });

  it('una S sin atestación de un signer no se despliega', async () => {
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    await expect(
      service().deploySafe({
        walletId: crypto.randomUUID(),
        userKey: U.address,
        recoveryKey: R.address,
        executor: stranger,
        saltNonce: 7n,
        executorAttestation: 'a.b.c',
      }),
    ).rejects.toMatchObject({ code: 'PLATFORM_TX_REJECTED', reason: 'DEPLOY_EXECUTOR_NOT_ATTESTED' });
  });
});

describe('recargas de S', () => {
  it('la S vigente bajo el mínimo se lleva al objetivo; arriba del mínimo no se recarga', async () => {
    expect(await balance(S)).toBe(0n);
    const result = await service().topUp({ safe, executor: S });
    expect(result).toMatchObject({ toppedUp: true, amount: TARGET, status: 'MINED' });
    expect(await balance(S)).toBe(TARGET);
    expect(await service().topUp({ safe, executor: S })).toEqual({ toppedUp: false, reason: 'ABOVE_MINIMUM' });
    const topups = await db.app
      .selectFrom('gas_topups')
      .select(['amount_wei'])
      .where('executor_address', '=', addressToBuffer(S))
      .execute();
    expect(topups.map((t) => t.amount_wei)).toEqual([TARGET.toString()]);
  });

  it('el signer sólo recarga la S vigente de una Safe registrada', async () => {
    const other = privateKeyToAccount(generatePrivateKey()).address;
    await expect(service().topUp({ safe, executor: other })).rejects.toMatchObject({
      code: 'PLATFORM_TX_REJECTED',
      reason: 'TOPUP_NOT_EXECUTOR',
    });
  });

  it('tope diario: el backend no pide más y el signer aplica el suyo aunque se le pida', async () => {
    // Backend: con un tope de 0,0015 ETH, otra recarga de 0,001 no entra.
    await anvil.rpc('anvil_setBalance', [S, '0x0']);
    expect(await service({ dailyCapWei: 1_500_000_000_000_000n }).topUp({ safe, executor: S })).toEqual({
      toppedUp: false,
      reason: 'DAILY_CAP',
    });
    // Signer: su tope del snapshot (0,003 ETH = tres recargas de 0,001) corta aunque el backend no tenga tope.
    const noBackendCap = service({ dailyCapWei: 10n ** 18n });
    for (const expected of [2, 3]) {
      expect(await noBackendCap.topUp({ safe, executor: S })).toMatchObject({ toppedUp: true, status: 'MINED' });
      expect(await noBackendCap.toppedUpLastDay()).toBe(BigInt(expected) * TARGET);
      await anvil.rpc('anvil_setBalance', [S, '0x0']);
    }
    await expect(noBackendCap.topUp({ safe, executor: S })).rejects.toMatchObject({ code: 'GAS_TANK_CAP_EXCEEDED' });
  });

  it('la pasada periódica recorre las wallets activas y deja las métricas', async () => {
    const config = testConfig();
    const { hash, pepperVersion } = await new PasswordHasher(config.secrets.passwordPeppers).hash(
      'contraseña de prueba larga',
    );
    const user = await db.app
      .insertInto('users')
      .values({
        platform_id: config.platformId,
        email: `${crypto.randomUUID()}@test.invalid`,
        password_hash: hash,
        pepper_version: pepperVersion,
        email_verified_at: sql`now()`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const wallet = await db.app
      .insertInto('wallets')
      .values({
        id: walletId,
        user_id: user.id,
        platform_id: config.platformId,
        chain_id: 8453,
        status: 'ACTIVE',
        safe_address: addressToBuffer(safe),
        activated_at: sql`now()`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db.app
      .insertInto('signer_keys')
      .values({
        wallet_id: wallet.id,
        shard_id: 'dev-1',
        key_ref: `dev-1:${S.toLowerCase()}`,
        address: addressToBuffer(S),
        provider: 'selfhosted',
        status: 'ACTIVE',
      })
      .execute();
    await anvil.rpc('anvil_setBalance', [S, `0x${(MIN * 2n).toString(16)}`]);
    const report = await service().runOnce();
    expect(report).toMatchObject({ checked: 1, belowMinimum: 0, toppedUp: 0 });
    expect((await metrics.executorsBelowMinimum.get()).values[0]?.value).toBe(0);
    expect((await metrics.gasTankBalanceWei.get()).values[0]?.value).toBeGreaterThan(0);
  });
});

describe('retransmisión de cancelaciones [C-RTL-03]', () => {
  it('una propuesta pendiente se cancela con la firma de U retransmitida por el gas tank; una firma ajena no', async () => {
    const pc = publicClient();
    // Propuesta de rotación de S por camino soberano U+R (prepara el estado; el Guard no aplica política ahí).
    const newS = privateKeyToAccount(generatePrivateKey()).address;
    const tx: SafeTx = {
      to: system.contracts.RotationTimelock as Address,
      value: 0n,
      data: encodeFunctionData({ abi: rotationTimelockAbi, functionName: 'propose', args: [2, S, newS] }),
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: '0x0000000000000000000000000000000000000000',
      refundReceiver: '0x0000000000000000000000000000000000000000',
      nonce: await pc.readContract({ address: safe, abi: iSafeAbi, functionName: 'nonce' }),
    };
    const hash = safeTxHash(8453, safe, tx);
    const signatures = [
      { signer: U.address, sig: await U.sign({ hash }) },
      { signer: R.address, sig: await R.sign({ hash }) },
    ]
      .sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1))
      .map((s) => s.sig.slice(2))
      .join('');
    const relayer = privateKeyToAccount(generatePrivateKey());
    await anvil.rpc('anvil_setBalance', [relayer.address, '0xde0b6b3a7640000']);
    const wallet = createWalletClient({ account: relayer, chain: base, transport: http(anvil.url) });
    const proposeHash = await wallet.writeContract({
      address: safe,
      abi: iSafeAbi,
      functionName: 'execTransaction',
      args: [
        tx.to,
        tx.value,
        tx.data,
        tx.operation,
        tx.safeTxGas,
        tx.baseGas,
        tx.gasPrice,
        tx.gasToken,
        tx.refundReceiver,
        `0x${signatures}`,
      ],
      gas: 1_500_000n,
    });
    const receipt = await pc.waitForTransactionReceipt({ hash: proposeHash });
    const [proposed] = parseEventLogs({ abi: rotationTimelockAbi, logs: receipt.logs, eventName: 'RotationProposed' });
    const proposalId = (proposed?.args as { id: Hex }).id;

    const stranger = privateKeyToAccount(generatePrivateKey());
    const digest = cancelRotationDigest(8453, system.contracts.RotationTimelock as Address, proposalId, safe);
    await expect(
      service().relayCancellation({ proposalId, signature: await stranger.sign({ hash: digest }) }),
    ).rejects.toMatchObject({ code: 'SIMULATION_REVERTED' });

    const relayed = await service().relayCancellation({ proposalId, signature: await U.sign({ hash: digest }) });
    expect(relayed.status).toBe('MINED');
    const proposal = (await pc.readContract({
      address: system.contracts.RotationTimelock as Address,
      abi: rotationTimelockAbi,
      functionName: 'getProposal',
      args: [proposalId],
    })) as { status: number };
    expect(proposal.status).toBe(2);
  });
});
