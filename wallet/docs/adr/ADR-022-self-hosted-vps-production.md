# ADR-022 — Producción self-hosted en una VPS Linux

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-022), §0.1 (R-09, R-14), §1, §2.2, §5.5, §9.3, §13 (entradas del 2026-10-16 y 2026-10-17), §13.1 (H-02 a H-06), P26, P30; V9 §2, §17; prompt §38; CF-07, CF-10

## Contexto

El owner decidió el 2026-10-16 que la producción corra en una VPS Linux propia (target: Hostinger), self-hosted, sin AWS, GCP ni Azure (§1, §13). El prompt §38 exige que el planner cierre con una fase de PRODUCTION READINESS: Dockerfiles, layout de despliegue, reverse proxy, TLS, migraciones, persistencia de la cola, backups y restore test, inyección de secretos, DNS, headers de seguridad, monitoreo, retención de logs, rotación de claves, rollback e incidentes.

V9 §2 y §17 exigen trust domains administrativamente independientes y hosting/DNS separado entre Wallet y Recovery. El backend y el signer comparten un único host (CF-10); por decisión del owner (2026-10-17) cada frontend se sirve desde un servidor propio, distinto del de la otra app y del backend (CF-07), y la separación de DNS queda en CF-11.

R-09 y R-14 (2026-10-17) precisan el alcance: ninguna fase despliega en Base mainnet ni accede a la VPS; staging y producción se despliegan y prueban completos sobre el fork de Anvil (P25 y P30), y el despliegue real —contratos en Base mainnet, servicios en la VPS, reverse proxy, DNS y TLS— es el despliegue final, manual, fuera del planner y con aprobación escrita del owner, siguiendo `docs/runbooks/go-live.md` y `docs/DEPLOYMENT_VPS.md`.

## Decisión

Producción **self-hosted**, **sin dependencia de ningún cloud**, en tres servidores:

1. **Host del backend:** VPS Linux estándar (target: Hostinger) con `infra/production/docker-compose.production.yml` (api, worker, watcher, indexer, gas-tank, integrity-monitor, signer shards, `postgres` del backend, `signer-postgres`, `valkey` y perfil opcional de observabilidad), con redes Docker separadas por dominio (`edge`, `backend` y `signer`, estas dos con `internal: true`) y sin puertos publicados salvo el bind configurable de la API hacia el **reverse proxy existente** del host.
2. **Servidor de Wallet** y 3. **servidor de Recovery** (decisión del owner del 2026-10-17): distintos entre sí y del backend; cada uno corre sólo su contenedor estático (`docker-compose.wallet-web.yml`, `docker-compose.recovery-web.yml`) detrás de su propio reverse proxy.

Los reverse proxies se configuran a mano al desplegar (el producto no incluye ni hardcodea Nginx). Las imágenes se construyen en CI, se publican en GHCR por digest y se firman. El despliegue es manual, fuera de este planner, siguiendo `docs/DEPLOYMENT_VPS.md` (P26).

Detalle:

- **Topología** (§5.5): en el servidor de cada frontend, `wallet-web` o `recovery-web` (Caddy sirviendo el bundle estático con sus headers, imagen inmutable por app). En el host del backend: `api` (listeners Wallet y Recovery) en `edge`, `backend` y `signer`; `worker`, `watcher`, `indexer` y `gas-tank` en `backend` y `signer`; `integrity-monitor` en `backend` con salida a internet; un `signer-shard-<id>` por shard en `signer` (`internal: true`) con volumen `signer-<id>-keystore`; `postgres` y `valkey` en `backend` (`internal: true`); `signer-postgres` en `signer` (`internal: true`).
- **Reglas de red:** puertos internos fijos (API 8080/8081, estáticos 8080); cada servidor sólo publica su servicio (la API en el host del backend, el contenedor estático en el de cada frontend), con binds en su `.env.production` (`*_BIND`, sin defaults de producción en el código); TLS termina en el reverse proxy de cada servidor y la API sólo confía en `X-Forwarded-*` desde `TRUSTED_PROXY_CIDRS` (§5.5).
- **Hardening de contenedores** (P26.T01, P26.T02): Dockerfiles multi-stage con imagen base fijada por digest, usuario no-root con UID fijo por servicio, filesystem de sólo lectura y healthcheck; en el compose, `restart: unless-stopped`, límites de recursos, `read_only`, `security_opt: [no-new-privileges:true]`, `cap_drop: [ALL]`, logging `local` con rotación, secrets por servicio (ADR-030) e imágenes por digest.
- **Artefactos de release** (P26.T02.a): build reproducible de imágenes, SBOM (syft), escaneo Trivy, firma con `cosign` keyless (OIDC de GitHub, sin secretos guardados), push a GHCR por digest y `release/images.lock`; sólo se publica desde commits con todos los required checks en verde y ningún job despliega a la VPS.
- **Ensayos dentro del planner:** los tres compose de producción se levantan en la máquina de desarrollo con secretos de ensayo y RPC apuntando al fork (P26.T16.b), y producción completa se despliega y prueba sobre el fork en P30.T04 y P30.T05.
- **Separación lógica de trust domains** en el host del backend: contenedores, redes Docker, UIDs y volúmenes por dominio, secretos por servicio, signer sin puertos publicados, y claves de release y de policy **fuera** del host (CF-10); los frontends quedan en servidores propios.

## Alternativas consideradas

- **Diseño previo en AWS:** descartado por decisión del owner (producción en VPS propia, sin AWS/GCP/Azure) (§4).
- **Incluir Nginx, TLS o configuración de DNS en el producto:** descartado; se usa el reverse proxy existente, configurado a mano al desplegar, con un contrato documentado (P26.T04).
- **Desplegar a la VPS desde CI:** descartado; ningún workflow despliega y el despliegue es manual (P26.T02.a, R-09).

## Consecuencias

- El producto no depende de ningún proveedor cloud y cualquier VPS Linux estándar con Docker puede alojarlo.
- Las imágenes firmadas y fijadas por digest permiten verificar lo que se despliega (`deploy.sh` verifica firmas `cosign` y digests de `images.lock`) y volver atrás al `images.lock` anterior (P26.T15).
- Riesgo residual del host del backend (CF-10): el root del host obtiene las S de todos sus shards, los secretos de Compose y la API, pero no el JS de los origins de U y R, que se sirve desde servidores propios; S sigue necesitando la firma de U o R. Controles compensatorios: monitor de integridad off-host en GitHub Actions con alertas, manifests firmados fuera de los hosts, kill-switch y playbook específico (P26.T16). El compromiso del servidor de un frontend alcanza sólo el origin de esa app (U o R); ambas sólo si los dos frontends comparten cuenta o proveedor de hosting (RR-16, CF-11). No bloquea V1.
- La operación queda a cargo del equipo: backups (ADR-031), monitoreo self-hosted con Prometheus, Alertmanager y Grafana (P26.T12), retención de logs (P26.T13) y rotación de claves (P26.T14).
- Fuera del planner quedan los pasos del despliegue final: dominios, servicios para los dominios reales, claves reales de Base mainnet, aprobación escrita y ETH real, y en los tres servidores (VPS del backend y servidores de Wallet y de Recovery, con cuentas de hosting y de DNS distintas o la aceptación escrita de CF-11) el DNS, el reverse proxy, TLS, la custodia offline de credenciales del signer y el destino off-host de los backups (H-02 a H-06).

## Verificación

- P26.T01 — Dockerfiles construidos y verificados (`node scripts/check-dockerfiles.mjs`: no-root, base por digest, healthcheck).
- P26.T02 — `docker-compose.production.yml`, `docker-compose.wallet-web.yml` y `docker-compose.recovery-web.yml` válidos y endurecidos (`node scripts/check-compose-hardening.mjs`: sin secretos en `environment:`, signer sin `ports:`, redes internas correctas).
- P26.T02.a — workflow de artefactos de release con `images.lock`, SBOMs y firmas verificables con `cosign verify`; un commit con CI en rojo no publica.
- P26.T03 — `.env.production.example` sólo con variables no secretas.
- P26.T04 y P26.T10 — contrato con el reverse proxy y requisitos de DNS y TLS documentados.
- P26.T06 — PostgreSQL y Valkey self-hosted con usuarios separados.
- P26.T11 — headers de seguridad en el ensayo local de producción.
- P26.T15 y P26.T16 — rollback por digest y procedimientos de incidente (kill-switch y host comprometido) ensayados.
- P26.T16.a y P26.T16.b — scripts de despliegue para uso manual posterior y ensayo local del layout de producción.
- P26.T17.h y P26.T17.j — gates del ensayo local y de los riesgos residuales del host del backend (CF-10) y de la separación de hosting y DNS de los frontends (CF-11).
- P26.SEC y P26.MAN — Trivy sin High/Critical, contenedores no-root y de sólo lectura; revisión independiente de `DEPLOYMENT_VPS.md` y de la separación de redes.
- P30.T04 y P30.T06 — ensayo de producción completo sobre el fork y `go-live.md` con el despliegue final paso a paso.
- P27.T02.k — auditoría del compromiso del root del host del backend y del servidor de un frontend.
- Trazabilidad: RQ-68, RQ-92, RQ-93.
