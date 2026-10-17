# ADR-027 — PostgreSQL 18 y Valkey 9 self-hosted

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-027), §1, §3.6, §5.3, §5.5, §7.3 ([B-DB], [B-DB-ROLES], [B-DB-BK]), §10, P00.T02, P26.T06; prompt §5, §21, §26, §38

## Contexto

El prompt §5 prefiere PostgreSQL como base de datos y Redis con un worker de cola. El §21 pide migraciones, constraints, foreign keys, índices únicos, límites transaccionales y una estrategia de backup/restore; el §26, levantar PostgreSQL y Redis en local con un mínimo de comandos; el §38, persistencia de la cola cuando corresponda. La producción es self-hosted, sin cloud (ADR-022), y PostgreSQL es la fuente de verdad mientras la cola es sólo transporte (ADR-021). En la máquina de desarrollo hay un cliente psql 14 instalado, por lo que los servicios de docker compose usan puertos no estándar (§1).

## Decisión

**PostgreSQL 18** y **Valkey 9** self-hosted (contenedores con volúmenes persistentes, usuarios separados, healthchecks y los backups de ADR-031); PostgreSQL es la fuente de verdad y Valkey es el transporte de BullMQ.

Detalle:

- **Imágenes** (§3.6, P00.T02): `postgres:18.6` y `valkey/valkey:9.2`, fijadas por digest.
- **Local** (§5.3, P00.T02): PostgreSQL en el puerto 55432, con las bases `mtw_wallet` (backend) y `mtw_signer_dev` (estado del signer de desarrollo) y los roles `mtw_migrator`, `mtw_app` y `mtw_signer` creados por el init script; Valkey en el 56379 con `--appendonly yes --maxmemory-policy noeviction --requirepass $REDIS_PASSWORD`.
- **Producción** (§5.5, P26.T06): `postgres` del backend en la red `backend` (`internal: true`) con volumen `pg-data` y repositorio pgBackRest; superusuario sólo para bootstrap y roles `mtw_migrator`, `mtw_app` y `mtw_readonly`. `signer-postgres` en la red `signer` (`internal: true`) con volumen `signer-pg-data`, roles propios por shard y backups propios. `valkey` en `backend` (`internal: true`) con AOF + RDB, `maxmemory-policy noeviction`, un usuario ACL con los comandos que necesita BullMQ y el usuario `default` deshabilitado.
- **Roles y permisos** ([B-DB], [B-DB-ROLES]): `mtw_migrator` (DDL), `mtw_app` (DML sin DELETE ni UPDATE sobre `audit_events`), `mtw_readonly`; passwords `MTW_APP_DB_PASSWORD`, `MTW_MIGRATOR_DB_PASSWORD` y `MTW_SIGNER_DB_PASSWORD`, generadas por `secrets:local` en local y por `scripts/deploy/init-secrets.sh` en producción (ADR-030).
- **Backups** ([B-DB-BK]): pgBackRest para PostgreSQL del backend y del signer (ADR-031).

## Alternativas consideradas

- **Redis 8:** descartado por su licencia AGPL. Valkey es compatible con el protocolo Redis —con lo que se cumple la preferencia "Redis" del prompt— y tiene licencia BSD (§4).

## Consecuencias

- BullMQ e ioredis funcionan sin cambios sobre Valkey, con una licencia permisiva y sin dependencia de un servicio gestionado.
- La operación de las bases queda a cargo del equipo: backups, restore ensayado, upgrades y monitoreo.
- Una pérdida de Valkey se recupera desde el outbox de PostgreSQL (ADR-021); por eso la cola usa `noeviction` y persistencia AOF.
- El dominio signer tiene su propia instancia de PostgreSQL, con credenciales que el backend no posee ([B-SIG-03]).
- Los tests de integración corren contra PostgreSQL 18 y Valkey 9 reales con Testcontainers (§10).

## Verificación

- P00.T02 — `docker-compose.yml` con imágenes fijadas por digest y servicios `healthy`.
- Check de preflight PF-17 — PostgreSQL ≥ 18, Valkey con `noeviction` y `appendonly yes`.
- P08.T03 — migraciones sobre PostgreSQL 18 (Testcontainers): `audit_events` inmodificable y el índice parcial de nonces.
- P13.TST.h — flush de Valkey sin pérdida ni duplicados.
- P26.T01 — imagen `postgres` (18.6 + pgBackRest 2.59.x).
- P26.T06 — conexión con cada rol limitada a lo permitido, Valkey rechaza al usuario `default` y reinicio de Valkey sin pérdida de operaciones.
- P26.T08 — restore de PostgreSQL con PITR en un contenedor nuevo.
- Trazabilidad: RQ-51, RQ-56.
