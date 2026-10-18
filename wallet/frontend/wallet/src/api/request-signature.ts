// Firma de requests críticos ([B-PSES-05], [F-SES-03]): con la PlatformSession el cliente manda `X-Platform-Session`
// (JWS), `X-Session-Timestamp` (unix en segundos; el backend acepta ±60 s), `X-Session-Nonce` (16 bytes en hex, un solo
// uso) y `X-Session-Signature` = P-256 de la session key sobre
//   MTW-REQ-V1\n{MÉTODO}\n{path con /api/v1 y query}\n{sha256 hex del cuerpo}\n{timestamp}\n{nonce}\n{platformSessionId}
// Vector: test/vectors/wire/p256.json (criticalRequest).
import { toHex, utf8 } from '../crypto/bytes.ts';
import { sha256, signP256, type SessionKey } from './session-key.ts';

export const REQUEST_SIGNATURE_VERSION = 'MTW-REQ-V1';

export interface CanonicalRequestInput {
  method: string;
  /** Path absoluto del API host, con `/api/v1` y la query si la hay. */
  path: string;
  bodySha256Hex: string;
  timestamp: number;
  nonce: string;
  platformSessionId: string;
}

export function canonicalRequest(input: CanonicalRequestInput): string {
  return [
    REQUEST_SIGNATURE_VERSION,
    input.method.toUpperCase(),
    input.path,
    input.bodySha256Hex,
    String(input.timestamp),
    input.nonce,
    input.platformSessionId,
  ].join('\n');
}

export async function bodySha256Hex(body: string): Promise<string> {
  return toHex(await sha256(utf8(body))).slice(2);
}

/** PlatformSession vigente con su session key: lo que hace falta para firmar un request crítico. */
export interface PlatformAuth {
  token: string;
  sessionId: string;
  key: SessionKey;
}

export interface SignatureClock {
  now: () => number;
  randomHex: (bytes: number) => string;
  /** Hora del servidor observada (ISO 8601) al recibir una respuesta: los relojes que se alinean la usan. */
  observe?: (serverTimeIso: string, receivedAt?: number) => void;
}

const randomHex = (bytes: number) => toHex(crypto.getRandomValues(new Uint8Array(bytes))).slice(2);

export const systemClock: SignatureClock = { now: () => Date.now(), randomHex };

/**
 * Reloj de las firmas alineado con el del servidor: `X-Session-Timestamp` y el `submittedAt` del envelope de envío
 * tienen que estar a ±60 s de la hora del backend, y un dispositivo con la hora corrida no podría operar. La diferencia
 * se estima con el `issuedAt` de cada PlatformSession recibida (precisión de segundos más la latencia: alcanza).
 */
export class ServerAlignedClock implements SignatureClock {
  #offsetMs = 0;
  readonly #local: () => number;

  constructor(local: () => number = () => Date.now()) {
    this.#local = local;
  }

  readonly now = (): number => this.#local() + this.#offsetMs;

  readonly randomHex = randomHex;

  readonly observe = (serverTimeIso: string, receivedAt: number = this.#local()): void => {
    const server = Date.parse(serverTimeIso);
    if (Number.isFinite(server)) this.#offsetMs = server - receivedAt;
  };

  get offsetMs(): number {
    return this.#offsetMs;
  }
}

export async function criticalHeaders(
  auth: PlatformAuth,
  method: string,
  path: string,
  body: string,
  clock: SignatureClock = systemClock,
): Promise<Record<string, string>> {
  const timestamp = Math.floor(clock.now() / 1000);
  const nonce = clock.randomHex(16);
  const canonical = canonicalRequest({
    method,
    path,
    bodySha256Hex: await bodySha256Hex(body),
    timestamp,
    nonce,
    platformSessionId: auth.sessionId,
  });
  return {
    'X-Platform-Session': auth.token,
    'X-Session-Timestamp': String(timestamp),
    'X-Session-Nonce': nonce,
    'X-Session-Signature': await signP256(auth.key.privateKey, canonical),
  };
}
