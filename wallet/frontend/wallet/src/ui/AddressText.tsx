// Dirección completa en EIP-55, en grupos de 4 caracteres (como en los emails y en la app Recovery), con botón para
// copiarla.
import { useState } from 'react';
import { getAddress, type Address } from 'viem';

export function groupAddress(address: Address): string {
  const checksummed = getAddress(address);
  return `0x ${(checksummed.slice(2).match(/.{4}/g) ?? []).join(' ')}`;
}

export function AddressText({ address, copy = false }: { address: Address; copy?: boolean }) {
  const [copied, setCopied] = useState(false);
  const checksummed = getAddress(address);
  return (
    <span className="address">
      <code className="address__text" data-address={checksummed} title={checksummed}>
        {groupAddress(checksummed)}
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
