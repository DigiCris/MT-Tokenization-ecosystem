// Mensajes para el usuario a partir de los errores de la app: el catálogo del backend ya trae títulos en castellano;
// acá se agregan las indicaciones de qué hacer en los casos que lo necesitan.
import { ApiError, NetworkError } from '../api/problem.ts';
import { BackupWordsError } from '../crypto/backup-words.ts';
import { EnvelopeError } from '../crypto/envelope.ts';
import { DriveError } from '../drive/client.ts';
import { DriveConnectError } from '../drive/oauth.ts';

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
};

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const guidance = GUIDANCE[error.code];
    if (error.code === 'RATE_LIMITED' && error.retryAfter !== null) {
      return `${guidance ?? error.problem.title} (podés reintentar en ${String(error.retryAfter)} s).`;
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
