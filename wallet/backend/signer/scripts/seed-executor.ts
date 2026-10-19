// Sólo desarrollo local (P21.T04, lo llama scripts/seed-local): importa en el shard de desarrollo la S determinística
// de la Safe del seed (derivada de LOCAL_SEED como contracts/script/lib/LocalKeys.sol: `keccak256("mtw-local-key" ‖
// seed ‖ "seed-executor-key")`, re-hasheada mientras no caiga en [1, n)) como clave EXECUTOR de la wallet del seed, y
// emite su SignerKeyAttestation. Se niega fuera de APP_ENV=local y fuera de un Anvil que forkea Base (guardas del
// DevelopmentSignerProvider). Salida: una línea JSON sin secretos.
//
//   node scripts/seed-executor.ts --wallet <walletId>
import { keccak_256 } from '@noble/hashes/sha3.js';
import { args, output, run } from '../src/cli/common.ts';
import { loadConfig } from '../src/config/env.ts';
import { KeyAttestor } from '../src/attestation.ts';
import { DevelopmentSignerProvider } from '../src/providers/DevelopmentSignerProvider.ts';
import { openProvider } from '../src/runtime.ts';
import { createSignerDb } from '../src/state/db.ts';
import { createLogger } from '../src/observability/logger.ts';

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function localKey(seedHex: string, label: string): Uint8Array {
  const raw = seedHex.startsWith('0x') ? seedHex.slice(2) : seedHex;
  if (!/^[0-9a-fA-F]{64}$/.test(raw) || /^0+$/.test(raw)) throw new Error('LOCAL_SEED inválida (32 bytes en hex)');
  let digest = keccak_256(
    new Uint8Array([
      ...new TextEncoder().encode('mtw-local-key'),
      ...Buffer.from(raw, 'hex'),
      ...new TextEncoder().encode(label),
    ]),
  );
  for (;;) {
    const value = BigInt(`0x${Buffer.from(digest).toString('hex')}`);
    if (value !== 0n && value < SECP256K1_N) return digest;
    digest = keccak_256(digest);
  }
}

await run(async () => {
  const { wallet } = args({ wallet: { type: 'string' } }).values;
  if (wallet === undefined || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(wallet)) {
    throw new Error('uso: node scripts/seed-executor.ts --wallet <walletId>');
  }
  const config = loadConfig();
  if (config.appEnv !== 'local' || config.provider !== 'development') {
    throw new Error('seed-executor sólo corre en APP_ENV=local con el provider de desarrollo');
  }
  const seed = process.env.LOCAL_SEED ?? '';
  const db = createSignerDb({ connectionString: config.databaseUrl.reveal(), applicationName: 'mtw-signer-seed' });
  const logger = createLogger({ level: 'warn', service: 'signer-seed', shardId: config.shardId });
  try {
    const provider = await openProvider(config, db, logger, undefined, undefined);
    if (!(provider instanceof DevelopmentSignerProvider)) throw new Error('el provider no es el de desarrollo');
    const imported = await provider.importSeedKey(wallet, localKey(seed, 'seed-executor-key'));
    const attestation = new KeyAttestor({
      privateKey: config.attestationPrivateKey,
      publicKey: config.attestationPublicKey,
      shardId: config.shardId,
      chainId: 8453,
    }).issue({ walletId: wallet, executor: imported.address });
    output({
      shardId: config.shardId,
      keyRef: imported.keyRef,
      executor: imported.address,
      created: imported.created,
      attestation,
    });
  } finally {
    await db.destroy();
  }
});
