// P18.T10 [W-05]: el documento soberano del vector de contracts/ se importa, su hash se recalcula, las firmas que trae
// verifican, U agrega la misma firma que el vector y el contenido JCS y los frames del QR son los del vector. Un
// documento de otra Safe, de otra red, con un hash que no es el de su SafeTx o mal formado no se firma.
import { keccak256, toBytes, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import sovereignVector from '../../test/vectors/wire/sovereign.json';
import systemVector from '../../test/vectors/system.json';
import { pinnedChain } from '../config/chain.ts';
import type { SystemContracts } from '../config/system-contracts.ts';
import { toBase64Url } from '../crypto/bytes.ts';
import { sealKey } from '../crypto/envelope.ts';
import { defaultKdfParams } from '../crypto/kdf.ts';
import { addressOf } from '../crypto/keys.ts';
import { encodeFrames } from '../qr/frames.ts';
import {
  addUserSignature,
  parseSovereignDocument,
  reviewSovereign,
  sovereignContent,
  SovereignDocumentError,
} from './document.ts';

const vector = sovereignVector as unknown as { file: Record<string, unknown>; content: string; frames: string[] };
const system = systemVector as unknown as { keys: Record<'user', { label: string; address: Address }> };
const SAFE = vector.file.safe as Address;
const ctx = {
  safe: SAFE,
  chain: pinnedChain,
  system: { contracts: {} } as unknown as Pick<SystemContracts, 'contracts'>,
};
const text = (patch: Record<string, unknown> = {}) => JSON.stringify({ ...vector.file, ...patch });

describe('documento soberano', () => {
  it('importa el del vector: hash recalculado, firmas válidas y transfer decodificado', async () => {
    const doc = parseSovereignDocument(text());
    const review = await reviewSovereign(doc, ctx);
    expect(review.hash).toBe(vector.file.safeTxHash);
    expect(review.validSignatures.map((s) => s.role)).toEqual(['U', 'R']);
    expect(review.decoded).toMatchObject({ kind: 'TRANSFER', token: 'USDC', amount: 1_000_000n });
    expect(sovereignContent(doc)).toBe(vector.content);
    expect(await encodeFrames(sovereignContent(doc))).toEqual(vector.frames);
  });

  it('U agrega su firma (la misma del vector) y reemplaza una anterior suya', async () => {
    const withoutU = parseSovereignDocument(
      text({ signatures: (vector.file.signatures as { role: string }[]).filter((s) => s.role !== 'U') }),
    );
    const review = await reviewSovereign(withoutU, ctx);
    const key = toBytes(keccak256(toBytes(system.keys.user.label)));
    const encryptionKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    const envelope = await sealKey(
      key.slice(),
      encryptionKey,
      { platformId: 'p', chainId: 8453, walletId: 'w', role: 'U', keyAddress: addressOf(key), keyVersion: 1 },
      defaultKdfParams(toBase64Url(new Uint8Array(16))),
    );
    const signed = await addUserSignature(withoutU, review, { envelope, encryptionKey });
    const expected = (vector.file.signatures as { role: string; signature: string }[]).find((s) => s.role === 'U');
    expect(signed.signatures.find((s) => s.role === 'U')?.signature).toBe(expected?.signature);
    const twice = await addUserSignature(signed, review, { envelope, encryptionKey });
    expect(twice.signatures.filter((s) => s.role === 'U')).toHaveLength(1);
  });

  it.each<[string, () => Promise<unknown>]>([
    ['de otra Safe', () => reviewSovereign(parseSovereignDocument(text()), { ...ctx, safe: system.keys.user.address })],
    ['de otra red', () => reviewSovereign(parseSovereignDocument(text({ chainId: 1 })), ctx)],
    [
      'con un hash que no es el de su SafeTx',
      () => reviewSovereign(parseSovereignDocument(text({ safeTxHash: `0x${'11'.repeat(32)}` })), ctx),
    ],
    [
      'que no es un documento soberano',
      () => Promise.resolve().then(() => parseSovereignDocument('{"format":"otro"}')),
    ],
    ['que no es JSON', () => Promise.resolve().then(() => parseSovereignDocument('no'))],
    [
      'con una firma mal formada',
      () =>
        Promise.resolve().then(() =>
          parseSovereignDocument(text({ signatures: [{ signer: SAFE, role: 'X', signature: '0x' }] })),
        ),
    ],
    [
      'con la SafeTx mal formada',
      () =>
        Promise.resolve().then(() =>
          parseSovereignDocument(text({ safeTx: { ...(vector.file.safeTx as object), nonce: '-1' } })),
        ),
    ],
  ])('rechaza un documento %s', async (_label, run) => {
    await expect(run()).rejects.toBeInstanceOf(SovereignDocumentError);
  });
});
