# Conectores de wallet externa de Recovery (P19.T07)

Recovery permite usar como clave R una wallet externa del usuario (una cuenta EOA en Base, [F-KEY-09]). Los conectores
viven sólo en el chunk lazy `src/external-wallet/` ([F-SEC-07]) y tienen que funcionar bajo la CSP estricta de Recovery
(`script-src 'self'`, Trusted Types exigidos, `frame-src 'none'`, COOP `same-origin` y COEP `require-corp`, ver
`frontend/recovery/build/headers.json`). Cada conector ofrecido tiene un test E2E en el navegador real contra el stack
local y el fork (`pnpm --dir frontend/recovery test:browser -- connectors` y `-- walletconnect.live`): conecta en Base,
firma con `eth_signTypedData_v4` (nunca `eth_sign` ni `personal_sign`) y no genera violaciones de CSP ni de Trusted
Types ni requests a terceros fuera de los permitidos.

## Ofrecidos

| Conector | Cuándo aparece | Cómo se probó |
| --- | --- | --- |
| EIP-6963 (`multiInjectedProviderDiscovery`) | Una extensión que se anuncia por EIP-6963 (MetaMask, Rabby, etc.): un conector por extensión, con su `rdns` como id | Provider EIP-6963 de prueba presentándose como extensión genérica y como MetaMask (`io.metamask`) |
| `injected` | Siempre (usa `window.ethereum`) | Provider de prueba como `window.ethereum` |
| `coinbaseWallet` (sólo EOA) | Sólo con la extensión de Coinbase Wallet instalada (`window.coinbaseWalletExtension`); wagmi une con este conector el anuncio EIP-6963 de la extensión (mismo `rdns`, `com.coinbase.wallet`) | Provider de prueba como extensión de Coinbase Wallet (anunciada por EIP-6963 y como `window.coinbaseWalletExtension`) |
| `walletConnect` (sin modal, QR propio) | Con `WALLETCONNECT_PROJECT_ID` configurado | Emparejamiento real por el relay de Reown y una wallet headless (`@reown/walletkit`) que firma la prueba de control y una cancelación de rotación en el fork |

## Excluidos o limitados

- **`metaMask` (MetaMask Connect, `@metamask/connect-evm`)**: excluido. Se comunica con la extensión por un transporte
  propio (Multichain API sobre `chrome.runtime`/`postMessage`, no por el provider EIP-1193), arma sus lecturas contra el
  RPC público de la cadena (`mainnet.base.org`) y envía analítica a MetaMask: terceros que la CSP de Recovery no permite,
  y un camino que no se puede verificar en E2E con un provider de prueba. MetaMask sigue soportada: la extensión de
  escritorio por EIP-6963 y MetaMask Mobile por WalletConnect.
- **Coinbase Wallet sin extensión**: el SDK abre un popup de `keys.coinbase.com` y espera su respuesta por `postMessage`;
  la política COOP `same-origin` de Recovery corta esa relación y el flujo quedaría colgado. Sin la extensión el conector
  no se ofrece; la app móvil de Coinbase Wallet se conecta por WalletConnect.
- **WalletConnect Verify API**: el SDK embebe un iframe oculto de `verify.walletconnect.org` para atestar el dominio de
  la app ante la wallet. `frame-src 'none'` y COEP `require-corp` no lo permiten, así que el registro se desactiva en el
  conector (no espera su timeout ni genera violaciones). La wallet ve la sesión sin atestación de dominio; por eso
  Recovery muestra siempre la dirección completa de R para compararla.
- **Telemetría de WalletConnect** (`pulse.walletconnect.org`): apagada en el conector (`telemetryEnabled: false`).

## Hosts de WalletConnect en `connect-src`

Verificados en la documentación oficial de Reown
([Content Security Policy](https://docs.reown.com/advanced/security/content-security-policy)) y en el código de
`@walletconnect/core` 2.26.0 que usa la app: sin AppKit (QR propio, sin modal) Recovery sólo necesita el relay,
`wss://relay.walletconnect.org` y `wss://relay.walletconnect.com`. No se agregan `api.web3modal`, `keys`, `notify`,
`echo` ni `push` (funciones de AppKit o de wallets), `rpc.walletconnect` (las lecturas usan el RPC propio de Recovery por
`rpcMap`) ni `pulse` (telemetría apagada).

## Registro

Las corridas de estos tests (fecha, commit y resultado) quedan en §13 del planner.
