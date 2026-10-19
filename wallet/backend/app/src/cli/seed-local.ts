// Parte off-chain del seed determinístico (P21.T04; sólo APP_ENV=local contra Anvil, lo llama wallet/scripts/seed-local
// después de contracts/script/SeedLocal.s.sol y de `seed:executor` del signer). Sobre la Safe del seed
// (contracts/deployments/local.json → .seed) deja: el usuario de prueba con el email verificado, la wallet con su id
// determinístico registrada como ACTIVE **después** de la verificación normal (V9 §16, la misma del deploy asistido),
// las claves U, R y S (S en el shard de desarrollo, con su SignerKeyAttestation), el registro OPAQUE de U derivado de la
// Password U de prueba y de los parámetros KDF de su sobre, y el destino de prueba activo de la whitelist. Idempotente.
//
//   node src/cli/seed-local.ts --credentials <json> --u-envelope <U.enc.json> --executor <json de seed:executor>
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import * as opaque from '@serenity-kit/opaque';
import { sql } from 'kysely';
import { getAddress, hexToBytes, type Address } from 'viem';
import { PasswordHasher } from '../auth/password.ts';
import { RpcQuorumClient } from '../chain/rpc-quorum.ts';
import { loadConfig, loadSignerClientConfig } from '../config/env.ts';
import { createDatabase } from '../db/kysely.ts';
import { withTransaction } from '../db/transaction.ts';
import { createLogger } from '../observability/logger.ts';
import { createMetrics } from '../observability/metrics.ts';
import { deriveAuthSecret, opaqueInput, type KdfParams } from '../platform-session/auth-secret.ts';
import {
  OPAQUE_KEY_STRETCHING,
  OPAQUE_KEY_STRETCHING_RECORD,
  opaqueUserIdentifier,
} from '../platform-session/opaque.ts';
import { loadPolicySnapshot } from '../policy/snapshot.ts';
import { walletSaltNonce } from '../wallets/salt.ts';
import { verifyDeployedWallet } from '../wallets/verification.ts';

const WALLET_ROOT = resolve(import.meta.dirname, '../../../..');

interface Seed {
  walletId: string;
  safe: Address;
  userKey: Address;
  recoveryKey: Address;
  executor: Address;
  saltNonce: string;
  destination: Address;
}

function fail(message: string): never {
  process.stderr.write(`seed-local: ${message}\n`);
  process.exit(1);
}

const bytes = (address: Address) => Buffer.from(hexToBytes(getAddress(address)));

async function rpcCall<T>(url: string, method: string): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
  });
  return ((await response.json()) as { result: T }).result;
}

const { values } = parseArgs({
  options: { credentials: { type: 'string' }, 'u-envelope': { type: 'string' }, executor: { type: 'string' } },
});
if (!values.credentials || !values['u-envelope'] || !values.executor) {
  fail('uso: node src/cli/seed-local.ts --credentials <json> --u-envelope <U.enc.json> --executor <json>');
}
const config = loadConfig();
if (config.appEnv !== 'local') fail('sólo corre con APP_ENV=local');
const rpcUrl = config.rpc.primaryUrl.reveal();
const client = await rpcCall<string>(rpcUrl, 'web3_clientVersion');
if (!/anvil/i.test(client) || Number.parseInt(await rpcCall<string>(rpcUrl, 'eth_chainId'), 16) !== 8453) {
  fail('el RPC no es un Anvil que forkea Base: el seed no corre');
}
const seed = (
  JSON.parse(readFileSync(resolve(WALLET_ROOT, 'contracts/deployments/local.json'), 'utf8')) as { seed?: Seed }
).seed;
if (!seed?.walletId) fail('el deployment local no tiene seed: correr pnpm seed-local');
if (BigInt(seed.saltNonce) !== walletSaltNonce(config.platformId, seed.walletId)) {
  fail('el saltNonce de la Safe del seed no es el del producto para su walletId y PLATFORM_ID');
}
const credentials = JSON.parse(readFileSync(values.credentials, 'utf8')) as {
  email: string;
  accountPassword: string;
  passwordU: string;
};
const envelope = JSON.parse(readFileSync(values['u-envelope'], 'utf8')) as {
  keyAddress: Address;
  kdf: KdfParams & { salt: string };
};
const executor = JSON.parse(readFileSync(values.executor, 'utf8')) as {
  shardId: string;
  keyRef: string;
  executor: Address;
  attestation: string;
};
if (getAddress(envelope.keyAddress) !== getAddress(seed.userKey)) fail('el sobre de U no es de la U del seed');
if (getAddress(executor.executor) !== getAddress(seed.executor)) fail('la S importada no es la S del seed');

// Verificación normal de la Safe desplegada (la misma que el deploy asistido): owners, threshold, Guard, roles,
// módulos, fallback handler, codehash de los contratos del sistema. La nonce ya avanzó (alta en la whitelist).
const logger = createLogger({ level: 'warn', service: 'seed-local' });
const metrics = createMetrics({ defaultMetrics: false });
const signer = loadSignerClientConfig();
const snapshot = loadPolicySnapshot(signer.policy.snapshotPath, signer.policy.publicKey, config.appEnv);
const rpc = new RpcQuorumClient({
  primaryUrl: rpcUrl,
  secondaryUrl: config.rpc.secondaryUrl.reveal(),
  mode: config.rpc.quorumMode,
  chainId: config.chainId,
  timeoutMs: config.rpc.timeoutMs,
  healthIntervalMs: config.rpc.healthIntervalMs,
  maxHeadLagBlocks: config.rpc.maxHeadLagBlocks,
  retries: config.rpc.quorumRetries,
  backoffMs: config.rpc.quorumBackoffMs,
  logger,
  metrics,
});
const verification = await verifyDeployedWallet(
  rpc,
  snapshot,
  {
    safe: seed.safe,
    userKey: seed.userKey,
    recoveryKey: seed.recoveryKey,
    executor: seed.executor,
    saltNonce: BigInt(seed.saltNonce),
  },
  { requireFreshNonce: false },
);
await rpc.stop();
if (!verification.ok) fail(`la Safe del seed no verifica: ${verification.failures.join(', ')}`);

await opaque.ready;
const db = createDatabase({
  connectionString: config.database.url.reveal(),
  applicationName: 'seed-local',
  poolMax: 2,
});
try {
  const { hash, pepperVersion } = await new PasswordHasher(config.secrets.passwordPeppers).hash(
    credentials.accountPassword,
  );
  await withTransaction(db, async (trx) => {
    const user = await trx
      .insertInto('users')
      .values({
        platform_id: config.platformId,
        email: credentials.email,
        password_hash: hash,
        pepper_version: pepperVersion,
        email_verified_at: sql`now()`,
      })
      .onConflict((oc) =>
        oc
          .columns(['platform_id', 'email'])
          .doUpdateSet({ password_hash: hash, pepper_version: pepperVersion, email_verified_at: sql`now()` }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('wallets')
      .values({
        id: seed.walletId,
        user_id: user.id,
        platform_id: config.platformId,
        chain_id: config.chainId,
        status: 'ACTIVE',
        safe_address: bytes(seed.safe),
        salt_nonce: seed.saltNonce,
        factory_address: bytes(snapshot.contracts.walletFactory),
        singleton_address: bytes(snapshot.contracts.safeL2Singleton),
        next_safe_nonce: verification.state.nonce,
        activated_at: sql`now()`,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    const keys = [
      { role: 'U' as const, address: seed.userKey, source: 'INTERNAL' as const, kdf: { ...envelope.kdf } },
      { role: 'R' as const, address: seed.recoveryKey, source: 'INTERNAL' as const, kdf: null },
      { role: 'S' as const, address: seed.executor, source: 'SIGNER_SHARD' as const, kdf: null },
    ];
    for (const key of keys) {
      const existing = await trx
        .selectFrom('wallet_keys_metadata')
        .select('id')
        .where('wallet_id', '=', seed.walletId)
        .where('role', '=', key.role)
        .where('status', '=', 'ACTIVE')
        .executeTakeFirst();
      if (existing) continue;
      await trx
        .insertInto('wallet_keys_metadata')
        .values({
          wallet_id: seed.walletId,
          role: key.role,
          key_address: bytes(key.address),
          key_version: 1,
          status: 'ACTIVE',
          source: key.source,
          kdf_params: key.kdf === null ? null : JSON.stringify(key.kdf),
          activated_at: sql`now()`,
        })
        .execute();
    }
    const signerKey = await trx
      .selectFrom('signer_keys')
      .select('id')
      .where('wallet_id', '=', seed.walletId)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    if (!signerKey) {
      await trx
        .insertInto('signer_keys')
        .values({
          wallet_id: seed.walletId,
          shard_id: executor.shardId,
          key_ref: executor.keyRef,
          address: bytes(seed.executor),
          provider: 'development',
          status: 'ACTIVE',
          attestation: executor.attestation,
        })
        .execute();
    }
    const record = await trx
      .selectFrom('opaque_records')
      .select('id')
      .where('wallet_id', '=', seed.walletId)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    if (!record) {
      const authInput = opaqueInput(deriveAuthSecret(credentials.passwordU, envelope.kdf));
      const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({ password: authInput });
      const { registrationResponse } = opaque.server.createRegistrationResponse({
        serverSetup: config.secrets.opaqueServerSetup.reveal(),
        userIdentifier: opaqueUserIdentifier(config.platformId, seed.walletId, 1),
        registrationRequest,
      });
      const { registrationRecord } = opaque.client.finishRegistration({
        clientRegistrationState,
        registrationResponse,
        password: authInput,
        keyStretching: OPAQUE_KEY_STRETCHING,
      });
      await trx
        .insertInto('opaque_records')
        .values({
          user_id: user.id,
          wallet_id: seed.walletId,
          key_version: 1,
          registration_record: Buffer.from(registrationRecord, 'base64url'),
          key_stretching: JSON.stringify(OPAQUE_KEY_STRETCHING_RECORD),
          status: 'ACTIVE',
          activated_at: sql`now()`,
        })
        .execute();
    }
    await trx
      .insertInto('whitelisted_destinations')
      .values({
        wallet_id: seed.walletId,
        destination: bytes(seed.destination),
        label: 'Destino de prueba (seed)',
        status: 'ACTIVE',
        activates_at: sql`now()`,
        activated_at: sql`now()`,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  });
  process.stdout.write(
    `${JSON.stringify({ walletId: seed.walletId, safe: getAddress(seed.safe), status: 'ACTIVE', verifiedAtBlock: verification.blockNumber.toString() })}\n`,
  );
} finally {
  await db.destroy();
}
