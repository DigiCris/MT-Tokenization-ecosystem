// P19 [F-CON-03]: el firmante R. La R interna firma el digest EIP-712 que calcula la app con R descifrada sólo para esa
// firma (la firma recupera a R); la externa recibe el typed data completo y puede transmitir transacciones.
import { keccak256, recoverAddress, recoverTypedDataAddress, toBytes, type Address, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { plainCall, safeTxHash } from '../chain/safe-tx.ts';
import { toBufferSource } from '../crypto/encoding.ts';
import { sealRecoveryKey } from '../crypto/envelope.ts';
import type { Argon2 } from '../crypto/kdf.ts';
import { cancelRotation } from '../crypto/typed-data.ts';
import type { ExternalSession } from '../external-wallet/types.ts';
import { externalSigner, internalSigner, signSafeTx } from './recovery-signer.ts';

const R_KEY = toBytes(keccak256(toBytes('mtw-recovery-key')));
const fastArgon2: Argon2 = async ({ password, salt }) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', toBufferSource(new Uint8Array([...password, ...salt]))));
const SAFE = '0x2Ffa853A9213C92A16295C55FA6A5b27A6498688' as Address;
const TIMELOCK = '0xa38D17ef017A314cCD72b8F199C0e108EF7Ca04c' as Address;

describe('R interna', () => {
  it('firma typed data y SafeTx con R del sobre; la firma recupera a R', async () => {
    const opened = await sealRecoveryKey(
      R_KEY.slice(),
      'una password de prueba',
      { platformId: 'mtw', walletId: '7d2e3f40-1a2b-4c5d-8e9f-a0b1c2d3e4f5', keyVersion: 1 },
      fastArgon2,
    );
    const signer = internalSigner(opened);
    expect(signer).toMatchObject({ kind: 'internal', walletId: opened.envelope.walletId, sendTransaction: null });
    const definition = cancelRotation(TIMELOCK, { proposalId: `0x${'ab'.repeat(32)}`, safe: SAFE });
    const signature = await signer.signTypedData(definition);
    expect(await recoverTypedDataAddress({ ...definition, signature })).toBe(signer.address);
    const tx = plainCall(SAFE, '0x', 3n);
    const safeSignature = await signSafeTx(signer, 8453, SAFE, tx);
    expect(await recoverAddress({ hash: safeTxHash(8453, SAFE, tx), signature: safeSignature })).toBe(signer.address);
  });
});

describe('R externa', () => {
  it('delega en la wallet conectada: typed data completo y transacciones', async () => {
    const signTypedData = vi.fn<ExternalSession['signTypedData']>(() => Promise.resolve('0x01' as Hex));
    const sendTransaction = vi.fn<ExternalSession['sendTransaction']>(() => Promise.resolve('0x02' as Hex));
    const session = {
      address: '0x00000000000000000000000000000000000000e1',
      signTypedData,
      sendTransaction,
    } as unknown as ExternalSession;
    const signer = externalSigner(session);
    expect(signer).toMatchObject({ kind: 'external', walletId: null, address: session.address });
    await signSafeTx(signer, 8453, SAFE, plainCall(SAFE, '0x', 1n));
    expect(signTypedData.mock.calls[0]?.[0]).toMatchObject({ primaryType: 'SafeTx', domain: { chainId: 8453 } });
    expect(await signer.sendTransaction?.({ to: SAFE, data: '0x' })).toBe('0x02');
    expect(sendTransaction).toHaveBeenCalledWith({ to: SAFE, data: '0x' });
  });
});
