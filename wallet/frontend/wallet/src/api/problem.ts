// Errores de la API (RFC 9457, `application/problem+json`): `code` estable del catálogo del backend, `status`, `title`
// y `detail` legibles y `requestId` para soporte. Un fallo de red (sin respuesta) es otro tipo de error: el request
// pudo no haber llegado y sólo se reintenta si es idempotente.

export interface ProblemFieldError {
  path: string;
  message: string;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  requestId: string;
  errors?: ProblemFieldError[];
}

export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  readonly code: string;
  readonly problem: Problem;
  /** Segundos de `Retry-After` (429/503), si vino. */
  readonly retryAfter: number | null;

  constructor(problem: Problem, retryAfter: number | null = null) {
    super(problem.detail ? `${problem.title}: ${problem.detail}` : problem.title);
    this.status = problem.status;
    this.code = problem.code;
    this.problem = problem;
    this.retryAfter = retryAfter;
  }
}

export class NetworkError extends Error {
  override name = 'NetworkError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isProblem(value: unknown): value is Problem {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    typeof value.title === 'string' &&
    typeof value.status === 'number' &&
    typeof value.code === 'string' &&
    typeof value.requestId === 'string' &&
    (value.detail === undefined || typeof value.detail === 'string') &&
    (value.errors === undefined ||
      (Array.isArray(value.errors) &&
        value.errors.every((e) => isRecord(e) && typeof e.path === 'string' && typeof e.message === 'string')))
  );
}

/** Problema de una respuesta no-2xx; si el cuerpo no es un problem+json válido, uno sintético con el status. */
export function problemOf(status: number, body: unknown, requestId: string | null): Problem {
  if (isProblem(body)) return body;
  return {
    type: 'about:blank',
    title: status >= 500 ? 'Error del servidor' : 'Respuesta inesperada del servidor',
    status,
    code: status >= 500 ? 'INTERNAL_ERROR' : 'UNEXPECTED_RESPONSE',
    requestId: requestId ?? '',
  };
}

export function retryAfterSeconds(header: string | null): number | null {
  if (header === null || !/^\d{1,6}$/.test(header)) return null;
  return Number(header);
}
