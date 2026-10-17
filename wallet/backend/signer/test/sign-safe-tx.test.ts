// P11.T03 / P11.TST [B-SIG-02], [B-Q-02] pasos 2–8 y 7b: el signer co-firma una SafeTx sólo tras repetir todos los
// checks con su propio RPC, DB y policy; la tx firmada se transmite y se mina en el fork real. Tabla de rechazos del
// planner (firma U inválida, sesión vencida, envelope ausente, nonce distinto, whitelist inactiva, saldo insuficiente,
// simulación que revierte, snapshot inválido o con versión menor, pausa de integridad, regla estática) más la regla
// (safe, nonce), el ledger de 24 h, el 2FA y la configuración de la Safe: en ningún rechazo sale una firma S.
import { encodeFunctionData } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeCall, SELECTORS, wordAddress } from '../src/chain/abi.ts';
import { bytesToHex } from '../src/crypto/bytes.ts';
import { selectorOf, type Address } from '../src/crypto/keccak.ts';
import { safeTx, signSafeTxAs, testAccount, type TestAccount } from './helpers/chain.ts';
import {
  createWallet,
  signRequest,
  signedRows,
  transferData,
  usdc,
  usdt,
  whitelistSovereign,
  type RequestOptions,
  type Wallet,
} from './helpers/flow.ts';
import { testSnapshot, writeSignedSnapshot } from './helpers/policy.ts';
import { attest } from './helpers/session.ts';
import { startHarness, type SignerHarness } from './helpers/signer.ts';
import { StartupError } from '../src/runtime.ts';
import { PolicySnapshotError } from '../src/policy/snapshot.ts';
import type { SafeTx } from '../src/chain/safe-tx.ts';

let h: SignerHarness;
let w: Wallet;
const DEST = testAccount().address;
const NOT_LISTED = testAccount().address;
const USD = (n: number) => BigInt(n) * 1_000_000n;

beforeAll(async () => {
  h = await startHarness();
  w = await createWallet(h);
  await whitelistSovereign(h, w, DEST);
});
afterAll(async () => {
  await (h as SignerHarness | undefined)?.close();
});

async function nonce(): Promise<bigint> {
  return h.chain.safeNonce(w.safe);
}

async function send(amount: bigint, to: Address = DEST, token?: Address): Promise<SafeTx> {
  return safeTx(token ?? usdc(h), transferData(to, amount), await nonce());
}

async function sign(tx: SafeTx, o: RequestOptions = { operationType: 'SEND' }) {
  const response = await h.client.post('/v1/sign-safe-tx', await signRequest(h, w, tx, o));
  return { status: response.status, body: response.json() as Record<string, unknown> };
}

/** Rechazo sin efectos: código esperado, sin firma en la respuesta y sin filas nuevas. */
async function expectRejected(tx: SafeTx, o: RequestOptions, code: string, reason?: string) {
  const before = await signedRows(h);
  const { status, body } = await sign(tx, o);
  expect(body, JSON.stringify(body)).toMatchObject({ code, ...(reason === undefined ? {} : { reason }) });
  expect(status).toBeGreaterThanOrEqual(400);
  expect(body.sSignature).toBeUndefined();
  expect(body.signedTx).toBeUndefined();
  expect(await signedRows(h)).toBe(before);
}

async function signAndMine(tx: SafeTx, o: RequestOptions = { operationType: 'SEND' }) {
  const { status, body } = await sign(tx, o);
  expect(status, JSON.stringify(body)).toBe(200);
  const sent = await h.chain.sendRaw(body.signedTx as `0x${string}`);
  expect(sent.status).toBe('success');
  return body;
}

function highValue(tx: SafeTx, amount: bigint, to: Address = DEST, overrides: Record<string, unknown> = {}): string {
  const { hash } = signSafeTxAs(w.U, w.safe, tx);
  return attest(h.keys.issuer, {
    challengeId: `chl_${crypto.randomUUID()}`,
    type: 'HIGH_VALUE_TX',
    userId: w.userId,
    safe: w.safe,
    chainId: 8453,
    action: 'SEND',
    destination: to,
    safeTxHash: hash,
    token: tx.to,
    amount: amount.toString(),
    nonce: Number(tx.nonce),
    completedAt: Math.floor(Date.now() / 1000) - 30,
    ...overrides,
  });
}

describe('co-firma de un SEND', () => {
  it('firma, se transmite y se mina: DEST recibe los USDC', async () => {
    const tx = await send(USD(100));
    const body = await signAndMine(tx);
    expect(body.executor).toBe(w.S);
    expect(await h.chain.tokenBalance(usdc(h), DEST)).toBe(USD(100));
    expect(await h.chain.safeNonce(w.safe)).toBe(tx.nonce + 1n);
  });
});

describe('tabla de rechazos (P11.TST)', () => {
  it('firma U inválida: de otra clave → OWNER_NOT_ROLE; con s alto → OWNER_SIGNATURE_INVALID', async () => {
    const tx = await send(USD(10));
    await expectRejected(tx, { operationType: 'SEND', owner: testAccount() }, 'OWNER_NOT_ROLE', 'U');
    const { signature } = signSafeTxAs(w.U, w.safe, tx);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const s = BigInt(`0x${signature.slice(66, 130)}`);
    const v = signature.slice(130) === '1b' ? '1c' : '1b';
    const highS = `${signature.slice(0, 66)}${(n - s).toString(16).padStart(64, '0')}${v}` as `0x${string}`;
    await expectRejected(tx, { operationType: 'SEND', ownerSignature: highS }, 'OWNER_SIGNATURE_INVALID', 'HIGH_S');
    // R firmando con scope de U: R no es el rol U.
    await expectRejected(tx, { operationType: 'SEND', owner: w.R }, 'OWNER_NOT_ROLE', 'U');
  });

  it('sesión vencida al momento del envío → SESSION_INVALID', async () => {
    const tx = await send(USD(10));
    const now = Math.floor(Date.now() / 1000);
    await expectRejected(
      tx,
      { operationType: 'SEND', session: { issuedAt: now - 2_000, expiresAt: now - 1_100 }, submittedAt: now - 60 },
      'SESSION_INVALID',
      'OUTSIDE_SESSION',
    );
  });

  it('envelope ausente o firmado con otra clave → SESSION_INVALID; envío de más de 24 h → SIGNATURE_STALE', async () => {
    const tx = await send(USD(10));
    await expectRejected(
      tx,
      { operationType: 'SEND', envelopeSignature: 'A'.repeat(86) },
      'SESSION_INVALID',
      'ENVELOPE_SIGNATURE',
    );
    const now = Math.floor(Date.now() / 1000);
    await expectRejected(
      tx,
      {
        operationType: 'SEND',
        session: { issuedAt: now - 90_000, expiresAt: now - 89_200 },
        submittedAt: now - 89_500,
      },
      'SIGNATURE_STALE',
    );
    await expectRejected(tx, { operationType: 'SEND', session: { aud: ['mtw-api'] } }, 'SESSION_INVALID', 'AUDIENCE');
  });

  it('nonce distinto del on-chain → NONCE_NOT_REACHED (reintentable) o NONCE_CONSUMED', async () => {
    const current = await nonce();
    await expectRejected(
      safeTx(usdc(h), transferData(DEST, USD(10)), current + 1n),
      { operationType: 'SEND' },
      'NONCE_NOT_REACHED',
    );
    await expectRejected(
      safeTx(usdc(h), transferData(DEST, USD(10)), current - 1n),
      { operationType: 'SEND' },
      'NONCE_CONSUMED',
    );
  });

  it('whitelist inactiva: destino no listado o recién agregado (sin 24 h) → DESTINATION_NOT_WHITELISTED', async () => {
    await expectRejected(
      await send(USD(10), NOT_LISTED),
      { operationType: 'SEND' },
      'POLICY_REJECTED',
      'DESTINATION_NOT_WHITELISTED',
    );
    const fresh = testAccount().address;
    await whitelistSovereign(h, w, fresh, false);
    await expectRejected(
      await send(USD(10), fresh),
      { operationType: 'SEND' },
      'POLICY_REJECTED',
      'DESTINATION_NOT_WHITELISTED',
    );
  });

  it('saldo insuficiente → INSUFFICIENT_BALANCE', async () => {
    const tx = await send(USD(6_000), DEST, usdt(h));
    await expectRejected(
      tx,
      { operationType: 'SEND', challengeAttestation: highValue(tx, USD(6_000)) },
      'POLICY_REJECTED',
      'INSUFFICIENT_BALANCE',
    );
  });

  it('la simulación revierte (destino bloqueado por el emisor de USDC) → SIMULATION_REVERTED', async () => {
    const blacklister = await h.chain.public.readContract({
      address: usdc(h),
      abi: [
        {
          type: 'function',
          name: 'blacklister',
          stateMutability: 'view',
          inputs: [],
          outputs: [{ name: '', type: 'address' }],
        },
      ] as const,
      functionName: 'blacklister',
    });
    const abi = [
      {
        type: 'function',
        name: 'blacklist',
        stateMutability: 'nonpayable',
        inputs: [{ name: 'a', type: 'address' }],
        outputs: [],
      },
      {
        type: 'function',
        name: 'unBlacklist',
        stateMutability: 'nonpayable',
        inputs: [{ name: 'a', type: 'address' }],
        outputs: [],
      },
    ] as const;
    await h.chain.impersonate(blacklister, {
      to: usdc(h),
      data: encodeFunctionData({ abi, functionName: 'blacklist', args: [DEST] }),
    });
    try {
      await expectRejected(await send(USD(10)), { operationType: 'SEND' }, 'SIMULATION_REVERTED');
    } finally {
      await h.chain.impersonate(blacklister, {
        to: usdc(h),
        data: encodeFunctionData({ abi, functionName: 'unBlacklist', args: [DEST] }),
      });
    }
  });

  it('versión del snapshot distinta de la vigente → POLICY_VERSION_MISMATCH', async () => {
    await expectRejected(
      await send(USD(10)),
      { operationType: 'SEND', policySnapshotVersion: 2 },
      'POLICY_VERSION_MISMATCH',
    );
  });

  it('regla estática violada (DELEGATECALL, destino fuera de la allowlist) → STATIC_RULE_VIOLATION', async () => {
    const tx = { ...(await send(USD(10))), operation: 1 };
    await expectRejected(tx, { operationType: 'SEND' }, 'STATIC_RULE_VIOLATION', 'SR-02');
    const permit2 = safeTx(
      usdc(h),
      encodeCall(SELECTORS.approve, wordAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3'), new Uint8Array(32)),
      await nonce(),
    );
    await expectRejected(permit2, { operationType: 'SWAP_APPROVE' }, 'STATIC_RULE_VIOLATION', 'SR-06');
    const arbitrary = safeTx(DEST, encodeCall(selectorOf('doSomething()')), await nonce());
    await expectRejected(arbitrary, { operationType: 'SEND' }, 'STATIC_RULE_VIOLATION', 'SR-06');
  });

  it('scope RECOVERY no co-firma un SEND de U → OPERATION_NOT_ALLOWED', async () => {
    await expectRejected(
      await send(USD(10)),
      { operationType: 'SEND', scope: 'RECOVERY' },
      'POLICY_REJECTED',
      'OPERATION_NOT_ALLOWED',
    );
  });

  it('nonce de cuenta de S distinto, topes de fee y S sin ETH para el gas', async () => {
    const tx = await send(USD(10));
    await expectRejected(tx, { operationType: 'SEND', execution: { accountNonce: '999' } }, 'ACCOUNT_NONCE_MISMATCH');
    await expectRejected(
      tx,
      { operationType: 'SEND', execution: { maxFeePerGas: (10n ** 11n).toString() } },
      'STATIC_RULE_VIOLATION',
      'SR-14',
    );
    await h.chain.setBalance(w.S, 0n);
    try {
      await expectRejected(tx, { operationType: 'SEND' }, 'INSUFFICIENT_GAS_FUNDS');
    } finally {
      await h.chain.setBalance(w.S, 10n ** 18n);
    }
  });
});

describe('2FA de alto valor y ledger de 24 h [B-POL-02]', () => {
  it('1.000 o más sin atestación o con una que no coincide → TWO_FACTOR_REQUIRED', async () => {
    const tx = await send(USD(1_000));
    await expectRejected(tx, { operationType: 'SEND' }, 'POLICY_REJECTED', 'TWO_FACTOR_REQUIRED');
    await expectRejected(
      tx,
      { operationType: 'SEND', challengeAttestation: highValue(tx, USD(999)) },
      'POLICY_REJECTED',
      'TWO_FACTOR_REQUIRED',
    );
    await expectRejected(
      tx,
      { operationType: 'SEND', challengeAttestation: highValue(tx, USD(1_000), DEST, { userId: crypto.randomUUID() }) },
      'POLICY_REJECTED',
      'TWO_FACTOR_REQUIRED',
    );
  });

  it('con la atestación ligada a la operación, 9.000 + 9.000 pasan y 2.500 más superan el tope diario', async () => {
    for (const amount of [USD(9_000), USD(9_000)]) {
      const tx = await send(amount);
      await signAndMine(tx, { operationType: 'SEND', challengeAttestation: highValue(tx, amount) });
    }
    // Ya salieron 100 + 9.000 + 9.000 = 18.100 en 24 h.
    const tx = await send(USD(2_500));
    await expectRejected(
      tx,
      { operationType: 'SEND', challengeAttestation: highValue(tx, USD(2_500)) },
      'POLICY_REJECTED',
      'LIMIT_DAILY',
    );
    await signAndMine(await send(USD(900)));
  });
});

describe('una SafeTx activa por (safe, nonce) [B-SIG-03]', () => {
  it('otra SafeTx en el mismo nonce se rechaza; la NoOp la reemplaza y gana el nonce', async () => {
    const first = await send(USD(5));
    const signed = await sign(first);
    expect(signed.status).toBe(200);
    // Re-firma de la misma SafeTx (reintento o fee bump): permitida.
    expect((await sign(first)).status).toBe(200);
    await expectRejected(
      safeTx(usdc(h), transferData(DEST, USD(6)), first.nonce),
      { operationType: 'SEND' },
      'SAFE_NONCE_CONFLICT',
    );
    const noop = safeTx(w.safe, '0x', first.nonce);
    const replaced = await signAndMine(noop, { operationType: 'NOOP_CANCEL' });
    expect(replaced.safeTxHash).not.toBe(signed.body.safeTxHash);
    const rows = await h.db.db
      .selectFrom('signed_safe_txs')
      .select(['safe_tx_hash', 'status', 'op_type'])
      .where('nonce', '=', first.nonce.toString())
      .execute();
    expect(rows.find((r) => r.op_type === 'SEND')?.status).toBe('REPLACED');
    expect(rows.find((r) => r.op_type === 'NOOP_CANCEL')?.status).toBe('ACTIVE');
    // La SafeTx original firmada por S ya no puede ejecutarse: su nonce lo consumió la NoOp.
    expect(await h.chain.safeNonce(w.safe)).toBe(first.nonce + 1n);
  });

  it('un reemplazo explícito con nueva firma del usuario nombra la SafeTx que reemplaza', async () => {
    const first = await send(USD(7));
    const a = await sign(first);
    expect(a.status).toBe(200);
    const second = safeTx(usdc(h), transferData(DEST, USD(8)), first.nonce);
    await signAndMine(second, { operationType: 'SEND', replacesSafeTxHash: a.body.safeTxHash as string });
  });
});

describe('alta de whitelist con challenge', () => {
  it('WHITELIST_ADD sólo con la atestación WHITELIST_ADD ligada a la SafeTx', async () => {
    const target = testAccount().address;
    const tx = safeTx(
      h.contracts.destinationWhitelist!,
      encodeCall(SELECTORS.addDestination, wordAddress(target)),
      await nonce(),
    );
    await expectRejected(tx, { operationType: 'WHITELIST_ADD' }, 'POLICY_REJECTED', 'CHALLENGE_REQUIRED');
    const { hash } = signSafeTxAs(w.U, w.safe, tx);
    const attestation = attest(h.keys.issuer, {
      challengeId: 'chl_wl',
      type: 'WHITELIST_ADD',
      userId: w.userId,
      safe: w.safe,
      chainId: 8453,
      action: 'WHITELIST_ADD',
      destination: target,
      safeTxHash: hash,
      nonce: Number(tx.nonce),
      completedAt: Math.floor(Date.now() / 1000) - 10,
    });
    await signAndMine(tx, { operationType: 'WHITELIST_ADD', challengeAttestation: attestation });
  });
});

describe('pausa por integridad [B-SIG-02]', () => {
  it('con INTEGRITY_REQUIRED=true sólo co-firma con una IntegrityAttestation OK y vigente de la app', async () => {
    await h.restart({ INTEGRITY_REQUIRED: 'true' });
    try {
      await expectRejected(await send(USD(10)), { operationType: 'SEND' }, 'INTEGRITY_PAUSED', 'WALLET');
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        platformId: 'mtw',
        app: 'WALLET',
        environment: 'local',
        releaseId: 'wallet-local',
        manifestSha256: `0x${'ab'.repeat(32)}`,
        status: 'OK',
        observedAt: now - 30,
        expiresAt: now + 600,
      };
      await expectRejected(
        await send(USD(10)),
        { operationType: 'SEND', integrityAttestation: attest(h.keys.monitor, { ...claims, status: 'MISMATCH' }) },
        'INTEGRITY_PAUSED',
      );
      await expectRejected(
        await send(USD(10)),
        { operationType: 'SEND', integrityAttestation: attest(h.keys.monitor, { ...claims, expiresAt: now - 1 }) },
        'INTEGRITY_PAUSED',
      );
      await expectRejected(
        await send(USD(10)),
        { operationType: 'SEND', integrityAttestation: attest(h.keys.issuer, claims) },
        'INTEGRITY_PAUSED',
      );
      await signAndMine(await send(USD(10)), {
        operationType: 'SEND',
        integrityAttestation: attest(h.keys.monitor, claims),
      });
    } finally {
      await h.restart({ INTEGRITY_REQUIRED: 'false' });
    }
  });
});

describe('snapshot de policy al arrancar [B-POL-01]', () => {
  it('firma inválida o versión menor a la vigente: el shard no arranca', async () => {
    const dir = h.ws.root;
    // Versión 2 válida: se activa (anti-rollback la registra).
    const v2 = writeSignedSnapshot(dir, testSnapshot(2), h.keys.policy, 'v2.json');
    await h.restart({ POLICY_SNAPSHOT_PATH: v2 });
    expect(h.runtime.snapshot.snapshot.version).toBe(2);
    const v1 = writeSignedSnapshot(dir, testSnapshot(1), h.keys.policy, 'v1.json');
    await expect(h.restart({ POLICY_SNAPSHOT_PATH: v1 })).rejects.toThrow(PolicySnapshotError);
    const forged = writeSignedSnapshot(dir, testSnapshot(3), { ...h.keys.issuer }, 'forged.json');
    await expect(h.restart({ POLICY_SNAPSHOT_PATH: forged })).rejects.toThrow(/firma del snapshot/);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      `${dir}/v2-tampered.json`,
      (await import('node:fs')).readFileSync(v2, 'utf8').replace('"version": 2', '"version": 4'),
    );
    writeFileSync(`${dir}/v2-tampered.json.sig`, (await import('node:fs')).readFileSync(`${v2}.sig`, 'utf8'));
    await expect(h.restart({ POLICY_SNAPSHOT_PATH: `${dir}/v2-tampered.json` })).rejects.toThrow(/firma del snapshot/);
    await h.restart({ POLICY_SNAPSHOT_PATH: v2 });
    expect(StartupError).toBeDefined();
  });
});

describe('configuración de la Safe modificada soberanamente (paso 7b)', () => {
  it('U+R instalan un fallback handler: el signer no co-firma (SAFE_CONFIG_MODIFIED)', async () => {
    const other = await createWallet(h, { usdc: 0n, usdt: 0n });
    const handler = testAccount().address;
    await h.chain.execSovereign(
      other.safe,
      safeTx(other.safe, encodeCall(selectorOf('setFallbackHandler(address)'), wordAddress(handler)), 0n),
      [other.U, other.R],
    );
    const tx = safeTx(other.safe, '0x', 1n);
    const response = await h.client.post(
      '/v1/sign-safe-tx',
      await signRequest(h, other, tx, { operationType: 'NOOP_CANCEL' }),
    );
    expect(response.json()).toMatchObject({ code: 'SAFE_CONFIG_MODIFIED', reason: 'fallbackHandler' });
  });
});

describe('logs del signer', () => {
  it('no contienen tokens, firmas de envelope ni material de claves', () => {
    const output = h.logs.output();
    expect(output).toContain('SafeTx co-firmada por S');
    expect(output).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./);
    expect(output.toLowerCase()).not.toContain(bytesToHex(w.U.key).slice(2));
    expect(output).not.toMatch(/ciphertext|privateKey|"mac"/i);
  });
});

export type { TestAccount };
