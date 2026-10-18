// P12.T07 y P12.TST contra el fork: verificación post-deploy de V9 §16 por lectura directa con quórum. La Safe de la
// WalletFactory verifica; Safes creadas con la SafeProxyFactory canónica pero FUERA de la factory, cada una con un ítem
// alterado (sin guard ni roles, threshold 1, fallback handler, módulo habilitado, otra singleton, claves que no son las
// esperadas), fallan con exactamente ese ítem. Una wallet cuya Safe no verifica queda FAILED: nunca ACTIVE, su
// registro OPAQUE y sus claves siguen PENDING y la Safe no se muestra.
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { iSafeAbi, iSafeProxyFactoryAbi, walletFactoryAbi } from '../../src/chain/abis/index.ts';
import { addressToBuffer } from '../../src/lib/bytes.ts';
import { verifyDeployedWallet, type ExpectedWallet } from '../../src/wallets/verification.ts';
import { deploy, onboard, startOnboardingEnv, type OnboardingEnv } from '../helpers/onboarding.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

const ZERO: Address = '0x0000000000000000000000000000000000000000';
/** Safe 1.5.0 singleton L1 de config/chains (referencia; el sistema usa SafeL2). */
const SAFE_L1_SINGLETON: Address = '0xFf51A5898e281Db6DfC7855790607438dF2ca44b';

let env: OnboardingEnv;
let funder: PrivateKeyAccount;

beforeAll(async () => {
  env = await startOnboardingEnv({ redisDb: REDIS_DBS.walletVerify });
  funder = privateKeyToAccount(generatePrivateKey());
  await env.anvil.rpc('anvil_setBalance', [funder.address, '0x56bc75e2d63100000']);
}, 600_000);
afterAll(async () => {
  await (env as OnboardingEnv | undefined)?.close();
});

const publicClient = () => createPublicClient({ chain: base, transport: http(env.anvil.url) });
const walletClient = () => createWalletClient({ account: funder, chain: base, transport: http(env.anvil.url) });
const randomKey = (): Address => privateKeyToAccount(generatePrivateKey()).address;

/** Safe creada directamente con la SafeProxyFactory canónica (fuera de la WalletFactory) con la config dada. */
async function safeOutsideFactory(config: {
  owners: Address[];
  threshold: bigint;
  fallbackHandler?: Address;
  singleton?: Address;
}): Promise<Address> {
  const initializer = encodeFunctionData({
    abi: iSafeAbi,
    functionName: 'setup',
    args: [config.owners, config.threshold, ZERO, '0x', config.fallbackHandler ?? ZERO, ZERO, 0n, ZERO],
  });
  const args = [config.singleton ?? env.snapshot.contracts.safeL2Singleton, initializer, BigInt(Date.now())] as const;
  const { result } = await publicClient().simulateContract({
    account: funder,
    address: env.snapshot.contracts.safeProxyFactory,
    abi: iSafeProxyFactoryAbi,
    functionName: 'createProxyWithNonceL2',
    args,
  });
  const hash = await walletClient().writeContract({
    address: env.snapshot.contracts.safeProxyFactory,
    abi: iSafeProxyFactoryAbi,
    functionName: 'createProxyWithNonceL2',
    args,
  });
  await publicClient().waitForTransactionReceipt({ hash });
  return getAddress(result);
}

/** Ejecuta una tx de la Safe (threshold 1) firmada por su único owner. */
async function execAsOwner(safe: Address, owner: PrivateKeyAccount, to: Address, data: Hex): Promise<void> {
  const nonce = await publicClient().readContract({ address: safe, abi: iSafeAbi, functionName: 'nonce' });
  const txHash = await publicClient().readContract({
    address: safe,
    abi: iSafeAbi,
    functionName: 'getTransactionHash',
    args: [to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, nonce],
  });
  const signature = await owner.sign({ hash: txHash });
  const hash = await walletClient().writeContract({
    address: safe,
    abi: iSafeAbi,
    functionName: 'execTransaction',
    args: [to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, signature],
  });
  const receipt = await publicClient().waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe('success');
}

async function failures(expected: ExpectedWallet): Promise<string[]> {
  const result = await verifyDeployedWallet(env.rpc, env.snapshot, expected);
  return result.ok ? [] : result.failures;
}

let factorySafe: ExpectedWallet;

describe('verificación post-deploy (V9 §16)', () => {
  it('la Safe desplegada por la WalletFactory verifica todos los ítems', async () => {
    const keys = { userKey: randomKey(), recoveryKey: randomKey(), executor: randomKey() };
    const saltNonce = BigInt(`0x${randomBytes(16).toString('hex')}`);
    const hash = await walletClient().writeContract({
      address: env.snapshot.contracts.walletFactory,
      abi: walletFactoryAbi,
      functionName: 'createWallet',
      args: [keys.userKey, keys.recoveryKey, keys.executor, saltNonce],
    });
    await publicClient().waitForTransactionReceipt({ hash });
    const safe = await publicClient().readContract({
      address: env.snapshot.contracts.walletFactory,
      abi: walletFactoryAbi,
      functionName: 'predictWalletAddress',
      args: [keys.userKey, keys.recoveryKey, keys.executor, saltNonce],
    });
    factorySafe = { safe, ...keys, saltNonce };
    const result = await verifyDeployedWallet(env.rpc, env.snapshot, factorySafe);
    expect(result.ok).toBe(true);
    expect(result.state).toMatchObject({ isWallet: true, threshold: '2', nonce: '0', modules: [], registered: true });
  });

  it('claves distintas de las de la Safe: OWNERS, ROLES y la dirección no corresponde', async () => {
    expect(await failures({ ...factorySafe, recoveryKey: randomKey() })).toEqual([
      'ADDRESS_MISMATCH',
      'OWNERS',
      'ROLES',
    ]);
    expect(await failures({ ...factorySafe, saltNonce: factorySafe.saltNonce + 1n })).toEqual(['ADDRESS_MISMATCH']);
  });

  it('una dirección sin Safe nunca verifica', async () => {
    const items = await failures({ ...factorySafe, safe: randomKey() });
    expect(items).toEqual(expect.arrayContaining(['NOT_A_FACTORY_WALLET', 'SAFE_PROXY_CODEHASH', 'OWNERS', 'GUARD']));
  });

  it('Safe fuera de la factory con los mismos owners y threshold 2: sin guard, module guard ni roles', async () => {
    const safe = await safeOutsideFactory({
      owners: [factorySafe.userKey, factorySafe.recoveryKey, factorySafe.executor],
      threshold: 2n,
    });
    expect(await failures({ ...factorySafe, safe })).toEqual([
      'NOT_A_FACTORY_WALLET',
      'ADDRESS_MISMATCH',
      'GUARD',
      'GUARD_CODEHASH',
      'MODULE_GUARD',
      'MODULE_GUARD_CODEHASH',
      'ROLES',
    ]);
  });

  it('cada ítem alterado aparece: threshold 1, fallback handler, módulo habilitado (y nonce), otra singleton', async () => {
    const owners = [factorySafe.userKey, factorySafe.recoveryKey, factorySafe.executor];
    const outside = ['NOT_A_FACTORY_WALLET', 'ADDRESS_MISMATCH'];
    const noGuard = ['GUARD', 'GUARD_CODEHASH', 'MODULE_GUARD', 'MODULE_GUARD_CODEHASH', 'ROLES'];

    const thresholdOne = await safeOutsideFactory({ owners, threshold: 1n });
    expect(await failures({ ...factorySafe, safe: thresholdOne })).toEqual([...outside, 'THRESHOLD', ...noGuard]);

    const withFallback = await safeOutsideFactory({ owners, threshold: 2n, fallbackHandler: randomKey() });
    expect(await failures({ ...factorySafe, safe: withFallback })).toEqual([
      ...outside,
      ...noGuard.slice(0, 4),
      'FALLBACK_HANDLER',
      'ROLES',
    ]);

    const otherSingleton = await safeOutsideFactory({ owners, threshold: 2n, singleton: SAFE_L1_SINGLETON });
    expect(await failures({ ...factorySafe, safe: otherSingleton })).toEqual([
      ...outside,
      'SINGLETON',
      'SINGLETON_CODEHASH',
      ...noGuard,
    ]);

    // Una Safe con un único owner conocido habilita un módulo (y su nonce deja de ser 0).
    const owner = privateKeyToAccount(generatePrivateKey());
    const withModule = await safeOutsideFactory({ owners: [owner.address], threshold: 1n });
    const enableModule = encodeFunctionData({
      abi: parseAbi(['function enableModule(address module)']),
      functionName: 'enableModule',
      args: [randomKey()],
    });
    await execAsOwner(withModule, owner, withModule, enableModule);
    expect(await failures({ ...factorySafe, safe: withModule })).toEqual([
      ...outside,
      'OWNERS',
      'THRESHOLD',
      'NONCE',
      ...noGuard.slice(0, 4),
      'MODULES',
      'ROLES',
    ]);
  });

  it('la wallet cuya Safe no verifica queda FAILED: nunca ACTIVE, OPAQUE y claves PENDING, sin Safe visible', async () => {
    const o = await onboard(env);
    // Estado anómalo: el deploy "minado" apunta a una Safe con otra configuración (creada fuera de la factory).
    const impostor = await safeOutsideFactory({
      owners: [o.userKey.account.address, o.recoveryKey.account.address, o.plan.executor],
      threshold: 2n,
    });
    await env.db.app
      .updateTable('wallets')
      .set({
        status: 'VERIFYING',
        expected_safe: addressToBuffer(impostor),
        safe_address: addressToBuffer(impostor),
        updated_at: sql`now()`,
      })
      .where('id', '=', o.walletId)
      .execute();
    const before = (await env.metrics.walletVerificationFailures.get()).values.length;

    expect(await env.deployer.handle(o.walletId)).toBe('FAILED');
    const wallet = await env.db.app
      .selectFrom('wallets')
      .select(['status', 'failure_reason', 'activated_at'])
      .where('id', '=', o.walletId)
      .executeTakeFirstOrThrow();
    expect(wallet).toMatchObject({ status: 'FAILED', activated_at: null });
    expect(wallet.failure_reason).toContain('NOT_A_FACTORY_WALLET');
    expect(wallet.failure_reason).toContain('GUARD');
    const opaqueRecords = await env.db.app
      .selectFrom('opaque_records')
      .select('status')
      .where('wallet_id', '=', o.walletId)
      .execute();
    expect(opaqueRecords.map((r) => r.status)).toEqual(['PENDING']);
    const keys = await env.db.app
      .selectFrom('wallet_keys_metadata')
      .select('status')
      .where('wallet_id', '=', o.walletId)
      .where('status', '=', 'ACTIVE')
      .execute();
    expect(keys).toHaveLength(0);
    // La wallet FAILED deja de ser la viva: GET /wallets/me no la muestra ni muestra la Safe.
    expect((await o.user.wallet.get('/api/v1/wallets/me')).json()).toEqual({ wallet: null });
    const info = await o.user.wallet.get(`/api/v1/wallets/${o.walletId}/deployment`);
    expect(info.json()).toMatchObject({ status: 'FAILED' });
    const audit = await env.db.app
      .selectFrom('audit_events')
      .select('payload')
      .where('wallet_id', '=', o.walletId)
      .where('event_type', '=', 'WALLET_VERIFICATION_FAILED')
      .executeTakeFirstOrThrow();
    expect((audit.payload as { failures: string[] }).failures).toContain('NOT_A_FACTORY_WALLET');
    expect((await env.metrics.walletVerificationFailures.get()).values.length).toBeGreaterThan(before);
    // Procesar otra vez el evento no la reactiva.
    expect(await env.deployer.handle(o.walletId)).toBe('FAILED');
  });

  it('la wallet con la Safe correcta pasa de VERIFYING a ACTIVE (camino del deployer)', async () => {
    const o = await onboard(env);
    expect(await deploy(env, o)).toBe('ACTIVE');
  });
});
