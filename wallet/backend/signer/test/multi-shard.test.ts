// P11.T08 [B-SIG-09]: N shards (dos en esta prueba, en el mismo host como en la producción inicial), cada uno con su
// DB, sus keystores, su credencial y su identidad: cada shard co-firma sólo para las wallets cuya S tiene; un pedido
// al shard equivocado no obtiene firma; y la rotación de S hacia una clave de OTRO shard se acepta porque la nueva S
// trae la SignerKeyAttestation del entorno.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeCall, SELECTORS, wordAddress, wordUint } from '../src/chain/abi.ts';
import type { Address } from '../src/crypto/keccak.ts';
import { safeTx, testAccount } from './helpers/chain.ts';
import { createWallet, signRequest, transferData, usdc, whitelistSovereign, type Wallet } from './helpers/flow.ts';
import { startHarness, type SignerHarness } from './helpers/signer.ts';

let a: SignerHarness;
let b: SignerHarness;
let wa: Wallet;
let wb: Wallet;
const DEST = testAccount().address;

beforeAll(async () => {
  a = await startHarness({ shardId: 'dev-1' });
  b = await startHarness({ shardId: 'dev-2', share: { anvil: a.anvil, chain: a.chain, keys: a.keys, pki: a.pki } });
  wa = await createWallet(a);
  wb = await createWallet(b);
  await whitelistSovereign(a, wa, DEST, false);
  await whitelistSovereign(b, wb, DEST);
});
afterAll(async () => {
  // Si el beforeAll falló a mitad de camino, alguno puede no existir.
  for (const h of [b, a] as (SignerHarness | undefined)[]) await h?.close();
});

async function sign(h: SignerHarness, w: Wallet) {
  const tx = safeTx(usdc(h), transferData(DEST, 1_000_000n), await h.chain.safeNonce(w.safe));
  const response = await h.client.post('/v1/sign-safe-tx', await signRequest(h, w, tx, { operationType: 'SEND' }));
  return { status: response.status, body: response.json() as Record<string, unknown> };
}

describe('dos shards independientes', () => {
  it('estado separado: DB, keystores y credencial propios', async () => {
    expect(a.ws.keystoreDir).not.toBe(b.ws.keystoreDir);
    expect(a.ws.credentialFile).not.toBe(b.ws.credentialFile);
    const fpA = (await a.runtime.provider.registry.shard())?.credentialFingerprint;
    const fpB = (await b.runtime.provider.registry.shard())?.credentialFingerprint;
    expect(fpA).not.toBe(fpB);
    expect(await a.runtime.provider.registry.byAddress(wb.S)).toBeUndefined();
    expect(await b.runtime.provider.registry.byAddress(wa.S)).toBeUndefined();
  });

  it('cada shard co-firma para sus wallets y el pedido al shard equivocado no obtiene firma', async () => {
    const okA = await sign(a, wa);
    expect(okA.status, JSON.stringify(okA.body)).toBe(200);
    expect((await a.chain.sendRaw(okA.body.signedTx as `0x${string}`)).status).toBe('success');
    const okB = await sign(b, wb);
    expect(okB.status, JSON.stringify(okB.body)).toBe(200);
    expect((await b.chain.sendRaw(okB.body.signedTx as `0x${string}`)).status).toBe('success');
    const wrong = await sign(b, wa);
    expect(wrong.body).toMatchObject({ code: 'KEY_NOT_FOUND' });
    expect(wrong.body.signedTx).toBeUndefined();
  });

  it('rotación de S hacia una clave del otro shard: válida por la atestación del entorno', async () => {
    const target = (await b.client.post('/v1/keys', { walletId: wa.walletId, reason: 'ROTATION' })).json() as {
      address: Address;
      attestation: string;
      shardId: string;
    };
    expect(target.shardId).toBe('dev-2');
    const n = await a.chain.safeNonce(wa.safe);
    const propose = safeTx(
      a.contracts.rotationTimelock!,
      encodeCall(SELECTORS.propose, wordUint(2n), wordAddress(wa.S), wordAddress(target.address)),
      n,
    );
    const response = await a.client.post(
      '/v1/sign-safe-tx',
      await signRequest(a, wa, propose, { operationType: 'ROTATION_PROPOSE', newKeyAttestation: target.attestation }),
    );
    expect(response.status, response.text).toBe(200);
    expect((await a.chain.sendRaw((response.json() as { signedTx: `0x${string}` }).signedTx)).status).toBe('success');
  });
});
