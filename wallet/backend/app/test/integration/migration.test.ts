// P15.T06 / P15.TST.e: migración excepcional (ADR-026) completa en el fork, con la CLI real de operadores.
//
// Credencial sana R (U comprometida): un operador abre el caso y otro lo aprueba (el mismo no puede: doble aprobación
// obligatoria, TOTP por stdin) → wallet vieja MIGRATING (la plataforma deja de co-firmar lo demás) → onboarding de la
// Safe nueva con `migrated_from_wallet_id`, U nueva y la MISMA R (la U comprometida o una R distinta se rechazan) →
// sin autorización on-chain: rechazo del backend, del signer y revert del Guard → la Governance Safe propone la
// autorización (24 h; antes no se activa; un guardián puede cancelar otra) → prepare con R desde Recovery: un
// MIGRATION_TRANSFER por token con el saldo completo, firmado por R y ejecutado por S → sólo hacia la Safe autorizada
// → la sincronización deja la vieja MIGRATED y el caso COMPLETED, con emails al usuario.
//
// Credencial sana U (R comprometida): la Safe nueva reutiliza U con R nueva; U desbloquea la wallet vieja (OPAQUE con
// `walletId`) y firma la migración desde Wallet.
import { randomBytes } from 'node:crypto';
import { createWalletClient, encodeFunctionData, getAddress, http, type Address, type Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { iSafeAbi, securityGuardAbi } from '../../src/chain/abis/index.ts';
import { safeTxHash } from '../../src/chain/safe-tx.ts';
import { decodeRevertReason } from '../../src/operations/chain-context.ts';
import type { PreparedOperation } from '../../src/operations/intent.ts';
import { safeTxFromJson, safeTxToJson } from '../../src/operations/intent.ts';
import { submissionCanonical } from '../../src/platform-session/request-signature.ts';
import type { MigrationCaseView } from '../../src/recovery/migration.ts';
import { SignerClientError } from '../../src/signer-client/client.ts';
import { executorAccount } from '../helpers/compromised-signer.ts';
import { Governance, REGISTRY_DELAY_SECONDS } from '../helpers/governance.ts';
import {
  critical,
  deploy,
  enrollmentSubmission,
  idempotencyKey,
  KDF_PARAMS,
  newRecoveryKey,
  newUserKey,
  opaqueRecord,
  resetRateLimits,
  signCreationAuthorization,
  stepUp,
  type OnboardedWallet,
  type RecoveryKeyMaterial,
  type Session,
  type UserKeyMaterial,
} from '../helpers/onboarding.ts';
import { cliJson, operatorsCli, type OperatorsCli, type TestOperator } from '../helpers/operators.ts';
import {
  activeWallet,
  actorFor,
  nextEmail,
  revokeCall,
  settle,
  startOperationsEnv,
  USDC_HOLDER,
  USDT_HOLDER,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { newSessionKey, signP256, unlockWallet } from '../helpers/platform.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';
import { recoveryPost, signAndExecute, userPost } from '../helpers/rotations.ts';

const ZERO: Address = '0x0000000000000000000000000000000000000000';
const UNIT = 1_000_000n;

const erc20Abi = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

let env: OperationsEnv;
let cli: OperatorsCli;
let governance: Governance;
let alice: TestOperator;
let bob: TestOperator;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.migration });
  cli = operatorsCli(env.base);
  governance = new Governance(env);
  alice = await cli.add('alice');
  bob = await cli.add('bob');
}, 600_000);

afterAll(async () => {
  cli.cleanup();
  await env.close();
});

const random = (): Address => getAddress(`0x${randomBytes(20).toString('hex')}`);

async function walletStatus(walletId: string): Promise<string> {
  const row = await env.base.db.app
    .selectFrom('wallets')
    .select('status')
    .where('id', '=', walletId)
    .executeTakeFirstOrThrow();
  return row.status;
}

async function openAndApprove(old: ActiveWallet, healthy: 'U' | 'R'): Promise<MigrationCaseView> {
  const requested = cliJson(
    await cli.run(
      [
        'migration:request',
        '--wallet',
        old.walletId,
        '--healthy',
        healthy,
        '--reason',
        `credencial ${healthy === 'R' ? 'U' : 'R'} comprometida: cancela cada rotación (verificación reforzada)`,
        '--operator',
        alice.email,
      ],
      await alice.next(),
    ),
  ) as MigrationCaseView;
  expect(requested).toMatchObject({ status: 'REQUESTED', healthyRole: healthy, oldWalletId: old.walletId });
  return cliJson(
    await cli.run(['migration:approve', '--case', requested.id, '--operator', bob.email], await bob.next()),
  ) as MigrationCaseView;
}

/** Onboarding de la Safe nueva para el mismo usuario, con las claves dadas (una de ellas, la sana de la vieja). */
async function onboardReplacement(
  old: ActiveWallet,
  keys: {
    userKey: UserKeyMaterial;
    recovery: RecoveryKeyMaterial;
    enrollmentKey?: RecoveryKeyMaterial['enrollmentKey'];
  },
  checks: { rejectUserKey?: UserKeyMaterial; rejectRecovery?: RecoveryKeyMaterial } = {},
): Promise<OnboardedWallet> {
  const user = old.onboarded.user;
  // Cada step-up cuenta en el cupo de challenges del usuario (3 cada 10 min, [B-RL]).
  await resetRateLimits(env.base.redis);
  const onboarding = await stepUp(user.wallet, user.account.email, 'ONBOARDING');
  expect(onboarding.walletId).toBeNull();
  const created = await critical(user.wallet, onboarding, '/wallets', {}, { idempotencyKey: idempotencyKey() });
  expect(created.statusCode, created.body).toBe(201);
  const walletId = created.json<{ id: string }>().id;
  const row = await env.base.db.app
    .selectFrom('wallets')
    .select(['migrated_from_wallet_id', 'status'])
    .where('id', '=', walletId)
    .executeTakeFirstOrThrow();
  expect(row).toEqual({ migrated_from_wallet_id: old.walletId, status: 'CREATING' });

  const registerUser = async (material: UserKeyMaterial) => {
    const registrationRecord = await opaqueRecord(user.wallet, onboarding, walletId, material.authSecretHex);
    return critical(
      user.wallet,
      onboarding,
      `/wallets/${walletId}/user-key`,
      {
        userKey: material.account.address,
        kdfParams: KDF_PARAMS,
        storageFlags: { drive: true, file: true, qr: false, words: true },
        registrationRecord,
      },
      { idempotencyKey: idempotencyKey() },
    );
  };
  if (checks.rejectUserKey) {
    const rejected = await registerUser(checks.rejectUserKey);
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toMatchObject({ code: 'KEY_NOT_ALLOWED' });
  }
  const registered = await registerUser(keys.userKey);
  expect(registered.statusCode, registered.body).toBe(201);

  const requested = await critical(
    user.wallet,
    onboarding,
    `/wallets/${walletId}/recovery/enrollments`,
    {},
    {
      idempotencyKey: idempotencyKey(),
    },
  );
  expect(requested.statusCode, requested.body).toBe(201);
  const { enrollmentId, nonce } = requested.json<{ enrollmentId: string; nonce: Hex }>();
  const enrollmentKey = keys.enrollmentKey ?? keys.recovery.enrollmentKey;
  await resetRateLimits(env.base.redis);
  const enrollment = await stepUp(user.recovery, user.account.email, 'ENROLLMENT');
  expect(enrollment.walletId).toBe(walletId);
  const keyResponse = await critical(
    user.recovery,
    enrollment,
    `/recovery/enrollments/${enrollmentId}/enrollment-key`,
    {
      enrollmentKey: enrollmentKey.jwk,
    },
  );
  expect(keyResponse.statusCode, keyResponse.body).toBe(200);
  const submit = async (recovery: RecoveryKeyMaterial) =>
    critical(
      user.recovery,
      enrollment,
      `/recovery/enrollments/${enrollmentId}/submit`,
      await enrollmentSubmission(env.base, {
        userId: user.account.id,
        enrollmentId,
        nonce,
        recovery: { account: recovery.account, enrollmentKey },
      }),
    );
  if (checks.rejectRecovery) {
    const rejected = await submit(checks.rejectRecovery);
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toMatchObject({ code: 'KEY_NOT_ALLOWED' });
  }
  const submitted = await submit(keys.recovery);
  expect(submitted.statusCode, submitted.body).toBe(200);

  const assigned = await critical(user.wallet, onboarding, `/wallets/${walletId}/executor`, {});
  expect(assigned.statusCode, assigned.body).toBe(200);
  const plan = assigned.json<OnboardedWallet['plan']>();
  const signature = await signCreationAuthorization(keys.userKey.account, plan.typedData);
  const incorporated = await critical(user.wallet, onboarding, `/recovery/enrollments/${enrollmentId}/incorporate`, {
    authorization: { ...plan.typedData.message },
    signature,
  });
  expect(incorporated.statusCode, incorporated.body).toBe(200);
  const onboarded: OnboardedWallet = {
    user,
    walletId,
    userKey: keys.userKey,
    recoveryKey: keys.recovery,
    onboarding,
    enrollmentId,
    plan,
  };
  expect(await deploy(env.base, onboarded)).toBe('ACTIVE');
  return onboarded;
}

async function safeOf(walletId: string): Promise<Address> {
  const row = await env.base.db.app
    .selectFrom('wallets')
    .select('safe_address')
    .where('id', '=', walletId)
    .executeTakeFirstOrThrow();
  return getAddress(`0x${(row.safe_address ?? Buffer.alloc(20)).toString('hex')}`);
}

/** Capa 3: transferencia directa en la Safe con firmas válidas del owner y de S, enviada por S. */
async function directTransfer(
  old: ActiveWallet,
  owner: PrivateKeyAccount,
  token: Address,
  to: Address,
  amount: bigint,
): Promise<{ reason: string; status: 'success' | 'reverted' }> {
  const executor = executorAccount(env.base.executorShard, old.executor);
  await env.chain.setBalance(executor.address, 10n ** 18n);
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] });
  const tx = {
    to: token,
    value: 0n,
    data,
    operation: 0 as const,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO,
    refundReceiver: ZERO,
    nonce: await env.chain.safeNonce(old.safe),
  };
  const hash = safeTxHash(8453, old.safe, tx);
  const signed = await Promise.all(
    [owner, executor].map(async (s) => ({ owner: s.address, sig: await s.sign({ hash }) })),
  );
  signed.sort((a, b) => (BigInt(a.owner) < BigInt(b.owner) ? -1 : 1));
  const signatures: Hex = `0x${signed.map((s) => s.sig.slice(2)).join('')}`;
  const args = [token, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, signatures] as const;
  let reason = 'NO_REVERT';
  try {
    await env.chain.public.simulateContract({
      account: executor,
      address: old.safe,
      abi: iSafeAbi,
      functionName: 'execTransaction',
      args,
    });
  } catch (error) {
    let current: unknown = error;
    let raw: Hex | null = null;
    for (let depth = 0; depth < 8 && current && raw === null; depth++) {
      const candidate = current as { raw?: unknown; data?: unknown };
      if (typeof candidate.raw === 'string' && candidate.raw.startsWith('0x')) raw = candidate.raw as Hex;
      else if (typeof candidate.data === 'string' && candidate.data.startsWith('0x')) raw = candidate.data as Hex;
      current = (current as { cause?: unknown }).cause;
    }
    reason = decodeRevertReason(raw);
  }
  const client = createWalletClient({ account: executor, chain: base, transport: http(env.chain.url) });
  const txHash = await client.writeContract({
    address: old.safe,
    abi: iSafeAbi,
    functionName: 'execTransaction',
    args,
    gas: 1_500_000n,
  });
  const receipt = await env.chain.public.waitForTransactionReceipt({ hash: txHash });
  return { reason, status: receipt.status };
}

/** Capa 2: el MIGRATION_TRANSFER firmado por R directo al signer (sin operación del backend). */
async function signerRefusesMigration(
  old: ActiveWallet,
  rSession: Session,
  token: Address,
  to: Address,
  amount: bigint,
) {
  const nonce = await env.chain.safeNonce(old.safe);
  const safeTx = safeTxToJson({
    to: token,
    value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO,
    refundReceiver: ZERO,
    nonce,
  });
  const operationId = crypto.randomUUID();
  const hash = safeTxHash(8453, old.safe, safeTxFromJson(safeTx));
  const envelope = {
    operationId,
    safeTxHash: hash,
    sessionId: rSession.sessionId,
    submittedAt: Math.floor(Date.now() / 1000),
  };
  const fees = await env.base.rpc.feeData();
  const result = await env.base.executorShard.client
    .signSafeTx({
      operationId,
      walletId: old.walletId,
      safe: old.safe,
      chainId: 8453,
      operationType: 'MIGRATION_TRANSFER',
      safeTx,
      ownerSignature: await old.recoveryKey.sign({ hash }),
      ownerRole: 'R',
      platformSessionToken: rSession.token,
      submissionEnvelope: envelope,
      submissionEnvelopeSignature: signP256(rSession.key, submissionCanonical(envelope)),
      policySnapshotVersion: env.base.snapshot.version,
      execution: {
        accountNonce: String(await env.chain.public.getTransactionCount({ address: old.executor })),
        maxFeePerGas: fees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
      },
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(result).toBeInstanceOf(SignerClientError);
  return result as SignerClientError;
}

describe('credencial sana R (U comprometida)', { timeout: 900_000 }, () => {
  let old: ActiveWallet;
  let fresh: OnboardedWallet;
  let freshSafe: Address;
  let caseId: string;
  let rSession: Session;
  const balances = { USDC: 300n * UNIT, USDT: 200n * UNIT };

  beforeAll(async () => {
    old = await activeWallet(env);
    await env.chain.fund(env.base.snapshot.tokens.USDC, USDC_HOLDER, old.safe, balances.USDC);
    await env.chain.fund(env.base.snapshot.tokens.USDT, USDT_HOLDER, old.safe, balances.USDT);
  }, 600_000);

  it('doble aprobación obligatoria: el mismo operador no aprueba su caso; con otro, operator_actions y MIGRATING', async () => {
    const requested = cliJson(
      await cli.run(
        [
          'migration:request',
          '--wallet',
          old.walletId,
          '--healthy',
          'R',
          '--reason',
          'U comprometida: cancela cada rotación (verificación reforzada)',
          '--operator',
          alice.email,
        ],
        await alice.next(),
      ),
    ) as MigrationCaseView;
    caseId = requested.id;
    // El mismo operador (con otro paso TOTP válido) no puede aprobar.
    const self = await cli.run(['migration:approve', '--case', caseId, '--operator', alice.email], await alice.next());
    expect(self.code).toBe(1);
    expect(self.stderr).toContain('otro operador');
    expect(await walletStatus(old.walletId)).toBe('ACTIVE');
    const approved = cliJson(
      await cli.run(['migration:approve', '--case', caseId, '--operator', bob.email], await bob.next()),
    ) as MigrationCaseView;
    expect(approved).toMatchObject({ status: 'APPROVED', healthyRole: 'R' });
    expect(await walletStatus(old.walletId)).toBe('MIGRATING');
    const action = await env.base.db.app
      .selectFrom('operator_actions')
      .selectAll()
      .where('id', '=', approved.approvalActionId ?? '')
      .executeTakeFirstOrThrow();
    expect(action).toMatchObject({ action_type: 'EXCEPTIONAL_MIGRATION', approver_1: alice.id, approver_2: bob.id });
    const email = await nextEmail(old.onboarded.user.account.email, 'Se aprobó la migración de tu wallet');
    expect(email.text).toContain('tu clave de recuperación (R)');
    // Con la wallet en MIGRATING la plataforma no co-firma nada más con la U (comprometida).
    await expect(env.operations.prepare(old.actor, revokeCall(env, old))).rejects.toMatchObject({
      code: 'WALLET_NOT_ACTIVE',
    });
  });

  it('Safe nueva: U nueva y la misma R (la U comprometida y una R distinta se rechazan); deploy → ACTIVE', async () => {
    fresh = await onboardReplacement(
      old,
      { userKey: newUserKey(), recovery: old.onboarded.recoveryKey, enrollmentKey: newRecoveryKey().enrollmentKey },
      { rejectUserKey: old.onboarded.userKey, rejectRecovery: newRecoveryKey() },
    );
    freshSafe = await safeOf(fresh.walletId);
    const roles = await env.chain.public.readContract({
      address: env.base.snapshot.contracts.securityGuard,
      abi: securityGuardAbi,
      functionName: 'rolesOf',
      args: [freshSafe],
    });
    expect(getAddress(roles.recoveryKey)).toBe(old.recoveryKey.address);
    expect(getAddress(roles.userKey)).not.toBe(old.userKey.address);
    const reused = await env.base.db.app
      .selectFrom('wallet_keys_metadata')
      .select(['role', 'reused_from_wallet_id', 'status'])
      .where('wallet_id', '=', fresh.walletId)
      .where('role', '=', 'R')
      .executeTakeFirstOrThrow();
    expect(reused).toEqual({ role: 'R', reused_from_wallet_id: old.walletId, status: 'ACTIVE' });
    const migration = await env.base.db.app
      .selectFrom('migration_cases')
      .select('new_wallet_id')
      .where('id', '=', caseId)
      .executeTakeFirstOrThrow();
    expect(migration.new_wallet_id).toBe(fresh.walletId);
  });

  it('sin autorización on-chain: la API no prepara, el signer rechaza y el Guard revierte (TST.e)', async () => {
    await resetRateLimits(env.base.redis);
    rSession = await stepUp(
      old.onboarded.user.recovery,
      old.onboarded.user.account.email,
      'RECOVERY',
      undefined,
      old.walletId,
    );
    expect(rSession.walletId).toBe(old.walletId);
    const early = await recoveryPost(old, rSession, `/wallets/${old.walletId}/migration/prepare`);
    expect(early.statusCode).toBe(409);
    expect(early.json<{ detail: string }>().detail).toContain('autorización on-chain');
    const usdc = env.base.snapshot.tokens.USDC;
    const rActor = actorFor(old.onboarded.user.account.id, rSession);
    await expect(
      env.operations.prepare(rActor, {
        walletId: old.walletId,
        operationType: 'MIGRATION_TRANSFER',
        call: {
          to: usdc,
          data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [freshSafe, balances.USDC] }),
        },
      }),
    ).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
    const refused = await signerRefusesMigration(old, rSession, usdc, freshSafe, balances.USDC);
    expect(refused.code).toBe('POLICY_REJECTED');
    const direct = await directTransfer(old, old.recoveryKey, usdc, freshSafe, balances.USDC);
    expect(direct).toEqual({ reason: 'RecoveryCannotTransfer', status: 'reverted' });
  });

  it('la Governance Safe autoriza (24 h; un guardián puede cancelar) y sólo vale hacia la Safe autorizada', async () => {
    const id = await governance.proposeMigration(old.safe, freshSafe);
    expect(await governance.activate(id)).toBe('reverted');
    const other = random();
    const cancelled = await governance.proposeMigration(old.safe, other);
    expect(await governance.cancelAsGuardian(cancelled)).toBe('success');
    await env.chain.increaseTime(REGISTRY_DELAY_SECONDS);
    expect(await governance.activate(id)).toBe('success');
    expect(await governance.activate(cancelled)).toBe('reverted');
    expect(await governance.isMigrationAuthorized(old.safe, freshSafe)).toBe(true);
    expect(await governance.isMigrationAuthorized(old.safe, other)).toBe(false);
    // Hacia otra Safe no autorizada: el Guard revierte aun con R + S.
    const direct = await directTransfer(old, old.recoveryKey, env.base.snapshot.tokens.USDC, other, 1n * UNIT);
    expect(direct).toEqual({ reason: 'RecoveryCannotTransfer', status: 'reverted' });
  });

  it('prepare con R: MIGRATION_TRANSFER del saldo completo de cada token → firmado por R, ejecutado por S → MIGRATED', async () => {
    await resetRateLimits(env.base.redis);
    const response = await recoveryPost(old, rSession, `/wallets/${old.walletId}/migration/prepare`);
    expect(response.statusCode, response.body).toBe(200);
    const prepared = response.json<{
      destination: { safe: string; walletId: string };
      operations: PreparedOperation[];
    }>();
    expect(prepared.destination).toEqual({ safe: freshSafe, walletId: fresh.walletId });
    expect(
      prepared.operations.map((o) => [o.operationType, o.decoded.token, o.decoded.amount, o.decoded.destination]),
    ).toEqual([
      ['MIGRATION_TRANSFER', 'USDC', balances.USDC.toString(), freshSafe],
      ['MIGRATION_TRANSFER', 'USDT', balances.USDT.toString(), freshSafe],
    ]);
    for (const operation of prepared.operations) {
      await signAndExecute(env, old, operation, { role: 'R', session: rSession });
    }
    // La migración se cierra con las transferencias confirmadas (no apenas minadas).
    expect((await env.migrationSync().runOnce()).completed).toBe(0);
    for (const operation of prepared.operations) await settle(env, operation.operationId, 'CONFIRMED');
    expect(await env.chain.tokenBalance(env.base.snapshot.tokens.USDC, old.safe)).toBe(0n);
    expect(await env.chain.tokenBalance(env.base.snapshot.tokens.USDT, old.safe)).toBe(0n);
    expect(await env.chain.tokenBalance(env.base.snapshot.tokens.USDC, freshSafe)).toBe(balances.USDC);
    expect(await env.chain.tokenBalance(env.base.snapshot.tokens.USDT, freshSafe)).toBe(balances.USDT);
    const result = await env.migrationSync().runOnce();
    expect(result.completed).toBe(1);
    expect(await walletStatus(old.walletId)).toBe('MIGRATED');
    expect(await walletStatus(fresh.walletId)).toBe('ACTIVE');
    const finished = await env.base.db.app
      .selectFrom('migration_cases')
      .selectAll()
      .where('id', '=', caseId)
      .executeTakeFirstOrThrow();
    expect(finished.status).toBe('COMPLETED');
    expect(finished.completed_at).not.toBeNull();
    await nextEmail(old.onboarded.user.account.email, 'Migración de tu wallet completada');
    const audit = await env.base.db.app
      .selectFrom('audit_events')
      .select('event_type')
      .where('target_type', '=', 'migration_case')
      .where('target_id', '=', caseId)
      .orderBy('id')
      .execute();
    expect(audit.map((a) => a.event_type)).toEqual([
      'MIGRATION_CASE_REQUESTED',
      'MIGRATION_CASE_APPROVED',
      'MIGRATION_TRANSFER_PREPARED',
      'MIGRATION_COMPLETED',
    ]);
  });
});

describe('credencial sana U (R comprometida)', { timeout: 900_000 }, () => {
  it('la Safe nueva reutiliza U con R nueva; U desbloquea la wallet vieja y firma la migración desde Wallet', async () => {
    const old = await activeWallet(env);
    await env.chain.fund(env.base.snapshot.tokens.USDC, USDC_HOLDER, old.safe, 150n * UNIT);
    const approved = await openAndApprove(old, 'U');
    expect(await walletStatus(old.walletId)).toBe('MIGRATING');
    // Misma U (con una Password U nueva para la Safe nueva); la R comprometida no se puede reutilizar.
    const sameU: UserKeyMaterial = {
      account: old.onboarded.userKey.account,
      authSecretHex: newUserKey().authSecretHex,
    };
    const fresh = await onboardReplacement(
      old,
      { userKey: sameU, recovery: newRecoveryKey() },
      { rejectUserKey: newUserKey(), rejectRecovery: old.onboarded.recoveryKey },
    );
    const freshSafe = await safeOf(fresh.walletId);
    const id = await governance.proposeMigration(old.safe, freshSafe);
    await env.chain.increaseTime(REGISTRY_DELAY_SECONDS);
    expect(await governance.activate(id)).toBe('success');

    // Sin walletId el desbloqueo abre la Safe nueva (ACTIVE); con el de la vieja, su registro OPAQUE (MIGRATING).
    const unlocked = await unlockWallet(
      old.onboarded.user.wallet,
      old.onboarded.userKey.authSecretHex,
      newSessionKey(),
      old.walletId,
    );
    expect(unlocked.session).toMatchObject({ walletId: old.walletId, scope: 'OPERATIONS' });
    old.session = unlocked;
    old.actor = actorFor(old.onboarded.user.account.id, unlocked);
    await resetRateLimits(env.base.redis);
    const response = await userPost(old, `/wallets/${old.walletId}/migration/prepare`);
    expect(response.statusCode, response.body).toBe(200);
    const prepared = response.json<{ operations: PreparedOperation[] }>();
    expect(prepared.operations).toHaveLength(1);
    const transfer = prepared.operations[0] as PreparedOperation;
    await signAndExecute(env, old, transfer, { role: 'U' });
    await settle(env, transfer.operationId, 'CONFIRMED');
    expect(await env.chain.tokenBalance(env.base.snapshot.tokens.USDC, freshSafe)).toBe(150n * UNIT);
    expect((await env.migrationSync().runOnce()).completed).toBe(1);
    expect(await walletStatus(old.walletId)).toBe('MIGRATED');
    const view = cliJson(await cli.run(['migration:status', '--case', approved.id])) as MigrationCaseView;
    expect(view).toMatchObject({ status: 'COMPLETED', newWalletId: fresh.walletId });
  });
});
