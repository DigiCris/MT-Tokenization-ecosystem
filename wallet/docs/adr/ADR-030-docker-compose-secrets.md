# ADR-030 — Secretos de producción como secrets de Docker Compose

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-030), §0.1 (R-06), §3.5 (Docker Compose secrets), §5.5, §7.3 ([B-DB-ROLES]), §7.10 ([B-SIG-08]), P00.T04, P08.T02, P26.T03, P26.T09; prompt §24, §38; CF-10

## Contexto

El prompt §24 prohíbe commitear secretos y el §38 pide definir la inyección de secretos en producción. R-06 mantiene fuera del repositorio `wallet/.env`, los keystores, los certificados privados y todo lo que esté bajo `wallet/.secrets/`. La producción corre como contenedores Docker en una VPS, sin servicios cloud (ADR-022), y la credencial de desbloqueo del signer debe vivir separada de los keystores (ADR-014).

Hecho verificado (§3.5): los secrets de Docker Compose funcionan sin Swarm: `secrets:` con `file:`, montados en `/run/secrets/<nombre>` sólo en los servicios que los declaran; las imágenes oficiales (por ejemplo, `postgres`) aceptan la convención `*_FILE`.

## Decisión

Secretos de producción como **secrets de Docker Compose** (`file:`), montados en `/run/secrets/<nombre>` sólo en los servicios que los usan; cada servicio lee `<VAR>_FILE`. Los archivos viven en el host, fuera del repositorio, en `/etc/mtw/<entorno>/secrets/` (root, 0400), y los genera `scripts/deploy/init-secrets.sh` al desplegar. Las credenciales de desbloqueo del signer van en un directorio distinto (`/etc/mtw/<entorno>/signer-unlock/`) y sólo se montan en su shard. Nunca van en el repositorio ni en imágenes.

Detalle:

- **Lectura en los servicios** (P08.T02): toda variable secreta acepta también `<VAR>_FILE`, y en staging y producción se exige la forma `_FILE`; la configuración falla si detecta valores de ejemplo o secretos de baja entropía y nunca imprime valores. El mismo patrón se replica, implementado por separado, en `backend/signer` y `backend/integrity-monitor`.
- **Generación** (P26.T09): `init-secrets.sh` genera en el host destino todos los secretos generables —sesión, CSRF, emisor de PlatformSession, OPAQUE server setup, field key, OTP, pepper, audit, claves de atestación del signer y del monitor, CA y certificados mTLS, credencial de desbloqueo de cada shard, passwords de los roles de base de datos y de Valkey— sin tocar el repositorio ni las imágenes y sin sobrescribir lo existente.
- **Montaje por servicio** (§5.5): cada contenedor recibe sólo lo que usa; por ejemplo, `api` monta sesión, CSRF, emisor, OPAQUE, field key, OTP, pepper, audit, DB app, Valkey y certificado mTLS de cliente, mientras que cada `signer-shard-<id>` monta su credencial de desbloqueo (directorio aparte), su clave de atestación, la DB del signer, el certificado mTLS de servidor y su RPC propio. La credencial de desbloqueo llega al signer como `SIGNER_UNLOCK_CREDENTIAL_FILE` = `/run/secrets/signer_unlock` ([B-SIG-08]).
- **Variables no secretas** (P26.T03): `infra/production/.env.production.example` sólo contiene variables no secretas (dominios, URLs públicas, binds, `TRUSTED_PROXY_CIDRS`, digests de imágenes, shards y parámetros) y la lista de archivos de secrets que espera cada servicio (`*_FILE`).
- **Base de datos** ([B-DB-ROLES]): `MTW_APP_DB_PASSWORD`, `MTW_MIGRATOR_DB_PASSWORD` y `MTW_SIGNER_DB_PASSWORD` se entregan como archivos de secrets, y las URLs de conexión se componen con ellas.
- **Local:** `scripts/secrets-local` completa los secretos locales en `wallet/.env` y genera los materiales en `wallet/.secrets/` (gitignored), nunca sobrescribe y se niega a correr si `APP_ENV != local` (P00.T04).

## Alternativas consideradas

- **systemd credentials:** descartado porque los servicios corren en contenedores (§4).
- **Valores de secretos en variables de entorno:** descartado; con archivos de secrets los valores no quedan en variables de entorno ni en `docker inspect` (§4). Sólo en local se acepta que `BASE_RPC_URL` quede visible en `docker inspect` (P00.T02).
- **Servicios externos de gestión de secretos:** descartados; el mecanismo elegido es el estándar del runtime (Docker Compose, también sin Swarm) y no depende de servicios externos (§4, ADR-022).

## Consecuencias

- Los valores secretos no aparecen en variables de entorno, en `docker inspect`, en imágenes ni en el repositorio, y cada servicio ve sólo los secretos que necesita.
- La credencial de desbloqueo del signer queda físicamente separada de los keystores: un acceso a un volumen de keystores no alcanza para descifrarlos.
- Los archivos de secrets viven en el host: quien obtenga root del host puede leerlos, riesgo cubierto por CF-10. Las claves de release y de policy, en cambio, nunca están en el host.
- La custodia y la rotación de los archivos son manuales y se guían por runbook (rotación de claves en P26.T14).

## Verificación

- P00.T04 y P00.SEC — `secrets-local` idempotente, nunca sobrescribe y se niega con `APP_ENV=staging`.
- P08.T02 — tests de configuración: secreto faltante, formato inválido y valor de ejemplo en producción → error.
- P26.T03 — `node scripts/check-env-production.mjs`: cada variable del compose documentada y ninguna secreta.
- P26.T09 — `init-secrets.sh` en el ensayo local (`wallet/.secrets/prod-rehearsal/`), idempotente, y `node scripts/check-compose-secrets.mjs` confirma que ningún secreto llega por `environment:` ni está en una imagen.
- P26.TST, P26.SEC y P26.MAN — secretos sólo por archivos, credenciales de desbloqueo separadas de los keystores y revisión independiente de los permisos de los directorios de secretos.
- P11.SEC — credencial de desbloqueo en un secret separado de los keystores.
- Check de preflight PF-27 — credencial de desbloqueo presente en una ubicación distinta de la de los keystores.
- Trazabilidad: RQ-94.
