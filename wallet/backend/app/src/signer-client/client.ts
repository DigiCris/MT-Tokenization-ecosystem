// Cliente mTLS del backend hacia un shard del signer [B-SIG-01] (P11.T02): HTTPS con certificado de cliente del
// backend, CA privada del entorno, TLS 1.3 y verificación del certificado del shard. Los errores del signer llegan
// tipificados ({code, reason, retryable}); un corte de red o de TLS es SIGNER_UNAVAILABLE (reintentable, [B-Q-03]).
// Nunca loguea cuerpos (llevan el token de PlatformSession y firmas).
import { readFileSync } from 'node:fs';
import { Agent, request } from 'node:https';
import type { Address, Hex } from 'viem';

export class SignerClientError extends Error {
  override name = 'SignerClientError';
  readonly code: string;
  readonly reason: string | undefined;
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(
    code: string,
    options: { reason?: string; retryable: boolean; status?: number | undefined; cause?: unknown },
  ) {
    super(
      options.reason === undefined ? code : `${code}: ${options.reason}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.code = code;
    this.reason = options.reason;
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

export interface SignerTls {
  ca: Buffer;
  cert: Buffer;
  key: Buffer;
}

export function readSignerTls(paths: { caPath: string; certPath: string; keyPath: string }): SignerTls {
  return { ca: readFileSync(paths.caPath), cert: readFileSync(paths.certPath), key: readFileSync(paths.keyPath) };
}

export interface SignerHealth {
  provider: string;
  shardId: string;
  ready: boolean;
  problems: string[];
  keys: { active: number; broken: number };
  platform: boolean;
  policyVersion: number;
  attestationKid: string;
}

export interface CreatedSignerKey {
  keyRef: string;
  address: Address;
  shardId: string;
  attestation?: string;
  purpose?: 'GAS_TANK';
}

export interface SignedExecution {
  operationId: string;
  safeTxHash: Hex;
  executor: Address;
  sSignature: Hex;
  signedTx: Hex;
  txHash: Hex;
  accountNonce: string;
  gasLimit: string;
}

export interface SignedPlatformTx {
  from: Address;
  signedTx: Hex;
  txHash: Hex;
  accountNonce: string;
  gasLimit: string;
}

export class SignerClient {
  readonly shardId: string;
  readonly url: URL;
  readonly #agent: Agent;
  readonly #timeoutMs: number;

  constructor(options: { shardId: string; url: string; tls: SignerTls; timeoutMs?: number }) {
    this.shardId = options.shardId;
    this.url = new URL(options.url);
    if (this.url.protocol !== 'https:') throw new TypeError('el signer se alcanza sólo por https (mTLS)');
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#agent = new Agent({
      ca: options.tls.ca,
      cert: options.tls.cert,
      key: options.tls.key,
      minVersion: 'TLSv1.3',
      keepAlive: true,
      maxSockets: 8,
    });
  }

  close(): void {
    this.#agent.destroy();
  }

  async #request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<T>((resolvePromise, reject) => {
      const req = request(
        new URL(path, this.url),
        {
          method,
          agent: this.#agent,
          headers:
            payload === undefined
              ? {}
              : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json: unknown;
            try {
              json = JSON.parse(text);
            } catch {
              reject(new SignerClientError('SIGNER_BAD_RESPONSE', { retryable: true, status: res.statusCode }));
              return;
            }
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) {
              resolvePromise(json as T);
              return;
            }
            const error = json as { code?: unknown; reason?: unknown; retryable?: unknown };
            reject(
              new SignerClientError(typeof error.code === 'string' ? error.code : 'SIGNER_ERROR', {
                ...(typeof error.reason === 'string' ? { reason: error.reason } : {}),
                retryable: error.retryable === true,
                status,
              }),
            );
          });
          res.on('error', (cause: Error) => {
            reject(new SignerClientError('SIGNER_UNAVAILABLE', { retryable: true, cause }));
          });
        },
      );
      req.setTimeout(this.#timeoutMs, () => req.destroy(new Error('timeout')));
      req.on('error', (cause: Error) => {
        reject(new SignerClientError('SIGNER_UNAVAILABLE', { retryable: true, cause }));
      });
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  health(): Promise<SignerHealth> {
    return this.#request('GET', '/v1/health');
  }

  createKey(input: {
    walletId: string | null;
    reason: 'ONBOARDING' | 'ROTATION' | 'GAS_TANK';
  }): Promise<CreatedSignerKey> {
    return this.#request('POST', '/v1/keys', input);
  }

  retireKey(input: { walletId: string; address: Address; safe: Address }): Promise<{ keyRef: string; status: string }> {
    return this.#request('POST', '/v1/keys/retire', input);
  }

  signSafeTx(body: Record<string, unknown>): Promise<SignedExecution> {
    return this.#request('POST', '/v1/sign-safe-tx', body);
  }

  signPlatformTx(body: Record<string, unknown>): Promise<SignedPlatformTx> {
    return this.#request('POST', '/v1/sign-platform-tx', body);
  }

  gasTankAddress(): Promise<{ address: Address; shardId: string }> {
    return this.#request('GET', '/v1/gas-tank');
  }
}
