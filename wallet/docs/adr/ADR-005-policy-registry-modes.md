# ADR-005 — PolicyRegistry con modos BOOTSTRAP y RESTRICTED

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-005), §0.1 (R-09, R-14), §6 ([C-GEN]), §6.4 ([C-GRD-03] paso 7), §6.6 ([C-POL-01] a [C-POL-06]), §7.9 ([B-POL-01], [B-POL-04]), §13.1 (H-04); V9 §11; prompt §3 (Policy)

## Contexto

V9 §11 define el Policy Engine en dos etapas. En V1-BOOTSTRAP conviven la policy del backend, una policy del signer independiente (con snapshot firmado) y el `SecurityGuard` estructural. El modo endurecido RESTRICTED se alcanza con una transición unidireccional BOOTSTRAP → RESTRICTED: default = DENY y sólo permisos explícitos; los permisos nuevos se proponen, esperan 24 horas y recién entonces se activan, y guardianes independientes pueden cancelarlos durante ese timelock. `PolicyRegistry` gobierna el camino asistido, nunca el camino soberano U+R.

El prompt §3 admite BOOTSTRAP durante el desarrollo, pero exige que el acceptance gate de producción imponga RESTRICTED/default DENY para todas las operaciones de V1, y que la aplicación sólo permita operaciones explícitamente soportadas.

## Decisión

`PolicyRegistry` con modo `BOOTSTRAP → RESTRICTED` (unidireccional). Permisos por `(opType, rol)` ([C-POL-02]), registro de tokens soportados y de swap executors; en RESTRICTED: alta con timelock de 24 h, los guardianes pueden cancelar y las revocaciones son inmediatas. **Staging y producción nacen RESTRICTED** (constructor) con el set V1 completo. El fork local también se despliega **RESTRICTED por defecto** (igual que producción); BOOTSTRAP existe sólo como perfil de desarrollo de contratos (`deploy-local --policy-mode bootstrap`) y las suites adversariales corren en ambos modos. Admin = Governance Safe (multisig; hardware wallets recomendadas para sus owners, H-04).

Detalle ([C-POL]):

- **Inmutables y modo** ([C-POL-01]): `ADMIN` (Governance Safe) y `ACTIVATION_DELAY = 24 hours`; modo `BOOTSTRAP | RESTRICTED`; `enterRestricted()` (admin, unidireccional); el constructor recibe modo inicial y entradas iniciales activas.
- **Registros** ([C-POL-02]): los permisos se materializan como `opPermission[opType][role]` sobre la clasificación de target y selector que hace el Guard ([C-GRD-05] a [C-GRD-13]); opTypes: NOOP, TRANSFER, APPROVE, APPROVE_REVOKE, SWAP, WHITELIST_ADD, WHITELIST_REMOVE, ROTATION_PROPOSE, ROTATION_CANCEL, ROTATION_EXECUTE, MIGRATION_TRANSFER y GUARD_UPGRADE ([C-GRD-17], ADR-029), más UNKNOWN, que sólo BOOTSTRAP admite. Además `supportedToken[token] = {decimals}`, `swapExecutor[executor]`, `migrationAuthorization[oldSafe][newSafe]` y `guardians`.
- **Cambios** ([C-POL-03]): en BOOTSTRAP el admin modifica los registros de inmediato. En RESTRICTED las altas van por `propose…` (admin) → `PENDING` 24 h → `activate…` (cualquiera); `cancel…` lo puede ejecutar el admin o cualquier guardián durante el pending (la baja de un guardián sólo la pueden cancelar **otros** guardianes); `revoke…` es inmediato por admin o guardián ("endurecer nunca espera").
- **Set V1** ([C-POL-04]), para staging y producción: U → NOOP, TRANSFER, APPROVE, APPROVE_REVOKE, SWAP, WHITELIST_ADD, WHITELIST_REMOVE, ROTATION_PROPOSE, ROTATION_CANCEL, ROTATION_EXECUTE, MIGRATION_TRANSFER, GUARD_UPGRADE; R → NOOP, APPROVE_REVOKE, WHITELIST_REMOVE, ROTATION_PROPOSE, ROTATION_CANCEL, ROTATION_EXECUTE, MIGRATION_TRANSFER. Tokens: USDC y USDT (6 decimales). Executors: `SwapExecutorV3`.
- **Evaluación en el Guard** ([C-GRD-03] paso 7): `POLICY_REGISTRY.isOpAllowed(opType, rol)`; en BOOTSTRAP devuelve true para opTypes conocidos, y las operaciones desconocidas se permiten salvo los selectores de autoridad económica de [C-DEC-03] y las llamadas administrativas; en RESTRICTED las operaciones desconocidas se deniegan siempre.
- **Alcance** ([C-POL-05]): gobierna sólo el camino asistido; el Guard nunca lo consulta en el soberano (ADR-004).
- **Sucesores del Guard** ([C-POL-06]): registro `successorGuard[oldGuard]` y `successorModuleGuard[old]`, con alta por timelock de 24 h y cancelación por guardianes (ADR-029).
- **Capa off-chain:** el registry on-chain se complementa con el snapshot de policy firmado que backend y signer evalúan por separado ([B-POL-01], [B-POL-04], ADR-025).

## Alternativas consideradas

- **Producción en BOOTSTRAP:** descartado; el prompt §3 exige RESTRICTED/default DENY como gate de producción (§4).
- **Fork local en BOOTSTRAP por defecto:** descartado; local se despliega RESTRICTED, igual que producción, y BOOTSTRAP queda sólo como perfil de desarrollo de contratos.
- **Altas inmediatas en RESTRICTED:** descartadas por V9 §11 (propuesta, 24 h de espera y posibilidad de cancelación por guardianes).
- **Revocaciones con timelock:** descartadas; endurecer nunca espera ([C-POL-03]).
- **Transición reversible RESTRICTED → BOOTSTRAP:** excluida por V9 §11 (transición unidireccional).

## Consecuencias

- En producción rige default DENY: toda operación fuera del set V1 revierte on-chain aunque backend y signer fallaran.
- Todo permiso, token, executor o sucesor nuevo tiene una ventana visible de 24 h en la que los guardianes pueden cancelarlo; las revocaciones toman efecto en el acto.
- Incorporar un token o un executor nuevo (por ejemplo, un `SwapExecutorV4`, o una representación oficial distinta de USDT si apareciera en Base) es un cambio de policy con timelock, más la configuración de frontends y del pool correspondiente (§3.3).
- `PolicyRegistry` es el único contrato propio con admin ([C-GEN]): la seguridad del modo RESTRICTED depende de la custodia de la Governance Safe y de que los guardianes vigilen las propuestas durante las 24 h.
- Durante el planner (R-09, R-14, ADR-024) la Governance Safe y los guardianes de staging y producción son de ensayo: se crean en el fork con claves generadas en `~/.config/mtw/`, fuera del repositorio, que nunca se reutilizan en Base mainnet (P25.T05, P30.T02). La Governance Safe real y los guardianes independientes forman parte del despliegue final (H-04, P30.T06).
- Las suites adversariales e invariantes corren en ambos modos, y el acceptance full-system corre sobre un deploy RESTRICTED.

## Verificación

- P04.T04 — `PolicyRegistry` con modos, registros, timelock de 24 h, guardianes, revocación inmediata y eventos (`forge test --match-contract PolicyRegistryTest`).
- P04.TST — transición BOOTSTRAP → RESTRICTED irreversible, alta antes de 24 h no activa, cancelación por guardián, revocación inmediata, un guardián no puede cancelar su propia baja, admin distinto rechazado.
- P07.T09 y P07.TST — P07.T01 y P07.T02 en ambos modos; en RESTRICTED, operaciones desconocidas y tokens no soportados revierten.
- P23.T01 — escenario de 22 pasos sobre un deploy local RESTRICTED.
- P25.T02 — `DeployBase.s.sol` con `PolicyRegistry` en RESTRICTED y el set V1 de [C-POL-04].
- P25.TST y P25.SEC — staging y producción con `mode == RESTRICTED` y exactamente el set V1.
- P26.T17.e — gate: RESTRICTED con exactamente el set V1 en los deploys de staging y producción sobre el fork.
- P30.T03 — `PolicyRegistry` de producción en RESTRICTED con exactamente el set V1, Governance Safe y guardianes de ensayo.
- P28.SEC — ningún fix relajó la policy RESTRICTED.
- Trazabilidad: RQ-15, RQ-16.
