// P19: lo que muestra el review de R sale de los bytes de la SafeTx. Las operaciones que R puede firmar (NoOp, baja de
// whitelist, revocación y permisos, transferencias, propuestas y ejecuciones de rotación, guards y roles) se describen;
// lo demás (swap, alta de whitelist, cancelación por SafeTx, DELEGATECALL, valor, datos que no corresponden) no se firma.
import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import safeTxVectors from '../../test/vectors/safe-tx.json' with { type: 'json' };
import systemVector from '../../test/vectors/system.json' with { type: 'json' };
import { iSafeAbi } from '../chain/abis/ISafe.ts';
import { securityGuardAbi } from '../chain/abis/SecurityGuard.ts';
import { parseSafeTx, plainCall, type SafeTx } from '../chain/safe-tx.ts';
import { pinnedChain } from '../config/chain.ts';
import type { SystemContracts } from '../config/system-contracts.ts';
import { decodeSafeTx, type DecodeContext } from './decode.ts';

const safe = getAddress(safeTxVectors.safe);
const contracts = systemVector.contracts as Record<string, Address>;
const ctx: DecodeContext = {
  safe,
  chain: pinnedChain,
  system: {
    contracts: {
      whitelist: { address: contracts.destinationWhitelist },
      timelock: { address: contracts.rotationTimelock },
      guard: { address: contracts.securityGuard },
    },
  } as unknown as Pick<SystemContracts, 'contracts'>,
};

function fromVector(opType: string): SafeTx {
  const op = safeTxVectors.operations.find((o) => o.opType === opType);
  if (!op) throw new Error(`falta el vector ${opType}`);
  return parseSafeTx({
    to: op.to as Address,
    value: op.value,
    data: op.data as Hex,
    operation: op.operation as 0 | 1,
    safeTxGas: op.safeTxGas,
    baseGas: op.baseGas,
    gasPrice: op.gasPrice,
    gasToken: op.gasToken as Address,
    refundReceiver: op.refundReceiver as Address,
    nonce: String(op.nonce),
  });
}

describe('decodeSafeTx', () => {
  it.each([
    ['NOOP', /^Cancelar la operación pendiente con nonce 1 \(NoOp\)$/],
    ['TRANSFER', /^Enviar [\d.]+,\d+ USDC a 0x /],
    ['MIGRATION_TRANSFER', /^Enviar [\d.]+,\d+ USDC a 0x /],
    ['APPROVE', /^Permitir que 0x .+ use [\d.]+,\d+ USDC$/],
    ['APPROVE_REVOKE', /^Revocar el permiso de 0x .+ sobre USDC$/],
    ['WHITELIST_REMOVE', /^Quitar de tu whitelist el destino 0x /],
    [
      'ROTATION_PROPOSE',
      /^Proponer reemplazar la clave de la plataforma \(S\) 0x .+ por 0x .+ \(se puede ejecutar a las 48 h\)$/,
    ],
    ['ROTATION_EXECUTE', /^Reemplazar en la Safe la clave 0x .+ por 0x /],
    ['GUARD_UPGRADE', /^Cambiar el Guard de la Safe por 0x /],
  ])('%s se describe', (opType, text) => {
    const decoded = decodeSafeTx(fromVector(opType), ctx);
    expect(decoded.known).toBe(true);
    expect(decoded.text).toMatch(text);
  });

  it.each(['SWAP', 'WHITELIST_ADD', 'ROTATION_CANCEL'])('%s no la firma R', (opType) => {
    expect(decodeSafeTx(fromVector(opType), ctx).known).toBe(false);
  });

  it('retirar guards y actualizar roles del Guard', () => {
    const zero = '0x0000000000000000000000000000000000000000';
    const remove = plainCall(
      safe,
      encodeFunctionData({ abi: iSafeAbi, functionName: 'setModuleGuard', args: [zero] }),
      2n,
    );
    expect(decodeSafeTx(remove, ctx).text).toBe('Retirar el guard de módulos de la Safe');
    const roles = plainCall(
      contracts.securityGuard as Address,
      encodeFunctionData({ abi: securityGuardAbi, functionName: 'updateRoles', args: [safe, safe, safe] }),
      2n,
    );
    expect(decodeSafeTx(roles, ctx).text).toMatch(/^Actualizar los roles del Guard: U 0x .+, R 0x .+, S 0x /);
  });

  it('DELEGATECALL, con valor, otra función de la Safe, otro destino o datos rotos: no se firma', () => {
    const noop = fromVector('NOOP');
    expect(decodeSafeTx({ ...noop, operation: 1 }, ctx).known).toBe(false);
    expect(decodeSafeTx({ ...noop, value: 1n }, ctx).known).toBe(false);
    const approveHash = plainCall(
      safe,
      encodeFunctionData({ abi: iSafeAbi, functionName: 'approveHash', args: [`0x${'11'.repeat(32)}`] }),
      1n,
    );
    expect(decodeSafeTx(approveHash, ctx).text).toContain('approveHash');
    expect(decodeSafeTx(plainCall(contracts.walletFactory as Address, '0x', 1n), ctx).text).toContain(
      'destino desconocido',
    );
    expect(decodeSafeTx(plainCall(pinnedChain.tokens.USDT.address, '0x1234', 1n), ctx).text).toContain(
      'datos que no corresponden',
    );
  });
});
