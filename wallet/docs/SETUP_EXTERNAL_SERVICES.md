# Setup de servicios externos, API keys y secretos — MT Wallet Web

Este documento lista **cada** dato, credencial y secreto que necesita el sistema y lo clasifica en tres categorías: lo que se obtiene **automáticamente** de fuentes públicas (AUTO-DISCOVERED), lo que se **genera automáticamente** (AUTO-GENERATED) y lo único que requiere **acción del usuario** (USER ACTION REQUIRED). El preflight (`cd wallet && pnpm preflight`, fase P00 del planner) referencia las secciones de este archivo cuando algo falta.

## Reglas

1. **Autodiscovery antes de pedir nada.** El preflight busca cada credencial en las variables de entorno del proceso y en `wallet/.env`, la **valida sin mostrar el valor** (por ejemplo `eth_chainId` contra el RPC, `eth_chainId` contra el RPC de WalletConnect, el endpoint de autorización de Google) y la reutiliza. Sólo lo que no existe o no valida pasa a USER ACTION REQUIRED.
2. **Local:** valores en `wallet/.env` (gitignored; `wallet/.env.example` sólo documenta variables).
3. **Staging y producción** (target futuro: VPS Linux propia, self-hosted): nunca en archivos del repo ni en imágenes Docker. Los secretos son archivos de **secrets de Docker Compose** en el host (`/etc/mtw/<entorno>/secrets/`, root, 0400) que los servicios leen con `<VAR>_FILE`; las credenciales de desbloqueo del signer van en un directorio separado (`/etc/mtw/<entorno>/signer-unlock/`). Los genera `scripts/deploy/init-secrets.sh` **al desplegar** (planner ADR-030). Las variables no secretas de producción se documentan en `infra/production/.env.production.example` (P26).
4. Nada se reutiliza entre staging y producción (proyectos, claves, servidores, cuentas).
5. Las interfaces de los proveedores cambian: si un menú no coincide, seguir la documentación oficial enlazada respetando los permisos mínimos indicados.
6. Verificado el 2026-10-16.

## Estado al 2026-10-16

Búsqueda realizada en las variables de entorno del proceso y en `wallet/.env` (sin mostrar valores): **ninguna** de las credenciales externas existe todavía. Todo lo demás está resuelto automáticamente (ver las tres secciones finales).

---

## AUTO-DISCOVERED

Datos públicos verificados con fuentes oficiales y lecturas on-chain; quedan en el planner (§3) y en `config/chains/base-mainnet.json` (P00.T03.a). No requieren acción.

| Dato | Valor | Fuente |
|---|---|---|
| Red y `CHAIN_ID` | Base mainnet, `8453` | `cast chain-id` |
| `FORK_BLOCK_NUMBER` | `52700000` (finalizado; hash `0x64a292b057c55f118eb550d89bd860a5740598962f50536c719b375f1ca9c473`) | `cast block` |
| Safe | v1.5.0: SafeL2 `0xEdd160fEBBD92E350D4D398fb636302fccd67C7e`, SafeProxyFactory `0x14F2982D601c9458F93bd70B218933A6f8165e7b`, codehash y runtime del proxy en planner §3.2 | safe-deployments + on-chain |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (FiatTokenProxy, implementación `0x2Ce6311ddAE708829bc0784C967b7d77D19FD779`), 6 decimales | Circle + on-chain |
| USDT | `0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2` — **única representación canónica en Base** (Superchain token list; USDT0 sin despliegue en Base), 6 decimales; usada en V1 | Superchain token list, USDT0, Tether + on-chain |
| Uniswap | pool v3 USDC/USDT 0,01 % (fee tier 100) `0xD56da2B74bA826f19015E6B7Dd9Dae1903E85DA1`, UniswapV3Factory `0x33128a8fC17869897dcE68Ed026d694621f6FDfD`, QuoterV2 `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` (y resto en §3.4) | developers.uniswap.org + on-chain |
| Codehash de todos los contratos externos | planner §3.2–§3.4, verificados en el bloque de fork | `cast code` + `cast keccak` |
| Explorer | `https://basescan.org/address/<address>` y `https://basescan.org/token/<address>` | BaseScan |
| Finalidad de Base | `safe` ~1–2 min, `finalized` ~20 min; upgrade Denim (bloques de 200 ms) previsto | docs.base.org |
| Versiones de toolchain | Node 26.x, pnpm 12.14.0, Foundry v1.8.5, Slither 0.11.6, gitleaks 8.30.1, TypeScript 6.0.3 y el resto de §3.6 | registries y releases oficiales |
| Infra self-hosted | PostgreSQL 18.6, Valkey 9.2, pgBackRest 2.59.3, age 1.3.2, Caddy 2.11.7, Prometheus 3.15.0, Alertmanager 0.34.1, Grafana 13.2.4 | Docker Hub y releases oficiales |
| Signer | Clef sin mantenimiento; Web3Signer evaluado (no genera claves); se usa `SelfHostedSoftwareSignerProvider` (ADR-014) | repos oficiales y docs.web3signer |
| Servicios | Reown: projectId en `dashboard.reown.com`; Google: scope `drive.appdata` no sensible; Postmark: header `X-Postmark-Server-Token`, stream `outbound`; Etherscan API V2 con `chainid=8453` | documentación oficial de cada proveedor |

## AUTO-GENERATED

Secretos y claves que se generan criptográficamente: **no son acciones del usuario**. En local los genera `pnpm secrets:local` (se niega si `APP_ENV != local` y nunca sobrescribe valores existentes). En staging/producción los genera `scripts/deploy/init-secrets.sh` en el host al desplegar, como archivos de secrets de Docker Compose (ADR-030). Su rotación está en `docs/runbooks/key-rotation.md` (P26).

| Variable / archivo | Uso | Generador | Entorno | Obligatoria | Quién lo lee |
|---|---|---|---|---|---|
| `SESSION_SECRET` | firma de cookies de sesión | `openssl rand -base64 32` | todos | Sí | api |
| `CSRF_SECRET` | HMAC de tokens CSRF | `openssl rand -base64 32` | todos | Sí | api |
| `SESSION_ISSUER_PRIVATE_KEY` / `SESSION_ISSUER_PUBLIC_KEY` | firma y verificación de tokens PlatformSession | Ed25519 (`node:crypto` / `openssl genpkey -algorithm ed25519`) | todos | Sí | api (privada); api, worker, signer (pública) |
| `OPAQUE_SERVER_SETUP` | secreto de servidor OPAQUE (RFC 9807) | `pnpm --dir backend/app opaque:setup` (desde P10); rotarlo implica re-registro con `KEY_RESTORE` | todos | Sí | api |
| `APP_FIELD_ENCRYPTION_KEY` | cifrado de campos sensibles en DB (secretos TOTP) | `openssl rand -base64 32` | todos | Sí | api |
| `OTP_HMAC_KEY` | hash de códigos OTP | `openssl rand -base64 32` | todos | Sí | api |
| `PASSWORD_PEPPER_V1` | pepper del hash Argon2id de passwords de cuenta | `openssl rand -base64 32` | todos | Sí | api |
| `AUDIT_CHAIN_KEY` | cadena HMAC del audit log | `openssl rand -base64 32` | todos | Sí | api, worker, job `audit:verify` |
| `INTEGRITY_MONITOR_PRIVATE_KEY` / `_PUBLIC_KEY` | atestaciones del integrity monitor | Ed25519 | todos | Sí | integrity-monitor (privada); signer (pública) |
| `SIGNER_ATTESTATION_PRIVATE_KEY` / `_PUBLIC_KEY` | `SignerKeyAttestation` de cada S creada | Ed25519 | todos | Sí | signer (privada); frontends embeben la pública |
| Credencial de desbloqueo de cada shard (`SIGNER_UNLOCK_CREDENTIAL_FILE`) | deriva las contraseñas de los keystores V3 de S | 32 bytes aleatorios; **separada** de los keystores | todos | Sí | sólo el signer de ese shard |
| Keystores de S | una clave por Safe | los crea el propio signer al dar de alta cada wallet (nunca un humano) | todos | Sí | sólo el signer de ese shard |
| Certificados mTLS (`MTLS_*`) | backend ↔ signer | CA privada por entorno con `openssl`, certificados de corta vida | todos | Sí | worker, api, gas-tank (cliente); signer (servidor) |
| `POSTGRES_PASSWORD`, `MTW_APP_DB_PASSWORD`, `MTW_MIGRATOR_DB_PASSWORD`, `MTW_SIGNER_DB_PASSWORD`, `DATABASE_URL`, `DATABASE_MIGRATION_URL`, `SIGNER_DATABASE_URL` | acceso a las bases (roles separados) | `openssl rand -base64 24` + composición de URLs | todos | Sí | cada servicio, sólo su rol |
| `REDIS_PASSWORD`, `REDIS_URL` | acceso a Valkey (usuario ACL de la cola) | `openssl rand -base64 24` | todos | Sí | api, worker |
| Claves de release (`WALLET_RELEASE_*`, `RECOVERY_RELEASE_*`) | firma de manifests de cada frontend | Ed25519, una por app; en staging/prod se cargan sólo en el GitHub Environment de esa app (`gh secret set`) | todos | Sí | sólo el workflow de esa app; públicas en `config/release-keys/` |
| Clave de policy (`POLICY_SIGNING_*`) | firma de snapshots de policy | Ed25519; en staging/prod se genera en una máquina offline y la privada nunca está en servidores | todos | Sí | backend y signer (pública) |
| Par de claves de backup (`age`) | cifrado de backups off-host | `age-keygen`; la pública queda en la config del host, la privada en custodia offline | staging/prod | Sí | scripts de backup (pública) |
| `LOCAL_SEED`, credencial y keystores del shard `dev-1`, `*_LOCAL`, `GRAFANA_ADMIN_PASSWORD` | sólo desarrollo local | `pnpm secrets:local` | local | Sí (local) | procesos locales |

---

## USER ACTION REQUIRED

Sólo lo que no se puede conseguir ni generar automáticamente. Antes de pedir cualquier ítem, el preflight lo busca y lo valida sin mostrarlo; si ya existe, se reutiliza.

| Ítem | Proveedor | Local (P00) | Staging / Producción | Estado 2026-10-16 |
|---|---|---|---|---|
| [`BASE_RPC_URL`](#base_rpc_url) | Alchemy | **Obligatoria** | Obligatoria | no existe |
| [`WALLETCONNECT_PROJECT_ID`](#walletconnect_project_id) | Reown | **Obligatoria** | Obligatoria (un proyecto por entorno) | no existe |
| [`GOOGLE_CLIENT_ID_WALLET`](#google_client_id_wallet) | Google Cloud | **Obligatoria** | Obligatoria (cliente por entorno) | no existe |
| [`GOOGLE_CLIENT_ID_RECOVERY`](#google_client_id_recovery) | Google Cloud | **Obligatoria** | Obligatoria (cliente por entorno) | no existe |
| [`BASE_RPC_URL_SECONDARY`](#base_rpc_url_secondary) | QuickNode | Opcional | Obligatoria | no existe |
| [RPC por componente](#rpc_primary_url--rpc_secondary_url) | Alchemy / QuickNode | No (fork) | Obligatorias | no existen |
| [`EMAIL_PROVIDER_API_KEY` / `EMAIL_FROM`](#email_provider_api_key--email_from) | Postmark | Opcional (local usa Mailpit) | Obligatorias | no existe |
| [`ETHERSCAN_API_KEY`](#etherscan_api_key) | Etherscan | No | Obligatoria para verificar contratos | no existe |
| [Dominios de producción](#wallet_domain--recovery_domain) | registrador a elección | No | Obligatorios al desplegar | pendiente |
| [Governance Safe y guardianes](#governance_safe_address--policy_guardians) | Safe{Wallet} + hardware wallets | No (lo crea el seed) | Obligatorios | pendiente |
| [`ALERT_EMAIL`](#alert_email--alert_webhook_url) | casilla propia | No (Mailpit) | Obligatoria | pendiente |
| [Fondeo de ETH](#fondeo-de-eth-gas-tank) | — | No (fork) | Obligatorio | pendiente |
| [Aprobaciones en Base mainnet](#aprobaciones-en-base-mainnet) | owner | No | Obligatorias | pendiente |
| [Custodia offline y copia off-host](#custodia-offline-y-copia-off-host) | owner / equipo | No | Obligatorias al desplegar | pendiente |

Condicionales (sólo si el preflight detecta que hacen falta): [Docker](#docker-sólo-si-falta), [branch protection](#branch-protection-sólo-si-gh-no-tiene-permisos), [tests opcionales](#tests-opcionales-con-servicios-reales).

### BASE_RPC_URL

| Campo | Valor |
|---|---|
| Para qué sirve | RPC de **Base mainnet con datos archive**: Anvil forkea desde aquí en `FORK_BLOCK_NUMBER` (local y CI). |
| Proveedor | Alchemy |
| URL | https://dashboard.alchemy.com |
| Pasos | 1) Crear cuenta. 2) "Create new app" → cadena **Base** → red **Base Mainnet**. 3) Copiar la URL HTTPS (`https://base-mainnet.g.alchemy.com/v2/<API_KEY>`). 4) Pegarla en `BASE_RPC_URL` de `wallet/.env`. 5) `pnpm preflight`: PF-13/PF-14 validan cadena y estado histórico sin mostrar la clave. |
| Permisos mínimos | App dedicada a este uso (y otra para CI). |
| Entorno | local, CI (y staging/prod como upstream, con apps separadas) |
| Obligatoria | Sí |

### BASE_RPC_URL_SECONDARY

| Campo | Valor |
|---|---|
| Para qué sirve | Segundo proveedor independiente para lecturas de quórum y transmisión redundante (ADR-017). |
| Proveedor | QuickNode |
| URL | https://dashboard.quicknode.com |
| Pasos | 1) Crear cuenta. 2) "Create endpoint" → **Base** → **Mainnet**. 3) Copiar la URL HTTPS (incluye el token). 4) Cargarla en `BASE_RPC_URL_SECONDARY`. |
| Permisos mínimos | Endpoint dedicado con autenticación por token y allowlist de IPs del servidor si el plan lo permite. No requiere archive. |
| Entorno | staging, production (opcional en local) |
| Obligatoria | Sí en staging/production |

### RPC_PRIMARY_URL / RPC_SECONDARY_URL

| Campo | Valor |
|---|---|
| Para qué sirve | RPC propios de cada componente en staging/producción: backend (`RPC_PRIMARY_URL`/`RPC_SECONDARY_URL`), signer (`SIGNER_RPC_PRIMARY_URL`/`SIGNER_RPC_SECONDARY_URL`, para re-verificar sin depender del backend) y cada frontend (`WALLET_FRONTEND_RPC_URL`, `RECOVERY_FRONTEND_RPC_URL`, públicas). En local apuntan al fork. |
| Proveedor | Alchemy (primarios y frontends) y QuickNode (secundarios) |
| URL | https://dashboard.alchemy.com · https://dashboard.quicknode.com |
| Pasos | Crear en cada proveedor una app/endpoint por componente y entorno (`backend-<env>`, `signer-<env>`, `wallet-frontend-<env>`, `recovery-frontend-<env>`) y copiar cada URL. En las apps de frontend configurar el **allowlist de dominio** (`https://wallet.<WALLET_DOMAIN>`, `https://recovery.<RECOVERY_DOMAIN>`). Los valores de backend y signer van como archivos de secrets en el host al desplegar. |
| Permisos mínimos | Una clave por componente; allowlist de IP del servidor para backend/signer y de dominio para frontends. |
| Entorno | staging, production |
| Obligatoria | Sí en staging/production |

### WALLETCONNECT_PROJECT_ID

| Campo | Valor |
|---|---|
| Para qué sirve | Conector WalletConnect de la app **Recovery** (R mediante wallet externa por QR). Wallet no lo usa. |
| Proveedor | Reown (ex WalletConnect Cloud) |
| URL | https://dashboard.reown.com |
| Pasos | 1) Crear cuenta. 2) Crear un proyecto por entorno (`mtw-recovery-local`, `-staging`, `-production`). 3) Copiar el **Project ID** (32 hex) a `WALLETCONNECT_PROJECT_ID`. 4) En la configuración del proyecto → **Domain** → "+ Domain": `https://recovery.<RECOVERY_DOMAIN>` (staging/producción; localhost siempre está permitido; los cambios tardan ~15 min). 5) PF-19 lo valida con `eth_chainId` contra `https://rpc.walletconnect.org/v1/?chainId=eip155:8453&projectId=<ID>` (un ID inválido responde 401). |
| Permisos mínimos | Allowlist con sólo el origin de Recovery del entorno (no dejarla vacía fuera de local). |
| Entorno | local, staging, production |
| Obligatoria | Sí |

### GOOGLE_CLIENT_ID_WALLET

| Campo | Valor |
|---|---|
| Para qué sirve | OAuth client ID con el que la app **Wallet** guarda `U.enc` (cifrado en el navegador) en el appDataFolder del usuario. |
| Proveedor | Google Cloud |
| URL | https://console.cloud.google.com |
| Pasos | 1) Crear un proyecto **exclusivo** por entorno: `mtw-wallet-local`, `-staging`, `-production`. 2) *APIs & Services → Library* → habilitar **Google Drive API**. 3) *Google Auth Platform* (antes "OAuth consent screen"): **Branding**, **Audience** = External (en local/staging modo *Testing* con *test users*), **Data Access** → scope `.../auth/drive.appdata`. 4) *Clients* → *Create client* → **Web application**. 5) *Authorized JavaScript origins*: `http://localhost:5173` (local) o `https://wallet.<WALLET_DOMAIN>`. 6) *Authorized redirect URIs*: `http://localhost:5173/oauth/google/callback` o `https://wallet.<WALLET_DOMAIN>/oauth/google/callback`. 7) Copiar el **Client ID** a `GOOGLE_CLIENT_ID_WALLET` (no copiar el client secret a ningún lado). 8) Producción: dominio verificado, homepage y política de privacidad publicadas, pasar a *In production*. |
| Permisos mínimos | Sólo el scope `drive.appdata` (no sensible). |
| Entorno | local, staging, production (cliente y proyecto distintos en cada uno) |
| Obligatoria | Sí |

### GOOGLE_CLIENT_ID_RECOVERY

| Campo | Valor |
|---|---|
| Para qué sirve | Igual que el anterior para la app **Recovery** (`R.enc`), en **otro proyecto** de Google Cloud. |
| Proveedor | Google Cloud |
| URL | https://console.cloud.google.com |
| Pasos | Repetir los pasos de `GOOGLE_CLIENT_ID_WALLET` en proyectos `mtw-recovery-local/-staging/-production` con origin `http://localhost:5174` o `https://recovery.<RECOVERY_DOMAIN>` y redirect `…/oauth/google/callback`. |
| Permisos mínimos | Sólo `drive.appdata`. |
| Entorno | local, staging, production |
| Obligatoria | Sí |

Nota: `GOOGLE_CLIENT_SECRET_WALLET` y `GOOGLE_CLIENT_SECRET_RECOVERY` **no se usan** — la integración Drive corre íntegramente en el navegador con un cliente OAuth público (ADR-012); no hay que conseguirlos.

### EMAIL_PROVIDER_API_KEY / EMAIL_FROM

| Campo | Valor |
|---|---|
| Para qué sirve | Envío de OTPs, challenges de whitelist (con la dirección exacta, red y expiración), avisos de rotación/recovery, reset de password y alertas. |
| Proveedor | Postmark |
| URL | https://account.postmarkapp.com |
| Pasos | 1) Crear cuenta. 2) Crear un **Server** por entorno (`mtw-staging`, `mtw-production`). 3) Usar el stream transaccional **`outbound`**. 4) Pestaña **API Tokens** del server → copiar el **Server API Token**. 5) **Sender Signatures / Domains** → agregar el dominio de envío y publicar sus registros DNS (DKIM TXT y Return-Path CNAME `pm-bounces` → `pm.mtasv.net`) cuando existan los dominios. 6) `EMAIL_FROM` = una dirección de ese dominio. 7) Solicitar la aprobación de la cuenta (< 24 h hábiles). En staging/prod el token va como archivo de secrets al desplegar. |
| Permisos mínimos | Server token (no el Account token), un server por entorno. |
| Entorno | staging, production (en local se usa Mailpit; `POSTMARK_API_TEST` sirve para tests de formato sin envío) |
| Obligatoria | Sí en staging/production |

### ETHERSCAN_API_KEY

| Campo | Valor |
|---|---|
| Para qué sirve | Verificar los contratos desplegados en Base con `forge verify-contract` (API V2, `chainid=8453`). |
| Proveedor | Etherscan |
| URL | https://etherscan.io/myapikey |
| Pasos | 1) Crear cuenta. 2) *API Dashboard* → crear una API key. 3) Cargarla sólo donde se despliega (máquina del deployer o GitHub Environment). Las keys antiguas de BaseScan no sirven para la API V2. |
| Permisos mínimos | Key dedicada al despliegue; el plan gratuito alcanza para verificación. |
| Entorno | staging, production |
| Obligatoria | Sí para P25/P30 |

### WALLET_DOMAIN / RECOVERY_DOMAIN

| Campo | Valor |
|---|---|
| Para qué sirve | Origins de los frontends (`wallet.<WALLET_DOMAIN>`, `recovery.<RECOVERY_DOMAIN>`) y de sus API hosts (`api.<…>`), que se configuran en el reverse proxy existente al desplegar. |
| Proveedor | Registrador de dominios a elección (con bloqueo de transferencia y 2FA) |
| URL | panel del registrador elegido |
| Pasos | Registrar **dos dominios registrables distintos** (uno por app) cuando llegue el momento de desplegar; los registros y el TLS se configuran a mano en esa etapa siguiendo `docs/DEPLOYMENT_VPS.md`. |
| Permisos mínimos | 2FA en el registrador; acceso al DNS limitado a quien despliega. |
| Entorno | staging (subdominios de staging), production |
| Obligatoria | Sí al desplegar (no bloquea el desarrollo) |

### GOVERNANCE_SAFE_ADDRESS / POLICY_GUARDIANS

| Campo | Valor |
|---|---|
| Para qué sirve | `GOVERNANCE_SAFE_ADDRESS` administra el `PolicyRegistry` (propone permisos con timelock de 24 h y autoriza migraciones excepcionales); `POLICY_GUARDIANS` pueden cancelar propuestas pendientes y revocar permisos. |
| Proveedor | Safe{Wallet} (https://app.safe.global) + hardware wallets de los firmantes |
| URL | https://app.safe.global |
| Pasos | 1) Conseguir hardware wallets (una por firmante). 2) Crear en red **Base** una Safe multisig (2-de-3 o 3-de-5) con esos firmantes. 3) Registrar la dirección. 4) Elegir guardianes independientes del equipo que opera el backend y registrar sus direcciones. |
| Permisos mínimos | Ningún firmante es operador del backend ni custodio de claves de release. |
| Entorno | staging (Safe propia), production (Safe distinta) |
| Obligatoria | Sí |

### ALERT_EMAIL / ALERT_WEBHOOK_URL

| Campo | Valor |
|---|---|
| Para qué sirve | Destino de las alertas de Alertmanager (self-hosted); el webhook es opcional. |
| Proveedor | casilla de guardia propia (lista de distribución); webhook opcional (p. ej. del canal de chat del equipo) |
| URL | — |
| Pasos | Definir la casilla de guardia por entorno; el envío usa el SMTP de Postmark. |
| Permisos mínimos | Casilla con acceso del equipo de guardia. |
| Entorno | staging, production |
| Obligatoria | `ALERT_EMAIL` sí; webhook opcional |

### Fondeo de ETH (gas tank)

La cuenta gas tank/relayer (clave en un keystore del shard `platform`, generada por el signer) necesita ETH en Base para desplegar Safes, recargar el ETH operativo de cada S y retransmitir cancelaciones. Hay que fondearla con un monto acotado (el tope diario de recargas es `GAS_TANK_DAILY_CAP_WEI`). Obligatorio en staging y producción.

### Aprobaciones en Base mainnet

Toda acción que despliegue contratos o mueva fondos reales en Base mainnet (staging en P25.T06, producción en P30.T02) requiere la **aprobación explícita y escrita del owner**, registrada en el Registro de ejecución del planner.

### Custodia offline y copia off-host

Al desplegar: definir quiénes custodian (dos personas distintas) las copias selladas de las credenciales de desbloqueo de cada shard del signer y la clave privada de backup (`age`), y elegir el destino de la copia off-host cifrada de los backups (ADR-031). No bloquea el desarrollo.

### Docker (sólo si falta)

Docker Engine con Compose v2 es la única dependencia de sistema que el preflight no puede instalar sin privilegios (PF-05). Si falta, instalarlo con la guía oficial de Docker para la distribución usada.

### Branch protection (sólo si `gh` no tiene permisos)

El planner aplica la protección de la rama principal con `gh api` (P02.T04). Sólo si las credenciales de `gh` del entorno no tienen permisos de administrador del repositorio, esa configuración puntual la hace el owner en GitHub (required checks, revisión de CODEOWNERS, "include administrators", commits firmados).

### Tests opcionales con servicios reales

| Variable | Para qué sirve | Cómo obtenerla | Entorno | Obligatoria |
|---|---|---|---|---|
| `GOOGLE_DRIVE_TEST_CLIENT_ID` / `GOOGLE_DRIVE_TEST_CLIENT_SECRET` / `GOOGLE_DRIVE_TEST_REFRESH_TOKEN` | Probar el cliente Drive contra la API real en CI nightly (Google no permite automatizar su login en E2E). | Proyecto de Google Cloud **de test** separado, cliente OAuth propio para tests y cuenta Google de pruebas; refresh token con scope `drive.appdata`. El producto nunca usa este cliente. | CI | Opcional |
| `POSTMARK_TEST_RECIPIENT` | Smoke test real de email | Casilla propia de pruebas | local, staging | Opcional |
