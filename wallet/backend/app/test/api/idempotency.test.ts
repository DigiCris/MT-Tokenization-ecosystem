// P08.T10: Idempotency-Key sobre una ruta con efectos reales en la base. Requerido y validado, repetición idéntica,
// 422 con otro body o URL, 409 en curso, errores 4xx guardados, 5xx que liberan la clave y validación que no la
// consume. La autenticación de cuenta llega en P09: acá un hook de prueba fija el usuario desde un header.
import { setTimeout as sleep } from 'node:timers/promises';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiError, errorResponses } from '../../src/api/errors.ts';
import type { RouteRegistrar } from '../../src/api/server.ts';
import { buildTestListener, type TestListener } from '../helpers/api.ts';
import { createTestDatabase, insertUser, type TestDatabase } from '../helpers/db.ts';

let db: TestDatabase;
let listener: TestListener;
let gate: Promise<void> = Promise.resolve();
let failNext: 'none' | 'conflict' | 'crash' = 'none';

const routes: RouteRegistrar = (app) => {
  // Sólo en este test: usuario autenticado desde un header (P09 lo reemplaza por la sesión de cuenta).
  app.addHook('onRequest', (request, _reply, done) => {
    const userId = request.headers['x-test-user'];
    if (typeof userId === 'string') request.principal = { userId, platformId: 'mt-test', sessionId: 'test' };
    done();
  });
  app.post(
    '/test/resources/:group',
    {
      config: { idempotency: true },
      schema: {
        operationId: 'testCreateResource',
        tags: ['test'],
        summary: 'Crea un recurso (efecto real: una notificación)',
        params: z.object({ group: z.string() }),
        body: z.object({ label: z.string().min(1), amount: z.string().regex(/^\d+$/) }),
        response: { 201: z.object({ id: z.string(), label: z.string() }), ...errorResponses(409, 422) },
      },
    },
    async (request, reply) => {
      await gate;
      if (failNext === 'conflict') {
        failNext = 'none';
        throw new ApiError('CONFLICT', { detail: 'conflicto de dominio' });
      }
      if (failNext === 'crash') {
        failNext = 'none';
        throw new Error('falla interna transitoria');
      }
      const row = await db.app
        .insertInto('notifications')
        .values({
          user_id: request.principal?.userId ?? '',
          type: 'RESOURCE_CREATED',
          payload: JSON.stringify(request.body),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return reply.code(201).send({ id: row.id, label: request.body.label });
    },
  );
};

const createdFor = async (userId: string) =>
  (
    await db.app
      .selectFrom('notifications')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow()
  ).n;

function post(userId: string, key: string | undefined, body: unknown, group = 'a') {
  return listener.app.inject({
    method: 'POST',
    url: `/api/v1/test/resources/${group}`,
    headers: {
      'x-test-user': userId,
      'content-type': 'application/json',
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    payload: JSON.stringify(body),
  });
}

const newKey = () => `key_${crypto.randomUUID().replaceAll('-', '')}`;

beforeAll(async () => {
  db = await createTestDatabase();
  listener = await buildTestListener({ db, extraRoutes: routes });
});
afterAll(async () => {
  await listener.close();
  await db.close();
});

describe('Idempotency-Key', () => {
  it('es obligatorio y tiene formato fijo', async () => {
    const userId = await insertUser(db.app);
    const missing = await post(userId, undefined, { label: 'x', amount: '1' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    const invalid = await post(userId, 'corta', { label: 'x', amount: '1' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_INVALID' });
    expect(await createdFor(userId)).toBe(0);
  });

  it('repite la misma respuesta sin repetir el efecto (orden de claves del body indistinto)', async () => {
    const userId = await insertUser(db.app);
    const key = newKey();
    const first = await post(userId, key, { label: 'compra', amount: '10' });
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const again = await post(userId, key, { amount: '10', label: 'compra' });
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(await createdFor(userId)).toBe(1);
  });

  it('la misma clave con otro body u otra URL es 422', async () => {
    const userId = await insertUser(db.app);
    const key = newKey();
    expect((await post(userId, key, { label: 'a', amount: '1' })).statusCode).toBe(201);
    const otherBody = await post(userId, key, { label: 'a', amount: '2' });
    expect(otherBody.statusCode).toBe(422);
    expect(otherBody.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect((await post(userId, key, { label: 'a', amount: '1' }, 'b')).statusCode).toBe(422);
    expect(await createdFor(userId)).toBe(1);
  });

  it('un duplicado mientras el original sigue en curso es 409', async () => {
    const userId = await insertUser(db.app);
    const key = newKey();
    let open!: () => void;
    gate = new Promise((resolveGate) => (open = resolveGate));
    const original = post(userId, key, { label: 'lento', amount: '5' });
    await sleep(100);
    const duplicate = await post(userId, key, { label: 'lento', amount: '5' });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS' });
    open();
    gate = Promise.resolve();
    expect((await original).statusCode).toBe(201);
    expect(await createdFor(userId)).toBe(1);
  });

  it('un error 4xx del handler queda guardado y se repite', async () => {
    const userId = await insertUser(db.app);
    const key = newKey();
    failNext = 'conflict';
    const first = await post(userId, key, { label: 'x', amount: '1' });
    expect(first.statusCode).toBe(409);
    const again = await post(userId, key, { label: 'x', amount: '1' });
    expect(again.statusCode).toBe(409);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.headers['content-type']).toContain('application/problem+json');
    expect(again.json()).toMatchObject({ code: 'CONFLICT', detail: 'conflicto de dominio' });
  });

  it('un 5xx libera la clave: el reintento con la misma clave se procesa', async () => {
    const userId = await insertUser(db.app);
    const key = newKey();
    failNext = 'crash';
    expect((await post(userId, key, { label: 'x', amount: '1' })).statusCode).toBe(500);
    const retry = await post(userId, key, { label: 'x', amount: '1' });
    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
    expect(await createdFor(userId)).toBe(1);
  });

  it('un request inválido no consume la clave', async () => {
    const userId = await insertUser(db.app);
    const key = newKey();
    expect((await post(userId, key, { label: '', amount: 'x' })).statusCode).toBe(400);
    expect((await post(userId, key, { label: 'ok', amount: '3' })).statusCode).toBe(201);
  });

  it('las claves son por usuario', async () => {
    const [a, b] = [await insertUser(db.app), await insertUser(db.app)];
    const key = newKey();
    expect((await post(a, key, { label: 'x', amount: '1' })).statusCode).toBe(201);
    const other = await post(b, key, { label: 'y', amount: '2' });
    expect(other.statusCode).toBe(201);
    expect(other.headers['idempotent-replayed']).toBeUndefined();
  });

  it('una ruta idempotente sin usuario autenticado es un error de configuración (500)', async () => {
    const response = await listener.app.inject({
      method: 'POST',
      url: '/api/v1/test/resources/a',
      headers: { 'content-type': 'application/json', 'idempotency-key': newKey() },
      payload: JSON.stringify({ label: 'x', amount: '1' }),
    });
    expect(response.statusCode).toBe(500);
  });
});
