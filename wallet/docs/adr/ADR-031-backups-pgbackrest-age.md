# ADR-031 — Backups con pgBackRest y age

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-031), §3.5 (pgBackRest / age), §7.3 ([B-DB-BK]), §7.10 ([B-SIG-08]), §7.13 ([B-AUD]), §7.14 ([B-OBS]), §13.1 (H-06), P11.T10, P26.T07, P26.T08, P26.T13; prompt §21, §38

## Contexto

El prompt §21 pide definir backup y restore de la base, y el §38 exige una estrategia de backups y un restore test como parte de PRODUCTION READINESS. La producción es self-hosted y sin cloud (ADR-022). Además de PostgreSQL del backend, hay estado crítico en el dominio signer: su propia base de datos y los keystores cifrados de S, cuya credencial de desbloqueo debe custodiarse aparte (ADR-014, ADR-030).

Hechos verificados (§3.5): pgBackRest 2.59.3 (2026-10-04) hace backups full, diferenciales y WAL con repositorio cifrado; age 1.3.2 (2026-08-29) cifra archivos con clave pública.

## Decisión

Backups agnósticos al proveedor: PostgreSQL (backend y signer) con **pgBackRest** (full + diferencial + WAL archiving para PITR, repositorio cifrado; repo1 local y repo2 off-host, cuyo destino concreto se configura al desplegar); keystores del signer, export de auditoría y configuración empaquetados y cifrados con **age** hacia la clave pública de backup. La credencial de desbloqueo del signer **nunca** viaja en esos backups (custodia offline separada, dos copias selladas con custodios distintos). La copia off-host cifrada es obligatoria en producción y el restore se ensaya en local (P26).

Detalle:

- **PostgreSQL** ([B-DB-BK], P26.T07): full semanal, diferencial diario y WAL archiving continuo para PITR, con retención y repositorio cifrado (`pgbackrest.conf.example`); en local, `pnpm db:backup` / `pnpm db:restore` y un perfil de compose `backup` para ensayar pgBackRest. La imagen `postgres` incluye pgBackRest (P26.T01).
- **Signer** ([B-SIG-08]): tras cada alta de clave y diariamente, keystores + dump de la DB del signer cifrados con `age` hacia la clave pública de backup y copiados off-host (`signer-backup.sh`); el restore en un host nuevo pasa por el modo `restore-verify` antes del modo normal.
- **Auditoría** ([B-AUD]): export diario firmado y cifrado con `age` hacia la copia off-host; el hash de cada export queda anclado como evento de auditoría (`audit-export.sh`).
- **Configuración** (P26.T07): `config-backup.sh` empaqueta el compose, `.env.production` sin secretos, los snapshots de policy y las claves públicas.
- **Retención** (P26.T13): exports de auditoría con retención de 7 años en la copia off-host (valor por defecto ajustable).
- **Restore test** (P26.T08): PITR de PostgreSQL a un instante dado en un contenedor nuevo, `audit:verify` y reconciliación contra el fork; restore de un shard del signer con `restore-verify`; medición de RTO y RPO.

## Alternativas consideradas

- **Incluir la credencial de desbloqueo en los backups de keystores:** descartado; la credencial nunca viaja con ellos y se custodia offline en dos copias selladas con custodios distintos, de modo que un backup filtrado no alcanza para obtener S.

Las fuentes no registran otras herramientas de backup evaluadas: pgBackRest y age se eligen por ser herramientas maduras y self-hosted (§4), coherentes con la producción sin cloud (ADR-022).

## Consecuencias

- Hay recuperación a un punto en el tiempo para ambas bases y recuperación de los keystores del signer, sin depender de ningún proveedor.
- Un backup filtrado no expone S: hace falta además la credencial de desbloqueo, que está fuera de los backups.
- El destino off-host de los backups y la custodia offline de las credenciales con dos custodios son acciones del despliegue final (H-06), junto con la custodia de la clave privada de backup.
- Si se pierden a la vez los keystores, sus backups o la credencial de desbloqueo, las claves S afectadas son irrecuperables: la Safe queda sin camino asistido hasta que U+R reemplacen S (P15.T09).
- Se alerta si un backup de keystores falla o se atrasa ([B-OBS], P24.T07).

## Verificación

- P08.T03 — `pnpm db:backup` y `pnpm db:restore` disponibles junto con las migraciones.
- P11.T10 — procedimientos del ciclo de vida del signer: backup cifrado con `age` sin la credencial, restore + `restore-verify` y custodia offline (dos copias selladas, custodios distintos).
- P26.T07 — cada script de backup corre en el ensayo local y produce artefactos cifrados que sólo se abren con la clave privada de backup de prueba.
- P26.T08 — restore test con RTO y RPO medidos, registrado en §13.
- P26.T16.b — ensayo local del layout de producción con los scripts de backup y restore.
- P26.T17.g — gate: backups y restore ensayados (PostgreSQL PITR, keystores del signer, auditoría) y custodia offline documentada.
- P24.T07 — alarma de backup de keystores fallido o atrasado.
- P30.T04 — backups y restore en verde contra el ensayo de producción.
- Trazabilidad: RQ-51, RQ-95.
