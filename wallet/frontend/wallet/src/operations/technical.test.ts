// P18.MAN: los detalles técnicos del review salen de los bytes de la SafeTx con los ABIs fijados (contrato, valor, tipo
// de llamada, función con sus argumentos y número de orden); la operación vacía y un contrato que la app no conoce no
// muestran una función inventada.
import { getAddress, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import safeTxVectors from '../../test/vectors/safe-tx.json';
import systemVector from '../../test/vectors/system.json';
import type { SafeTxJson } from '../api/wallet-api.ts';
import { assistedCall, parseSafeTx } from '../chain/safe-tx.ts';
import { pinnedChain } from '../config/chain.ts';
import type { SystemContracts } from '../config/system-contracts.ts';
import { technicalCall } from './technical.ts';

interface VectorOperation extends Omit<SafeTxJson, 'nonce'> {
  opType: string;
  nonce: number;
}

const vectors = safeTxVectors as unknown as { safe: Address; operations: VectorOperation[] };
const system = systemVector as unknown as { contracts: Record<string, Address> };
const contract = (name: string) => ({ name, address: system.contracts[name] ?? '0x', codehash: '0x' as const });
const ctx = {
  safe: vectors.safe,
  chain: pinnedChain,
  system: {
    contracts: {
      guard: contract('securityGuard'),
      timelock: contract('rotationTimelock'),
      policyRegistry: contract('policyRegistry'),
      whitelist: contract('destinationWhitelist'),
      swapExecutor: contract('swapExecutor'),
      bootstrap: contract('safeBootstrap'),
      factory: contract('walletFactory'),
      moduleGuard: contract('denyAllModuleGuard'),
    },
  } as unknown as Pick<SystemContracts, 'contracts'>,
};

function vector(opType: string) {
  const op = vectors.operations.find((o) => o.opType === opType);
  if (!op) throw new Error(opType);
  return { op, tx: parseSafeTx({ ...op, nonce: String(op.nonce) }) };
}

describe('detalles técnicos de una SafeTx', () => {
  it('transfer: contrato del token, sin ETH, CALL, función con sus argumentos y número de orden', () => {
    const { op, tx } = vector('TRANSFER');
    const call = technicalCall(tx, ctx);
    expect(call.to).toBe(op.to);
    expect(call.value).toBe(0n);
    expect(call.operation).toBe(0);
    expect(call.nonce).toBe(BigInt(op.nonce));
    expect(call.signature).toMatch(/^transfer\(address \w+, uint256 \w+\)$/);
    expect(call.args.map((a) => a.value)).toEqual([
      getAddress(`0x${op.data.slice(34, 74)}`),
      BigInt(`0x${op.data.slice(74)}`).toString(),
    ]);
  });

  it('swap y alta en la whitelist: la función de cada contrato del sistema', () => {
    expect(technicalCall(vector('SWAP').tx, ctx).signature).toMatch(
      /^swap\(address \w+, uint256 \w+, uint256 \w+, uint256 \w+\)$/,
    );
    expect(technicalCall(vector('WHITELIST_ADD').tx, ctx).signature).toMatch(/^addDestination\(address \w+\)$/);
  });

  it('la operación vacía no tiene función; un contrato desconocido tampoco', () => {
    expect(technicalCall(vector('NOOP').tx, ctx)).toMatchObject({ signature: null, args: [], data: '0x' });
    const other: Address = '0x00000000000000000000000000000000000000c3';
    const unknown = technicalCall(assistedCall(other, '0x12345678', 1n), ctx);
    expect(unknown).toMatchObject({ signature: null, args: [] });
  });
});
