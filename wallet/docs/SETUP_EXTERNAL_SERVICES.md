# Setup de servicios externos, API keys y secretos — MT Wallet Web

Este documento lista **cada** credencial, API key y secreto que necesita el sistema, para qué sirve, dónde y cómo obtenerla, con qué permisos mínimos, en qué entorno y si es obligatoria. El preflight (`cd wallet && pnpm preflight`, fase P00 del planner) referencia las secciones de este archivo cuando algo falta.

Reglas:

- Los valores van en `wallet/.env` (local, gitignored). En staging/production **nunca** van en archivos: se cargan en AWS Secrets Manager o en el GitHub Environment del pipeline correspondiente.
- Nada se reutiliza entre staging y production (proyectos, claves, servidores, cuentas).
- Las interfaces web de los proveedores cambian con el tiempo: si un menú no coincide exactamente, seguir la documentación oficial enlazada y respetar los permisos mínimos indicados.
- Verificado el 2026-10-16 (ver §3 del planner).

---

## Resumen: qué conseguir y cuándo

| Variable | Proveedor | Local | Staging / Production |
|---|---|---|---|
| [`BASE_RPC_URL`](#base_rpc_url) | Alchemy | **Obligatoria** (P00) | Obligatoria |
| [`BASE_RPC_URL_SECONDARY`](#base_rpc_url_secondary) | QuickNode | Opcional | Obligatoria |
| [`RPC_PRIMARY_URL` / `RPC_SECONDARY_URL`](#rpc_primary_url--rpc_secondary_url) | Alchemy / QuickNode | No (apuntan al fork) | Obligatorias |
| [`SIGNER_RPC_PRIMARY_URL` / `SIGNER_RPC_SECONDARY_URL`](#signer_rpc_primary_url--signer_rpc_secondary_url) | Alchemy / QuickNode | No (fork) | Obligatorias |
| [`WALLET_FRONTEND_RPC_URL` / `RECOVERY_FRONTEND_RPC_URL`](#wallet_frontend_rpc_url--recovery_frontend_rpc_url) | Alchemy | No (fork) | Obligatorias |
| [`WALLETCONNECT_PROJECT_ID`](#walletconnect_project_id) | Reown (WalletConnect) | **Obligatoria** (P00) | Obligatoria (un proyecto por entorno) |
| [`GOOGLE_CLIENT_ID_WALLET`](#google_client_id_wallet) | Google Cloud | **Obligatoria** (P00) | Obligatoria (cliente por entorno) |
| [`GOOGLE_CLIENT_ID_RECOVERY`](#google_client_id_recovery) | Google Cloud | **Obligatoria** (P00) | Obligatoria (cliente por entorno) |
| [`GOOGLE_CLIENT_SECRET_*`](#google_client_secret_wallet--google_client_secret_recovery) | — | **No se usa** | **No se usa** |
| [`EMAIL_PROVIDER_API_KEY` / `EMAIL_FROM`](#email_provider_api_key--email_from) | Postmark | Opcional (local usa Mailpit) | Obligatorias |
| [`ETHERSCAN_API_KEY`](#etherscan_api_key) | Etherscan | No | Obligatoria para desplegar/verificar |
| [`AWS_REGION` / `KMS_KEY_ALIAS_PREFIX` / cuentas y roles](#aws_region--kms_key_alias_prefix--cuentas-aws) | AWS | No | Obligatorias |
| [`AWS_ACCOUNT_ID_*` / `AWS_DEPLOY_ROLE_ARN_*` / secretos de CI](#aws_account_id_--aws_deploy_role_arn_--secretos-de-ci) | AWS + GitHub Environments | No | Obligatorias |
| [`GOVERNANCE_SAFE_ADDRESS` / `POLICY_GUARDIANS`](#governance_safe_address--policy_guardians) | Safe{Wallet} + hardware wallets | No (lo crea el seed) | Obligatorias |
| [`WALLET_DOMAIN` / `RECOVERY_DOMAIN`](#wallet_domain--recovery_domain) | Registrador + Route 53 | No | Obligatorias |
| [Claves de release](#wallet_release_--recovery_release_-claves-de-release) | generadas por el equipo | Generadas por `secrets:local` | Obligatorias (una por app) |
| [Clave de policy](#policy_signing_-clave-de-firma-de-policy) | generada por seguridad | Generada por `secrets:local` | Obligatoria |
| [`ALERT_EMAIL` / `ALERT_SMS_NUMBER`](#alert_email--alert_sms_number) | — | No | Obligatorias |
| [Fondeo del gas tank](#fondeo-del-gas-tank-eth-en-base) | — | No (fork) | Obligatorio |
| [Secretos generados](#secretos-generados-no-provienen-de-terceros) | generados | `pnpm secrets:local` | Generados una vez y guardados en Secrets Manager |
| [Tests opcionales](#tests-opcionales-con-servicios-reales) | Google / Postmark | Opcionales | Opcionales (CI nightly) |

**Para pasar el preflight en local sólo hacen falta cuatro credenciales externas:** `BASE_RPC_URL`, `WALLETCONNECT_PROJECT_ID`, `GOOGLE_CLIENT_ID_WALLET` y `GOOGLE_CLIENT_ID_RECOVERY`. El resto de los valores locales los genera `pnpm secrets:local`.

---

## RPC de Base

### BASE_RPC_URL

| Campo | Valor |
|---|---|
| Para qué sirve | RPC de **Base mainnet con datos archive**. En local/CI lo usa Anvil para forkear en `FORK_BLOCK_NUMBER`; en staging/production es la fuente del primario del backend si no se separan claves (recomendado separarlas, ver abajo). |
| Proveedor | Alchemy |
| URL | https://dashboard.alchemy.com |
| Pasos | 1) Crear cuenta. 2) "Create new app" → cadena **Base** → red **Base Mainnet**. 3) Copiar la URL HTTPS (`https://base-mainnet.g.alchemy.com/v2/<API_KEY>`). 4) Pegarla en `BASE_RPC_URL`. 5) Correr `pnpm preflight`: el check PF-14 confirma que el endpoint sirve estado histórico en el bloque fijado. |
| Permisos mínimos | Una app dedicada a este uso. Para CI, una app separada. Si el plan lo permite, restringir por IP (egress de CI) y desactivar métodos que no se usan. |
| Entorno | local, CI, staging, production (una app distinta por entorno) |
| Obligatoria | Sí |

### BASE_RPC_URL_SECONDARY

| Campo | Valor |
|---|---|
| Para qué sirve | Segundo proveedor independiente para lecturas de quórum y transmisión redundante (ADR-017). |
| Proveedor | QuickNode |
| URL | https://dashboard.quicknode.com |
| Pasos | 1) Crear cuenta. 2) "Create endpoint" → **Base** → **Mainnet**. 3) Copiar la URL HTTPS del endpoint (incluye el token). 4) Pegarla en `BASE_RPC_URL_SECONDARY`. |
| Permisos mínimos | Endpoint dedicado; activar autenticación por token y allowlist de IPs (egress del backend) si está disponible. No requiere archive. |
| Entorno | staging, production (en local es opcional; si se define, el preflight la valida) |
| Obligatoria | Sí en staging/production |

### RPC_PRIMARY_URL / RPC_SECONDARY_URL

| Campo | Valor |
|---|---|
| Para qué sirve | RPC que usa **el backend** (API, worker, watcher, indexer). En local apuntan al fork (`http://127.0.0.1:8545`). |
| Proveedor | Alchemy (primario) y QuickNode (secundario) |
| URL | https://dashboard.alchemy.com · https://dashboard.quicknode.com |
| Pasos | Crear en cada proveedor una app/endpoint llamado `backend-<entorno>` siguiendo los pasos de arriba y cargar las URLs. Poner `RPC_QUORUM_MODE=dual` y `CONFIRMATION_POLICY=tags`. |
| Permisos mínimos | Allowlist de IPs de salida del backend. |
| Entorno | staging, production |
| Obligatoria | Sí en staging/production |

### SIGNER_RPC_PRIMARY_URL / SIGNER_RPC_SECONDARY_URL

| Campo | Valor |
|---|---|
| Para qué sirve | RPC **propio del signer** para re-verificar nonce, roles, whitelist y saldos sin depender del backend (V9 §8). |
| Proveedor | Alchemy y QuickNode, con **apps/endpoints distintos** de los del backend (`signer-<entorno>`). |
| URL | https://dashboard.alchemy.com · https://dashboard.quicknode.com |
| Pasos | 1) En Alchemy crear la app `signer-<entorno>` (Base Mainnet) y copiar su URL a `SIGNER_RPC_PRIMARY_URL`. 2) En QuickNode crear el endpoint `signer-<entorno>` (Base Mainnet) y copiar su URL a `SIGNER_RPC_SECONDARY_URL`. 3) Restringir ambos a las IPs de salida (NAT) de la cuenta AWS del signer. 4) Cargar las URLs sólo en el Secrets Manager de la cuenta del signer (el backend no debe poder leerlas). |
| Permisos mínimos | Allowlist de IPs de salida de la cuenta del signer. |
| Entorno | staging, production |
| Obligatoria | Sí en staging/production |

### WALLET_FRONTEND_RPC_URL / RECOVERY_FRONTEND_RPC_URL

| Campo | Valor |
|---|---|
| Para qué sirve | RPC que usa **cada frontend** para leer la cadena por su cuenta (verificar la Safe, saldos, whitelist y rotaciones) sin confiar en el backend. Son públicas (quedan en el bundle). |
| Proveedor | Alchemy: una app `wallet-frontend-<entorno>` y otra `recovery-frontend-<entorno>`. |
| URL | https://dashboard.alchemy.com |
| Pasos | Crear cada app, copiar la URL y configurar en la app el **allowlist de dominios** (`https://wallet.<WALLET_DOMAIN>` para la primera, `https://recovery.<RECOVERY_DOMAIN>` para la segunda). |
| Permisos mínimos | Allowlist de dominio obligatoria; sólo métodos de lectura más `eth_call`. |
| Entorno | staging, production (en local apuntan al fork) |
| Obligatoria | Sí en staging/production |

---

## WalletConnect

### WALLETCONNECT_PROJECT_ID

| Campo | Valor |
|---|---|
| Para qué sirve | Identificador del proyecto para el conector WalletConnect de la app **Recovery** (R mediante wallet externa por QR). La app Wallet no usa WalletConnect. |
| Proveedor | Reown (ex WalletConnect Cloud) |
| URL | https://dashboard.reown.com (cloud.reown.com redirige ahí) |
| Pasos | 1) Crear cuenta. 2) Crear un proyecto por entorno (`mtw-recovery-local`, `mtw-recovery-staging`, `mtw-recovery-production`). 3) Copiar el **Project ID** (32 caracteres hex). 4) En la configuración del proyecto → **Domain** → "+ Domain": agregar `https://recovery.<RECOVERY_DOMAIN>` (staging/production). localhost está permitido siempre. Los cambios de allowlist tardan ~15 minutos. |
| Permisos mínimos | Allowlist con **sólo** el origin de Recovery del entorno. Una lista vacía permite cualquier origin: no dejarla vacía fuera de local. |
| Entorno | local, staging, production |
| Obligatoria | Sí |

---

## Google Drive (appDataFolder)

Los backups cifrados de U y R se guardan en el `appDataFolder` de Google Drive del usuario, directamente desde cada frontend. **Wallet y Recovery usan proyectos de Google Cloud distintos** (V9 §17: OAuth y appDataFolder separados). El scope `https://www.googleapis.com/auth/drive.appdata` es **no sensible** según Google, por lo que no requiere verificación de seguridad; en producción sí conviene la verificación de marca para mostrar nombre y logo.

### GOOGLE_CLIENT_ID_WALLET

| Campo | Valor |
|---|---|
| Para qué sirve | OAuth client ID con el que la app **Wallet** pide al usuario acceso a su appDataFolder para guardar `U.enc` (cifrado en el navegador). |
| Proveedor | Google Cloud |
| URL | https://console.cloud.google.com |
| Pasos | 1) Crear un proyecto **exclusivo** por entorno: `mtw-wallet-local`, `mtw-wallet-staging`, `mtw-wallet-production`. 2) *APIs & Services → Library* → habilitar **Google Drive API**. 3) *Google Auth Platform* (antes "OAuth consent screen"): **Branding** (nombre de la app, email de soporte), **Audience** = External (en local/staging dejar en modo *Testing* y agregar como *test users* las cuentas que van a probar), **Data Access** → agregar el scope `.../auth/drive.appdata`. 4) *Clients* → *Create client* → tipo **Web application**. 5) *Authorized JavaScript origins*: `http://localhost:5173` (local) o `https://wallet.<WALLET_DOMAIN>`. 6) *Authorized redirect URIs*: `http://localhost:5173/oauth/google/callback` (local) o `https://wallet.<WALLET_DOMAIN>/oauth/google/callback`. 7) Copiar el **Client ID** (`…apps.googleusercontent.com`) a `GOOGLE_CLIENT_ID_WALLET`. No copiar el client secret a ningún lado. 8) Producción: dominio verificado en Search Console, homepage y política de privacidad publicadas, pasar a *In production*. |
| Permisos mínimos | Sólo el scope `drive.appdata`. Ningún otro scope de Drive. |
| Entorno | local, staging, production (cliente y proyecto distintos en cada uno) |
| Obligatoria | Sí |

### GOOGLE_CLIENT_ID_RECOVERY

| Campo | Valor |
|---|---|
| Para qué sirve | Igual que el anterior, para la app **Recovery** (`R.enc`). Debe ser de **otro proyecto** de Google Cloud. |
| Proveedor | Google Cloud |
| URL | https://console.cloud.google.com |
| Pasos | Repetir los pasos de `GOOGLE_CLIENT_ID_WALLET` en proyectos `mtw-recovery-local/staging/production` con origin `http://localhost:5174` / `https://recovery.<RECOVERY_DOMAIN>` y redirect `…/oauth/google/callback`. |
| Permisos mínimos | Sólo `drive.appdata`. |
| Entorno | local, staging, production |
| Obligatoria | Sí |

### GOOGLE_CLIENT_SECRET_WALLET / GOOGLE_CLIENT_SECRET_RECOVERY

**No se usan.** La integración Drive corre íntegramente en el navegador con un cliente OAuth público (authorization code + PKCE sin secret si Google lo acepta, o flujo implícito como alternativa — ADR-012 del planner). Un client secret no puede protegerse dentro de un frontend y usarlo en el backend convertiría al backend en parte del flujo de U. Si Google llegara a exigir un secret para el flujo elegido, se reabre ADR-012 antes de implementar cualquier alternativa.

---

## Email transaccional

### EMAIL_PROVIDER_API_KEY / EMAIL_FROM

| Campo | Valor |
|---|---|
| Para qué sirve | Envío de OTPs, challenges de whitelist (con la dirección exacta, red y expiración), avisos de rotación/recovery, reset de password y alertas de seguridad. |
| Proveedor | Postmark |
| URL | https://account.postmarkapp.com |
| Pasos | 1) Crear cuenta. 2) Crear un **Server** por entorno (`mtw-staging`, `mtw-production`). 3) Usar el stream transaccional por defecto **`outbound`** (`EMAIL_MESSAGE_STREAM=outbound`). 4) En el server → pestaña **API Tokens** → copiar el **Server API Token** a `EMAIL_PROVIDER_API_KEY`. 5) **Sender Signatures / Domains** → agregar el dominio de envío y publicar los registros DNS que indica Postmark: **DKIM** (TXT, obligatorio para verificar el dominio) y **Return-Path** (CNAME `pm-bounces` → `pm.mtasv.net`). 6) `EMAIL_FROM` = una dirección del dominio verificado (p. ej. `no-reply@<WALLET_DOMAIN>`). 7) Solicitar la **aprobación de la cuenta** (Postmark revisa en < 24 h hábiles); hasta entonces sólo se puede enviar a dominios propios verificados. 8) Poner `EMAIL_PROVIDER=postmark`. |
| Permisos mínimos | Usar el **Server** token (no el Account token). Un server por entorno. |
| Entorno | staging, production. En local se usa Mailpit (`EMAIL_PROVIDER=smtp`); el token es opcional para un smoke test real. Para tests de formato sin enviar, Postmark acepta el token especial `POSTMARK_API_TEST`. |
| Obligatoria | Sí en staging/production |

---

## Verificación de contratos

### ETHERSCAN_API_KEY

| Campo | Valor |
|---|---|
| Para qué sirve | Verificar los contratos desplegados en Base con `forge verify-contract` (API V2 de Etherscan, `chainid=8453`). |
| Proveedor | Etherscan |
| URL | https://etherscan.io/myapikey |
| Pasos | 1) Crear cuenta en etherscan.io. 2) *API Dashboard* → crear una API key. 3) Cargarla en `ETHERSCAN_API_KEY` sólo en el entorno de despliegue (máquina del deployer o GitHub Environment). Las keys antiguas de BaseScan **no** sirven para la API V2. |
| Permisos mínimos | Key dedicada al despliegue. El plan gratuito alcanza para verificación y lectura de ABI en Base (el resto de la API de Base es de pago y no se usa). |
| Entorno | staging, production (despliegue) |
| Obligatoria | Sí para P25 |

---

## Infraestructura

### AWS_REGION / KMS_KEY_ALIAS_PREFIX / cuentas AWS

| Campo | Valor |
|---|---|
| Para qué sirve | Despliegue de producción y staging (ADR-022) y claves S en **AWS KMS** (`ECC_SECG_P256K1`, no exportables, una por Safe) para el signer. |
| Proveedor | AWS |
| URL | https://console.aws.amazon.com/organizations/ · https://console.aws.amazon.com/kms/ |
| Pasos | 1) Crear una AWS Organization con cuentas separadas por trust domain y entorno: `backend-<env>`, `signer-<env>`, `wallet-frontend-<env>`. 2) Crear **fuera** de esa organización (cuenta raíz y administradores distintos) la cuenta `recovery-frontend-<env>`. 3) MFA obligatorio en todas las cuentas raíz; sin access keys de largo plazo. 4) Configurar en cada cuenta el proveedor OIDC de GitHub y un rol de despliegue por área y entorno (`AWS_DEPLOY_ROLE_ARN_<AREA>_<ENV>`), con confianza limitada al repositorio, al workflow y al Environment correspondientes. 5) Región: `AWS_REGION=sa-east-1` (decisión del planner, ADR-022; P26 verifica que soporte KMS `ECC_SECG_P256K1`, ECS Fargate, RDS PostgreSQL 18, ElastiCache for Valkey 9 y AMP/AMG; si falta algo se usa `us-east-1`). 6) Las claves KMS, VPCs, bases y demás recursos se crean con OpenTofu en P26; `KMS_KEY_ALIAS_PREFIX` = `alias/mtw/<env>`. |
| Permisos mínimos | El rol del signer sólo puede `kms:Sign` y `kms:GetPublicKey` sobre sus claves; `kms:CreateKey` sólo para el rol de aprovisionamiento del shard; nadie en las cuentas backend/frontend tiene permisos sobre las claves del signer; borrado de claves con ventana de 30 días y aprobación de dos administradores. |
| Entorno | staging, production |
| Obligatoria | Sí (P25–P26) |

### WALLET_DOMAIN / RECOVERY_DOMAIN

| Campo | Valor |
|---|---|
| Para qué sirve | Origins de los frontends (`wallet.<WALLET_DOMAIN>`, `recovery.<RECOVERY_DOMAIN>`) y de sus API hosts (`api.<WALLET_DOMAIN>`, `api.<RECOVERY_DOMAIN>`). |
| Proveedor | Registrador de dominios a elección (con bloqueo de transferencia y 2FA) + Amazon Route 53 para las zonas DNS |
| URL | https://console.aws.amazon.com/route53/ |
| Pasos | 1) Registrar **dos dominios registrables distintos** (uno por app). 2) Crear la hosted zone de cada uno en la cuenta AWS de su frontend. 3) Activar DNSSEC y CAA (sólo Amazon/ACM). 4) Los registros `api.` apuntan al ALB del backend; el resto lo gestiona cada equipo de frontend. |
| Permisos mínimos | Cuentas del registrador distintas por dominio (o al menos usuarios distintos con 2FA), registrar lock activo; en Route 53, sólo el equipo del frontend correspondiente administra su zona; el backend sólo tiene los registros `api.` que necesita. |
| Entorno | staging (subdominios de staging), production |
| Obligatoria | Sí |

### ALERT_EMAIL / ALERT_SMS_NUMBER

| Campo | Valor |
|---|---|
| Para qué sirve | Destinos de las alertas críticas (Amazon SNS ← Alertmanager de Amazon Managed Prometheus). |
| Proveedor | AWS SNS (destinos: casilla y teléfono de guardia) |
| URL | https://console.aws.amazon.com/sns/ |
| Pasos | 1) Definir casilla de guardia (lista de distribución) y teléfono de guardia por entorno. 2) OpenTofu crea los topics y suscripciones en P26. 3) Confirmar la suscripción de email desde la casilla. 4) Disparar la alerta de prueba de P30.T05. |
| Permisos mínimos | Sólo el rol de alertas puede publicar en los topics. |
| Entorno | staging, production |
| Obligatoria | Sí |

### Fondeo del gas tank (ETH en Base)

La cuenta gas tank/relayer (clave en KMS, creada en P26) necesita ETH en Base para desplegar Safes, recargar el ETH operativo de cada S y retransmitir cancelaciones. Fondear con un monto acotado (el tope diario de recargas se fija con `GAS_TANK_DAILY_CAP_WEI`) y monitorear el saldo (alerta en P24). Obligatorio en staging/production.

---

### AWS_ACCOUNT_ID_* / AWS_DEPLOY_ROLE_ARN_* / secretos de CI

| Variable | Para qué sirve | Dónde se obtiene / pasos | Permisos mínimos | Entorno | Obligatoria |
|---|---|---|---|---|---|
| `AWS_ACCOUNT_ID_BACKEND`, `AWS_ACCOUNT_ID_SIGNER`, `AWS_ACCOUNT_ID_WALLET_FE`, `AWS_ACCOUNT_ID_RECOVERY_FE` | Identificar las cuentas de cada trust domain en IaC y CI | Al crear cada cuenta (ver sección de AWS); se cargan como *variables* (no secretos) del GitHub Environment correspondiente | — | staging, production | Sí |
| `AWS_DEPLOY_ROLE_ARN_<AREA>_<ENV>` | Rol que asume cada workflow de deploy vía OIDC (sin access keys) | IAM → Identity providers → `token.actions.githubusercontent.com`; rol con trust policy limitada a `repo:<owner>/<repo>:environment:<env>` y al workflow del área | Sólo los permisos de deploy de su área y entorno | staging, production | Sí |
| `AWS_KMS_TEST_ROLE_ARN_STAGING` | Tests de integración de `KmsSignerProvider` contra KMS real (P11.T06) | Rol en la cuenta del signer de staging con `kms:CreateKey`/`kms:Sign`/`kms:GetPublicKey` sobre claves con tag `purpose=ci-test` | Sólo claves de test; nunca claves de usuarios | CI (staging) | Sí (desde P11) |
| `BASE_RPC_URL` (secreto de CI) | Fork de Base en CI | App Alchemy dedicada a CI (ver `BASE_RPC_URL`) | Restringida a CI | CI | Sí |
| `WALLET_RELEASE_SIGNING_KEY` / `RECOVERY_RELEASE_SIGNING_KEY` (secretos de Environment) | Firma de manifests de release | Ver claves de release | Sólo el workflow de esa app | staging, production | Sí |
| Firma de imágenes | Firma de imágenes de contenedor en CD (P26.T01) | `cosign` keyless con el OIDC de GitHub (no requiere secreto almacenado) | — | staging, production | Sí |

Amazon Managed Grafana se accede con usuarios de IAM Identity Center (SSO); no hay credenciales estáticas que conseguir.

## Gobierno on-chain

### GOVERNANCE_SAFE_ADDRESS / POLICY_GUARDIANS

| Campo | Valor |
|---|---|
| Proveedor | Safe{Wallet} (https://app.safe.global) + hardware wallets de los firmantes |
| Para qué sirve | `GOVERNANCE_SAFE_ADDRESS` es el admin del `PolicyRegistry` (propone permisos con timelock de 24 h y autoriza migraciones excepcionales). `POLICY_GUARDIANS` son direcciones que pueden **cancelar** propuestas pendientes y revocar permisos. |
| Pasos | 1) Comprar hardware wallets (una por firmante). 2) Crear en https://app.safe.global, red **Base**, una Safe multisig (recomendado 2-de-3 o 3-de-5) con esos firmantes. 3) Anotar la dirección en `GOVERNANCE_SAFE_ADDRESS`. 4) Elegir guardianes **independientes** del equipo que opera el backend (hardware wallets propias) y cargarlos en `POLICY_GUARDIANS`. |
| Permisos mínimos | Ningún firmante de la Governance Safe puede ser operador del backend ni custodio de claves de release. |
| Entorno | staging (Safe de staging), production (Safe de producción, distinta) |
| Obligatoria | Sí |

---

## Claves que genera el propio equipo

### WALLET_RELEASE_* / RECOVERY_RELEASE_* (claves de release)

| Campo | Valor |
|---|---|
| Para qué sirve | Firmar el `release-manifest.json` de cada frontend; el integrity monitor verifica las firmas y, ante discrepancia, el signer deja de cooperar (V9 §17). |
| Cómo generarlas | En una máquina offline: `openssl genpkey -algorithm ed25519 -out wallet-release.pem` y `openssl pkey -in wallet-release.pem -pubout -out wallet-release.pub` (repetir con otra persona y otra máquina para Recovery). |
| Dónde van | Privada: secreto del **GitHub Environment** `production`/`staging` del workflow de esa app únicamente. Pública: `wallet/config/release-keys/<app>.pub` y `WALLET_RELEASE_PUBLIC_KEY` / `RECOVERY_RELEASE_PUBLIC_KEY` del monitor. |
| Permisos mínimos | La clave de Wallet nunca es accesible para el pipeline de Recovery ni para el backend, y viceversa. |
| Entorno | staging, production (en local las genera `pnpm secrets:local`) |
| Obligatoria | Sí |

### POLICY_SIGNING_* (clave de firma de policy)

| Campo | Valor |
|---|---|
| Para qué sirve | Firmar los snapshots de policy que aplican backend y signer (límites, operaciones habilitadas, direcciones). |
| Cómo generarla | Equipo de seguridad, offline, Ed25519 (mismos comandos que arriba). |
| Dónde va | Privada: custodia offline del equipo de seguridad (nunca en servidores). Pública: `POLICY_SIGNING_PUBLIC_KEY` del backend y del signer. |
| Permisos mínimos | Sólo el equipo de seguridad (dos personas) puede firmar snapshots; ningún operador del backend tiene acceso a la privada; cada firma queda registrada con versión y hash. |
| Entorno | staging, production (en local la genera `pnpm secrets:local`) |
| Obligatoria | Sí |

---

## Secretos generados (no provienen de terceros)

En **local** los genera `pnpm secrets:local` (se niega a correr si `APP_ENV != local` y nunca sobrescribe valores existentes). En **staging/production** se generan una sola vez por entorno con los comandos indicados, se guardan en AWS Secrets Manager y se inyectan en los servicios; su rotación está en `docs/runbooks/key-rotation.md` (P26).

| Variable | Uso | Generación (staging/production) | Entorno | Obligatoria | Quién puede leerla |
|---|---|---|---|---|---|
| `SESSION_SECRET` | firma de cookies de sesión | `openssl rand -base64 32` | todos | Sí | API |
| `CSRF_SECRET` | HMAC de tokens CSRF | `openssl rand -base64 32` | todos | Sí | API |
| `SESSION_ISSUER_PRIVATE_KEY` | firma de tokens PlatformSession | `openssl genpkey -algorithm ed25519 -outform DER \| base64 -w0` | todos | Sí | API |
| `SESSION_ISSUER_PUBLIC_KEY` | verificación de tokens PlatformSession | `openssl pkey -pubout -outform DER` de la anterior | todos | Sí | API, worker, signer (no es secreta) |
| `OPAQUE_SERVER_SETUP` | secreto de servidor OPAQUE (RFC 9807) | `pnpm --dir backend/app opaque:setup` (desde P10). Rotarlo obliga a re-registrar a todos los usuarios | todos (desde P10) | Sí | API |
| `APP_FIELD_ENCRYPTION_KEY` | cifrado de campos sensibles en DB (secretos TOTP) | `openssl rand -base64 32` | todos | Sí | API |
| `OTP_HMAC_KEY` | hash de códigos OTP | `openssl rand -base64 32` | todos | Sí | API |
| `PASSWORD_PEPPER_V1` | pepper del hash Argon2id de passwords de cuenta | `openssl rand -base64 32` | todos | Sí | API |
| `AUDIT_CHAIN_KEY` | cadena HMAC del audit log | `openssl rand -base64 32` | todos | Sí | API, worker, job `audit:verify` |
| `INTEGRITY_MONITOR_PRIVATE_KEY` | firma de atestaciones de integridad | Ed25519 como `SESSION_ISSUER_*` | todos | Sí | integrity monitor |
| `INTEGRITY_MONITOR_PUBLIC_KEY` | verificación de atestaciones | pública de la anterior | todos | Sí | signer (no es secreta) |
| `MTW_APP_DB_PASSWORD`, `MTW_MIGRATOR_DB_PASSWORD`, `DATABASE_URL`, `DATABASE_MIGRATION_URL` | acceso a la DB del backend (roles `mtw_app`, `mtw_migrator`) | gestionadas por RDS + Secrets Manager | todos | Sí | API/worker (app); job de migraciones (migrator) |
| `MTW_SIGNER_DB_PASSWORD`, `SIGNER_DATABASE_URL` | DB propia del signer | RDS + Secrets Manager en la cuenta del signer | todos | Sí | signer |
| `POSTGRES_PASSWORD` | superusuario del Postgres local | sólo local | local | Sí (local) | compose local |
| `REDIS_PASSWORD`, `REDIS_URL` | acceso a Valkey | AUTH token de ElastiCache en Secrets Manager | todos | Sí | API, worker |
| Certificados mTLS (`MTLS_*`) | backend ↔ signer | CA privada por entorno (AWS Private CA o CA offline con openssl), certificados de corta vida | todos | Sí | worker (cliente), signer (servidor) |
| `GRAFANA_ADMIN_PASSWORD` | Grafana del perfil `observability` local | sólo local (producción usa SSO) | local | Opcional | compose local |
| `DEV_SIGNER_KEYSTORE_PASSPHRASE`, `LOCAL_SEED`, `*_LOCAL` | sólo desarrollo | sólo `pnpm secrets:local`; **prohibidos** en staging/production (el preflight lo verifica) | local | Sí (local) | procesos locales |

---

## Tests opcionales con servicios reales

| Variable | Para qué sirve | Cómo obtenerla | Entorno | Obligatoria |
|---|---|---|---|---|
| `GOOGLE_DRIVE_TEST_CLIENT_ID` / `GOOGLE_DRIVE_TEST_CLIENT_SECRET` / `GOOGLE_DRIVE_TEST_REFRESH_TOKEN` | Probar el cliente Drive contra la API real en CI nightly (Google no permite automatizar su login en E2E). | Proyecto de Google Cloud **de test** separado, cliente OAuth propio para tests, cuenta Google de pruebas; obtener un refresh token con scope `drive.appdata` (p. ej. con OAuth Playground configurado con ese cliente). Este cliente de test nunca lo usa el producto. | CI | Opcional |
| `POSTMARK_TEST_RECIPIENT` | Smoke test real de email desde local/staging | Casilla propia de pruebas | local, staging | Opcional |
