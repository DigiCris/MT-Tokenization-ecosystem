// Indexer de la cadena (P13.T07, [B-FIN-03]): eventos de SafeL2 de las Safes de la plataforma (ejecuciones del backend
// y soberanas, para que el historial sea completo), `Transfer` de USDC/USDT desde/hacia esas Safes (`token_transfers`)
// y altas/bajas de DestinationWhitelist de esas Safes (`whitelist_events`, P14: las aplica la sincronización de whitelist
// del worker, también las soberanas o las hechas con MultiSend) y propuestas, cancelaciones y ejecuciones de rotación del
// RotationTimelock (`rotation_events`, P15: también las que no originó el backend).
// Lee por rangos de bloques con quórum (los dos proveedores tienen que devolver exactamente los mismos logs) hasta el
// head común, guarda el cursor con el hash de su bloque y, si ese hash cambió, retrocede y marca REORGED lo indexado
// después del punto de retroceso. Las filas avanzan MINED → CONFIRMED → FINALIZED con la misma política de finalidad
// que las operaciones (ADR-018) y con el hash de su bloque reconfirmado; si cambió, REORGED (y el re-escaneo las vuelve
// a insertar con el bloque nuevo).
import { sql, type Kysely } from 'kysely';
import { decodeAbiParameters, getAddress, parseAbiItem, toEventSelector, type Address, type Hex, type Log } from 'viem';
import type { AuditWriter } from '../audit/audit-writer.ts';
import type { Database } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import { addressToBuffer, bufferToAddress, bufferToHex, hexToBuffer } from '../lib/bytes.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import { timelocksOf } from '../policy/guards.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';
import { RpcQuorumError, type BaseClient, type RpcQuorumClient } from './rpc-quorum.ts';
import type { ConfirmationPolicy } from './watcher.ts';

export const SAFE_MULTISIG_TRANSACTION = parseAbiItem(
  'event SafeMultiSigTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures, bytes additionalInfo)',
);
export const EXECUTION_SUCCESS = parseAbiItem('event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)');
export const EXECUTION_FAILURE = parseAbiItem('event ExecutionFailure(bytes32 indexed txHash, uint256 payment)');
export const ERC20_TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
export const DESTINATION_ADDED = parseAbiItem(
  'event DestinationAdded(address indexed safe, address indexed destination, uint64 activatesAt)',
);
export const DESTINATION_REMOVED = parseAbiItem(
  'event DestinationRemoved(address indexed safe, address indexed destination)',
);
const ADDED_TOPIC = toEventSelector(DESTINATION_ADDED).toLowerCase();
export const ROTATION_PROPOSED = parseAbiItem(
  'event RotationProposed(bytes32 indexed id, address indexed safe, uint8 kind, address oldValue, address newValue, uint64 executableAt)',
);
export const ROTATION_CANCELLED = parseAbiItem(
  'event RotationCancelled(bytes32 indexed id, address indexed safe, address indexed by)',
);
export const ROTATION_EXECUTED = parseAbiItem('event RotationExecuted(bytes32 indexed id, address indexed safe)');
const PROPOSED_TOPIC = toEventSelector(ROTATION_PROPOSED).toLowerCase();
const CANCELLED_TOPIC = toEventSelector(ROTATION_CANCELLED).toLowerCase();

const MULTISIG_TOPIC = toEventSelector(SAFE_MULTISIG_TRANSACTION).toLowerCase();
const SUCCESS_TOPIC = toEventSelector(EXECUTION_SUCCESS).toLowerCase();
const FAILURE_TOPIC = toEventSelector(EXECUTION_FAILURE).toLowerCase();

export const INDEXER_CURSOR = 'chain-indexer';
const REORG_KIND = {
  safe_executions: 'execution',
  token_transfers: 'transfer',
  whitelist_events: 'whitelist',
  rotation_events: 'rotation',
} as const;

/** El RotationTimelock del Guard del sistema y los de sus sucesores fijados en el snapshot ([C-GRD-17]). */
function rotationTimelocks(snapshot: BackendPolicySnapshot): Address[] {
  return timelocksOf(snapshot);
}
/** Bloques que retrocede el cursor al detectar un reorg (más que cualquier reorg observado en Base). */
const REWIND_BLOCKS = 64n;
const ADDRESS_CHUNK = 200;

export interface IndexerDeps {
  db: Kysely<Database>;
  rpc: RpcQuorumClient;
  audit: AuditWriter;
  snapshot: () => BackendPolicySnapshot;
  confirmations: ConfirmationPolicy;
  logger: Logger;
  metrics: Metrics;
  /** Bloques por pasada (default 500). */
  batchBlocks?: number;
}

/** Lo que comparan los dos proveedores de un log (bigint como string). */
interface LogSummary {
  address: Address;
  blockNumber: string;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
  topics: Hex[];
  data: Hex;
}

function summarize(log: Log): LogSummary {
  return {
    address: getAddress(log.address),
    blockNumber: (log.blockNumber ?? 0n).toString(),
    blockHash: log.blockHash ?? '0x',
    transactionHash: log.transactionHash ?? '0x',
    logIndex: log.logIndex ?? -1,
    topics: [...log.topics] as Hex[],
    data: log.data,
  };
}

const addressOfTopic = (topic: Hex | undefined): Address => getAddress(`0x${(topic ?? '0x').slice(-40)}`);

export interface IndexerResult {
  fromBlock: string | null;
  toBlock: string | null;
  executions: number;
  transfers: number;
  whitelistEvents: number;
  rotationEvents: number;
  rewound: boolean;
}

export class ChainIndexer {
  readonly #d: IndexerDeps;
  /** Bloques por consulta de logs: se achica si el proveedor rechaza el rango (límites de plan). */
  #span: bigint;

  constructor(deps: IndexerDeps) {
    this.#d = deps;
    this.#span = BigInt(deps.batchBlocks ?? 500);
  }

  /** Bloque anterior al deploy de la primera wallet: el indexer nunca necesita mirar antes. */
  async #startBlock(): Promise<bigint | null> {
    const first = await this.#d.db
      .selectFrom('wallets')
      .select(sql<string | null>`min(deploy_block_number)`.as('block'))
      .executeTakeFirstOrThrow();
    return first.block === null ? null : BigInt(first.block) - 1n;
  }

  async #blockHash(blockNumber: bigint): Promise<Hex> {
    const { value } = await this.#d.rpc.readSensitive('eth_getBlockByNumber:hash', (client) =>
      client.getBlock({ blockNumber }).then((b) => b.hash),
    );
    return value;
  }

  async #safes(): Promise<Address[]> {
    const rows = await this.#d.db
      .selectFrom('wallets')
      .select('safe_address')
      .where('safe_address', 'is not', null)
      .where('status', 'in', ['ACTIVE', 'SOVEREIGN_MODIFIED', 'MIGRATING', 'MIGRATED'])
      .execute();
    return rows.flatMap((r) => (r.safe_address === null ? [] : [bufferToAddress(r.safe_address)]));
  }

  /** Una pasada: verifica el cursor, indexa el siguiente rango y avanza la finalidad de lo indexado. */
  async runOnce(): Promise<IndexerResult> {
    const result: IndexerResult = {
      fromBlock: null,
      toBlock: null,
      executions: 0,
      transfers: 0,
      whitelistEvents: 0,
      rotationEvents: 0,
      rewound: false,
    };
    const head = await this.#d.rpc.commonHead();
    let cursor = await this.#d.db
      .selectFrom('chain_cursors')
      .selectAll()
      .where('name', '=', INDEXER_CURSOR)
      .executeTakeFirst();
    if (!cursor) {
      const start = await this.#startBlock();
      if (start === null) return result;
      cursor = await this.#saveCursor(start, await this.#blockHash(start));
    }
    let position = BigInt(cursor.block_number);
    if ((await this.#blockHash(position)) !== bufferToHex(cursor.block_hash)) {
      position = await this.#rewind(position);
      result.rewound = true;
    }
    if (position < head) {
      const from = position + 1n;
      const safes = await this.#safes();
      let to: bigint;
      for (;;) {
        const max = from + this.#span - 1n;
        to = max < head ? max : head;
        if (safes.length === 0) break;
        try {
          const counts = await this.#indexRange(safes, from, to);
          result.executions = counts.executions;
          result.transfers = counts.transfers;
          result.whitelistEvents = counts.whitelistEvents;
          result.rotationEvents = counts.rotationEvents;
          break;
        } catch (error) {
          // Un proveedor que limita el rango de eth_getLogs (p. ej. un plan gratuito): se reintenta con la mitad.
          if (!(error instanceof RpcQuorumError) || this.#span === 1n) throw error;
          this.#span = (this.#span + 1n) / 2n;
          this.#d.logger.warn({ span: this.#span.toString() }, 'eth_getLogs rechazado: se achica el rango');
        }
      }
      await this.#saveCursor(to, await this.#blockHash(to));
      result.fromBlock = from.toString();
      result.toBlock = to.toString();
      this.#d.metrics.indexerHeadBlock.set({ indexer: INDEXER_CURSOR }, Number(to));
    }
    await this.#advanceFinality(head);
    return result;
  }

  async #saveCursor(blockNumber: bigint, hash: Hex) {
    return this.#d.db
      .insertInto('chain_cursors')
      .values({ name: INDEXER_CURSOR, block_number: blockNumber.toString(), block_hash: hexToBuffer(hash, 32) })
      .onConflict((oc) =>
        oc.column('name').doUpdateSet({
          block_number: blockNumber.toString(),
          block_hash: hexToBuffer(hash, 32),
          updated_at: sql`now()`,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Reorg bajo el cursor: retrocede y marca REORGED lo indexado después (el re-escaneo lo vuelve a insertar). */
  async #rewind(position: bigint): Promise<bigint> {
    const start = (await this.#startBlock()) ?? 0n;
    const back = position > REWIND_BLOCKS ? position - REWIND_BLOCKS : 0n;
    const target = back > start ? back : start;
    await withTransaction(this.#d.db, async (trx) => {
      await trx
        .updateTable('safe_executions')
        .set({ status: 'REORGED', updated_at: sql`now()` })
        .where('block_number', '>', target.toString())
        .where('status', 'in', ['MINED', 'CONFIRMED'])
        .execute();
      await trx
        .updateTable('token_transfers')
        .set({ status: 'REORGED', updated_at: sql`now()` })
        .where('block_number', '>', target.toString())
        .where('status', 'in', ['MINED', 'CONFIRMED'])
        .execute();
      for (const table of ['whitelist_events', 'rotation_events'] as const) {
        await trx
          .updateTable(table)
          .set({ status: 'REORGED' })
          .where('block_number', '>', target.toString())
          .where('status', 'in', ['MINED', 'CONFIRMED'])
          .execute();
      }
    });
    await this.#saveCursor(target, await this.#blockHash(target));
    this.#d.metrics.reorgsDetected.inc({ kind: 'indexer' });
    this.#d.logger.error(
      { alert: 'REORG_DETECTED', from: position.toString(), to: target.toString() },
      'reorg bajo el cursor del indexer: se re-escanea',
    );
    return target;
  }

  /** Logs con quórum: el resultado (resumido y ordenado) tiene que ser idéntico en los dos proveedores. */
  async #logs<L extends Log>(label: string, query: (client: BaseClient) => Promise<L[]>) {
    const { value } = await this.#d.rpc.readSensitive(label, async (client) =>
      (await query(client))
        .map(summarize)
        .sort((a, b) =>
          a.blockNumber === b.blockNumber
            ? a.logIndex - b.logIndex
            : Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)),
        ),
    );
    return value;
  }

  async #indexRange(
    safes: Address[],
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<{ executions: number; transfers: number; whitelistEvents: number; rotationEvents: number }> {
    const snapshot = this.#d.snapshot();
    const tokens = [snapshot.tokens.USDC, snapshot.tokens.USDT];
    const whitelist = snapshot.contracts.destinationWhitelist;
    const timelocks = rotationTimelocks(snapshot);
    const safeEvents: LogSummary[] = [];
    const transfers: LogSummary[] = [];
    const whitelistLogs: LogSummary[] = [];
    const rotationLogs: LogSummary[] = [];
    for (let i = 0; i < safes.length; i += ADDRESS_CHUNK) {
      const chunk = safes.slice(i, i + ADDRESS_CHUNK);
      safeEvents.push(
        ...(await this.#logs('eth_getLogs:safe', (client) =>
          client.getLogs({
            address: chunk,
            events: [SAFE_MULTISIG_TRANSACTION, EXECUTION_SUCCESS, EXECUTION_FAILURE],
            fromBlock,
            toBlock,
          }),
        )),
      );
      transfers.push(
        ...(await this.#logs('eth_getLogs:transfer-out', (client) =>
          client.getLogs({ address: tokens, event: ERC20_TRANSFER, args: { from: chunk }, fromBlock, toBlock }),
        )),
        ...(await this.#logs('eth_getLogs:transfer-in', (client) =>
          client.getLogs({ address: tokens, event: ERC20_TRANSFER, args: { to: chunk }, fromBlock, toBlock }),
        )),
      );
      whitelistLogs.push(
        ...(await this.#logs('eth_getLogs:whitelist-added', (client) =>
          client.getLogs({ address: whitelist, event: DESTINATION_ADDED, args: { safe: chunk }, fromBlock, toBlock }),
        )),
        ...(await this.#logs('eth_getLogs:whitelist-removed', (client) =>
          client.getLogs({ address: whitelist, event: DESTINATION_REMOVED, args: { safe: chunk }, fromBlock, toBlock }),
        )),
      );
    }
    for (let i = 0; i < safes.length; i += ADDRESS_CHUNK) {
      const chunk = safes.slice(i, i + ADDRESS_CHUNK);
      for (const event of [ROTATION_PROPOSED, ROTATION_CANCELLED, ROTATION_EXECUTED]) {
        rotationLogs.push(
          ...(await this.#logs(`eth_getLogs:${event.name}`, (client) =>
            client.getLogs({ address: timelocks, event, args: { safe: chunk }, fromBlock, toBlock }),
          )),
        );
      }
    }
    const executions = await this.#storeExecutions(safeEvents);
    const stored = await this.#storeTransfers(transfers, new Set(safes.map((s) => s.toLowerCase())));
    const whitelistEvents = await this.#storeWhitelistEvents(whitelistLogs);
    const rotationEvents = await this.#storeRotationEvents(rotationLogs);
    return { executions, transfers: stored, whitelistEvents, rotationEvents };
  }

  /** Propuestas, cancelaciones y ejecuciones del RotationTimelock (las aplica la sincronización de rotaciones). */
  async #storeRotationEvents(logs: LogSummary[]): Promise<number> {
    const snapshot = this.#d.snapshot();
    let stored = 0;
    for (const log of logs) {
      const topic0 = log.topics[0]?.toLowerCase();
      const kind = topic0 === PROPOSED_TOPIC ? 'PROPOSED' : topic0 === CANCELLED_TOPIC ? 'CANCELLED' : 'EXECUTED';
      const proposed =
        kind === 'PROPOSED'
          ? decodeAbiParameters(
              [{ type: 'uint8' }, { type: 'address' }, { type: 'address' }, { type: 'uint64' }],
              log.data,
            )
          : null;
      const result = await this.#d.db
        .insertInto('rotation_events')
        .values({
          chain_id: snapshot.chainId,
          safe_address: addressToBuffer(addressOfTopic(log.topics[2])),
          timelock: addressToBuffer(log.address),
          proposal_id: hexToBuffer(log.topics[1] ?? '0x', 32),
          kind,
          rotation_kind: proposed ? proposed[0] : null,
          old_value: proposed ? addressToBuffer(proposed[1]) : null,
          new_value: proposed ? addressToBuffer(proposed[2]) : null,
          executable_at: proposed ? new Date(Number(proposed[3]) * 1000) : null,
          actor: kind === 'CANCELLED' ? addressToBuffer(addressOfTopic(log.topics[3])) : null,
          tx_hash: hexToBuffer(log.transactionHash, 32),
          log_index: log.logIndex,
          block_number: log.blockNumber,
          block_hash: hexToBuffer(log.blockHash, 32),
          status: 'MINED',
        })
        .onConflict((oc) =>
          oc.columns(['chain_id', 'tx_hash', 'log_index']).doUpdateSet({
            block_number: log.blockNumber,
            block_hash: hexToBuffer(log.blockHash, 32),
            status: 'MINED',
          }),
        )
        .returning(sql<boolean>`(xmax = 0)`.as('inserted'))
        .executeTakeFirstOrThrow();
      if (result.inserted) stored++;
    }
    return stored;
  }

  /** Altas y bajas de DestinationWhitelist (las aplica la sincronización de whitelist cuando están confirmadas). */
  async #storeWhitelistEvents(logs: LogSummary[]): Promise<number> {
    const snapshot = this.#d.snapshot();
    let stored = 0;
    for (const log of logs) {
      const added = log.topics[0]?.toLowerCase() === ADDED_TOPIC;
      const [activatesAt] = added ? decodeAbiParameters([{ type: 'uint64' }], log.data) : [null];
      const result = await this.#d.db
        .insertInto('whitelist_events')
        .values({
          chain_id: snapshot.chainId,
          safe_address: addressToBuffer(addressOfTopic(log.topics[1])),
          destination: addressToBuffer(addressOfTopic(log.topics[2])),
          kind: added ? 'ADDED' : 'REMOVED',
          activates_at: activatesAt === null ? null : new Date(Number(activatesAt) * 1000),
          tx_hash: hexToBuffer(log.transactionHash, 32),
          log_index: log.logIndex,
          block_number: log.blockNumber,
          block_hash: hexToBuffer(log.blockHash, 32),
          status: 'MINED',
        })
        .onConflict((oc) =>
          oc.columns(['chain_id', 'tx_hash', 'log_index']).doUpdateSet({
            block_number: log.blockNumber,
            block_hash: hexToBuffer(log.blockHash, 32),
            status: 'MINED',
          }),
        )
        .returning(sql<boolean>`(xmax = 0)`.as('inserted'))
        .executeTakeFirstOrThrow();
      if (result.inserted) stored++;
    }
    return stored;
  }

  /** Empareja cada ExecutionSuccess/Failure con el SafeMultiSigTransaction previo de la misma Safe y tx. */
  async #storeExecutions(logs: LogSummary[]): Promise<number> {
    const snapshot = this.#d.snapshot();
    let stored = 0;
    const lastMultisig = new Map<string, LogSummary>();
    for (const log of logs) {
      const topic0 = log.topics[0]?.toLowerCase();
      const key = `${log.transactionHash}:${log.address.toLowerCase()}`;
      if (topic0 === MULTISIG_TOPIC) {
        lastMultisig.set(key, log);
        continue;
      }
      if (topic0 !== SUCCESS_TOPIC && topic0 !== FAILURE_TOPIC) continue;
      const multisig = lastMultisig.get(key);
      lastMultisig.delete(key);
      if (!multisig) continue;
      const [to, value, data, operation, , , , , , , additionalInfo] = decodeAbiParameters(
        SAFE_MULTISIG_TRANSACTION.inputs,
        multisig.data,
      );
      const [nonce, sender] = decodeAbiParameters(
        [{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }],
        additionalInfo,
      );
      const safeTxHash = log.topics[1] ?? '0x';
      // La misma SafeTx puede tener filas terminadas (vencida, cancelada) además de la que se ejecutó.
      const operationRow = await this.#d.db
        .selectFrom('wallet_operations')
        .select(['id', 'user_id', 'wallet_id'])
        .where('safe_tx_hash', '=', hexToBuffer(safeTxHash, 32))
        .orderBy((eb) => eb.case().when('status', 'in', ['EXPIRED', 'CANCELLED', 'FAILED_FINAL']).then(1).else(0).end())
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      const origin = operationRow ? 'PLATFORM' : 'SOVEREIGN';
      const inserted = await withTransaction(
        this.#d.db,
        async (trx) => {
          const row = await trx
            .insertInto('safe_executions')
            .values({
              chain_id: snapshot.chainId,
              safe_address: addressToBuffer(log.address),
              safe_nonce: nonce.toString(),
              safe_tx_hash: hexToBuffer(safeTxHash, 32),
              success: topic0 === SUCCESS_TOPIC,
              origin,
              operation_id: operationRow?.id ?? null,
              target: addressToBuffer(to),
              value: value.toString(),
              data: hexToBuffer(data),
              operation,
              sender: addressToBuffer(sender),
              tx_hash: hexToBuffer(log.transactionHash, 32),
              log_index: log.logIndex,
              block_number: log.blockNumber,
              block_hash: hexToBuffer(log.blockHash, 32),
              status: 'MINED',
            })
            .onConflict((oc) =>
              oc.columns(['chain_id', 'tx_hash', 'log_index']).doUpdateSet({
                block_number: log.blockNumber,
                block_hash: hexToBuffer(log.blockHash, 32),
                status: 'MINED',
                updated_at: sql`now()`,
              }),
            )
            .returning(sql<boolean>`(xmax = 0)`.as('inserted'))
            .executeTakeFirstOrThrow();
          if (row.inserted && origin === 'SOVEREIGN') {
            const wallet = await trx
              .selectFrom('wallets')
              .select(['id', 'user_id'])
              .where('chain_id', '=', snapshot.chainId)
              .where('safe_address', '=', addressToBuffer(log.address))
              .executeTakeFirst();
            await this.#d.audit.append(trx, {
              actorType: 'SYSTEM',
              actorId: 'chain-indexer',
              userId: wallet?.user_id ?? null,
              walletId: wallet?.id ?? null,
              eventType: 'SAFE_SOVEREIGN_EXECUTION',
              targetType: 'wallet',
              targetId: wallet?.id ?? null,
              payload: {
                safe: log.address,
                safeTxHash,
                nonce: nonce.toString(),
                to: getAddress(to),
                success: topic0 === SUCCESS_TOPIC,
                txHash: log.transactionHash,
              },
            });
          }
          return row.inserted;
        },
        { auditLock: true },
      );
      if (inserted) stored++;
    }
    return stored;
  }

  async #storeTransfers(logs: LogSummary[], safes: Set<string>): Promise<number> {
    const snapshot = this.#d.snapshot();
    let stored = 0;
    const seen = new Set<string>();
    for (const log of logs) {
      const unique = `${log.transactionHash}:${String(log.logIndex)}`;
      if (seen.has(unique)) continue;
      seen.add(unique);
      const from = addressOfTopic(log.topics[1]);
      const to = addressOfTopic(log.topics[2]);
      const [amount] = decodeAbiParameters([{ type: 'uint256' }], log.data);
      const sides: { safe: Address; direction: 'IN' | 'OUT'; counterparty: Address }[] = [];
      if (safes.has(from.toLowerCase())) sides.push({ safe: from, direction: 'OUT', counterparty: to });
      if (safes.has(to.toLowerCase())) sides.push({ safe: to, direction: 'IN', counterparty: from });
      for (const side of sides) {
        const result = await this.#d.db
          .insertInto('token_transfers')
          .values({
            chain_id: snapshot.chainId,
            safe_address: addressToBuffer(side.safe),
            token: addressToBuffer(log.address),
            direction: side.direction,
            counterparty: addressToBuffer(side.counterparty),
            amount: amount.toString(),
            tx_hash: hexToBuffer(log.transactionHash, 32),
            log_index: log.logIndex,
            block_number: log.blockNumber,
            block_hash: hexToBuffer(log.blockHash, 32),
            status: 'MINED',
          })
          .onConflict((oc) =>
            oc.columns(['chain_id', 'tx_hash', 'log_index', 'safe_address']).doUpdateSet({
              block_number: log.blockNumber,
              block_hash: hexToBuffer(log.blockHash, 32),
              status: 'MINED',
              updated_at: sql`now()`,
            }),
          )
          .returning(sql<boolean>`(xmax = 0)`.as('inserted'))
          .executeTakeFirstOrThrow();
        if (result.inserted) stored++;
      }
    }
    return stored;
  }

  /** MINED/CONFIRMED → CONFIRMED/FINALIZED con el hash del bloque reconfirmado; si cambió, REORGED. */
  async #advanceFinality(head: bigint): Promise<void> {
    const c = this.#d.confirmations;
    const tags = c.policy === 'tags' ? await this.#d.rpc.headTags() : null;
    for (const table of ['safe_executions', 'token_transfers', 'whitelist_events', 'rotation_events'] as const) {
      const blocks = await this.#d.db
        .selectFrom(table)
        .select(['block_number', 'block_hash'])
        .distinct()
        .where('status', 'in', ['MINED', 'CONFIRMED'])
        .orderBy('block_number')
        .limit(200)
        .execute();
      for (const block of blocks) {
        const number = BigInt(block.block_number);
        const canonical = await this.#blockHash(number);
        if (canonical !== bufferToHex(block.block_hash)) {
          await this.#d.db
            .updateTable(table)
            .set({ status: 'REORGED', updated_at: sql`now()` })
            .where('block_number', '=', block.block_number)
            .where('block_hash', '=', block.block_hash)
            .where('status', 'in', ['MINED', 'CONFIRMED'])
            .execute();
          this.#d.metrics.reorgsDetected.inc({ kind: REORG_KIND[table] });
          continue;
        }
        const confirmed = tags ? number <= tags.safe : head - number + 1n >= BigInt(c.confirmationDepth);
        const finalized = tags ? number <= tags.finalized : head - number + 1n >= BigInt(c.finalizationDepth);
        if (!confirmed) continue;
        await this.#d.db
          .updateTable(table)
          .set({ status: finalized ? 'FINALIZED' : 'CONFIRMED', updated_at: sql`now()` })
          .where('block_number', '=', block.block_number)
          .where('block_hash', '=', block.block_hash)
          .where('status', 'in', finalized ? ['MINED', 'CONFIRMED'] : ['MINED'])
          .execute();
      }
    }
  }
}
