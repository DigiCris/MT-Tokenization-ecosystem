// Idempotencia (P08.T10) para las rutas con `config.idempotency = true` (POST que crean recursos u operaciones):
//
// - `Idempotency-Key` obligatorio (16–128 caracteres [A-Za-z0-9_-]), por usuario, válido 24 h.
// - Hash del request = SHA-256(método ‖ URL ‖ JCS(body)): la misma clave con otro request → 422.
// - Request repetido ya terminado → misma respuesta (status y body) con `Idempotent-Replayed: true`.
// - Request repetido todavía en curso → 409.
// - Los errores de validación ocurren antes de reclamar la clave (no la consumen); un 5xx la libera para reintentar.
//
// Corre en preHandler: la autenticación (preValidation) ya fijó `request.principal` y el body ya está validado. Una
// ruta idempotente pública no arranca (plugins/auth.ts); el chequeo de acá es la segunda barrera.
import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { IdempotencyRepository } from '../../db/repositories/idempotency-repository.ts';
import { canonicalJson } from '../../lib/jcs.ts';
import { ApiError } from '../errors.ts';
import type { AppInstance } from '../types.ts';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
const KEY_FORMAT = /^[A-Za-z0-9_-]{16,128}$/;

export function requestHash(request: Pick<FastifyRequest, 'method' | 'url' | 'body'>): Buffer {
  return createHash('sha256')
    .update(`${request.method}\n${request.url}\n${canonicalJson(request.body ?? null)}`)
    .digest();
}

export function registerIdempotency(app: AppInstance, repository: IdempotencyRepository): void {
  app.addHook('preHandler', async (request, reply) => {
    if (request.routeOptions.config.idempotency !== true) return;
    const header = request.headers[IDEMPOTENCY_HEADER];
    if (header === undefined) throw new ApiError('IDEMPOTENCY_KEY_REQUIRED');
    if (typeof header !== 'string' || !KEY_FORMAT.test(header)) throw new ApiError('IDEMPOTENCY_KEY_INVALID');
    const principal = request.principal;
    if (!principal) throw new Error('ruta idempotente sin usuario autenticado (falta la autenticación)');

    const result = await repository.claim(principal.userId, header, requestHash(request));
    switch (result.state) {
      case 'claimed':
        request.idempotency = { userId: principal.userId, key: header };
        return;
      case 'mismatch':
        throw new ApiError('IDEMPOTENCY_KEY_REUSED');
      case 'in-progress':
        throw new ApiError('IDEMPOTENCY_IN_PROGRESS');
      case 'replay':
        reply.header('idempotent-replayed', 'true');
        if (result.status >= 400) reply.type('application/problem+json; charset=utf-8');
        return reply.code(result.status).send(result.body);
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const claim = request.idempotency;
    if (!claim) return payload;
    request.idempotency = null;
    if (reply.statusCode >= 500) {
      await repository.release(claim.userId, claim.key);
      return payload;
    }
    let body: unknown = null;
    if (typeof payload === 'string' && payload.length > 0) {
      try {
        body = JSON.parse(payload);
      } catch {
        body = null;
      }
    }
    await repository.complete(claim.userId, claim.key, reply.statusCode, body);
    return payload;
  });
}
