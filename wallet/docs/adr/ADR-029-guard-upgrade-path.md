# ADR-029 — Vía de upgrade del Guard para Safes existentes

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-029), §6 ([C-GEN]), §6.4 ([C-GRD-11], [C-GRD-13], [C-GRD-17]), §6.5 ([C-RTL-02], [C-RTL-03]), §6.6 ([C-POL-03], [C-POL-06]), §7.15 ([W-07]), P07, P15.T08, P26.T15; V9 §9, §16; prompt §3 (SecurityGuard y Factory)

## Contexto

V9 §9 exige que el `SecurityGuard` tenga código inmutable y V9 §16 fija en la `WalletFactory` toda la configuración sensible de cada Safe nueva, incluido el Guard; el prompt §3 repite ambos requisitos. Las reglas generales de contratos prohíben proxies y upgradeability ([C-GEN]), y en el camino asistido cualquier `setGuard` o `setModuleGuard` es una llamada administrativa prohibida ([C-GRD-13]).

Eso deja un problema operativo: un contrato nuevo de la factory sólo afecta a las wallets nuevas (P26.T15), y U+R siempre puede retirar o cambiar el Guard por el camino soberano (ADR-004), pero eso exige que cada usuario junte U y R. Sin otra vía, un bug del Guard inmutable sólo se podría resolver con ceremonias U+R usuario por usuario.

## Decisión

**Vía de upgrade del Guard** para Safes existentes ([C-GRD-17]): sucesor registrado en `PolicyRegistry` (24 h + guardianes) + propuesta por Safe en `RotationTimelock` (48 h, cancelable por U o R) + SafeTx asistida `setGuard(sucesor)`. Los contratos nuevos de la factory sólo afectan a wallets nuevas.

Detalle:

- **Registro de sucesores** ([C-POL-06]): `successorGuard[oldGuard]` y `successorModuleGuard[old]`, con alta por timelock de 24 h y cancelación por guardianes ([C-POL-03]). Requisito de alta: auditoría del sucesor, codehash publicado y la suite de P07 completa en verde contra el sucesor.
- **Propuesta por Safe** ([C-RTL-02], [C-GRD-11]): `propose(kind, oldValue, newValue)` con `kind ∈ {GUARD, MODULE_GUARD}`, `oldValue` igual al slot actual y `newValue` igual a un sucesor registrado; sólo el rol U puede proponer GUARD o MODULE_GUARD (R nunca propone GUARD); `executableAt = now + 48 h`; U o R pueden cancelarla individualmente, incluso con firma EIP-712 transmitida por cualquier relayer ([C-RTL-03]).
- **Ejecución** ([C-GRD-17]): en camino asistido se permite `safe.setGuard(newGuard)` o `safe.setModuleGuard(newModuleGuard)` sólo si (a) el nuevo contrato está registrado y activo como sucesor en `PolicyRegistry` y (b) existe en `RotationTimelock` una propuesta madura (48 h) y no cancelada del tipo correspondiente para esa Safe con ese valor. En el post-check de esa operación el slot debe valer el sucesor, como excepción explícita al chequeo "guard == este contrato". El sucesor debe importar los roles desde este Guard (`rolesOf`) en su primer uso.
- **Implementación de la importación** (P05, 2026-10-17): el propio `SecurityGuard` recibe en el constructor el inmutable `PREDECESSOR` (`address(0)` en V1). En el primer uso de una Safe que lo instaló, si la Safe es un `SafeProxy` canónico con este Guard en su slot y está registrada en el predecesor, importa sus roles (`version + 1`, evento `RolesImported`). Las vistas devuelven esos roles aun antes del primer uso. Tras un upgrade de tipo MODULE_GUARD, el chequeo de estado intacto acepta como module guard el sucesor activo de `DENY_ALL_MODULE_GUARD` en `PolicyRegistry`; si la gobernanza lo revoca, el camino asistido vuelve a fail-closed hasta que U+R restauren la configuración. La lectura del slot de una Safe ajena nunca revierte ([external-calls-review.md](../security/external-calls-review.md)).
- **Operación** (P15.T08, [W-07]): `GUARD_UPGRADE` se ofrece en el scope `OPERATIONS` sólo para U, con propuesta en el timelock, notificación, 48 h de espera y ejecución con firma de U + S; sólo se habilita si hay un sucesor activo en `PolicyRegistry`.

## Alternativas consideradas

- **Sin vía de upgrade:** descartado; un bug del Guard inmutable sólo se podría resolver con ceremonias U+R por usuario (§4).
- **Guard upgradeable (proxy):** excluido por [C-GEN] (sin proxies ni upgradeability) y por V9 §9 (código inmutable).
- **Depender sólo del cambio soberano del Guard por U+R:** sigue disponible como expresión de soberanía (ADR-004), pero exige las dos claves del usuario y no escala como mecanismo de corrección.

## Consecuencias

- Existe una vía de corrección para las Safes ya desplegadas que no requiere juntar U y R, protegida por un doble timelock (24 h en el registro de sucesores y 48 h por Safe) y por el veto individual de U o R.
- Cada upgrade requiere la firma de U y al menos 48 h por Safe; si el usuario cancela la propuesta, esa Safe se queda con el Guard anterior.
- Un sucesor sólo puede registrarse tras auditoría, con codehash publicado y la suite de P07 en verde, y debe implementar la importación de roles desde el Guard actual.
- Un compromiso de la gobernanza no alcanza para cambiar el Guard de una Safe: además hace falta la firma de U + S en esa Safe, con 48 h de ventana para que U o R cancelen.

## Verificación

- P05.T06 — upgrade del Guard en fork: sin sucesor registrado, antes de 48 h o con la propuesta cancelada → revert; completo → OK.
- P07.T01.r — sucesor no registrado, propuesta inmadura o cancelada, y `setGuard` hacia un contrato arbitrario en camino asistido.
- P15.T08 — operación `GUARD_UPGRADE` de punta a punta con un Guard sucesor de prueba desplegado en el fork.
- P05.T01 — `RotationTimelock` con los tipos `GUARD` y `MODULE_GUARD`.
- Trazabilidad: RQ-90.
