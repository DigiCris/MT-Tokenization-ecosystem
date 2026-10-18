// P18.T02 [W-01] [F-SEC-08]: la app acepta la asignación de S sólo si todo lo que propone el backend es lo que ella
// calcula (atestación de S con la clave fijada, U propia, R confirmada, saltNonce, Safe esperada, configHash y el typed
// data exacto) y U firma la autorización que arma la app; cualquier campo distinto bloquea la firma con el ítem.
import { getAddress, keccak256, recoverTypedDataAddress, toBytes, type Address, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import jwsVectors from '../../test/vectors/wire/jws.json';
import systemVector from '../../test/vectors/system.json';
import { ApiClient } from '../api/client.ts';
import { WalletApi, type DeploymentInfo, type ExecutorAssignment } from '../api/wallet-api.ts';
import { pinnedChain } from '../config/chain.ts';
import { SYSTEM_ROLES, type SystemContracts } from '../config/system-contracts.ts';
import { fromBase64Url, toBase64Url } from '../crypto/bytes.ts';
import { sealKey } from '../crypto/envelope.ts';
import { defaultKdfParams } from '../crypto/kdf.ts';
import { addressOf } from '../crypto/keys.ts';
import { PLATFORM_TYPES } from '../crypto/typed-data.ts';
import {
  authorizationBody,
  CreationCheckError,
  signCreationAuthorization,
  verifyExecutorAssignment,
  waitForDeployment,
  WalletCreationFailed,
} from './creation.ts';
import { predictSafeAddress, safeInitializer, walletSaltNonce } from './predict.ts';

interface Token {
  name: string;
  publicJwk: { x: string };
  claims: { walletId: string; executor: Address };
  jws: string;
}
const attestation = (jwsVectors as unknown as { tokens: Token[] }).tokens.find(
  (t) => t.name === 'SignerKeyAttestation',
);
if (!attestation) throw new Error('vector sin SignerKeyAttestation');
const system = systemVector as unknown as {
  keys: Record<'user' | 'recovery' | 'executor', { label: string; address: Address }>;
  contracts: Record<string, Address>;
};
const spki = (x: string) =>
  btoa(
    String.fromCharCode(
      ...[0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00],
      ...fromBase64Url(x),
    ),
  );

const NAMES: Record<string, string> = {
  guard: 'securityGuard',
  timelock: 'rotationTimelock',
  policyRegistry: 'policyRegistry',
  whitelist: 'destinationWhitelist',
  swapExecutor: 'swapExecutor',
  bootstrap: 'safeBootstrap',
  factory: 'walletFactory',
  moduleGuard: 'denyAllModuleGuard',
};
const pinned = {
  chain: pinnedChain,
  system: {
    contracts: Object.fromEntries(
      SYSTEM_ROLES.map((role) => [role, { name: role, address: system.contracts[NAMES[role] ?? ''], codehash: '0x' }]),
    ),
    signerAttestationPublicKey: spki(attestation.publicJwk.x),
  } as unknown as Pick<SystemContracts, 'contracts' | 'signerAttestationPublicKey'>,
};

const WALLET_ID = attestation.claims.walletId;
const PLATFORM_ID = 'mt-default';
const USER_ID = '4f1c2d9e-6b7a-4c3d-9e8f-0a1b2c3d4e5f';
const ENROLLMENT_ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const NONCE: Hex = `0x${'5a'.repeat(32)}`;
const userKeyBytes = toBytes(keccak256(toBytes(system.keys.user.label)));
const keys = {
  userKey: system.keys.user.address,
  recoveryKey: system.keys.recovery.address,
  executor: attestation.claims.executor,
};
const saltNonce = walletSaltNonce(PLATFORM_ID, WALLET_ID);
const expectedSafe = predictSafeAddress(keys, saltNonce, {
  safeProxyFactory: pinnedChain.safe.proxyFactory,
  safeSingleton: pinnedChain.safe.singletonL2,
  safeBootstrap: system.contracts.safeBootstrap ?? '0x',
});
const expected = {
  walletId: WALLET_ID,
  userId: USER_ID,
  platformId: PLATFORM_ID,
  userKey: keys.userKey,
  recoveryKey: keys.recoveryKey,
  enrollmentId: ENROLLMENT_ID,
  enrollmentNonce: NONCE,
};

/** Asignación como la arma el backend (uint256 en decimal). */
function assignment(
  overrides: Partial<ExecutorAssignment> = {},
  message: Partial<ExecutorAssignment['typedData']['message']> = {},
): ExecutorAssignment {
  const base: ExecutorAssignment = {
    walletId: WALLET_ID,
    ...keys,
    shardId: 'dev-1',
    executorAttestation: attestation?.jws ?? '',
    saltNonce: saltNonce.toString(),
    expectedSafe,
    configHash: keccak256(safeInitializer(keys, system.contracts.safeBootstrap ?? '0x')),
    enrollmentId: ENROLLMENT_ID,
    enrollmentNonce: NONCE,
    typedData: {
      domain: {
        name: 'MTW Wallet',
        version: '1',
        chainId: 8453,
        verifyingContract: system.contracts.walletFactory ?? '0x',
      },
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        WalletCreationAuthorization: [...PLATFORM_TYPES.WalletCreationAuthorization],
      },
      primaryType: 'WalletCreationAuthorization',
      message: {
        userId: USER_ID,
        platformId: PLATFORM_ID,
        walletId: WALLET_ID,
        ...keys,
        saltNonce: saltNonce.toString(),
        expectedSafe,
        enrollmentNonce: NONCE,
        ...message,
      },
    },
  };
  return { ...base, ...overrides };
}

const itemsOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CreationCheckError) return error.items;
    throw error;
  }
  return [];
};

describe('asignación de S y Safe esperada', () => {
  it('todo coincide: plan con la Safe calculada y U firma la autorización propia', async () => {
    const plan = await verifyExecutorAssignment(assignment(), expected, pinned);
    expect(plan.expectedSafe).toBe(expectedSafe);
    expect(plan.keys).toEqual(keys);
    const encryptionKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    const envelope = await sealKey(
      userKeyBytes.slice(),
      encryptionKey,
      {
        platformId: PLATFORM_ID,
        chainId: 8453,
        walletId: WALLET_ID,
        role: 'U',
        keyAddress: addressOf(userKeyBytes),
        keyVersion: 1,
      },
      defaultKdfParams(toBase64Url(new Uint8Array(16))),
    );
    const signature = await signCreationAuthorization({ envelope, encryptionKey }, plan);
    expect(await recoverTypedDataAddress({ ...plan.authorization, signature })).toBe(getAddress(keys.userKey));
    const body = authorizationBody(plan, signature);
    expect(body.authorization.saltNonce).toBe(saltNonce.toString());
    expect(body.authorization.expectedSafe).toBe(expectedSafe);
  });

  it.each<[string, () => ExecutorAssignment, string[]]>([
    ['otra wallet', () => assignment({ walletId: '11111111-1111-4111-8111-111111111111' }), ['WALLET']],
    ['una U que no es la propia', () => assignment({ userKey: keys.executor }), ['USER_KEY']],
    ['una R que no es la confirmada', () => assignment({ recoveryKey: keys.executor }), ['RECOVERY_KEY']],
    ['otro enrollment', () => assignment({ enrollmentNonce: `0x${'00'.repeat(32)}` }), ['ENROLLMENT_NONCE']],
    ['S sin atestación válida', () => assignment({ executorAttestation: 'a.b.c' }), ['EXECUTOR_ATTESTATION']],
    ['otro saltNonce', () => assignment({ saltNonce: '1' }), ['SALT_NONCE']],
    ['otra Safe esperada', () => assignment({ expectedSafe: keys.recoveryKey }), ['EXPECTED_SAFE']],
    ['otro configHash', () => assignment({ configHash: `0x${'11'.repeat(32)}` }), ['CONFIG_HASH']],
    [
      'dominio con otra factory',
      () => {
        const a = assignment();
        return {
          ...a,
          typedData: { ...a.typedData, domain: { ...a.typedData.domain, verifyingContract: keys.userKey } },
        };
      },
      ['TYPED_DATA_DOMAIN'],
    ],
    [
      'tipos alterados',
      () => {
        const a = assignment();
        return { ...a, typedData: { ...a.typedData, types: { WalletCreationAuthorization: [] } } };
      },
      ['TYPED_DATA_TYPES'],
    ],
    ['mensaje con otra Safe', () => assignment({}, { expectedSafe: keys.executor }), ['TYPED_DATA_MESSAGE']],
    ['mensaje de otro usuario', () => assignment({}, { userId: 'otro' }), ['TYPED_DATA_MESSAGE']],
  ])('no firma con %s', async (_label, make, items) => {
    expect(await itemsOf(verifyExecutorAssignment(make(), expected, pinned))).toEqual(items);
  });

  it('retomada desde el link de regreso: sin el nonce local, usa el de la asignación (mismo enrollment)', async () => {
    const plan = await verifyExecutorAssignment(assignment(), { ...expected, enrollmentNonce: null }, pinned);
    expect(plan.enrollmentNonce).toBe(NONCE);
    expect(
      await itemsOf(
        verifyExecutorAssignment(assignment({ enrollmentId: 'otro' }), { ...expected, enrollmentNonce: null }, pinned),
      ),
    ).toEqual(['ENROLLMENT']);
  });

  it('la autorización sólo la firma la U del plan', async () => {
    const plan = await verifyExecutorAssignment(assignment(), expected, pinned);
    const other = { envelope: { keyAddress: keys.recoveryKey }, encryptionKey: {} } as never;
    expect(await itemsOf(signCreationAuthorization(other, plan))).toEqual(['USER_KEY']);
  });
});

describe('espera del despliegue', () => {
  const api = new WalletApi(new ApiClient({ baseUrl: 'https://api.example/api/v1' }));
  const deployment = (status: DeploymentInfo['status'], failureReason: string | null = null) =>
    ({ walletId: WALLET_ID, status, failureReason }) as DeploymentInfo;

  it('espera ACTIVE en la plataforma y devuelve la wallet', async () => {
    vi.spyOn(api, 'walletDeployment')
      .mockResolvedValueOnce(deployment('DEPLOYING'))
      .mockResolvedValueOnce(deployment('VERIFYING'))
      .mockResolvedValueOnce(deployment('ACTIVE'));
    vi.spyOn(api, 'myWallet').mockResolvedValue({
      wallet: { id: WALLET_ID, status: 'ACTIVE', chainId: 8453, safe: expectedSafe, createdAt: '', activatedAt: '' },
    });
    await expect(waitForDeployment(api, WALLET_ID, { sleep: () => Promise.resolve() })).resolves.toMatchObject({
      status: 'ACTIVE',
      safe: expectedSafe,
    });
  });

  it('FAILED con el motivo, o corte por tiempo', async () => {
    vi.spyOn(api, 'walletDeployment').mockResolvedValueOnce(deployment('FAILED', 'OWNERS'));
    await expect(waitForDeployment(api, WALLET_ID, { sleep: () => Promise.resolve() })).rejects.toThrow('OWNERS');
    let clock = 0;
    vi.spyOn(api, 'walletDeployment').mockResolvedValue(deployment('DEPLOYING'));
    await expect(
      waitForDeployment(api, WALLET_ID, {
        sleep: () => {
          clock += 10_000;
          return Promise.resolve();
        },
        now: () => clock,
        timeoutMs: 30_000,
      }),
    ).rejects.toBeInstanceOf(WalletCreationFailed);
  });
});
