// Send (P14.T03): POST /wallets/{id}/send/prepare reconstruye la SafeTx `token.transfer(destino, monto)` de USDC o
// USDT desde los datos del pedido (nunca desde bytes del cliente) y la prepara con el pipeline de P13: policy del
// backend con los hechos on-chain leídos con quórum (destino activo en DestinationWhitelist, saldo de la Safe, límites
// por operación y ledger de 24 h, nonce). Con monto ≥ umbral la operación queda `requiresTwoFactor` y la firma de U
// se acepta recién con el 2FA completo (POST /operations/{id}/two-factor, challenge ligado a SafeTxHash, token, monto,
// destino y nonce). El signer y el Guard vuelven a exigir todo por su cuenta.
import type { Kysely } from 'kysely';
import { encodeFunctionData, type Abi } from 'viem';
import { ApiError } from '../api/errors.ts';
import type { Database } from '../db/schema.ts';
import type { PreparedOperation } from '../operations/intent.ts';
import { roleForScope, type OperationActor, type OperationService } from '../operations/service.ts';
import { walletForActor } from '../operations/wallet-access.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';
import { validateDestination } from '../whitelist/validation.ts';

export const erc20TransferAbi = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const satisfies Abi;

export interface SendDeps {
  db: Kysely<Database>;
  operations: OperationService;
  snapshot: () => BackendPolicySnapshot;
}

export class SendService {
  readonly #d: SendDeps;

  constructor(deps: SendDeps) {
    this.#d = deps;
  }

  async prepare(
    actor: OperationActor,
    walletId: string,
    input: { token: 'USDC' | 'USDT'; destination: string; amount: bigint },
  ): Promise<PreparedOperation> {
    if (roleForScope(actor.session.claims.scope) !== 'U') throw new ApiError('SCOPE_NOT_ALLOWED');
    const wallet = await walletForActor(this.#d.db, actor, walletId);
    const snapshot = this.#d.snapshot();
    const check = validateDestination(input.destination, { safe: wallet.safe, snapshot });
    if (!check.ok) throw new ApiError('DESTINATION_INVALID', { detail: check.problem });
    return this.#d.operations.prepare(actor, {
      walletId: wallet.id,
      operationType: 'SEND',
      call: {
        to: snapshot.tokens[input.token],
        data: encodeFunctionData({
          abi: erc20TransferAbi,
          functionName: 'transfer',
          args: [check.destination, input.amount],
        }),
      },
    });
  }
}
