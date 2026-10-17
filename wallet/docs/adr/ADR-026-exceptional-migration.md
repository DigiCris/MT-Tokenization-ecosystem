# ADR-026 — Migración excepcional con autorización on-chain

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-026), §2.3, §6.4 ([C-GRD-01], [C-GRD-06]), §6.6 ([C-POL-02], [C-POL-03], [C-POL-04]), §7.3 ([B-DB]), §7.9 ([B-POL-02]), §7.11 ([B-API]), §7.13 ([B-AUD]), §7.15 ([W-07]), §8.4 ([F-UI]), §9.2 (A5), P15.T06; V9 §14, §19, §20

## Contexto

V9 §14 contempla el caso de una credencial comprometida que veta su propia rotación (U o R pueden cancelar individualmente cualquier rotación pendiente, ADR-007). El procedimiento excepcional es manual: verificación humana reforzada, doble aprobación interna y registro auditable; la credencial sana firma una transferencia y S la co-firma hacia una Safe nueva, y la Safe anterior se abandona una vez migrados los activos. V9 §19 lo toma como supuesto autoritativo, y §2.3 lo lista entre los comportamientos deliberados. A5 (V9 §20) exige que R+S sólo ejecute recovery permitido o el flujo excepcional autorizado.

Sin un control on-chain, el Guard no podría distinguir una migración autorizada de una salida de R+S (o de un backend comprometido junto con S) hacia un destino arbitrario.

## Decisión

Migración excepcional, para una credencial que veta su rotación: doble aprobación interna de operadores + autorización on-chain en `PolicyRegistry` por la Governance Safe (24 h, con posibilidad de cancelación por guardianes) + regla del Guard: el destino debe ser una Safe registrada en el Guard cuyo rol correspondiente coincida con la credencial sana firmante.

Detalle:

- **Regla del Guard** ([C-GRD-06]): la rama de migración de un `token.transfer(dest, amount)` aplica si y sólo si `POLICY_REGISTRY.isMigrationAuthorized(safe, dest)`; además `dest` debe estar registrada en este Guard (por [C-GRD-01], creada por la `WalletFactory`) y el rol del firmante debe coincidir en el destino: `rolesOf(dest).userKey == U` si firma U, o `rolesOf(dest).recoveryKey == R` si firma R. El opType es `MIGRATION_TRANSFER`.
- **Autorización on-chain** ([C-POL-02], [C-POL-03]): registro `migrationAuthorization[oldSafe][newSafe]`, que en RESTRICTED se propone por el admin (Governance Safe), espera 24 h en `PENDING` y puede ser cancelado por cualquier guardián.
- **Permisos** ([C-POL-04], [W-07]): `MIGRATION_TRANSFER` está en el set V1 para U y para R; se habilita en los scopes `OPERATIONS` (U, Wallet) y `RECOVERY` (R, Recovery).
- **Doble aprobación interna** ([B-DB]): tablas `operator_users` (operadores con TOTP obligatorio) y `operator_actions` (append-only, con `CHECK(approver_1 <> approver_2)`); eventos de auditoría `MIGRATION_CASE_*` y `OPERATOR_ACTION_*` ([B-AUD]).
- **Flujo** (P15.T06): caso de operador con doble aprobación → la wallet vieja pasa a `MIGRATING` → se crea la Safe nueva por la factory con `migrated_from_wallet_id`, con la credencial sana como owner → la Governance Safe propone la autorización on-chain (24 h) → `MIGRATION_TRANSFER` del saldo completo, firmado por la credencial sana + S y exento del límite de 24 h ([B-POL-02]) → la wallet vieja pasa a `MIGRATED`. Runbook en `docs/runbooks/exceptional-migration.md`.
- **API e interfaces:** `POST /wallets/{id}/migration/prepare` exige el caso de operadores aprobado y la autorización on-chain madura ([B-API]); Wallet (`/security/migration`) y Recovery (`/migration`) verifican on-chain la Safe destino (owners, roles en el Guard, creación por la factory y autorización madura) antes de que U o R firmen ([F-UI]).

## Alternativas consideradas

- **Procedimiento exclusivamente manual y off-chain** (doble aprobación sin enforcement on-chain): no se adopta; el planner agrega el enforcement on-chain a lo que pide V9 §14 (§4), porque sin él el Guard no podría acotar a qué destino puede salir una transferencia firmada por la credencial sana junto con S (A5).

## Consecuencias

- A5 queda cubierta on-chain: una migración sólo puede ir a una Safe creada por la factory cuyo rol coincida con la credencial sana, y sólo con una autorización madura de la Governance Safe.
- La credencial comprometida puede vetar su rotación, pero no puede bloquear la migración, que sólo requiere la credencial sana, S, los operadores y la gobernanza.
- El procedimiento es lento (al menos 24 h de timelock en `PolicyRegistry`) y operativamente pesado: dos operadores distintos con TOTP, una propuesta de la Governance Safe y la vigilancia de los guardianes.
- La Safe vieja se abandona tras migrar el saldo completo; el historial conserva el vínculo por `migrated_from_wallet_id`.
- V1 admite una sola wallet activa por usuario: durante la migración la vieja queda `MIGRATING` y la nueva se crea con `migrated_from_wallet_id` (índice único parcial de `wallets`, [B-DB]).

## Verificación

- P15.T06 — migración excepcional completa en el fork (`test/integration/migration.test.ts`).
- P15.TST.e — sin autorización → revert; con autorización madura → OK sólo hacia la Safe autorizada; doble aprobación de operadores obligatoria.
- P07.T01.o — migración no autorizada y R+S intentando operar como U+S.
- P18.T11 — migración en Wallet con verificación on-chain de la Safe destino antes de firmar con U.
- P19.T10 — pantalla `/migration` de Recovery: R firma `MIGRATION_TRANSFER` tras verificar on-chain la Safe destino.
- P04.T04 — `PolicyRegistry` con registros, timelock de 24 h y cancelación por guardianes.
- Trazabilidad: RQ-84.
