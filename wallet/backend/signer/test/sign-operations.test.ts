// P11.T03 [B-SIG-02] sobre el fork real, operación por operación:
// - emparejamiento approve/swap: el SWAP_APPROVE N sólo viaja con su SWAP N+1 firmado por U (mismo executor y monto)
//   y el SWAP sólo tras el approve ejecutado; el swap se ejecuta contra el pool canónico de Uniswap;
// - operaciones de R con scope RECOVERY (NoOp, revocación);
// - rotación de S sólo hacia claves creadas por un signer (SignerKeyAttestation), ejecutada tras las 48 h y
//   co-firmada por la S saliente; después firma la S nueva;
// - rotación de U por R sólo con KeyAcceptance de la U nueva;
// - Guard: propuesta hacia algo no registrado y setGuard sin propuesta madura se rechazan;
// - migración: transferencia del saldo completo a una Safe autorizada en el PolicyRegistry (24 h de timelock).
import { decodeEventLog, encodeFunctionData } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeCall, SELECTORS, wordAddress, wordUint } from '../src/chain/abi.ts';
import { keyAcceptanceDigest } from '../src/chain/eip712.ts';
import { policyRegistryAbi, securityGuardAbi } from '../src/chain/abis/index.ts';
import type { SafeTx } from '../src/chain/safe-tx.ts';
import { bytesToHex, type Hex } from '../src/crypto/bytes.ts';
import type { Address } from '../src/crypto/keccak.ts';
import { signDigest } from '../src/crypto/secp256k1.ts';
import { inject } from 'vitest';
import { safeTx, testAccount, type TestAccount } from './helpers/chain.ts';
import {
  createWallet,
  pairedSafeTx,
  signRequest,
  signedRows,
  transferData,
  usdc,
  usdt,
  whitelistSovereign,
  type RequestOptions,
  type Wallet,
} from './helpers/flow.ts';
import { startHarness, type SignerHarness } from './helpers/signer.ts';

let h: SignerHarness;
let w: Wallet;
const DEST = testAccount().address;
const SENTINEL = '0x0000000000000000000000000000000000000001' as Address;
const USD = (n: number) => BigInt(n) * 1_000_000n;

beforeAll(async () => {
  h = await startHarness();
  w = await createWallet(h);
  await whitelistSovereign(h, w, DEST);
});
afterAll(async () => {
  await (h as SignerHarness | undefined)?.close();
});

const nonce = () => h.chain.safeNonce(w.safe);

async function sign(tx: SafeTx, o: RequestOptions) {
  const response = await h.client.post('/v1/sign-safe-tx', await signRequest(h, w, tx, o));
  return { status: response.status, body: response.json() as Record<string, unknown> };
}

async function expectRejected(tx: SafeTx, o: RequestOptions, code: string, reason?: string) {
  const before = await signedRows(h);
  const { body } = await sign(tx, o);
  expect(body, JSON.stringify(body)).toMatchObject({ code, ...(reason === undefined ? {} : { reason }) });
  expect(body.sSignature).toBeUndefined();
  expect(await signedRows(h)).toBe(before);
}

async function signAndMine(tx: SafeTx, o: RequestOptions) {
  const { status, body } = await sign(tx, o);
  expect(status, JSON.stringify(body)).toBe(200);
  const sent = await h.chain.sendRaw(body.signedTx as `0x${string}`);
  expect(sent.status).toBe('success');
  return body;
}

async function roles(safe: Address) {
  return await h.chain.public.readContract({
    address: h.contracts.securityGuard!,
    abi: securityGuardAbi,
    functionName: 'rolesOf',
    args: [safe],
  });
}

function keyAcceptance(newKey: TestAccount, role: number, walletId = w.walletId): Record<string, unknown> {
  const nonceHex = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const digest = keyAcceptanceDigest(8453, h.contracts.walletFactory!, {
    walletId,
    role,
    newKey: newKey.address,
    nonce: nonceHex,
  });
  return { walletId, role, newKey: newKey.address, nonce: nonceHex, signature: signDigest(digest, newKey.key).bytes };
}

describe('approve + swap emparejados contra el pool real [B-SIG-02]', () => {
  it('el approve sin su SWAP, con otro monto o sin firma válida de U se rechaza', async () => {
    const n = await nonce();
    const chainNow = await h.chain.now();
    const approve = safeTx(
      usdc(h),
      encodeCall(SELECTORS.approve, wordAddress(h.contracts.swapExecutor!), wordUint(USD(500))),
      n,
    );
    await expectRejected(approve, { operationType: 'SWAP_APPROVE' }, 'POLICY_REJECTED', 'SWAP_PAIRING_INVALID');
    const swapOther = safeTx(
      h.contracts.swapExecutor!,
      encodeCall(
        SELECTORS.swap,
        wordAddress(usdc(h)),
        wordUint(USD(499)),
        wordUint(USD(497)),
        wordUint(BigInt(chainNow + 300)),
      ),
      n + 1n,
    );
    const request = await signRequest(h, w, approve, { operationType: 'SWAP_APPROVE' });
    const response = await h.client.post('/v1/sign-safe-tx', {
      ...request,
      pairedSafeTx: pairedSafeTx(h, w, swapOther, request),
    });
    expect(response.json()).toMatchObject({ code: 'POLICY_REJECTED', reason: 'SWAP_PAIRING_INVALID' });
    const swap = safeTx(
      h.contracts.swapExecutor!,
      encodeCall(
        SELECTORS.swap,
        wordAddress(usdc(h)),
        wordUint(USD(500)),
        wordUint(USD(498)),
        wordUint(BigInt(chainNow + 300)),
      ),
      n + 1n,
    );
    const forged = {
      ...pairedSafeTx(h, w, swap, request),
      ownerSignature: pairedSafeTx(h, { ...w, U: testAccount() }, swap, request).ownerSignature,
    };
    const response2 = await h.client.post('/v1/sign-safe-tx', { ...request, pairedSafeTx: forged });
    expect(response2.json()).toMatchObject({ code: 'POLICY_REJECTED', reason: 'SWAP_PAIRING_INVALID' });
  });

  it('el SWAP sin approve co-firmado se rechaza aunque la allowance exista', async () => {
    const n = await nonce();
    const chainNow = await h.chain.now();
    const swap = safeTx(
      h.contracts.swapExecutor!,
      encodeCall(
        SELECTORS.swap,
        wordAddress(usdc(h)),
        wordUint(USD(500)),
        wordUint(USD(498)),
        wordUint(BigInt(chainNow + 300)),
      ),
      n,
    );
    await expectRejected(swap, { operationType: 'SWAP' }, 'POLICY_REJECTED', 'SWAP_PAIRING_INVALID');
  });

  it('approve N con su SWAP N+1 → ambos co-firmados en orden; el swap llena contra Uniswap y la allowance vuelve a 0', async () => {
    const n = await nonce();
    const chainNow = await h.chain.now();
    const amount = USD(500);
    const approve = safeTx(
      usdc(h),
      encodeCall(SELECTORS.approve, wordAddress(h.contracts.swapExecutor!), wordUint(amount)),
      n,
    );
    const minOut = (amount * 9_970n) / 10_000n;
    const swap = safeTx(
      h.contracts.swapExecutor!,
      encodeCall(
        SELECTORS.swap,
        wordAddress(usdc(h)),
        wordUint(amount),
        wordUint(minOut),
        wordUint(BigInt(chainNow + 300)),
      ),
      n + 1n,
    );
    const request = await signRequest(h, w, approve, { operationType: 'SWAP_APPROVE' });
    const paired = pairedSafeTx(h, w, swap, request);
    const approved = await h.client.post('/v1/sign-safe-tx', { ...request, pairedSafeTx: paired });
    expect(approved.status, approved.text).toBe(200);
    expect((await h.chain.sendRaw((approved.json() as { signedTx: `0x${string}` }).signedTx)).status).toBe('success');

    const usdtBefore = await h.chain.tokenBalance(usdt(h), w.safe);
    await signAndMine(swap, { operationType: 'SWAP' });
    const received = (await h.chain.tokenBalance(usdt(h), w.safe)) - usdtBefore;
    expect(received >= minOut).toBe(true);
    const allowance = await h.chain.public.readContract({
      address: usdc(h),
      abi: [
        {
          type: 'function',
          name: 'allowance',
          stateMutability: 'view',
          inputs: [
            { name: 'o', type: 'address' },
            { name: 's', type: 'address' },
          ],
          outputs: [{ name: '', type: 'uint256' }],
        },
      ] as const,
      functionName: 'allowance',
      args: [w.safe, h.contracts.swapExecutor!],
    });
    expect(allowance).toBe(0n);
  });
});

describe('operaciones de R (scope RECOVERY)', () => {
  it('NoOp y revocación de approve firmadas por R se co-firman; un SEND de R no', async () => {
    await signAndMine(safeTx(w.safe, '0x', await nonce()), { operationType: 'NOOP_CANCEL', ownerRole: 'R' });
    await signAndMine(
      safeTx(
        usdt(h),
        encodeCall(SELECTORS.approve, wordAddress(h.contracts.swapExecutor!), wordUint(0n)),
        await nonce(),
      ),
      { operationType: 'APPROVE_REVOKE', ownerRole: 'R' },
    );
    await expectRejected(
      safeTx(usdc(h), transferData(DEST, USD(1)), await nonce()),
      { operationType: 'SEND', ownerRole: 'R' },
      'POLICY_REJECTED',
      'OPERATION_NOT_ALLOWED',
    );
  });
});

let newS: { address: Address; attestation: string };
const newU = testAccount();

describe('rotaciones [B-SIG-02], [C-GRD-11/12]', () => {
  it('S sólo hacia una clave creada por un signer para esta wallet', async () => {
    newS = (await h.client.post('/v1/keys', { walletId: w.walletId, reason: 'ROTATION' })).json() as typeof newS;
    const foreign = testAccount().address;
    const propose = (target: Address) =>
      safeTx(
        h.contracts.rotationTimelock!,
        encodeCall(SELECTORS.propose, wordUint(2n), wordAddress(w.S), wordAddress(target)),
        0n,
      );
    const n = await nonce();
    const toForeign = { ...propose(foreign), nonce: n };
    await expectRejected(
      toForeign,
      { operationType: 'ROTATION_PROPOSE' },
      'POLICY_REJECTED',
      'ROTATION_TARGET_NOT_SIGNER_KEY',
    );
    await expectRejected(
      toForeign,
      { operationType: 'ROTATION_PROPOSE', newKeyAttestation: newS.attestation },
      'POLICY_REJECTED',
      'ROTATION_TARGET_NOT_SIGNER_KEY',
    );
    const otherWallet = (
      await h.client.post('/v1/keys', { walletId: crypto.randomUUID(), reason: 'ONBOARDING' })
    ).json() as typeof newS;
    const toOther = { ...propose(otherWallet.address), nonce: n };
    await expectRejected(
      toOther,
      { operationType: 'ROTATION_PROPOSE', newKeyAttestation: otherWallet.attestation },
      'POLICY_REJECTED',
      'ROTATION_TARGET_NOT_SIGNER_KEY',
    );
    await signAndMine(
      { ...propose(newS.address), nonce: n },
      { operationType: 'ROTATION_PROPOSE', newKeyAttestation: newS.attestation },
    );
  });

  it('U por R (recovery) sólo con KeyAcceptance válido de la U nueva', async () => {
    const n = await nonce();
    const tx = safeTx(
      h.contracts.rotationTimelock!,
      encodeCall(SELECTORS.propose, wordUint(0n), wordAddress(w.U.address), wordAddress(newU.address)),
      n,
    );
    await expectRejected(
      tx,
      { operationType: 'ROTATION_PROPOSE', ownerRole: 'R' },
      'POLICY_REJECTED',
      'KEY_ACCEPTANCE_REQUIRED',
    );
    await expectRejected(
      tx,
      { operationType: 'ROTATION_PROPOSE', ownerRole: 'R', keyAcceptance: keyAcceptance(newU, 2) },
      'POLICY_REJECTED',
      'KEY_ACCEPTANCE_REQUIRED',
    );
    const signedByOther = { ...keyAcceptance(newU, 1), signature: keyAcceptance(testAccount(), 1).signature };
    await expectRejected(
      tx,
      { operationType: 'ROTATION_PROPOSE', ownerRole: 'R', keyAcceptance: signedByOther },
      'POLICY_REJECTED',
      'KEY_ACCEPTANCE_REQUIRED',
    );
    await expectRejected(
      tx,
      { operationType: 'ROTATION_PROPOSE', ownerRole: 'R', keyAcceptance: keyAcceptance(newU, 1, crypto.randomUUID()) },
      'POLICY_REJECTED',
      'KEY_ACCEPTANCE_REQUIRED',
    );
    await signAndMine(tx, { operationType: 'ROTATION_PROPOSE', ownerRole: 'R', keyAcceptance: keyAcceptance(newU, 1) });
  });

  it('antes de las 48 h la ejecución se rechaza', async () => {
    const tx = safeTx(
      w.safe,
      encodeCall(SELECTORS.swapOwner, wordAddress(w.R.address), wordAddress(w.S), wordAddress(newS.address)),
      await nonce(),
    );
    await expectRejected(
      tx,
      { operationType: 'ROTATION_EXECUTE', newKeyAttestation: newS.attestation },
      'POLICY_REJECTED',
      'ROTATION_NOT_EXECUTABLE',
    );
  });

  it("tras 48 h: S → S' (co-firma la S saliente) y desde ahí firma S'", async () => {
    await h.chain.increaseTime(48 * 3600 + 60);
    const n = await nonce();
    const wrongPrev = safeTx(
      w.safe,
      encodeCall(SELECTORS.swapOwner, wordAddress(SENTINEL), wordAddress(w.S), wordAddress(newS.address)),
      n,
    );
    await expectRejected(
      wrongPrev,
      { operationType: 'ROTATION_EXECUTE', newKeyAttestation: newS.attestation },
      'POLICY_REJECTED',
      'ROTATION_INVALID',
    );
    const tx = safeTx(
      w.safe,
      encodeCall(SELECTORS.swapOwner, wordAddress(w.R.address), wordAddress(w.S), wordAddress(newS.address)),
      n,
    );
    const body = await signAndMine(tx, { operationType: 'ROTATION_EXECUTE', newKeyAttestation: newS.attestation });
    expect(body.executor).toBe(w.S);
    expect((await roles(w.safe)).executor).toBe(newS.address);
    await h.chain.setBalance(newS.address, 10n ** 18n);
    const old = w.S;
    w = { ...w, S: newS.address };
    const after = await signAndMine(safeTx(usdc(h), transferData(DEST, USD(3)), await nonce()), {
      operationType: 'SEND',
    });
    expect(after.executor).toBe(newS.address);
    expect(after.executor).not.toBe(old);

    // Retiro de la S saliente [B-SIG-08]: no se puede retirar la vigente ni con una Safe que no es de la wallet.
    const retireCurrent = await h.client.post('/v1/keys/retire', {
      walletId: w.walletId,
      address: newS.address,
      safe: w.safe,
    });
    expect(retireCurrent.json()).toMatchObject({
      code: 'BAD_REQUEST',
      reason: 'la clave sigue siendo la S de la Safe',
    });
    const otherSafe = await h.client.post('/v1/keys/retire', { walletId: w.walletId, address: old, safe: DEST });
    expect(otherSafe.json()).toMatchObject({ code: 'BAD_REQUEST' });
    const retired = await h.client.post('/v1/keys/retire', { walletId: w.walletId, address: old, safe: w.safe });
    expect(retired.status, retired.text).toBe(200);
    expect(retired.json()).toMatchObject({ status: 'RETIRED' });
    const record = (await h.runtime.provider.registry.forWallet(w.walletId)).find((k) => k.address === old);
    expect(record?.status).toBe('RETIRED');
    expect(record!.destroyAfter!.getTime() - Date.now()).toBeGreaterThan(29 * 24 * 3600_000);
  });

  it("U → U' ejecutada por R con KeyAcceptance; después firma U'", async () => {
    const n = await nonce();
    const tx = safeTx(
      w.safe,
      encodeCall(SELECTORS.swapOwner, wordAddress(SENTINEL), wordAddress(w.U.address), wordAddress(newU.address)),
      n,
    );
    await expectRejected(
      tx,
      { operationType: 'ROTATION_EXECUTE', ownerRole: 'R' },
      'POLICY_REJECTED',
      'KEY_ACCEPTANCE_REQUIRED',
    );
    await signAndMine(tx, { operationType: 'ROTATION_EXECUTE', ownerRole: 'R', keyAcceptance: keyAcceptance(newU, 1) });
    expect((await roles(w.safe)).userKey).toBe(newU.address);
    const oldU = w.U;
    w = { ...w, U: newU };
    await signAndMine(safeTx(usdc(h), transferData(DEST, USD(2)), await nonce()), { operationType: 'SEND' });
    await expectRejected(
      safeTx(usdc(h), transferData(DEST, USD(2)), await nonce()),
      { operationType: 'SEND', owner: oldU },
      'OWNER_NOT_ROLE',
      'U',
    );
  });
});

describe('Guard [C-GRD-17]', () => {
  it('propuesta de GUARD hacia un sucesor no registrado y setGuard sin propuesta madura se rechazan', async () => {
    const candidate = testAccount().address;
    const n = await nonce();
    const propose = safeTx(
      h.contracts.rotationTimelock!,
      encodeCall(SELECTORS.propose, wordUint(3n), wordAddress(h.contracts.securityGuard!), wordAddress(candidate)),
      n,
    );
    await expectRejected(propose, { operationType: 'ROTATION_PROPOSE' }, 'POLICY_REJECTED', 'GUARD_UPGRADE_INVALID');
    const upgrade = safeTx(w.safe, encodeCall(SELECTORS.setGuard, wordAddress(candidate)), n);
    await expectRejected(upgrade, { operationType: 'GUARD_UPGRADE' }, 'POLICY_REJECTED', 'GUARD_UPGRADE_INVALID');
  });
});

describe('migración autorizada [B-POL-02], [C-GRD-06]', () => {
  it('saldo completo a la Safe nueva autorizada en el PolicyRegistry; parcial se rechaza', async () => {
    const walletId2 = crypto.randomUUID();
    const s2 = (await h.client.post('/v1/keys', { walletId: walletId2, reason: 'ONBOARDING' })).json() as {
      address: Address;
    };
    const safe2 = await h.chain.createSafe(h.contracts.walletFactory!, {
      userKey: w.U.address,
      recoveryKey: w.R.address,
      executor: s2.address,
    });
    const registry = h.contracts.policyRegistry!;
    const admin = inject('chain').system.policy.admin as Address;
    const balance = await h.chain.tokenBalance(usdt(h), w.safe);
    const n = await nonce();
    const transfer = (amount: bigint) => safeTx(usdt(h), transferData(safe2, amount), n);
    // Sin autorización on-chain es un SEND a un destino no whitelisteado.
    await expectRejected(
      transfer(balance),
      { operationType: 'MIGRATION_TRANSFER' },
      'POLICY_REJECTED',
      'OPERATION_TYPE_MISMATCH',
    );

    await h.chain.impersonate(admin, {
      to: registry,
      data: encodeFunctionData({
        abi: policyRegistryAbi,
        functionName: 'proposeMigrationAuthorization',
        args: [w.safe, safe2],
      }),
    });
    const logs = await h.chain.public.getLogs({ address: registry, fromBlock: await h.chain.public.getBlockNumber() });
    const proposed = logs
      .map((l) => {
        try {
          return decodeEventLog({ abi: policyRegistryAbi, data: l.data, topics: l.topics });
        } catch {
          return undefined;
        }
      })
      .find((e) => e?.eventName === 'ChangeProposed');
    const id = (proposed?.args as { id: Hex } | undefined)?.id;
    expect(id).toBeDefined();
    await h.chain.increaseTime(24 * 3600 + 60);
    await h.chain.send(h.chain.relayer, {
      to: registry,
      data: encodeFunctionData({ abi: policyRegistryAbi, functionName: 'activateChange', args: [id!] }),
    });

    await expectRejected(
      transfer(balance - 1n),
      { operationType: 'MIGRATION_TRANSFER' },
      'POLICY_REJECTED',
      'MIGRATION_PARTIAL',
    );
    await expectRejected(transfer(balance), { operationType: 'SEND' }, 'POLICY_REJECTED', 'OPERATION_TYPE_MISMATCH');
    await signAndMine(transfer(balance), { operationType: 'MIGRATION_TRANSFER' });
    expect(await h.chain.tokenBalance(usdt(h), safe2)).toBe(balance);
    expect(await h.chain.tokenBalance(usdt(h), w.safe)).toBe(0n);
  });
});
