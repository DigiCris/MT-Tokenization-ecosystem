// P08.T05 [B-RPC]: RpcQuorumClient contra dos Anvil reales sobre el mismo fork de Base y el proxy de inyección de
// fallas delante de uno de ellos (timeouts, respuesta divergente, chainId incorrecto, head atrasado, error HTTP).
import { erc20Abi, parseEther, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RpcQuorumClient, RpcQuorumError, type QuorumMode } from '../../src/chain/rpc-quorum.ts';
import { createLogger } from '../../src/observability/logger.ts';
import { createMetrics, type Metrics } from '../../src/observability/metrics.ts';
import { startFaultProxy, type FaultProxy } from '../helpers/fault-proxy.ts';
import { forkBlockNumber, startAnvil, type AnvilInstance } from '../helpers/fork.ts';

const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
/** Holder real de USDC en el bloque de fork (Morpho Blue). */
const USDC_HOLDER: Address = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
/** Slot EIP-1967 de implementación (USDC es un proxy). */
const IMPLEMENTATION_SLOT: Hex = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
/** Primera cuenta por defecto de Anvil (sólo existe con fondos en el fork local). */
const ANVIL_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const logger = createLogger({ level: 'silent', service: 'test' });

let anvilA: AnvilInstance;
let anvilB: AnvilInstance;
let proxyB: FaultProxy;
let proxyA: FaultProxy;

/** Timeout corto sólo para los tests que provocan timeouts; el resto tolera la lectura en frío del fork. */
const SHORT_TIMEOUT = 1_500;
const READ_TIMEOUT = 30_000;

function client(
  primary: string,
  secondary: string,
  metrics: Metrics,
  mode: QuorumMode = 'dual',
  retries = 2,
  timeoutMs = READ_TIMEOUT,
) {
  return new RpcQuorumClient({
    primaryUrl: primary,
    secondaryUrl: secondary,
    mode,
    chainId: 8453,
    timeoutMs,
    healthIntervalMs: 60_000,
    maxHeadLagBlocks: 10,
    retries,
    backoffMs: 20,
    logger,
    metrics,
  });
}

async function code(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'ok';
  } catch (error) {
    if (error instanceof RpcQuorumError) return error.code;
    throw error;
  }
}

beforeAll(async () => {
  [anvilA, anvilB] = await Promise.all([startAnvil(), startAnvil()]);
  // Un bloque más en cada uno: el bloque común (min(head) - 1) es el de fork.
  await Promise.all([anvilA.rpc('anvil_mine', ['0x1']), anvilB.rpc('anvil_mine', ['0x1'])]);
  proxyB = await startFaultProxy(anvilB.url);
  proxyA = await startFaultProxy(anvilA.url);
  // Precalienta en ambos Anvil el estado que leen los tests (Anvil lo trae del RPC remoto la primera vez).
  const forkTag = `0x${forkBlockNumber().toString(16)}`;
  const balanceOf = `0x70a08231${USDC_HOLDER.slice(2).toLowerCase().padStart(64, '0')}`;
  for (const anvil of [anvilA, anvilB]) {
    for (const tag of [forkTag, 'latest']) {
      await anvil.rpc('eth_call', [{ to: USDC, data: balanceOf }, tag]);
      await anvil.rpc('eth_getCode', [USDC, tag]);
      await anvil.rpc('eth_getStorageAt', [USDC, IMPLEMENTATION_SLOT, tag]);
      await anvil.rpc('eth_getBalance', [USDC_HOLDER, tag]);
    }
  }
}, 300_000);

afterAll(async () => {
  await Promise.all([proxyA.close(), proxyB.close()]);
  await Promise.all([anvilA.stop(), anvilB.stop()]);
});

describe('health checks [B-RPC-01]', () => {
  it('ambos proveedores sanos: chainId 8453, head y latencia', async () => {
    proxyB.setMode({ kind: 'pass' });
    const metrics = createMetrics({ defaultMetrics: false });
    const rpc = client(anvilA.url, proxyB.url, metrics);
    const results = await rpc.checkHealth();
    expect(results.map((r) => [r.provider, r.healthy, r.reason, r.chainId])).toEqual([
      ['primary', true, 'OK', 8453],
      ['secondary', true, 'OK', 8453],
    ]);
    expect(results.every((r) => r.head !== null && r.head > BigInt(forkBlockNumber()))).toBe(true);
    expect(rpc.health().ready).toBe(true);
    expect(await metrics.registry.getSingleMetricAsString('mtw_rpc_provider_healthy')).toContain(
      'provider="secondary"} 1',
    );
  });

  it.each([
    [{ kind: 'wrong-chain' } as const, 'CHAIN_ID_MISMATCH'],
    [{ kind: 'timeout' } as const, 'TIMEOUT'],
    [{ kind: 'http-error', status: 502 } as const, 'UNREACHABLE'],
    [{ kind: 'head-lag', lag: 50 } as const, 'HEAD_LAG'],
  ])('detecta %o y deja la API no lista', async (mode, reason) => {
    proxyB.setMode(mode);
    const metrics = createMetrics({ defaultMetrics: false });
    const rpc = client(anvilA.url, proxyB.url, metrics, 'dual', 2, SHORT_TIMEOUT);
    const results = await rpc.checkHealth();
    expect(results[0]).toMatchObject({ provider: 'primary', healthy: true });
    expect(results[1]).toMatchObject({ provider: 'secondary', healthy: false, reason });
    expect(rpc.health().ready).toBe(false);
    expect(await metrics.registry.getSingleMetricAsString('mtw_rpc_provider_healthy')).toContain(
      'provider="secondary"} 0',
    );
    proxyB.setMode({ kind: 'pass' });
  });

  it('el loop de health checks corre y se detiene', async () => {
    const rpc = client(anvilA.url, proxyB.url, createMetrics({ defaultMetrics: false }));
    rpc.start();
    await expect.poll(() => rpc.health().ready, { timeout: 10_000 }).toBe(true);
    await rpc.stop();
  });
});

describe('lecturas sensibles con quórum [B-RPC-02]', () => {
  it('dos Anvil del mismo fork coinciden en el bloque común', async () => {
    proxyB.setMode({ kind: 'pass' });
    const rpc = client(anvilA.url, proxyB.url, createMetrics({ defaultMetrics: false }));
    const balance = await rpc.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [USDC_HOLDER],
    });
    expect(balance.blockNumber).toBe(BigInt(forkBlockNumber()));
    expect(balance.value > 0n).toBe(true);
    const codeRead = await rpc.getCode(USDC);
    expect(codeRead.value?.length).toBeGreaterThan(10);
    const slot = await rpc.getStorageAt(USDC, IMPLEMENTATION_SLOT);
    expect(slot.value).toMatch(/^0x0{24}[0-9a-f]{40}$/);
    const eth = await rpc.getBalance(USDC_HOLDER);
    expect(eth.blockNumber).toBe(BigInt(forkBlockNumber()));
  });

  it('una respuesta divergente persistente es RPC_DISAGREEMENT y no devuelve valor', async () => {
    proxyB.setMode({ kind: 'diverge', methods: ['eth_call'] });
    const metrics = createMetrics({ defaultMetrics: false });
    const rpc = client(anvilA.url, proxyB.url, metrics);
    expect(
      await code(() =>
        rpc.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [USDC_HOLDER] }),
      ),
    ).toBe('RPC_DISAGREEMENT');
    const disagreements = await metrics.registry.getSingleMetricAsString('mtw_rpc_disagreements_total');
    expect(disagreements).toContain('method="eth_call:balanceOf"} 3');
    proxyB.setMode({ kind: 'pass' });
  });

  it('un proveedor que no responde es RPC_TIMEOUT; uno que falla es RPC_UNAVAILABLE', async () => {
    const metrics = createMetrics({ defaultMetrics: false });
    const rpc = client(anvilA.url, proxyB.url, metrics, 'dual', 1, SHORT_TIMEOUT);
    proxyB.setMode({ kind: 'timeout', methods: ['eth_getCode'] });
    expect(await code(() => rpc.getCode(USDC))).toBe('RPC_TIMEOUT');
    proxyB.setMode({ kind: 'http-error', status: 500 });
    expect(await code(() => rpc.getCode(USDC))).toBe('RPC_UNAVAILABLE');
    expect(await metrics.registry.getSingleMetricAsString('mtw_rpc_errors_total')).toContain('provider="secondary"');
    proxyB.setMode({ kind: 'pass' });
    expect(await code(() => rpc.getCode(USDC))).toBe('ok');
  });

  it('una divergencia transitoria se resuelve con el reintento', async () => {
    const rpc = client(anvilA.url, proxyB.url, createMetrics({ defaultMetrics: false }), 'dual', 3);
    proxyB.setMode({ kind: 'diverge', methods: ['eth_getStorageAt'] });
    setTimeout(() => {
      proxyB.setMode({ kind: 'pass' });
    }, 30);
    const slot = await rpc.getStorageAt(USDC, IMPLEMENTATION_SLOT);
    expect(slot.value).toMatch(/^0x0{24}[0-9a-f]{40}$/);
  });

  it('en local-single lee sólo el primario en su head', async () => {
    proxyB.setMode({ kind: 'diverge', methods: ['eth_call'] });
    const rpc = client(anvilA.url, proxyB.url, createMetrics({ defaultMetrics: false }), 'local-single');
    const head = BigInt(await anvilA.rpc<string>('eth_blockNumber'));
    const balance = await rpc.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [USDC_HOLDER],
    });
    expect(balance.blockNumber).toBe(head);
    expect(rpc.health().providers.map((p) => p.provider)).toEqual(['primary']);
    proxyB.setMode({ kind: 'pass' });
  });
});

describe('escrituras y receipts [B-RPC-03]', () => {
  const account = privateKeyToAccount(ANVIL_KEY);

  async function signedTransfer(nonce: number): Promise<Hex> {
    return account.signTransaction({
      chainId: 8453,
      type: 'eip1559',
      to: '0x000000000000000000000000000000000000dEaD',
      value: parseEther('0.001'),
      nonce,
      gas: 21_000n,
      maxFeePerGas: 50_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
  }

  it('transmite a ambos proveedores', async () => {
    const rpc = client(anvilA.url, anvilB.url, createMetrics({ defaultMetrics: false }));
    const nonce = Number(await anvilA.rpc<string>('eth_getTransactionCount', [account.address, 'latest']));
    const raw = await signedTransfer(nonce);
    const sent = await rpc.sendRawTransaction(raw);
    expect(sent.acceptedBy.sort()).toEqual(['primary', 'secondary']);
  });

  it('una transacción ya conocida por el proveedor cuenta como aceptada', async () => {
    await anvilA.rpc('evm_setAutomine', [false]);
    try {
      const rpc = client(anvilA.url, proxyA.url, createMetrics({ defaultMetrics: false }));
      const nonce = Number(await anvilA.rpc<string>('eth_getTransactionCount', [account.address, 'pending']));
      const raw = await signedTransfer(nonce);
      const first = await rpc.sendRawTransaction(raw);
      expect(first.acceptedBy.length).toBeGreaterThanOrEqual(1);
      const again = await rpc.sendRawTransaction(raw);
      expect(again.hash).toBe(first.hash);
      expect(again.acceptedBy.length).toBeGreaterThanOrEqual(1);
    } finally {
      await anvilA.rpc('evm_setAutomine', [true]);
      await anvilA.rpc('anvil_mine', ['0x1']);
    }
  });

  it('si ningún proveedor acepta, falla', async () => {
    proxyB.setMode({ kind: 'http-error', status: 500 });
    const rpc = client(proxyB.url, proxyB.url, createMetrics({ defaultMetrics: false }));
    expect(await code(() => rpc.sendRawTransaction(`0x02${'00'.repeat(10)}`))).toBe('RPC_UNAVAILABLE');
    proxyB.setMode({ kind: 'pass' });
  });

  it('receipt con quórum: coincide si ambos ven el mismo bloque y difiere si sólo uno lo conoce', async () => {
    const nonce = Number(await anvilA.rpc<string>('eth_getTransactionCount', [account.address, 'latest']));
    const hash = await anvilA.rpc<Hex>('eth_sendRawTransaction', [await signedTransfer(nonce)]);
    await anvilA.rpc('anvil_mine', ['0x1']);
    const same = client(anvilA.url, proxyA.url, createMetrics({ defaultMetrics: false }));
    const receipt = await same.getTransactionReceipt(hash);
    expect(receipt?.status).toBe('success');
    const split = client(anvilA.url, anvilB.url, createMetrics({ defaultMetrics: false }), 'dual', 1);
    expect(await code(() => split.getTransactionReceipt(hash))).toBe('RPC_DISAGREEMENT');
    expect(await same.getTransactionReceipt(`0x${'ab'.repeat(32)}`)).toBeNull();
  });
});
