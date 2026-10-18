// Creación de la Safe (P18.T02, [W-01], [F-SEC-08]). Con U registrada y R confirmada, la plataforma asigna S y calcula
// la Safe esperada; antes de que U firme la WalletCreationAuthorization la app verifica todo por su cuenta: la
// SignerKeyAttestation de S con la clave fijada en el build, que U sea su clave y R la que confirmó el usuario, el
// saltNonce, la dirección esperada y el configHash calculados con sus propias direcciones fijadas, y que el typed data
// que manda el backend sea exactamente el que arma la app (U firma el propio). Después del deploy la Safe sólo se
// muestra operativa si la verificación propia por el RPC del frontend (safe/verify.ts) da todo bien.
import { isAddressEqual, keccak256, type Address, type Hex } from 'viem';
import type { ExecutorAssignment, WalletApi, WalletView } from '../api/wallet-api.ts';
import type { PinnedChain } from '../config/chain.ts';
import type { SystemContracts } from '../config/system-contracts.ts';
import type { KeyEnvelope } from '../crypto/envelope.ts';
import { signTypedDataWithKey, withKey } from '../crypto/sign.ts';
import { PLATFORM_DOMAIN_NAME, PLATFORM_TYPES, walletCreationAuthorization } from '../crypto/typed-data.ts';
import { verifySignerKeyAttestation } from './attestation.ts';
import { predictSafeAddress, safeInitializer, walletSaltNonce, type WalletKeys } from './predict.ts';

export class CreationCheckError extends Error {
  override name = 'CreationCheckError';
  readonly items: readonly string[];

  constructor(items: readonly string[]) {
    super(`La plataforma propuso una Safe que esta app no puede confirmar (${items.join(', ')}): no se firma nada.`);
    this.items = items;
  }
}

export interface CreationPlan {
  walletId: string;
  keys: WalletKeys;
  saltNonce: bigint;
  expectedSafe: Address;
  enrollmentId: string;
  enrollmentNonce: Hex;
  shardId: string;
  authorization: ReturnType<typeof walletCreationAuthorization>;
}

const EIP712_DOMAIN = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function verifyExecutorAssignment(
  assignment: ExecutorAssignment,
  expected: {
    walletId: string;
    userId: string;
    platformId: string;
    userKey: Address;
    recoveryKey: Address;
    enrollmentId: string;
    /** Nonce del enrollment creado en esta pestaña; null si se retomó desde el link de regreso (sólo el id). */
    enrollmentNonce: Hex | null;
  },
  pinned: {
    chain: Pick<PinnedChain, 'safe'>;
    system: Pick<SystemContracts, 'contracts' | 'signerAttestationPublicKey'>;
  },
): Promise<CreationPlan> {
  const problems: string[] = [];
  const check = (ok: boolean, item: string) => {
    if (!ok) problems.push(item);
  };
  const c = pinned.system.contracts;
  check(assignment.walletId === expected.walletId, 'WALLET');
  check(isAddressEqual(assignment.userKey, expected.userKey), 'USER_KEY');
  check(isAddressEqual(assignment.recoveryKey, expected.recoveryKey), 'RECOVERY_KEY');
  check(assignment.enrollmentId === expected.enrollmentId, 'ENROLLMENT');
  const enrollmentNonce = expected.enrollmentNonce ?? assignment.enrollmentNonce;
  check(assignment.enrollmentNonce.toLowerCase() === enrollmentNonce.toLowerCase(), 'ENROLLMENT_NONCE');
  try {
    await verifySignerKeyAttestation(assignment.executorAttestation, pinned.system.signerAttestationPublicKey, {
      walletId: expected.walletId,
      executor: assignment.executor,
    });
  } catch {
    problems.push('EXECUTOR_ATTESTATION');
  }
  const keys: WalletKeys = {
    userKey: expected.userKey,
    recoveryKey: expected.recoveryKey,
    executor: assignment.executor,
  };
  const saltNonce = walletSaltNonce(expected.platformId, expected.walletId);
  check(assignment.saltNonce === saltNonce.toString(), 'SALT_NONCE');
  const predicted = predictSafeAddress(keys, saltNonce, {
    safeProxyFactory: pinned.chain.safe.proxyFactory,
    safeSingleton: pinned.chain.safe.singletonL2,
    safeBootstrap: c.bootstrap.address,
  });
  check(isAddressEqual(assignment.expectedSafe, predicted), 'EXPECTED_SAFE');
  check(assignment.configHash.toLowerCase() === keccak256(safeInitializer(keys, c.bootstrap.address)), 'CONFIG_HASH');
  const authorization = walletCreationAuthorization(c.factory.address, {
    userId: expected.userId,
    platformId: expected.platformId,
    walletId: expected.walletId,
    userKey: keys.userKey,
    recoveryKey: keys.recoveryKey,
    executor: keys.executor,
    saltNonce,
    expectedSafe: predicted,
    enrollmentNonce,
  });
  // El typed data del backend tiene que ser exactamente el propio (dominio con la factory fijada, tipos y mensaje).
  const remote = assignment.typedData;
  const domainOk =
    remote.domain.name === PLATFORM_DOMAIN_NAME &&
    remote.domain.version === '1' &&
    remote.domain.chainId === 8453 &&
    isAddressEqual(remote.domain.verifyingContract, c.factory.address);
  check(domainOk, 'TYPED_DATA_DOMAIN');
  const typesOk =
    remote.primaryType === 'WalletCreationAuthorization' &&
    sameJson(remote.types.WalletCreationAuthorization, PLATFORM_TYPES.WalletCreationAuthorization) &&
    (remote.types.EIP712Domain === undefined || sameJson(remote.types.EIP712Domain, EIP712_DOMAIN));
  check(typesOk, 'TYPED_DATA_TYPES');
  const m = remote.message;
  const messageOk =
    m.userId === expected.userId &&
    m.platformId === expected.platformId &&
    m.walletId === expected.walletId &&
    isAddressEqual(m.userKey, keys.userKey) &&
    isAddressEqual(m.recoveryKey, keys.recoveryKey) &&
    isAddressEqual(m.executor, keys.executor) &&
    m.saltNonce === saltNonce.toString() &&
    isAddressEqual(m.expectedSafe, predicted) &&
    m.enrollmentNonce.toLowerCase() === enrollmentNonce.toLowerCase();
  check(messageOk, 'TYPED_DATA_MESSAGE');
  if (problems.length > 0) throw new CreationCheckError(problems);
  return {
    walletId: expected.walletId,
    keys,
    saltNonce,
    expectedSafe: predicted,
    enrollmentId: expected.enrollmentId,
    enrollmentNonce,
    shardId: assignment.shardId,
    authorization,
  };
}

/** U firma la autorización armada por la app (descifrada sólo durante la firma). */
export async function signCreationAuthorization(
  key: { envelope: KeyEnvelope; encryptionKey: CryptoKey },
  plan: CreationPlan,
): Promise<Hex> {
  if (!isAddressEqual(key.envelope.keyAddress, plan.keys.userKey)) {
    throw new CreationCheckError(['USER_KEY']);
  }
  return withKey(key.envelope, key.encryptionKey, (privateKey) => signTypedDataWithKey(privateKey, plan.authorization));
}

/** Mensaje de la autorización como lo recibe el backend (uint256 en decimal). */
export function authorizationBody(plan: CreationPlan, signature: Hex) {
  const m = plan.authorization.message;
  return {
    authorization: {
      userId: m.userId,
      platformId: m.platformId,
      walletId: m.walletId,
      userKey: m.userKey,
      recoveryKey: m.recoveryKey,
      executor: m.executor,
      saltNonce: m.saltNonce.toString(),
      expectedSafe: m.expectedSafe,
      enrollmentNonce: m.enrollmentNonce,
    },
    signature,
  };
}

export class WalletCreationFailed extends Error {
  override name = 'WalletCreationFailed';
}

/** Espera a que la plataforma deje la wallet ACTIVE (o FAILED con su motivo); la verificación propia va después. */
export async function waitForDeployment(
  api: WalletApi,
  walletId: string,
  options: { sleep?: (ms: number) => Promise<void>; timeoutMs?: number; now?: () => number } = {},
): Promise<WalletView> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 300_000);
  for (;;) {
    const deployment = await api.walletDeployment(walletId);
    if (deployment.status === 'FAILED') {
      throw new WalletCreationFailed(
        `La plataforma no pudo verificar la Safe (${deployment.failureReason ?? 'sin detalle'}).`,
      );
    }
    if (deployment.status === 'ACTIVE') {
      const { wallet } = await api.myWallet();
      if (wallet?.id === walletId && wallet.status === 'ACTIVE') return wallet;
    }
    if (now() >= deadline) throw new WalletCreationFailed('El despliegue de la Safe está tardando: volvé a intentar.');
    await sleep(2_000);
  }
}
