// Texto legible de una operación decodificada desde sus bytes (review de P18): qué hace, con montos en es-AR y las
// direcciones completas en grupos de 4. Lo no reconocido no se firma.
import { isAddressEqual, zeroAddress } from 'viem';
import type { OperationState } from '../api/wallet-api.ts';
import { formatAmount } from '../assets/amount.ts';
import type { DecodedCall } from '../chain/decoders.ts';
import { groupAddress } from '../ui/AddressText.tsx';

const ROLE_TEXT: Record<string, string> = {
  U: 'tu clave de usuario (U)',
  R: 'tu clave de recuperación (R)',
  S: 'la clave de la plataforma (S)',
  GUARD: 'el Guard de seguridad',
  MODULE_GUARD: 'el guard de módulos',
};

export function describeCall(call: DecodedCall): string {
  switch (call.kind) {
    case 'NOOP':
      return 'Operación vacía (reemplaza a la operación pendiente con el mismo nonce)';
    case 'TRANSFER':
      return `Enviar ${formatAmount(call.amount, 6)} ${call.token} a ${groupAddress(call.recipient)}`;
    case 'APPROVE':
      return call.amount === 0n
        ? `Revocar el permiso sobre ${call.token} a ${groupAddress(call.spender)}`
        : `Permitir que ${groupAddress(call.spender)} use exactamente ${formatAmount(call.amount, 6)} ${call.token}`;
    case 'SWAP':
      return (
        `Cambiar ${formatAmount(call.amountIn, 6)} ${call.tokenIn} por al menos ${formatAmount(call.minAmountOut, 6)} ` +
        `${call.tokenOut} (vence ${new Date(Number(call.deadline) * 1000).toLocaleTimeString('es-AR')})`
      );
    case 'WHITELIST_ADD':
      return `Agregar a tu whitelist el destino ${groupAddress(call.destination)} (se activa 24 h después)`;
    case 'WHITELIST_REMOVE':
      return `Quitar de tu whitelist el destino ${groupAddress(call.destination)}`;
    case 'ROTATION_PROPOSE':
      return (
        `Proponer reemplazar ${ROLE_TEXT[call.role] ?? call.role} ${groupAddress(call.oldValue)} por ` +
        `${groupAddress(call.newValue)} (se puede ejecutar a las 48 h y hasta entonces cancelar)`
      );
    case 'ROTATION_CANCEL':
      return `Cancelar la propuesta de rotación ${call.proposalId}`;
    case 'ROTATION_EXECUTE':
      return `Reemplazar en la Safe la clave ${groupAddress(call.oldOwner)} por ${groupAddress(call.newOwner)}`;
    case 'GUARD_UPGRADE':
      return isAddressEqual(call.newGuard, zeroAddress)
        ? `Quitar ${call.target === 'GUARD' ? 'el Guard de seguridad' : 'el guard de módulos'} de la Safe`
        : `Cambiar ${call.target === 'GUARD' ? 'el Guard de seguridad' : 'el guard de módulos'} a ${groupAddress(call.newGuard)}`;
    case 'GUARD_ROLES_UPDATE':
      return `Registrar en el Guard las claves U ${groupAddress(call.userKey)}, R ${groupAddress(call.recoveryKey)} y S ${groupAddress(call.executor)}`;
    case 'UNKNOWN':
      return `Operación no reconocida (${call.reason}): no se firma`;
  }
}

export const STATE_TEXT: Record<OperationState, string> = {
  CREATED: 'Preparada',
  USER_SIGNED: 'Firmada por vos',
  QUEUED: 'En cola',
  VALIDATING: 'Validando',
  READY: 'Lista para enviar',
  SUBMITTED: 'Enviada a la red',
  MINED: 'Incluida en un bloque',
  CONFIRMED: 'Confirmada',
  FINALIZED: 'Final',
  FAILED_RETRYABLE: 'Reintentando',
  FAILED_FINAL: 'Falló',
  REORGED: 'Revirtió por reorganización: se reintenta',
  CANCEL_REQUESTED: 'Cancelación pedida',
  CANCELLED: 'Cancelada',
  EXPIRED: 'Venció',
};
