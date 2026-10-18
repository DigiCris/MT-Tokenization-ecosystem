// P14.T02: validación de destinos de whitelist con el snapshot de policy firmado (direcciones del sistema y tokens):
// EIP-55, ≠ dirección cero, ≠ la propia Safe, ≠ contratos del sistema y de Safe, ≠ tokens. El duplicado lo controla el
// servicio contra la base (test de integración del flujo).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPolicySnapshot, type BackendPolicySnapshot } from '../../src/policy/snapshot.ts';
import { validateDestination } from '../../src/whitelist/validation.ts';
import { edKey, vectorSystem, writePolicySnapshot } from '../helpers/signer-shard.ts';

let dir: string;
let snapshot: BackendPolicySnapshot;
const SAFE = getAddress('0x8335f4f8b46d8d3db0ad0f1e2c4a7e6e9e3b5f71');
const DESTINATION = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mtw-destinations-'));
  const key = edKey();
  snapshot = loadPolicySnapshot(writePolicySnapshot(dir, key, vectorSystem()), key.publicKey, 'local');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('validación de destinos', () => {
  it('acepta minúsculas o el checksum EIP-55 exacto y devuelve siempre la forma con checksum', () => {
    const checksummed = getAddress(DESTINATION);
    expect(validateDestination(DESTINATION, { safe: SAFE, snapshot })).toEqual({ ok: true, destination: checksummed });
    expect(validateDestination(checksummed, { safe: SAFE, snapshot })).toEqual({ ok: true, destination: checksummed });
  });

  it('rechaza un checksum alterado (una letra con otra capitalización) y las mayúsculas sin checksum', () => {
    const checksummed = getAddress(DESTINATION);
    const index = checksummed.split('').findIndex((c, i) => i > 1 && /[a-f]/.test(c));
    const flipped = `${checksummed.slice(0, index)}${(checksummed[index] ?? '').toUpperCase()}${checksummed.slice(index + 1)}`;
    expect(flipped).not.toBe(checksummed);
    expect(validateDestination(flipped, { safe: SAFE, snapshot })).toEqual({ ok: false, problem: 'BAD_CHECKSUM' });
    expect(validateDestination(`0x${DESTINATION.slice(2).toUpperCase()}`, { safe: SAFE, snapshot })).toEqual({
      ok: false,
      problem: 'BAD_CHECKSUM',
    });
  });

  it('rechaza formatos inválidos', () => {
    for (const input of ['', '0x', 'd8da6bf26964af9d7eed9e03e53415d37aa96045', `${DESTINATION}00`, '0xzz', ' 0xd8da']) {
      expect(validateDestination(input, { safe: SAFE, snapshot }), input).toEqual({
        ok: false,
        problem: 'INVALID_FORMAT',
      });
    }
  });

  it('rechaza la dirección cero, la propia Safe, los tokens y cada contrato del sistema', () => {
    expect(validateDestination('0x0000000000000000000000000000000000000000', { safe: SAFE, snapshot })).toEqual({
      ok: false,
      problem: 'ZERO_ADDRESS',
    });
    expect(validateDestination(SAFE.toLowerCase(), { safe: SAFE, snapshot })).toEqual({
      ok: false,
      problem: 'OWN_SAFE',
    });
    for (const token of [snapshot.tokens.USDC, snapshot.tokens.USDT]) {
      expect(validateDestination(token, { safe: SAFE, snapshot })).toEqual({ ok: false, problem: 'TOKEN_CONTRACT' });
    }
    for (const [name, address] of Object.entries(snapshot.contracts)) {
      expect(validateDestination(address, { safe: SAFE, snapshot }), name).toEqual({
        ok: false,
        problem: 'SYSTEM_CONTRACT',
      });
    }
  });
});
