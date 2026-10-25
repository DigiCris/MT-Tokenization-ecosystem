// Errores para mostrar en Recovery: los problemas del backend pasan a un texto en castellano de esta app; los errores
// propios de la app (verificaciones, sobres, palabras) ya traen su mensaje.
//
// Regla (revisión de seguridad de ADR-033, igual que en la app Wallet): ningún texto del backend llega a la pantalla.
// Un backend comprometido (ESC-20) controla `title` y `detail` de sus errores: con texto libre podría mostrar una
// dirección o una instrucción al lado de lo que el usuario confirma o firma. Sólo salen textos locales elegidos por
// `code` o, si el código no está en el catálogo, por `status`.
import { ApiError } from '../api/client.ts';

const API_TEXT: Record<string, string> = {
  INVALID_CREDENTIALS: 'Email o contraseña incorrectos.',
  TOTP_REQUIRED: 'Ingresá el código de tu app de autenticación (o uno de recuperación).',
  ACCOUNT_LOCKED: 'La cuenta está bloqueada por intentos fallidos: desbloqueala desde el email que te mandamos.',
  EMAIL_NOT_VERIFIED: 'Verificá el email de tu cuenta desde la app Wallet antes de seguir.',
  SECOND_FACTOR_REQUIRED: 'Falta el código de tu app de autenticación (o uno de recuperación).',
  REAUTH_FAILED:
    'El código de verificación en dos pasos no es válido: pedí un código nuevo por email y volvé a intentar.',
  INVALID_CODE: 'El código del email no es válido o venció: pedí uno nuevo.',
  RATE_LIMITED: 'Demasiados intentos: esperá un rato antes de volver a probar.',
  SESSION_REQUIRED: 'Tu sesión venció: iniciá sesión de nuevo.',
  PLATFORM_SESSION_INVALID: 'La verificación venció (dura 15 minutos): verificá tu identidad de nuevo.',
  PLATFORM_SESSION_REQUIRED: 'Primero verificá tu identidad con el código por email.',
  SCOPE_NOT_ALLOWED: 'Esta verificación no sirve para esta acción o esta wallet: verificá tu identidad de nuevo.',
  WALLET_NOT_ACTIVE: 'La wallet no está activa para esta acción.',
  SAFE_CONFIG_MODIFIED: 'La Safe se modificó fuera de la plataforma: usá el modo soberano.',
  // Lo devuelve el envío de la dirección (con R ya creada y respaldada); antes de crear R, /enroll muestra el estado.
  ENROLLMENT_EXPIRED:
    'El pedido venció antes de enviar la dirección: esta clave R no se va a usar; destruí sus backups y generá un pedido nuevo desde la app Wallet.',
  KEY_NOT_ALLOWED: 'Esa clave no se puede usar como clave de recuperación (ya está en uso o no es una cuenta común).',
  SIGNATURE_INVALID: 'La firma no es válida para esta operación.',
  POLICY_REJECTED: 'Las reglas de la plataforma no permiten esta operación.',
  GUARD_WOULD_REVERT: 'El Guard de tu Safe rechazaría esta operación.',
  OPERATION_NOT_PENDING: 'La operación ya no está pendiente.',
  OPERATION_BUSY: 'La operación se está procesando: probá de nuevo en unos segundos.',
  NOT_FOUND: 'No se encontró lo pedido.',
  CONFLICT: 'La plataforma no puede hacer esto en el estado actual: recargá la pantalla y reintentá.',
  BAD_REQUEST: 'Algún dato del pedido no es válido: revisalo y reintentá.',
  VALIDATION_FAILED: 'Algún dato del pedido no es válido: revisalo y reintentá.',
  UNAUTHENTICATED: 'Tu sesión venció: iniciá sesión de nuevo.',
  FORBIDDEN: 'La plataforma no permite esta acción.',
  CSRF_TOKEN_INVALID: 'La sesión de la app se desincronizó: recargá la página y reintentá.',
  REQUEST_SIGNATURE_INVALID: 'La app no pudo firmar el pedido: verificá tu identidad de nuevo y reintentá.',
  REQUEST_EXPIRED: 'El pedido firmado llegó fuera de tiempo: revisá la fecha y hora de tu dispositivo.',
  REQUEST_REPLAYED: 'Ese pedido ya se había enviado: reintentá.',
  INTERNAL_ERROR: 'La plataforma tuvo un error: reintentá en un momento.',
  SERVICE_UNAVAILABLE: 'La plataforma no está disponible en este momento: reintentá en un rato.',
};

/** Un código fuera del catálogo local: un texto genérico según el status (nunca el título ni el detalle). */
function byStatus(status: number): string {
  if (status >= 500) return 'La plataforma no pudo procesar el pedido: reintentá en un momento.';
  if (status === 401) return 'Tu sesión venció: iniciá sesión de nuevo.';
  if (status === 403) return 'La plataforma no permitió la acción: verificá tu identidad de nuevo y reintentá.';
  if (status === 404) return 'No se encontró lo pedido.';
  if (status === 409) return 'La plataforma no puede hacer esto en el estado actual: recargá la pantalla y reintentá.';
  if (status === 429) return 'Demasiados intentos: esperá un rato antes de volver a probar.';
  return 'La plataforma rechazó el pedido: revisá los datos y reintentá.';
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const text = API_TEXT[error.code] ?? byStatus(error.status);
    return error.retryAfterSeconds !== null
      ? `${text} (podés reintentar en ${String(error.retryAfterSeconds)} s)`
      : text;
  }
  if (error instanceof Error && error.message !== '') return error.message;
  return 'Algo salió mal.';
}
