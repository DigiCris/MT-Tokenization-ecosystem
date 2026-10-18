# Runbook: migración excepcional de una wallet

Procedimiento de ADR-026 (P15.T06) para cuando una de las dos credenciales del usuario (U o R) está comprometida y
**veta su propia rotación**: cada propuesta de rotación queda cancelada por la credencial comprometida (U o R pueden
cancelar individualmente, ADR-007), así que los fondos se mueven a una Safe nueva donde la **credencial sana conserva su
rol**. Lo prueba de punta a punta `backend/app/test/integration/migration.test.ts` (los dos casos: U sana y R sana).

Nada de este procedimiento puede mover fondos sin la credencial sana: el Guard sólo acepta la transferencia de
migración hacia la Safe autorizada on-chain y exige que esa Safe tenga la misma clave en el rol de quien firma
([C-GRD-06]).

## Cuándo aplica

- Hay evidencia de que U o R están comprometidas y la rotación asistida (48 h, cancelable) no prospera porque la clave
  comprometida cancela cada propuesta. Si la rotación es posible, se usa la rotación (no esta migración).
- El usuario conserva la otra credencial (la sana) y la cuenta (email, contraseña y, si lo tiene, TOTP).
- Si U **y** R están en manos del usuario, no hace falta la plataforma: U + R pueden operar soberanamente desde
  Recovery.

## Roles

| Quién | Qué hace |
|---|---|
| Operador A (soporte) | Verificación humana reforzada del usuario y apertura del caso |
| Operador B (otro operador) | Revisión independiente y aprobación (doble aprobación, nunca el mismo que abrió) |
| Usuario | Onboarding de la Safe nueva y firma de la migración con la credencial sana |
| Governance Safe | Propuesta de la autorización on-chain en el `PolicyRegistry` (24 h) |
| Guardianes | Vigilan la propuesta y pueden cancelarla durante las 24 h |

Los operadores se dan de alta una sola vez con TOTP obligatorio (la URI de enrolamiento se escribe en un archivo 0600;
nunca sale por pantalla):

```bash
pnpm --dir backend/app operators operator:add --email <email> --name "<nombre>" --totp-uri-file <archivo>
```

La CLI corre con la configuración del backend (mismo entorno y secretos que el proceso `api`; en producción, dentro
del contenedor del backend). Toda acción de operador lee el código TOTP por **stdin** y queda en la cadena de
auditoría (`OPERATOR_*`, `MIGRATION_CASE_*`); un código inválido o reutilizado se rechaza y se audita
(`OPERATOR_AUTH_FAILED`).

## 1. Verificación reforzada y apertura del caso (operador A)

1. Verificar la identidad del usuario por un canal distinto del email de la cuenta (videollamada con documento, datos
   de alta, historial de operaciones). Registrar en el ticket qué se verificó.
2. Confirmar con el usuario cuál credencial es la sana (la que conserva y puede usar).
3. Abrir el caso:

```bash
echo "<código TOTP>" | pnpm --dir backend/app operators migration:request \
  --wallet <walletId> --healthy U|R --reason "<motivo, 10 a 500 caracteres, con el número de ticket>" \
  --operator <email del operador A>
```

## 2. Aprobación (operador B)

Otro operador revisa el ticket y aprueba:

```bash
echo "<código TOTP>" | pnpm --dir backend/app operators migration:approve --case <caseId> --operator <email del operador B>
```

Efectos: fila append-only en `operator_actions` (`approver_1` ≠ `approver_2`), caso `APPROVED`, wallet vieja
`MIGRATING` y email + notificación al usuario. Desde ese momento la plataforma **sólo co-firma la migración** (y una
NoOp de cancelación) en la Safe vieja: la credencial comprometida ya no consigue que S co-firme nada más.

`migration:status --case <id>` muestra el caso; `migration:cancel` lo cancela mientras la Safe nueva no se haya
desplegado (la wallet vieja vuelve a `ACTIVE`).

## 3. Safe nueva (usuario)

El usuario hace el onboarding normal en la app Wallet (step-up ONBOARDING): la wallet nueva queda vinculada a la vieja
(`migrated_from_wallet_id`) y al caso.

- **U sana**: registra la **misma U** (puede elegir otra Password U) y vincula una **R nueva** desde Recovery.
- **R sana**: registra una **U nueva** y vincula la **misma R** desde Recovery.

El backend rechaza reutilizar la credencial comprometida y exige que el rol sano sea exactamente la credencial sana de
la wallet vieja. Después: asignación de S, autorización de creación firmada por U y deploy por la factory.

## 4. Autorización on-chain (Governance Safe)

Con la Safe nueva `ACTIVE`, la Governance Safe propone la autorización (desde su interfaz de Safe, con el quórum de sus
owners):

```text
PolicyRegistry.proposeMigrationAuthorization(<Safe vieja>, <Safe nueva>)
```

Los guardianes revisan la propuesta (evento `ChangeProposed`) durante las 24 h y la cancelan con
`cancelChange(<id>)` si algo no coincide con el caso aprobado. Pasadas las 24 h, cualquiera llama
`activateChange(<id>)`; `isMigrationAuthorized(<Safe vieja>, <Safe nueva>)` pasa a `true`.

## 5. Migración (usuario)

- **U sana**: en Wallet, desbloquea la wallet vieja con su Password U (el desbloqueo admite `walletId` de la wallet en
  `MIGRATING`) y abre la migración.
- **R sana**: en Recovery, step-up RECOVERY sobre la wallet vieja (`walletId`) y abre la migración.

`POST /wallets/{id}/migration/prepare` exige el caso aprobado, la Safe nueva `ACTIVE`, la autorización on-chain activa
y que la credencial de la sesión sea la sana; devuelve un `MIGRATION_TRANSFER` por token con saldo (el **saldo
completo**, exento del límite de 24 h) y la Safe destino, que la app verifica on-chain antes de firmar (owners, roles en
el Guard, creada por la factory, autorización activa). La firma la credencial sana y la ejecuta S.

## 6. Cierre

Cuando la Safe vieja queda sin saldo de los tokens soportados y sus transferencias están confirmadas, el worker marca la
wallet vieja `MIGRATED` y el caso `COMPLETED` (`MIGRATION_COMPLETED` en auditoría) y avisa al usuario. La Safe vieja se
abandona: sigue on-chain con sus owners, pero la plataforma no vuelve a operarla.

## Verificaciones

- Que el caso tenga dos aprobadores distintos: `SELECT approver_1, approver_2 FROM operator_actions WHERE id = <approval_action_id>`.
- Que la Safe nueva tenga la credencial sana en el mismo rol: `SecurityGuard.rolesOf(<Safe nueva>)`.
- Que la autorización esté activa: `PolicyRegistry.isMigrationAuthorized(<vieja>, <nueva>)`.
- Auditoría: `pnpm --dir backend/app audit:verify` (la cadena incluye los eventos de operadores y del caso).
