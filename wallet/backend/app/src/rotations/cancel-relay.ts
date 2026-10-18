// Retransmisión de cancelaciones de rotación (P15.T02, proceso gas-tank): ROTATION_CANCEL_RELAY_REQUESTED → si la
// propuesta sigue pendiente on-chain, `RotationTimelock.cancelWithSignature` desde la cuenta gas tank (el shard
// `platform` del signer sólo firma esa llamada hacia el timelock del sistema, GT-04).
//
// Idempotente: una propuesta que ya no está pendiente (cancelada por esta u otra tx, ejecutada o inexistente) no se
// retransmite. Una tx revertida no se reintenta (la firma dejó de valer, p. ej. porque el firmante ya no es U ni R) y
// queda auditada; un error del RPC o del signer sí se reintenta (BullMQ). El estado CANCELLED lo aplica la
// sincronización de rotaciones con el evento `RotationCancelled` confirmado.
import type { Kysely } from 'kysely';
import { getAddress } from 'viem';
import { z } from 'zod';
import type { AuditWriter } from '../audit/audit-writer.ts';
import { rotationTimelockAbi } from '../chain/abis/index.ts';
import type { RpcQuorumClient } from '../chain/rpc-quorum.ts';
import type { Database } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import type { GasTankService } from '../gas/gas-tank.ts';
import type { Logger } from '../observability/logger.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';

const PayloadSchema = z.object({
  rotationId: z.uuid(),
  proposalId: z.string().regex(/^0x[0-9a-f]{64}$/),
  signature: z.string().regex(/^0x[0-9a-f]{130}$/),
  signer: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  /** RotationTimelock de la propuesta (el del sistema o el de un Guard sucesor). */
  timelock: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
});

/** Status del RotationTimelock: 0 = None, 1 = Pending, 2 = Cancelled, 3 = Executed. */
const PENDING = 1;

export interface CancelRelayerDeps {
  db: Kysely<Database>;
  rpc: RpcQuorumClient;
  gasTank: Pick<GasTankService, 'relayCancellation'>;
  snapshot: () => BackendPolicySnapshot;
  audit: AuditWriter;
  logger: Logger;
}

export class CancelRelayer {
  readonly #d: CancelRelayerDeps;

  constructor(deps: CancelRelayerDeps) {
    this.#d = deps;
  }

  async handle(payload: unknown): Promise<'RELAYED' | 'REVERTED' | 'NOT_PENDING'> {
    const parsed = PayloadSchema.safeParse(payload);
    if (!parsed.success) throw new Error('ROTATION_CANCEL_RELAY_REQUESTED con payload inválido');
    const { rotationId, signer } = parsed.data;
    const proposalId = parsed.data.proposalId as `0x${string}`;
    const signature = parsed.data.signature as `0x${string}`;
    const snapshot = this.#d.snapshot();
    const timelock = getAddress(parsed.data.timelock ?? snapshot.contracts.rotationTimelock);
    const { value: status } = await this.#d.rpc.readSensitive('rotation-cancel-relay', async (client, blockNumber) => {
      const proposal = await client.readContract({
        address: timelock,
        abi: rotationTimelockAbi,
        functionName: 'getProposal',
        args: [proposalId],
        blockNumber,
      });
      return proposal.status;
    });
    const rotation = await this.#d.db
      .selectFrom('rotation_requests as r')
      .innerJoin('wallets as w', 'w.id', 'r.wallet_id')
      .select(['r.wallet_id', 'w.user_id'])
      .where('r.id', '=', rotationId)
      .executeTakeFirst();
    if (status !== PENDING) {
      await this.#audit('ROTATION_CANCEL_RELAY_SKIPPED', rotationId, rotation, { proposalId, signer, status });
      return 'NOT_PENDING';
    }
    const tx = await this.#d.gasTank.relayCancellation({ proposalId, signature, timelock });
    if (tx.status === 'FAILED') {
      this.#d.logger.warn({ rotationId, txHash: tx.txHash }, 'la cancelación retransmitida revirtió');
    }
    await this.#audit('ROTATION_CANCEL_RELAYED', rotationId, rotation, {
      proposalId,
      signer,
      txHash: tx.txHash,
      result: tx.status,
    });
    return tx.status === 'MINED' ? 'RELAYED' : 'REVERTED';
  }

  async #audit(
    eventType: string,
    rotationId: string,
    rotation: { wallet_id: string; user_id: string } | undefined,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await withTransaction(
      this.#d.db,
      async (trx) => {
        await this.#d.audit.append(trx, {
          actorType: 'SYSTEM',
          actorId: 'gas-tank',
          userId: rotation?.user_id ?? null,
          walletId: rotation?.wallet_id ?? null,
          eventType,
          targetType: 'rotation',
          targetId: rotationId,
          payload,
        });
      },
      { auditLock: true },
    );
  }
}

/**
 * Handler de la cola `gas-tank` (proceso gas-tank): WALLET_DEPLOY_REQUESTED → deploy de la Safe;
 * ROTATION_CANCEL_RELAY_REQUESTED → retransmisión de la cancelación.
 */
export function gasTankJobHandler(handlers: {
  deploy: (data: { eventType: string; payload: unknown }) => Promise<void>;
  cancelRelay: CancelRelayer;
}): (data: { eventType: string; payload: unknown }) => Promise<void> {
  return async (data) => {
    if (data.eventType === 'ROTATION_CANCEL_RELAY_REQUESTED') {
      await handlers.cancelRelay.handle(data.payload);
      return;
    }
    await handlers.deploy(data);
  };
}
