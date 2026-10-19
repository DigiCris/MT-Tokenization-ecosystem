// P19.T06 [W-05]: el documento soberano y su QR multi-cuadro contra el vector de contracts/ (mismo JCS, mismos cuadros,
// mismo hash), firmas que recuperan a U y R, combinación ordenada por firmante para execTransaction y las acciones
// tipadas que arma la app.
import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  toBytes,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { describe, expect, it } from 'vitest';
import sovereignVector from '../../test/vectors/wire/sovereign.json' with { type: 'json' };
import { iSafeAbi } from '../chain/abis/ISafe.ts';
import { securityGuardAbi } from '../chain/abis/SecurityGuard.ts';
import { safeTxHash } from '../chain/safe-tx.ts';
import { pinnedChain } from '../config/chain.ts';
import { addressOfKey, signDigest } from '../crypto/secp256k1.ts';
import { decodeFrames, encodeFrames, FrameCollector, FrameError } from '../qr/frames.ts';
import { noop, replaceExecutor, setGuard, SovereignActionError, transferAll, updateRoles } from './actions.ts';
import {
  execTransactionData,
  mergeSignatures,
  newDocument,
  parseSovereignDocument,
  SovereignDocumentError,
  sovereignContent,
  verifySignatures,
  withSignature,
} from './document.ts';

const U_KEY = toBytes(keccak256(toBytes('mtw-user-key')));
const R_KEY = toBytes(keccak256(toBytes('mtw-recovery-key')));

describe('vector [W-05]', () => {
  it('el documento del vector: mismo JCS, mismo hash y firmas de U y R que recuperan', async () => {
    const doc = parseSovereignDocument(sovereignVector.file);
    expect(sovereignContent(doc)).toBe(sovereignVector.content);
    await expect(verifySignatures(doc)).resolves.toBeUndefined();
    expect(doc.signatures.map((s) => s.signer)).toEqual([addressOfKey(U_KEY), addressOfKey(R_KEY)]);
  });

  it('QR multi-cuadro: los mismos cuadros del vector y se leen en cualquier orden, repetidos', async () => {
    expect(await encodeFrames(sovereignVector.content)).toEqual(sovereignVector.frames);
    expect(await decodeFrames([...sovereignVector.frames].reverse())).toBe(sovereignVector.content);
    const collector = new FrameCollector();
    expect(collector.add('otro QR')).toBeNull();
    for (const frame of [sovereignVector.frames[1], sovereignVector.frames[1], sovereignVector.frames[0]]) {
      collector.add(frame ?? '');
    }
    expect(await collector.content()).toBeNull();
    collector.add(sovereignVector.frames[2] ?? '');
    expect(await collector.content()).toBe(sovereignVector.content);
  });

  it('un cuadro alterado no reconstruye el hash; faltantes y formatos ajenos fallan', async () => {
    const tampered = [...sovereignVector.frames];
    tampered[0] = `${(tampered[0] ?? '').slice(0, -2)}AA`;
    await expect(decodeFrames(tampered)).rejects.toBeInstanceOf(FrameError);
    await expect(decodeFrames(sovereignVector.frames.slice(0, 2))).rejects.toThrow('faltan cuadros');
    await expect(decodeFrames(['MTWQR1:1/1:abc:xx'])).rejects.toThrow('formato MTWQR1');
  });

  it('un documento con otro hash, otra cadena o una firma ajena se rechaza', async () => {
    expect(() => parseSovereignDocument({ ...sovereignVector.file, safeTxHash: `0x${'00'.repeat(32)}` })).toThrow(
      'safeTxHash',
    );
    expect(() => parseSovereignDocument({ ...sovereignVector.file, chainId: 1 })).toThrow(SovereignDocumentError);
    const wrongSigner = {
      ...sovereignVector.file,
      signatures: [{ ...sovereignVector.file.signatures[0], signer: addressOfKey(R_KEY) }],
    };
    await expect(verifySignatures(parseSovereignDocument(wrongSigner))).rejects.toThrow('no es de');
  });
});

describe('armar, firmar y combinar', () => {
  const safe: Address = '0x2Ffa853A9213C92A16295C55FA6A5b27A6498688';
  const usdc = pinnedChain.tokens.USDC;

  it('R firma, se importa la firma de U del documento devuelto y execTransaction lleva las dos ordenadas', async () => {
    const destination: Address = '0xdE032Ab8bcF44FB9dd7fb9C0d8e9ead8D2325E26';
    const { tx, action } = transferAll(usdc, destination, 1_000_000n, 1n);
    const doc = newDocument(safe, tx, action, new Date('2026-10-17T12:00:00Z'));
    expect(doc.safeTxHash).toBe(safeTxHash(8453, safe, tx));
    expect(doc.safeTxHash).toBe(sovereignVector.file.safeTxHash);
    const signedByR = await withSignature(doc, {
      signer: addressOfKey(R_KEY),
      role: 'R',
      signature: signDigest(doc.safeTxHash, R_KEY),
    });
    expect(() => execTransactionData(signedByR)).toThrow('faltan firmas');
    const fromWallet = await withSignature(doc, {
      signer: addressOfKey(U_KEY),
      role: 'U',
      signature: signDigest(doc.safeTxHash, U_KEY),
    });
    const both = await mergeSignatures(signedByR, fromWallet);
    const { args } = decodeFunctionData({ abi: iSafeAbi, data: execTransactionData(both) });
    const signatures = args[9] as Hex;
    const ordered = [both.signatures[0], both.signatures[1]].sort((a, b) =>
      BigInt(a?.signer ?? 0) < BigInt(b?.signer ?? 0) ? -1 : 1,
    );
    expect(signatures).toBe(`0x${ordered.map((s) => (s?.signature ?? '').slice(2)).join('')}`);
    const other = newDocument(safe, noop(safe, 7n).tx, noop(safe, 7n).action, new Date());
    await expect(mergeSignatures(signedByR, other)).rejects.toThrow('otra operación');
    await expect(
      withSignature(doc, { signer: addressOfKey(U_KEY), role: 'U', signature: signDigest(doc.safeTxHash, R_KEY) }),
    ).rejects.toThrow('no es de');
  });

  it('acciones tipadas: transfer de todo el saldo, reemplazo de S en dos SafeTx, guards, roles y NoOp', () => {
    const roles = {
      userKey: addressOfKey(U_KEY),
      recoveryKey: addressOfKey(R_KEY),
      executor: '0xc80D387fCc59cB57AEf0eC2b137C77D26474288E' as Address,
    };
    const guard: Address = '0x1111111111111111111111111111111111111111';
    const transfer = transferAll(usdc, roles.userKey, 25n, 4n);
    expect(transfer.tx).toMatchObject({ to: usdc.address, nonce: 4n, operation: 0, value: 0n });
    expect(transfer.tx.data).toBe(
      encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [roles.userKey, 25n] }),
    );
    expect(() => transferAll(usdc, roles.userKey, 0n, 4n)).toThrow(SovereignActionError);

    const next: Address = '0x30680C97b8eFE2404915432e7e16115679417AbF';
    const owners = [roles.userKey, roles.executor, roles.recoveryKey];
    const [swap, update] = replaceExecutor(safe, guard, roles, owners, next, 10n);
    expect(swap.tx.nonce).toBe(10n);
    expect(update.tx.nonce).toBe(11n);
    expect(decodeFunctionData({ abi: iSafeAbi, data: swap.tx.data }).args).toEqual([
      roles.userKey,
      roles.executor,
      next,
    ]);
    expect(update.tx.to).toBe(guard);
    expect(decodeFunctionData({ abi: securityGuardAbi, data: update.tx.data }).args).toEqual([
      roles.userKey,
      roles.recoveryKey,
      next,
    ]);
    expect(() => replaceExecutor(safe, guard, roles, owners, roles.userKey, 10n)).toThrow('dirección nueva');

    expect(
      decodeFunctionData({ abi: iSafeAbi, data: setGuard(safe, 'GUARD', zeroAddress, 1n).tx.data }).functionName,
    ).toBe('setGuard');
    expect(setGuard(safe, 'MODULE_GUARD', zeroAddress, 1n).action.type).toBe('SET_MODULE_GUARD');
    expect(updateRoles(guard, roles, 2n).tx.to).toBe(guard);
    expect(() => updateRoles(guard, { ...roles, executor: roles.userKey }, 2n)).toThrow('distintas');
    expect(noop(safe, 3n).tx).toMatchObject({ to: safe, data: '0x', nonce: 3n });
  });
});
