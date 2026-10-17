# ADR-004 — Camino soberano sin políticas de negocio

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-004), §2.3, §5.4 (soberano U+R), §6.4 ([C-GRD-03] paso 3, [C-GRD-04], [C-GRD-13], [C-GRD-14]), §6.6 ([C-POL-05]), §7.6 ([B-Q-02] paso 7b), §7.7 ([B-FIN-03]), §9.2 (A6), §9.3; V9 §9, §10, §18, §19; prompt §3 (SecurityGuard y Modules), §41

## Contexto

V9 §9 establece que el camino U+R no está sujeto a business policies de la plataforma: mientras el Guard siga instalado *puede* mantener invariantes estructurales, pero U+R puede cambiar o retirar el Guard mediante una transacción soberana de la propia Safe. V9 §10 agrega que U+R puede modificar módulos, module guard y fallback como expresión de soberanía. V9 §18 garantiza que U+R tiene control completo, que cualquier relayer con gas puede transmitir y que ese camino no depende de PlatformSession, Backend, Signer, Policy Engine ni PolicyRegistry: con copias válidas de U y R el usuario mantiene el control aunque la plataforma desaparezca.

El prompt §3 exige que el camino U+R no quede bloqueado por políticas de negocio, y §41 (copiado en §2.3) lista la soberanía de U+R entre los comportamientos deliberados que no son vulnerabilidades.

## Decisión

El camino soberano (S no participa) va **sin políticas de negocio**: el Guard no aplica whitelist ni `PolicyRegistry`; sólo mantiene sincronizados los roles ante un `swapOwner` soberano y permite `updateRoles` llamado por la propia Safe. U+R puede retirar el Guard.

Detalle:

- **Clasificación** ([C-GRD-03] paso 3): si `executor ∉ signers` del threshold validado, el camino es SOVEREIGN. Se guarda siempre el marcador `SOVEREIGN` y, si la llamada es `swapOwner` directo a la propia Safe, el par `(old, new)` para sincronizar roles. No hay chequeos de negocio ni **ningún `revert` posible** en este camino: las operaciones vía DELEGATECALL/MultiSend o que retiran el Guard también pasan.
- **Post-ejecución** ([C-GRD-04]): en SOVEREIGN (o con contexto ausente, que no debería ocurrir) `checkAfterExecution` nunca revierte; si hubo un `swapOwner` directo exitoso de una clave con rol, actualiza ese rol (`RolesSynced`). Cualquier otro cambio de roles —por ejemplo, dentro de un MultiSend— se resincroniza con `updateRoles` y lo detecta la reconciliación off-chain ([B-FIN-03]).
- **`updateRoles(U, R, S)`** ([C-GRD-14]): sólo `msg.sender == safe` registrada; exige que sean owners actuales y distintos. En la práctica sólo es alcanzable por el camino soberano, porque [C-GRD-13] lo bloquea en el asistido.
- **Ejecuciones anidadas:** el contexto por Safe se apila por profundidad (`depth[safe]`) en transient storage para soportar ejecuciones soberanas anidadas (§6.4).
- **`PolicyRegistry`** gobierna sólo el camino asistido; el Guard nunca lo consulta en el soberano ([C-POL-05]).
- **Lado off-chain:** antes de cada co-firma, backend y signer verifican la configuración on-chain de la Safe (guard, module guard, fallback, módulos, threshold y owners contra `rolesOf`); si U+R la alteraron, no se co-firma, la wallet pasa a `SOVEREIGN_MODIFIED`, se alerta y se informa al usuario ([B-Q-02] paso 7b). On-chain, el camino asistido queda fail-closed hasta que U+R restauren la estructura o actualicen roles ([C-GRD-03] paso 6).
- **Herramientas client-side:** Recovery `/sovereign` arma SafeTx soberanas tipadas con el formato [W-05] y Wallet `/sovereign` co-firma con U, sin backend; `wallet/tools/sovereign-exit/` permite operar U+R offline, fuera de los origins de la plataforma (P19.T09). Para que esta salida funcione aunque la plataforma desaparezca, U y R deben tener cada una al menos un backup independiente de la plataforma ([F-KEY-06]).

## Alternativas consideradas

- **Aplicar whitelist o `PolicyRegistry` también al camino U+R:** descartado por V9 §9, §11 y §18 ("PolicyRegistry gobierna el camino asistido, nunca el camino soberano") y por A6.
- **Mantener invariantes estructurales en el camino soberano mientras el Guard esté instalado** (posibilidad que V9 §9 admite): no se adopta. El Guard no revierte nunca en el camino soberano, de modo que ninguna regla del Guard pueda bloquear la salida soberana (incluidos MultiSend, `execTransaction` anidado y el retiro del propio Guard); la protección de la plataforma frente a cambios soberanos es off-chain (dejar de cooperar, `SOVEREIGN_MODIFIED`) y on-chain sólo afecta al camino asistido (fail-closed).

## Consecuencias

- El usuario conserva control completo de la Safe con U+R aunque la plataforma desaparezca, y cualquier relayer puede transmitir (V9 §18).
- El compromiso conjunto de U y R otorga el poder correspondiente por diseño (§2.3, V9 §19): no se reporta como vulnerabilidad y se usa como filtro obligatorio en la auditoría (P27.T04).
- Tras un cambio soberano de estructura, la plataforma deja de cooperar con esa Safe hasta que U+R restauren la configuración: la wallet queda `SOVEREIGN_MODIFIED` y se alerta (§9.3).
- Un cambio de roles dentro de un MultiSend deja los roles del Guard desincronizados hasta que U+R ejecuten `updateRoles`; la reconciliación lo detecta y alerta.
- Las transacciones soberanas se indexan desde los eventos de SafeL2 para que el historial esté completo ([B-FIN-03]).
- La salida soberana depende de que el usuario conserve backups independientes de U y R: el appDataFolder sólo es accesible con el cliente OAuth de la plataforma ([F-KEY-06], ADR-012).

## Verificación

- P05.T06 — camino soberano U+R en fork: retirar el Guard, cambiar S y transferir a cualquier dirección sin backend; cambios soberanos de configuración (`enableModule`, `setFallbackHandler`, `setModuleGuard(otro)`, `setModuleGuard(0)`) seguidos de fail-closed del camino asistido; `setGuard(0)`, MultiSend vía DELEGATECALL y `execTransaction` anidado pasan.
- P07.T01.q — el Guard nunca bloquea el camino soberano.
- P07.T02 — invariante "toda tx U+R con firmas válidas se ejecuta (el Guard nunca la revierte)".
- P13.T11 y P13.TST.k — chequeo de configuración antes de co-firmar y estado `SOVEREIGN_MODIFIED`.
- P15.T09 — U+R reemplazan una S perdida soberanamente y ejecutan `updateRoles`.
- P18.T10 — co-firma soberana en Wallet sin backend.
- P19.T06 — modo soberano de Recovery con el backend detenido.
- P19.T09 — `tools/sovereign-exit`: transferencia soberana en el fork con backend y frontends apagados.
- P23.T02 — U+R soberano con backend detenido → transferencia exitosa.
- P29.T04 — guía de salida soberana ensayada en el fork.
- Trazabilidad: RQ-07, RQ-87, RQ-89.
