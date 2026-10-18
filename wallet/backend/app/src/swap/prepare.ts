// Swaps USDC↔USDT (P14.T05): el backend cotiza (QuoterV2) y prepara el par de SafeTx del grupo — nonce N:
// `token.approve(SwapExecutor, amountIn)` exacto; nonce N+1: `SwapExecutor.swap(tokenIn, amountIn, minOut, deadline)` —
// que U firma junto; el worker los ejecuta en orden (el signer exige el SWAP firmado junto con su approve, [B-SIG-02])
// y el resultado siempre vuelve a la Safe (allowance final 0).
//
// Si el swap falla en forma definitiva con el approve ya ejecutado (allowance residual), el grupo queda FAILED y se
// ofrece: volver a cotizar (par nuevo approve + swap en los nonces siguientes: el signer sólo co-firma un SWAP emparejado
// con el approve que co-firmó en el mismo pedido, así que un approve ya ejecutado no se re-empareja) o revocar la
// allowance (`approve(SwapExecutor, 0)`). La limpieza de allowances residuales la hace el coordinador del worker.
import type { Kysely, Selectable } from 'kysely';
import { encodeFunctionData, getAddress, type Abi, type Address } from 'viem';
import { ApiError } from '../api/errors.ts';
import { swapExecutorV3Abi } from '../chain/abis/index.ts';
import type { Database, OperationGroupsTable, SwapQuoteJson } from '../db/schema.ts';
import { bufferToAddress } from '../lib/bytes.ts';
import type { OperationView, PreparedOperation } from '../operations/intent.ts';
import type { OperationActor, OperationService } from '../operations/service.ts';
import { isUuid, walletForActor, walletOfUser } from '../operations/wallet-access.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';
import { quoteJson, type QuoteService, type SwapQuote, type SwapToken } from './quote.ts';

type GroupRow = Selectable<OperationGroupsTable>;

export const erc20ApproveAbi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const satisfies Abi;

export type GroupNextAction = 'REQUOTE' | 'REVOKE_APPROVAL';

export interface SwapQuoteView {
  tokenIn: SwapToken;
  tokenOut: SwapToken;
  amountIn: string;
  expectedOut: string;
  minOut: string;
  slippageBps: number;
  priceImpactBps: number;
  deadline: string;
  blockNumber: string;
  quotedAt: string;
  pool: Address;
  fee: number;
}

export interface OperationGroupView {
  id: string;
  walletId: string;
  type: 'SWAP';
  status: GroupRow['status'];
  tokenIn: SwapToken;
  tokenOut: SwapToken;
  amountIn: string;
  quote: SwapQuoteJson;
  failureReason: string | null;
  completedAt: string | null;
  createdAt: string;
  nextActions: GroupNextAction[];
  operations: OperationView[];
}

export interface PreparedSwap {
  group: OperationGroupView;
  quote: SwapQuoteView;
  operations: PreparedOperation[];
}

export interface SwapDeps {
  db: Kysely<Database>;
  operations: OperationService;
  quotes: QuoteService;
  snapshot: () => BackendPolicySnapshot;
}

export function quoteView(q: SwapQuote): SwapQuoteView {
  return {
    tokenIn: q.tokenIn,
    tokenOut: q.tokenOut,
    amountIn: q.amountIn.toString(),
    expectedOut: q.expectedOut.toString(),
    minOut: q.minOut.toString(),
    slippageBps: q.slippageBps,
    priceImpactBps: q.priceImpactBps,
    deadline: q.deadline.toString(),
    blockNumber: q.blockNumber.toString(),
    quotedAt: q.quotedAt.toISOString(),
    pool: q.pool,
    fee: q.fee,
  };
}

export class SwapService {
  readonly #d: SwapDeps;

  constructor(deps: SwapDeps) {
    this.#d = deps;
  }

  #symbol(address: Address): SwapToken {
    const { tokens } = this.#d.snapshot();
    if (getAddress(address) === tokens.USDC) return 'USDC';
    if (getAddress(address) === tokens.USDT) return 'USDT';
    throw new Error(`token ${address} fuera del par del swap`);
  }

  /** GET /wallets/{id}/swap/quote (sesión de cuenta): la wallet tiene que ser del usuario y estar ACTIVE. */
  async quote(
    userId: string,
    walletId: string,
    input: { tokenIn: SwapToken; amountIn: bigint; slippageBps?: number | undefined },
  ): Promise<SwapQuoteView> {
    const wallet = await walletOfUser(this.#d.db, userId, walletId);
    if (wallet.status !== 'ACTIVE' || wallet.safe === null) throw new ApiError('WALLET_NOT_ACTIVE');
    return quoteView(await this.#d.quotes.quote(input));
  }

  #calls(q: SwapQuote) {
    const executor = this.#d.snapshot().contracts.swapExecutor;
    return {
      approve: {
        to: q.tokenInAddress,
        data: encodeFunctionData({ abi: erc20ApproveAbi, functionName: 'approve', args: [executor, q.amountIn] }),
      },
      swap: {
        to: executor,
        data: encodeFunctionData({
          abi: swapExecutorV3Abi,
          functionName: 'swap',
          args: [q.tokenInAddress, q.amountIn, q.minOut, q.deadline],
        }),
      },
    };
  }

  /** POST /wallets/{id}/swap/prepare: cotización + par approve/swap en un grupo nuevo. */
  async prepare(
    actor: OperationActor,
    walletId: string,
    input: { tokenIn: SwapToken; amountIn: bigint; slippageBps?: number | undefined },
  ): Promise<PreparedSwap> {
    const wallet = await walletForActor(this.#d.db, actor, walletId);
    const quote = await this.#d.quotes.quote(input);
    const calls = this.#calls(quote);
    const prepared = await this.#d.operations.prepareSwapGroup(actor, {
      walletId: wallet.id,
      groupId: null,
      tokenIn: quote.tokenInAddress,
      tokenOut: quote.tokenOutAddress,
      amountIn: quote.amountIn,
      quote: quoteJson(quote),
      ...calls,
    });
    return {
      group: await this.group(actor.userId, prepared.groupId),
      quote: quoteView(quote),
      operations: [prepared.approve, prepared.swap],
    };
  }

  async #groupFor(userId: string, groupId: string): Promise<GroupRow> {
    if (!isUuid(groupId)) throw new ApiError('NOT_FOUND');
    const group = await this.#d.db
      .selectFrom('operation_groups')
      .selectAll()
      .where('id', '=', groupId)
      .executeTakeFirst();
    if (group?.user_id !== userId) throw new ApiError('NOT_FOUND');
    return group;
  }

  /** POST /operation-groups/{id}/requote: grupo FAILED → cotización nueva y par nuevo (mismo token y monto). */
  async requote(
    actor: OperationActor,
    groupId: string,
    input: { slippageBps?: number | undefined },
  ): Promise<PreparedSwap> {
    const group = await this.#groupFor(actor.userId, groupId);
    if (group.status !== 'FAILED') {
      throw new ApiError('CONFLICT', { detail: `el swap está en ${group.status}: no admite una nueva cotización` });
    }
    const wallet = await walletForActor(this.#d.db, actor, group.wallet_id);
    const quote = await this.#d.quotes.quote({
      tokenIn: this.#symbol(bufferToAddress(group.token_in)),
      amountIn: BigInt(group.amount_in),
      slippageBps: input.slippageBps,
    });
    const prepared = await this.#d.operations.prepareSwapGroup(actor, {
      walletId: wallet.id,
      groupId: group.id,
      tokenIn: quote.tokenInAddress,
      tokenOut: quote.tokenOutAddress,
      amountIn: quote.amountIn,
      quote: quoteJson(quote),
      ...this.#calls(quote),
    });
    return {
      group: await this.group(actor.userId, group.id),
      quote: quoteView(quote),
      operations: [prepared.approve, prepared.swap],
    };
  }

  /** POST /operation-groups/{id}/revoke-approval: `approve(SwapExecutor, 0)` del token de entrada (APPROVE_REVOKE). */
  async revokeApproval(actor: OperationActor, groupId: string): Promise<PreparedOperation> {
    const group = await this.#groupFor(actor.userId, groupId);
    if (group.status !== 'FAILED') {
      throw new ApiError('CONFLICT', { detail: `el swap está en ${group.status}: no hay allowance para revocar` });
    }
    const wallet = await walletForActor(this.#d.db, actor, group.wallet_id);
    return this.#d.operations.prepare(actor, {
      walletId: wallet.id,
      operationType: 'APPROVE_REVOKE',
      groupId: group.id,
      call: revokeCall(this.#d.snapshot(), bufferToAddress(group.token_in)),
    });
  }

  /**
   * `approve(SwapExecutor, 0)` de un token fuera de un grupo: el botón de pánico de Recovery (R + S, grupo de
   * emergencia) o cualquier limpieza de allowance que pida el usuario.
   */
  async revokeToken(actor: OperationActor, walletId: string, token: SwapToken): Promise<PreparedOperation> {
    const wallet = await walletForActor(this.#d.db, actor, walletId);
    const snapshot = this.#d.snapshot();
    return this.#d.operations.prepare(actor, {
      walletId: wallet.id,
      operationType: 'APPROVE_REVOKE',
      call: revokeCall(snapshot, snapshot.tokens[token]),
    });
  }

  /** GET /operation-groups/{id}: estado, cotización vigente, operaciones y acciones ofrecidas. */
  async group(userId: string, groupId: string): Promise<OperationGroupView> {
    const group = await this.#groupFor(userId, groupId);
    const operations = await this.#d.operations.listByGroup(userId, group.id);
    return {
      id: group.id,
      walletId: group.wallet_id,
      type: group.type,
      status: group.status,
      tokenIn: this.#symbol(bufferToAddress(group.token_in)),
      tokenOut: this.#symbol(bufferToAddress(group.token_out)),
      amountIn: group.amount_in,
      quote: group.quote,
      failureReason: group.failure_reason,
      completedAt: group.completed_at?.toISOString() ?? null,
      createdAt: group.created_at.toISOString(),
      nextActions: group.status === 'FAILED' ? ['REQUOTE', 'REVOKE_APPROVAL'] : [],
      operations,
    };
  }
}

/** `approve(SwapExecutor, 0)`: la única forma de APPROVE_REVOKE que acepta la policy. */
export function revokeCall(snapshot: BackendPolicySnapshot, token: Address) {
  return {
    to: token,
    data: encodeFunctionData({
      abi: erc20ApproveAbi,
      functionName: 'approve',
      args: [snapshot.contracts.swapExecutor, 0n],
    }),
  };
}
