// Texto legible de una operación decodificada desde sus bytes (review de P18): qué hace, con montos en es-AR y las
// direcciones completas en grupos de 4 junto al nombre que conoce la app (operations/names.ts). Se arma en partes para
// que la pantalla destaque monto y token y muestre cada dirección en monoespaciada (CallDescription.tsx); en texto plano
// queda igual. Lo no reconocido no se firma.
import { isAddressEqual, zeroAddress, type Address } from 'viem';
import type { OperationState } from '../api/wallet-api.ts';
import { formatAmount } from '../assets/amount.ts';
import type { ChainClock } from '../chain/ChainNow.tsx';
import type { DecodedCall } from '../chain/decoders.ts';
import { groupAddress } from '../ui/AddressText.tsx';
import type { NameOf } from './names.ts';

export const ROLE_TEXT: Record<string, string> = {
  U: 'tu clave de usuario (U)',
  R: 'tu clave de recuperación (R)',
  S: 'la clave de la plataforma (S)',
  GUARD: 'el Guard de seguridad',
  MODULE_GUARD: 'el guard de módulos',
};

export type DescriptionPart =
  | { kind: 'text'; text: string }
  /** Monto con su token, destacado. */
  | { kind: 'amount'; text: string }
  /** Dirección completa con el nombre que le conoce la app (si tiene). */
  | { kind: 'address'; address: Address; name: string | null };

export type { ChainClock };

export interface DescribeContext {
  nameOf?: NameOf;
  /**
   * Para vencimientos que decide la cadena (deadline del swap): cuánto falta se mide con la hora de la cadena y la hora
   * en que vence se muestra en el reloj del dispositivo (en el fork la cadena puede ir adelantada).
   */
  clock?: ChainClock | null;
  /** false: sin el vencimiento (la operación ya terminó y el plazo dejó de importar). */
  showDeadline?: boolean;
}

/** "1,50 USDC": los tokens del camino asistido tienen 6 decimales. */
export function tokenAmount(units: bigint, token: string): string {
  return `${formatAmount(units, 6)} ${token}`;
}

/** Vencimiento del swap: "vence en 10 min (10:34:35)" con la hora del dispositivo, o la de la cadena si no hay reloj. */
export function expiryText(deadlineSeconds: bigint, clock?: ChainClock | null): string {
  const deadlineMs = Number(deadlineSeconds) * 1000;
  if (!clock) return `vence el ${new Date(deadlineMs).toLocaleString('es-AR')} (hora de la cadena)`;
  const remaining = deadlineMs - clock.chainMs;
  const at = new Date(clock.deviceMs + remaining).toLocaleTimeString('es-AR');
  if (remaining <= 0) return `venció a las ${at}: volvé a cotizar`;
  return `vence en ${String(Math.ceil(remaining / 60_000))} min (${at})`;
}

export function describeParts(call: DecodedCall, ctx: DescribeContext = {}): DescriptionPart[] {
  const text = (value: string): DescriptionPart => ({ kind: 'text', text: value });
  const amount = (units: bigint, token: string): DescriptionPart => ({
    kind: 'amount',
    text: tokenAmount(units, token),
  });
  const party = (address: Address): DescriptionPart => ({
    kind: 'address',
    address,
    name: ctx.nameOf?.(address) ?? null,
  });
  switch (call.kind) {
    case 'NOOP':
      return [text('Operación vacía: anula la operación pendiente que tiene el mismo número de orden en tu Safe')];
    case 'TRANSFER':
      return [text('Enviar '), amount(call.amount, call.token), text(' a '), party(call.recipient)];
    case 'APPROVE':
      if (call.amount === 0n)
        return [text(`Revocar el permiso sobre tus ${call.token} que tiene `), party(call.spender)];
      return [
        text('Permitir que '),
        party(call.spender),
        text(' use exactamente '),
        amount(call.amount, call.token),
        text(
          call.spenderIsSwapExecutor
            ? ' de tu Safe, sólo para este swap (al ejecutarse el swap el permiso vuelve a 0)'
            : ' de tu Safe',
        ),
      ];
    case 'SWAP':
      return [
        text('Cambiar '),
        amount(call.amountIn, call.tokenIn),
        text(' por al menos '),
        amount(call.minAmountOut, call.tokenOut),
        text(
          ctx.showDeadline === false
            ? ', que llegan a tu Safe'
            : `, que llegan a tu Safe; ${expiryText(call.deadline, ctx.clock)}`,
        ),
      ];
    case 'WHITELIST_ADD':
      return [text('Agregar a tu whitelist el destino '), party(call.destination), text(' (se activa 24 h después)')];
    case 'WHITELIST_REMOVE':
      return [text('Quitar de tu whitelist el destino '), party(call.destination)];
    case 'ROTATION_PROPOSE':
      return [
        text(`Proponer reemplazar ${ROLE_TEXT[call.role] ?? call.role} `),
        party(call.oldValue),
        text(' por '),
        party(call.newValue),
        text(' (se puede ejecutar a las 48 h y hasta entonces cancelar)'),
      ];
    case 'ROTATION_CANCEL':
      return [text(`Cancelar la propuesta de rotación ${call.proposalId}`)];
    case 'ROTATION_EXECUTE':
      return [text('Reemplazar en la Safe la clave '), party(call.oldOwner), text(' por '), party(call.newOwner)];
    case 'GUARD_UPGRADE': {
      const target = call.target === 'GUARD' ? 'el Guard de seguridad' : 'el guard de módulos';
      return isAddressEqual(call.newGuard, zeroAddress)
        ? [text(`Quitar ${target} de la Safe`)]
        : [text(`Cambiar ${target} a `), party(call.newGuard)];
    }
    case 'GUARD_ROLES_UPDATE':
      return [
        text('Registrar en el Guard las claves U '),
        party(call.userKey),
        text(', R '),
        party(call.recoveryKey),
        text(' y S '),
        party(call.executor),
      ];
    case 'UNKNOWN':
      return [text(`Operación no reconocida (${call.reason}): no se firma`)];
  }
}

/** Las partes en texto plano: la dirección agrupada, con su nombre adelante si lo tiene. */
export function partsText(parts: readonly DescriptionPart[]): string {
  return parts
    .map((part) => {
      if (part.kind !== 'address') return part.text;
      const grouped = groupAddress(part.address);
      return part.name === null ? grouped : `${part.name} (${grouped})`;
    })
    .join('');
}

export function describeCall(call: DecodedCall, ctx: DescribeContext = {}): string {
  return partsText(describeParts(call, ctx));
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

/** Ayuda breve de los estados de una operación que ya está en la cadena ([B-FIN-01], ADR-018). */
export const SETTLEMENT_HELP: readonly { state: OperationState; text: string }[] = [
  {
    state: 'MINED',
    text: 'la red de Base ya la ejecutó, pero en casos raros una reorganización de la red todavía podría revertirla (la plataforma la vuelve a enviar).',
  },
  { state: 'CONFIRMED', text: 'el bloque ya está asegurado por la red; suele tardar unos minutos.' },
  { state: 'FINALIZED', text: 'ya no puede revertirse; en Base tarda unos 20 minutos.' },
];
