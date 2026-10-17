# ADR-007 — RotationTimelock de 48 h

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-007), §2.3, §5.4 (rotación asistida y recovery de U), §6.4 ([C-GRD-11], [C-GRD-12]), §6.5 ([C-RTL-01] a [C-RTL-05]), §7.10 ([B-SIG-02], [B-SIG-05]), §7.11 ([B-RL]), §7.15 ([W-01]), §9.3; V9 §10, §14, §19; prompt §3 (Rotaciones), §9

## Contexto

V9 §14 define el cambio asistido de U, R o S como: U o R + S → propose → timelock de 48 h → execute. Al proponer se notifica por email y dentro de la aplicación, y la U actual o la R actual pueden cancelar individualmente en cualquier momento durante el timelock. Los flujos de recovery derivan de ese mecanismo: con U perdida, R firma el reemplazo U → U' y S valida; con R perdida, U firma el reemplazo R → R'. V9 §10 fija `modules = none` en el camino asistido, y V9 §19 reconoce como supuesto que U o R actuales pueden cancelar individualmente una rotación pendiente.

El prompt §3 repite el esquema propose → 48 h → execute con cancelación individual, y el §9 asigna a R la recuperación o el cambio de U y la cancelación de rotaciones. Entre los comportamientos deliberados (§2.3) está que U o R puedan cancelar incluso para vetar su propia rotación; el remedio para ese caso es la migración excepcional (ADR-026).

## Decisión

`RotationTimelock` de 48 h desplegado por el constructor del `SecurityGuard` (sin dependencias circulares). La propuesta se hace por SafeTx asistida; la cancelación individual, por U o R vía firma EIP-712 (cualquier relayer) o por la propia Safe; la ejecución es una SafeTx `swapOwner` validada por el Guard contra una propuesta madura y firmada **nuevamente** por la U o la R vigente + S.

Detalle ([C-RTL]):

- **Constantes** ([C-RTL-01]): `GUARD` (constructor), `DELAY = 48 hours`, dominio EIP-712 `("MTW RotationTimelock", "1", chainId, address(this))`. El Guard lo crea con `new RotationTimelock(address(this))`.
- **`propose(kind, oldValue, newValue) → id`** ([C-RTL-02]): `kind ∈ {U, R, S, GUARD, MODULE_GUARD}`; `msg.sender` = Safe registrada en el Guard; a lo sumo una propuesta activa por (safe, kind); para U/R/S, `GUARD.rolesOf(safe)[kind] == oldValue`; `id = keccak256(abi.encode(chainId, this, safe, kind, oldValue, newValue, ++count[safe]))`; `executableAt = now + 48 h`; evento `RotationProposed`. (Los tipos `GUARD` y `MODULE_GUARD` se usan para la vía de upgrade del Guard, ADR-029.)
- **Reglas del Guard para proponer y cancelar** ([C-GRD-11]): el rol U puede proponer U, R, S, GUARD o MODULE_GUARD; el rol R puede proponer U o S (nunca R, nunca GUARD); `old == rolesOf(safe)[role]`; `new ∉ {U, R, S actuales, 0, sentinel, safe, contratos del sistema}`; `cancel(id)` con roles U o R. Para S, backend y signer exigen además que `new` sea una clave creada por el propio signer para esa wallet; para U o R, una firma EIP-712 `KeyAcceptance` de la nueva clave ([B-SIG-02], [W-01]).
- **Cancelación** ([C-RTL-03]): `cancel(id)` por la propia Safe; `cancelWithSignature(id, signature)` por cualquiera, con una firma EIP-712 `CancelRotation(bytes32 proposalId,address safe)` de la U **o** la R **vigente** (ECDSA de 65 bytes, low-s), válida mientras la propuesta esté `PENDING` (antes o después de madurar, hasta que se ejecute); evento `RotationCancelled(id, signer)`. El backend expone un relay sin autenticación (`POST /rotations/{id}/cancel`) que verifica firma y propuesta pendiente on-chain y retransmite por el gas tank ([B-SIG-05]); la firma también se puede transmitir por cualquier relayer o con una wallet propia.
- **Ejecución** ([C-GRD-12], [C-RTL-04]): la SafeTx `safe.swapOwner(prev, old, new)` exige una propuesta `PENDING` madura en el timelock para `(safe, role, old, new)` y `rolesOf(safe)[role] == old`; en el post-check se llama `ROTATION_TIMELOCK.markExecuted(id)` (sólo `GUARD`, exige `PENDING` y `now ≥ executableAt`) y se actualiza el rol (`RoleRotated(safe, role, old, new)`); si el rol es S, el nuevo executor rige desde la siguiente transacción.
- **Vistas** ([C-RTL-05]): `getProposal(id)`, `activeProposal(safe, role)` y `executableProposal(safe, old, new)`.
- **Notificaciones:** email e in-app al proponer, cancelar y ejecutar; el watcher detecta y notifica también las propuestas on-chain no originadas por el backend (P15.T07).

## Alternativas consideradas

- **Ejecutar la rotación mediante un módulo de Safe:** descartado; la ejecución se hace sin módulos, porque la configuración exige `modules = none` (§4, V9 §10).
- **Firmar la ejecución por anticipado al proponer:** descartado; la re-firma al madurar evita reservar nonces de la Safe durante 48 h y congelarla (§4).
- **Cancelación sólo mediante `cancel(id)` desde la propia Safe:** insuficiente, porque una SafeTx necesita threshold y V9 §14 exige cancelación *individual* por U o R; por eso existe `cancelWithSignature`, transmisible por cualquier relayer.

## Consecuencias

- A17: las rotaciones asistidas sólo ocurren tras 48 h y si nadie las canceló. Un compromiso de R + S sólo puede rotar U tras 48 h, con posibilidad de cancelación por U (§9.3).
- Escenario "rotación de S hacia una clave del atacante" (U y backend comprometidos): el signer sólo co-firma rotaciones de S hacia claves que él mismo creó para esa wallet, y U o R pueden cancelar durante 48 h (§9.3).
- La recuperación de una U perdida (o de una R perdida) demora como mínimo 48 h, y requiere que la clave firmante esté disponible tanto al proponer como al ejecutar.
- La cancelación no depende del backend: alcanza con una firma de U o R y cualquier relayer (P15.SEC). El relay del backend tiene un bucket de rate limit propio: 10/h por propuesta y 60/h por IP ([B-RL]).
- Una credencial que veta su propia rotación no se puede reemplazar por esta vía: el remedio es la migración excepcional (ADR-026), comportamiento deliberado según §2.3.
- El mismo timelock sostiene la vía de upgrade del Guard (ADR-029).

## Verificación

- P05.T01 — `RotationTimelock` (`forge test --match-contract RotationTimelockTest`).
- P05.T06 — propuesta y ejecución con `vm.warp(48h)`; cancelación por firma de U y por firma de R.
- P07.T01.i — bypass de rotación y de timelock: ejecutar antes de 48 h, con old ≠ rol, con propuesta cancelada, R proponiendo rol R.
- P11.T03 — política del signer: rotación de S sólo hacia claves propias y `KeyAcceptance` para U' o R'.
- P15.T01, P15.T02 y P15.T03 — propuesta, cancelación sin autenticación vía relay y ejecución con actualización de roles.
- P15.T04 y P15.T05 — flujos "perdí U / Password U" y "perdí R".
- P15.TST.a — cancelación por U, por R y por un relayer ajeno al backend.
- P15.TST.b — ejecución antes de 48 h, con old ≠ rol actual o con R+S proponiendo rol R → revert.
- P15.TST.c y P15.TST.d — recovery completo de U con warp de 48 h, R perdida y rotación de S con continuidad de operaciones.
- P15.SEC — cancelación posible sin backend.
- P18.T09, P18.T09.a y P18.T09.b — rotaciones en Wallet: cancelar, reemplazar Recovery y rotación de S pedida por la plataforma.
- P19.T04 y P19.T05 — recovery de U y rotaciones desde Recovery.
- P22.T02.p y P22.T02.q — E2E de recover U/R y de cancelación de rotación por U y por R.
- P23.T01.i y P23.T01.j — pasos 21 y 22 del acceptance.
- P27.T02.d — auditoría de bypass del timelock de rotación.
- Trazabilidad: RQ-14, RQ-33.
