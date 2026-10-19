// Pausa de la cooperación de S por integridad de los frontends (P20.T03, V9 §17, ADR-023). Con INTEGRITY_REQUIRED el
// signer sólo co-firma si tiene, para Wallet **y** Recovery, una IntegrityAttestation del integrity monitor (firma con
// la clave fijada del monitor, misma plataforma y entorno) observada hace ≤ 5 min y vigente:
//   - MISMATCH → pausa en el acto; una atestación OK observada antes o en el mismo instante que ese MISMATCH no la
//     levanta (no se puede "reanudar" reenviando un OK viejo);
//   - UNREACHABLE → se sigue cooperando hasta 15 min después del último OK visto de esa app; después, pausa;
//   - sin atestación vigente de alguna app (monitor caído o atestación vencida) → pausa (fail-closed).
// La reanudación tras un MISMATCH la decide el monitor (release OK + dos operadores, P20.T04): el signer sólo ve
// volver las atestaciones OK. El camino soberano (U + R) no pasa por el signer y no se afecta.
import { JwsError, verifyJws, type PinnedKeys } from '../crypto/jws.ts';
import { IntegrityAttestationSchema } from './attestations.ts';

export const INTEGRITY_APPS = ['WALLET', 'RECOVERY'] as const;
export type IntegrityApp = (typeof INTEGRITY_APPS)[number];
export const ATTESTATION_MAX_AGE_SECONDS = 5 * 60;
export const UNREACHABLE_GRACE_SECONDS = 15 * 60;
export const MAX_ATTESTATIONS = 4;

export type PauseReason = 'MISSING' | 'STALE' | 'MISMATCH' | 'UNREACHABLE';

export interface IntegrityDecision {
  cooperate: boolean;
  /** Primera app que impide cooperar y por qué (si `cooperate` es false). */
  app?: IntegrityApp;
  reason?: PauseReason;
  /** Apps UNREACHABLE dentro de la gracia (se coopera, con alerta). */
  degraded: IntegrityApp[];
}

interface Context {
  platformId: string;
  environment: string;
  /** Segundos Unix. */
  now: number;
  clockSkewSeconds: number;
}

type Attestation = ReturnType<typeof IntegrityAttestationSchema.parse>;

export class IntegrityGate {
  readonly #keys: PinnedKeys;
  readonly #lastOk = new Map<IntegrityApp, number>();
  readonly #mismatchAt = new Map<IntegrityApp, number>();

  constructor(monitorKeys: PinnedKeys) {
    this.#keys = monitorKeys;
  }

  async #newest(tokens: readonly string[], context: Context): Promise<Map<IntegrityApp, Attestation>> {
    const newest = new Map<IntegrityApp, Attestation>();
    for (const token of tokens.slice(0, MAX_ATTESTATIONS)) {
      let payload: unknown;
      try {
        ({ payload } = await verifyJws(token, this.#keys));
      } catch (error) {
        if (error instanceof JwsError) continue;
        throw error;
      }
      const parsed = IntegrityAttestationSchema.safeParse(payload);
      if (!parsed.success) continue;
      const a = parsed.data;
      if (a.platformId !== context.platformId || a.environment !== context.environment) continue;
      if (a.observedAt > context.now + context.clockSkewSeconds) continue;
      const current = newest.get(a.app);
      if (current === undefined || a.observedAt > current.observedAt) newest.set(a.app, a);
    }
    return newest;
  }

  async decide(tokens: readonly string[], context: Context): Promise<IntegrityDecision> {
    const newest = await this.#newest(tokens, context);
    const degraded: IntegrityApp[] = [];
    let blocked: { app: IntegrityApp; reason: PauseReason } | undefined;
    const block = (app: IntegrityApp, reason: PauseReason) => {
      blocked ??= { app, reason };
    };
    for (const app of INTEGRITY_APPS) {
      const a = newest.get(app);
      if (a === undefined) {
        block(app, 'MISSING');
        continue;
      }
      if (a.status === 'MISMATCH') {
        this.#mismatchAt.set(app, Math.max(this.#mismatchAt.get(app) ?? 0, a.observedAt));
        block(app, 'MISMATCH');
        continue;
      }
      if (a.expiresAt <= context.now || context.now - a.observedAt > ATTESTATION_MAX_AGE_SECONDS) {
        block(app, 'STALE');
        continue;
      }
      if (a.status === 'OK') {
        const mismatchAt = this.#mismatchAt.get(app);
        if (mismatchAt !== undefined && a.observedAt <= mismatchAt) {
          block(app, 'MISMATCH');
          continue;
        }
        this.#mismatchAt.delete(app);
        this.#lastOk.set(app, Math.max(this.#lastOk.get(app) ?? 0, a.observedAt));
        continue;
      }
      // UNREACHABLE: el monitor no pudo verificar; gracia desde el último OK que vio este signer.
      const lastOk = this.#lastOk.get(app);
      if (this.#mismatchAt.has(app) || lastOk === undefined || context.now - lastOk > UNREACHABLE_GRACE_SECONDS) {
        block(app, this.#mismatchAt.has(app) ? 'MISMATCH' : 'UNREACHABLE');
        continue;
      }
      degraded.push(app);
    }
    return blocked === undefined ? { cooperate: true, degraded } : { cooperate: false, ...blocked, degraded };
  }
}
