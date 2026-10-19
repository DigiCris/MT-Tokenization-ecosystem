# Salida soberana de MT Wallet (U + R)

Herramienta offline para operar tu Safe con tu clave U y tu clave R **sin la plataforma** (P19.T09): es la única pieza
que junta U y R, y lo hace sólo en tu máquina, fuera de los origins de la plataforma. Es un único archivo HTML,
reproducible y firmado, que se abre desde el disco (`file://`) y habla únicamente con el RPC de Base que indiques.

## Qué hace

1. Lee tu Safe por el RPC que elijas (tiene que ser de Base, 8453): owners, nonce y saldos.
2. Abre U y R en memoria de la pestaña: desde el sobre cifrado (`U.enc` / `R.enc`) con su Password, o desde las 17
   palabras de cada una. Cada clave tiene que ser owner de la Safe.
3. Arma una SafeTx tipada con el nonce on-chain: transferir todo el USDC, USDT o ETH a una dirección, reemplazar una
   clave de la Safe (por ejemplo la de la plataforma, S), retirar el Guard o el guard de módulos, o anular el nonce
   actual (NoOp).
4. La firma con U y con R, combina las firmas ordenadas por firmante y te da la calldata de `execTransaction` (para
   cualquier relayer) o la transmite con la cuenta que elijas para pagar el gas (U, R u otra clave).

Las claves nunca se guardan: viven en la memoria de la pestaña y se borran al cerrarla (o con «Borrar las claves de
esta pestaña»).

## Verificar antes de abrir

Cada release trae `sovereign-exit.html`, `SHA256SUMS` y `SHA256SUMS.sig` (Ed25519, clave de release de la herramienta).
Antes de abrir el HTML, verificá la firma y el hash con la clave pública publicada:

```bash
pnpm verify -- --dist <carpeta del release> --public-key <sovereign-exit.pub>
```

o, sin este repositorio, con OpenSSL: `openssl pkeyutl -verify -pubin -inkey sovereign-exit.pub -rawin -in SHA256SUMS
-sigfile <(base64 -d SHA256SUMS.sig)` y `sha256sum -c SHA256SUMS`.

## Desarrollo

| Comando              | Qué hace                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`         | `dist/sovereign-exit.html`: JS y CSS inline, CSP en `<meta>` que sólo los habilita por SHA-256, sin recursos externos. Mismo commit → mismos bytes.                             |
| `pnpm build:release` | `build` + `SHA256SUMS` y su firma Ed25519 (se niega con cambios sin commitear).                                                                                                 |
| `pnpm verify`        | Verifica la firma y el hash del release.                                                                                                                                        |
| `pnpm test`          | Cripto (sobres, 17 palabras) y SafeTx contra los vectores de `contracts/`, dos builds idénticos y la firma del release.                                                         |
| `pnpm test:e2e`      | En el fork del stack local con la plataforma apagada: Safe de la factory con U y R de los vectores, transferencia soberana de punta a punta con el HTML abierto desde el disco. |

La criptografía es una implementación propia (como la de cada app), verificada contra los vectores compartidos:
Argon2id de `@noble/hashes` (sin WASM), HKDF y AES-256-GCM de WebCrypto, firmas de viem.
