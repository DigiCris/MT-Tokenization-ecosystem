# ADR-025 — Límites por defecto del snapshot de policy

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-025), §3.4, §6.4 ([C-GRD-09]), §7.3 ([B-DB]), §7.9 ([B-POL-01] a [B-POL-05]), §7.10 ([B-SIG-03]), §7.14 ([B-OBS]), §7.15 ([W-03]), §9.3; V9 §11, §13; prompt §11, §12

## Contexto

V9 §11 establece que el signer usa un snapshot firmado de policy y vuelve a verificar target, selector, token, monto, destino, multicall, secuencia y whitelist directamente desde la SafeTx, de forma independiente de la policy del backend. V9 §13 admite exigir un segundo factor para operaciones de mayor riesgo, con un challenge ligado a Safe, SafeTxHash, acción, token, monto, destino y nonce. El prompt §11 pide que backend y signer validen policy, whitelist, saldo y nonce antes de cada envío, y el §12 exige `amountIn` explícito, `minAmountOut`, deadline y límites de slippage para los swaps.

La liquidez observada condiciona los límites de swap (§3.4): en el bloque 52700000 el pool v3 0,01 % tenía `liquidity = 297227205812614` y saldos de 67.659,18 USDC + 133.289,34 USDT; el total de Uniswap USDC/USDT en Base rondaba US$ 850k (liquidez baja); QuoterV2 cotizaba 1.000 USDC → 1.001,363627 USDT.

## Decisión

Límites por defecto en el snapshot de policy: **10.000 por operación**, **20.000 por Safe cada 24 h**, **2FA desde 1.000** (TOTP o email OTP), **swap ≤ 10.000 por operación**, **slippage por defecto 30 bps / máximo 50 bps** (= piso on-chain) y **deadline de 10 min**. Los swaps se deshabilitan por policy si la cotización se desvía más de 0,5 % de 1:1 o si la liquidez del pool cae bajo el umbral de monitoreo.

Detalle ([B-POL]):

- **Límites** ([B-POL-02]): montos en USDC o USDT (6 decimales); salida acumulada de 24 h por Safe; umbral de 2FA transaccional con factor TOTP si el usuario lo tiene activo y, si no, email OTP, mediante un challenge `HIGH_VALUE_TX` ligado a Safe, SafeTxHash, acción, token, monto, destino y nonce, del que el signer exige la atestación `ChallengeCompletion` ([W-03]); mínimo por operación de 1 unidad de token. `MIGRATION_TRANSFER` queda exento del límite de 24 h, pero exige el caso de operadores con doble aprobación y la autorización on-chain madura, y transfiere el saldo completo (ADR-026).
- **Snapshot firmado** ([B-POL-01]): `config/policy/<env>/policy-snapshot.json` + `.sig` (Ed25519, clave del equipo de seguridad; la pública queda fijada en backend y signer), con versión monótona, chainId, direcciones del sistema, tipos de operación habilitados por rol, tokens (USDC, USDT), límites, umbral de 2FA, slippage, deadlines y platformId. El signer rechaza snapshots con firma inválida o con versión menor a la vigente (anti-rollback).
- **Operaciones tipificadas** ([B-POL-03]): `SEND`, `SWAP_APPROVE`, `SWAP`, `APPROVE_REVOKE`, `WHITELIST_ADD`, `WHITELIST_REMOVE`, `ROTATION_PROPOSE`, `ROTATION_EXECUTE`, `NOOP_CANCEL`, `MIGRATION_TRANSFER` y `GUARD_UPGRADE` (sólo U, hacia el sucesor activo con propuesta madura; [C-GRD-17], [W-07], ADR-029); cualquier otra se rechaza.
- **Evaluación independiente** ([B-POL-04], [B-POL-05]): backend y signer evalúan la policy por separado, decodificando desde los bytes de la SafeTx; el backend lleva su ledger de salidas de 24 h en PostgreSQL (`backend/app/src/policy/`) y el signer el suyo en su propia base (`backend/signer/src/policy/`, [B-SIG-03]); ambas implementaciones se contrastan contra los mismos vectores.
- **Piso on-chain:** el slippage máximo de policy coincide con el piso del Guard, `MAX_SWAP_SLIPPAGE_BPS = 50` ([C-GRD-09]).
- **Umbrales de monitoreo** ([B-OBS]): alerta si la liquidez activa del pool canónico cae por debajo del 50 % de la observada en `FORK_BLOCK_NUMBER` o si las reservas USDC + USDT bajan de US$ 100k; si la cotización USDC/USDT se desvía más de 0,5 % de 1:1, además de alertar se deshabilitan los swaps por policy.

## Alternativas consideradas

Las fuentes no registran alternativas descartadas para estos valores concretos: son parámetros de negocio iniciales, modificables mediante un snapshot firmado nuevo y elegidos en forma coherente con la liquidez observada (§4, §3.4). Lo que queda fijado por diseño es que el slippage máximo de la policy no puede superar el piso on-chain de 50 bps.

## Consecuencias

- La exposición queda acotada por operación y por día aun con U comprometida, y se suma a la whitelist on-chain (ADR-006) y al piso de slippage del Guard.
- El MEV/sandwich en swaps queda acotado por el piso de 0,5 %, con slippage por defecto de 0,3 % y deadline de 10 min (riesgo residual documentado en §9.3).
- Los swaps pueden quedar deshabilitados automáticamente si la cotización o la liquidez salen de rango.
- El 2FA agrega fricción a las operaciones desde 1.000.
- Cambiar un límite exige un snapshot nuevo con versión mayor, firmado con la clave de policy del entorno; en el despliegue final el snapshot de producción se re-firma offline (P30.T06).

## Verificación

- P11.T03 — política del signer: límites, ledger de 24 h y atestación de challenge (whitelist y 2FA).
- P11.T04 — snapshot de policy firmado, `policy:verify` y test de anti-rollback.
- P13.T10 — policy del backend: snapshot firmado y anti-rollback, tabla por rol, límites, ledger de 24 h y umbral de 2FA.
- P13.TST.j — policy del backend contra los vectores compartidos, con el mismo veredicto que el signer.
- P14.T03 y P14.TST.c — send con 2FA exigido sobre el umbral.
- P14.T04 — cotización con `minOut` según slippage (≤ 50 bps) y `deadline` de now + 10 min.
- P24.T06 — monitoreo de dependencias externas: liquidez bajo umbral y desvío de cotización > 0,5 % que deshabilita swaps.
- P25.T07 y P30.T03 — snapshots de policy de staging y producción firmados con la clave de cada entorno.
- Trazabilidad: RQ-37, RQ-83.
