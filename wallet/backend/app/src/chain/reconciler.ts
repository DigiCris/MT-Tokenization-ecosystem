// Reconciliación periódica DB ↔ cadena [B-FIN-03] (P13.T07): cada 60 s para las wallets con operaciones no finales y
// una pasada diaria completa sobre todas las wallets operativas. Compara con lecturas con quórum: configuración de la
// Safe (deriva → SOVEREIGN_MODIFIED), nonce de la Safe contra las operaciones y ejecuciones indexadas, roles del Guard
// contra las claves vigentes en la DB y, en la completa, whitelist, rotaciones pendientes en el RotationTimelock y
// saldos contra el neto de los transfers indexados. Cada discrepancia genera un evento de auditoría
// RECONCILIATION_DISCREPANCY y una alerta (log de error + métrica); la misma discrepancia no se vuelve a registrar
// mientras no cambie (deduplicada contra la auditoría de las últimas 24 h).
import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { isAddressEqual, type Abi, type Address, type Hex } from 'viem';
import type { AuditWriter } from '../audit/audit-writer.ts';
import type { Database } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import { addressToBuffer, bufferToAddress } from '../lib/bytes.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';
import type { SovereignModification } from '../wallets/sovereign.ts';
import { destinationWhitelistAbi, rotationTimelockAbi } from './abis/index.ts';
import { RotationKind } from './constants.ts';
import { INDEXER_CURSOR } from './indexer.ts';
import { RpcQuorumError, type RpcQuorumClient } from './rpc-quorum.ts';
import { readSafeState, safeConfigDrift, type SafeChainState } from './safe-state.ts';

const ZERO_ID = /^0x0{64}$/;
const balanceOfAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const satisfies Abi;

export type DiscrepancyKind = 'config' | 'nonce' | 'executions' | 'roles' | 'whitelist' | 'rotation' | 'balance';

export interface Discrepancy {
  walletId: string;
  kind: DiscrepancyKind;
  detail: Record<string, unknown>;
}

export interface ReconcilerDeps {
  db: Kysely<Database>;
  rpc: RpcQuorumClient;
  audit: AuditWriter;
  snapshot: () => BackendPolicySnapshot;
  sovereign: SovereignModification;
  logger: Logger;
  metrics: Metrics;
}

interface FullFacts {
  whitelist: { destination: Address; onchain: boolean }[];
  proposals: { kind: number; id: Hex }[];
  balances: { token: Address; balance: string }[];
}

export class Reconciler {
  readonly #d: ReconcilerDeps;

  constructor(deps: ReconcilerDeps) {
    this.#d = deps;
  }

  async runOnce(scope: 'active' | 'full'): Promise<{ wallets: number; discrepancies: Discrepancy[] }> {
    let query = this.#d.db
      .selectFrom('wallets')
      .select(['id', 'user_id', 'safe_address', 'deploy_block_number'])
      .where('status', '=', 'ACTIVE')
      .where('safe_address', 'is not', null);
    if (scope === 'active') {
      query = query.where((eb) =>
        eb.exists(
          eb
            .selectFrom('wallet_operations')
            .select('wallet_operations.id')
            .whereRef('wallet_operations.wallet_id', '=', 'wallets.id')
            .where('wallet_operations.status', 'not in', ['FINALIZED', 'FAILED_FINAL', 'CANCELLED', 'EXPIRED']),
        ),
      );
    }
    const wallets = await query.execute();
    const found: Discrepancy[] = [];
    for (const wallet of wallets) {
      if (wallet.safe_address === null) continue;
      try {
        found.push(
          ...(await this.#reconcile(
            wallet.id,
            bufferToAddress(wallet.safe_address),
            wallet.deploy_block_number,
            scope,
          )),
        );
      } catch (error) {
        if (!(error instanceof RpcQuorumError)) throw error;
        this.#d.logger.warn({ walletId: wallet.id, code: error.code }, 'reconciliación sin quórum: se reintenta');
      }
    }
    for (const discrepancy of found) await this.#report(discrepancy);
    return { wallets: wallets.length, discrepancies: found };
  }

  async #reconcile(
    walletId: string,
    safe: Address,
    deployBlock: string | null,
    scope: 'active' | 'full',
  ): Promise<Discrepancy[]> {
    const snapshot = this.#d.snapshot();
    const c = snapshot.contracts;
    const whitelisted = scope === 'full' ? await this.#whitelistedDestinations(walletId) : [];
    const { value, blockNumber } = await this.#d.rpc.readSensitive('reconciliation', async (client, block) => {
      const state = await readSafeState(client, block, snapshot, safe);
      if (scope !== 'full') return { state, full: null };
      const read = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
        client.readContract({ address, abi, functionName, args, blockNumber: block }) as Promise<T>;
      const full: FullFacts = {
        whitelist: await Promise.all(
          whitelisted.map(async (destination) => ({
            destination,
            onchain: await read<boolean>(c.destinationWhitelist, destinationWhitelistAbi, 'isWhitelisted', [
              safe,
              destination,
            ]),
          })),
        ),
        proposals: await Promise.all(
          Object.values(RotationKind).map(async (kind) => ({
            kind,
            id: await read<Hex>(c.rotationTimelock, rotationTimelockAbi, 'activeProposal', [safe, kind]),
          })),
        ),
        balances: await Promise.all(
          [snapshot.tokens.USDC, snapshot.tokens.USDT].map(async (token) => ({
            token,
            balance: (await read<bigint>(token, balanceOfAbi, 'balanceOf', [safe])).toString(),
          })),
        ),
      };
      return { state, full };
    });
    const found: Discrepancy[] = [];
    const add = (kind: DiscrepancyKind, detail: Record<string, unknown>) => found.push({ walletId, kind, detail });
    const { state } = value;

    const drift = safeConfigDrift(state, snapshot);
    if (drift.length > 0) {
      await withTransaction(
        this.#d.db,
        (trx) => this.#d.sovereign.mark(trx, { walletId, safe, items: drift, detectedBy: 'reconciler' }),
        { auditLock: true },
      );
      add('config', { items: drift });
    }
    await this.#checkNonce(walletId, safe, state, blockNumber, add);
    await this.#checkRoles(walletId, state, add);
    if (value.full) await this.#checkFull(walletId, safe, deployBlock, blockNumber, value.full, add);
    return found;
  }

  async #checkNonce(
    walletId: string,
    safe: Address,
    state: SafeChainState,
    blockNumber: bigint,
    add: (kind: DiscrepancyKind, detail: Record<string, unknown>) => void,
  ): Promise<void> {
    const onchain = BigInt(state.nonce);
    // La DB cree ejecutada (MINED o más) una operación cuyo nonce la cadena todavía no consumió: reorg sin detectar.
    const ahead = await this.#d.db
      .selectFrom('wallet_operations')
      .select(['id', 'safe_nonce', 'status'])
      .where('wallet_id', '=', walletId)
      .where('status', 'in', ['MINED', 'CONFIRMED', 'FINALIZED'])
      .where('safe_nonce', '>=', onchain.toString())
      .execute();
    if (ahead.length > 0) {
      add('nonce', {
        onchainNonce: onchain.toString(),
        executedInDb: ahead.map((r) => ({ id: r.id, nonce: r.safe_nonce })),
      });
    }
    // Con el indexer al día, cada nonce consumido tiene su ejecución exitosa indexada (de la plataforma o soberana).
    const cursor = await this.#d.db
      .selectFrom('chain_cursors')
      .select('block_number')
      .where('name', '=', INDEXER_CURSOR)
      .executeTakeFirst();
    if (cursor && BigInt(cursor.block_number) >= blockNumber) {
      const indexed = await this.#d.db
        .selectFrom('safe_executions')
        .select(sql<string>`count(DISTINCT safe_nonce)`.as('n'))
        .where('chain_id', '=', this.#d.snapshot().chainId)
        .where('safe_address', '=', addressToBuffer(safe))
        .where('success', '=', true)
        .where('status', '<>', 'REORGED')
        .where('block_number', '<=', blockNumber.toString())
        .executeTakeFirstOrThrow();
      if (BigInt(indexed.n) !== onchain) {
        add('executions', { onchainNonce: onchain.toString(), indexedExecutions: indexed.n });
      }
    }
  }

  async #checkRoles(
    walletId: string,
    state: SafeChainState,
    add: (kind: DiscrepancyKind, detail: Record<string, unknown>) => void,
  ): Promise<void> {
    const keys = await this.#d.db
      .selectFrom('wallet_keys_metadata')
      .select(['role', 'key_address'])
      .where('wallet_id', '=', walletId)
      .where('status', '=', 'ACTIVE')
      .execute();
    const signer = await this.#d.db
      .selectFrom('signer_keys')
      .select('address')
      .where('wallet_id', '=', walletId)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    const db = {
      U: keys.find((k) => k.role === 'U')?.key_address,
      R: keys.find((k) => k.role === 'R')?.key_address,
      S: signer?.address ?? keys.find((k) => k.role === 'S')?.key_address,
    };
    const onchain = { U: state.roles.userKey, R: state.roles.recoveryKey, S: state.roles.executor };
    const mismatched = (['U', 'R', 'S'] as const).filter((role) => {
      const stored = db[role];
      return stored === undefined || !isAddressEqual(bufferToAddress(stored), onchain[role]);
    });
    if (mismatched.length > 0) add('roles', { roles: mismatched, onchain });
  }

  async #whitelistedDestinations(walletId: string): Promise<Address[]> {
    const rows = await this.#d.db
      .selectFrom('whitelisted_destinations')
      .select('destination')
      .where('wallet_id', '=', walletId)
      .where('status', '=', 'ACTIVE')
      .execute();
    return rows.map((r) => bufferToAddress(r.destination));
  }

  async #checkFull(
    walletId: string,
    safe: Address,
    deployBlock: string | null,
    blockNumber: bigint,
    full: FullFacts,
    add: (kind: DiscrepancyKind, detail: Record<string, unknown>) => void,
  ): Promise<void> {
    const inactive = full.whitelist.filter((w) => !w.onchain).map((w) => w.destination);
    if (inactive.length > 0) add('whitelist', { activeInDbNotOnchain: inactive });

    const pending = await this.#d.db
      .selectFrom('rotation_requests')
      .select(['id', 'role', 'proposal_id', 'status'])
      .where('wallet_id', '=', walletId)
      .where('status', 'in', ['PENDING_TIMELOCK', 'READY_TO_EXECUTE'])
      .execute();
    const onchainProposals = full.proposals.filter((p) => !ZERO_ID.test(p.id));
    const known = new Set(
      pending.flatMap((p) => (p.proposal_id === null ? [] : [`0x${p.proposal_id.toString('hex')}`])),
    );
    const unknownOnchain = onchainProposals.filter((p) => !known.has(p.id.toLowerCase()));
    const missingOnchain = pending.filter(
      (p) =>
        p.proposal_id !== null &&
        !onchainProposals.some((o) => o.id.toLowerCase() === `0x${p.proposal_id?.toString('hex') ?? ''}`),
    );
    if (unknownOnchain.length > 0 || missingOnchain.length > 0) {
      add('rotation', {
        unknownOnchain: unknownOnchain.map((p) => ({ kind: p.kind, id: p.id })),
        missingOnchain: missingOnchain.map((p) => p.id),
      });
    }

    // Saldos: el indexer arranca en el deploy de la primera wallet y avanza sin huecos, así que con el cursor en (o
    // después de) el bloque leído el neto de transfers indexados hasta ese bloque es exactamente el saldo.
    const cursor = await this.#d.db
      .selectFrom('chain_cursors')
      .select('block_number')
      .where('name', '=', INDEXER_CURSOR)
      .executeTakeFirst();
    if (cursor === undefined || deployBlock === null || BigInt(cursor.block_number) < blockNumber) return;
    for (const { token, balance } of full.balances) {
      const row = await this.#d.db
        .selectFrom('token_transfers')
        .select(sql<string>`coalesce(sum(CASE WHEN direction = 'IN' THEN amount ELSE -amount END), 0)`.as('net'))
        .where('safe_address', '=', addressToBuffer(safe))
        .where('token', '=', addressToBuffer(token))
        .where('status', '<>', 'REORGED')
        .where('block_number', '<=', blockNumber.toString())
        .executeTakeFirstOrThrow();
      if (BigInt(row.net) !== BigInt(balance)) add('balance', { token, onchain: balance, indexedNet: row.net });
    }
  }

  async #report(discrepancy: Discrepancy): Promise<void> {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ kind: discrepancy.kind, detail: discrepancy.detail }))
      .digest('hex');
    const wallet = await this.#d.db
      .selectFrom('wallets')
      .select('user_id')
      .where('id', '=', discrepancy.walletId)
      .executeTakeFirst();
    const reported = await withTransaction(
      this.#d.db,
      async (trx) => {
        const recent = await trx
          .selectFrom('audit_events')
          .select('id')
          .where('event_type', '=', 'RECONCILIATION_DISCREPANCY')
          .where('wallet_id', '=', discrepancy.walletId)
          .where('occurred_at', '>', sql<Date>`now() - interval '24 hours'`)
          .where(sql<boolean>`payload ->> 'fingerprint' = ${fingerprint}`)
          .executeTakeFirst();
        if (recent) return false;
        await this.#d.audit.append(trx, {
          actorType: 'SYSTEM',
          actorId: 'reconciler',
          userId: wallet?.user_id ?? null,
          walletId: discrepancy.walletId,
          eventType: 'RECONCILIATION_DISCREPANCY',
          targetType: 'wallet',
          targetId: discrepancy.walletId,
          payload: { kind: discrepancy.kind, fingerprint, ...discrepancy.detail },
        });
        return true;
      },
      { auditLock: true },
    );
    if (!reported) return;
    this.#d.metrics.reconcilerDiscrepancies.inc({ kind: discrepancy.kind });
    this.#d.logger.error(
      {
        alert: 'RECONCILIATION_DISCREPANCY',
        walletId: discrepancy.walletId,
        kind: discrepancy.kind,
        ...discrepancy.detail,
      },
      'discrepancia entre la DB y la cadena',
    );
  }
}
