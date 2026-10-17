#!/usr/bin/env node
// Vectores de los formatos de intercambio [W-02]..[W-07] (§7.15 del planner, P07.T05) en test/vectors/wire/*.json,
// sólo con node:crypto (Node 26: Argon2id, HKDF, AES-GCM, Ed25519, P-256, Keccak-256 y secp256k1 de OpenSSL).
// [W-01] (EIP-712 con secp256k1 y id de recuperación) lo genera test/fork/Vectors.t.sol.
//
// Uso: node script/wire-vectors.mjs           escribe los archivos
//      node script/wire-vectors.mjs --check   falla si regenerar cambiaría algún archivo
//
// Todo es determinístico salvo las firmas ECDSA P-256 (k aleatorio en OpenSSL y en WebCrypto): si el archivo ya tiene
// una firma válida para los mismos datos se conserva, así regenerar no produce cambios.
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTRACTS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(CONTRACTS, 'test/vectors/wire');
const WORDLIST = readFileSync(join(CONTRACTS, '../config/wordlist/mtw-wordlist-v1.txt'), 'utf8').trim().split('\n');
const system = JSON.parse(readFileSync(join(CONTRACTS, 'test/vectors/system.json'), 'utf8'));
const safeTx = JSON.parse(readFileSync(join(CONTRACTS, 'test/vectors/safe-tx.json'), 'utf8'));
const check = process.argv.includes('--check');

if (WORDLIST.length !== 65536) throw new Error(`wordlist: ${WORDLIST.length} palabras (se esperaban 65.536)`);

// ---------------------------------------------------------------------------------------------
// Utilidades

const hex = (b) => `0x${Buffer.from(b).toString('hex')}`;
const b64url = (b) => Buffer.from(b).toString('base64url');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const keccak256 = (b) => crypto.createHash('keccak-256').update(b).digest();
const utf8 = (s) => Buffer.from(s, 'utf8');

/** JSON canónico RFC 8785 (JCS) para los tipos que usan los formatos: objetos, arrays, strings, enteros, bool, null. */
export function jcs(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`JCS: sólo enteros seguros (${value})`);
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(value[k])}`).join(',')}}`;
}

/** Clave de test como en forge-std makeAddrAndKey: clave = keccak256(label). */
function testKey(label) {
  const priv = keccak256(utf8(label));
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.setPrivateKey(priv);
  const pub = ecdh.getPublicKey(null, 'uncompressed');
  const address = toChecksum(keccak256(pub.subarray(1)).subarray(12));
  return { label, priv, address };
}

function toChecksum(addrBytes) {
  const lower = Buffer.from(addrBytes).toString('hex');
  const h = keccak256(utf8(lower)).toString('hex');
  return `0x${[...lower].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('')}`;
}

function ed25519FromSeed(seed) {
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const privateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const publicJwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  return { privateKey, publicJwk };
}

function p256FromScalar(d) {
  // Clave P-256 desde un escalar fijo: se importa por JWK calculando la pública con ECDH.
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey(null, 'uncompressed');
  const jwk = { kty: 'EC', crv: 'P-256', x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33)), d: b64url(d) };
  const privateKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const publicJwk = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  return { privateKey, publicKey: crypto.createPublicKey({ key: publicJwk, format: 'jwk' }), publicJwk };
}

/** Thumbprint RFC 7638 de una JWK P-256 (base64url de SHA-256 del JSON con crv, kty, x, y en ese orden). */
const thumbprint = (jwk) => b64url(sha256(utf8(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`)));

function previous(file) {
  const p = join(OUT, file);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

/** Firma ECDSA P-256/SHA-256 (IEEE P1363 r‖s, base64url); conserva la anterior si sigue siendo válida. */
function p256Sign(key, message, prev) {
  if (prev && crypto.verify('sha256', message, { key: key.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(prev, 'base64url'))) {
    return prev;
  }
  return b64url(crypto.sign('sha256', message, { key: key.privateKey, dsaEncoding: 'ieee-p1363' }));
}

function jws(key, kid, claims) {
  const header = b64url(utf8(jcs({ alg: 'EdDSA', kid, typ: 'JWT' })));
  const payload = b64url(utf8(jcs(claims)));
  const signature = b64url(crypto.sign(null, utf8(`${header}.${payload}`), key.privateKey));
  return `${header}.${payload}.${signature}`;
}

// ---------------------------------------------------------------------------------------------
// Claves de test (las mismas labels que system.json; se verifica la derivación contra forge).

const U = testKey('mtw-user-key');
const R = testKey('mtw-recovery-key');
const S = testKey('mtw-executor-key');
for (const [k, role] of [[U, 'user'], [R, 'recovery'], [S, 'executor']]) {
  if (k.address !== system.keys[role].address) throw new Error(`derivación de ${role}: ${k.address} != ${system.keys[role].address}`);
}
const platformId = 'mtw';
const userId = '4f1c2d9e-6b7a-4c3d-9e8f-0a1b2c3d4e5f';
const walletId = '7d2e3f40-1a2b-4c5d-8e9f-a0b1c2d3e4f5';
const sessionKey = p256FromScalar(sha256(utf8('mtw-vector-session-key')));
const enrollmentKey = p256FromScalar(sha256(utf8('mtw-vector-enrollment-key')));
const issuer = ed25519FromSeed(sha256(utf8('mtw-vector-session-issuer')));
const monitor = ed25519FromSeed(sha256(utf8('mtw-vector-integrity-monitor')));
const signerAttestation = ed25519FromSeed(sha256(utf8('mtw-vector-signer-attestation')));
const releaseKey = ed25519FromSeed(sha256(utf8('mtw-vector-release-wallet')));

// ---------------------------------------------------------------------------------------------
// [W-02] Firmas P-256 de la Enrollment Key y de la session key

function p256Vectors() {
  const prev = previous('p256.json');
  const enrollment = {
    userId,
    platformId,
    R: R.address,
    nonce: hex(sha256(utf8('mtw-vector-enrollment-nonce'))),
    issuedAt: '2026-10-17T12:00:00Z',
    expiresAt: '2026-10-17T12:30:00Z',
  };
  const enrollmentCanonical = jcs(enrollment);
  const body = jcs({ token: system.contracts.usdc, amount: '1000000', destination: '0x0000000000000000000000000000000000000001' });
  const request = [
    'MTW-REQ-V1',
    'POST',
    `/api/v1/wallets/${walletId}/send/prepare`,
    sha256(utf8(body)).toString('hex'),
    '1792189400',
    'b3f1c9a2d4e5f60718293a4b5c6d7e8f',
    'sess_5c1f0e2d3b4a',
  ].join('\n');
  return {
    format: '[W-02] ECDSA P-256 (WebCrypto, SHA-256, IEEE P1363 r‖s de 64 bytes en base64url) sobre los bytes UTF-8 del mensaje',
    enrollment: {
      object: enrollment,
      canonical: enrollmentCanonical,
      sha256: hex(sha256(utf8(enrollmentCanonical))),
      publicJwk: enrollmentKey.publicJwk,
      jwkThumbprint: thumbprint(enrollmentKey.publicJwk),
      signature: p256Sign(enrollmentKey, utf8(enrollmentCanonical), prev?.enrollment?.signature),
    },
    criticalRequest: {
      body,
      canonical: request,
      sha256: hex(sha256(utf8(request))),
      publicJwk: sessionKey.publicJwk,
      jwkThumbprint: thumbprint(sessionKey.publicJwk),
      signature: p256Sign(sessionKey, utf8(request), prev?.criticalRequest?.signature),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// [W-03] Atestaciones JWS EdDSA

function jwsVectors() {
  const platformSession = {
    userId,
    safe: system.safe,
    platformId,
    sessionPublicKey: sessionKey.publicJwk,
    sessionId: 'sess_5c1f0e2d3b4a',
    issuedAt: 1792189347,
    expiresAt: 1792190247,
    scope: 'OPERATIONS',
    authMethod: 'OPAQUE_U',
    accountSessionId: 'acct_8e7d6c5b4a39',
    aud: ['mtw-api', 'mtw-signer'],
  };
  const challenge = {
    challengeId: 'chl_01a2b3c4d5e6',
    type: 'HIGH_VALUE_TX',
    userId,
    safe: system.safe,
    chainId: 8453,
    action: 'SEND',
    destination: '0x0000000000000000000000000000000000000001',
    safeTxHash: safeTx.operations[1].safeTxHash,
    token: system.contracts.usdc,
    amount: '1500000000',
    nonce: safeTx.operations[1].nonce,
    completedAt: 1792189400,
  };
  const integrity = {
    platformId,
    app: 'WALLET',
    environment: 'staging',
    releaseId: 'wallet-v1.0.0-rc.1',
    manifestSha256: hex(sha256(utf8('mtw-vector-manifest'))),
    status: 'OK',
    observedAt: 1792189347,
    expiresAt: 1792189947,
  };
  const signerKey = { walletId, shardId: 'dev-1', executor: S.address, chainId: 8453, issuedAt: 1792189347 };
  const entry = (name, key, kid, claims) => ({ name, kid, publicJwk: key.publicJwk, claims, jws: jws(key, kid, claims) });
  return {
    format: '[W-03] JWS compacto, alg EdDSA (Ed25519), kid obligatorio; header y payload en JSON canónico JCS',
    tokens: [
      entry('PlatformSession', issuer, 'mtw-session-issuer-test-1', platformSession),
      entry('ChallengeCompletion', issuer, 'mtw-session-issuer-test-1', challenge),
      entry('IntegrityAttestation', monitor, 'mtw-integrity-monitor-test-1', integrity),
      entry('SignerKeyAttestation', signerAttestation, 'mtw-signer-attestation-test-1', signerKey),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// [W-04] Release manifest

function manifestVectors() {
  const files = [
    ['index.html', '<!doctype html><title>MTW Wallet</title>'],
    ['assets/app-3f2a1b.js', 'export const app = "mtw";'],
    ['assets/app-9c8d7e.css', ':root{color-scheme:light dark}'],
  ].map(([path, content]) => ({ path, sha256: sha256(utf8(content)).toString('hex'), size: utf8(content).length }));
  const manifest = {
    app: 'wallet',
    environment: 'staging',
    releaseId: 'wallet-v1.0.0-rc.1',
    gitCommit: '17afffa171bd3d28f5096dab302e2f8e9a4d9835',
    sourceDateEpoch: 1792189347,
    files,
  };
  const bytes = utf8(jcs(manifest));
  return {
    format: '[W-04] release-manifest.json = bytes JCS del manifest; release-manifest.json.sig = base64 de la firma Ed25519 de esos bytes',
    publicJwk: releaseKey.publicJwk,
    manifest,
    manifestJson: bytes.toString('utf8'),
    manifestSha256: sha256(bytes).toString('hex'),
    signatureBase64: crypto.sign(null, bytes, releaseKey.privateKey).toString('base64'),
  };
}

// ---------------------------------------------------------------------------------------------
// [W-05] Intercambio soberano y QR multi-frame

function sovereignVectors() {
  const op = safeTx.operations.find((o) => o.opType === 'TRANSFER');
  const signers = [
    { signer: U.address, role: 'U', signature: op.signatureUser },
    { signer: R.address, role: 'R', signature: op.signatureRecovery },
  ];
  const file = {
    format: 'mtw-sovereign-safetx',
    version: 1,
    chainId: 8453,
    safe: safeTx.safe,
    safeTx: {
      to: op.to,
      value: op.value,
      data: op.data,
      operation: op.operation,
      safeTxGas: op.safeTxGas,
      baseGas: op.baseGas,
      gasPrice: op.gasPrice,
      gasToken: op.gasToken,
      refundReceiver: op.refundReceiver,
      nonce: String(op.nonce),
    },
    safeTxHash: op.safeTxHash,
    action: { type: 'SEND', params: { token: system.contracts.usdc, destination: toChecksum(Buffer.from(op.data.slice(34, 74), 'hex')), amount: '1000000' } },
    signatures: signers,
    createdAt: '2026-10-17T12:00:00Z',
  };
  const content = jcs(file);
  const digest = sha256(utf8(content)).toString('hex');
  const encoded = b64url(utf8(content));
  const chunks = encoded.match(/.{1,600}/g);
  return {
    format:
      '[W-05] archivo JSON (bytes JCS para el QR); frames MTWQR1:<i>/<n>:<sha256 hex del contenido completo>:<chunk> con i desde 1, chunk = tramo de ≤ 600 caracteres del base64url sin padding del contenido',
    file,
    content,
    contentSha256: digest,
    frames: chunks.map((c, i) => `MTWQR1:${i + 1}/${chunks.length}:${digest}:${c}`),
  };
}

// ---------------------------------------------------------------------------------------------
// [W-06] Sobres X.enc y backup humano de 17 palabras

function envelopeVectors() {
  const memoryKiB = 65536;
  const iterations = 3;
  const parallelism = 4;
  const make = (role, key, label) => {
    const passwordIdx = [...sha256(utf8(`mtw-vector-password-${role}`)).subarray(0, 10)];
    const words = [];
    for (let i = 0; i < 10; i += 2) words.push(WORDLIST[(passwordIdx[i] << 8) | passwordIdx[i + 1]]);
    const password = words.join(' ');
    const salt = sha256(utf8(`mtw-vector-salt-${role}`)).subarray(0, 16);
    const nonce = sha256(utf8(`mtw-vector-nonce-${role}`)).subarray(0, 12);
    const root = crypto.argon2Sync('argon2id', {
      message: utf8(password),
      nonce: salt,
      parallelism,
      tagLength: 32,
      memory: memoryKiB,
      passes: iterations,
    });
    const hkdf = (info) => Buffer.from(crypto.hkdfSync('sha256', root, utf8('mtw-hkdf-v1'), utf8(info), 32));
    const encKey = hkdf(`${role}-encryption-v1`);
    const keyVersion = 1;
    const aad = `mtw-key-envelope|1|${platformId}|8453|${walletId}|${role}|${key.address.toLowerCase()}|${keyVersion}`;
    const cipher = crypto.createCipheriv('aes-256-gcm', encKey, nonce);
    cipher.setAAD(utf8(aad));
    const ciphertext = Buffer.concat([cipher.update(key.priv), cipher.final(), cipher.getAuthTag()]);
    const envelope = {
      format: 'mtw-key-envelope',
      formatVersion: 1,
      platformId,
      chainId: 8453,
      walletId,
      role,
      keyAddress: key.address,
      keyVersion,
      kdf: { alg: 'argon2id', version: 19, memoryKiB, iterations, parallelism, salt: b64url(salt) },
      cipher: { alg: 'AES-256-GCM', nonce: b64url(nonce) },
      ciphertext: b64url(ciphertext),
      createdAt: '2026-10-17T12:00:00Z',
    };
    const out = {
      keyLabel: label,
      password,
      rootHex: hex(root),
      encryptionKeyHex: hex(encKey),
      aad,
      envelope,
    };
    if (role === 'U') out.authSecretHex = hex(hkdf('U-auth-v1'));
    return out;
  };
  return {
    format:
      '[F-KEY-03]/[F-KEY-04] Root = Argon2id(password, salt, m, t, p, 32); K = HKDF-SHA256(Root, "mtw-hkdf-v1", "<rol>-encryption-v1"); AuthSecret_U con info "U-auth-v1"; AES-256-GCM (ciphertext ‖ tag de 16 bytes, base64url) con el AAD indicado; el texto plano es la clave de 32 bytes de la label (keccak256(label))',
    envelopes: [make('U', U, U.label), make('R', R, R.label)],
  };
}

function backupWordsVectors() {
  const version = 1;
  const make = (role, key) => {
    const indices = [];
    for (let i = 0; i < 32; i += 2) indices.push((key.priv[i] << 8) | key.priv[i + 1]);
    const digest = sha256(Buffer.concat([utf8(`MTW-KEY-BACKUP-V1|${role}|`), key.priv]));
    const checksum12 = (digest[0] << 4) | (digest[1] >> 4);
    indices.push((version << 12) | checksum12);
    return { role, keyLabel: key.label, keyAddress: key.address, checksum12, indices, words: indices.map((i) => WORDLIST[i]) };
  };
  return {
    format:
      '[F-KEY-06] 16 palabras = la clave en tramos de 16 bits big-endian (índice en MTW-WORDLIST-V1) + w17 = (version(4 bits) << 12) | checksum12, checksum12 = primeros 12 bits de SHA-256("MTW-KEY-BACKUP-V1|" ‖ rol ‖ "|" ‖ clave de 32 bytes)',
    version,
    backups: [make('U', U), make('R', R)],
  };
}

// ---------------------------------------------------------------------------------------------
// [W-07] Matriz scope → operaciones

function scopesVectors() {
  return {
    format: '[W-07] scopes de PlatformSession y operaciones/endpoints permitidos (backend y signer la aplican igual)',
    scopes: {
      OPERATIONS: {
        app: 'Wallet',
        operations: [
          'SEND', 'SWAP_APPROVE', 'SWAP', 'APPROVE_REVOKE', 'WHITELIST_ADD', 'WHITELIST_REMOVE',
          'ROTATION_PROPOSE:U', 'ROTATION_EXECUTE:U', 'NOOP_CANCEL:U', 'MIGRATION_TRANSFER:U', 'GUARD_UPGRADE:U',
        ],
      },
      RECOVERY: {
        app: 'Recovery',
        operations: ['ROTATION_PROPOSE:R(U,S)', 'ROTATION_EXECUTE:R', 'NOOP_CANCEL:R', 'WHITELIST_REMOVE:R', 'APPROVE_REVOKE:R', 'MIGRATION_TRANSFER:R'],
      },
      U_REPLACEMENT: { app: 'Wallet', operations: ['REGISTER_U_PRIME_OPAQUE_PENDING', 'KEY_ACCEPTANCE'] },
      ENROLLMENT: { app: 'Recovery', operations: ['RECOVERY_ENROLLMENT', 'R_PRIME_ENROLLMENT'] },
      ONBOARDING: { app: 'Wallet', operations: ['REGISTER_U', 'CREATE_ENROLLMENT', 'WALLET_CREATION_AUTHORIZATION', 'DEPLOY'] },
      KEY_RESTORE: { app: 'Wallet', operations: ['USER_KEY_RESTORE'] },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Autoverificación: cada vector se comprueba por el camino inverso antes de escribirse.

function assert(cond, msg) {
  if (!cond) throw new Error(`autoverificación: ${msg}`);
}

function selfTest(o) {
  const p256Key = (jwk) => crypto.createPublicKey({ key: jwk, format: 'jwk' });
  for (const name of ['enrollment', 'criticalRequest']) {
    const v = o['p256.json'][name];
    const ok = crypto.verify('sha256', utf8(v.canonical), { key: p256Key(v.publicJwk), dsaEncoding: 'ieee-p1363' }, Buffer.from(v.signature, 'base64url'));
    assert(ok, `firma P-256 de ${name}`);
  }
  for (const t of o['jws.json'].tokens) {
    const [h, p, sig] = t.jws.split('.');
    assert(crypto.verify(null, utf8(`${h}.${p}`), crypto.createPublicKey({ key: t.publicJwk, format: 'jwk' }), Buffer.from(sig, 'base64url')), `JWS ${t.name}`);
    assert(jcs(JSON.parse(Buffer.from(p, 'base64url').toString('utf8'))) === jcs(t.claims), `payload JWS ${t.name}`);
  }
  const m = o['release-manifest.json'];
  assert(crypto.verify(null, utf8(m.manifestJson), crypto.createPublicKey({ key: m.publicJwk, format: 'jwk' }), Buffer.from(m.signatureBase64, 'base64')), 'firma del manifest');
  const sv = o['sovereign.json'];
  const parts = sv.frames.map((f) => f.split(':'));
  assert(parts.every((q) => q[0] === 'MTWQR1' && q[2] === sv.contentSha256 && q[3].length <= 600), 'formato de frames');
  const rebuilt = Buffer.from(parts.map((q) => q[3]).join(''), 'base64url').toString('utf8');
  assert(rebuilt === sv.content && sha256(utf8(rebuilt)).toString('hex') === sv.contentSha256, 'reconstrucción QR');
  for (const e of o['envelope.json'].envelopes) {
    const raw = Buffer.from(e.envelope.ciphertext, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(e.encryptionKeyHex.slice(2), 'hex'), Buffer.from(e.envelope.cipher.nonce, 'base64url'));
    decipher.setAAD(utf8(e.aad));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const plain = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]);
    const key = testKey(e.keyLabel);
    assert(plain.equals(key.priv) && key.address === e.envelope.keyAddress, `sobre ${e.envelope.role}`);
  }
  for (const b of o['backup-words.json'].backups) {
    const idx = b.words.map((w) => WORDLIST.indexOf(w));
    assert(idx.every((v, i) => v === b.indices[i]), `palabras ${b.role}`);
    const key = Buffer.alloc(32);
    for (let i = 0; i < 16; i++) key.writeUInt16BE(idx[i], i * 2);
    const digest = sha256(Buffer.concat([utf8(`MTW-KEY-BACKUP-V1|${b.role}|`), key]));
    assert(idx[16] >> 12 === 1 && (idx[16] & 0xfff) === ((digest[0] << 4) | (digest[1] >> 4)), `checksum ${b.role}`);
    assert(testKey(b.keyLabel).priv.equals(key), `clave desde palabras ${b.role}`);
  }
}

// ---------------------------------------------------------------------------------------------

const outputs = {
  'p256.json': p256Vectors(),
  'jws.json': jwsVectors(),
  'release-manifest.json': manifestVectors(),
  'sovereign.json': sovereignVectors(),
  'envelope.json': envelopeVectors(),
  'backup-words.json': backupWordsVectors(),
  'scopes.json': scopesVectors(),
};

selfTest(outputs);
mkdirSync(OUT, { recursive: true });
let stale = [];
for (const [file, value] of Object.entries(outputs)) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const path = join(OUT, file);
  if (check) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== text) stale.push(file);
  } else {
    writeFileSync(path, text);
  }
}
if (check && stale.length) {
  console.error(`vectores wire desactualizados: ${stale.join(', ')} (correr bash script/export-vectors.sh)`);
  process.exit(1);
}
console.log(check ? 'vectores wire al día' : `vectores wire escritos: ${Object.keys(outputs).length} archivos en test/vectors/wire/`);
