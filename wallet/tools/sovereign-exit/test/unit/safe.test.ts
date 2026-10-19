// SafeTx de la salida soberana contra los vectores de contracts/: mismo hash EIP-712, firmas de U y R iguales a las del
// vector, execTransaction con las firmas ordenadas por firmante y las acciones tipadas (transferencias, reemplazo de
// owner con el anterior de la lista, guards y NoOp).
import {
  decodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  toBytes,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { bytesToHex } from '../../src/crypto/encoding.ts';
import {
  ActionError,
  noop,
  previousOwner,
  removeGuard,
  replaceOwner,
  SENTINEL,
  TOKENS,
  transferAll,
} from '../../src/safe/actions.ts';
import { call, execTransactionData, SAFE_ABI, safeTxHash, signHash, type SafeTx } from '../../src/safe/safe-tx.ts';
import { vector, type SafeTxVector } from './vectors.ts';

const vectors = vector('safe-tx.json') as { safe: Address; operations: SafeTxVector[] };
const SAFE = getAddress(vectors.safe);
const U_KEY = toBytes(keccak256(toBytes('mtw-user-key')));
const R_KEY = toBytes(keccak256(toBytes('mtw-recovery-key')));
const U = privateKeyToAddress(bytesToHex(U_KEY));
const R = privateKeyToAddress(bytesToHex(R_KEY));

function fromVector(op: SafeTxVector): SafeTx {
  return { ...call(op.to as Address, op.data as Hex, BigInt(op.nonce), BigInt(op.value)), operation: 0 };
}

describe('SafeTx (vectores de contracts/)', () => {
  it.each(vectors.operations.map((op) => [op.opType, op] as const))('%s: hash y firmas de U y R', async (_, op) => {
    const tx = fromVector(op);
    const hash = safeTxHash(8453, SAFE, tx);
    expect(hash).toBe(op.safeTxHash);
    expect((await signHash(hash, U_KEY, U)).signature).toBe(op.signatureUser);
    expect((await signHash(hash, R_KEY, R)).signature).toBe(op.signatureRecovery);
  });

  it('execTransaction lleva las firmas ordenadas por firmante', async () => {
    const op = vectors.operations[0];
    if (!op) throw new Error('sin vectores');
    const tx = fromVector(op);
    const hash = safeTxHash(8453, SAFE, tx);
    const sigs = [await signHash(hash, U_KEY, U), await signHash(hash, R_KEY, R)];
    const data = execTransactionData(tx, sigs);
    const reversed = execTransactionData(tx, [...sigs].reverse());
    expect(data).toBe(reversed);
    const decoded = decodeFunctionData({ abi: SAFE_ABI, data });
    const [first, second] = BigInt(U) < BigInt(R) ? [sigs[0], sigs[1]] : [sigs[1], sigs[0]];
    expect(decoded.args[9]).toBe(`${first?.signature ?? ''}${second?.signature.slice(2) ?? ''}`);
  });
});

describe('acciones tipadas', () => {
  const owners = [U, R, getAddress('0x00000000000000000000000000000000000000a3')];
  const destination = getAddress('0xde032ab8bcf44fb9dd7fb9c0d8e9ead8d2325e26');

  it('transferir todo el saldo: token o ETH; sin saldo, al cero o a la misma Safe no se arma', () => {
    const usdc = transferAll(SAFE, 'USDC', destination, 1_250_000n, 4n);
    expect(usdc.tx.to).toBe(TOKENS.USDC.address);
    expect(decodeFunctionData({ abi: erc20Abi, data: usdc.tx.data }).args).toEqual([destination, 1_250_000n]);
    expect(usdc.description).toBe(`Enviar 1,25 USDC a ${destination}`);
    const eth = transferAll(SAFE, 'ETH', destination, 10n ** 18n, 4n);
    expect(eth.tx).toMatchObject({ to: destination, value: 10n ** 18n, data: '0x' });
    expect(eth.description).toBe(`Enviar 1 ETH a ${destination}`);
    expect(() => transferAll(SAFE, 'USDT', destination, 0n, 4n)).toThrow(ActionError);
    expect(() => transferAll(SAFE, 'USDC', zeroAddress, 1n, 4n)).toThrow(ActionError);
    expect(() => transferAll(SAFE, 'USDC', SAFE, 1n, 4n)).toThrow(ActionError);
  });

  it('reemplazar un owner usa el anterior de la lista enlazada', () => {
    expect(previousOwner(owners, U)).toBe(SENTINEL);
    expect(previousOwner(owners, owners[2] ?? zeroAddress)).toBe(R);
    const next = getAddress('0x00000000000000000000000000000000000000a4');
    const swap = replaceOwner(SAFE, owners, owners[2] ?? zeroAddress, next, 7n);
    expect(decodeFunctionData({ abi: SAFE_ABI, data: swap.tx.data }).args).toEqual([R, owners[2], next]);
    expect(() => replaceOwner(SAFE, owners, U, R, 7n)).toThrow('dirección nueva');
    expect(() => previousOwner(owners, destination)).toThrow('no es owner');
  });

  it('retirar guards y NoOp', () => {
    const guard = removeGuard(SAFE, 'GUARD', 2n);
    expect(decodeFunctionData({ abi: SAFE_ABI, data: guard.tx.data })).toMatchObject({
      functionName: 'setGuard',
      args: [zeroAddress],
    });
    expect(removeGuard(SAFE, 'MODULE_GUARD', 2n).description).toBe('Retirar el guard de módulos de la Safe');
    expect(noop(SAFE, 9n)).toMatchObject({ tx: { to: SAFE, data: '0x', nonce: 9n } });
  });
});
