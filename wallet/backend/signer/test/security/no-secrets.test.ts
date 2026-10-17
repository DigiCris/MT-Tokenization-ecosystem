// P11.SEC: S nunca en la DB del signer, en los logs ni en la API; tampoco la credencial de desbloqueo, las contraseñas
// derivadas de los keystores ni los tokens de sesión. Keystores 0400 del UID del signer en un directorio 0700 y la
// credencial en un archivo separado (fuera del directorio de keystores) 0600/0400.
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex } from '../../src/crypto/bytes.ts';
import { deriveKeystorePassword } from '../../src/keystore/derive-password.ts';
import { decryptKeystore } from '../../src/keystore/v3.ts';
import { safeTx, testAccount } from '../helpers/chain.ts';
import { createWallet, signRequest, transferData, usdc, whitelistSovereign, type Wallet } from '../helpers/flow.ts';
import { startHarness, type SignerHarness } from '../helpers/signer.ts';

let h: SignerHarness;
let w: Wallet;
const responses: string[] = [];
const DEST = testAccount().address;

beforeAll(async () => {
  h = await startHarness();
  w = await createWallet(h);
  await whitelistSovereign(h, w, DEST);
  const keys = await h.client.post('/v1/keys', { walletId: crypto.randomUUID(), reason: 'ONBOARDING' });
  responses.push(keys.text);
  const request = await signRequest(
    h,
    w,
    safeTx(usdc(h), transferData(DEST, 1_000_000n), await h.chain.safeNonce(w.safe)),
    { operationType: 'SEND' },
  );
  const signed = await h.client.post('/v1/sign-safe-tx', request);
  expect(signed.status).toBe(200);
  responses.push(signed.text, (await h.client.get('/v1/health')).text, (await h.client.get('/v1/metrics')).text);
  // Un rechazo también queda en logs: el token no debe aparecer.
  responses.push((await h.client.post('/v1/sign-safe-tx', { ...request, ownerRole: 'R' })).text);
  (globalThis as { token?: string }).token = request.platformSessionToken as string;
});
afterAll(async () => {
  await (h as SignerHarness | undefined)?.close();
});

describe('S y la credencial nunca salen del keystore', () => {
  it('ni la DB, ni los logs, ni las respuestas contienen claves, contraseñas derivadas, la credencial o tokens', async () => {
    const credential = h.ws.credential();
    const credentialHex = readFileSync(h.ws.credentialFile, 'utf8').trim();
    const canaries: string[] = [credentialHex, (globalThis as { token?: string }).token!];
    for (const file of readdirSync(h.ws.keystoreDir)) {
      const address = file.replace(/\.json$/, '') as `0x${string}`;
      const password = deriveKeystorePassword(credential, address);
      const key = decryptKeystore(
        JSON.parse(readFileSync(join(h.ws.keystoreDir, file), 'utf8')) as unknown,
        password,
        address,
      );
      canaries.push(bytesToHex(key).slice(2), Buffer.from(password).toString('utf8'));
    }
    expect(canaries.length).toBeGreaterThanOrEqual(6);
    const tables = [
      'signer_shards',
      'signer_keys',
      'key_events',
      'policy_state',
      'signed_safe_txs',
      'exec_signatures',
      'platform_txs',
    ];
    const dump = (
      await Promise.all(
        tables.map((t) =>
          h.db.admin<{ dump: string | null }>(`SELECT string_agg(row_to_json(x)::text, ' ') AS dump FROM ${t} x`),
        ),
      )
    )
      .map((r) => r.rows[0]?.dump ?? '')
      .join(' ')
      .toLowerCase();
    const logs = h.logs.output().toLowerCase();
    const api = responses.join(' ').toLowerCase();
    for (const canary of canaries) {
      const needle = canary.toLowerCase();
      expect(dump).not.toContain(needle);
      expect(logs).not.toContain(needle);
      expect(api).not.toContain(needle);
    }
  });

  it('keystores 0400 del UID del proceso en un directorio 0700; credencial separada 0600', () => {
    const uid = process.getuid?.();
    const dir = statSync(h.ws.keystoreDir);
    expect(dir.mode & 0o777).toBe(0o700);
    if (uid !== undefined) expect(dir.uid).toBe(uid);
    const files = readdirSync(h.ws.keystoreDir);
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const file of files) {
      expect(file).toMatch(/^0x[0-9a-f]{40}\.json$/);
      const st = lstatSync(join(h.ws.keystoreDir, file));
      expect(st.mode & 0o777).toBe(0o400);
      if (uid !== undefined) expect(st.uid).toBe(uid);
    }
    expect(h.ws.credentialFile.startsWith(`${h.ws.keystoreDir}/`)).toBe(false);
    expect(statSync(h.ws.credentialFile).mode & 0o077).toBe(0);
  });
});
