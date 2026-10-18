// Emparejamiento approve/swap de un grupo de swap (P14.T05, [B-SIG-02]): el `SWAP_APPROVE` de nonce N sólo vale junto
// con el `SWAP` N+1 del mismo grupo firmado por U, y el `SWAP` sólo después de que S co-firmó ese approve. Hechos de la
// policy en dos modos:
//
// - `anticipate` (prepare y envío de la firma): la pareja existe y está viva; la firma de la otra mitad puede llegar
//   después (el par se encola recién cuando están las dos firmas) y la allowance del approve todavía no ejecutado se
//   da por la exacta del swap.
// - `execute` (worker, paso 6): la firma de U del SWAP N+1 es válida y de la U vigente on-chain, el approve N−1 ya
//   tiene la co-firma de S y la allowance es la leída on-chain (la pone `readOperationContext`).
import type { Kysely, Selectable } from 'kysely';
import { isAddressEqual, type Address } from 'viem';
import type { DecodedCall } from '../chain/decoders/safe-call.ts';
import { safeTxHash } from '../chain/safe-tx.ts';
import { InvalidSignatureError, recoverStrictSigner } from '../chain/signatures.ts';
import type { Database, OperationStatus, WalletOperationsTable } from '../db/schema.ts';
import { bufferToHex } from '../lib/bytes.ts';
import type { PolicyFacts } from '../policy/evaluate.ts';
import { safeTxFromJson, type CanonicalIntent } from './intent.ts';

type OperationRow = Selectable<WalletOperationsTable>;

/** Operaciones que ya no se van a ejecutar (no cuentan como pareja). */
export const DEAD_STATUSES: readonly OperationStatus[] = ['EXPIRED', 'CANCELLED', 'FAILED_FINAL'];
/** Ejecutadas on-chain. */
export const EXECUTED_STATUSES: readonly OperationStatus[] = ['MINED', 'CONFIRMED', 'FINALIZED'];

/** La otra mitad viva del par (nonce ± 1, mismo grupo, tipo complementario). */
export async function groupPartner(
  db: Kysely<Database>,
  op: Pick<OperationRow, 'group_id' | 'safe_nonce'>,
  partner: 'SWAP' | 'SWAP_APPROVE',
): Promise<OperationRow | undefined> {
  if (op.group_id === null) return undefined;
  const nonce = BigInt(op.safe_nonce) + (partner === 'SWAP' ? 1n : -1n);
  if (nonce < 0n) return undefined;
  return db
    .selectFrom('wallet_operations')
    .selectAll()
    .where('group_id', '=', op.group_id)
    .where('safe_nonce', '=', nonce.toString())
    .where('operation_type', '=', partner)
    .where('status', 'not in', DEAD_STATUSES)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
}

async function ownerSignatureValid(row: OperationRow, chainId: number, userKey: Address): Promise<boolean> {
  if (row.owner_signature === null || row.owner_role !== 'U') return false;
  const intent = row.canonical_intent as CanonicalIntent;
  const hash = safeTxHash(chainId, intent.safe, safeTxFromJson(intent.safeTx));
  if (hash !== bufferToHex(row.safe_tx_hash)) return false;
  try {
    return isAddressEqual(await recoverStrictSigner(hash, bufferToHex(row.owner_signature)), userKey);
  } catch (error) {
    if (error instanceof InvalidSignatureError) return false;
    throw error;
  }
}

export type PairingMode = { mode: 'anticipate' } | { mode: 'execute'; chainId: number; userKey: Address };

export async function swapPairingFacts(
  db: Kysely<Database>,
  op: Pick<OperationRow, 'group_id' | 'safe_nonce'>,
  call: DecodedCall,
  options: PairingMode,
): Promise<Partial<PolicyFacts>> {
  if (call.kind === 'ERC20_APPROVE' && call.amount > 0n) {
    const swap = await groupPartner(db, op, 'SWAP');
    if (!swap) return { pairedSwap: null };
    const safeTx = safeTxFromJson((swap.canonical_intent as CanonicalIntent).safeTx);
    return {
      pairedSwap: {
        safeTx,
        ownerSignatureValid:
          options.mode === 'anticipate' || (await ownerSignatureValid(swap, options.chainId, options.userKey)),
      },
    };
  }
  if (call.kind === 'SWAP') {
    const approve = await groupPartner(db, op, 'SWAP_APPROVE');
    if (!approve) return { approvalSigned: false };
    if (options.mode === 'execute') return { approvalSigned: approve.s_signature !== null };
    if (EXECUTED_STATUSES.includes(approve.status)) return { approvalSigned: true };
    // Todavía no ejecutado: la allowance que va a dejar es la del approve emparejado (decodificado de sus bytes al
    // prepararlo); la policy exige que sea exactamente el amountIn del swap y del mismo token.
    const decoded = (approve.canonical_intent as CanonicalIntent).decoded;
    if (decoded.token !== call.tokenIn || decoded.amount === undefined) return { approvalSigned: false };
    return { approvalSigned: true, allowance: BigInt(decoded.amount) };
  }
  return {};
}
