// Errores RFC 9457 (`application/problem+json`) [B-API]: `{type, title, status, code, detail, requestId, errors?}`.
// Ninguna respuesta de error repite valores recibidos ni detalles internos (stack, SQL, mensajes de drivers).
import { z } from 'zod';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

export const ProblemFieldErrorSchema = z
  .object({
    path: z.string().describe('Ruta del campo inválido (p. ej. `body.email`)'),
    message: z.string(),
  })
  .meta({ id: 'ProblemFieldError' });

export const ProblemSchema = z
  .object({
    type: z.string().describe('URI que identifica el tipo de problema (`urn:mtw:problem:<código>`)'),
    title: z.string(),
    status: z.number().int().min(400).max(599),
    code: z.string().describe('Código estable para el cliente (p. ej. `VALIDATION_FAILED`)'),
    detail: z.string().optional(),
    requestId: z.string(),
    errors: z.array(ProblemFieldErrorSchema).optional(),
  })
  .meta({ id: 'Problem', description: 'Error RFC 9457' });

export type Problem = z.infer<typeof ProblemSchema>;
export type ProblemFieldError = z.infer<typeof ProblemFieldErrorSchema>;

/** Catálogo de errores de la API: status y título fijos por código. */
export const ERROR_CATALOG = {
  BAD_REQUEST: { status: 400, title: 'Request inválido' },
  VALIDATION_FAILED: { status: 400, title: 'El request no cumple el schema' },
  IDEMPOTENCY_KEY_REQUIRED: { status: 400, title: 'Falta el header Idempotency-Key' },
  IDEMPOTENCY_KEY_INVALID: { status: 400, title: 'Idempotency-Key inválido' },
  INVALID_CODE: { status: 400, title: 'Código inválido o vencido' },
  INVALID_TOKEN: { status: 400, title: 'Enlace inválido o vencido' },
  UNAUTHENTICATED: { status: 401, title: 'Autenticación requerida' },
  INVALID_CREDENTIALS: { status: 401, title: 'Email o contraseña incorrectos' },
  TOTP_REQUIRED: { status: 401, title: 'Falta el código de verificación en dos pasos' },
  INVALID_TOTP: { status: 401, title: 'Código de verificación en dos pasos incorrecto' },
  FORBIDDEN: { status: 403, title: 'Acción no permitida' },
  ORIGIN_NOT_ALLOWED: { status: 403, title: 'Origin no permitido para este listener' },
  CSRF_ORIGIN_REQUIRED: { status: 403, title: 'Falta el header Origin' },
  CSRF_TOKEN_INVALID: { status: 403, title: 'Token CSRF ausente o inválido' },
  EMAIL_NOT_VERIFIED: { status: 403, title: 'El email de la cuenta no está verificado' },
  ACCOUNT_LOCKED: { status: 403, title: 'Cuenta bloqueada por intentos fallidos' },
  ACCOUNT_DISABLED: { status: 403, title: 'Cuenta deshabilitada' },
  REAUTH_FAILED: { status: 403, title: 'No se pudo confirmar tu identidad' },
  SECOND_FACTOR_REQUIRED: { status: 403, title: 'Falta el código de verificación en dos pasos' },
  PLATFORM_SESSION_REQUIRED: { status: 403, title: 'Esta acción requiere desbloquear la wallet (PlatformSession)' },
  PLATFORM_SESSION_INVALID: { status: 403, title: 'PlatformSession vencida, revocada o inválida' },
  SCOPE_NOT_ALLOWED: { status: 403, title: 'La PlatformSession no permite esta acción' },
  REQUEST_SIGNATURE_INVALID: { status: 403, title: 'Firma del request ausente o inválida' },
  REQUEST_EXPIRED: { status: 403, title: 'El request firmado está fuera de la ventana de tiempo' },
  REQUEST_REPLAYED: { status: 403, title: 'El request firmado ya se usó' },
  NOT_FOUND: { status: 404, title: 'Recurso no encontrado' },
  IDEMPOTENCY_IN_PROGRESS: { status: 409, title: 'Hay un request con el mismo Idempotency-Key en curso' },
  CONFLICT: { status: 409, title: 'Conflicto con el estado actual' },
  WALLET_NOT_ACTIVE: { status: 409, title: 'La wallet no está activa' },
  PAYLOAD_TOO_LARGE: { status: 413, title: 'El cuerpo del request supera el límite' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, title: 'Content-Type no soportado' },
  IDEMPOTENCY_KEY_REUSED: { status: 422, title: 'Idempotency-Key ya usado con otro request' },
  WEAK_PASSWORD: { status: 422, title: 'La contraseña no cumple la política' },
  RATE_LIMITED: { status: 429, title: 'Demasiados requests' },
  INTERNAL_ERROR: { status: 500, title: 'Error interno' },
  SERVICE_UNAVAILABLE: { status: 503, title: 'Servicio no disponible' },
} as const satisfies Record<string, { status: number; title: string }>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export function problemType(code: string): string {
  return `urn:mtw:problem:${code.toLowerCase().replaceAll('_', '-')}`;
}

export class ApiError extends Error {
  override name = 'ApiError';
  readonly code: ErrorCode;
  readonly status: number;
  readonly title: string;
  readonly detail: string | undefined;
  readonly errors: readonly ProblemFieldError[] | undefined;
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    code: ErrorCode,
    options: {
      detail?: string;
      errors?: readonly ProblemFieldError[];
      headers?: Record<string, string>;
      cause?: unknown;
    } = {},
  ) {
    super(
      options.detail ?? ERROR_CATALOG[code].title,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.code = code;
    this.status = ERROR_CATALOG[code].status;
    this.title = ERROR_CATALOG[code].title;
    this.detail = options.detail;
    this.errors = options.errors;
    this.headers = options.headers ?? {};
  }

  toProblem(requestId: string): Problem {
    return {
      type: problemType(this.code),
      title: this.title,
      status: this.status,
      code: this.code,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
      requestId,
      ...(this.errors === undefined ? {} : { errors: [...this.errors] }),
    };
  }
}

/** Respuestas de error documentadas por defecto en toda ruta (además de las propias de cada una). */
export function errorResponses(...codes: number[]): Record<number, typeof ProblemSchema> {
  const all = new Set([400, 429, 500, 503, ...codes]);
  return Object.fromEntries([...all].sort().map((code) => [code, ProblemSchema]));
}
