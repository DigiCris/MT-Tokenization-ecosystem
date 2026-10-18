// Saldos de la Safe (P14.T06, [B-API] balances): USDC y USDT con la allowance de cada uno hacia el SwapExecutor (para
// mostrar una allowance residual), leídos con quórum en un mismo bloque. El frontend además los lee por su propio RPC.
import type { Kysely } from 'kysely';
import type { Abi, Address } from 'viem';
import { ApiError } from '../api/errors.ts';
import type { RpcQuorumClient } from '../chain/rpc-quorum.ts';
import type { Database } from '../db/schema.ts';
import { walletOfUser } from '../operations/wallet-access.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';

const erc20ReadAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const satisfies Abi;

export interface TokenBalanceView {
  symbol: 'USDC' | 'USDT';
  address: Address;
  decimals: 6;
  balance: string;
  allowanceToSwapExecutor: string;
}

export interface BalancesView {
  walletId: string;
  safe: Address;
  chainId: number;
  blockNumber: string;
  tokens: TokenBalanceView[];
}

export class BalanceService {
  readonly #db: Kysely<Database>;
  readonly #rpc: RpcQuorumClient;
  readonly #snapshot: () => BackendPolicySnapshot;

  constructor(deps: { db: Kysely<Database>; rpc: RpcQuorumClient; snapshot: () => BackendPolicySnapshot }) {
    this.#db = deps.db;
    this.#rpc = deps.rpc;
    this.#snapshot = deps.snapshot;
  }

  async balances(userId: string, walletId: string): Promise<BalancesView> {
    const wallet = await walletOfUser(this.#db, userId, walletId);
    if (wallet.safe === null) throw new ApiError('WALLET_NOT_ACTIVE', { detail: 'la Safe todavía no está desplegada' });
    const safe = wallet.safe;
    const snapshot = this.#snapshot();
    const symbols = ['USDC', 'USDT'] as const;
    const { value, blockNumber } = await this.#rpc.readSensitive('balances', (client, block) =>
      Promise.all(
        symbols.map(async (symbol) => {
          const token = snapshot.tokens[symbol];
          const [balance, allowance] = await Promise.all([
            client.readContract({
              address: token,
              abi: erc20ReadAbi,
              functionName: 'balanceOf',
              args: [safe],
              blockNumber: block,
            }),
            client.readContract({
              address: token,
              abi: erc20ReadAbi,
              functionName: 'allowance',
              args: [safe, snapshot.contracts.swapExecutor],
              blockNumber: block,
            }),
          ]);
          return { symbol, balance: balance.toString(), allowance: allowance.toString() };
        }),
      ),
    );
    return {
      walletId: wallet.id,
      safe,
      chainId: wallet.chainId,
      blockNumber: blockNumber.toString(),
      tokens: value.map((t) => ({
        symbol: t.symbol,
        address: snapshot.tokens[t.symbol],
        decimals: 6,
        balance: t.balance,
        allowanceToSwapExecutor: t.allowance,
      })),
    };
  }
}
