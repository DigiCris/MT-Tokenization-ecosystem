// Escenarios por la API real (P12) con el mismo código de la app: cuenta verificada y, para los tests que necesitan la
// wallet ACTIVE (desbloqueo con OPERATIONS), el onboarding completo — U con su Password U y su sobre, enrollment de R por
// el listener de Recovery, S asignada por el signer, autorización de U, deploy por el gas tank y verificación on-chain.
import { argon2Sync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { ApiClient } from '../../../../src/api/client.ts';
import { canonicalize } from '../../../../src/api/jcs.ts';
import { generateSessionKey, signP256 } from '../../../../src/api/session-key.ts';
import type { User, WalletApi, WalletView } from '../../../../src/api/wallet-api.ts';
import { fromHex, toHex } from '../../../../src/crypto/bytes.ts';
import { addressOf } from '../../../../src/crypto/keys.ts';
import type { KeyEnvelope } from '../../../../src/crypto/envelope.ts';
import type { Argon2 } from '../../../../src/crypto/kdf.ts';
import { generatePassword } from '../../../../src/crypto/password.ts';
import { signTypedDataWithKey } from '../../../../src/crypto/sign.ts';
import { walletCreationAuthorization } from '../../../../src/crypto/typed-data.ts';
import type { Wordlist } from '../../../../src/crypto/wordlist.ts';
import {
  draftUserKey,
  ONBOARDING_KEY_VERSION,
  registerNewUserKey,
  sealUserKey,
} from '../../../../src/onboarding/user-key.ts';
import { finishStepUp, startStepUp, type StepUpSession } from '../../../../src/session/step-up.ts';
import { nextCode } from './mailpit.ts';
import { ACCOUNT_PASSWORD, recoveryClient, uniqueEmail, walletApi } from './node-api.ts';
import { freshClientIp, stack, walletFactory } from './stack.ts';

/** Argon2id nativo de Node (OpenSSL) con los mismos parámetros: el resultado es idéntico al del worker de la app. */
export const nodeArgon2: Argon2 = (input) =>
  Promise.resolve(
    new Uint8Array(
      argon2Sync('argon2id', {
        message: Buffer.from(input.password),
        nonce: Buffer.from(input.salt),
        parallelism: input.parallelism,
        tagLength: input.outputLength,
        memory: input.memoryKiB,
        passes: input.iterations,
      }),
    ),
  );

let wordlist: Wordlist | null = null;

export function testWordlist(): Wordlist {
  if (wordlist) return wordlist;
  const words = readFileSync(resolve(import.meta.dirname, '../../../../src/vendor/mtw-wordlist-v1.txt'), 'utf8')
    .trimEnd()
    .split('\n');
  wordlist = { words, index: new Map(words.map((w, i) => [w, i])) };
  return wordlist;
}

export interface Account {
  email: string;
  password: string;
  user: User;
  api: WalletApi;
}

/** Cuenta registrada y verificada (código real por Mailpit), con sesión abierta en `api`. */
export async function verifiedAccount(prefix?: string): Promise<Account> {
  freshClientIp();
  const api = walletApi();
  const email = uniqueEmail(prefix);
  await api.register({ email, password: ACCOUNT_PASSWORD });
  const { user } = await api.verifyEmail({ email, code: await nextCode(email) });
  return { email, password: ACCOUNT_PASSWORD, user, api };
}

export async function stepUp(
  api: WalletApi,
  email: string,
  scope: 'ONBOARDING' | 'U_REPLACEMENT' | 'KEY_RESTORE',
): Promise<StepUpSession> {
  const pending = await startStepUp(api, scope);
  return finishStepUp(api, pending, { code: await nextCode(email) });
}

export interface ActiveWallet extends Account {
  wallet: WalletView & { safe: Address };
  userKey: Uint8Array;
  userAddress: Address;
  passwordWords: string[];
  envelope: KeyEnvelope;
  /** R de la wallet (la tendría la app Recovery). */
  recovery: PrivateKeyAccount;
}

async function recoveryStepUp(client: ApiClient, email: string) {
  const key = await generateSessionKey();
  const started = await client.request<{ challengeId: string }>('POST', '/platform-sessions/step-up/start', {
    body: { scope: 'ENROLLMENT', sessionPublicKey: key.publicJwk },
  });
  const issued = await client.request<{ token: string; session: { id: string } }>(
    'POST',
    '/platform-sessions/step-up/finish',
    {
      body: { challengeId: started.challengeId, code: await nextCode(email) },
    },
  );
  return { token: issued.token, sessionId: issued.session.id, key };
}

/**
 * La parte de la app Recovery para un enrollment (P12, listener de Recovery): login con la misma cuenta, step-up
 * ENROLLMENT, Enrollment Key, prueba de control de R (EIP-712) y envío del enrollment firmado por la Enrollment Key. Para
 * un reemplazo (R′ de una wallet ACTIVE) agrega la KeyAcceptance de R′ con el nonce del enrollment.
 */
export async function submitRecovery(
  account: Pick<Account, 'email' | 'user'>,
  enrollment: { enrollmentId: string; nonce: Hex; walletId?: string },
  r: PrivateKeyAccount = privateKeyToAccount(generatePrivateKey()),
): Promise<PrivateKeyAccount> {
  const recovery = recoveryClient();
  await recovery.request('POST', '/auth/login', { body: { email: account.email, password: ACCOUNT_PASSWORD } });
  const enrollmentSession = await recoveryStepUp(recovery, account.email);
  const enrollmentKey = await generateSessionKey();
  await recovery.request('POST', `/recovery/enrollments/${enrollment.enrollmentId}/enrollment-key`, {
    platform: enrollmentSession,
    body: { enrollmentKey: enrollmentKey.publicJwk },
  });
  const issuedAt = new Date(Date.now() - 1_000);
  const enrollmentObject = {
    userId: account.user.id,
    platformId: stack().platformId,
    R: getAddress(r.address),
    nonce: enrollment.nonce,
    issuedAt: issuedAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    expiresAt: new Date(issuedAt.getTime() + 10 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  const domain = { name: 'MTW Wallet', version: '1', chainId: 8453, verifyingContract: walletFactory() } as const;
  const proofOfControl = await r.signTypedData({
    domain,
    types: {
      RecoveryProofOfControl: [
        { name: 'userId', type: 'string' },
        { name: 'platformId', type: 'string' },
        { name: 'enrollmentId', type: 'string' },
        { name: 'recoveryKey', type: 'address' },
      ],
    },
    primaryType: 'RecoveryProofOfControl',
    message: {
      userId: account.user.id,
      platformId: stack().platformId,
      enrollmentId: enrollment.enrollmentId,
      recoveryKey: enrollmentObject.R,
    },
  });
  const keyAcceptance =
    enrollment.walletId === undefined
      ? {}
      : {
          keyAcceptance: {
            nonce: enrollment.nonce,
            signature: await r.signTypedData({
              domain,
              types: {
                KeyAcceptance: [
                  { name: 'walletId', type: 'string' },
                  { name: 'role', type: 'uint8' },
                  { name: 'newKey', type: 'address' },
                  { name: 'nonce', type: 'bytes32' },
                ],
              },
              primaryType: 'KeyAcceptance',
              message: { walletId: enrollment.walletId, role: 2, newKey: enrollmentObject.R, nonce: enrollment.nonce },
            }),
          },
        };
  await recovery.request('POST', `/recovery/enrollments/${enrollment.enrollmentId}/submit`, {
    platform: enrollmentSession,
    body: {
      enrollment: enrollmentObject,
      enrollmentKeySignature: await signP256(enrollmentKey.privateKey, canonicalize(enrollmentObject)),
      rType: 'INTERNAL',
      proofOfControl,
      storageFlags: { drive: true, file: true, qr: false, words: false },
      ...keyAcceptance,
    },
  });
  return r;
}

/** Onboarding completo por la API hasta la Safe ACTIVE. */
export async function activeWallet(prefix?: string): Promise<ActiveWallet> {
  return onboardWallet(await verifiedAccount(prefix));
}

/**
 * Onboarding por la API de una wallet para una cuenta ya verificada, con una U nueva o con una existente (la U sana que
 * reutiliza la Safe nueva de una migración excepcional, sellada con una Password U nueva para esa wallet).
 */
export async function onboardWallet(account: Account, existingUserKey?: Uint8Array): Promise<ActiveWallet> {
  const { api, email } = account;
  const onboarding = await stepUp(api, email, 'ONBOARDING');
  const created = await api.createWallet(onboarding.platform);
  const fresh = draftUserKey(testWordlist());
  const draft =
    existingUserKey === undefined
      ? fresh
      : { ...fresh, key: existingUserKey.slice(), address: addressOf(existingUserKey) };
  const sealed = await sealUserKey(
    draft,
    draft.passwordWords.join(' '),
    { platformId: stack().platformId, walletId: created.id, keyVersion: ONBOARDING_KEY_VERSION },
    nodeArgon2,
  );
  await registerNewUserKey(api, onboarding.platform, sealed, { drive: false, file: true, qr: false, words: true });

  // Enrollment de R desde el listener de Recovery (la misma cuenta, su propia sesión).
  const enrollment = await api.client.request<{ enrollmentId: string; nonce: Hex }>(
    'POST',
    `/wallets/${created.id}/recovery/enrollments`,
    { platform: onboarding.platform, idempotencyKey: `idem-${crypto.randomUUID()}` },
  );
  const r = await submitRecovery(account, enrollment);

  // S del signer, autorización de U y deploy por el gas tank.
  const plan = await api.client.request<{
    typedData: { message: Record<string, string> };
  }>('POST', `/wallets/${created.id}/executor`, { platform: onboarding.platform });
  const message = plan.typedData.message;
  const authorization = {
    userId: message.userId ?? '',
    platformId: message.platformId ?? '',
    walletId: message.walletId ?? '',
    userKey: getAddress(message.userKey ?? ''),
    recoveryKey: getAddress(message.recoveryKey ?? ''),
    executor: getAddress(message.executor ?? ''),
    saltNonce: BigInt(message.saltNonce ?? '0'),
    expectedSafe: getAddress(message.expectedSafe ?? ''),
    enrollmentNonce: (message.enrollmentNonce ?? '0x') as Hex,
  };
  const signature = signTypedDataWithKey(draft.key, walletCreationAuthorization(walletFactory(), authorization));
  await api.client.request('POST', `/recovery/enrollments/${enrollment.enrollmentId}/incorporate`, {
    platform: onboarding.platform,
    body: { authorization: plan.typedData.message, signature },
  });
  await api.client.request('POST', `/wallets/${created.id}/deploy`, {
    platform: onboarding.platform,
    idempotencyKey: `idem-${crypto.randomUUID()}`,
  });
  const deadline = Date.now() + 240_000;
  for (;;) {
    const { wallet } = await api.myWallet();
    if (wallet?.status === 'ACTIVE' && wallet.safe) {
      return {
        ...account,
        wallet: { ...wallet, safe: wallet.safe },
        userKey: draft.key,
        userAddress: draft.address,
        passwordWords: draft.passwordWords,
        envelope: sealed.envelope,
        recovery: r,
      };
    }
    if (wallet?.status === 'FAILED' || Date.now() > deadline) {
      throw new Error(`la wallet no quedó ACTIVE (${wallet?.status ?? 'sin wallet'})`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  }
}

export function passwordWords(): string[] {
  return generatePassword(testWordlist());
}

export function keyHex(key: Uint8Array): string {
  return toHex(key);
}

export { fromHex };
