// Dirección completa en EIP-55 y en grupos de 4 caracteres (como la muestra la Wallet para compararla a mano,
// [F-LNK-02]), con botón opcional para copiarla.
import { useState } from 'react';
import { getAddress, type Address } from 'viem';

/** Los 10 grupos de 4 caracteres de la dirección (sin 0x), los mismos que pide la Wallet al confirmar R a mano. */
export function addressGroups(address: Address): string[] {
  return getAddress(address).slice(2).match(/.{4}/g) ?? [];
}

export function groupedAddress(address: Address): string {
  return `0x ${addressGroups(address).join(' ')}`;
}

export function AddressText({ address, copy = false }: { address: Address; copy?: boolean }) {
  const [copied, setCopied] = useState(false);
  const checksummed = getAddress(address);
  return (
    <span className="address">
      <code className="address__text" data-address={checksummed} title={checksummed}>
        {groupedAddress(checksummed)}
      </code>
      {copy && (
        <button
          type="button"
          className="button button--link"
          onClick={() => {
            void navigator.clipboard.writeText(checksummed).then(() => {
              setCopied(true);
            });
          }}
        >
          {copied ? 'Copiada' : 'Copiar'}
        </button>
      )}
    </span>
  );
}
