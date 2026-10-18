// Swap USDC↔USDT (P18.T07): la cotización del backend se compara con una propia (QuoterV2 por eth_call con el RPC del
// frontend, sobre el pool fijado del SwapExecutor), el slippage es de hasta 0,5 % y la operación son dos SafeTx que la
// app arma por su cuenta: `approve(SwapExecutor, monto exacto)` (nonce N) y `swap(tokenIn, monto, minOut, deadline)`
// (nonce N+1), con la allowance final en 0. El minOut del backend no puede quedar por debajo del piso calculado con la
// cotización propia, ni el deadline fuera de una ventana corta.
import { encodeFunctionData, erc20Abi, isAddressEqual, type Address } from 'viem';
import type { PreparedOperation, SwapQuote, TokenSymbol } from '../api/wallet-api.ts';
import { swapExecutorV3Abi } from '../chain/abis/SwapExecutorV3.ts';
import type { BaseClient } from '../chain/client.ts';
import { decodeSafeTx, type DecodeContext } from '../chain/decoders.ts';
import {
  assistedCall,
  parseSafeTx,
  SafeTxMismatchError,
  verifyPrepared,
  type VerifiedOperation,
} from '../chain/safe-tx.ts';
import type { PinnedChain } from '../config/chain.ts';

export const MAX_SLIPPAGE_BPS = 50;
/** Ventana máxima del deadline del swap (el backend usa unos minutos). */
export const MAX_DEADLINE_SECONDS = 3_600n;

const quoterV2Abi = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

export function tokenAddress(chain: Pick<PinnedChain, 'tokens'>, symbol: TokenSymbol): Address {
  return symbol === 'USDC' ? chain.tokens.usdc.address : chain.tokens.usdt.address;
}

/** Cotización propia: cuánto sale del pool fijado por `amountIn` (eth_call al QuoterV2 con el RPC del frontend). */
export async function ownQuote(
  reader: Pick<BaseClient, 'simulateContract'>,
  chain: Pick<PinnedChain, 'tokens' | 'uniswap'>,
  tokenIn: TokenSymbol,
  amountIn: bigint,
): Promise<bigint> {
  const { result } = await reader.simulateContract({
    address: chain.uniswap.quoterV2,
    abi: quoterV2Abi,
    functionName: 'quoteExactInputSingle',
    args: [
      {
        tokenIn: tokenAddress(chain, tokenIn),
        tokenOut: tokenAddress(chain, tokenIn === 'USDC' ? 'USDT' : 'USDC'),
        amountIn,
        fee: chain.uniswap.pool.fee,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  return result[0];
}

/** Mínimo aceptable con el slippage pedido sobre una cotización. */
export function minOutFor(expectedOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new RangeError('slippage fuera de rango (máximo 0,5 %)');
  }
  return (expectedOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

export function approveCall(token: Address, spender: Address, amount: bigint, nonce: bigint) {
  return assistedCall(
    token,
    encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
    nonce,
  );
}

export function swapCall(
  swapExecutor: Address,
  args: { tokenIn: Address; amountIn: bigint; minAmountOut: bigint; deadline: bigint },
  nonce: bigint,
) {
  return assistedCall(
    swapExecutor,
    encodeFunctionData({
      abi: swapExecutorV3Abi,
      functionName: 'swap',
      args: [args.tokenIn, args.amountIn, args.minAmountOut, args.deadline],
    }),
    nonce,
  );
}

export interface SwapReview {
  approve: VerifiedOperation;
  swap: VerifiedOperation;
  minAmountOut: bigint;
  deadline: bigint;
  ownExpectedOut: bigint;
  backendQuote: SwapQuote;
}

/** Verifica el par preparado por el backend contra el que arma la app (con la cotización propia como referencia). */
export function verifySwapPair(
  prepared: { quote: SwapQuote; operations: PreparedOperation[] },
  ctx: {
    safe: Address;
    chain: Pick<PinnedChain, 'tokens'>;
    decode: DecodeContext;
    swapExecutor: Address;
    tokenIn: TokenSymbol;
    amountIn: bigint;
    slippageBps: number;
    ownExpectedOut: bigint;
    onchainNonce: bigint;
    nowSeconds: bigint;
  },
): SwapReview {
  const [approveOp, swapOp] = prepared.operations;
  if (prepared.operations.length !== 2 || !approveOp || !swapOp) throw new SafeTxMismatchError(['operations']);
  if (approveOp.operationType !== 'SWAP_APPROVE' || swapOp.operationType !== 'SWAP') {
    throw new SafeTxMismatchError(['operationType']);
  }
  const tokenIn = tokenAddress(ctx.chain, ctx.tokenIn);
  const approve = verifyPrepared(approveOp, {
    safe: ctx.safe,
    chainId: 8453,
    onchainNonce: ctx.onchainNonce,
    build: (nonce) => approveCall(tokenIn, ctx.swapExecutor, ctx.amountIn, nonce),
  });
  // minOut y deadline los fija el backend al cotizar: se leen de sus bytes y se acotan con la referencia propia.
  const remote = decodeSafeTx(parseSafeTx(swapOp.safeTx), ctx.decode);
  if (remote.kind !== 'SWAP') throw new SafeTxMismatchError(['data']);
  const floor = minOutFor(ctx.ownExpectedOut, ctx.slippageBps);
  const problems: string[] = [];
  if (remote.minAmountOut < floor || remote.minAmountOut > ctx.ownExpectedOut) problems.push('minAmountOut');
  if (remote.deadline <= ctx.nowSeconds || remote.deadline > ctx.nowSeconds + MAX_DEADLINE_SECONDS) {
    problems.push('deadline');
  }
  if (problems.length > 0) throw new SafeTxMismatchError(problems);
  const swap = verifyPrepared(swapOp, {
    safe: ctx.safe,
    chainId: 8453,
    onchainNonce: ctx.onchainNonce,
    build: (nonce) =>
      swapCall(
        ctx.swapExecutor,
        { tokenIn, amountIn: ctx.amountIn, minAmountOut: remote.minAmountOut, deadline: remote.deadline },
        nonce,
      ),
  });
  if (swap.safeTx.nonce !== approve.safeTx.nonce + 1n) throw new SafeTxMismatchError(['nonce']);
  if (!isAddressEqual(approve.safeTx.to, tokenIn)) throw new SafeTxMismatchError(['to']);
  return {
    approve,
    swap,
    minAmountOut: remote.minAmountOut,
    deadline: remote.deadline,
    ownExpectedOut: ctx.ownExpectedOut,
    backendQuote: prepared.quote,
  };
}
