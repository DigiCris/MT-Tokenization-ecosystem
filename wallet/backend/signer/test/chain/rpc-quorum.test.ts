// SignerRpc [B-RPC-04] en modo `dual` contra dos nodos reales con la misma historia: un Anvil con el sistema
// desplegado (estado del global setup) y un segundo Anvil que forkea al primero, con el proxy de inyección de fallas
// delante de cada uno (acuerdo, bloque común, head atrasado, desacuerdo, respuestas mal formadas, error HTTP,
// timeouts, reverts y simulación/estimación en ambos proveedores). También el modo `local-single`.
import { encodeFunctionData } from 'viem';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { policyRegistryAbi } from '../../src/chain/abis/index.ts';
import { CallRevertedError, RpcQuorumError, SignerRpc, type QuorumMode } from '../../src/chain/rpc.ts';
import type { Hex } from '../../src/crypto/bytes.ts';
import { checksumAddress, type Address } from '../../src/crypto/keccak.ts';
import { startAnvil, type AnvilInstance } from '../helpers/anvil.ts';
import { testAccount } from '../helpers/chain.ts';
import { startFaultProxy, type FaultProxy } from '../helpers/fault-proxy.ts';

const READ_TIMEOUT = 30_000;
const UNKNOWN_SELECTOR = '0xdeadbeef' as Hex;

let anvilA: AnvilInstance;
let anvilB: AnvilInstance;
let proxyA: FaultProxy;
let proxyB: FaultProxy;
/** Head de los dos nodos después de minar un bloque en cada uno (la historia común termina en `head - 1`). */
let head: bigint;
let registry: Address;
let admin: Address;
let devAccount: Address;
/**
 * Destino de la transferencia simulada: una dirección nueva, sin código (el admin de la policy es una Safe y las cuentas
 * por defecto de Anvil tienen delegaciones EIP-7702 en Base mainnet: recibir ETH ejecuta código y cuesta más gas).
 */
const recipient = testAccount().address;

function rpc(mode: QuorumMode = 'dual', timeoutMs = READ_TIMEOUT, retries = 2): SignerRpc {
  return new SignerRpc({ primaryUrl: proxyA.url, secondaryUrl: proxyB.url, mode, timeoutMs, retries, backoffMs: 10 });
}

async function problem(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'ok';
  } catch (error) {
    if (error instanceof RpcQuorumError) return error.problem;
    if (error instanceof CallRevertedError) return 'REVERTED';
    throw error;
  }
}

const adminCall = () => ({ to: registry, data: encodeFunctionData({ abi: policyRegistryAbi, functionName: 'ADMIN' }) });
const transfer = () => ({ from: devAccount, to: recipient, data: '0x' as Hex, value: 1n });

beforeAll(async () => {
  const chain = inject('chain');
  registry = checksumAddress(chain.system.contracts.PolicyRegistry as Address);
  admin = checksumAddress(chain.system.policy.admin);
  anvilA = await startAnvil({ loadState: chain.statePath });
  const forkPoint = BigInt(await anvilA.rpc<string>('eth_blockNumber'));
  anvilB = await startAnvil({ upstream: { url: anvilA.url, blockNumber: forkPoint } });
  await Promise.all([anvilA.rpc('anvil_mine', ['0x1']), anvilB.rpc('anvil_mine', ['0x1'])]);
  head = forkPoint + 1n;
  devAccount = checksumAddress((await anvilA.rpc<string[]>('eth_accounts'))[0] as Address);
  [proxyA, proxyB] = await Promise.all([startFaultProxy(anvilA.url), startFaultProxy(anvilB.url)]);
}, 180_000);

afterAll(async () => {
  for (const proxy of [proxyA, proxyB] as (FaultProxy | undefined)[]) await proxy?.close();
  for (const anvil of [anvilB, anvilA] as (AnvilInstance | undefined)[]) await anvil?.stop();
});

describe('modo dual con proveedores de acuerdo', () => {
  it('chainId, bloque común y lecturas a ese bloque iguales en los dos nodos', async () => {
    proxyB.setMode({ kind: 'pass' });
    const client = rpc();
    expect(client.mode).toBe('dual');
    expect(await client.chainId()).toBe(8453);

    const block = await client.snapshotBlock();
    expect(block).toBe(head - 1n);

    const header = await anvilA.rpc<{ timestamp: string }>('eth_getBlockByNumber', [`0x${block.toString(16)}`, false]);
    expect(await client.blockTimestamp(block)).toBe(Number(BigInt(header.timestamp)));

    const adminWord = await client.call(adminCall(), block);
    expect(checksumAddress(`0x${adminWord.slice(-40)}`)).toBe(admin);

    const slot0 = await client.storageAt(registry, `0x${'00'.repeat(32)}`, block);
    expect(slot0).toBe(
      await anvilA.rpc<string>('eth_getStorageAt', [registry, `0x${'00'.repeat(32)}`, `0x${block.toString(16)}`]),
    );

    const balance = await client.balance(admin, block);
    expect(balance).toBe(BigInt(await anvilA.rpc<string>('eth_getBalance', [admin, `0x${block.toString(16)}`])));

    const nonce = await client.transactionCount(admin, 'latest');
    expect(nonce).toBe(BigInt(await anvilA.rpc<string>('eth_getTransactionCount', [admin, 'latest'])));
  });

  it('bloque común = min(head) - 1 cuando un proveedor informa un head atrasado', async () => {
    proxyB.setMode({ kind: 'head-lag', lag: 2 });
    expect(await rpc().snapshotBlock()).toBe(head - 2n - 1n);
    proxyB.setMode({ kind: 'pass' });
  });

  it('simulación y estimación aceptadas por los dos (la estimación es el máximo)', async () => {
    proxyB.setMode({ kind: 'pass' });
    const client = rpc();
    expect(await client.simulate(transfer())).toBe('0x');
    expect(await client.estimateGas(transfer())).toBe(21_000n);
  });

  it('un bloque inexistente en los dos → RPC_UNAVAILABLE', async () => {
    proxyB.setMode({ kind: 'pass' });
    expect(await problem(() => rpc().blockTimestamp(head + 1_000n))).toBe('RPC_UNAVAILABLE');
  });
});

describe('modo dual con fallas en un proveedor', () => {
  it('resultado divergente → RPC_DISAGREEMENT (lecturas, eth_call y chainId)', async () => {
    const client = rpc();
    const block = head - 1n;
    proxyB.setMode({ kind: 'diverge', methods: ['eth_getStorageAt', 'eth_call', 'eth_chainId', 'eth_getBalance'] });
    expect(await problem(() => client.storageAt(registry, `0x${'00'.repeat(32)}`, block))).toBe('RPC_DISAGREEMENT');
    expect(await problem(() => client.call(adminCall(), block))).toBe('RPC_DISAGREEMENT');
    expect(await problem(() => client.chainId())).toBe('RPC_DISAGREEMENT');
    expect(await problem(() => client.balance(admin, block))).toBe('RPC_DISAGREEMENT');
    proxyB.setMode({ kind: 'pass' });
  });

  it('respuesta mal formada → RPC_UNAVAILABLE (no se compara ni se usa)', async () => {
    const client = rpc();
    proxyB.setMode({ kind: 'malformed', methods: ['eth_getStorageAt', 'eth_getTransactionCount'] });
    expect(await problem(() => client.storageAt(registry, `0x${'00'.repeat(32)}`, head - 1n))).toBe('RPC_UNAVAILABLE');
    expect(await problem(() => client.transactionCount(admin, 'latest'))).toBe('RPC_UNAVAILABLE');
    proxyB.setMode({ kind: 'pass' });
  });

  it('error HTTP con cuerpo no JSON → RPC_UNAVAILABLE en todas las operaciones', async () => {
    const client = rpc();
    proxyB.setMode({ kind: 'http-error', status: 503 });
    expect(await problem(() => client.snapshotBlock())).toBe('RPC_UNAVAILABLE');
    expect(await problem(() => client.balance(admin, head - 1n))).toBe('RPC_UNAVAILABLE');
    expect(await problem(() => client.call(adminCall(), head - 1n))).toBe('RPC_UNAVAILABLE');
    expect(await problem(() => client.simulate(transfer()))).toBe('RPC_UNAVAILABLE');
    expect(await problem(() => client.estimateGas(transfer()))).toBe('RPC_UNAVAILABLE');
    proxyB.setMode({ kind: 'pass' });
  });

  it('un proveedor que no responde → RPC_UNAVAILABLE al agotar el timeout', async () => {
    proxyB.setMode({ kind: 'timeout' });
    const started = Date.now();
    expect(await problem(() => rpc('dual', 400, 1).chainId())).toBe('RPC_UNAVAILABLE');
    expect(Date.now() - started).toBeGreaterThanOrEqual(800);
    proxyB.setMode({ kind: 'pass' });
  });

  it('revert en los dos → CallRevertedError en eth_call, simulación y estimación', async () => {
    proxyB.setMode({ kind: 'pass' });
    const client = rpc();
    const reverting = { to: registry, data: UNKNOWN_SELECTOR };
    expect(await problem(() => client.call(reverting, head - 1n))).toBe('REVERTED');
    expect(await problem(() => client.simulate({ ...reverting, from: devAccount }))).toBe('REVERTED');
    expect(await problem(() => client.estimateGas({ ...reverting, from: devAccount }))).toBe('REVERTED');
  });
});

describe('modo local-single', () => {
  it('lee sólo el primario en su head y falla con RPC_UNAVAILABLE si no responde', async () => {
    proxyB.setMode({ kind: 'http-error', status: 503 });
    const client = rpc('local-single');
    expect(client.mode).toBe('local-single');
    expect(await client.snapshotBlock()).toBe(head);
    expect(await client.chainId()).toBe(8453);

    proxyA.setMode({ kind: 'http-error', status: 502 });
    expect(await problem(() => client.snapshotBlock())).toBe('RPC_UNAVAILABLE');
    proxyA.setMode({ kind: 'pass' });
    proxyB.setMode({ kind: 'pass' });
  });
});
