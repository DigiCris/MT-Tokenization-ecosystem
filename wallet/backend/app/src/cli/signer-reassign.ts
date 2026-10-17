// pnpm signer:reassign <salida-de-shard-migrate.json>
// Segunda fase de una migración de wallets entre shards [B-SIG-08] en el backend: con la salida de
// `pnpm --dir backend/signer shard:migrate` (claves ya copiadas, verificadas y activas en el shard destino) actualiza
// `signer_keys.shard_id` y `key_ref`. Imprime cuántas filas cambió; no toca nada on-chain.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ConfigError, loadDatabaseConfig } from '../config/env.ts';
import { createDatabase } from '../db/kysely.ts';
import { SignerKeyService } from '../signer-client/sharding.ts';

const MovedSchema = z.object({
  moved: z.array(
    z.object({
      walletId: z.uuid(),
      address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      fromShard: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
      toShard: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
      keyRef: z.string().min(1).max(128),
    }),
  ),
});

async function main(): Promise<void> {
  const file = process.argv.slice(2).find((a) => a !== '--');
  if (file === undefined) throw new Error('uso: signer:reassign <archivo JSON de shard:migrate>');
  const moved = MovedSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).moved;
  const config = loadDatabaseConfig();
  const db = createDatabase({ connectionString: config.databaseUrl.reveal(), applicationName: 'mtw-signer-reassign' });
  try {
    const service = new SignerKeyService({ db, shards: [], clients: new Map() });
    const updated = await service.reassign(moved);
    process.stdout.write(`${JSON.stringify({ updated, expected: moved.length })}\n`);
    if (updated !== moved.length) process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `signer:reassign: ${error instanceof ConfigError || error instanceof Error ? error.message : 'error'}\n`,
  );
  process.exit(1);
});
