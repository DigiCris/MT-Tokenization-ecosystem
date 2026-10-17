// RPC propio del signer [B-RPC-04] con quórum (implementación independiente de la del backend):
//
// - Lecturas sensibles a un bloque común: `min(headA, headB) - 1` en modo `dual` (los dos proveedores deben devolver
//   lo mismo, comparado sobre el valor normalizado: cantidades como número, datos en minúsculas, bloque por hash y
//   timestamp; si difieren se reintenta con backoff y si persiste → RPC_DISAGREEMENT); en `local-single` (fork local)
//   se lee el primario en su head.
// - Simulación (`eth_call`/`eth_estimateGas` en `latest`) en ambos proveedores: los dos deben aceptar.
// - El signer nunca transmite: firma y devuelve la tx; el backend la transmite.
import { setTimeout as sleep } from 'node:timers/promises';
import type { Hex } from '../crypto/bytes.ts';
import type { Address } from '../crypto/keccak.ts';
import { jsonRpc, JsonRpcError } from './json-rpc.ts';

export type QuorumMode = 'local-single' | 'dual';

export interface SignerRpcOptions {
  primaryUrl: string;
  secondaryUrl: string;
  mode: QuorumMode;
  timeoutMs: number;
  retries: number;
  backoffMs: number;
}

export type RpcProblem = 'RPC_UNAVAILABLE' | 'RPC_DISAGREEMENT';

export class RpcQuorumError extends Error {
  override name = 'RpcQuorumError';
  readonly problem: RpcProblem;

  constructor(problem: RpcProblem, message: string) {
    super(message);
    this.problem = problem;
  }
}

/** Revert de un eth_call/eth_estimateGas (con los datos de revert si el proveedor los devuelve). */
export class CallRevertedError extends Error {
  override name = 'CallRevertedError';
  readonly data: Hex | undefined;

  constructor(message: string, data?: Hex) {
    super(message);
    this.data = data;
  }
}

export interface CallRequest {
  from?: Address;
  to: Address;
  data: Hex;
  value?: bigint;
  gas?: bigint;
}

const toHexQuantity = (v: bigint) => `0x${v.toString(16)}`;

/** Clave de comparación entre proveedores (una respuesta que no se puede normalizar cuenta como indisponible). */
type Normalize<T> = (result: T) => string;
const quantity: Normalize<string> = (result) => BigInt(result).toString();
const data: Normalize<string> = (result) => {
  if (!/^0x[0-9a-fA-F]*$/.test(result)) throw new TypeError('dato no hexadecimal');
  return result.toLowerCase();
};

interface BlockHeader {
  hash: string;
  timestamp: string;
}
const header: Normalize<BlockHeader | null> = (result) =>
  result === null ? 'null' : `${data(result.hash)}:${quantity(result.timestamp)}`;

function callObject(req: CallRequest): Record<string, string> {
  return {
    ...(req.from === undefined ? {} : { from: req.from }),
    to: req.to,
    data: req.data,
    ...(req.value === undefined ? {} : { value: toHexQuantity(req.value) }),
    ...(req.gas === undefined ? {} : { gas: toHexQuantity(req.gas) }),
  };
}

export class SignerRpc {
  readonly #options: SignerRpcOptions;
  readonly #urls: readonly string[];

  constructor(options: SignerRpcOptions) {
    this.#options = options;
    this.#urls = options.mode === 'dual' ? [options.primaryUrl, options.secondaryUrl] : [options.primaryUrl];
  }

  get mode(): QuorumMode {
    return this.#options.mode;
  }

  async #one<T>(url: string, method: string, params: unknown[]): Promise<T> {
    return jsonRpc<T>(url, method, params, this.#options.timeoutMs);
  }

  /** Ejecuta en todos los proveedores y exige el mismo resultado normalizado (con reintentos). */
  async #agree<T>(method: string, params: unknown[], normalize: Normalize<T>): Promise<T> {
    let lastProblem: RpcProblem = 'RPC_UNAVAILABLE';
    for (let attempt = 0; attempt <= this.#options.retries; attempt++) {
      if (attempt > 0) await sleep(this.#options.backoffMs * 2 ** (attempt - 1));
      let results: T[];
      let keys: string[];
      try {
        results = await Promise.all(this.#urls.map((url) => this.#one<T>(url, method, params)));
        keys = results.map(normalize);
      } catch (error) {
        if (error instanceof JsonRpcError && error.rpcCode !== undefined && method === 'eth_call') throw error;
        lastProblem = 'RPC_UNAVAILABLE';
        continue;
      }
      if (keys.every((key) => key === keys[0])) return results[0] as T;
      lastProblem = 'RPC_DISAGREEMENT';
    }
    throw new RpcQuorumError(lastProblem, `${method}: ${lastProblem}`);
  }

  async chainId(): Promise<number> {
    return Number(BigInt(await this.#agree<string>('eth_chainId', [], quantity)));
  }

  /** Bloque común para las lecturas sensibles [B-RPC-02]. */
  async snapshotBlock(): Promise<bigint> {
    if (this.#options.mode === 'local-single') {
      return BigInt(await this.#withRetries(() => this.#one<string>(this.#options.primaryUrl, 'eth_blockNumber', [])));
    }
    const heads = await this.#withRetries(() =>
      Promise.all(this.#urls.map((url) => this.#one<string>(url, 'eth_blockNumber', []))),
    );
    const min = heads.map((h) => BigInt(h)).reduce((a, b) => (a < b ? a : b));
    return min - 1n;
  }

  async #withRetries<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch {
        if (attempt >= this.#options.retries)
          throw new RpcQuorumError('RPC_UNAVAILABLE', 'el RPC del signer no responde');
        await sleep(this.#options.backoffMs * 2 ** attempt);
      }
    }
  }

  /** eth_call a un bloque fijo en todos los proveedores (lectura de estado, con quórum). */
  async call(req: CallRequest, block: bigint): Promise<Hex> {
    try {
      return await this.#agree<Hex>('eth_call', [callObject(req), toHexQuantity(block)], data);
    } catch (error) {
      if (error instanceof JsonRpcError) throw new CallRevertedError(error.message);
      throw error;
    }
  }

  /** Timestamp del bloque (segundos): referencia de tiempo de las reglas con semántica on-chain (deadline de swap). */
  async blockTimestamp(block: bigint): Promise<number> {
    const result = await this.#agree('eth_getBlockByNumber', [toHexQuantity(block), false], header);
    if (result === null) throw new RpcQuorumError('RPC_UNAVAILABLE', 'bloque inexistente');
    return Number(BigInt(result.timestamp));
  }

  async storageAt(address: Address, slot: Hex, block: bigint): Promise<Hex> {
    return this.#agree<Hex>('eth_getStorageAt', [address, slot, toHexQuantity(block)], data);
  }

  async balance(address: Address, block: bigint): Promise<bigint> {
    return BigInt(await this.#agree('eth_getBalance', [address, toHexQuantity(block)], quantity));
  }

  /** Nonce de cuenta (la tx de S que firma el signer debe usar el siguiente confirmado). */
  async transactionCount(address: Address, tag: 'latest' | 'pending'): Promise<bigint> {
    return BigInt(await this.#agree('eth_getTransactionCount', [address, tag], quantity));
  }

  /**
   * Simulación en `latest` en todos los proveedores: devuelve los datos de retorno; si alguno revierte → error.
   * (Los proveedores pueden diferir en el head: no se exige igualdad de bytes, sí que ninguno revierta.)
   */
  async simulate(req: CallRequest): Promise<Hex> {
    const results = await Promise.all(
      this.#urls.map(async (url) => {
        try {
          return await this.#one<Hex>(url, 'eth_call', [callObject(req), 'latest']);
        } catch (error) {
          if (error instanceof JsonRpcError && error.rpcCode !== undefined) throw new CallRevertedError(error.message);
          throw new RpcQuorumError('RPC_UNAVAILABLE', 'simulación sin respuesta');
        }
      }),
    );
    return results[0] as Hex;
  }

  async estimateGas(req: CallRequest): Promise<bigint> {
    const estimates = await Promise.all(
      this.#urls.map(async (url) => {
        try {
          return BigInt(await this.#one<string>(url, 'eth_estimateGas', [callObject(req), 'latest']));
        } catch (error) {
          if (error instanceof JsonRpcError && error.rpcCode !== undefined) throw new CallRevertedError(error.message);
          throw new RpcQuorumError('RPC_UNAVAILABLE', 'estimación sin respuesta');
        }
      }),
    );
    return estimates.reduce((a, b) => (a > b ? a : b));
  }
}
