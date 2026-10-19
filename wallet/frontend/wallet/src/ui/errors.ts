// Mensajes para el usuario a partir de los errores de la app, con las indicaciones de qué hacer en los casos que lo
// necesitan; los códigos que el backend manda en el detalle (rechazos de la policy, problemas del destino, estados) se
// traducen: ningún código crudo llega a la pantalla.
//
// Regla (revisión de seguridad de ADR-033, MEDIO 2): ningún texto del backend llega a la pantalla. Un backend
// comprometido (ESC-20) controla `title`, `detail` y `requestId` de sus errores: con texto libre podría mostrar una
// dirección para que el usuario la copie en la comparación de R, o una instrucción al lado de lo que firma o confirma.
// Así que acá sólo salen textos de esta app: elegidos por `code` (o por `status`, si el código no está en el catálogo
// local); un código que viene en el detalle se traduce con una tabla cerrada y, si no está en la tabla, se usa el texto
// genérico de su código. Vale para todas las pantallas (todas usan describeError, también useAsyncAction).
import { ApiError, NetworkError } from '../api/problem.ts';
import type { OperationState } from '../api/wallet-api.ts';
import { BackupWordsError } from '../crypto/backup-words.ts';
import { EnvelopeError } from '../crypto/envelope.ts';
import { DriveError } from '../drive/client.ts';
import { DriveConnectError } from '../drive/oauth.ts';
import { STATE_TEXT } from '../operations/describe.ts';
import { knownDestinationProblem, knownPolicyReason } from '../operations/reasons.ts';

/** Texto local de cada código del catálogo de errores del backend ([B-API]). */
const CATALOG_TEXT: Readonly<Record<string, string>> = {
  BAD_REQUEST: 'Algún dato del pedido no es válido: revisalo y reintentá.',
  VALIDATION_FAILED: 'Algún dato del pedido no es válido: revisalo y reintentá.',
  IDEMPOTENCY_KEY_REQUIRED: 'La app no pudo enviar el pedido: recargá la pantalla y reintentá.',
  IDEMPOTENCY_KEY_INVALID: 'La app no pudo enviar el pedido: recargá la pantalla y reintentá.',
  INVALID_CODE: 'El código no es correcto o venció. Pedí uno nuevo si hace falta.',
  INVALID_TOKEN: 'El enlace no es válido o venció. Pedí uno nuevo.',
  UNAUTHENTICATED: 'Tu sesión de cuenta terminó: iniciá sesión de nuevo.',
  INVALID_CREDENTIALS: 'Email o contraseña de cuenta incorrectos.',
  TOTP_REQUIRED: 'Ingresá el código de tu app de autenticación (o un código de recuperación).',
  INVALID_TOTP: 'El código de verificación en dos pasos no es correcto.',
  FORBIDDEN: 'La plataforma no permite esta acción.',
  ORIGIN_NOT_ALLOWED: 'La plataforma rechazó el pedido desde esta app: recargá la página.',
  CSRF_ORIGIN_REQUIRED: 'La plataforma rechazó el pedido desde esta app: recargá la página.',
  CSRF_TOKEN_INVALID: 'La sesión de la app se desincronizó: recargá la página y reintentá.',
  EMAIL_NOT_VERIFIED: 'Todavía no verificaste tu email: ingresá el código que te mandamos.',
  ACCOUNT_LOCKED: 'Tu cuenta quedó bloqueada por intentos fallidos. Pedí un código de desbloqueo por email.',
  ACCOUNT_DISABLED: 'Tu cuenta está deshabilitada: contactá a soporte.',
  REAUTH_FAILED: 'No se pudo confirmar tu identidad: revisá lo que ingresaste y reintentá.',
  SECOND_FACTOR_REQUIRED: 'Falta el código de verificación en dos pasos.',
  PLATFORM_SESSION_REQUIRED: 'Desbloqueá la wallet para continuar.',
  PLATFORM_SESSION_INVALID: 'La sesión de la wallet venció o se cerró: desbloqueala de nuevo.',
  SCOPE_NOT_ALLOWED: 'La sesión de la wallet no permite esta acción: desbloqueala de nuevo.',
  REQUEST_SIGNATURE_INVALID: 'La app no pudo firmar el pedido: desbloqueá la wallet de nuevo y reintentá.',
  REQUEST_EXPIRED: 'El pedido firmado llegó fuera de tiempo: revisá la fecha y hora de tu dispositivo.',
  REQUEST_REPLAYED: 'Ese pedido ya se había enviado: reintentá.',
  NOT_FOUND: 'No se encontró lo que pediste: recargá la pantalla.',
  IDEMPOTENCY_IN_PROGRESS: 'Ya hay un pedido igual en curso: esperá unos segundos.',
  CONFLICT: 'La plataforma no puede hacer esto en el estado actual: recargá la pantalla y reintentá.',
  WALLET_NOT_ACTIVE: 'La wallet todavía no está activa.',
  ENROLLMENT_EXPIRED: 'El pedido a la app Recovery venció: generá uno nuevo.',
  OPERATION_NOT_PENDING: 'La operación ya no admite esta acción: revisá su estado en Actividad.',
  OPERATION_EXPIRED: 'La operación venció sin tu firma (15 minutos): preparala de nuevo.',
  OPERATION_BUSY: 'La plataforma está revisando la operación: reintentá en unos segundos.',
  NONCE_CONFLICT:
    'Otra operación ocupa el mismo número de orden en tu Safe: esperá a que termine (o cancelala) y prepará esta de nuevo.',
  NONCE_CONSUMED: 'Otra operación ya usó el número de orden de esta en tu Safe: preparala de nuevo.',
  SAFE_CONFIG_MODIFIED:
    'La configuración de tu Safe cambió fuera de la plataforma: la plataforma ya no co-firma. Revisá tu Safe desde Seguridad.',
  WHITELIST_DUPLICATE: 'El destino ya está autorizado o tiene un alta en curso.',
  TWO_FACTOR_REQUIRED: 'Falta confirmar el segundo factor de esta operación.',
  SUBMISSION_INVALID:
    'La firma enviada no corresponde a esta operación o a tu sesión: desbloqueá la wallet de nuevo y preparala otra vez.',
  POLICY_REJECTED: 'La operación no cumple las reglas de la plataforma.',
  DESTINATION_INVALID: 'Ese destino no se puede agregar.',
  GUARD_WOULD_REVERT: 'El Guard de seguridad de tu Safe rechazaría la operación en la red: no se envió.',
  PAYLOAD_TOO_LARGE: 'El pedido es demasiado grande.',
  UNSUPPORTED_MEDIA_TYPE: 'La app no pudo enviar el pedido: recargá la pantalla y reintentá.',
  IDEMPOTENCY_KEY_REUSED: 'El pedido se repitió con otros datos: reintentá.',
  WEAK_PASSWORD: 'Elegí una contraseña de cuenta más larga y que no sea común (12 caracteres o más).',
  SIGNATURE_INVALID: 'La firma no corresponde a la clave esperada.',
  KEY_NOT_ALLOWED: 'Esa clave no es la U vigente de tu wallet.',
  RATE_LIMITED: 'Demasiados intentos seguidos. Esperá un momento antes de volver a probar.',
  INTERNAL_ERROR: 'La plataforma tuvo un error: reintentá en un momento.',
  SERVICE_UNAVAILABLE: 'La plataforma no está disponible en este momento: reintentá en un rato.',
};

/** Un código fuera del catálogo local: un texto genérico según el status (nunca el título ni el detalle). */
function byStatus(status: number): string {
  if (status >= 500) return 'La plataforma no pudo procesar el pedido: reintentá en un momento.';
  if (status === 401) return 'Tu sesión de cuenta terminó: iniciá sesión de nuevo.';
  if (status === 403) return 'La plataforma no permitió la acción: desbloqueá la wallet de nuevo y reintentá.';
  if (status === 404) return 'No se encontró lo que pediste: recargá la pantalla.';
  if (status === 409) return 'La plataforma no puede hacer esto en el estado actual: recargá la pantalla y reintentá.';
  if (status === 429) return 'Demasiados intentos seguidos. Esperá un momento antes de volver a probar.';
  return 'La plataforma rechazó el pedido: revisá los datos y reintentá.';
}

const STATE_IN_DETAIL = /está en ([A-Z_]+)/;

/** Estados de un pedido de alta en la whitelist y de un swap (grupo), para los conflictos que los nombran. */
const REQUEST_STATE_TEXT: Readonly<Record<string, string>> = {
  PENDING_CHALLENGE: 'esperando el código del email',
  CHALLENGE_PASSED: 'con el código ya confirmado',
  AWAITING_SIGNATURE: 'esperando tu firma',
  SUBMITTED: 'enviado a la red',
  ACTIVATING: 'en activación',
  ACTIVE: 'activo',
  EXPIRED: 'vencido',
  CANCELLED: 'cancelado',
  FAILED: 'fallido',
};
const GROUP_STATE_TEXT: Readonly<Record<string, string>> = {
  OPEN: 'en curso',
  COMPLETED: 'terminado',
  FAILED: 'fallido',
  CANCELLED: 'cancelado',
};

/** Los errores cuyo detalle es un código del backend: el texto local que lo explica (tablas cerradas). */
function detailed(error: ApiError): string | null {
  const detail = error.problem.detail?.trim() ?? '';
  if (error.code === 'POLICY_REJECTED') {
    if (detail === 'DEADLINE_INVALID') return 'Venció el plazo del swap: volvé a cotizar.';
    const reason = knownPolicyReason(detail);
    return reason === null
      ? 'La operación no cumple las reglas de la plataforma.'
      : `La operación no cumple las reglas de la plataforma: ${reason}.`;
  }
  if (error.code === 'DESTINATION_INVALID') {
    const problem = knownDestinationProblem(detail);
    return problem === null ? 'Ese destino no se puede agregar.' : `Ese destino no se puede agregar: ${problem}.`;
  }
  if (error.code === 'OPERATION_NOT_PENDING') {
    // El detalle dice el estado con su código ("la operación está en CANCELLED"): va con su nombre en la app.
    const state = STATE_IN_DETAIL.exec(detail)?.[1] as OperationState | undefined;
    const label = state === undefined ? undefined : STATE_TEXT[state];
    if (label !== undefined) {
      return `La operación ya no admite esta acción: su estado es «${label}». Revisala en Actividad.`;
    }
    return null;
  }
  if (error.code === 'CONFLICT') {
    const request = /^el pedido está en ([A-Z_]+)/.exec(detail)?.[1];
    const requestState = request === undefined ? undefined : REQUEST_STATE_TEXT[request];
    if (requestState !== undefined) {
      return `El pedido de alta ya no admite esta acción: está ${requestState}. Empezá de nuevo si hace falta.`;
    }
    const group = /^el swap está en ([A-Z_]+)/.exec(detail)?.[1];
    const groupState = group === undefined ? undefined : GROUP_STATE_TEXT[group];
    if (groupState !== undefined) return `El swap ya no admite esta acción: está ${groupState}.`;
  }
  return null;
}

/** El texto local de un error de la API: por código del catálogo o, si no lo conoce esta app, por status. */
export function apiErrorText(error: ApiError): string {
  const translated = detailed(error);
  if (translated !== null) return translated;
  const text = CATALOG_TEXT[error.code] ?? byStatus(error.status);
  if (error.code === 'RATE_LIMITED' && error.retryAfter !== null) {
    return `${text.replace(/\.$/, '')} (podés reintentar en ${String(error.retryAfter)} s).`;
  }
  return text;
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) return apiErrorText(error);
  if (error instanceof NetworkError) return `${error.message}. Revisá tu conexión y reintentá.`;
  if (
    error instanceof DriveError ||
    error instanceof DriveConnectError ||
    error instanceof EnvelopeError ||
    error instanceof BackupWordsError
  ) {
    return error.message;
  }
  if (error instanceof Error && error.message !== '') return error.message;
  return 'Algo salió mal. Reintentá en un momento.';
}
