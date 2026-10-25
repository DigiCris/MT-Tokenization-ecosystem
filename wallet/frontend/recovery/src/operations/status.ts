// Estados, tipos y motivos de las operaciones que informa el backend, en texto de esta app (revisión de seguridad de
// ADR-033: ningún texto del backend llega a la pantalla). Un estado o un tipo que esta versión no conoce va con un texto
// genérico; de un motivo que no conoce sólo se muestra el código interno —para consultarlo con soporte— si tiene la
// forma de un código, nunca texto libre (un backend comprometido podría meter ahí una dirección o una instrucción).
import type { OperationState, OperationType } from '../api/recovery-api.ts';

export const STATE_TEXT: Readonly<Record<OperationState, string>> = {
  CREATED: 'Esperando la firma de R',
  USER_SIGNED: 'Firmada',
  QUEUED: 'En cola',
  VALIDATING: 'Validando',
  READY: 'Lista para enviar',
  SUBMITTED: 'Enviada a Base',
  MINED: 'Minada',
  CONFIRMED: 'Confirmada',
  FINALIZED: 'Final',
  FAILED_RETRYABLE: 'Reintentando',
  FAILED_FINAL: 'Falló',
  REORGED: 'Reorganizada: se reenvía',
  CANCEL_REQUESTED: 'Cancelación pedida',
  CANCELLED: 'Cancelada',
  EXPIRED: 'Vencida',
};

/** Un estado que esta versión de la app no conoce: un texto genérico, nunca el código. */
export const UNKNOWN_STATE_TEXT = 'Estado que esta versión de la app no reconoce';

export function stateText(state: string): string {
  return Object.hasOwn(STATE_TEXT, state) ? STATE_TEXT[state as OperationState] : UNKNOWN_STATE_TEXT;
}

const OPERATION_TEXT: Readonly<Record<OperationType, string>> = {
  SEND: 'Envío',
  SWAP_APPROVE: 'Permiso exacto para el swap',
  SWAP: 'Swap',
  APPROVE_REVOKE: 'Revocación de permiso',
  WHITELIST_ADD: 'Alta en la whitelist',
  WHITELIST_REMOVE: 'Baja de la whitelist',
  ROTATION_PROPOSE: 'Propuesta de rotación',
  ROTATION_EXECUTE: 'Ejecución de rotación',
  NOOP_CANCEL: 'Cancelación',
  MIGRATION_TRANSFER: 'Migración',
  GUARD_UPGRADE: 'Actualización del Guard',
};

/** Un tipo de operación que esta versión de la app no conoce: un texto genérico, nunca el código. */
export const UNKNOWN_OPERATION_TEXT =
  'Operación que esta versión de la app no reconoce (abrí la app actualizada para ver el detalle)';

export function operationTypeText(type: string): string {
  return Object.hasOwn(OPERATION_TEXT, type) ? OPERATION_TEXT[type as OperationType] : UNKNOWN_OPERATION_TEXT;
}

/** Rechazos de la policy de la plataforma: el detalle de POLICY_REJECTED en el motivo de una operación. */
const POLICY_REASON_TEXT: Readonly<Record<string, string>> = {
  UNKNOWN_OPERATION: 'la plataforma no reconoce la operación',
  OPERATION_TYPE_MISMATCH: 'la operación no es del tipo con el que se preparó',
  OPERATION_NOT_ALLOWED: 'esa operación no está habilitada para tu wallet',
  DESTINATION_FORBIDDEN: 'el destino no está permitido',
  DESTINATION_NOT_WHITELISTED: 'el destino no está activo en tu whitelist',
  INSUFFICIENT_BALANCE: 'no hay saldo suficiente',
  ROTATION_INVALID: 'la rotación no es válida',
  ROTATION_NOT_EXECUTABLE: 'la rotación todavía no se puede ejecutar (falta que se cumpla el plazo de 48 h)',
  KEY_ACCEPTANCE_REQUIRED: 'falta la aceptación firmada de la clave nueva',
  ROTATION_TARGET_NOT_SIGNER_KEY: 'la clave nueva de la plataforma no es una de las que crea su servidor de firma',
  MIGRATION_PARTIAL: 'la migración tiene que transferir todo el saldo',
  GUARD_UPGRADE_INVALID: 'el cambio del Guard no es válido',
};

/** Motivos de las operaciones (`failureReason`): fallas definitivas, cancelaciones y reintentos agotados. */
const OPERATION_REASON_TEXT: Readonly<Record<string, string>> = {
  POLICY_REJECTED: 'no cumple las reglas de la plataforma',
  WHITELIST_INACTIVE: 'el destino no está activo en tu whitelist',
  INSUFFICIENT_BALANCE: 'no había saldo suficiente',
  NONCE_CONSUMED: 'otra operación ya usó su número de orden en tu Safe',
  SESSION_INVALID: 'la verificación de Recovery se cerró o venció antes de que la plataforma la enviara',
  SIGNATURE_STALE: 'tu firma tiene más de 24 h',
  INTEGRITY_MISMATCH: 'lo firmado no coincide con lo que se preparó',
  OWNER_SIGNATURE_INVALID: 'la firma no es válida',
  OWNER_NOT_ROLE: 'la firma no es de tu clave R vigente',
  SAFE_CONFIG_MODIFIED: 'la configuración de tu Safe cambió fuera de la plataforma',
  GUARD_WOULD_REVERT: 'el Guard de seguridad de tu Safe la rechazaría en la red',
  KEY_NOT_FOUND: 'la clave de la plataforma (S) no coincide con la registrada',
  RETRIES_EXHAUSTED: 'no se pudo enviar después de varios intentos',
  CANCEL_TOO_LATE: 'la operación original se ejecutó antes que su cancelación',
  SUPERSEDED_BY_NOOP: 'la reemplazó la operación vacía que se firmó para anularla',
  NOT_SIGNED_IN_TIME: 'pasaron 15 minutos sin tu firma',
  USER_CANCELLED: 'se canceló antes de que se enviara a la red',
  POLICY_VERSION_MISMATCH: 'cambiaron las reglas de la plataforma mientras se procesaba',
  STATIC_RULE_VIOLATION: 'el servidor de firma de la plataforma la rechazó por sus reglas fijas',
  SAFE_NOT_REGISTERED: 'el servidor de firma de la plataforma no tiene registrada tu Safe',
  SAFE_NONCE_CONFLICT: 'otra operación ocupa su número de orden en tu Safe',
  SIMULATION_REVERTED: 'la simulación en la red falló',
  REVERTED: 'revirtió al ejecutarse en la red',
  // Problemas transitorios: la plataforma vuelve a intentar sola (aparecen como el último de un reintento agotado).
  NONCE_NOT_REACHED: 'espera que se ejecute una operación anterior de tu Safe',
  FEE_CAP_EXCEEDED: 'el costo de la red está por encima del máximo que paga la plataforma',
  SIGNER_UNAVAILABLE: 'el servidor de firma de la plataforma no responde',
  SIGNER_BAD_RESPONSE: 'el servidor de firma de la plataforma respondió con un error',
  SIGNER_RESPONSE_MISMATCH: 'la respuesta del servidor de firma no coincidió con lo pedido',
  COOPERATION_PAUSED: 'la plataforma pausó la co-firma por precaución',
  INTEGRITY_UNREACHABLE: 'la plataforma no pudo comprobar la integridad de las apps',
  INSUFFICIENT_GAS_FUNDS: 'la plataforma no tiene fondos para el gas en este momento',
  PLATFORM_TX_REJECTED: 'la red rechazó la transacción de la plataforma',
  TX_DROPPED: 'la red descartó la transacción',
  RPC_TIMEOUT: 'la conexión con la red no respondió a tiempo',
  RPC_UNAVAILABLE: 'la conexión con la red no está disponible',
};

const CODE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Un código interno que se puede mostrar para consultarlo con soporte: sólo un identificador corto (mayúsculas, dígitos
 * y `_`, hasta 32 caracteres). Cualquier otra cosa es texto libre del backend y no llega a la pantalla.
 */
export function internalCode(raw: string): string | null {
  const code = raw.trim();
  return /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : null;
}

function known(table: Readonly<Record<string, string>>, code: string): string {
  if (Object.hasOwn(table, code)) return table[code] ?? '';
  const shown = internalCode(code);
  return shown === null ? 'un motivo que esta versión de la app no reconoce' : `código interno ${shown}`;
}

/**
 * El motivo de una operación (`failureReason` como lo guarda el backend: `CÓDIGO`, `CÓDIGO: detalle` o
 * `REVERTED:motivo`) en texto, sin el detalle. Un rechazo de la policy dice además qué regla, y un reintento agotado,
 * el último problema.
 */
export function operationReasonText(raw: string): string {
  const match = /^([A-Z][A-Z0-9_]*)(?::\s*([\s\S]*))?$/.exec(raw.trim());
  if (!match?.[1]) return known({}, raw);
  const [, code, detail = ''] = match;
  const inner = CODE.test(detail) ? detail : null;
  if (code === 'POLICY_REJECTED' && inner !== null) {
    return `${known(OPERATION_REASON_TEXT, code)}: ${known(POLICY_REASON_TEXT, inner)}`;
  }
  if (code === 'RETRIES_EXHAUSTED' && inner !== null) {
    return `${known(OPERATION_REASON_TEXT, code)} (el último problema: ${known(OPERATION_REASON_TEXT, inner)})`;
  }
  return known(OPERATION_REASON_TEXT, code);
}
