// Transfers de USDC y USDT desde y hacia la Safe (P18.T08): los que indexa el indexer de P13.T07 en `token_transfers`
// (eventos `Transfer` de los dos tokens, también los que no originó la plataforma), para la actividad de la app. Más
// recientes primero y paginados por cursor; los que un reorg dejó afuera (REORGED) no se muestran. Sólo las wallets
// del usuario (si no, 404: no se revela que existe).
import type { Kysely } from 'kysely';
import { isAddressEqual, type Address } from 'viem';
import { ApiError } from '../api/errors.ts';
import type { Database } from '../db/schema.ts';
import { addressToBuffer, bufferToAddress, bufferToHex } from '../lib/bytes.ts';
import { isUuid, walletOfUser } from '../operations/wallet-access.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';

export interface TransferView {
  id: string;
  token: 'USDC' | 'USDT';
  tokenAddress: Address;
  direction: 'IN' | 'OUT';
  counterparty: Address;
  amount: string;
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: string;
  status: 'MINED' | 'CONFIRMED' | 'FINALIZED';
  createdAt: string;
}

export class TransferService {
  readonly #db: Kysely<Database>;
  readonly #snapshot: () => BackendPolicySnapshot;

  constructor(deps: { db: Kysely<Database>; snapshot: () => BackendPolicySnapshot }) {
    this.#db = deps.db;
    this.#snapshot = deps.snapshot;
  }

  async list(
    userId: string,
    walletId: string,
    options: { limit: number; before?: string },
  ): Promise<{ items: TransferView[]; nextCursor: string | null }> {
    const wallet = await walletOfUser(this.#db, userId, walletId);
    if (wallet.safe === null) return { items: [], nextCursor: null };
    const { tokens } = this.#snapshot();
    let query = this.#db
      .selectFrom('token_transfers')
      .selectAll()
      .where('chain_id', '=', wallet.chainId)
      .where('safe_address', '=', addressToBuffer(wallet.safe))
      .where('token', 'in', [addressToBuffer(tokens.USDC), addressToBuffer(tokens.USDT)])
      .where('status', '!=', 'REORGED')
      .orderBy('id', 'desc')
      .limit(options.limit + 1);
    if (options.before !== undefined) {
      if (!isUuid(options.before)) throw new ApiError('VALIDATION_FAILED', { detail: 'cursor inválido' });
      query = query.where('id', '<', options.before);
    }
    const rows = await query.execute();
    const page = rows.slice(0, options.limit);
    return {
      items: page.map((row) => {
        const tokenAddress = bufferToAddress(row.token);
        return {
          id: row.id,
          token: isAddressEqual(tokenAddress, tokens.USDC) ? 'USDC' : 'USDT',
          tokenAddress,
          direction: row.direction,
          counterparty: bufferToAddress(row.counterparty),
          amount: row.amount,
          txHash: bufferToHex(row.tx_hash),
          logIndex: row.log_index,
          blockNumber: row.block_number,
          status: row.status === 'REORGED' ? 'MINED' : row.status,
          createdAt: new Date(row.created_at).toISOString(),
        };
      }),
      nextCursor: rows.length > options.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }
}
