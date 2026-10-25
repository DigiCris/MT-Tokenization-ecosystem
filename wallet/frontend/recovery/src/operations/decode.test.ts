// P19: lo que muestra el review de R sale de los bytes de la SafeTx. Las operaciones que R puede firmar (NoOp, baja de
// whitelist, revocación y permisos, transferencias, propuestas y ejecuciones de rotación, guards y roles) se describen;
// lo demás (swap, alta de whitelist, cancelación por SafeTx, DELEGATECALL, valor, datos que no corresponden, un tipo de
// rotación que esta app no conoce) no se firma. Una clave o un contrato se nombran por su dirección (tercera revisión
// independiente): «la dirección de tu clave de usuario (U)», «la dirección del Guard de seguridad».
import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import safeTxVectors from '../../test/vectors/safe-tx.json' with { type: 'json' };
import systemVector from '../../test/vectors/system.json' with { type: 'json' };
import { iSafeAbi } from '../chain/abis/ISafe.ts';
import { rotationTimelockAbi } from '../chain/abis/RotationTimelock.ts';
import { securityGuardAbi } from '../chain/abis/SecurityGuard.ts';
import { proposeCall } from '../chain/rotations.ts';
import { parseSafeTx, plainCall, type SafeTx } from '../chain/safe-tx.ts';
import { groupedAddress } from '../ui/AddressText.tsx';
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
      /^Proponer reemplazar la dirección de la clave de la plataforma \(S\) 0x .+ por 0x .+ \(se puede ejecutar a las 48 h\)$/,
    ],
    ['ROTATION_EXECUTE', /^Reemplazar en la Safe la dirección de la clave actual 0x .+ por la de la clave nueva 0x /],
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
    expect(decodeSafeTx(roles, ctx).text).toMatch(
      /^Registrar en el Guard las direcciones de las claves U 0x .+, R 0x .+ y S 0x /,
    );
  });

  it('cada rol con su artículo: «tu» sólo para las claves del usuario; un tipo de rotación desconocido no se firma', () => {
    const timelock = contracts.rotationTimelock as Address;
    const other = getAddress('0x00000000000000000000000000000000000000b2');
    expect(decodeSafeTx(proposeCall(timelock, 'U', safe, other, 3n), ctx).text).toBe(
      `Proponer reemplazar la dirección de tu clave de usuario (U) ${groupedAddress(safe)} por ${groupedAddress(other)} (se puede ejecutar a las 48 h)`,
    );
    expect(decodeSafeTx(proposeCall(timelock, 'GUARD', safe, other, 3n), ctx).text).toMatch(
      /^Proponer reemplazar la dirección del Guard de seguridad 0x /,
    );
    expect(decodeSafeTx(proposeCall(timelock, 'MODULE_GUARD', safe, other, 3n), ctx).text).toMatch(
      /^Proponer reemplazar la dirección del guard de módulos 0x /,
    );
    const unknownKind = plainCall(
      timelock,
      encodeFunctionData({ abi: rotationTimelockAbi, functionName: 'propose', args: [7, safe, other] }),
      3n,
    );
    const decoded = decodeSafeTx(unknownKind, ctx);
    expect(decoded.known).toBe(false);
    expect(decoded.text).toBe('Operación que esta app no reconoce (tipo de rotación desconocido): no se firma.');
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
