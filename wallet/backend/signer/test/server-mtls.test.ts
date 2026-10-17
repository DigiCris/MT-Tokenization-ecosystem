// P11.T02 [B-SIG-01]/[B-SIG-07]: API mTLS del signer. Sin certificado de cliente, con uno de otra CA o con TLS 1.2 el
// handshake se corta; con un certificado de la CA pero de otro servicio, 403; con el del backend, la API responde.
// POST /v1/keys crea S en un keystore cifrado y devuelve una SignerKeyAttestation verificable con la clave pública de
// atestación (idempotente en el onboarding).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pinnedKeys } from '../src/crypto/jws.ts';
import { verifySignerKeyAttestation } from '../src/policy/attestations.ts';
import { mtlsRequest } from './helpers/https.ts';
import { startHarness, type SignerHarness } from './helpers/signer.ts';

let h: SignerHarness;

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await (h as SignerHarness | undefined)?.close();
});

async function handshakeError(options: Parameters<typeof mtlsRequest>[1]): Promise<string> {
  try {
    const response = await mtlsRequest(`${h.url}/v1/health`, options);
    return `HTTP ${response.status}`;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? (error as Error).message;
  }
}

describe('transporte mTLS', () => {
  it('con el certificado del backend responde la salud del shard', async () => {
    const response = await h.client.get('/v1/health');
    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({
      provider: 'development',
      shardId: 'dev-1',
      ready: true,
      policyVersion: 1,
      platform: false,
    });
  });

  it('sin certificado de cliente el handshake falla', async () => {
    expect(await handshakeError({ ca: h.pki.ca })).not.toMatch(/^HTTP/);
  });

  it('con un certificado de otra CA el handshake falla', async () => {
    expect(
      await handshakeError({ ca: h.pki.ca, cert: h.pki.foreignClient.cert, key: h.pki.foreignClient.key }),
    ).not.toMatch(/^HTTP/);
  });

  it('con TLS 1.2 el handshake falla (sólo TLS 1.3)', async () => {
    expect(
      await handshakeError({ ca: h.pki.ca, cert: h.pki.client.cert, key: h.pki.client.key, maxVersion: 'TLSv1.2' }),
    ).not.toMatch(/^HTTP/);
  });

  it('con un certificado de la CA pero de otro servicio: 403 UNAUTHORIZED_CLIENT', async () => {
    const response = await mtlsRequest(`${h.url}/v1/health`, {
      ca: h.pki.ca,
      cert: h.pki.wrongNameClient.cert,
      key: h.pki.wrongNameClient.key,
    });
    expect(response.status).toBe(403);
    expect(response.json()).toEqual({ code: 'UNAUTHORIZED_CLIENT', retryable: false });
  });

  it('cuerpo inválido, demasiado grande o no JSON → 400 sin efectos', async () => {
    expect((await h.client.post('/v1/keys', { walletId: 'no-uuid', reason: 'ONBOARDING' })).status).toBe(400);
    expect(
      (await h.client.post('/v1/keys', { walletId: crypto.randomUUID(), reason: 'ONBOARDING', extra: 1 })).status,
    ).toBe(400);
    const big = await mtlsRequest(`${h.url}/v1/keys`, {
      ca: h.pki.ca,
      cert: h.pki.client.cert,
      key: h.pki.client.key,
      rawBody: JSON.stringify({ walletId: crypto.randomUUID(), reason: 'ONBOARDING', pad: 'x'.repeat(70_000) }),
    });
    expect([400, 413]).toContain(big.status);
    const notJson = await mtlsRequest(`${h.url}/v1/keys`, {
      ca: h.pki.ca,
      cert: h.pki.client.cert,
      key: h.pki.client.key,
      rawBody: '{nope',
    });
    expect(notJson.status).toBe(400);
    expect(await h.db.db.selectFrom('signer_keys').selectAll().execute()).toEqual([]);
  });

  it('el shard de S no expone las rutas del gas tank', async () => {
    expect((await h.client.get('/v1/gas-tank')).json()).toMatchObject({ code: 'NOT_FOUND' });
    expect((await h.client.post('/v1/keys', { walletId: null, reason: 'GAS_TANK' })).status).toBe(400);
  });
});

describe('POST /v1/keys', () => {
  it('crea S con una SignerKeyAttestation verificable; el onboarding es idempotente y la rotación crea otra', async () => {
    const walletId = crypto.randomUUID();
    const first = await h.client.post('/v1/keys', { walletId, reason: 'ONBOARDING' });
    expect(first.status).toBe(200);
    const body = first.json() as { keyRef: string; address: string; shardId: string; attestation: string };
    expect(body.shardId).toBe('dev-1');
    const claims = await verifySignerKeyAttestation(body.attestation, pinnedKeys(h.keys.attestation.publicKey), {
      walletId,
      executor: body.address as `0x${string}`,
    });
    expect(claims).toMatchObject({ walletId, shardId: 'dev-1', chainId: 8453 });

    const again = (await h.client.post('/v1/keys', { walletId, reason: 'ONBOARDING' })).json() as typeof body;
    expect(again.address).toBe(body.address);
    const rotated = (await h.client.post('/v1/keys', { walletId, reason: 'ROTATION' })).json() as typeof body;
    expect(rotated.address).not.toBe(body.address);
    expect(
      await verifySignerKeyAttestation(rotated.attestation, pinnedKeys(h.keys.attestation.publicKey), {
        walletId,
        executor: rotated.address as `0x${string}`,
      }),
    ).toBeDefined();

    // La atestación no es intercambiable entre wallets ni claves.
    expect(
      await verifySignerKeyAttestation(body.attestation, pinnedKeys(h.keys.attestation.publicKey), {
        walletId: crypto.randomUUID(),
        executor: body.address as `0x${string}`,
      }),
    ).toBeUndefined();
    // Ninguna respuesta incluye material privado.
    expect(Object.keys(body).sort()).toEqual(['address', 'attestation', 'keyRef', 'shardId']);
  });
});
