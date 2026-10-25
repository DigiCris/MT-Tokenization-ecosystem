// Texto legible de una operación decodificada desde sus bytes (review de P18): qué hace, con montos en es-AR y las
// direcciones completas en grupos de 4 junto al nombre que conoce la app (operations/names.ts). Se arma en partes para
// que la pantalla destaque monto y token y muestre cada dirección en monoespaciada (CallDescription.tsx); en texto plano
// queda igual. Lo no reconocido no se firma. Ya ejecutada, la operación se cuenta en pasado. Los estados y sus motivos
// también tienen texto (P18.MAN): ningún código crudo del backend llega a la pantalla. Una clave o un contrato se
// nombran por su dirección («la dirección de tu clave de usuario (U)»): la dirección no es la clave.
import { isAddressEqual, zeroAddress, type Address } from 'viem';
import type { OperationState, OperationStatus, RotationRole } from '../api/wallet-api.ts';
import { formatAmount } from '../assets/amount.ts';
import type { ChainClock } from '../chain/ChainNow.tsx';
import type { DecodedCall } from '../chain/decoders.ts';
import { groupAddress } from '../ui/AddressText.tsx';
import type { NameOf } from './names.ts';
import { operationReasonText } from './reasons.ts';

/** Cada rol que se rota, con «tu» si es una clave del usuario (U y R) y con su artículo si no (S y los guards). */
export const ROLE_TEXT: Readonly<Record<RotationRole, string>> = {
  U: 'tu clave de usuario (U)',
  R: 'tu clave de recuperación (R)',
  S: 'la clave de la plataforma (S)',
  GUARD: 'el Guard de seguridad',
  MODULE_GUARD: 'el guard de módulos',
};

/** Un rol que esta versión de la app no conoce (llega del backend): un texto genérico, nunca el código. */
export const UNKNOWN_ROLE_TEXT = 'un rol de tu Safe que esta versión de la app no reconoce';

export function isRotationRole(value: unknown): value is RotationRole {
  return typeof value === 'string' && Object.hasOwn(ROLE_TEXT, value);
}

/** El rol en texto, con su artículo (el genérico si esta app no lo conoce). */
export function roleText(role: unknown): string {
  return isRotationRole(role) ? ROLE_TEXT[role] : UNKNOWN_ROLE_TEXT;
}

/** «de tu clave de usuario (U)», «de la clave de la plataforma (S)», «del Guard de seguridad». */
export function ofRole(role: unknown): string {
  const text = roleText(role);
  return text.startsWith('el ') ? `del ${text.slice('el '.length)}` : `de ${text}`;
}

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
  /** Hora del dispositivo ahora (ms): suma a la lectura de la cadena lo que pasó desde entonces. */
  nowMs?: number | undefined;
  /** false: sin el vencimiento (la operación ya terminó y el plazo dejó de importar). */
  showDeadline?: boolean;
  /** true: la operación ya se ejecutó y se cuenta en pasado. */
  done?: boolean;
}

/** "1,50 USDC": los tokens del camino asistido tienen 6 decimales. */
export function tokenAmount(units: bigint, token: string): string {
  return `${formatAmount(units, 6)} ${token}`;
}

/**
 * Margen para firmar un swap antes de su plazo: después de la firma, la plataforma todavía lo valida, lo co-firma y lo
 * envía (el permiso y el cambio, en orden), y el contrato rechaza el cambio si se ejecuta pasado el plazo.
 */
export const SWAP_SIGN_MARGIN_MS = 60_000;

/** Hora estimada de la cadena (ms) en el momento `nowMs` del dispositivo: la última lectura más lo que pasó desde ella. */
export function chainNowAt(clock: ChainClock, nowMs: number = clock.deviceMs): number {
  return clock.chainMs + Math.max(0, nowMs - clock.deviceMs);
}

/** Cuánto le falta (ms) a un plazo de la cadena; null sin la hora de la cadena. */
export function deadlineRemainingMs(
  deadlineSeconds: bigint,
  clock: ChainClock | null | undefined,
  nowMs?: number,
): number | null {
  if (!clock) return null;
  return Number(deadlineSeconds) * 1000 - chainNowAt(clock, nowMs);
}

/** El plazo más cercano de los swaps de una lista de operaciones (null si no hay swaps). */
export function swapDeadline(calls: readonly DecodedCall[]): bigint | null {
  let earliest: bigint | null = null;
  for (const call of calls) {
    if (call.kind === 'SWAP' && (earliest === null || call.deadline < earliest)) earliest = call.deadline;
  }
  return earliest;
}

/**
 * Vencimiento del swap: "vence en 10 min (10:34:35)" con la hora del dispositivo, o la de la cadena si no hay reloj.
 * En el último minuto ya no da tiempo a firmarlo (SWAP_SIGN_MARGIN_MS) y, vencido, hay que volver a cotizar.
 */
export function expiryText(deadlineSeconds: bigint, clock?: ChainClock | null, nowMs?: number): string {
  const deadlineMs = Number(deadlineSeconds) * 1000;
  if (!clock) return `vence el ${new Date(deadlineMs).toLocaleString('es-AR')} (hora de la cadena)`;
  const remaining = deadlineMs - chainNowAt(clock, nowMs);
  const at = new Date(clock.deviceMs + (deadlineMs - clock.chainMs)).toLocaleTimeString('es-AR');
  if (remaining <= 0) return `venció a las ${at}: volvé a cotizar`;
  if (remaining <= SWAP_SIGN_MARGIN_MS) return `vence a las ${at}: ya no da tiempo a firmarlo, volvé a cotizar`;
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
  const done = ctx.done === true;
  switch (call.kind) {
    case 'NOOP':
      return [
        text(
          done
            ? 'Operación vacía: anuló la operación pendiente que tenía el mismo número de orden en tu Safe'
            : 'Operación vacía: anula la operación pendiente que tiene el mismo número de orden en tu Safe',
        ),
      ];
    case 'TRANSFER':
      return [
        text(done ? 'Enviaste ' : 'Enviar '),
        amount(call.amount, call.token),
        text(' a '),
        party(call.recipient),
      ];
    case 'APPROVE':
      if (call.amount === 0n) {
        return [
          text(
            done
              ? `Revocaste el permiso sobre tus ${call.token} que tenía `
              : `Revocar el permiso sobre tus ${call.token} que tiene `,
          ),
          party(call.spender),
        ];
      }
      return [
        text(done ? 'Permitiste que ' : 'Permitir que '),
        party(call.spender),
        text(' use exactamente '),
        amount(call.amount, call.token),
        text(
          call.spenderIsSwapExecutor
            ? done
              ? ' de tu Safe, sólo para este swap'
              : ' de tu Safe, sólo para este swap (al ejecutarse el swap el permiso vuelve a 0)'
            : ' de tu Safe',
        ),
      ];
    case 'SWAP':
      if (done) {
        return [
          text('Cambiaste '),
          amount(call.amountIn, call.tokenIn),
          text(` por ${call.tokenOut} (como mínimo `),
          amount(call.minAmountOut, call.tokenOut),
          text('), que llegaron a tu Safe'),
        ];
      }
      return [
        text('Cambiar '),
        amount(call.amountIn, call.tokenIn),
        text(' por al menos '),
        amount(call.minAmountOut, call.tokenOut),
        text(
          ctx.showDeadline === false
            ? ', que llegan a tu Safe'
            : `, que llegan a tu Safe; ${expiryText(call.deadline, ctx.clock, ctx.nowMs)}`,
        ),
      ];
    case 'WHITELIST_ADD':
      return done
        ? [
            text('Agregaste a tu whitelist el destino '),
            party(call.destination),
            text(' (se activa 24 h después de incluirse en un bloque)'),
          ]
        : [text('Agregar a tu whitelist el destino '), party(call.destination), text(' (se activa 24 h después)')];
    case 'WHITELIST_REMOVE':
      return [
        text(done ? 'Quitaste de tu whitelist el destino ' : 'Quitar de tu whitelist el destino '),
        party(call.destination),
      ];
    case 'ROTATION_PROPOSE':
      return [
        text(`${done ? 'Propusiste' : 'Proponer'} reemplazar la dirección ${ofRole(call.role)} `),
        party(call.oldValue),
        text(' por '),
        party(call.newValue),
        text(' (se puede ejecutar a las 48 h y hasta entonces cancelar)'),
      ];
    case 'ROTATION_CANCEL':
      return [text(`${done ? 'Cancelaste' : 'Cancelar'} la propuesta de rotación ${call.proposalId}`)];
    case 'ROTATION_EXECUTE':
      return [
        text(
          done
            ? 'Se reemplazó en la Safe la dirección de la clave anterior '
            : 'Reemplazar en la Safe la dirección de la clave actual ',
        ),
        party(call.oldOwner),
        text(' por la de la clave nueva '),
        party(call.newOwner),
      ];
    case 'GUARD_UPGRADE': {
      const target = call.target === 'GUARD' ? 'el Guard de seguridad' : 'el guard de módulos';
      if (isAddressEqual(call.newGuard, zeroAddress)) {
        return [text(done ? `Se quitó ${target} de la Safe` : `Quitar ${target} de la Safe`)];
      }
      return [text(done ? `Se cambió ${target} a ` : `Cambiar ${target} a `), party(call.newGuard)];
    }
    case 'GUARD_ROLES_UPDATE':
      return [
        text(
          done
            ? 'Se registraron en el Guard las direcciones de las claves U '
            : 'Registrar en el Guard las direcciones de las claves U ',
        ),
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
  EXPIRED: 'Venció sin firmar',
};

/** Qué significa cada estado que el usuario puede ver en el review y en la actividad ([B-FIN-01], ADR-018). */
export const STATE_HELP: readonly { state: OperationState; text: string }[] = [
  { state: 'CREATED', text: 'la plataforma la armó y espera tu firma; si no la firmás en 15 minutos, vence.' },
  { state: 'USER_SIGNED', text: 'ya tiene tu firma; la plataforma la revisa antes de co-firmarla.' },
  { state: 'QUEUED', text: 'espera su turno: las operaciones de tu Safe se ejecutan en orden.' },
  { state: 'VALIDATING', text: 'la plataforma la revisa contra sus reglas y contra la red.' },
  { state: 'READY', text: 'ya se revisó; la plataforma la co-firma y la envía a la red.' },
  { state: 'SUBMITTED', text: 'ya está en la red de Base, esperando que la incluyan en un bloque.' },
  {
    state: 'MINED',
    text: 'la red de Base ya la ejecutó, pero en casos raros una reorganización de la red todavía podría revertirla (la plataforma la vuelve a enviar).',
  },
  { state: 'CONFIRMED', text: 'el bloque ya está asegurado por la red; suele tardar unos minutos.' },
  { state: 'FINALIZED', text: 'ya no puede revertirse; en Base tarda unos 20 minutos.' },
  {
    state: 'FAILED_RETRYABLE',
    text: 'hubo un problema transitorio (por ejemplo, de la red); la plataforma la vuelve a intentar sola.',
  },
  { state: 'FAILED_FINAL', text: 'no se ejecutó y no se va a reintentar; el motivo aparece al lado.' },
  {
    state: 'REORGED',
    text: 'una reorganización de la red sacó el bloque en el que estaba; la plataforma la vuelve a enviar.',
  },
  {
    state: 'CANCEL_REQUESTED',
    text: 'pediste cancelarla después de firmarla: se cancela cuando se ejecuta la operación vacía que ocupa su lugar.',
  },
  {
    state: 'CANCELLED',
    text: 'no se ejecutó: la cancelaste (antes de firmarla o con una operación vacía) o la plataforma la descartó.',
  },
  { state: 'EXPIRED', text: 'pasaron 15 minutos sin tu firma; no se ejecutó.' },
];

type StatusLike = Pick<OperationStatus, 'status' | 'failureReason' | 'lastErrorCode' | 'history'>;

/** Cancelada antes de que U la firmara (la cancelación sin firma o lo preparado que la plataforma descartó). */
function cancelledUnsigned(status: StatusLike): boolean {
  if (status.status !== 'CANCELLED') return false;
  if (status.failureReason === 'USER_CANCELLED') return true;
  return status.history.length > 0 && !status.history.some((entry) => entry.status === 'USER_SIGNED');
}

/** Un estado que esta versión de la app no conoce (llega del backend): un texto genérico, nunca el código. */
export const UNKNOWN_STATE_TEXT = 'Estado que esta versión de la app no reconoce';

/** El estado de una operación en texto, con el matiz que importa ("Cancelada antes de firmar"). */
export function stateLabel(status: StatusLike): string {
  if (cancelledUnsigned(status)) return 'Cancelada antes de firmar';
  return Object.hasOwn(STATE_TEXT, status.status) ? STATE_TEXT[status.status] : UNKNOWN_STATE_TEXT;
}

/** Estados en los que importa por qué: la operación no se ejecutó (o se está reintentando). */
const WITH_REASON: readonly OperationState[] = ['FAILED_FINAL', 'FAILED_RETRYABLE', 'CANCELLED', 'EXPIRED'];

/** El nombre del estado ya dice el motivo ("Venció sin firmar", "Cancelada antes de firmar"): no se repite. */
function saidByState(status: StatusLike, raw: string): boolean {
  return (
    (status.status === 'EXPIRED' && raw === 'NOT_SIGNED_IN_TIME') ||
    (raw === 'USER_CANCELLED' && cancelledUnsigned(status))
  );
}

/** El motivo de una operación fallida, cancelada o que se está reintentando, en texto (null si no hay o ya se dice). */
export function operationReason(status: StatusLike): string | null {
  if (!WITH_REASON.includes(status.status)) return null;
  const raw = (
    status.status === 'FAILED_RETRYABLE' ? status.lastErrorCode : (status.failureReason ?? status.lastErrorCode)
  )?.trim();
  if (raw === undefined || raw === '' || saidByState(status, raw)) return null;
  return operationReasonText(raw);
}
