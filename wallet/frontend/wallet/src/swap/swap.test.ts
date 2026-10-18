// P18.T06/T07: transfer del vector de contracts/; swap: el par approve exacto + swap se acepta sólo si es el que arma la
// app, con nonces consecutivos, minOut entre el piso de la cotización propia (slippage ≤ 0,5 %) y la cotización, y un
// deadline cercano; la cotización propia sale del QuoterV2 fijado por eth_call.
import { encodeFunctionData, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import safeTxVectors from '../../test/vectors/safe-tx.json';
import systemVector from '../../test/vectors/system.json';
import type { PreparedOperation, SwapQuote } from '../api/wallet-api.ts';
import { swapExecutorV3Abi } from '../chain/abis/SwapExecutorV3.ts';
import { assistedCall, safeTxHash, SafeTxMismatchError, type SafeTx } from '../chain/safe-tx.ts';
import { pinnedChain } from '../config/chain.ts';
import type { SystemContracts } from '../config/system-contracts.ts';
import { transferCall } from '../send/send.ts';
import { approveCall, minOutFor, ownQuote, swapCall, verifySwapPair } from './swap.ts';

const vectors = safeTxVectors as unknown as {
  safe: Address;
  operations: { opType: string; to: Address; data: `0x${string}`; nonce: number; safeTxHash: `0x${string}` }[];
};
const system = systemVector as unknown as { contracts: Record<string, Address> };
const EXECUTOR = system.contracts.swapExecutor ?? '0x';
const SAFE = vectors.safe;

describe('envío', () => {
  it('transfer: la SafeTx del vector', () => {
    const op = vectors.operations.find((o) => o.opType === 'TRANSFER');
    if (!op) throw new Error('TRANSFER');
    const recipient: Address = `0x${op.data.slice(34, 74)}`;
    const amount = BigInt(`0x${op.data.slice(74)}`);
    const tx = transferCall(pinnedChain.tokens.usdc, recipient, amount, BigInt(op.nonce));
    expect(safeTxHash(8453, SAFE, tx)).toBe(op.safeTxHash);
  });
});

describe('swap', () => {
  const NOW = 1_792_189_000n;
  const AMOUNT = 100_000_000n;
  const OWN = 99_990_000n;
  const decode = {
    safe: SAFE,
    chain: pinnedChain,
    system: { contracts: { swapExecutor: { address: EXECUTOR } } } as unknown as Pick<SystemContracts, 'contracts'>,
  };
  const prepared = (tx: SafeTx, type: PreparedOperation['operationType']): PreparedOperation => ({
    operationId: type,
    groupId: 'g',
    walletId: 'w',
    safe: SAFE,
    chainId: 8453,
    operationType: type,
    safeTx: {
      ...tx,
      value: tx.value.toString(),
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      nonce: tx.nonce.toString(),
    },
    safeTxHash: safeTxHash(8453, SAFE, tx),
    typedData: {},
    decoded: {},
    requiresTwoFactor: false,
    expiresAt: '',
  });
  const pair = (minOut: bigint, deadline: bigint, options: { approveAmount?: bigint; swapNonce?: bigint } = {}) => [
    prepared(
      approveCall(pinnedChain.tokens.usdc.address, EXECUTOR, options.approveAmount ?? AMOUNT, 7n),
      'SWAP_APPROVE',
    ),
    prepared(
      swapCall(
        EXECUTOR,
        { tokenIn: pinnedChain.tokens.usdc.address, amountIn: AMOUNT, minAmountOut: minOut, deadline },
        options.swapNonce ?? 8n,
      ),
      'SWAP',
    ),
  ];
  const ctx = {
    safe: SAFE,
    chain: pinnedChain,
    decode,
    swapExecutor: EXECUTOR,
    tokenIn: 'USDC' as const,
    amountIn: AMOUNT,
    slippageBps: 30,
    ownExpectedOut: OWN,
    onchainNonce: 7n,
    nowSeconds: NOW,
  };
  const quote = {} as SwapQuote;
  const fields = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      if (error instanceof SafeTxMismatchError) return error.fields;
      throw error;
    }
    return [];
  };

  it('piso del slippage y su límite de 0,5 %', () => {
    expect(minOutFor(OWN, 30)).toBe(99_690_030n);
    expect(() => minOutFor(OWN, 51)).toThrow(RangeError);
  });

  it('par correcto: approve exacto (N) y swap (N+1) con minOut y deadline acotados', () => {
    const review = verifySwapPair({ quote, operations: pair(99_700_000n, NOW + 300n) }, ctx);
    expect(review.approve.safeTx.nonce).toBe(7n);
    expect(review.swap.safeTx.nonce).toBe(8n);
    expect(review.minAmountOut).toBe(99_700_000n);
  });

  it.each<[string, () => PreparedOperation[], string[]]>([
    ['minOut bajo el piso propio', () => pair(99_000_000n, NOW + 300n), ['minAmountOut']],
    ['minOut sobre la cotización (no ejecutaría)', () => pair(OWN + 1n, NOW + 300n), ['minAmountOut']],
    ['deadline vencido', () => pair(99_700_000n, NOW), ['deadline']],
    ['deadline lejano', () => pair(99_700_000n, NOW + 7_200n), ['deadline']],
    [
      'approve mayor que el swap',
      () => pair(99_700_000n, NOW + 300n, { approveAmount: AMOUNT + 1n }),
      ['data', 'safeTxHash'],
    ],
    ['swap no consecutivo', () => pair(99_700_000n, NOW + 300n, { swapNonce: 9n }), ['nonce']],
  ])('no firma con %s', (_label, make, expected) => {
    expect(fields(() => verifySwapPair({ quote, operations: make() }, ctx))).toEqual(expected);
  });

  it('el par tiene que ser exactamente approve + swap', () => {
    const [a, s] = pair(99_700_000n, NOW + 300n);
    if (!a || !s) throw new Error('par');
    expect(fields(() => verifySwapPair({ quote, operations: [a] }, ctx))).toEqual(['operations']);
    expect(fields(() => verifySwapPair({ quote, operations: [s, a] }, ctx))).toEqual(['operationType']);
    const notSwap = prepared(assistedCall(EXECUTOR, '0x1234', 8n), 'SWAP');
    expect(fields(() => verifySwapPair({ quote, operations: [a, notSwap] }, ctx))).toEqual(['data']);
  });

  it('cotización propia con el QuoterV2 fijado', async () => {
    const calls: unknown[] = [];
    const reader = {
      simulateContract: (request: unknown) => {
        calls.push(request);
        return Promise.resolve({ result: [OWN, 0n, 0, 0n] });
      },
    } as never;
    expect(await ownQuote(reader, pinnedChain, 'USDT', AMOUNT)).toBe(OWN);
    expect(calls[0]).toMatchObject({
      address: pinnedChain.uniswap.quoterV2,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          tokenIn: pinnedChain.tokens.usdt.address,
          tokenOut: pinnedChain.tokens.usdc.address,
          amountIn: AMOUNT,
          fee: 100,
        },
      ],
    });
    expect(encodeFunctionData({ abi: swapExecutorV3Abi, functionName: 'tokenOutFor', args: [EXECUTOR] })).toMatch(
      /^0x/,
    );
  });
});
