# Contratos externos verificados

Fuente de verdad: `config/chains/base-mainnet.json` (P03.T01). Cada dirección se verificó el **2026-10-17** contra su fuente oficial (P03.MAN) y por codehash en el bloque de fork **52700000** (hash `0x64a292b057c55f118eb550d89bd860a5740598962f50536c719b375f1ca9c473`). Se re-verifica en cada `pnpm preflight` (PF-15 → `scripts/verify-external`), en cada corrida de `test/fork/ExternalContracts.t.sol` y, en producción, con `bash scripts/verify-external --block latest`. `node scripts/check-external-docs.mjs` exige que esta tabla coincida con el JSON.

## Tabla

| Contrato | Clave en el JSON | Dirección | Codehash (52700000) | Uso en V1 | Fuente oficial |
|---|---|---|---|---|---|
| Safe (singleton L1) v1.5.0 | `safeSingleton` | `0xFf51A5898e281Db6DfC7855790607438dF2ca44b` | `0xdda019cbd7c867a533a2a86e5c53434fdc50b13122b5a5ddb4a8df61b31c20f2` | referencia (no se usa) | https://github.com/safe-global/safe-deployments/tree/main/src/assets/v1.5.0 |
| SafeL2 v1.5.0 (singleton usado) | `safeL2Singleton` | `0xEdd160fEBBD92E350D4D398fb636302fccd67C7e` | `0x180193227186ccb85316c94db1f0d156ed932b14712cfaac78901899178572dc` | singleton de toda Safe del sistema | https://github.com/safe-global/safe-deployments/tree/main/src/assets/v1.5.0 |
| SafeProxyFactory v1.5.0 | `safeProxyFactory` | `0x14F2982D601c9458F93bd70B218933A6f8165e7b` | `0x967dae4cda22b0c9ef7f31b010bdc1ceb0af9904b0c3dc060b5302e4c18a4529` | deploy + init atómicos de cada Safe (`createProxyWithNonceL2`) | https://github.com/safe-global/safe-deployments/tree/main/src/assets/v1.5.0 |
| MultiSendCallOnly v1.5.0 | `multiSendCallOnly` | `0xA83c336B20401Af773B6219BA5027174338D1836` | `0xcdbdcec38d2f1c7d961b0029ff8416b7e86e9974d6f0e9c9580c7d17fcfb6663` | referencia (el camino asistido no usa MultiSend) | https://github.com/safe-global/safe-deployments/tree/main/src/assets/v1.5.0 |
| CompatibilityFallbackHandler v1.5.0 | `compatibilityFallbackHandler` | `0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4` | `0x3c6a85bcf7b563daa624b884b4e9a1b9fa5371edde7be945d998071a48f28bbc` | no se instala (fallback = 0) | https://github.com/safe-global/safe-deployments/tree/main/src/assets/v1.5.0 |
| USDC (Circle) | `usdc` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `0xa6705a10bb756b5dea144591118be77d7af0c3eee3bf2dfe2583dcb0364fefab` | token soportado (6 decimales) | https://developers.circle.com/stablecoins/usdc-contract-addresses |
| USDT (bridged canónico) | `usdt` | `0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2` | `0x478746a8e4b17181c4efbeb2069d86f22ec395788099ed65c9442ca44df265bc` | token soportado (6 decimales) | https://ethereum-optimism.github.io/data/USDT/data.json |
| UniswapV3Factory | `uniswapV3Factory` | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` | `0x95707a4ac71f20181a63ef7d180e3c625be5d20fc8f6f980befa966bad568132` | verificación del pool | https://github.com/Uniswap/sdks/blob/81db6f17e5d9b94ce86f9629a7f3085192670035/sdks/sdk-core/src/addresses.ts |
| UniswapV3Pool USDC/USDT 0,01 % | `uniswapV3PoolUsdcUsdt100` | `0xD56da2B74bA826f19015E6B7Dd9Dae1903E85DA1` | `0x7c1e281e8700a5038559b9380296ee9c4591b706789a1aa5a7a270ca837ef80d` | pool canónico del `SwapExecutorV3` | https://developers.uniswap.org/docs/protocols/v3/deployments/base-deployments |
| QuoterV2 | `uniswapQuoterV2` | `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` | `0xceb5b8bc35e09fc64b1c48c6b920e0d2e37d5710e4f3ef214e1a81f75acee51e` | cotización por `eth_call` | https://github.com/Uniswap/sdks/blob/81db6f17e5d9b94ce86f9629a7f3085192670035/sdks/sdk-core/src/addresses.ts |
| SwapRouter02 | `uniswapSwapRouter02` | `0x2626664c2603336E57B271c5C0b26F421741e481` | `0x38bd640f47df62b2fd5a6755a63f4976ad847dc9b946ae0d145d21d16bb124e4` | no se usa | https://github.com/Uniswap/sdks/blob/81db6f17e5d9b94ce86f9629a7f3085192670035/sdks/sdk-core/src/addresses.ts |
| UniversalRouter 2.1.2 | `uniswapUniversalRouter` | `0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40` | `0x816c75fe7f6ccf8fe8b14825091e8dff301fe7ffd4b962f89b2981a747facc08` | no se usa | https://github.com/Uniswap/sdks/blob/81db6f17e5d9b94ce86f9629a7f3085192670035/sdks/universal-router-sdk/src/utils/constants.ts |
| Permit2 | `permit2` | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | `0xa67739abc3ede9dbdc0491636c67d6a14ac07fab9030c3f509b1eb7b11dff8ed` | no se usa; el Guard deniega toda llamada | https://github.com/Uniswap/sdks/blob/81db6f17e5d9b94ce86f9629a7f3085192670035/sdks/permit2-sdk/src/constants.ts |
| Uniswap v4 PoolManager | `uniswapV4PoolManager` | `0x498581fF718922c3f8e6A244956aF099B2652b2b` | `0x83b2af6e9f3158defc2811cbcb0db71ecf8b2ba2abea39c39e370ac5c6f43eb6` | candidato a `SwapExecutorV4` futuro | https://developers.uniswap.org/docs/protocols/v4/deployments |
| Uniswap v4 Quoter | `uniswapV4Quoter` | `0x0d5e0F971ED27FBfF6c2837bf31316121532048D` | `0x9a5c0cdd56325bef0e48cdab071a4b6a7f877e1271c2e08510998d724a038bb3` | monitoreo comparativo | https://developers.uniswap.org/docs/protocols/v4/deployments |
| Uniswap v4 StateView | `uniswapV4StateView` | `0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71` | `0xbbd5859677ef5491143133e8ed2b8faa0272f6fc2cbae94c53e79cc8c0538545` | monitoreo comparativo | https://developers.uniswap.org/docs/protocols/v4/deployments |

Implementación de USDC detrás del proxy (slot ZeppelinOS `org.zeppelinos.proxy.implementation`, `0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3`): `FiatTokenV2_2` en `0x2Ce6311ddAE708829bc0784C967b7d77D19FD779`, codehash `0x11b75a237997ab8328f65b2d5a55c10f0346d0a175741ed42ddf4f2c66b9e873`.

## Supuestos de confianza

### USDC (Circle)

- **Emisor:** Circle; USDC nativo en Base (no USDbC, que es bridged y no se usa).
- **Upgradeability:** `FiatTokenProxy` con admin de Circle; la implementación puede cambiar.
- **Pausa y blacklist:** Circle puede pausar el token o bloquear una dirección, incluida una Safe del sistema.
- **Consecuencia:** fondos en USDC de una Safe pueden quedar congelados por decisión de Circle; el sistema no puede evitarlo (THREAT_MODEL §8, RR-06).

### USDT (bridged canónico de Base)

- **Emisor:** no existe USDT emitido por Tether ni USDT0 en Base; es el `L2StandardERC20` del bridge canónico, respaldado por USDT de Ethereum en escrow del `L1StandardBridge`.
- **Upgradeability:** no upgradeable, sin admin, sin pausa ni blacklist; sólo el bridge `0x4200000000000000000000000000000000000010` hace mint/burn.
- **Consecuencia:** depende del bridge y de las claves de upgrade de Base; Tether no emite ni redime en Base (RR-07).

### Uniswap v3 (pool USDC/USDT 0,01 %)

- El pool, la factory y QuoterV2 son inmutables (sin admin de upgrade); el pool se verifica con `getPool(USDC, USDT, 100)` en el fork.
- Riesgos: liquidez baja del par en Base y MEV dentro del slippage, acotados por el piso on-chain de 0,5 % y los límites de policy (ADR-015, ADR-025, RR-03, RR-08).
- SwapRouter02, UniversalRouter y Permit2 **no** se usan; toda llamada a Permit2 en el camino asistido se rechaza ([C-GRD-08]).

### Safe v1.5.0

- Singleton SafeL2, SafeProxyFactory, MultiSendCallOnly y CompatibilityFallbackHandler del deployment `canonical` (safe-deployments v1.5.0), inmutables. El código se fija en el commit `dc437e8` (`script/verify-deps.sh`).
- La seguridad del sistema depende de la corrección de Safe v1.5.0 (auditada por terceros); el Guard sólo clasifica con firmas que la Safe ya validó.

## Política ante un cambio de implementación de un proxy de token

Un cambio de la implementación de USDC (slot del proxy distinto de `implementation.address` o codehash distinto) **no** bloquea automáticamente los retiros: los usuarios siempre pueden salir por el camino soberano y el sistema no puede impedir lo que haga el emisor. La respuesta es:

1. **Alerta inmediata** del monitor de contratos externos (P24.T06) y de `scripts/verify-external --block latest`.
2. **Revisión** del nuevo código (fuente verificada en BaseScan, diff contra la versión anterior, anuncio oficial de Circle).
3. Según el resultado: actualizar `implementation` en el JSON con un commit dedicado, o revocar el token en `PolicyRegistry` (revocación inmediata por admin o guardián) mientras dura la revisión, lo que bloquea sólo las operaciones asistidas con ese token.
