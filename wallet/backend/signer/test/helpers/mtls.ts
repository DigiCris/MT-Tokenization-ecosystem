// PKI de prueba con openssl (igual que scripts/secrets-local): CA del entorno, certificado de servidor del signer
// (SAN localhost/127.0.0.1), cliente `mtw-backend`, cliente de OTRA CA y cliente de la CA con un nombre no permitido.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Pem {
  cert: Buffer;
  key: Buffer;
  certPath: string;
  keyPath: string;
}

export interface TestPki {
  dir: string;
  caPath: string;
  ca: Buffer;
  server: Pem;
  client: Pem;
  foreignClient: Pem;
  wrongNameClient: Pem;
  cleanup: () => void;
}

function openssl(args: string[]): void {
  const r = spawnSync('openssl', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`openssl ${args[0]} falló: ${r.stderr.split('\n')[0]}`);
}

function makeCa(dir: string, name: string): { cert: string; key: string } {
  const key = join(dir, `${name}-key.pem`);
  const cert = join(dir, `${name}.pem`);
  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]);
  openssl([
    'req',
    '-x509',
    '-new',
    '-key',
    key,
    '-sha256',
    '-days',
    '2',
    '-subj',
    `/CN=${name}`,
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
    '-out',
    cert,
  ]);
  return { cert, key };
}

function leaf(dir: string, ca: { cert: string; key: string }, name: string, cn: string, ext: string): Pem {
  const keyPath = join(dir, `${name}-key.pem`);
  const certPath = join(dir, `${name}.pem`);
  const csr = join(dir, `${name}.csr`);
  const extFile = join(dir, `${name}.ext`);
  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyPath]);
  openssl(['req', '-new', '-key', keyPath, '-subj', `/CN=${cn}`, '-out', csr]);
  writeFileSync(extFile, ext);
  openssl([
    'x509',
    '-req',
    '-in',
    csr,
    '-CA',
    ca.cert,
    '-CAkey',
    ca.key,
    '-CAcreateserial',
    '-days',
    '2',
    '-sha256',
    '-extfile',
    extFile,
    '-out',
    certPath,
  ]);
  return { cert: readFileSync(certPath), key: readFileSync(keyPath), certPath, keyPath };
}

const CLIENT_EXT =
  'extendedKeyUsage=clientAuth\nkeyUsage=critical,digitalSignature\nbasicConstraints=critical,CA:FALSE\n';

export function createTestPki(): TestPki {
  const dir = mkdtempSync(join(tmpdir(), 'mtw-signer-pki-'));
  const ca = makeCa(dir, 'ca');
  const foreignCa = makeCa(dir, 'foreign-ca');
  const server = leaf(
    dir,
    ca,
    'server',
    'mtw-signer-test',
    'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature\nbasicConstraints=critical,CA:FALSE\n',
  );
  return {
    dir,
    caPath: ca.cert,
    ca: readFileSync(ca.cert),
    server,
    client: leaf(dir, ca, 'client', 'mtw-backend', CLIENT_EXT),
    foreignClient: leaf(dir, foreignCa, 'foreign-client', 'mtw-backend', CLIENT_EXT),
    wrongNameClient: leaf(dir, ca, 'wrong-client', 'mtw-intruso', CLIENT_EXT),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
