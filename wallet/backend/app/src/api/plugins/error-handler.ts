// Todas las respuestas de error son RFC 9457 (`application/problem+json`) con el requestId. Los 5xx se loguean con
// el error completo (redactado); al cliente nunca le llegan detalles internos.
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import { RpcQuorumError } from '../../chain/rpc-quorum.ts';
import { ApiError, PROBLEM_CONTENT_TYPE, type ProblemFieldError } from '../errors.ts';
import type { AppInstance } from '../types.ts';

const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  '57P01',
  '57P03',
]);

function isInfrastructureOutage(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const name = (error as { name?: unknown } | null)?.name;
  const message = (error as { message?: unknown } | null)?.message;
  return (
    (typeof code === 'string' && UNAVAILABLE_CODES.has(code)) ||
    name === 'MaxRetriesPerRequestError' ||
    (typeof message === 'string' && /Connection is closed|Stream isn't writeable/.test(message))
  );
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (hasZodFastifySchemaValidationErrors(error)) {
    const context = (error as FastifyError & { validationContext?: string }).validationContext ?? 'request';
    const errors: ProblemFieldError[] = error.validation.map((issue) => ({
      path: [context, ...issue.instancePath.split('/').filter(Boolean)].join('.'),
      message: issue.message ?? 'inválido',
    }));
    return new ApiError('VALIDATION_FAILED', { errors });
  }
  if (isResponseSerializationError(error)) return new ApiError('INTERNAL_ERROR', { cause: error });
  const fastifyError = error as Partial<FastifyError>;
  if (fastifyError.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return new ApiError('PAYLOAD_TOO_LARGE');
  if (fastifyError.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return new ApiError('UNSUPPORTED_MEDIA_TYPE');
  if (isInfrastructureOutage(error)) return new ApiError('SERVICE_UNAVAILABLE', { cause: error });
  // Lectura sensible sin quórum ([B-RPC-02]): no se decide nada y el cliente reintenta.
  if (error instanceof RpcQuorumError) {
    return new ApiError('SERVICE_UNAVAILABLE', { detail: `lectura on-chain sin quórum (${error.code})`, cause: error });
  }
  const status = fastifyError.statusCode;
  if (typeof status === 'number' && status === 429) return new ApiError('RATE_LIMITED');
  if (typeof status === 'number' && status >= 400 && status < 500) return new ApiError('BAD_REQUEST');
  return new ApiError('INTERNAL_ERROR', { cause: error });
}

export function sendProblem(request: FastifyRequest, reply: FastifyReply, apiError: ApiError): FastifyReply {
  return reply
    .code(apiError.status)
    .headers(apiError.headers)
    .type(PROBLEM_CONTENT_TYPE)
    .send(apiError.toProblem(request.id));
}

export function registerErrorHandling(app: AppInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const apiError = toApiError(error);
    if (apiError.status >= 500) request.log.error({ err: error, errorCode: apiError.code }, 'error del servidor');
    else request.log.info({ errorCode: apiError.code }, 'request rechazado');
    return sendProblem(request, reply, apiError);
  });
  app.setNotFoundHandler((request, reply) => sendProblem(request, reply, new ApiError('NOT_FOUND')));
}
