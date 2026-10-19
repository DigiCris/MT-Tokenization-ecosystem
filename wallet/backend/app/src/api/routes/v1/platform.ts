// GET /platform/status (P20.T03, pública en los dos listeners): estado de la cooperación de S según las atestaciones de
// integridad registradas (integrity_status): ACTIVE, DEGRADED (una app sin verificar, dentro de la gracia) o PAUSED.
// La app Wallet lo usa para el banner de pausa. El signer es quien decide; esto lo muestra con la misma regla.
import type { Kysely } from 'kysely';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Database } from '../../../db/schema.ts';
import { cooperationState, INTEGRITY_APPS } from '../../../integrity/monitor-client.ts';
import { storedIntegrity } from '../../../integrity/status-recorder.ts';
import { errorResponses } from '../../errors.ts';

const PlatformStatusSchema = z
  .object({
    integrity: z.enum(['MONITORED', 'NOT_MONITORED']).describe('NOT_MONITORED sólo en local sin integrity monitor'),
    cooperation: z.enum(['ACTIVE', 'DEGRADED', 'PAUSED']),
    apps: z.array(
      z.object({
        app: z.enum(INTEGRITY_APPS),
        status: z.enum(['OK', 'MISMATCH', 'UNREACHABLE']).nullable(),
        releaseId: z.string().nullable(),
        observedAt: z.iso.datetime().nullable(),
      }),
    ),
  })
  .meta({ id: 'PlatformStatus' });

export interface PlatformRoutesOptions {
  db: Kysely<Database>;
  platformId: string;
  monitored: boolean;
  now?: () => number;
}

export const platformRoutes: FastifyPluginCallbackZod<PlatformRoutesOptions> = (app, options, done) => {
  app.get(
    '/platform/status',
    {
      config: { auth: 'public' },
      schema: {
        operationId: 'getPlatformStatus',
        tags: ['health'],
        summary: 'Estado de la cooperación de la plataforma (pausa por integridad de los frontends)',
        response: { 200: PlatformStatusSchema, ...errorResponses() },
      },
    },
    async () => {
      if (!options.monitored) {
        return {
          integrity: 'NOT_MONITORED' as const,
          cooperation: 'ACTIVE' as const,
          apps: INTEGRITY_APPS.map((a) => ({ app: a, status: null, releaseId: null, observedAt: null })),
        };
      }
      const stored = await storedIntegrity(options.db, options.platformId);
      const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
      return {
        integrity: 'MONITORED' as const,
        cooperation: cooperationState(stored.latest, stored.lastOk, now),
        apps: INTEGRITY_APPS.map((a) => {
          const latest = stored.latest[a];
          return {
            app: a,
            status: latest?.status ?? null,
            releaseId: latest?.releaseId ?? null,
            observedAt: latest === undefined ? null : new Date(latest.observedAt * 1000).toISOString(),
          };
        }),
      };
    },
  );
  done();
};
