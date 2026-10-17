// Flujo de co-firma de prueba: una wallet con S creada por el signer (POST /v1/keys), su Safe creada por la
// WalletFactory real, fondos reales del fork y pedidos a /v1/sign-safe-tx armados como los arma el backend.
import { encodeCall, SELECTORS, wordAddress, wordUint } from '../../src/chain/abi.ts';
import type { SafeTx } from '../../src/chain/safe-tx.ts';
import type { Hex } from '../../src/crypto/bytes.ts';
import type { Address } from '../../src/crypto/keccak.ts';
import { safeTx, safeTxJson, signSafeTxAs, testAccount, USDC_HOLDER, USDT_HOLDER, type TestAccount } from './chain.ts';
import { mintSession, newSessionKey, signEnvelope, type SessionKey } from './session.ts';
import type { SignerHarness } from './signer.ts';

export interface Wallet {
  walletId: string;
  userId: string;
  U: TestAccount;
  R: TestAccount;
  S: Address;
  attestation: string;
  safe: Address;
  sessionKey: SessionKey;
}

export async function createWallet(
  h: SignerHarness,
  funds = { usdc: 50_000_000_000n, usdt: 5_000_000_000n },
): Promise<Wallet> {
  const walletId = crypto.randomUUID();
  const created = (await h.client.post('/v1/keys', { walletId, reason: 'ONBOARDING' })).json() as {
    address: Address;
    attestation: string;
  };
  const U = testAccount();
  const R = testAccount();
  const safe = await h.chain.createSafe(h.contracts.walletFactory!, {
    userKey: U.address,
    recoveryKey: R.address,
    executor: created.address,
  });
  await h.chain.setBalance(created.address, 10n ** 18n);
  if (funds.usdc > 0n) await h.chain.fundToken(usdc(h), USDC_HOLDER, safe, funds.usdc);
  if (funds.usdt > 0n) await h.chain.fundToken(usdt(h), USDT_HOLDER, safe, funds.usdt);
  return {
    walletId,
    userId: crypto.randomUUID(),
    U,
    R,
    S: created.address,
    attestation: created.attestation,
    safe,
    sessionKey: newSessionKey(),
  };
}

export function usdc(h: SignerHarness): Address {
  return h.runtime.snapshot.snapshot.tokens.find((t) => t.symbol === 'USDC')!.address;
}

export function usdt(h: SignerHarness): Address {
  return h.runtime.snapshot.snapshot.tokens.find((t) => t.symbol === 'USDT')!.address;
}

export const transferData = (to: Address, amount: bigint): Hex =>
  encodeCall(SELECTORS.transfer, wordAddress(to), wordUint(amount));

/** Alta de destino por camino soberano U+R y espera de las 24 h de activación. */
export async function whitelistSovereign(
  h: SignerHarness,
  w: Wallet,
  destination: Address,
  activate = true,
): Promise<void> {
  const nonce = await h.chain.safeNonce(w.safe);
  await h.chain.execSovereign(
    w.safe,
    safeTx(h.contracts.destinationWhitelist!, encodeCall(SELECTORS.addDestination, wordAddress(destination)), nonce),
    [w.U, w.R],
  );
  if (activate) await h.chain.increaseTime(24 * 3600 + 60);
}

export interface RequestOptions {
  operationType: string;
  owner?: TestAccount;
  ownerRole?: 'U' | 'R';
  scope?: string;
  challengeAttestation?: string;
  keyAcceptance?: Record<string, unknown>;
  newKeyAttestation?: string;
  pairedSafeTx?: Record<string, unknown>;
  replacesSafeTxHash?: string;
  integrityAttestation?: string;
  policySnapshotVersion?: number;
  session?: { issuedAt?: number; expiresAt?: number; aud?: string[]; scope?: string };
  submittedAt?: number;
  envelopeSignature?: string;
  ownerSignature?: Hex;
  execution?: Partial<{ accountNonce: string; maxFeePerGas: string; maxPriorityFeePerGas: string; gasLimit: string }>;
  operationId?: string;
}

export async function fees(h: SignerHarness): Promise<{ maxFeePerGas: string; maxPriorityFeePerGas: string }> {
  const block = await h.chain.public.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  const priority = 1_000_000n;
  return { maxFeePerGas: (baseFee * 2n + priority).toString(), maxPriorityFeePerGas: priority.toString() };
}

/** Pedido de firma como lo arma el backend (sesión vigente, envelope firmado, nonce de cuenta y fees actuales). */
export async function signRequest(
  h: SignerHarness,
  w: Wallet,
  tx: SafeTx,
  o: RequestOptions,
): Promise<Record<string, unknown>> {
  const now = Math.floor(Date.now() / 1000);
  const issuedAt = o.session?.issuedAt ?? now - 10;
  const { token, sessionId } = mintSession({
    issuer: h.keys.issuer,
    sessionKey: w.sessionKey,
    userId: w.userId,
    walletId: w.walletId,
    safe: w.safe,
    scope: o.session?.scope ?? o.scope ?? (o.ownerRole === 'R' ? 'RECOVERY' : 'OPERATIONS'),
    issuedAt,
    ...(o.session?.expiresAt === undefined ? {} : { expiresAt: o.session.expiresAt }),
    ...(o.session?.aud === undefined ? {} : { aud: o.session.aud }),
  });
  const owner = o.owner ?? (o.ownerRole === 'R' ? w.R : w.U);
  const signed = signSafeTxAs(owner, w.safe, tx);
  const operationId = o.operationId ?? crypto.randomUUID();
  const envelope = { operationId, safeTxHash: signed.hash, sessionId, submittedAt: o.submittedAt ?? now - 5 };
  return {
    operationId,
    walletId: w.walletId,
    safe: w.safe,
    chainId: 8453,
    operationType: o.operationType,
    safeTx: safeTxJson(tx),
    ownerSignature: o.ownerSignature ?? signed.signature,
    ownerRole: o.ownerRole ?? 'U',
    platformSessionToken: token,
    submissionEnvelope: envelope,
    submissionEnvelopeSignature: o.envelopeSignature ?? signEnvelope(w.sessionKey, envelope),
    ...(o.challengeAttestation === undefined ? {} : { challengeAttestation: o.challengeAttestation }),
    ...(o.keyAcceptance === undefined ? {} : { keyAcceptance: o.keyAcceptance }),
    ...(o.newKeyAttestation === undefined ? {} : { newKeyAttestation: o.newKeyAttestation }),
    ...(o.pairedSafeTx === undefined ? {} : { pairedSafeTx: o.pairedSafeTx }),
    ...(o.replacesSafeTxHash === undefined ? {} : { replacesSafeTxHash: o.replacesSafeTxHash }),
    ...(o.integrityAttestation === undefined ? {} : { integrityAttestation: o.integrityAttestation }),
    policySnapshotVersion: o.policySnapshotVersion ?? h.runtime.snapshot.snapshot.version,
    execution: {
      accountNonce: (await h.chain.accountNonce(w.S)).toString(),
      ...(await fees(h)),
      ...o.execution,
    },
  };
}

/** SafeTx emparejada (SWAP N+1) con su envelope en la misma sesión. */
export function pairedSafeTx(
  h: SignerHarness,
  w: Wallet,
  tx: SafeTx,
  request: Record<string, unknown>,
): Record<string, unknown> {
  const signed = signSafeTxAs(w.U, w.safe, tx);
  const envelope = {
    operationId: crypto.randomUUID(),
    safeTxHash: signed.hash,
    sessionId: (request.submissionEnvelope as { sessionId: string }).sessionId,
    submittedAt: (request.submissionEnvelope as { submittedAt: number }).submittedAt,
  };
  return {
    operationId: envelope.operationId,
    safeTx: safeTxJson(tx),
    ownerSignature: signed.signature,
    submissionEnvelope: envelope,
    submissionEnvelopeSignature: signEnvelope(w.sessionKey, envelope),
  };
}

export async function signedRows(h: SignerHarness): Promise<number> {
  const row = await h.db.db
    .selectFrom('signed_safe_txs')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}
