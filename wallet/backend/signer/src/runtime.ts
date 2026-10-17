// Arranque de un shard del signer: configuración → DB propia (migraciones aplicadas) → credencial de desbloqueo →
// provider (con las guardas de desarrollo si corresponde) → snapshot de policy firmado (firma, entorno y anti-rollback)
// → RPC propio (chainId del snapshot) → servicios → servidor mTLS. Cualquier problema de policy o de RPC impide
// arrancar (fail-closed); un keystore o una credencial con problemas deja el shard `not ready` (no firma).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Kysely } from 'kysely';
import { KeyAttestor } from './attestation.ts';
import { buildServer, type SignerServer } from './api/server.ts';
import { OnChainReader } from './chain/reader.ts';
import { SignerRpc } from './chain/rpc.ts';
import { WALLET_ROOT, type SignerConfig } from './config/env.ts';
import { pinnedKeys } from './crypto/jws.ts';
import { readCredentialFile } from './keystore/derive-password.ts';
import { createLogger, type Logger } from './observability/logger.ts';
import { createMetrics, type SignerMetrics } from './observability/metrics.ts';
import { activateSnapshot, verifySnapshot, type LoadedSnapshot } from './policy/snapshot.ts';
import { DevelopmentSignerProvider } from './providers/DevelopmentSignerProvider.ts';
import { SelfHostedSoftwareSignerProvider } from './providers/SelfHostedSoftwareSignerProvider.ts';
import { PlatformTxService } from './sign/platform-tx.ts';
import { SignSafeTxService } from './sign/sign-safe-tx.ts';
import { createSignerDb } from './state/db.ts';
import { migrateToLatest, pendingMigrations } from './state/migrator.ts';
import type { SignerDatabase } from './state/schema.ts';

export class StartupError extends Error {
  override name = 'StartupError';
}

export interface SignerRuntime {
  config: SignerConfig;
  db: Kysely<SignerDatabase>;
  provider: SelfHostedSoftwareSignerProvider;
  snapshot: LoadedSnapshot;
  server: SignerServer;
  metrics: SignerMetrics;
  logger: Logger;
  close: () => Promise<void>;
}

export interface StartOptions {
  logger?: Logger;
  /** Aplica migraciones pendientes (sólo el comando `migrate` y los tests). */
  migrate?: boolean;
  /** Escucha en host:port (los tests de inyección usan `server.inject` o un puerto propio). */
  listen?: boolean;
  /** Raíces permitidas para los keystores del provider de desarrollo (default wallet/.secrets/signer). */
  developmentRoots?: string[];
}

export function loadPolicyFile(config: SignerConfig): LoadedSnapshot {
  let bytes: Buffer;
  let signature: string;
  try {
    bytes = readFileSync(config.policy.snapshotPath);
    signature = readFileSync(`${config.policy.snapshotPath}.sig`, 'utf8');
  } catch {
    throw new StartupError('no se puede leer el snapshot de policy o su firma (.sig)');
  }
  return verifySnapshot(bytes, signature, config.policy.publicKey, { environment: config.appEnv });
}

export async function openProvider(
  config: SignerConfig,
  db: Kysely<SignerDatabase>,
  logger: Logger,
  metrics: SignerMetrics | undefined,
  developmentRoots: string[] | undefined,
): Promise<SelfHostedSoftwareSignerProvider> {
  const credential = readCredentialFile(config.credentialFile, { keystoreDir: config.keystoreDir });
  const options = {
    shardId: config.shardId,
    keystoreDir: config.keystoreDir,
    credential,
    db,
    logger,
    ...(metrics === undefined ? {} : { metrics }),
  };
  if (config.provider === 'development') {
    return DevelopmentSignerProvider.openDevelopment(options, {
      appEnv: config.appEnv,
      rpcUrls: [config.rpc.primaryUrl.reveal(), config.rpc.secondaryUrl.reveal()],
      keystoreDir: config.keystoreDir,
      credentialFile: config.credentialFile,
      allowedRoots: developmentRoots ?? [resolve(WALLET_ROOT, '.secrets/signer')],
    });
  }
  return SelfHostedSoftwareSignerProvider.open(options);
}

export async function startSigner(config: SignerConfig, options: StartOptions = {}): Promise<SignerRuntime> {
  const logger = options.logger ?? createLogger({ level: config.logLevel, service: 'signer', shardId: config.shardId });
  const metrics = createMetrics();
  const db = createSignerDb({
    connectionString: config.databaseUrl.reveal(),
    applicationName: `mtw-signer-${config.shardId}`,
    onPoolError: (error) => {
      logger.error({ err: error }, 'error del pool de la DB del signer');
    },
  });
  try {
    if (options.migrate === true) await migrateToLatest(db);
    const pending = await pendingMigrations(db);
    if (pending.length > 0) throw new StartupError(`migraciones pendientes: ${pending.join(', ')} (pnpm db:migrate)`);

    const snapshot = loadPolicyFile(config);
    await activateSnapshot(db, snapshot);

    const rpc = new SignerRpc({
      primaryUrl: config.rpc.primaryUrl.reveal(),
      secondaryUrl: config.rpc.secondaryUrl.reveal(),
      mode: config.rpc.mode,
      timeoutMs: config.rpc.timeoutMs,
      retries: config.rpc.retries,
      backoffMs: config.rpc.backoffMs,
    });
    const chainId = await rpc.chainId();
    if (chainId !== snapshot.snapshot.chainId) {
      throw new StartupError(`el RPC del signer es chainId ${chainId}, el snapshot ${snapshot.snapshot.chainId}`);
    }
    const provider = await openProvider(config, db, logger, metrics, options.developmentRoots);
    const reader = new OnChainReader(rpc, snapshot.snapshot.contracts);
    const attestor = new KeyAttestor({
      privateKey: config.attestationPrivateKey,
      publicKey: config.attestationPublicKey,
      shardId: config.shardId,
      chainId: snapshot.snapshot.chainId,
    });
    const attestationKeys = pinnedKeys(config.attestationPublicKey);
    const current = () => snapshot.snapshot;
    const server = await buildServer({
      tls: {
        key: readFileSync(config.mtls.keyPath),
        cert: readFileSync(config.mtls.certPath),
        ca: readFileSync(config.mtls.caPath),
      },
      allowedClientNames: config.mtls.allowedClientNames,
      shardId: config.shardId,
      platform: config.platform,
      provider,
      attestor,
      reader,
      snapshot: current,
      logger,
      metrics,
      ...(config.platform
        ? {
            platformTx: new PlatformTxService({
              db,
              provider,
              reader,
              snapshot: current,
              attestationKeys,
              logger,
              metrics,
            }),
          }
        : {
            signSafeTx: new SignSafeTxService({
              db,
              provider,
              reader,
              snapshot: current,
              appEnv: config.appEnv,
              issuerKeys: pinnedKeys(...config.sessionIssuerKeys),
              attestationKeys,
              integrity: {
                required: config.integrity.required,
                monitorKeys: pinnedKeys(...config.integrity.monitorKeys),
              },
              logger,
              metrics,
            }),
          }),
    });
    if (options.listen !== false) await server.listen({ host: config.host, port: config.port });
    logger.info(
      {
        provider: provider.name,
        ready: provider.ready,
        policyVersion: snapshot.snapshot.version,
        platform: config.platform,
      },
      'signer iniciado',
    );
    return {
      config,
      db,
      provider,
      snapshot,
      server,
      metrics,
      logger,
      close: async () => {
        await server.close();
        await db.destroy();
      },
    };
  } catch (error) {
    await db.destroy();
    throw error;
  }
}
