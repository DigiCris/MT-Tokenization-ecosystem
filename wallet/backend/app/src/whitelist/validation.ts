// Validación de destinos de whitelist (P14.T02, prompt §10): dirección EVM con checksum EIP-55 válido (o toda en
// minúsculas, sin checksum que verificar), distinta de la dirección cero, de la propia Safe, de los contratos del
// sistema y de Safe y de los tokens soportados. Las mismas reglas que aplican la policy del backend, la del signer y el
// Guard on-chain ([C-GRD-08]): acá se rechaza antes de crear el challenge, con un motivo legible para el usuario.
import { getAddress, isAddress, isAddressEqual, type Address } from 'viem';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';

export type DestinationProblem =
  'INVALID_FORMAT' | 'BAD_CHECKSUM' | 'ZERO_ADDRESS' | 'OWN_SAFE' | 'SYSTEM_CONTRACT' | 'TOKEN_CONTRACT';

export type DestinationCheck = { ok: true; destination: Address } | { ok: false; problem: DestinationProblem };

const ZERO: Address = '0x0000000000000000000000000000000000000000';

export function validateDestination(
  input: string,
  context: { safe: Address; snapshot: BackendPolicySnapshot },
): DestinationCheck {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input)) return { ok: false, problem: 'INVALID_FORMAT' };
  // Con mayúsculas tiene que ser exactamente el checksum EIP-55 (una letra mal escrita cambia el checksum).
  if (!isAddress(input, { strict: true })) return { ok: false, problem: 'BAD_CHECKSUM' };
  const destination = getAddress(input);
  if (isAddressEqual(destination, ZERO)) return { ok: false, problem: 'ZERO_ADDRESS' };
  if (isAddressEqual(destination, context.safe)) return { ok: false, problem: 'OWN_SAFE' };
  const { contracts, tokens } = context.snapshot;
  if ([tokens.USDC, tokens.USDT].some((t) => isAddressEqual(t, destination))) {
    return { ok: false, problem: 'TOKEN_CONTRACT' };
  }
  if (Object.values(contracts).some((c) => isAddressEqual(c, destination))) {
    return { ok: false, problem: 'SYSTEM_CONTRACT' };
  }
  return { ok: true, destination };
}
