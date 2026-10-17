// Cliente HTTPS con certificado de cliente (mTLS) para los tests de la API del signer.
import { request } from 'node:https';

export interface MtlsClientOptions {
  ca: Buffer;
  cert?: Buffer;
  key?: Buffer;
  maxVersion?: 'TLSv1.2' | 'TLSv1.3';
}

export interface MtlsResponse {
  status: number;
  json: () => unknown;
  text: string;
}

export function mtlsRequest(
  url: string,
  options: MtlsClientOptions & { method?: 'GET' | 'POST'; body?: unknown; rawBody?: string },
): Promise<MtlsResponse> {
  return new Promise((resolveResponse, reject) => {
    const payload = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const req = request(
      url,
      {
        method: options.method ?? (payload === undefined ? 'GET' : 'POST'),
        ca: options.ca,
        ...(options.cert === undefined ? {} : { cert: options.cert }),
        ...(options.key === undefined ? {} : { key: options.key }),
        ...(options.maxVersion === undefined ? {} : { maxVersion: options.maxVersion }),
        headers: payload === undefined ? {} : { 'content-type': 'application/json' },
        agent: false,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => {
          resolveResponse({ status: res.statusCode ?? 0, text, json: () => JSON.parse(text) as unknown });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(120_000, () => req.destroy(new Error('timeout')));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export function mtlsClient(base: string, defaults: MtlsClientOptions) {
  return {
    get: (path: string) => mtlsRequest(`${base}${path}`, defaults),
    post: (path: string, body: unknown) => mtlsRequest(`${base}${path}`, { ...defaults, body }),
  };
}
