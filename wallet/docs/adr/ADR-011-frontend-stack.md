# ADR-011 — Stack de los frontends

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-011), §1, §3.5 (WalletConnect / Reown), §3.6, §8 (introducción), §8.1 ([F-KEY-09]), §8.5 ([F-SEC-02], [F-SEC-05], [F-SEC-07], [F-SEC-09]), §8.6 ([F-CON-01] a [F-CON-04]); V9 §5, §17; prompt §4, §5, §9

## Contexto

El prompt §5 prefiere React + TypeScript para los frontends, viem como cliente de blockchain y, para conexiones de wallets, wagmi, WalletConnect, wallets inyectadas, MetaMask y Coinbase Wallet. El §9 pide que Recovery permita usar una wallet externa como R mediante esos conectores, y el §4, que Wallet y Recovery sean aplicaciones distintas que pueden compartir look & feel pero no código con acceso a U o R en runtime. V9 §5 admite reemplazar R por una wallet externa controlada por el usuario; V9 §17 exige que Recovery sea un frontend mínimo y que no haya JavaScript de terceros en los origins criptográficos.

La raíz del repositorio usa React + Vite en JavaScript (§1): se reutiliza la elección tecnológica, no el código. Hechos verificados (§3.5): wagmi 3.7.7, @wagmi/core 3.6.5 y @wagmi/connectors 8.2.0, con los SDKs de wallets como peers opcionales; Coinbase se puede restringir a EOA con `coinbaseWallet({ preference: { options: 'eoaOnly' } })`; el projectId de WalletConnect se gestiona en `https://dashboard.reown.com`, con allowlist de dominios por proyecto.

## Decisión

Frontends en **React 19 + TypeScript 6.0.3 + Vite 8 + React Router 8**, sin librerías de UI de terceros. Wallet **sin** wagmi ni conectores; Recovery con wagmi + conectores sólo en un chunk lazy.

Detalle:

- **Versiones verificadas** (§3.6, a fijar exactas en P01): React / React DOM 19.3.1; Vite 8.3.4 y @vitejs/plugin-react 6.1.2; React Router 8.4.0; viem 2.57.7 (codificación y lectura de cadena); @noble/curves, @noble/hashes y @scure/base 2.4.0; @serenity-kit/opaque 1.1.0 en Wallet (ADR-008).
- **UI propia:** CSS propio con `wallet/frontend/design-tokens/tokens.css`, copiado en build con verificación de hash (ADR-001).
- **Wallet:** no incluye wagmi ni conectores ([F-SEC-07]).
- **Recovery:** wagmi 3.7.7, @wagmi/core 3.6.5 y @wagmi/connectors 8.2.0 con @walletconnect/ethereum-provider 2.26.0, @coinbase/wallet-sdk 4.4.0, @metamask/connect-evm 2.1.1 y @tanstack/react-query 5.104.3 (peer obligatorio de wagmi), declarados en el proyecto pero importados sólo vía `import()` en `src/external-wallet/`; los flujos de R interna nunca importan ese chunk ([F-SEC-07]).
- **Conectores** ([F-CON-01]): `injected` (EIP-6963: MetaMask, Coinbase Wallet extension, Rabby, etc.), `metaMask`, `coinbaseWallet` con preferencia sólo EOA y `walletConnect` (`projectId`, `showQrModal: false` y QR propio en canvas a partir del evento `display_uri`).
- **Reglas de firma** ([F-CON-02], [F-CON-03]): cadena fija Base (8453; en local, el fork 8453 vía RPC propio), rechazo de cualquier firma si la wallet reporta otra cadena, y firmas sólo con `eth_signTypedData_v4` (EIP-712), nunca `eth_sign` ni `personal_sign` para SafeTx.
- **Compatibilidad CSP/Trusted Types** ([F-CON-04], [F-SEC-02]): se verifica por conector en P19; un conector incompatible se excluye y se documenta, sin relajar la política.

## Alternativas consideradas

- **Librerías de UI de terceros:** descartadas para minimizar la superficie de código en los origins criptográficos (§4, [F-SEC-05]).
- **wagmi y conectores también en Wallet:** descartado; Wallet no necesita wallets externas y así se minimiza la superficie en el origin de U (§4).
- **wagmi en el bundle principal de Recovery:** descartado; se carga sólo en el chunk lazy de "wallet externa", para que Recovery siga siendo mínimo (V9 §17).
- **TypeScript 7.0.2:** descartado por la restricción de typescript-eslint 8.71.2 (`<6.1.0`) (§3.6).

## Consecuencias

- El origin de U carga sólo el código propio de la app y sus dependencias criptográficas mínimas; el de R carga código de conectores sólo cuando el usuario elige una wallet externa.
- No se aceptan smart-contract wallets como R en V1: la R externa debe ser una EOA con proof-of-control EIP-712 ([F-KEY-09]).
- Usar WalletConnect implica requests al relay de Reown y agregar sus endpoints verificados al `connect-src` de Recovery; fuera de ese conector no hay requests a terceros (P19.SEC).
- Los componentes de UI son propios y la capa criptográfica se implementa por separado en cada app, con más código para mantener.
- Los upgrades de dependencias criptográficas comunes (`@noble/*`, `viem`, `@scure/*`) se publican en Wallet y Recovery con al menos 72 h de diferencia y aprobación de cada dominio ([F-SEC-09]).

## Verificación

- P16.T02 — scaffold de cada app con versiones exactas; test de dependencias (Wallet sin wagmi).
- P16.T03 — ESLint prohíbe `dangerouslySetInnerHTML`, `innerHTML`, `eval` y storages fuera de módulos allowlisteados.
- P16.T08 — test de grafo de bundle: los chunks de entrada y de R interna de Recovery no contienen wagmi ni conectores.
- P16.T10 — check de CI de dependencias comunes entre lockfiles.
- P16.TST — build sin scripts inline, SRI y CSP/TT sin violaciones.
- P19.T03 — enrollment con R interna o externa (`coinbaseWallet` con `eoaOnly`, `walletConnect` con `showQrModal: false`).
- P19.T07 — compatibilidad de cada conector con CSP y Trusted Types.
- P19.MAN — WalletConnect real a través del relay de Reown con una wallet headless.
- P19.SEC — grafo de bundle verde y ningún request a terceros salvo WalletConnect cuando se usa.
- Trazabilidad: RQ-19, RQ-21, RQ-32.
