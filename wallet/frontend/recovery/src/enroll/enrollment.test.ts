// P19.T03: el fragmento del enlace de la Wallet (con el secreto k del pedido, ADR-033), el objeto del enrollment
// firmado por la Enrollment Key (verificable con su JWK, como lo verifica el backend), las firmas estrictas de wallets
// externas y el enlace de regreso [F-LNK-02] con el mismo k. Tercera revisión de P17.MAN: cuándo vence el pedido, el
// sobre de R recordado en este dispositivo sólo con la casilla marcada (nunca R ni la Password R) y los textos de la
// pantalla final según quede o no el sobre.
import { keccak256, recoverAddress, toBytes, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import p256Vectors from '../../test/vectors/wire/p256.json' with { type: 'json' };
import { canonicalize } from '../api/jcs.ts';
import { generateSessionKey, verifyP256 } from '../api/session-key.ts';
import { bytesToBase64Url, bytesToHex, toBufferSource } from '../crypto/encoding.ts';
import { sealRecoveryKey, type RecoveryEnvelope } from '../crypto/envelope.ts';
import type { Argon2 } from '../crypto/kdf.ts';
import { addressOfKey, signDigest } from '../crypto/secp256k1.ts';
import {
  connectorIdFor,
  EnrollmentError,
  enrollmentObject,
  enrollReturnPath,
  keepEnvelopeOnDevice,
  parseEnrollFragment,
  requestExpiryText,
  returnLink,
  signEnrollmentObject,
  strictSignature,
  submission,
} from './enrollment.ts';
import {
  NEW_R_PER_REQUEST_TEXT,
  REPLACEMENT_NEW_R_PER_REQUEST_TEXT,
  R_EXTERNAL_TEXT,
  R_KEEP_FAILED_TEXT,
  R_KEPT_TEXT,
  R_NOT_KEPT_TEXT,
  REMEMBER_R_LABEL,
  RETURN_QR_TEXT,
  RETURN_WITH_SECRET_TEXT,
  RETURN_WITHOUT_SECRET_TEXT,
} from './texts.ts';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const R_KEY = toBytes(keccak256(toBytes('mtw-recovery-key')));
const NONCE = '0xf52df41222748caa810259ddf3579c24ea2b5990ea5a188af2419aebe24629fa' as Hex;

describe('enlace de la Wallet', () => {
  const EID = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';
  const K = 'q1Zs-0bM4_Lr8xWp2cYtNg';

  it('lee eid, nonce y el secreto k del fragmento; rechaza lo que no es un pedido', () => {
    expect(parseEnrollFragment(`#eid=9A8B7C6D-5E4F-4A3B-9C2D-1E0F9A8B7C6D&n=${NONCE}&k=${K}`)).toEqual({
      enrollmentId: EID,
      nonce: NONCE,
      secret: K,
    });
    // Sin k el pedido sigue valiendo (sin enlace de regreso: la dirección se copia a mano en la Wallet).
    expect(parseEnrollFragment(`#eid=${EID}&n=${NONCE}`)).toEqual({ enrollmentId: EID, nonce: NONCE, secret: null });
    for (const bad of [
      '',
      '#eid=x&n=0x00',
      `#n=${NONCE}`,
      `#eid=${EID}&n=0x12`,
      // Un k que no es el de la Wallet (otro largo o caracteres fuera de base64url): el enlace no es válido.
      `#eid=${EID}&n=${NONCE}&k=corto`,
      `#eid=${EID}&n=${NONCE}&k=${K}A`,
      `#eid=${EID}&n=${NONCE}&k=${K.slice(0, 21)}+`,
    ]) {
      expect(parseEnrollFragment(bad)).toBeNull();
    }
  });

  it('volver a esta pantalla después de Drive conserva el pedido con su k', () => {
    const path = enrollReturnPath({ enrollmentId: EID, nonce: NONCE, secret: K });
    expect(path.startsWith('/enroll#')).toBe(true);
    expect(parseEnrollFragment(path.slice('/enroll'.length))).toEqual({ enrollmentId: EID, nonce: NONCE, secret: K });
    expect(enrollReturnPath({ enrollmentId: EID, nonce: NONCE, secret: null })).not.toContain('k=');
  });

  it('el enlace de regreso lleva el pedido, R (EIP-55) y el mismo k en el fragmento', () => {
    const link = new URL(returnLink('https://wallet.example', { enrollmentId: EID, secret: K }, addressOfKey(R_KEY)));
    expect(link.pathname).toBe('/onboarding/confirm-recovery');
    expect(link.search).toBe('');
    expect(Object.fromEntries(new URLSearchParams(link.hash.slice(1)))).toEqual({
      eid: EID,
      r: '0x7184D30100a188c9F869ccB6883392534ecD6C9d',
      k: K,
    });
    // Sin k en el enlace de ida, el de regreso tampoco lo traería (la Wallet lo cancelaría: la pantalla no lo ofrece).
    const withoutSecret = new URL(
      returnLink('https://wallet.example', { enrollmentId: EID, secret: null }, addressOfKey(R_KEY)),
    );
    expect(new URLSearchParams(withoutSecret.hash.slice(1)).has('k')).toBe(false);
    expect(() => returnLink('https://wallet.example', { enrollmentId: EID, secret: K }, '0x1234')).toThrow(
      EnrollmentError,
    );
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

describe('vencimiento del pedido (hallazgo 3)', () => {
  it('la hora en que vence el pedido de la Wallet, la que informa el backend, en el huso del dispositivo', () => {
    expect(requestExpiryText('2026-10-25T15:25:00.000Z', 'America/Argentina/Buenos_Aires')).toBe(
      'Este pedido de la app Wallet vence a las 12:25: enviá la dirección antes.',
    );
    expect(requestExpiryText('2026-10-25T15:05:00Z', 'UTC')).toBe(
      'Este pedido de la app Wallet vence a las 15:05: enviá la dirección antes.',
    );
    expect(requestExpiryText('2026-10-25T15:05:00Z')).toMatch(/vence a las \d{2}:\d{2}: enviá la dirección antes\.$/);
  });
});

describe('el sobre de R en este dispositivo al enviar la dirección ([F-KEY-07], bloqueante)', () => {
  /** Argon2id de prueba (rápido): el sobre se arma con el código de la app, sin pagar 64 MiB. */
  const fastArgon2: Argon2 = async ({ password, salt }) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', toBufferSource(new Uint8Array([...password, ...salt]))));
  const WALLET = '7d2e3f40-1a2b-4c5d-8e9f-a0b1c2d3e4f5';
  const PASSWORD_R = 'acorn violet marble tundra zebra';

  /** Lo que guardaría el storage, como lo guarda envelope-cache.ts (el JSON del sobre por wallet). */
  function fakeStore() {
    const stored = new Map<string, string>();
    const forgotten: string[] = [];
    return {
      stored,
      forgotten,
      store: {
        remember: (envelope: RecoveryEnvelope) => {
          stored.set(`${envelope.walletId}:${envelope.keyAddress}`, JSON.stringify(envelope));
          return Promise.resolve();
        },
        forget: (walletId: string) => {
          forgotten.push(walletId);
          for (const key of [...stored.keys()]) if (key.startsWith(`${walletId}:`)) stored.delete(key);
          return Promise.resolve();
        },
      },
    };
  }

  async function sealed() {
    const key = R_KEY.slice();
    const opened = await sealRecoveryKey(
      key,
      PASSWORD_R,
      { platformId: 'mtw', walletId: WALLET, keyVersion: 1 },
      fastArgon2,
    );
    return opened.envelope;
  }

  it('con la casilla marcada queda sólo el sobre cifrado: nunca R ni la Password R', async () => {
    const envelope = await sealed();
    const { stored, forgotten, store } = fakeStore();
    stored.set(`${WALLET}:0xde-un-pedido-anterior`, '{"de":"un pedido anterior"}');
    expect(await keepEnvelopeOnDevice(envelope, { remember: true, purpose: 'ONBOARDING' }, store)).toBe(true);
    // En el onboarding no queda el sobre de la R de un pedido anterior, sólo el de la nueva.
    expect(forgotten).toEqual([WALLET]);
    expect([...stored.keys()]).toEqual([`${WALLET}:${envelope.keyAddress}`]);
    const saved = stored.get(`${WALLET}:${envelope.keyAddress}`) ?? '';
    expect(JSON.parse(saved)).toEqual(envelope);
    // Ni la clave (hex con o sin 0x, base64url) ni la Password R (completa o sus palabras) aparecen en lo guardado.
    const keyHex = bytesToHex(R_KEY).slice(2);
    for (const secret of [
      keyHex,
      keyHex.toUpperCase(),
      bytesToBase64Url(R_KEY),
      PASSWORD_R,
      ...PASSWORD_R.split(' '),
    ]) {
      expect(saved).not.toContain(secret);
    }
  });

  it('sin marcar no se guarda nada; en el onboarding se borra el sobre de un pedido anterior, en un reemplazo no', async () => {
    const envelope = await sealed();
    const onboarding = fakeStore();
    onboarding.stored.set(`${WALLET}:0xde-un-pedido-anterior`, '{"de":"un pedido anterior"}');
    expect(await keepEnvelopeOnDevice(envelope, { remember: false, purpose: 'ONBOARDING' }, onboarding.store)).toBe(
      false,
    );
    expect(onboarding.forgotten).toEqual([WALLET]);
    expect(onboarding.stored.size).toBe(0);
    const replacement = fakeStore();
    replacement.stored.set(`${WALLET}:0xde-la-r-vigente`, '{"de":"la R vigente"}');
    expect(await keepEnvelopeOnDevice(envelope, { remember: false, purpose: 'REPLACEMENT' }, replacement.store)).toBe(
      false,
    );
    expect(replacement.forgotten).toEqual([]);
    expect(replacement.stored.get(`${WALLET}:0xde-la-r-vigente`)).toBe('{"de":"la R vigente"}');
  });

  it('en un reemplazo, el sobre de R′ queda junto al de la R vigente (hasta las 48 h, la vigente cancela rotaciones)', async () => {
    const envelope = await sealed();
    const replacement = fakeStore();
    replacement.stored.set(`${WALLET}:0xde-la-r-vigente`, '{"de":"la R vigente"}');
    expect(await keepEnvelopeOnDevice(envelope, { remember: true, purpose: 'REPLACEMENT' }, replacement.store)).toBe(
      true,
    );
    expect(replacement.forgotten).toEqual([]);
    expect(replacement.stored.get(`${WALLET}:0xde-la-r-vigente`)).toBe('{"de":"la R vigente"}');
    expect(JSON.parse(replacement.stored.get(`${WALLET}:${envelope.keyAddress}`) ?? '')).toEqual(envelope);
  });

  it('si el dispositivo no deja guardarlo, el error llega a quien lo pidió (la pantalla no dice que quedó)', async () => {
    const envelope = await sealed();
    const failing = {
      remember: () => Promise.reject(new Error('IndexedDB no disponible')),
      forget: () => Promise.resolve(),
    };
    await expect(keepEnvelopeOnDevice(envelope, { remember: true, purpose: 'ONBOARDING' }, failing)).rejects.toThrow(
      'IndexedDB',
    );
  });

  it('textos de la pantalla final: ciertos con el sobre recordado, sin recordarlo y con una wallet externa', () => {
    expect(REMEMBER_R_LABEL).toBe(
      'Recordar el sobre cifrado de R en este dispositivo (nunca la clave ni la Password R). Si el dispositivo es compartido, desmarcalo.',
    );
    // Nada dice que R «vive» o «queda» en la app sin el sobre recordado.
    expect(R_NOT_KEPT_TEXT).toContain('Esta app no la guarda');
    expect(R_NOT_KEPT_TEXT).toContain('al cerrar la pestaña, al tocar «Bloquear» o después de 5 minutos sin uso');
    expect(R_NOT_KEPT_TEXT).toContain('uno de sus backups (el archivo o el QR con la Password R, o las 17 palabras)');
    expect(R_KEPT_TEXT).toContain('Queda cifrada en este dispositivo (sólo se abre con tu Password R)');
    expect(R_KEPT_TEXT).toContain('igual necesitás sus backups fuera de él');
    expect(R_KEEP_FAILED_TEXT).toContain('No se pudo recordar el sobre cifrado de R');
    expect(R_EXTERNAL_TEXT).toContain('wallet externa');
    for (const text of [R_KEPT_TEXT, R_NOT_KEPT_TEXT, R_EXTERNAL_TEXT]) {
      expect(text).toContain('a la plataforma sólo le llegó su dirección');
      expect(text).not.toMatch(/vive en esta app|queda en esta app/);
    }
    // Los 10 grupos son los que siguen al «0x»; sin k no hay enlace de regreso.
    expect(RETURN_WITH_SECRET_TEXT).toContain('los 10 grupos que siguen al «0x»');
    expect(RETURN_WITHOUT_SECRET_TEXT).toContain('acá no hay enlace de regreso');
    expect(RETURN_WITHOUT_SECRET_TEXT).toContain('los 10 grupos que siguen al «0x»');
    expect(RETURN_QR_TEXT).toMatch(/^Si la Wallet está en tu celular, escaneá este QR con él/);
    expect(REPLACEMENT_NEW_R_PER_REQUEST_TEXT).toContain(
      'Los de tu R actual, no: sigue siendo tu clave de recuperación (y puede cancelar el reemplazo) hasta que se ejecute.',
    );
    expect(NEW_R_PER_REQUEST_TEXT).toBe(
      'Cada pedido crea una clave R nueva: si creaste otra para un pedido anterior, destruí sus backups.',
    );
  });
});
