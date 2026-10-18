// P08.T10: Idempotency-Key sobre una ruta con efectos reales en la base. Requerido y validado, repetición idéntica,
// 422 con otro body o URL, 409 en curso, errores 4xx guardados, 5xx que liberan la clave y validación que no la
// consume. El usuario sale de la sesión de cuenta real (login por la API, cookie y CSRF).
import { setTimeout as sleep } from 'node:timers/promises';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiError, errorResponses } from '../../src/api/errors.ts';
import type { RouteRegistrar } from '../../src/api/server.ts';
import { signedInClient } from '../helpers/accounts.ts';
import { buildTestListener, type TestListener } from '../helpers/api.ts';
import type { TestClient } from '../helpers/client.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';

let db: TestDatabase;
let listener: TestListener;
let gate: Promise<void> = Promise.resolve();
let failNext: 'none' | 'conflict' | 'crash' = 'none';

const routes: RouteRegistrar = (app) => {
  app.post(
    '/test/resources/:group',
    {
      config: { auth: 'account', idempotency: true },
      schema: {
        operationId: 'testCreateResource',
        tags: ['test'],
        summary: 'Crea un recurso (efecto real: una notificación)',
        params: z.object({ group: z.string() }),
        body: z.object({ label: z.string().min(1), amount: z.string().regex(/^\d+$/) }),
        response: { 201: z.object({ id: z.string(), label: z.string() }), ...errorResponses(401, 403, 409, 415, 422) },
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

// Sólo las filas que crea la ruta de prueba (el login agrega su propia notificación NEW_LOGIN, [B-MAIL-03]).
const createdFor = async (userId: string) =>
  (
    await db.app
      .selectFrom('notifications')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('user_id', '=', userId)
      .where('type', '=', 'RESOURCE_CREATED')
      .executeTakeFirstOrThrow()
  ).n;

interface User {
  id: string;
  client: TestClient;
}

async function user(): Promise<User> {
  const { client, account } = await signedInClient(listener, db);
  return { id: account.id, client };
}

function post(as: User, key: string | undefined, body: unknown, group = 'a') {
  return as.client.post(`/api/v1/test/resources/${group}`, body, key === undefined ? {} : { 'idempotency-key': key });
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
    const owner = await user();
    const missing = await post(owner, undefined, { label: 'x', amount: '1' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    const invalid = await post(owner, 'corta', { label: 'x', amount: '1' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_INVALID' });
    expect(await createdFor(owner.id)).toBe(0);
  });

  it('repite la misma respuesta sin repetir el efecto (orden de claves del body indistinto)', async () => {
    const owner = await user();
    const key = newKey();
    const first = await post(owner, key, { label: 'compra', amount: '10' });
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const again = await post(owner, key, { amount: '10', label: 'compra' });
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(await createdFor(owner.id)).toBe(1);
  });

  it('la misma clave con otro body u otra URL es 422', async () => {
    const owner = await user();
    const key = newKey();
    expect((await post(owner, key, { label: 'a', amount: '1' })).statusCode).toBe(201);
    const otherBody = await post(owner, key, { label: 'a', amount: '2' });
    expect(otherBody.statusCode).toBe(422);
    expect(otherBody.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect((await post(owner, key, { label: 'a', amount: '1' }, 'b')).statusCode).toBe(422);
    expect(await createdFor(owner.id)).toBe(1);
  });

  it('un duplicado mientras el original sigue en curso es 409', async () => {
    const owner = await user();
    const key = newKey();
    let open!: () => void;
    gate = new Promise((resolveGate) => (open = resolveGate));
    const original = post(owner, key, { label: 'lento', amount: '5' });
    await sleep(100);
    const duplicate = await post(owner, key, { label: 'lento', amount: '5' });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS' });
    open();
    gate = Promise.resolve();
    expect((await original).statusCode).toBe(201);
    expect(await createdFor(owner.id)).toBe(1);
  });

  it('un error 4xx del handler queda guardado y se repite', async () => {
    const owner = await user();
    const key = newKey();
    failNext = 'conflict';
    const first = await post(owner, key, { label: 'x', amount: '1' });
    expect(first.statusCode).toBe(409);
    const again = await post(owner, key, { label: 'x', amount: '1' });
    expect(again.statusCode).toBe(409);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.headers['content-type']).toContain('application/problem+json');
    expect(again.json()).toMatchObject({ code: 'CONFLICT', detail: 'conflicto de dominio' });
  });

  it('un 5xx libera la clave: el reintento con la misma clave se procesa', async () => {
    const owner = await user();
    const key = newKey();
    failNext = 'crash';
    expect((await post(owner, key, { label: 'x', amount: '1' })).statusCode).toBe(500);
    const retry = await post(owner, key, { label: 'x', amount: '1' });
    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
    expect(await createdFor(owner.id)).toBe(1);
  });

  it('un request inválido no consume la clave', async () => {
    const owner = await user();
    const key = newKey();
    expect((await post(owner, key, { label: '', amount: 'x' })).statusCode).toBe(400);
    expect((await post(owner, key, { label: 'ok', amount: '3' })).statusCode).toBe(201);
  });

  it('las claves son por usuario', async () => {
    const [a, b] = [await user(), await user()];
    const key = newKey();
    expect((await post(a, key, { label: 'x', amount: '1' })).statusCode).toBe(201);
    const other = await post(b, key, { label: 'y', amount: '2' });
    expect(other.statusCode).toBe(201);
    expect(other.headers['idempotent-replayed']).toBeUndefined();
  });

  it('sin sesión es 401 y la clave no se reclama', async () => {
    const anonymous = listener.newClient();
    const key = newKey();
    const response = await anonymous.post(
      '/api/v1/test/resources/a',
      { label: 'x', amount: '1' },
      { 'idempotency-key': key },
    );
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    const claimed = await db.app.selectFrom('idempotency_keys').select('key').where('key', '=', key).executeTakeFirst();
    expect(claimed).toBeUndefined();
  });

  it('una ruta idempotente pública es un error de configuración: el servidor no arranca', async () => {
    await expect(
      buildTestListener({
        db,
        extraRoutes: (app) => {
          app.post(
            '/test/public-idempotent',
            {
              config: { auth: 'public', idempotency: true },
              schema: {
                operationId: 'testPublicIdempotent',
                tags: ['test'],
                summary: 'Mal configurada',
                body: z.object({}),
                response: { 201: z.object({ ok: z.boolean() }), ...errorResponses(403, 415) },
              },
            },
            () => ({ ok: true }),
          );
        },
      }),
    ).rejects.toThrow(/ruta idempotente sin usuario autenticado: POST \/api\/v1\/test\/public-idempotent/);
  });
});
