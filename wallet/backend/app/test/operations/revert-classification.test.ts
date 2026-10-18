// Prechequeo de operaciones: sólo un revert de ejecución real es GUARD_WOULD_REVERT (422). viem envuelve toda falla de
// `eth_call` en CallExecutionError, también un error interno del nodo —p. ej. un fork que no logró traer estado del RPC
// remoto—; eso es una falla del RPC (se propaga y la reintenta el quórum), no un revert. Errores reales de viem contra un
// Anvil con el sistema desplegado, con el proxy de inyección de fallas delante.
import { createPublicClient, getAddress, http, type Address, type Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isExecutionRevert } from '../../src/operations/chain-context.ts';
import { deployedChain } from '../helpers/deploy.ts';
import { startFaultProxy, type FaultProxy } from '../helpers/fault-proxy.ts';
import { startAnvil, type AnvilInstance } from '../helpers/fork.ts';

let anvil: AnvilInstance;
let proxy: FaultProxy;
let registry: Address;

beforeAll(async () => {
  const chain = deployedChain();
  registry = getAddress(chain.system.contracts.PolicyRegistry ?? '');
  anvil = await startAnvil({ loadState: chain.statePath });
  proxy = await startFaultProxy(anvil.url);
}, 300_000);

afterAll(async () => {
  await proxy.close();
  await anvil.stop();
});

async function callError(data: Hex): Promise<unknown> {
  const client = createPublicClient({ transport: http(proxy.url, { retryCount: 0 }) });
  try {
    await client.call({ to: registry, data });
  } catch (error) {
    return error;
  }
  throw new Error('la llamada no falló');
}

describe('clasificación del prechequeo', () => {
  it('un revert real del contrato (selector inexistente) es revert de ejecución', async () => {
    proxy.setMode({ kind: 'pass' });
    expect(isExecutionRevert(await callError('0xdeadbeef'))).toBe(true);
  });

  it('un error interno del nodo envuelto en CallExecutionError no es revert', async () => {
    proxy.setMode({
      kind: 'rpc-error',
      methods: ['eth_call'],
      code: -32603,
      message: 'failed to get account for 0x4200000000000000000000000000000000000015: operation timed out',
    });
    const error = await callError('0x');
    expect((error as { name?: string }).name).toBe('CallExecutionError');
    expect(isExecutionRevert(error)).toBe(false);
  });

  it('el mensaje estándar de revert con código -32000 (otros nodos) sí es revert', async () => {
    proxy.setMode({ kind: 'rpc-error', methods: ['eth_call'], code: -32000, message: 'execution reverted' });
    expect(isExecutionRevert(await callError('0x'))).toBe(true);
    proxy.setMode({ kind: 'pass' });
  });
});
