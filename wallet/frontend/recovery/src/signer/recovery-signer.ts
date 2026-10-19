// Firmante R de las pantallas de Recovery: R interna (sobre + K_R no exportable, R se descifra sólo para firmar) o R
// externa (la wallet conectada). Todo lo que firma R es typed data EIP-712 —la SafeTx, la cancelación de una rotación,
// la prueba de control—: la interna firma el digest que calcula la app; la externa recibe el typed data completo por
// `eth_signTypedData_v4` ([F-CON-03], nunca `eth_sign`/`personal_sign`).
import type { Address, Hex, TypedDataDefinition } from 'viem';
import { safeTxTypedData, type SafeTx } from '../chain/safe-tx.ts';
import { signTypedDataWithRecovery, type UnlockedRecovery } from '../crypto/session.ts';
import type { ExternalSession } from '../external-wallet/types.ts';

export interface RecoverySigner {
  kind: 'internal' | 'external';
  address: Address;
  /** La wallet del sobre (R interna); null con una wallet externa. */
  walletId: string | null;
  signTypedData: (definition: TypedDataDefinition) => Promise<Hex>;
  /** Sólo con una wallet externa: transmitir una transacción pagando su gas (modo soberano, cancelWithSignature). */
  sendTransaction: ((tx: { to: Address; data: Hex; gas?: bigint }) => Promise<Hex>) | null;
}

export function internalSigner(unlocked: UnlockedRecovery): RecoverySigner {
  return {
    kind: 'internal',
    address: unlocked.address,
    walletId: unlocked.envelope.walletId,
    signTypedData: (definition) => signTypedDataWithRecovery(unlocked, definition),
    sendTransaction: null,
  };
}

export function externalSigner(session: ExternalSession): RecoverySigner {
  return {
    kind: 'external',
    address: session.address,
    walletId: null,
    signTypedData: (definition) => session.signTypedData(definition),
    sendTransaction: (tx) => session.sendTransaction(tx),
  };
}

/** Firma de R sobre una SafeTx (el hash lo calcula la app con la Safe y la cadena). */
export function signSafeTx(signer: RecoverySigner, chainId: number, safe: Address, tx: SafeTx): Promise<Hex> {
  const definition = safeTxTypedData(chainId, safe, tx);
  return signer.signTypedData({ ...definition, message: { ...definition.message } });
}
