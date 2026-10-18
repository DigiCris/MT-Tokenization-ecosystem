// P15.T08: upgrade del Guard [C-GRD-17] (ADR-029) en el fork, con un Guard sucesor de prueba desplegado (SecurityGuard
// real con `predecessor` = el Guard del sistema, que importa los roles en su primer uso) y un DenyAllModuleGuard
// sucesor. Habilitado sólo con el sucesor activo en el PolicyRegistry (Governance Safe, 24 h); propuesta GUARD firmada
// por U, notificación, 48 h, `setGuard` GUARD_UPGRADE firmado por U y ejecutado por S. Con los sucesores fijados en el
// snapshot de policy (backend y signer), la Safe actualizada sigue en modo asistido: opera, propone rotaciones en el
// RotationTimelock del sucesor (cancelables por el relay) y actualiza su module guard.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createWalletClient, getAddress, getContractAddress, http, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { iSafeAbi, rotationTimelockAbi, securityGuardAbi } from '../../src/chain/abis/index.ts';
import { SAFE_SLOTS } from '../../src/wallets/verification.ts';
import { Governance, REGISTRY_DELAY_SECONDS } from '../helpers/governance.ts';
import { resetRateLimits, until } from '../helpers/onboarding.ts';
import {
  activeWallet,
  expireCreated,
  nextEmail,
  noopCall,
  operationRow,
  queueOperation,
  startOperationsEnv,
  statusOf,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';
import {
  executePrepare,
  executePrepareRequest,
  propose,
  proposeRequest,
  recoverySession,
  rotationRow,
  rotationView,
  signAndExecute,
  signCancel,
  syncRotations,
  warpTimelock,
} from '../helpers/rotations.ts';

const WALLET_ROOT = resolve(import.meta.dirname, '../../../..');

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(resolve(WALLET_ROOT, `contracts/out/${name}.sol/${name}.json`), 'utf8')) as {
    abi: Abi;
    bytecode: { object: Hex };
  };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

// Direcciones del sucesor predichas antes de arrancar el entorno (deployer fijo con nonce 0 y 1): el snapshot de
// policy las fija desde el inicio, como haría el operador al publicar la versión del snapshot con el sucesor.
const deployer = privateKeyToAccount(generatePrivateKey());
const guardV2 = getContractAddress({ from: deployer.address, nonce: 0n });
const timelockV2 = getContractAddress({ from: guardV2, nonce: 1n });
const moduleGuardV2 = getContractAddress({ from: deployer.address, nonce: 1n });

let env: OperationsEnv;
let wallet: ActiveWallet;
let governance: Governance;

beforeAll(async () => {
  env = await startOperationsEnv({
    redisDb: REDIS_DBS.guardUpgrade,
    snapshotSuccessors: {
      guards: [{ guard: guardV2, rotationTimelock: timelockV2 }],
      moduleGuards: [moduleGuardV2],
    },
  });
  wallet = await activeWallet(env);
  governance = new Governance(env);
  env.base.startDeployWorker();
  // Despliegue del sucesor (SecurityGuard con predecessor = el del sistema; factory sin código: sólo gobierna Safes
  // que lo instalen) y de un DenyAllModuleGuard nuevo.
  await env.chain.setBalance(deployer.address, 10n ** 19n);
  const client = createWalletClient({ account: deployer, chain: base, transport: http(env.chain.url) });
  const chainConfig = JSON.parse(readFileSync(resolve(WALLET_ROOT, 'config/chains/base-mainnet.json'), 'utf8')) as {
    contracts: { permit2: { address: Address } };
  };
  const c = env.base.snapshot.contracts;
  const guard = artifact('SecurityGuard');
  const guardTx = await client.deployContract({
    abi: guard.abi,
    bytecode: guard.bytecode,
    args: [
      c.policyRegistry,
      c.destinationWhitelist,
      c.denyAllModuleGuard,
      getAddress(`0x${'f2'.repeat(20)}`),
      c.safeL2Singleton,
      env.base.snapshot.codehashes.safeProxyRuntime,
      chainConfig.contracts.permit2.address,
      c.securityGuard,
    ],
    gas: 15_000_000n,
  });
  await env.chain.public.waitForTransactionReceipt({ hash: guardTx });
  const moduleGuard = artifact('DenyAllModuleGuard');
  const moduleTx = await client.deployContract({
    abi: moduleGuard.abi,
    bytecode: moduleGuard.bytecode,
    gas: 2_000_000n,
  });
  await env.chain.public.waitForTransactionReceipt({ hash: moduleTx });
  const timelock = await env.chain.public.readContract({
    address: guardV2,
    abi: securityGuardAbi,
    functionName: 'ROTATION_TIMELOCK',
  });
  expect(getAddress(timelock)).toBe(timelockV2);
  expect(await env.chain.public.getCode({ address: moduleGuardV2 })).not.toBe('0x');
}, 900_000);

afterAll(async () => {
  await env.close();
});

async function slot(slotKey: Hex): Promise<Address> {
  const word = await env.chain.public.getStorageAt({ address: wallet.safe, slot: slotKey });
  return getAddress(`0x${(word ?? '0x').slice(-40)}`);
}

describe('upgrade del Guard', { timeout: 900_000 }, () => {
  it('sin sucesor activo en el PolicyRegistry no se propone; con el sucesor (24 h) U propone, 48 h, setGuard → la Safe usa el sucesor', async () => {
    await resetRateLimits(env.base.redis);
    const early = await proposeRequest(wallet, { role: 'U' }, 'GUARD');
    expect(early.statusCode).toBe(409);
    const change = await governance.proposeSuccessorGuard(env.base.snapshot.contracts.securityGuard, guardV2);
    await env.chain.increaseTime(REGISTRY_DELAY_SECONDS);
    expect(await governance.activate(change)).toBe('success');

    await resetRateLimits(env.base.redis);
    const { rotation, operation } = await propose(wallet, { role: 'U' }, 'GUARD');
    expect(rotation).toMatchObject({
      role: 'GUARD',
      oldKey: env.base.snapshot.contracts.securityGuard,
      newKey: guardV2,
    });
    expect(operation.safeTx.to).toBe(env.base.snapshot.contracts.rotationTimelock);
    await signAndExecute(env, wallet, operation, { role: 'U' });
    await syncRotations(env);
    expect((await rotationRow(env, rotation.id)).status).toBe('PENDING_TIMELOCK');
    const email = await nextEmail(wallet.onboarded.user.account.email, 'Propuesta de rotación de clave');
    expect(email.text).toContain('Guard de seguridad de la Safe');

    // R no ejecuta un upgrade; antes de las 48 h tampoco U.
    const session = await recoverySession(wallet);
    const byR = await executePrepareRequest(wallet, { role: 'R', session }, rotation.id);
    expect(byR.statusCode).toBe(403);
    expect((await executePrepareRequest(wallet, { role: 'U' }, rotation.id)).statusCode).toBe(409);
    await warpTimelock(env);
    await env.rotationSync().runOnce();
    await expireCreated(env, wallet);
    const execution = await executePrepare(wallet, { role: 'U' }, rotation.id);
    expect(execution.operation).toMatchObject({
      operationType: 'GUARD_UPGRADE',
      decoded: { role: 'GUARD', newKey: guardV2 },
    });
    await signAndExecute(env, wallet, execution.operation, { role: 'U' });
    await syncRotations(env);
    expect((await rotationRow(env, rotation.id)).status).toBe('EXECUTED');
    expect(await slot(SAFE_SLOTS.guard)).toBe(guardV2);
    expect(
      await env.chain.public.readContract({
        address: guardV2,
        abi: securityGuardAbi,
        functionName: 'isRegistered',
        args: [wallet.safe],
      }),
    ).toBe(true);
  });

  it('la Safe actualizada sigue en modo asistido: NoOp por S con el sucesor (importa los roles) y la wallet ACTIVE', async () => {
    await expireCreated(env, wallet);
    const noop = await queueOperation(env, wallet, noopCall(wallet));
    await env.pipeline().processWallet(wallet.walletId);
    expect(await statusOf(env, noop.operationId)).toBe('MINED');
    const row = await operationRow(env, noop.operationId);
    const receipt = await env.chain.public.getTransactionReceipt({
      hash: `0x${(row.tx_hash ?? Buffer.alloc(0)).toString('hex')}`,
    });
    expect(receipt.logs.some((log) => getAddress(log.address) === guardV2)).toBe(true);
    const roles = await env.chain.public.readContract({
      address: guardV2,
      abi: securityGuardAbi,
      functionName: 'rolesOf',
      args: [wallet.safe],
    });
    expect(roles.initialized).toBe(true);
    expect(getAddress(roles.executor)).toBe(wallet.executor);
    const walletRow = await env.base.db.app
      .selectFrom('wallets')
      .select('status')
      .where('id', '=', wallet.walletId)
      .executeTakeFirstOrThrow();
    expect(walletRow.status).toBe('ACTIVE');
  });

  it('las rotaciones siguientes van al RotationTimelock del sucesor y se cancelan por el relay hacia ese timelock', async () => {
    await resetRateLimits(env.base.redis);
    await expireCreated(env, wallet);
    const { rotation, operation } = await propose(wallet, { role: 'U' }, 'S');
    expect(operation.safeTx.to).toBe(timelockV2);
    await signAndExecute(env, wallet, operation, { role: 'U' });
    await syncRotations(env);
    const row = await rotationRow(env, rotation.id);
    expect(row.status).toBe('PENDING_TIMELOCK');
    expect(getAddress(`0x${(row.timelock ?? Buffer.alloc(20)).toString('hex')}`)).toBe(timelockV2);
    const view = await rotationView(wallet, rotation.id);
    expect(view.cancelTypedData).toMatchObject({ domain: { verifyingContract: timelockV2 } });
    const relayed = await env.base.recovery
      .newClient()
      .post(`/api/v1/rotations/${rotation.id}/cancel`, { signature: await signCancel(wallet.userKey, view) });
    expect(relayed.statusCode, relayed.body).toBe(202);
    await until(async () => {
      const proposal = await env.chain.public.readContract({
        address: timelockV2,
        abi: rotationTimelockAbi,
        functionName: 'getProposal',
        args: [view.proposalId as Hex],
      });
      return proposal.status === 2 ? true : undefined;
    }, 60_000);
    await until(async () => {
      const audited = await env.base.db.app
        .selectFrom('audit_events')
        .select('id')
        .where('event_type', '=', 'ROTATION_CANCEL_RELAYED')
        .where('target_id', '=', rotation.id)
        .executeTakeFirst();
      return audited ? true : undefined;
    }, 60_000);
    await syncRotations(env);
    expect(await rotationRow(env, rotation.id)).toMatchObject({ status: 'CANCELLED', cancelled_by: 'U' });
  });

  it('upgrade del module guard: sucesor registrado, propuesta en el timelock del Guard vigente, 48 h, setModuleGuard', async () => {
    const change = await governance.proposeSuccessorModuleGuard(
      env.base.snapshot.contracts.denyAllModuleGuard,
      moduleGuardV2,
    );
    await env.chain.increaseTime(REGISTRY_DELAY_SECONDS);
    expect(await governance.activate(change)).toBe('success');
    await resetRateLimits(env.base.redis);
    await expireCreated(env, wallet);
    const { rotation, operation } = await propose(wallet, { role: 'U' }, 'MODULE_GUARD');
    expect(operation.safeTx.to).toBe(timelockV2);
    await signAndExecute(env, wallet, operation, { role: 'U' });
    await syncRotations(env);
    await warpTimelock(env);
    await env.rotationSync().runOnce();
    await expireCreated(env, wallet);
    const execution = await executePrepare(wallet, { role: 'U' }, rotation.id);
    expect(execution.operation.operationType).toBe('GUARD_UPGRADE');
    await signAndExecute(env, wallet, execution.operation, { role: 'U' });
    await syncRotations(env);
    expect((await rotationRow(env, rotation.id)).status).toBe('EXECUTED');
    expect(await slot(SAFE_SLOTS.moduleGuard)).toBe(moduleGuardV2);
    // Sigue operando con los dos sucesores.
    await expireCreated(env, wallet);
    const noop = await queueOperation(env, wallet, noopCall(wallet));
    await env.pipeline().processWallet(wallet.walletId);
    expect(await statusOf(env, noop.operationId)).toBe('MINED');
    const owners = await env.chain.public.readContract({
      address: wallet.safe,
      abi: iSafeAbi,
      functionName: 'getOwners',
    });
    expect(owners).toHaveLength(3);
  });
});
