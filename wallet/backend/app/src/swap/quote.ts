// Cotización de swaps USDC/USDT (P14.T04): QuoterV2 de Uniswap v3 por `eth_call` (no es view) sobre el pool canónico
// que fija el SwapExecutorV3 (POOL y FEE inmutables), con quórum de los dos proveedores en el mismo bloque. Antes de
// usar el Quoter se verifica su runtime codehash contra el fijado en config/chains/base-mainnet.json.
//
// - expectedOut: salida exacta del Quoter (incluye el fee del pool).
// - minOut = expectedOut · (1 − slippage) con slippage ≤ 50 bps (máximo de la policy), pero nunca debajo del piso
//   contra la paridad 1:1 (amountIn · (1 − 50 bps), la misma cota que aplican la policy y el SwapExecutor): si el
//   slippage pedido lo deja debajo, minOut es el piso (más estricto para el usuario). Si la propia cotización está
//   debajo del piso (el pool se desvía de 1:1 más de 50 bps), no se cotiza (SWAP_PRICE_OUT_OF_RANGE).
// - priceImpactBps: salida contra el precio medio del pool antes del swap (slot0), redondeado hacia arriba.
// - deadline = timestamp del bloque de la cotización + deadlineSeconds del snapshot (10 min).
import { keccak256, type Abi, type Address } from 'viem';
import { ApiError } from '../api/errors.ts';
import { swapExecutorV3Abi } from '../chain/abis/index.ts';
import type { RpcQuorumClient } from '../chain/rpc-quorum.ts';
import type { SwapQuoteJson } from '../db/schema.ts';
import type { Metrics } from '../observability/metrics.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';

/** Uniswap v3 QuoterV2 en Base (config/chains/base-mainnet.json, verificado en P03). */
export const UNISWAP_QUOTER_V2: Address = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a';
export const UNISWAP_QUOTER_V2_CODEHASH = '0xceb5b8bc35e09fc64b1c48c6b920e0d2e37d5710e4f3ef214e1a81f75acee51e';

export const quoterV2Abi = [
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
] as const satisfies Abi;

const poolAbi = [
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
] as const satisfies Abi;

export type SwapToken = 'USDC' | 'USDT';

export interface SwapQuote {
  tokenIn: SwapToken;
  tokenOut: SwapToken;
  tokenInAddress: Address;
  tokenOutAddress: Address;
  amountIn: bigint;
  expectedOut: bigint;
  minOut: bigint;
  slippageBps: number;
  priceImpactBps: number;
  deadline: bigint;
  blockNumber: bigint;
  quotedAt: Date;
  pool: Address;
  fee: number;
}

export interface QuoteDeps {
  rpc: RpcQuorumClient;
  snapshot: () => BackendPolicySnapshot;
  metrics?: Metrics;
  /** Reloj en ms (tests). */
  now?: () => number;
}

const Q192 = 2n ** 192n;

/** Salida al precio medio del pool (sin fee ni impacto): token0 → token1 multiplica por P, token1 → token0 divide. */
export function midPriceOut(amountIn: bigint, sqrtPriceX96: bigint, zeroForOne: boolean): bigint {
  const priceX192 = sqrtPriceX96 * sqrtPriceX96;
  return zeroForOne ? (amountIn * priceX192) / Q192 : (amountIn * Q192) / priceX192;
}

/** bps de diferencia de `out` respecto de `reference`, redondeado hacia arriba (0 si out ≥ reference). */
export function shortfallBps(reference: bigint, out: bigint): number {
  if (reference === 0n || out >= reference) return 0;
  return Number(((reference - out) * 10_000n + reference - 1n) / reference);
}

/** minOut para un slippage sobre la cotización (redondeo hacia abajo, como QuoteReference.minOutFor). */
export function minOutFor(expectedOut: bigint, slippageBps: number): bigint {
  return (expectedOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** Piso contra la paridad 1:1 que exige la policy (y cumple el del SwapExecutor): ceil(amountIn · (1 − max)). */
export function parityFloor(amountIn: bigint, maxSlippageBps: number): bigint {
  const scaled = amountIn * BigInt(10_000 - maxSlippageBps);
  return (scaled + 9_999n) / 10_000n;
}

export function quoteJson(q: SwapQuote): SwapQuoteJson {
  return {
    expectedOut: q.expectedOut.toString(),
    minOut: q.minOut.toString(),
    slippageBps: q.slippageBps,
    priceImpactBps: q.priceImpactBps,
    deadline: q.deadline.toString(),
    blockNumber: q.blockNumber.toString(),
    quotedAt: q.quotedAt.toISOString(),
  };
}

export class QuoteService {
  readonly #d: QuoteDeps;
  #pool: { address: Address; fee: number } | undefined;
  #quoterVerified = false;

  constructor(deps: QuoteDeps) {
    this.#d = deps;
  }

  /** Pool canónico y fee del SwapExecutorV3 (inmutables) y codehash del Quoter: una vez por proceso. */
  async #setup(): Promise<{ address: Address; fee: number }> {
    if (this.#pool && this.#quoterVerified) return this.#pool;
    const executor = this.#d.snapshot().contracts.swapExecutor;
    const { value } = await this.#d.rpc.readSensitive('swap-setup', async (client, blockNumber) => {
      const [pool, fee, code] = await Promise.all([
        client.readContract({ address: executor, abi: swapExecutorV3Abi, functionName: 'POOL', blockNumber }),
        client.readContract({ address: executor, abi: swapExecutorV3Abi, functionName: 'FEE', blockNumber }),
        client.getCode({ address: UNISWAP_QUOTER_V2, blockNumber }),
      ]);
      return { pool, fee, codehash: code === undefined ? null : keccak256(code) };
    });
    if (value.codehash !== UNISWAP_QUOTER_V2_CODEHASH) {
      throw new Error('el runtime codehash de QuoterV2 no coincide con el fijado en config/chains/base-mainnet.json');
    }
    this.#quoterVerified = true;
    this.#pool = { address: value.pool, fee: value.fee };
    return this.#pool;
  }

  async quote(input: { tokenIn: SwapToken; amountIn: bigint; slippageBps?: number | undefined }): Promise<SwapQuote> {
    const snapshot = this.#d.snapshot();
    const slippageBps = input.slippageBps ?? snapshot.swap.defaultSlippageBps;
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > snapshot.swap.maxSlippageBps) {
      throw new ApiError('VALIDATION_FAILED', {
        detail: `slippage entre 0 y ${String(snapshot.swap.maxSlippageBps)} bps`,
      });
    }
    if (input.amountIn < snapshot.limits.minPerOperation)
      throw new ApiError('POLICY_REJECTED', { detail: 'BELOW_MINIMUM' });
    if (input.amountIn > snapshot.limits.swapMax) throw new ApiError('POLICY_REJECTED', { detail: 'SWAP_LIMIT' });
    const tokenOut: SwapToken = input.tokenIn === 'USDC' ? 'USDT' : 'USDC';
    const tokenInAddress = snapshot.tokens[input.tokenIn];
    const tokenOutAddress = snapshot.tokens[tokenOut];
    const pool = await this.#setup();
    const { value, blockNumber } = await this.#d.rpc.readSensitive('swap-quote', async (client, block) => {
      const [simulation, slot0, header] = await Promise.all([
        client.simulateContract({
          address: UNISWAP_QUOTER_V2,
          abi: quoterV2Abi,
          functionName: 'quoteExactInputSingle',
          args: [
            {
              tokenIn: tokenInAddress,
              tokenOut: tokenOutAddress,
              amountIn: input.amountIn,
              fee: pool.fee,
              sqrtPriceLimitX96: 0n,
            },
          ],
          blockNumber: block,
        }),
        client.readContract({ address: pool.address, abi: poolAbi, functionName: 'slot0', blockNumber: block }),
        client.getBlock({ blockNumber: block }),
      ]);
      return {
        expectedOut: simulation.result[0].toString(),
        sqrtPriceX96: slot0[0].toString(),
        timestamp: header.timestamp.toString(),
      };
    });
    const expectedOut = BigInt(value.expectedOut);
    const floor = parityFloor(input.amountIn, snapshot.swap.maxSlippageBps);
    if (expectedOut < floor) {
      this.#d.metrics?.swapQuotes.inc({ result: 'out_of_range' });
      throw new ApiError('SWAP_PRICE_OUT_OF_RANGE');
    }
    const requested = minOutFor(expectedOut, slippageBps);
    const minOut = requested > floor ? requested : floor;
    // USDC es token0 del pool canónico (dirección menor): USDC → USDT es zeroForOne.
    const zeroForOne = BigInt(tokenInAddress) < BigInt(tokenOutAddress);
    const priceImpactBps = shortfallBps(
      midPriceOut(input.amountIn, BigInt(value.sqrtPriceX96), zeroForOne),
      expectedOut,
    );
    this.#d.metrics?.swapQuotes.inc({ result: 'ok' });
    return {
      tokenIn: input.tokenIn,
      tokenOut,
      tokenInAddress,
      tokenOutAddress,
      amountIn: input.amountIn,
      expectedOut,
      minOut,
      slippageBps,
      priceImpactBps,
      deadline: BigInt(value.timestamp) + BigInt(snapshot.swap.deadlineSeconds),
      blockNumber,
      quotedAt: new Date(this.#d.now?.() ?? Date.now()),
      pool: pool.address,
      fee: pool.fee,
    };
  }
}
