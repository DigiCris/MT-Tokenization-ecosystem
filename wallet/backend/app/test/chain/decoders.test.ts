// Decoder estricto y firmas estrictas: todo lo que no es una llamada tipificada del sistema se rechaza.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { rotationTimelockAbi, swapExecutorV3Abi } from '../../src/chain/abis/index.ts';
import type { SystemAddresses } from '../../src/chain/constants.ts';
import { decodeSafeCall, UndecodableCallError, type UndecodableReason } from '../../src/chain/decoders/index.ts';
import { isPlainCall, type SafeTx } from '../../src/chain/safe-tx.ts';
import {
  InvalidSignatureError,
  parseStrictSignature,
  recoverStrictSigner,
  SECP256K1_N,
  splitSignatures,
  type SignatureProblem,
} from '../../src/chain/signatures.ts';

const system = JSON.parse(readFileSync(resolve(import.meta.dirname, '../vectors/system.json'), 'utf8')) as {
  contracts: SystemAddresses;
  safe: Address;
};
const SAFE = system.safe;
const RANDOM = '0x1111111111111111111111111111111111111111';

function reason(fn: () => unknown): UndecodableReason {
  try {
    fn();
  } catch (error) {
    if (error instanceof UndecodableCallError) return error.reason;
    throw error;
  }
  throw new Error('se esperaba UndecodableCallError');
}

const transfer = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [RANDOM, 1_000_000n] });

describe('decodeSafeCall rechaza', () => {
  it.each<[string, { to: Address; value?: bigint; data: Hex; operation?: number }, UndecodableReason]>([
    ['DELEGATECALL', { to: system.contracts.usdc, data: transfer, operation: 1 }, 'DELEGATECALL'],
    ['ETH adjunto', { to: system.contracts.usdc, data: transfer, value: 1n }, 'NONZERO_VALUE'],
    ['destino desconocido', { to: RANDOM, data: transfer }, 'UNKNOWN_TARGET'],
    [
      'transferFrom (selector ERC-20 no permitido)',
      {
        to: system.contracts.usdc,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'transferFrom', args: [SAFE, RANDOM, 1n] }),
      },
      'UNKNOWN_SELECTOR',
    ],
    ['selector inexistente', { to: system.contracts.usdt, data: '0xdeadbeef' }, 'UNKNOWN_SELECTOR'],
    ['bytes extra al final', { to: system.contracts.usdc, data: `${transfer}00` }, 'NON_CANONICAL_CALLDATA'],
    [
      'dirección con bits altos sucios',
      { to: system.contracts.usdc, data: `0xa9059cbb${'ff'.repeat(12)}${RANDOM.slice(2)}${'0'.repeat(63)}1` as Hex },
      'NON_CANONICAL_CALLDATA',
    ],
    [
      'swap de un token no soportado',
      {
        to: system.contracts.swapExecutor,
        data: encodeFunctionData({ abi: swapExecutorV3Abi, functionName: 'swap', args: [RANDOM, 1n, 1n, 1n] }),
      },
      'UNSUPPORTED_TOKEN',
    ],
    [
      'propuesta con un RotationKind inexistente',
      {
        to: system.contracts.rotationTimelock,
        data: encodeFunctionData({ abi: rotationTimelockAbi, functionName: 'propose', args: [9, RANDOM, SAFE] }),
      },
      'INVALID_ROTATION_KIND',
    ],
    ['llamada arbitraria a la propia Safe', { to: SAFE, data: '0x610b5925' }, 'UNKNOWN_SELECTOR'],
  ])('%s', (_name, call, expected) => {
    expect(reason(() => decodeSafeCall(system.contracts, SAFE, { value: 0n, operation: 0, ...call }))).toBe(expected);
  });
});

describe('firmas ECDSA estrictas', () => {
  const account = privateKeyToAccount(`0x${'42'.repeat(32)}`);
  const digest: Hex = `0x${'ab'.repeat(32)}`;

  const problem = (signature: Hex): SignatureProblem => {
    try {
      parseStrictSignature(signature);
    } catch (error) {
      if (error instanceof InvalidSignatureError) return error.reason;
      throw error;
    }
    throw new Error('se esperaba InvalidSignatureError');
  };

  it('acepta una firma canónica y recupera el firmante', async () => {
    const signature = await account.sign({ hash: digest });
    expect(await recoverStrictSigner(digest, signature)).toBe(account.address);
  });

  it('rechaza la variante maleable (s alto) de una firma válida', async () => {
    const signature = await account.sign({ hash: digest });
    const r = signature.slice(2, 66);
    const s = BigInt(`0x${signature.slice(66, 130)}`);
    const v = Number.parseInt(signature.slice(130), 16);
    const malleable =
      `0x${r}${(SECP256K1_N - s).toString(16).padStart(64, '0')}${(v === 27 ? 28 : 27).toString(16)}` as Hex;
    expect(problem(malleable)).toBe('HIGH_S');
  });

  it.each<[string, (sig: string) => Hex, SignatureProblem]>([
    ['v = 0 (firma de contrato)', (sig) => `${sig.slice(0, 130)}00` as Hex, 'V_NOT_27_28'],
    ['v = 1 (hash aprobado)', (sig) => `${sig.slice(0, 130)}01` as Hex, 'V_NOT_27_28'],
    ['v = 31 (eth_sign)', (sig) => `${sig.slice(0, 130)}1f` as Hex, 'V_NOT_27_28'],
    ['64 bytes', (sig) => sig.slice(0, 130) as Hex, 'LENGTH'],
    ['r = 0', (sig) => `0x${'0'.repeat(64)}${sig.slice(66)}` as Hex, 'ZERO_R_OR_S'],
    ['r ≥ n', (sig) => `0x${'f'.repeat(64)}${sig.slice(66)}` as Hex, 'R_OUT_OF_RANGE'],
  ])('rechaza %s', async (_name, mutate, expected) => {
    const signature = await account.sign({ hash: digest });
    expect(problem(mutate(signature))).toBe(expected);
  });

  it('separa firmas concatenadas y rechaza longitudes inválidas', () => {
    expect(splitSignatures(`0x${'11'.repeat(65)}${'22'.repeat(65)}`)).toHaveLength(2);
    expect(() => splitSignatures(`0x${'11'.repeat(64)}`)).toThrow(InvalidSignatureError);
  });
});

describe('SafeTx asistida', () => {
  const base: SafeTx = {
    to: RANDOM,
    value: 0n,
    data: '0x',
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: '0x0000000000000000000000000000000000000000',
    refundReceiver: '0x0000000000000000000000000000000000000000',
    nonce: 0n,
  };
  it.each<[string, Partial<SafeTx>]>([
    ['DELEGATECALL', { operation: 1 }],
    ['safeTxGas', { safeTxGas: 1n }],
    ['baseGas', { baseGas: 1n }],
    ['gasPrice', { gasPrice: 1n }],
    ['gasToken', { gasToken: RANDOM }],
    ['refundReceiver', { refundReceiver: RANDOM }],
  ])('no es una llamada simple con %s', (_name, patch) => {
    expect(isPlainCall(base)).toBe(true);
    expect(isPlainCall({ ...base, ...patch })).toBe(false);
  });
});
