// Lo que hace una SafeTx, decodificado de sus bytes para el review de R (P19): nunca de lo que diga el backend. Sólo las
// llamadas que puede firmar R (NoOp, baja de whitelist, revocación de permisos, rotaciones, migración) y las del modo
// soberano; cualquier otra cosa se marca como desconocida y no se firma.
import { decodeFunctionData, erc20Abi, formatUnits, getAddress, isAddressEqual, type Address } from 'viem';
import { destinationWhitelistAbi } from '../chain/abis/DestinationWhitelist.ts';
import { iSafeAbi } from '../chain/abis/ISafe.ts';
import { rotationTimelockAbi } from '../chain/abis/RotationTimelock.ts';
import { securityGuardAbi } from '../chain/abis/SecurityGuard.ts';
import { ROTATION_KINDS } from '../chain/rotations.ts';
import type { SafeTx } from '../chain/safe-tx.ts';
import type { PinnedChain } from '../config/chain.ts';
import type { SystemContracts } from '../config/system-contracts.ts';
import { groupedAddress } from '../ui/AddressText.tsx';

export interface DecodeContext {
  safe: Address;
  chain: Pick<PinnedChain, 'tokens'>;
  system: Pick<SystemContracts, 'contracts'>;
}

export interface DecodedCall {
  known: boolean;
  text: string;
}

const KIND_TEXT: Record<string, string> = {
  U: 'tu clave de usuario (U)',
  R: 'tu clave de recuperación (R)',
  S: 'la clave de la plataforma (S)',
  GUARD: 'el Guard de seguridad',
  MODULE_GUARD: 'el guard de módulos',
};

function amount(value: bigint): string {
  const [whole = '0', fraction = ''] = formatUnits(value, 6).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${fraction.padEnd(2, '0')}`;
}

const unknown = (reason: string): DecodedCall => ({
  known: false,
  text: `Operación que esta app no reconoce (${reason}): no se firma.`,
});

export function decodeSafeTx(tx: SafeTx, ctx: DecodeContext): DecodedCall {
  if (tx.operation !== 0 || tx.value !== 0n) return unknown('DELEGATECALL o con valor');
  const to = getAddress(tx.to);
  const contracts = ctx.system.contracts;
  try {
    if (isAddressEqual(to, ctx.safe)) {
      if (tx.data === '0x')
        return { known: true, text: `Cancelar la operación pendiente con nonce ${tx.nonce.toString()} (NoOp)` };
      const call = decodeFunctionData({ abi: iSafeAbi, data: tx.data });
      if (call.functionName === 'swapOwner') {
        const [, oldOwner, newOwner] = call.args;
        return {
          known: true,
          text: `Reemplazar en la Safe la clave ${groupedAddress(oldOwner)} por ${groupedAddress(newOwner)}`,
        };
      }
      if (call.functionName === 'setGuard' || call.functionName === 'setModuleGuard') {
        const [guard] = call.args;
        const what = call.functionName === 'setGuard' ? 'el Guard' : 'el guard de módulos';
        return {
          known: true,
          text: isAddressEqual(guard, '0x0000000000000000000000000000000000000000')
            ? `Retirar ${what} de la Safe`
            : `Cambiar ${what} de la Safe por ${groupedAddress(guard)}`,
        };
      }
      return unknown(call.functionName);
    }
    const token = Object.values(ctx.chain.tokens).find((t) => isAddressEqual(t.address, to));
    if (token) {
      const call = decodeFunctionData({ abi: erc20Abi, data: tx.data });
      if (call.functionName === 'transfer') {
        const [destination, value] = call.args;
        return { known: true, text: `Enviar ${amount(value)} ${token.symbol} a ${groupedAddress(destination)}` };
      }
      if (call.functionName === 'approve') {
        const [spender, value] = call.args;
        return value === 0n
          ? { known: true, text: `Revocar el permiso de ${groupedAddress(spender)} sobre ${token.symbol}` }
          : { known: true, text: `Permitir que ${groupedAddress(spender)} use ${amount(value)} ${token.symbol}` };
      }
      return unknown(call.functionName);
    }
    if (isAddressEqual(to, contracts.whitelist.address)) {
      const call = decodeFunctionData({ abi: destinationWhitelistAbi, data: tx.data });
      if (call.functionName === 'removeDestination') {
        return { known: true, text: `Quitar de tu whitelist el destino ${groupedAddress(call.args[0])}` };
      }
      return unknown(call.functionName);
    }
    if (isAddressEqual(to, contracts.timelock.address)) {
      const call = decodeFunctionData({ abi: rotationTimelockAbi, data: tx.data });
      if (call.functionName === 'propose') {
        const [kind, oldValue, newValue] = call.args;
        const role = ROTATION_KINDS[kind] ?? String(kind);
        return {
          known: true,
          text: `Proponer reemplazar ${KIND_TEXT[role] ?? role} ${groupedAddress(oldValue)} por ${groupedAddress(newValue)} (se puede ejecutar a las 48 h)`,
        };
      }
      return unknown(call.functionName);
    }
    if (isAddressEqual(to, contracts.guard.address)) {
      const call = decodeFunctionData({ abi: securityGuardAbi, data: tx.data });
      if (call.functionName === 'updateRoles') {
        const [userKey, recoveryKey, executor] = call.args;
        return {
          known: true,
          text: `Actualizar los roles del Guard: U ${groupedAddress(userKey)}, R ${groupedAddress(recoveryKey)}, S ${groupedAddress(executor)}`,
        };
      }
      return unknown(call.functionName);
    }
    return unknown('destino desconocido');
  } catch {
    return unknown('datos que no corresponden al contrato');
  }
}
