# ADR-015 — Swap con SwapExecutorV3 contra el pool canónico de Uniswap v3

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-015), §2.2, §3.3, §3.4, §6.3 ([C-DEC-03]), §6.4 ([C-GRD-07], [C-GRD-09]), §6.8 ([C-SWP-01] a [C-SWP-05]), §7.10 ([B-SIG-02]), §9.2 (A15, A16), §9.3, P06; V9 §9, §10, §12; prompt §3 (Autoridades económicas indirectas), §12; CF-04

## Contexto

El prompt §12 limita el swap a USDC ↔ USDT en Base con contratos oficiales de Uniswap verificados (address y codehash registrados), prohíbe la calldata arbitraria de Uniswap desde el frontend, sugiere evaluar un `SwapExecutor` propio mínimo (USDC ↔ USDT, ruta canónica, recipient = Safe, `amountIn` explícito, `minAmountOut`, deadline y límites de slippage) y pide elegir el diseño de menor riesgo. Prefiere "approve exacto → swap → allowance final 0" en una operación atómica cuando sea técnicamente posible; Permit2 o cualquier autorización persistente debe entrar explícitamente al threat model, y el resultado siempre vuelve a la Safe.

V9 §9 y §10 imponen CALL-only en el camino asistido (sin DELEGATECALL, y por lo tanto sin MultiSend), y V9 §12 trata como salida económica cualquier approve, permit, Permit2, allowance persistente o router genérico. CF-04 registra la consecuencia: con un CALL único por SafeTx, la atomicidad approve + swap + revoke en **una** SafeTx no es posible.

Hechos verificados en el bloque 52700000 (§3.3, §3.4): USDC nativo de Circle `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (proxy upgradeable con pausa y blacklist, 6 decimales) y USDT bridged canónico `0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2` (`L2StandardERC20`, sin admin, 6 decimales); pool Uniswap v3 USDC/USDT fee 100 (0,01 %) `0xD56da2B74bA826f19015E6B7Dd9Dae1903E85DA1`, codehash `0x7c1e281e8700a5038559b9380296ee9c4591b706789a1aa5a7a270ca837ef80d`, con token0 = USDC y token1 = USDT; `UniswapV3Factory` `0x33128a8fC17869897dcE68Ed026d694621f6FDfD`; `QuoterV2` `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` (cotización por `eth_call`). La liquidez total de Uniswap USDC/USDT en Base es baja (≈ US$ 850k) y la diferencia de precio entre el pool v3 0,01 % y el mejor pool v4 es de ~0,006 % para 1.000 USDC.

## Decisión

Swap con un `SwapExecutorV3` propio contra el **pool canónico Uniswap v3 USDC/USDT 0,01 %** (`0xD56da2B74bA826f19015E6B7Dd9Dae1903E85DA1`), por llamada directa al pool con callback validado; sin router, sin Permit2 y sin calldata arbitraria. Dos SafeTx consecutivas firmadas en una sola ceremonia: nonce N `approve(executor, amountIn)` exacto y nonce N+1 `swap`. El Guard impone post-condiciones on-chain y los executors se registran en `PolicyRegistry`, lo que permite un `SwapExecutorV4` futuro con timelock.

Contrato ([C-SWP]):

- **Inmutables** ([C-SWP-01]): `TOKEN0 = USDC`, `TOKEN1 = USDT`, `POOL` (v3 0,01 %), `FACTORY`, `FEE = 100`, `MAX_SLIPPAGE_BPS = 50`. El constructor verifica `FACTORY.getPool(TOKEN0, TOKEN1, FEE) == POOL`, `token0`/`token1` del pool y decimales iguales.
- **`swap(tokenIn, amountIn, minAmountOut, deadline) → amountOut`** ([C-SWP-02]), `nonReentrant` con transient storage: `tokenIn ∈ {USDC, USDT}`, `amountIn > 0`, `deadline ≥ now`, `minAmountOut ≥ amountIn·(1 − 0,5 %)`; **payer = recipient = `msg.sender`** (no es parámetro); `POOL.swap(recipient, zeroForOne, int256(amountIn), límite de precio extremo, "")`; exige fill completo (`pagado == amountIn`) y `amountOut ≥ minAmountOut`, verifica el delta de saldo del recipient y emite `Swapped`.
- **`uniswapV3SwapCallback`** ([C-SWP-03]): sólo `msg.sender == POOL` y con swap activo; toma exactamente el delta positivo que pide el pool para `tokenIn`, exige que sea igual a `amountIn` y paga con `transferFrom(payer, POOL, delta)`, consumiendo exactamente la allowance de la Safe, que queda en 0.
- **Sin custodia** ([C-SWP-04]): sin admin ni funciones de retiro; nunca custodia fondos. `tokenOutFor(tokenIn)` y la interfaz `ISwapExecutor` permiten registrar a futuro un `SwapExecutorV4` (pool v4 fee 5) vía `PolicyRegistry` con timelock.
- **Requisitos para registrar cualquier executor** ([C-SWP-05]): inmutable y sin admin; único `transferFrom` posible con `from == msg.sender` del `swap`; recipient fijo = `msg.sender`; mismo ABI `swap(tokenIn, amountIn, minOut, deadline)`; suite de tests de P06/P07 aplicada al executor nuevo en verde; auditoría.

Reglas del Guard:

- **APPROVE** ([C-GRD-07]): sólo si `token` es soportado y `spender` es un swap executor registrado; rol U, `amount ≤ balanceOf(safe)`; rol R, sólo `amount == 0` (revocación); cualquier otro spender → `EconomicAuthorityDenied`. Los selectores de autoridad económica de [C-DEC-03], incluida cualquier llamada a Permit2, se deniegan siempre.
- **SWAP** ([C-GRD-09]): executor registrado; rol U; `tokenIn` soportado y `tokenOut = executor.tokenOutFor(tokenIn)` soportado; mismos decimales; `amountIn > 0`; `minOut ≥ amountIn·(10_000 − MAX_SWAP_SLIPPAGE_BPS)/10_000` con `MAX_SWAP_SLIPPAGE_BPS = 50`; `deadline ≥ block.timestamp`. Post-condiciones: `saldoIn_antes − saldoIn_después ≤ amountIn`, `saldoOut_después − saldoOut_antes ≥ minOut` y `allowance(safe, executor)` de `tokenIn` == 0.

> Nota de consistencia: la fila de ADR-015 en §4 del planner expresaba el piso como `minAmountOut ≥ amountIn·(1−1 %)`, en contradicción con [C-GRD-09] (`MAX_SWAP_SLIPPAGE_BPS = 50`), [C-SWP-01], [C-SWP-02], ADR-025 y el riesgo residual declarado en la misma fila (0,5 %). El 2026-10-17 se corrigió el planner a 0,5 % (§13); este ADR, P05.T02 y P06.T01 usan 50 bps.

Emparejamiento off-chain y operación:

- On-chain no se puede ligar el approve N a su swap N+1: backend y signer exigen el emparejamiento exacto. El signer sólo co-firma un `SWAP_APPROVE` si llega acompañado de su `SWAP` N+1 firmado por U con el mismo executor y `amountIn == amount`, y el `SWAP` sólo tras el approve ejecutado ([B-SIG-02]).
- Cotización con QuoterV2 (`eth_call`) sobre el pool canónico: `expectedOut`, `minOut` según slippage (≤ 50 bps), impacto de precio y `deadline` = now + 10 min (P14.T04). Si el swap falla en forma final, se ofrece re-cotizar (nueva SafeTx N+1) o `APPROVE_REVOKE`, y un job notifica allowances residuales (P14.T05).

## Alternativas consideradas

El análisis de alternativas que exige P06 (router, UniversalRouter + Permit2, v4 y MultiSend) concluye:

- **SwapRouter02** (`0x2626664c2603336E57B271c5C0b26F421741e481`): no se usa; un router agrega superficie y calldata de ruteo que el diseño evita con la llamada directa al pool.
- **UniversalRouter 2.1.2** (`0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40`) **+ Permit2** (`0x000000000022D473030F116dDEE9F6B43aC78BA3`): no se usa; Permit2 es una autorización persistente y las approvals a Permit2 se deniegan ([C-DEC-03]).
- **Uniswap v4** (PoolManager singleton `0x498581fF718922c3f8e6A244956aF099B2652b2b`): más complejidad a cambio de una mejora de precio de ~0,006 %; queda como candidato a un `SwapExecutorV4` futuro.
- **MultiSend** (approve + swap + revoke atómicos en una SafeTx): requiere DELEGATECALL, prohibido en el camino asistido (CF-04).

## Consecuencias

- A15 y A16: no queda allowance persistente a terceros y, tras un swap asistido, la allowance Safe → SwapExecutor vale 0; el swap sólo opera USDC ↔ USDT contra el pool canónico, con recipient = Safe y `minOut` por encima del piso.
- Menor superficie: el pool v3 es inmutable y verificable por codehash, y el executor nunca custodia fondos.
- Las post-condiciones del Guard acotan lo que puede pasar **dentro** de la SafeTx del swap (pérdida ≤ `amountIn`, recepción ≥ piso). La allowance residual entre N y N+1 es segura sólo porque todo executor registrado debe debitar exclusivamente a `msg.sender` ([C-SWP-05]): un tercero que llama `swap` paga con **su** allowance, no con la de la Safe.
- Riesgo residual documentado: MEV/sandwich acotado por el piso de 0,5 %, con slippage por defecto de 0,3 % y deadline de 10 min (§9.3, ADR-025).
- Con liquidez baja y fill completo obligatorio, un monto que excede la liquidez revierte; los límites y el monitoreo de liquidez y cotización están en ADR-025.
- Dependencias externas que entran en los riesgos residuales (P28.T03): USDC upgradeable por Circle, con pausa y blacklist, y USDT dependiente del bridge canónico de Base.

## Verificación

- P06.T01 — `SwapExecutorV3` (`forge test --match-contract SwapExecutorV3Test`).
- P06.T02 — registro del executor y de USDC/USDT en `PolicyRegistry` e integración con [C-GRD-07] y [C-GRD-09].
- P06.T03 — swaps reales en ambos sentidos en el fork: saldos verificados, executor sin fondos, allowance final 0, fill parcial que revierte, `minOut` bajo el piso, deadline vencido, token arbitrario, callback de un no-pool, reentrancia y approve residual no utilizable por terceros.
- P06.T04 — cotización de referencia con QuoterV2 usada para validar `minOut`.
- P06.TST — fuzz de montos (1 unidad … 10.000 tokens) y slippage.
- P06.SEC — no existe ninguna ruta de `transferFrom` con payer ≠ `msg.sender`.
- P07.T01.j y P07.T01.k — swap de token o recipient arbitrario, calldata maliciosa, `minOut` bajo el piso y allowances persistentes.
- P07.T02 — invariante "allowance a terceros siempre 0".
- P14.T04, P14.T05 y P14.TST.d — cotización, prepare del grupo de 2 operaciones y swaps reales con allowance final 0.
- P18.T07 — pantalla de swap con cotización propia y review de las 2 SafeTx.
- P22.T02.n y P23.T01.g — E2E y acceptance de swaps en ambos sentidos.
- P27.T02.g — auditoría de calldata de swap maliciosa y abuso de allowances.
- Trazabilidad: RQ-18, RQ-38, RQ-39, RQ-40.
