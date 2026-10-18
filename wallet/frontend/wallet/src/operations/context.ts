// Contexto para decodificar las SafeTx de la Safe operativa (direcciones fijadas en el build y la propia Safe) y el
// nonce on-chain leído por el RPC propio (la cola del backend puede ir unos pocos por delante).
import type { Address } from 'viem';
import { iSafeAbi } from '../chain/abis/ISafe.ts';
import type { BaseClient } from '../chain/client.ts';
import type { DecodeContext } from '../chain/decoders.ts';
import { pinnedChain } from '../config/chain.ts';
import { systemContracts } from '../config/index.ts';

export function decodeContext(safe: Address): DecodeContext {
  return { safe, chain: pinnedChain, system: systemContracts };
}

export function onchainNonce(reader: Pick<BaseClient, 'readContract'>, safe: Address): Promise<bigint> {
  return reader.readContract({ address: safe, abi: iSafeAbi, functionName: 'nonce' });
}
