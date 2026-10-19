// Tipos de la wallet externa que usan las pantallas sin cargar el chunk de wagmi ([F-SEC-07]): el chunk
// (src/external-wallet/index.ts) los implementa y sólo se carga con loadExternalWallet().
import type { Address, Hex, TypedDataDefinition } from 'viem';

export interface ConnectorChoice {
  id: string;
  name: string;
}

/** R externa conectada: firma typed data (`eth_signTypedData_v4`) y transmite transacciones, siempre en Base. */
export interface ExternalSession {
  connectorId: string;
  connectorName: string;
  address: Address;
  signTypedData: (definition: TypedDataDefinition) => Promise<Hex>;
  sendTransaction: (tx: { to: Address; data: Hex; gas?: bigint }) => Promise<Hex>;
  disconnect: () => Promise<void>;
}
