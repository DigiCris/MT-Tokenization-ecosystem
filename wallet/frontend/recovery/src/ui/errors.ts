// Errores para mostrar en Recovery: los problemas del backend con su código pasan a un texto en castellano (sin
// detalles internos); los errores propios de la app (verificaciones, sobres, palabras) ya traen su mensaje.
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
  ENROLLMENT_EXPIRED: 'El pedido de la Wallet venció: generá uno nuevo desde la app Wallet.',
  KEY_NOT_ALLOWED: 'Esa clave no se puede usar como clave de recuperación (ya está en uso o no es una cuenta común).',
  SIGNATURE_INVALID: 'La firma no es válida para esta operación.',
  POLICY_REJECTED: 'Las reglas de la plataforma no permiten esta operación.',
  GUARD_WOULD_REVERT: 'El Guard de tu Safe rechazaría esta operación.',
  OPERATION_NOT_PENDING: 'La operación ya no está pendiente.',
  OPERATION_BUSY: 'La operación se está procesando: probá de nuevo en unos segundos.',
  NOT_FOUND: 'No se encontró lo pedido.',
};

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'CONFLICT' && error.detail !== null) return `${error.detail}.`;
    const known = API_TEXT[error.code];
    if (known !== undefined) {
      return error.retryAfterSeconds !== null
        ? `${known} (podés reintentar en ${String(error.retryAfterSeconds)} s)`
        : known;
    }
    return error.detail ?? error.message;
  }
  if (error instanceof Error) return error.message;
  return 'Algo salió mal.';
}
