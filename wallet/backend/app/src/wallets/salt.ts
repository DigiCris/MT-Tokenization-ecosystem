// saltNonce de una wallet (P12.T04): `uint256(keccak256(abi.encode("MTW_SALT_V1", platformId, walletId)))`. Depende
// sólo de la plataforma y del id de la wallet, así que el frontend lo recalcula y verifica la Safe esperada sin
// confiar en el backend. Vector: contracts/test/vectors/create2.json → saltNonces (generado en Solidity).
import { encodeAbiParameters, hexToBigInt, keccak256 } from 'viem';

export const SALT_DOMAIN = 'MTW_SALT_V1';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function walletSaltNonce(platformId: string, walletId: string): bigint {
  // El id va en su forma canónica (minúsculas, como lo devuelve PostgreSQL).
  const id = walletId.toLowerCase();
  if (!UUID.test(id)) throw new TypeError('walletId debe ser un UUID');
  return hexToBigInt(
    keccak256(
      encodeAbiParameters([{ type: 'string' }, { type: 'string' }, { type: 'string' }], [SALT_DOMAIN, platformId, id]),
    ),
  );
}
