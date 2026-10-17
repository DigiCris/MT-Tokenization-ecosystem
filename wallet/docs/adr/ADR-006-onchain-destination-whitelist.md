# ADR-006 — DestinationWhitelist on-chain con activación diferida

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-006), §2.2, §5.4 (Whitelist), §6.4 ([C-GRD-06], [C-GRD-10]), §6.7 ([C-WHL-01], [C-WHL-02], [C-WHL-03]), §7.3 ([B-DB]), §7.11 ([B-RL]), §7.12 ([B-MAIL-02]), §7.15 ([W-03]), §9.2 (A9, A18), §9.3; V9 §12, §13; prompt §3 (Destinos), §10, §11; CF-08

## Contexto

V9 §12 exige que toda salida de valor hacia un destino externo elegido por el usuario tenga una *destination authorization* previa, que el frontend no puede habilitar por sí solo: el usuario solicita el destino D, el backend crea un challenge, un canal externo muestra D, el usuario confirma y D queda whitelisteada. El challenge es single-use y queda ligado a userId, Safe, chainId, destination, action, nonce y expiresAt. V9 §13 agrega que, para el alta de destinos nuevos, el canal externo muestra explícitamente la dirección que se habilita.

El prompt §10 pide un contrato dedicado `DestinationWhitelist` con `isWhitelisted(safe, destination)`, consultado on-chain por toda operación asistida de envío, y deja que el planner decida "el mecanismo exacto más seguro" para actualizarlo, con una condición: el backend solo no debe poder falsificar una autorización del usuario. El prompt §11 exige que un envío a un destino no whitelisteado falle aunque se manipulen el frontend o la API.

El documento de negocio menciona "direcciones frecuentes" que no serían necesariamente una restricción on-chain; prompt y V9 exigen enforcement final on-chain (CF-08).

## Decisión

`DestinationWhitelist` on-chain por Safe: alta sólo con `msg.sender == safe` (SafeTx U+S tras el challenge), **activación diferida de 24 h**, baja inmediata e `isWhitelisted(safe, dest)`.

Detalle del contrato ([C-WHL]):

- `ACTIVATION_DELAY = 24 hours` (inmutable); por Safe, un `EnumerableSet` de destinos más `activatesAt` ([C-WHL-01]).
- `addDestination(dest)`: sólo `msg.sender` = la Safe; `dest ≠ 0`, `dest ≠ msg.sender`, no existente → `DestinationAdded(safe, dest, activatesAt)`. `removeDestination(dest)` → `DestinationRemoved` ([C-WHL-02]).
- `isWhitelisted(safe, dest)` = existe y `now ≥ activatesAt`; `destinationsOf(safe)` y `destinationInfo(safe, dest)` para lectura directa desde los frontends ([C-WHL-03]).

Reglas del Guard:

- `addDestination(dest)` sólo con rol U y `dest ∉ {safe, contratos del sistema, tokens soportados, swap executors, 0}`; `removeDestination(dest)` con roles U o R ([C-GRD-10]).
- `token.transfer(dest, amount)`: `amount > 0`, `dest ∉ {safe, contratos del sistema, tokens soportados, 0}`; sin autorización de migración, rol U exige `DESTINATION_WHITELIST.isWhitelisted(safe, dest)` y rol R revierte ([C-GRD-06]; la migración excepcional es ADR-026).

Proceso off-chain (§5.4, P14.T01):

1. Solicitud del destino y challenge ligado a `{userId, safe, chainId, destination, action, nonce, expiresAt}`: single-use, expirable, auditable e idempotente (tabla `security_challenges`, tipo `WHITELIST_ADD`).
2. Email con la plantilla sensible de [B-MAIL-02]: acción, dirección completa (checksum EIP-55 en grupos de 4), red, Safe y expiración; nunca links que ejecuten acciones.
3. El usuario ingresa el código en la app; el emisor de sesiones firma la atestación `ChallengeCompletion` ([W-03]), que el signer verifica.
4. U firma la SafeTx `DestinationWhitelist.addDestination(dest)`, S la ejecuta y el destino queda `ACTIVATING`; pasa a `ACTIVE` cuando `isWhitelisted` es true on-chain (24 h). Recién entonces es seleccionable en Send.
5. La baja (`removeDestination`) es inmediata, con U o R; Recovery la ofrece en `/emergency` con R + S.

## Alternativas consideradas

- **Whitelist sólo off-chain ("direcciones frecuentes" del documento de negocio):** descartada; prevalecen prompt y V9, que exigen enforcement final on-chain para toda salida asistida (CF-08).
- **Alta de destinos por el backend o por un rol administrativo:** descartada; con alta sólo por `msg.sender == safe`, el backend solo no puede alterar la whitelist porque necesita la firma de U (§4, A18).
- **Activación inmediata del destino:** descartada; la demora de 24 h agrega una ventana de reacción ante phishing o compromiso del canal de email, y es la lectura de "mecanismo más seguro" del prompt §10 (§4).

## Consecuencias

- A9: una salida externa a un destino no autorizado falla aunque U esté comprometida, en tres capas (backend, signer y Guard). A18: el backend solo no puede alterar la whitelist ni falsificar la autorización del usuario.
- Un destino nuevo tarda 24 h en ser usable; los tests y el seed lo resuelven con warp de 24 h en el fork (P21.T04, P22.T01).
- Una baja toma efecto inmediato, porque el Guard consulta `isWhitelisted` on-chain en cada transferencia asistida.
- Riesgo residual (§9.3): un usuario que confirma con U el destino de un atacante lo habilita al cabo de 24 h. Mitigaciones: el email muestra la dirección exacta, hay alerta in-app y las bajas son inmediatas (también con R desde `/emergency`).
- Límite de abuso: 5 solicitudes de whitelist por día por Safe y 10 por día por usuario ([B-RL]).
- Los frontends leen la whitelist directamente on-chain (`destinationsOf`) y sólo toman del backend las etiquetas (P18.T05); en Send sólo se ofrecen destinos `ACTIVE`.

## Verificación

- P04.T05 — `DestinationWhitelist` (`forge test --match-contract DestinationWhitelistTest`).
- P04.TST — activación a las 24 h exactas (`vm.warp`), aislamiento entre Safes y `dest == msg.sender` rechazado.
- P05.T06 — transfer a destino whitelisteado activo (OK) y no whitelisteado (revert) en el fork.
- P07.T01.a — send a destino no whitelisteado, pendiente de activación o de otra Safe.
- P14.T01 y P14.T02 — challenge ligado, email, atestación, SafeTx `addDestination` y validaciones de destino.
- P14.TST.a — destino no whitelisteado rechazado en tres capas: backend, signer y revert del Guard.
- P14.TST.b — challenge expirado, reusado o con otra dirección; whitelist en `ACTIVATING` no usable; idempotencia.
- P14.SEC — A9 y A18 cubiertos en tres capas.
- P14.MAN — email de whitelist con acción, dirección, red y expiración.
- P18.T05 — pantalla de whitelist con lectura on-chain, alta con código del email y cuenta regresiva.
- P22.T02.k y P22.T02.m — E2E de alta con activación a 24 h y rechazo de destino no whitelisteado.
- P23.T01.d y P23.T01.f — pasos 9–11 y 14–15 del acceptance.
- P27.T02.c — auditoría de bypass de whitelist.
- Trazabilidad: RQ-17, RQ-35, RQ-36.
