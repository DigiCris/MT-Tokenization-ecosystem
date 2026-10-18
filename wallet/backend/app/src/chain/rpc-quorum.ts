// Cliente RPC de quórum [B-RPC] sobre viem, con dos transports independientes (primario y secundario).
//
// - [B-RPC-01] Health check cada RPC_HEALTH_INTERVAL_MS: chainId, head y latencia de cada proveedor; un proveedor con
//   chainId distinto, sin respuesta o atrasado más de RPC_MAX_HEAD_LAG_BLOCKS queda no sano.
// - [B-RPC-02] Lecturas sensibles: se fija un bloque común `min(headA, headB) - 1`, se consulta en ambos y se compara.
//   Si difieren o uno falla, se reintenta con backoff; si persiste: RPC_DISAGREEMENT o RPC_UNAVAILABLE/RPC_TIMEOUT y
//   no se toma la decisión. En `local-single` (fork local) se lee sólo el primario en su head.
// - [B-RPC-03] Escrituras: `eth_sendRawTransaction` a ambos; éxito si al menos uno acepta o ya conoce la tx.
import { setTimeout as sleep } from 'node:timers/promises';
import {
  createPublicClient,
  http,
  keccak256,
  TimeoutError,
  type Abi,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hash,
  type Hex,
  type ReadContractParameters,
  type ReadContractReturnType,
  type TransactionReceipt,
} from 'viem';
import { base } from 'viem/chains';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';

export type ProviderName = 'primary' | 'secondary';
export type QuorumMode = 'local-single' | 'dual';

export interface RpcQuorumOptions {
  primaryUrl: string;
  secondaryUrl: string;
  mode: QuorumMode;
  chainId: number;
  timeoutMs: number;
  healthIntervalMs: number;
  maxHeadLagBlocks: number;
  retries: number;
  backoffMs: number;
  logger: Logger;
  metrics: Metrics;
}

export interface ProviderHealth {
  provider: ProviderName;
  healthy: boolean;
  chainId: number | null;
  head: bigint | null;
  latencyMs: number | null;
  lagBlocks: number | null;
  reason: 'OK' | 'UNREACHABLE' | 'TIMEOUT' | 'CHAIN_ID_MISMATCH' | 'HEAD_LAG' | 'NOT_CHECKED';
  checkedAt: Date | null;
}

export type RpcErrorCode = 'RPC_TIMEOUT' | 'RPC_UNAVAILABLE' | 'RPC_DISAGREEMENT' | 'RPC_CHAIN_MISMATCH';

export class RpcQuorumError extends Error {
  override name = 'RpcQuorumError';
  readonly code: RpcErrorCode;

  constructor(code: RpcErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

function createBaseClient(url: string, timeoutMs: number) {
  return createPublicClient({ chain: base, transport: http(url, { timeout: timeoutMs, retryCount: 0 }) });
}

/** Cliente viem con los formatters de Base (transacciones de depósito del OP Stack). */
export type BaseClient = ReturnType<typeof createBaseClient>;

interface Provider {
  name: ProviderName;
  client: BaseClient;
}

/** Igualdad estructural con soporte de bigint (los resultados de viem usan bigint). */
export function sameResult(a: unknown, b: unknown): boolean {
  const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? `${v.toString()}n` : v);
  return JSON.stringify(a, replacer) === JSON.stringify(b, replacer);
}

function errorKind(error: unknown): 'timeout' | 'unavailable' {
  if (error instanceof TimeoutError) return 'timeout';
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' ? 'timeout' : 'unavailable';
}

// "nonce too low" no cuenta: prueba que la cuenta avanzó, no que esta transacción sea la que se minó.
const ALREADY_KNOWN = /already known|known transaction|already imported/i;

export class RpcQuorumClient {
  readonly #options: RpcQuorumOptions;
  readonly #providers: readonly Provider[];
  readonly #logger: Logger;
  readonly #health = new Map<ProviderName, ProviderHealth>();
  #timer: NodeJS.Timeout | undefined;
  #checking: Promise<ProviderHealth[]> | undefined;

  constructor(options: RpcQuorumOptions) {
    this.#options = options;
    this.#logger = options.logger.child({ component: 'rpc-quorum' });
    const make = (name: ProviderName, url: string): Provider => ({
      name,
      client: createBaseClient(url, options.timeoutMs),
    });
    this.#providers =
      options.mode === 'dual'
        ? [make('primary', options.primaryUrl), make('secondary', options.secondaryUrl)]
        : [make('primary', options.primaryUrl)];
    for (const p of this.#providers) {
      this.#health.set(p.name, {
        provider: p.name,
        healthy: false,
        chainId: null,
        head: null,
        latencyMs: null,
        lagBlocks: null,
        reason: 'NOT_CHECKED',
        checkedAt: null,
      });
    }
  }

  get mode(): QuorumMode {
    return this.#options.mode;
  }

  /** Mide y registra la duración de una llamada a un proveedor. */
  async #call<T>(provider: Provider, method: string, fn: () => Promise<T>): Promise<T> {
    const end = this.#options.metrics.rpcRequestDuration.startTimer({ provider: provider.name, method });
    try {
      return await fn();
    } catch (error) {
      this.#options.metrics.rpcErrors.inc({ provider: provider.name, kind: errorKind(error) });
      throw error;
    } finally {
      end();
    }
  }

  // --- Salud ---------------------------------------------------------------------------------------------------

  async #probe(provider: Provider): Promise<ProviderHealth> {
    const started = performance.now();
    try {
      const [chainId, head] = await Promise.all([
        this.#call(provider, 'eth_chainId', () => provider.client.getChainId()),
        this.#call(provider, 'eth_blockNumber', () => provider.client.getBlockNumber({ cacheTime: 0 })),
      ]);
      const latencyMs = Math.round(performance.now() - started);
      const healthy = chainId === this.#options.chainId;
      return {
        provider: provider.name,
        healthy,
        chainId,
        head,
        latencyMs,
        lagBlocks: null,
        reason: healthy ? 'OK' : 'CHAIN_ID_MISMATCH',
        checkedAt: new Date(),
      };
    } catch (error) {
      return {
        provider: provider.name,
        healthy: false,
        chainId: null,
        head: null,
        latencyMs: null,
        lagBlocks: null,
        reason: errorKind(error) === 'timeout' ? 'TIMEOUT' : 'UNREACHABLE',
        checkedAt: new Date(),
      };
    }
  }

  /** Una ronda de health checks (concurrente entre proveedores). */
  async checkHealth(): Promise<ProviderHealth[]> {
    this.#checking ??= (async () => {
      const results = await Promise.all(this.#providers.map((p) => this.#probe(p)));
      const heads = results.flatMap((r) => (r.head === null ? [] : [r.head]));
      const maxHead = heads.length > 0 ? heads.reduce((a, b) => (a > b ? a : b)) : null;
      for (const r of results) {
        if (r.head !== null && maxHead !== null) {
          r.lagBlocks = Number(maxHead - r.head);
          if (r.healthy && r.lagBlocks > this.#options.maxHeadLagBlocks) {
            r.healthy = false;
            r.reason = 'HEAD_LAG';
          }
        }
        const previous = this.#health.get(r.provider);
        if (previous && previous.healthy !== r.healthy) {
          this.#logger[r.healthy ? 'info' : 'warn'](
            { provider: r.provider, reason: r.reason },
            'cambio de salud del proveedor RPC',
          );
        }
        this.#health.set(r.provider, r);
        this.#options.metrics.rpcHealthy.set({ provider: r.provider }, r.healthy ? 1 : 0);
        if (r.lagBlocks !== null) this.#options.metrics.rpcHeadLag.set({ provider: r.provider }, r.lagBlocks);
      }
      return results;
    })().finally(() => {
      this.#checking = undefined;
    });
    return this.#checking;
  }

  /** Estado del último health check. `ready` exige todos los proveedores del modo sanos. */
  health(): { ready: boolean; mode: QuorumMode; providers: ProviderHealth[] } {
    const providers = [...this.#health.values()];
    return { ready: providers.every((p) => p.healthy), mode: this.#options.mode, providers };
  }

  start(): void {
    if (this.#timer) return;
    const tick = () => {
      void this.checkHealth().catch((error: unknown) => {
        this.#logger.error({ err: error }, 'health check RPC falló');
      });
    };
    tick();
    this.#timer = setInterval(tick, this.#options.healthIntervalMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#checking?.catch(() => undefined);
  }

  // --- Lecturas sensibles ----------------------------------------------------------------------------------

  /**
   * Lectura sensible con quórum: el mismo `read` en el bloque común de ambos proveedores; devuelve el valor sólo si
   * coinciden (o, en local-single, el del primario en su head).
   */
  async readSensitive<T>(
    label: string,
    read: (client: BaseClient, blockNumber: bigint) => Promise<T>,
    compare: (a: T, b: T) => boolean = sameResult,
  ): Promise<{ value: T; blockNumber: bigint }> {
    const { retries, backoffMs } = this.#options;
    let lastError: RpcQuorumError | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));
      try {
        const heads = await Promise.all(
          this.#providers.map((p) => this.#call(p, 'eth_blockNumber', () => p.client.getBlockNumber({ cacheTime: 0 }))),
        );
        const minHead = heads.reduce((a, b) => (a < b ? a : b));
        const blockNumber = this.#options.mode === 'dual' ? minHead - 1n : minHead;
        const values = await Promise.all(
          this.#providers.map((p) => this.#call(p, label, () => read(p.client, blockNumber))),
        );
        const [first, ...rest] = values as [T, ...T[]];
        if (rest.every((v) => compare(first, v))) return { value: first, blockNumber };
        this.#options.metrics.rpcDisagreements.inc({ method: label });
        this.#logger.warn({ label, blockNumber: blockNumber.toString(), attempt }, 'desacuerdo entre proveedores RPC');
        lastError = new RpcQuorumError('RPC_DISAGREEMENT', `los proveedores no coinciden en ${label}`);
      } catch (error) {
        if (error instanceof RpcQuorumError) throw error;
        const kind = errorKind(error);
        lastError = new RpcQuorumError(
          kind === 'timeout' ? 'RPC_TIMEOUT' : 'RPC_UNAVAILABLE',
          `lectura ${label} sin respuesta de los proveedores`,
          { cause: error },
        );
      }
    }
    throw lastError ?? new RpcQuorumError('RPC_UNAVAILABLE', `lectura ${label} sin resultado`);
  }

  async readContract<
    const abi extends Abi,
    functionName extends ContractFunctionName<abi, 'pure' | 'view'>,
    const args extends ContractFunctionArgs<abi, 'pure' | 'view', functionName>,
  >(
    parameters: Omit<ReadContractParameters<abi, functionName, args>, 'blockNumber' | 'blockTag'>,
  ): Promise<{ value: ReadContractReturnType<abi, functionName, args>; blockNumber: bigint }> {
    return this.readSensitive(`eth_call:${parameters.functionName}`, (client, blockNumber) =>
      client.readContract({ ...parameters, blockNumber } as ReadContractParameters<abi, functionName, args>),
    );
  }

  async getBalance(address: Address): Promise<{ value: bigint; blockNumber: bigint }> {
    return this.readSensitive('eth_getBalance', (client, blockNumber) => client.getBalance({ address, blockNumber }));
  }

  /** Nonce de cuenta confirmado (`latest`) con quórum: el signer exige firmar con exactamente este nonce. */
  async getTransactionCount(address: Address): Promise<{ value: bigint; blockNumber: bigint }> {
    const { value, blockNumber } = await this.readSensitive('eth_getTransactionCount', (client, block) =>
      client.getTransactionCount({ address, blockNumber: block }),
    );
    return { value: BigInt(value), blockNumber };
  }

  /**
   * Fees EIP-1559 sugeridos por el primario: priority fee del nodo y `maxFeePerGas = 2·baseFee + priority`. No es una
   * lectura sensible (el signer aplica sus topes).
   */
  async feeData(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const provider = this.#providers[0];
    if (provider === undefined) throw new RpcQuorumError('RPC_UNAVAILABLE', 'sin proveedor primario');
    const [block, priority] = await Promise.all([
      this.#call(provider, 'eth_getBlockByNumber', () => provider.client.getBlock({ blockTag: 'latest' })),
      this.#call(provider, 'eth_maxPriorityFeePerGas', () => provider.client.estimateMaxPriorityFeePerGas()),
    ]);
    const baseFee = block.baseFeePerGas ?? 0n;
    return { maxFeePerGas: baseFee * 2n + priority, maxPriorityFeePerGas: priority };
  }

  async getCode(address: Address): Promise<{ value: Hex | undefined; blockNumber: bigint }> {
    return this.readSensitive('eth_getCode', (client, blockNumber) => client.getCode({ address, blockNumber }));
  }

  async getStorageAt(address: Address, slot: Hex): Promise<{ value: Hex | undefined; blockNumber: bigint }> {
    return this.readSensitive('eth_getStorageAt', (client, blockNumber) =>
      client.getStorageAt({ address, slot, blockNumber }),
    );
  }

  /**
   * Receipt con quórum: ambos proveedores deben devolver el mismo bloque, hash de bloque y status. `null` si ninguno
   * lo conoce todavía; si sólo uno lo conoce se reintenta y, si persiste, RPC_DISAGREEMENT.
   */
  async getTransactionReceipt(hash: Hash): Promise<TransactionReceipt | null> {
    const summary = (r: TransactionReceipt | null) =>
      r === null ? null : { blockHash: r.blockHash, blockNumber: r.blockNumber, status: r.status };
    const { value } = await this.readSensitive(
      'eth_getTransactionReceipt',
      async (client) => {
        try {
          return await client.getTransactionReceipt({ hash });
        } catch (error) {
          if ((error as { name?: string }).name === 'TransactionReceiptNotFoundError') return null;
          throw error;
        }
      },
      (a, b) => sameResult(summary(a), summary(b)),
    );
    return value;
  }

  /** Head común de los proveedores (el bloque de las lecturas sensibles: `min(heads) − 1` en dual). */
  async commonHead(): Promise<bigint> {
    const { blockNumber } = await this.readSensitive('eth_blockNumber', () => Promise.resolve(true));
    return blockNumber;
  }

  /**
   * Heads `safe` y `finalized` (ADR-018): el MÍNIMO entre los proveedores (nunca confirma de más). Si algún
   * proveedor no responde, RPC_UNAVAILABLE y no se decide nada.
   */
  async headTags(): Promise<{ safe: bigint; finalized: bigint }> {
    const values = await Promise.all(
      this.#providers.map(async (p) => {
        try {
          const [safe, finalized] = await Promise.all([
            this.#call(p, 'eth_getBlockByNumber:safe', () => p.client.getBlock({ blockTag: 'safe' })),
            this.#call(p, 'eth_getBlockByNumber:finalized', () => p.client.getBlock({ blockTag: 'finalized' })),
          ]);
          return { safe: safe.number, finalized: finalized.number };
        } catch (error) {
          throw new RpcQuorumError(
            errorKind(error) === 'timeout' ? 'RPC_TIMEOUT' : 'RPC_UNAVAILABLE',
            'heads safe/finalized',
            {
              cause: error,
            },
          );
        }
      }),
    );
    return values.reduce((a, b) => ({
      safe: a.safe < b.safe ? a.safe : b.safe,
      finalized: a.finalized < b.finalized ? a.finalized : b.finalized,
    }));
  }

  /** ¿Algún proveedor tiene la tx pendiente (en el mempool, sin bloque)? */
  async isPending(hash: Hash): Promise<boolean> {
    const results = await Promise.allSettled(
      this.#providers.map((p) => this.#call(p, 'eth_getTransactionByHash', () => p.client.getTransaction({ hash }))),
    );
    // viem tipa el resultado como minado; una tx del mempool llega con blockNumber null.
    return results.some(
      (r) => r.status === 'fulfilled' && (r.value as { blockNumber: bigint | null }).blockNumber === null,
    );
  }

  // --- Escrituras ------------------------------------------------------------------------------------------

  /** [B-RPC-03] Transmite a todos los proveedores; éxito si al menos uno acepta o ya conoce la transacción. */
  async sendRawTransaction(serialized: Hex): Promise<{ hash: Hash; acceptedBy: ProviderName[] }> {
    const hash = keccak256(serialized);
    const results = await Promise.allSettled(
      this.#providers.map((p) =>
        this.#call(p, 'eth_sendRawTransaction', () =>
          p.client.sendRawTransaction({ serializedTransaction: serialized }),
        ),
      ),
    );
    const acceptedBy: ProviderName[] = [];
    results.forEach((result, i) => {
      const provider = this.#providers[i];
      if (!provider) return;
      if (result.status === 'fulfilled') {
        if (result.value.toLowerCase() === hash.toLowerCase()) acceptedBy.push(provider.name);
      } else {
        const reason = result.reason as { details?: unknown; message?: unknown };
        const message =
          typeof reason.details === 'string'
            ? reason.details
            : typeof reason.message === 'string'
              ? reason.message
              : '';
        if (ALREADY_KNOWN.test(message)) acceptedBy.push(provider.name);
      }
    });
    if (acceptedBy.length === 0) {
      const first = results.find((r) => r.status === 'rejected');
      throw new RpcQuorumError('RPC_UNAVAILABLE', 'ningún proveedor aceptó la transacción', {
        cause: first?.status === 'rejected' ? first.reason : undefined,
      });
    }
    return { hash, acceptedBy };
  }
}
