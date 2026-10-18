// P14.T04: cotización contra el pool canónico real del fork. La salida es exactamente la de QuoterV2 en el mismo
// bloque, minOut sale del slippage (≤ 50 bps) y nunca baja del piso contra la paridad, el impacto se mide contra el
// precio medio del pool y el deadline es el bloque + 10 min. Si el pool se desvía de 1:1 más de lo que el slippage
// permite (aquí: una venta real grande en el pool por el SwapRouter02), no se cotiza. Más la ruta de la API.
import { randomBytes } from 'node:crypto';
import { encodeFunctionData, getAddress, type Abi, type Address, type Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { swapExecutorV3Abi } from '../../src/chain/abis/index.ts';
import {
  midPriceOut,
  minOutFor,
  parityFloor,
  QuoteService,
  quoterV2Abi,
  shortfallBps,
  UNISWAP_QUOTER_V2,
} from '../../src/swap/quote.ts';
import { newOnboardingUser } from '../helpers/onboarding.ts';
import {
  activeWallet,
  startOperationsEnv,
  USDC_HOLDER,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

const SWAP_ROUTER_02: Address = '0x2626664c2603336E57B271c5C0b26F421741e481';
const CANONICAL_POOL: Address = '0xD56da2B74bA826f19015E6B7Dd9Dae1903E85DA1';
const UNIT = 1_000_000n;

const routerAbi = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const satisfies Abi;

const approveAbi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const satisfies Abi;

let env: OperationsEnv;
let wallet: ActiveWallet;
let quotes: QuoteService;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.swapQuote });
  wallet = await activeWallet(env);
  quotes = new QuoteService({ rpc: env.base.rpc, snapshot: () => env.base.snapshot });
}, 600_000);

afterAll(async () => {
  await env.close();
});

/** Tx real desde una cuenta impersonada del fork. */
async function impersonated(from: Address, to: Address, data: Hex): Promise<void> {
  await env.chain.setBalance(from, 10n ** 19n);
  await env.chain.rpc('anvil_impersonateAccount', [from]);
  try {
    // Gas holgado: la venta grande cruza muchos ticks inicializados del pool.
    const tx = { from, to, data, gas: '0x1c9c380' };
    const hash = await env.chain.rpc<Hex>('eth_sendTransaction', [tx]);
    const receipt = await env.chain.public.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      const reason = await env.chain.rpc('eth_call', [tx, 'latest']).catch((error: unknown) => String(error));
      throw new Error(
        `tx impersonada revertida (gas usado ${receipt.gasUsed.toString()}): ${JSON.stringify(reason).slice(0, 300)}`,
      );
    }
  } finally {
    await env.chain.rpc('anvil_stopImpersonatingAccount', [from]);
  }
}

describe('aritmética de la cotización', () => {
  it('minOut redondea hacia abajo, el piso hacia arriba y el impacto nunca subestima', () => {
    expect(minOutFor(1_000_000n, 30)).toBe(997_000n);
    expect(minOutFor(999_999n, 30)).toBe(996_999n);
    expect(parityFloor(1_000_000n, 50)).toBe(995_000n);
    // 999.999 · 0,995 = 994.999,005 → 995.000 (el SwapExecutor acepta desde floor = 994.999; la policy exige el ceil).
    expect(parityFloor(999_999n, 50)).toBe(995_000n);
    expect(shortfallBps(1_000_000n, 999_000n)).toBe(10);
    expect(shortfallBps(1_000_000n, 998_999n)).toBe(11);
    expect(shortfallBps(1_000_000n, 1_000_001n)).toBe(0);
    const q96 = 2n ** 96n;
    expect(midPriceOut(1_000_000n, q96, true)).toBe(1_000_000n);
    expect(midPriceOut(1_000_000n, q96, false)).toBe(1_000_000n);
    // P = 1,0201 (√P = 1,01): token0 → token1 multiplica, token1 → token0 divide.
    expect(midPriceOut(1_000_000n, (q96 * 101n) / 100n, true)).toBe(1_020_099n);
    expect(midPriceOut(1_020_100n, (q96 * 101n) / 100n, false)).toBe(1_000_000n);
  });
});

describe('QuoterV2 sobre el pool canónico', () => {
  it('USDC→USDT y USDT→USDC: misma salida que QuoterV2 en el bloque, minOut por slippage, impacto y deadline', async () => {
    const s = env.base.snapshot;
    const pool = await env.chain.public.readContract({
      address: s.contracts.swapExecutor,
      abi: swapExecutorV3Abi,
      functionName: 'POOL',
    });
    expect(getAddress(pool)).toBe(CANONICAL_POOL);
    for (const tokenIn of ['USDC', 'USDT'] as const) {
      const amountIn = 1_000n * UNIT;
      const q = await quotes.quote({ tokenIn, amountIn, slippageBps: 30 });
      expect(q).toMatchObject({
        tokenIn,
        tokenOut: tokenIn === 'USDC' ? 'USDT' : 'USDC',
        amountIn,
        slippageBps: 30,
        pool: CANONICAL_POOL,
        fee: 100,
      });
      const direct = await env.chain.public.simulateContract({
        address: UNISWAP_QUOTER_V2,
        abi: quoterV2Abi,
        functionName: 'quoteExactInputSingle',
        args: [
          {
            tokenIn: q.tokenInAddress,
            tokenOut: q.tokenOutAddress,
            amountIn,
            fee: 100,
            sqrtPriceLimitX96: 0n,
          },
        ],
        blockNumber: q.blockNumber,
      });
      expect(q.expectedOut).toBe(direct.result[0]);
      expect(q.minOut).toBe((q.expectedOut * 9_970n) / 10_000n);
      expect(q.minOut).toBeGreaterThanOrEqual(parityFloor(amountIn, 50));
      // Pool estable profundo: el fee de 1 bp y casi nada de impacto para 1.000 unidades.
      expect(q.priceImpactBps).toBeGreaterThanOrEqual(1);
      expect(q.priceImpactBps).toBeLessThan(10);
      const block = await env.chain.public.getBlock({ blockNumber: q.blockNumber });
      expect(q.deadline).toBe(block.timestamp + 600n);
    }
    // Sin slippage explícito se usa el default del snapshot (30 bps).
    expect((await quotes.quote({ tokenIn: 'USDC', amountIn: 10n * UNIT })).slippageBps).toBe(30);
  });

  it('por la API con la sesión de cuenta, con validación del slippage, de los límites y de la wallet (404 ajena)', async () => {
    const browser = wallet.onboarded.user.wallet;
    const base = `/api/v1/wallets/${wallet.walletId}/swap/quote`;
    const ok = await browser.get(`${base}?tokenIn=USDT&amountIn=${String(250n * UNIT)}&slippageBps=50`);
    expect(ok.statusCode, ok.body).toBe(200);
    const view = ok.json<{
      expectedOut: string;
      minOut: string;
      slippageBps: number;
      deadline: string;
      pool: string;
    }>();
    expect(view).toMatchObject({ slippageBps: 50, pool: CANONICAL_POOL });
    // Con el slippage máximo y la cotización apenas debajo de la paridad (fee de 1 bp), minOut queda en el piso.
    const requested = (BigInt(view.expectedOut) * 9_950n) / 10_000n;
    const floor = parityFloor(250n * UNIT, 50);
    expect(BigInt(view.minOut)).toBe(requested > floor ? requested : floor);
    expect((await browser.get(`${base}?tokenIn=USDT&amountIn=1000000&slippageBps=51`)).statusCode).toBe(400);
    expect((await browser.get(`${base}?tokenIn=DAI&amountIn=1000000`)).statusCode).toBe(400);
    const below = await browser.get(`${base}?tokenIn=USDC&amountIn=999999`);
    expect(below.statusCode).toBe(422);
    expect(below.json()).toMatchObject({ code: 'POLICY_REJECTED', detail: 'BELOW_MINIMUM' });
    const above = await browser.get(`${base}?tokenIn=USDC&amountIn=${String(10_001n * UNIT)}`);
    expect(above.statusCode).toBe(422);
    expect(above.json()).toMatchObject({ code: 'POLICY_REJECTED', detail: 'SWAP_LIMIT' });
    // Otro usuario no ve la wallet ([B-AUTHZ]: 404).
    const stranger = await newOnboardingUser(env.base);
    expect((await stranger.wallet.get(`${base}?tokenIn=USDC&amountIn=1000000`)).statusCode).toBe(404);
    expect(
      (await browser.get(`/api/v1/wallets/${crypto.randomUUID()}/swap/quote?tokenIn=USDC&amountIn=1000000`)).statusCode,
    ).toBe(404);
  });

  it('precio fuera de banda: tras vender 200.000 USDC en el pool, USDC→USDT no se cotiza; USDT→USDC sí', async () => {
    const s = env.base.snapshot;
    const snapshot = await env.chain.rpc<Hex>('evm_snapshot');
    try {
      const amount = 200_000n * UNIT;
      await impersonated(
        USDC_HOLDER,
        s.tokens.USDC,
        encodeFunctionData({ abi: approveAbi, functionName: 'approve', args: [SWAP_ROUTER_02, amount] }),
      );
      await impersonated(
        USDC_HOLDER,
        SWAP_ROUTER_02,
        encodeFunctionData({
          abi: routerAbi,
          functionName: 'exactInputSingle',
          args: [
            {
              tokenIn: s.tokens.USDC,
              tokenOut: s.tokens.USDT,
              fee: 100,
              recipient: getAddress(`0x${randomBytes(20).toString('hex')}`),
              amountIn: amount,
              amountOutMinimum: 0n,
              sqrtPriceLimitX96: 0n,
            },
          ],
        }),
      );
      await expect(quotes.quote({ tokenIn: 'USDC', amountIn: 1_000n * UNIT, slippageBps: 50 })).rejects.toMatchObject({
        code: 'SWAP_PRICE_OUT_OF_RANGE',
      });
      const response = await wallet.onboarded.user.wallet.get(
        `/api/v1/wallets/${wallet.walletId}/swap/quote?tokenIn=USDC&amountIn=${String(1_000n * UNIT)}`,
      );
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'SWAP_PRICE_OUT_OF_RANGE' });
      // En el otro sentido el precio favorece al que vende USDT: se cotiza por encima de la paridad.
      const reverse = await quotes.quote({ tokenIn: 'USDT', amountIn: 1_000n * UNIT });
      expect(reverse.expectedOut).toBeGreaterThan(1_000n * UNIT);
    } finally {
      await env.chain.rpc('evm_revert', [snapshot]);
    }
    // La venta cruza muchos ticks del pool: Anvil lee ese estado del RPC remoto del fork (con límite de ritmo).
  }, 300_000);
});
