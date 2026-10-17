// pnpm shard:migrate --wallet <walletId> [--wallet <walletId>…] [--shard <origen>]
// Migración offline de wallets entre shards (dos fases, sin cambio on-chain). El shard destino se configura con las
// mismas variables prefijadas con TARGET_ (TARGET_SIGNER_SHARD_ID, TARGET_SIGNER_KEYSTORE_DIR,
// TARGET_SIGNER_UNLOCK_CREDENTIAL_FILE, TARGET_SIGNER_DATABASE_URL[_FILE]). Imprime las claves migradas para aplicar
// la reasignación en el backend (`pnpm --dir backend/app signer:reassign`).
import { args, fail, output, run, shardContext } from '../src/cli/common.ts';
import { readCredentialFile } from '../src/keystore/derive-password.ts';
import { migrateWallets } from '../src/lifecycle/migrate.ts';

await run(async () => {
  const { values } = args({ shard: { type: 'string' }, wallet: { type: 'string', multiple: true } });
  if (values.wallet === undefined) fail('uso: shard:migrate --wallet <walletId>');
  const source = shardContext({ shard: values.shard });
  const target = shardContext({ prefix: 'TARGET_' });
  try {
    const moved = await migrateWallets({
      source: {
        db: source.db,
        shardId: source.config.shardId,
        keystoreDir: source.config.keystoreDir,
        credential: readCredentialFile(source.config.credentialFile, { keystoreDir: source.config.keystoreDir }),
      },
      target: {
        db: target.db,
        shardId: target.config.shardId,
        keystoreDir: target.config.keystoreDir,
        credential: readCredentialFile(target.config.credentialFile, { keystoreDir: target.config.keystoreDir }),
      },
      walletIds: values.wallet,
    });
    output({ moved });
  } finally {
    await source.close();
    await target.close();
  }
});
