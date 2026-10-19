// P19.T03: el fragmento del link de la Wallet, el objeto del enrollment firmado por la Enrollment Key (verificable con
// su JWK, como lo verifica el backend), las firmas estrictas de wallets externas y el link de regreso [F-LNK-02].
import { keccak256, recoverAddress, toBytes, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import p256Vectors from '../../test/vectors/wire/p256.json' with { type: 'json' };
import { canonicalize } from '../api/jcs.ts';
import { generateSessionKey, verifyP256 } from '../api/session-key.ts';
import { addressOfKey, signDigest } from '../crypto/secp256k1.ts';
import {
  connectorIdFor,
  EnrollmentError,
  enrollmentObject,
  parseEnrollFragment,
  returnLink,
  signEnrollmentObject,
  strictSignature,
  submission,
} from './enrollment.ts';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const R_KEY = toBytes(keccak256(toBytes('mtw-recovery-key')));
const NONCE = '0xf52df41222748caa810259ddf3579c24ea2b5990ea5a188af2419aebe24629fa' as Hex;

describe('link de la Wallet', () => {
  it('lee eid y nonce del fragmento; rechaza lo que no es un pedido', () => {
    expect(parseEnrollFragment(`#eid=9A8B7C6D-5E4F-4A3B-9C2D-1E0F9A8B7C6D&n=${NONCE}`)).toEqual({
      enrollmentId: '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d',
      nonce: NONCE,
    });
    for (const bad of ['', '#eid=x&n=0x00', `#n=${NONCE}`, '#eid=9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d&n=0x12']) {
      expect(parseEnrollFragment(bad)).toBeNull();
    }
  });

  it('el link de regreso lleva el pedido y R (EIP-55) en el fragmento', () => {
    const link = new URL(
      returnLink('https://wallet.example', '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d', addressOfKey(R_KEY)),
    );
    expect(link.pathname).toBe('/onboarding/confirm-recovery');
    expect(link.search).toBe('');
    expect(Object.fromEntries(new URLSearchParams(link.hash.slice(1)))).toEqual({
      eid: '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d',
      r: '0x7184D30100a188c9F869ccB6883392534ecD6C9d',
    });
  });
});

describe('objeto del enrollment', () => {
  it('con los campos y el orden JCS del vector; la Enrollment Key lo firma y su JWK lo verifica', async () => {
    const object = enrollmentObject({
      userId: p256Vectors.enrollment.object.userId,
      platformId: 'mtw',
      recoveryKey: addressOfKey(R_KEY),
      nonce: NONCE,
      nowMs: Date.parse('2026-10-17T12:00:01Z'),
    });
    expect(object).toEqual(p256Vectors.enrollment.object);
    expect(canonicalize({ ...object })).toBe(p256Vectors.enrollment.canonical);
    const key = await generateSessionKey();
    const signature = await signEnrollmentObject(key.privateKey, object);
    expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(await verifyP256(key.publicJwk, p256Vectors.enrollment.canonical, signature)).toBe(true);
  });
});

describe('firmas estrictas', () => {
  const digest = keccak256(toBytes('enrollment'));
  const signature = signDigest(digest, R_KEY);

  it('una firma ya estricta queda igual; v = 0/1 se lleva a 27/28', async () => {
    expect(strictSignature(signature)).toBe(signature);
    const v = Number.parseInt(signature.slice(130), 16);
    const zeroBased = `${signature.slice(0, 130)}${(v - 27).toString(16).padStart(2, '0')}` as Hex;
    expect(strictSignature(zeroBased)).toBe(signature);
    expect(await recoverAddress({ hash: digest, signature: strictSignature(zeroBased) })).toBe(addressOfKey(R_KEY));
  });

  it('una s alta (maleable) se normaliza a la baja sin cambiar el firmante', async () => {
    const s = BigInt(`0x${signature.slice(66, 130)}`);
    const v = Number.parseInt(signature.slice(130), 16);
    const high =
      `${signature.slice(0, 66)}${(N - s).toString(16).padStart(64, '0')}${(v === 27 ? 28 : 27).toString(16)}` as Hex;
    const normalized = strictSignature(high);
    expect(normalized).toBe(signature);
    expect(await recoverAddress({ hash: digest, signature: normalized })).toBe(addressOfKey(R_KEY));
  });

  it('rechaza largos, v y s imposibles', () => {
    expect(() => strictSignature('0x1234')).toThrow(EnrollmentError);
    expect(() => strictSignature(`${signature.slice(0, 130)}05` as Hex)).toThrow('v inválido');
    expect(() => strictSignature(`${signature.slice(0, 66)}${'0'.repeat(64)}1b` as Hex)).toThrow('s inválida');
  });
});

describe('envío del enrollment', () => {
  const object = enrollmentObject({
    userId: '4f1c2d9e-6b7a-4c3d-9e8f-0a1b2c3d4e5f',
    platformId: 'mtw',
    recoveryKey: addressOfKey(R_KEY),
    nonce: NONCE,
    nowMs: Date.now(),
  });
  const proof = signDigest(keccak256(toBytes('proof')), R_KEY);

  it('R interna con sus backups; R externa con su conector; KeyAcceptance sólo en un reemplazo', () => {
    const internal = submission({
      object,
      enrollmentKeySignature: 'sig',
      proofOfControl: proof,
      external: null,
      storageFlags: { drive: false, file: true, qr: false, words: true },
      keyAcceptance: null,
    });
    expect(internal).toMatchObject({ rType: 'INTERNAL', storageFlags: { file: true } });
    expect(internal).not.toHaveProperty('connectorId');
    expect(internal).not.toHaveProperty('keyAcceptance');
    const external = submission({
      object,
      enrollmentKeySignature: 'sig',
      proofOfControl: proof,
      external: { connectorId: 'io.metamask' },
      storageFlags: null,
      keyAcceptance: { nonce: NONCE, signature: proof },
    });
    expect(external).toMatchObject({ rType: 'EXTERNAL', connectorId: 'io.metamask', keyAcceptance: { nonce: NONCE } });
    expect(external).not.toHaveProperty('storageFlags');
  });

  it('una R interna sin backup independiente de la plataforma no se envía', () => {
    expect(() =>
      submission({
        object,
        enrollmentKeySignature: 'sig',
        proofOfControl: proof,
        external: null,
        storageFlags: { drive: true, file: false, qr: false, words: false },
        keyAcceptance: null,
      }),
    ).toThrow('al menos un backup');
    expect(() =>
      submission({
        object,
        enrollmentKeySignature: 'sig',
        proofOfControl: proof,
        external: null,
        storageFlags: null,
        keyAcceptance: null,
      }),
    ).toThrow(EnrollmentError);
  });

  it('ids de conector como los acepta el backend', () => {
    expect(connectorIdFor('io.metamask')).toBe('io.metamask');
    expect(connectorIdFor('walletConnect')).toBe('walletconnect');
    expect(connectorIdFor('com.coinbase.wallet')).toBe('com.coinbase.wallet');
    expect(() => connectorIdFor('!')).toThrow(EnrollmentError);
  });
});
