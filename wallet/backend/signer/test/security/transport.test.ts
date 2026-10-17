// P11.SEC: mTLS obligatorio (sin HTTP plano, sin certificado de cliente, con certificado de otra CA o con TLS 1.2 no
// hay respuesta) y signer sin puertos publicados: en local escucha sólo en 127.0.0.1 y ningún servicio de los compose
// del repo publica el signer; en los compose de producción (P26) sólo está en la red `signer` interna.
import { existsSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.ts';
import { mtlsRequest } from '../helpers/https.ts';
import { WALLET_ROOT } from '../helpers/paths.ts';
import { startHarness, type SignerHarness } from '../helpers/signer.ts';

let h: SignerHarness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await (h as SignerHarness | undefined)?.close();
});

async function outcome(fn: () => Promise<{ status: number }>): Promise<string> {
  try {
    return `HTTP ${(await fn()).status}`;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? 'ERROR';
  }
}

describe('mTLS obligatorio', () => {
  it('HTTP plano no obtiene respuesta de la API', async () => {
    const port = new URL(h.url).port;
    const result = await new Promise<string>((resolveResult) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/v1/health', method: 'GET' }, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => {
          resolveResult(`HTTP ${res.statusCode ?? 0} ${body.includes('ready') ? 'API' : ''}`);
        });
      });
      req.on('error', (e: NodeJS.ErrnoException) => {
        resolveResult(e.code ?? 'ERROR');
      });
      req.end();
    });
    expect(result).not.toMatch(/API/);
  });

  it('sin certificado, con uno de otra CA o con TLS 1.2: sin respuesta HTTP', async () => {
    const url = `${h.url}/v1/health`;
    expect(await outcome(() => mtlsRequest(url, { ca: h.pki.ca }))).not.toMatch(/^HTTP/);
    expect(
      await outcome(() =>
        mtlsRequest(url, { ca: h.pki.ca, cert: h.pki.foreignClient.cert, key: h.pki.foreignClient.key }),
      ),
    ).not.toMatch(/^HTTP/);
    expect(
      await outcome(() =>
        mtlsRequest(url, { ca: h.pki.ca, cert: h.pki.client.cert, key: h.pki.client.key, maxVersion: 'TLSv1.2' }),
      ),
    ).not.toMatch(/^HTTP/);
    expect(
      await outcome(() => mtlsRequest(url, { ca: h.pki.ca, cert: h.pki.client.cert, key: h.pki.client.key })),
    ).toBe('HTTP 200');
  });
});

describe('sin puertos publicados', () => {
  it('en local escucha sólo en loopback por defecto; en staging/producción exige secretos por archivo', () => {
    expect(h.config.host).toBe('127.0.0.1');
    expect(() => loadConfig({ env: { APP_ENV: 'production', SIGNER_PROVIDER: 'development' }, envFile: null })).toThrow(
      /development sólo con APP_ENV=local/,
    );
  });

  it('ningún compose del repo publica el signer; en producción sólo la red interna `signer`', () => {
    const local = readFileSync(resolve(WALLET_ROOT, 'docker-compose.yml'), 'utf8');
    expect(local).not.toMatch(/signer[^\n]*:\n(?:\s+.*\n)*?\s+ports:/);
    for (const file of ['infra/production/docker-compose.production.yml']) {
      const path = resolve(WALLET_ROOT, file);
      if (!existsSync(path)) continue;
      const text = readFileSync(path, 'utf8');
      const services = text.split(/\n(?= {2}[a-z0-9-]+:\n)/).filter((block) => /^\s{2}signer-shard-/m.test(block));
      expect(services.length).toBeGreaterThan(0);
      for (const block of services) {
        expect(block).not.toMatch(/\n\s+ports:/);
        expect(block).toMatch(/networks:\s*\n\s+-\s*signer/);
      }
      expect(text).toMatch(/\n {2}signer:\n(?:\s+.*\n)*?\s+internal: true/);
    }
  });
});
