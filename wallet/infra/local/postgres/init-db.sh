#!/usr/bin/env bash
# Init de Postgres local (corre una sola vez, al crear el volumen). Crea los roles separados y la DB
# propia del signer de desarrollo. Las passwords llegan por variables de entorno desde wallet/.env y
# se pasan a psql como variables (:'var'), nunca interpoladas en el SQL.
set -euo pipefail

psql -v ON_ERROR_STOP=1 \
  -v app_pw="$MTW_APP_DB_PASSWORD" \
  -v migrator_pw="$MTW_MIGRATOR_DB_PASSWORD" \
  -v signer_pw="$MTW_SIGNER_DB_PASSWORD" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE mtw_migrator LOGIN PASSWORD :'migrator_pw';
CREATE ROLE mtw_app LOGIN PASSWORD :'app_pw';
CREATE ROLE mtw_signer LOGIN PASSWORD :'signer_pw';
-- Rol de grupo de sólo lectura [B-DB]: sin login; se otorga a usuarios de soporte o análisis.
CREATE ROLE mtw_readonly NOLOGIN;

-- DB del backend: DDL sólo con mtw_migrator; mtw_app sólo DML.
ALTER DATABASE mtw_wallet OWNER TO mtw_migrator;
REVOKE ALL ON DATABASE mtw_wallet FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE mtw_wallet TO mtw_app;
GRANT CONNECT ON DATABASE mtw_wallet TO mtw_readonly;

-- DBs propias de los shards del signer de desarrollo (una DB lógica por shard [B-SIG-03], separadas del backend):
-- dev-1 (claves S) y platform (cuenta gas tank).
CREATE DATABASE mtw_signer_dev OWNER mtw_signer;
REVOKE ALL ON DATABASE mtw_signer_dev FROM PUBLIC;
CREATE DATABASE mtw_signer_platform_dev OWNER mtw_signer;
REVOKE ALL ON DATABASE mtw_signer_platform_dev FROM PUBLIC;
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname mtw_wallet <<'SQL'
ALTER SCHEMA public OWNER TO mtw_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO mtw_app, mtw_readonly;
-- Las migraciones aplican además la política de acceso explícita por tabla (backend/app/src/db/migrations/grants.ts):
-- estos default privileges no son la fuente de verdad.
ALTER DEFAULT PRIVILEGES FOR ROLE mtw_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mtw_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mtw_migrator IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO mtw_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mtw_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO mtw_readonly;
SQL

for db in mtw_signer_dev mtw_signer_platform_dev; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<'SQL'
ALTER SCHEMA public OWNER TO mtw_signer;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
done
