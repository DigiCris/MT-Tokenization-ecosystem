// Envío (P18.T06): sólo a destinos activos on-chain de la whitelist, con el monto en unidades mínimas (bigint). La app
// arma la SafeTx `token.transfer(destino, monto)` con el token fijado y la compara con la que prepara el backend antes de
// que U firme (chain/safe-tx.ts → verifyPrepared): si los bytes difieren, la firma queda bloqueada.
import { encodeFunctionData, erc20Abi, type Address } from 'viem';
import { assistedCall, type SafeTx } from '../chain/safe-tx.ts';
import type { PinnedToken } from '../config/chain.ts';

export function transferCall(
  token: Pick<PinnedToken, 'address'>,
  destination: Address,
  amount: bigint,
  nonce: bigint,
): SafeTx {
  return assistedCall(
    token.address,
    encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [destination, amount] }),
    nonce,
  );
}
