// Mensajes para el usuario a partir de los errores de la app: el catálogo del backend ya trae títulos en castellano;
// acá se agregan las indicaciones de qué hacer en los casos que lo necesitan, y los códigos que el backend manda en el
// detalle (rechazos de la policy, problemas del destino, estados) se traducen: ningún código crudo llega a la pantalla.
import { ApiError, NetworkError } from '../api/problem.ts';
import type { OperationState } from '../api/wallet-api.ts';
import { BackupWordsError } from '../crypto/backup-words.ts';
import { EnvelopeError } from '../crypto/envelope.ts';
import { DriveError } from '../drive/client.ts';
import { DriveConnectError } from '../drive/oauth.ts';
import { STATE_TEXT } from '../operations/describe.ts';
import { destinationProblemText, policyReasonText } from '../operations/reasons.ts';

const GUIDANCE: Record<string, string> = {
  INVALID_CREDENTIALS: 'Email o contraseña de cuenta incorrectos.',
  ACCOUNT_LOCKED: 'Tu cuenta quedó bloqueada por intentos fallidos. Pedí un código de desbloqueo por email.',
  EMAIL_NOT_VERIFIED: 'Todavía no verificaste tu email: ingresá el código que te mandamos.',
  TOTP_REQUIRED: 'Ingresá el código de tu app de autenticación (o un código de recuperación).',
  INVALID_TOTP: 'El código de verificación en dos pasos no es correcto.',
  INVALID_CODE: 'El código no es correcto o venció. Pedí uno nuevo si hace falta.',
  INVALID_TOKEN: 'El enlace no es válido o venció. Pedí uno nuevo.',
  WEAK_PASSWORD: 'Elegí una contraseña de cuenta más larga y que no sea común (12 caracteres o más).',
  RATE_LIMITED: 'Demasiados intentos seguidos. Esperá un momento antes de volver a probar.',
  PLATFORM_SESSION_INVALID: 'La sesión de la wallet venció o se cerró: desbloqueala de nuevo.',
  PLATFORM_SESSION_REQUIRED: 'Desbloqueá la wallet para continuar.',
  REQUEST_EXPIRED: 'El pedido firmado llegó fuera de tiempo: revisá la fecha y hora de tu dispositivo.',
  UNAUTHENTICATED: 'Tu sesión de cuenta terminó: iniciá sesión de nuevo.',
  WALLET_NOT_ACTIVE: 'La wallet todavía no está activa.',
  SIGNATURE_INVALID: 'La firma no corresponde a la clave esperada.',
  KEY_NOT_ALLOWED: 'Esa clave no es la U vigente de tu wallet.',
  // Operaciones (P18.MAN): sin jerga del backend.
  OPERATION_EXPIRED: 'La operación venció sin tu firma (15 minutos): preparala de nuevo.',
  OPERATION_BUSY: 'La plataforma está revisando la operación: reintentá en unos segundos.',
  NONCE_CONFLICT:
    'Otra operación ocupa el mismo número de orden en tu Safe: esperá a que termine (o cancelala) y prepará esta de nuevo.',
  NONCE_CONSUMED: 'Otra operación ya usó el número de orden de esta en tu Safe: preparala de nuevo.',
  SUBMISSION_INVALID:
    'La firma enviada no corresponde a esta operación o a tu sesión: desbloqueá la wallet de nuevo y preparala otra vez.',
  GUARD_WOULD_REVERT: 'El Guard de seguridad de tu Safe rechazaría la operación en la red: no se envió.',
  TWO_FACTOR_REQUIRED: 'Falta confirmar el segundo factor de esta operación.',
  SCOPE_NOT_ALLOWED: 'La sesión de la wallet no permite esta acción: desbloqueala de nuevo.',
  REQUEST_SIGNATURE_INVALID: 'La app no pudo firmar el pedido: desbloqueá la wallet de nuevo y reintentá.',
  REQUEST_REPLAYED: 'Ese pedido ya se había enviado: reintentá.',
  VALIDATION_FAILED: 'Algún dato del pedido no es válido: revisalo y reintentá.',
  BAD_REQUEST: 'Algún dato del pedido no es válido: revisalo y reintentá.',
  IDEMPOTENCY_IN_PROGRESS: 'Ya hay un pedido igual en curso: esperá unos segundos.',
  IDEMPOTENCY_KEY_REUSED: 'El pedido se repitió con otros datos: reintentá.',
};

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

/** Los errores cuyo detalle es un código del backend: el texto que lo explica. */
function detailed(error: ApiError): string | null {
  const detail = error.problem.detail?.trim() ?? '';
  if (error.code === 'POLICY_REJECTED') {
    if (detail === 'DEADLINE_INVALID') return 'Venció el plazo del swap: volvé a cotizar.';
    return detail === ''
      ? 'La operación no cumple las reglas de la plataforma.'
      : `La operación no cumple las reglas de la plataforma: ${policyReasonText(detail)}.`;
  }
  if (error.code === 'DESTINATION_INVALID') {
    return detail === ''
      ? 'Ese destino no se puede agregar.'
      : `Ese destino no se puede agregar: ${destinationProblemText(detail)}.`;
  }
  if (error.code === 'OPERATION_NOT_PENDING') {
    // El detalle dice el estado con su código ("la operación está en CANCELLED"): va con su nombre en la app.
    const state = STATE_IN_DETAIL.exec(detail)?.[1] as OperationState | undefined;
    const label = state === undefined ? undefined : STATE_TEXT[state];
    if (label !== undefined) {
      return `La operación ya no admite esta acción: su estado es «${label}». Revisala en Actividad.`;
    }
    return detail === ''
      ? 'La operación ya no admite esta acción: revisá su estado en Actividad.'
      : `La operación ya no admite esta acción: ${detail}.`;
  }
  if (error.code === 'CONFLICT') {
    const request = /^el pedido está en ([A-Z_]+)/.exec(detail)?.[1];
    if (request !== undefined) {
      const state = REQUEST_STATE_TEXT[request] ?? `en el estado ${request}`;
      return `El pedido de alta ya no admite esta acción: está ${state}. Empezá de nuevo si hace falta.`;
    }
    const group = /^el swap está en ([A-Z_]+)/.exec(detail)?.[1];
    if (group !== undefined) {
      return `El swap ya no admite esta acción: está ${GROUP_STATE_TEXT[group] ?? `en el estado ${group}`}.`;
    }
  }
  return null;
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const translated = detailed(error);
    if (translated !== null) return translated;
    const guidance = GUIDANCE[error.code];
    if (error.code === 'RATE_LIMITED' && error.retryAfter !== null) {
      const base = (guidance ?? error.problem.title).replace(/\.$/, '');
      return `${base} (podés reintentar en ${String(error.retryAfter)} s).`;
    }
    return guidance ?? (error.problem.detail ? `${error.problem.title}: ${error.problem.detail}` : error.problem.title);
  }
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
