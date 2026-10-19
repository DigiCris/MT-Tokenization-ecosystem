// Atestaciones del integrity monitor (P20.T03, [W-03]): el backend las pide a `GET /v1/attestations` del monitor (red
// interna), las verifica con la clave pública fijada del monitor y adjunta las vigentes a cada pedido de co-firma al
// signer, que decide por su cuenta (pausa por MISMATCH, gracia por UNREACHABLE, fail-closed sin atestación). También
// las usa el registro de `integrity_status` y el estado público de la cooperación. Una atestación que no verifica no se
// usa ni se registra.
import type { KeyObject } from 'node:crypto';
import { calculateJwkThumbprint, compactVerify, exportJWK } from 'jose';
import { z } from 'zod';

export const INTEGRITY_APPS = ['WALLET', 'RECOVERY'] as const;
export type IntegrityApp = (typeof INTEGRITY_APPS)[number];

export const IntegrityAttestationSchema = z.object({
  platformId: z.string(),
  app: z.enum(INTEGRITY_APPS),
  environment: z.enum(['local', 'staging', 'production']),
  releaseId: z.string().min(1).max(128),
  manifestSha256: z.string().regex(/^0x[0-9a-f]{64}$/),
  status: z.enum(['OK', 'MISMATCH', 'UNREACHABLE']),
  observedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
});
export type IntegrityAttestation = z.infer<typeof IntegrityAttestationSchema>;

export interface VerifiedAttestation {
  token: string;
  attestation: IntegrityAttestation;
}

export interface IntegrityMonitorClientOptions {
  url: string;
  publicKey: KeyObject;
  platformId: string;
  environment: 'local' | 'staging' | 'production';
  timeoutMs?: number;
  /** Cuánto se reutiliza la última respuesta (el monitor renueva cada 60 s). */
  cacheMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export class IntegrityMonitorClient {
  readonly #o: IntegrityMonitorClientOptions;
  #kid: Promise<string> | undefined;
  #cache: { at: number; attestations: VerifiedAttestation[] } | undefined;

  constructor(options: IntegrityMonitorClientOptions) {
    this.#o = options;
  }

  #now(): number {
    return this.#o.now?.() ?? Date.now();
  }

  async #expectedKid(): Promise<string> {
    this.#kid ??= exportJWK(this.#o.publicKey).then((jwk) => calculateJwkThumbprint(jwk));
    return this.#kid;
  }

  /** Verifica una atestación (firma, kid, formato, plataforma y entorno); `null` si no vale. */
  async verify(token: string): Promise<IntegrityAttestation | null> {
    if (token.length > 8_192 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return null;
    let header: { alg?: unknown; kid?: unknown; crit?: unknown };
    try {
      header = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')) as typeof header;
    } catch {
      return null;
    }
    if (header.alg !== 'EdDSA' || header.kid !== (await this.#expectedKid()) || header.crit !== undefined) return null;
    let payload: unknown;
    try {
      const verified = await compactVerify(token, this.#o.publicKey, { algorithms: ['EdDSA'] });
      payload = JSON.parse(Buffer.from(verified.payload).toString('utf8'));
    } catch {
      return null;
    }
    const parsed = IntegrityAttestationSchema.safeParse(payload);
    if (!parsed.success) return null;
    if (parsed.data.platformId !== this.#o.platformId || parsed.data.environment !== this.#o.environment) return null;
    return parsed.data;
  }

  /**
   * Atestaciones verificadas que entrega el monitor (como mucho una por app). Si el monitor no responde se devuelven
   * las últimas obtenidas: el signer las rechaza cuando vencen (fail-closed), no el backend. Con `fresh` no se reutiliza
   * la respuesta anterior: cada co-firma lleva lo último del monitor, para que un MISMATCH recién detectado pause en
   * el acto y no viaje un OK previo todavía vigente.
   */
  async attestations(options: { fresh?: boolean } = {}): Promise<VerifiedAttestation[]> {
    const now = this.#now();
    if (options.fresh !== true && this.#cache !== undefined && now - this.#cache.at < (this.#o.cacheMs ?? 10_000))
      return this.#cache.attestations;
    try {
      const response = await (this.#o.fetch ?? fetch)(`${this.#o.url.replace(/\/+$/, '')}/v1/attestations`, {
        signal: AbortSignal.timeout(this.#o.timeoutMs ?? 5_000),
      });
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      const body = (await response.json()) as { attestations?: Record<string, unknown> };
      const verified: VerifiedAttestation[] = [];
      for (const token of Object.values(body.attestations ?? {})) {
        if (typeof token !== 'string') continue;
        const attestation = await this.verify(token);
        if (attestation !== null) verified.push({ token, attestation });
      }
      this.#cache = { at: now, attestations: verified };
      return verified;
    } catch {
      return this.#cache?.attestations ?? [];
    }
  }
}

export type CooperationState = 'ACTIVE' | 'DEGRADED' | 'PAUSED';

/** Gracia del signer ante UNREACHABLE desde el último OK (P20.T03) y antigüedad máxima de una atestación. */
export const UNREACHABLE_GRACE_SECONDS = 15 * 60;
export const ATTESTATION_MAX_AGE_SECONDS = 5 * 60;

/**
 * Estado de la cooperación como lo decide el signer, para mostrarlo (el signer es la autoridad): PAUSED si alguna app
 * está en MISMATCH, sin atestación vigente o UNREACHABLE más allá de la gracia; DEGRADED si alguna está UNREACHABLE
 * dentro de la gracia; ACTIVE si las dos están OK.
 */
export function cooperationState(
  latest: Partial<Record<IntegrityApp, IntegrityAttestation>>,
  lastOk: Partial<Record<IntegrityApp, number>>,
  nowSeconds: number,
): CooperationState {
  let degraded = false;
  for (const app of INTEGRITY_APPS) {
    const attestation = latest[app];
    if (attestation === undefined) return 'PAUSED';
    if (attestation.expiresAt <= nowSeconds || nowSeconds - attestation.observedAt > ATTESTATION_MAX_AGE_SECONDS) {
      return 'PAUSED';
    }
    if (attestation.status === 'MISMATCH') return 'PAUSED';
    if (attestation.status === 'UNREACHABLE') {
      const ok = lastOk[app];
      if (ok === undefined || nowSeconds - ok > UNREACHABLE_GRACE_SECONDS) return 'PAUSED';
      degraded = true;
    }
  }
  return degraded ? 'DEGRADED' : 'ACTIVE';
}
