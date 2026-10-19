# Runbook: mismatch de integridad de un frontend

Procedimiento de P20 para cuando lo que sirve el origin de Wallet o de Recovery no es el release firmado (V9 §17: "una
discrepancia pausa la cooperación de S"). Lo prueban `backend/integrity-monitor/test/` (chequeo, pausa en ≤ 2 ciclos,
reanudación con doble aprobación), `backend/signer/test/policy/integrity.test.ts` (pausa del signer) y el simulacro de
P20.MAN con el stack completo (registrado en §13 del planner).

## Piezas

- **Integrity monitor** (`backend/integrity-monitor`, contenedor propio con clave de atestación propia): cada 60 s
  descarga `/.well-known/release-manifest.json` y su `.sig` de cada app, verifica la firma con la clave pública de release
  fijada (`config/release-keys/`), cada archivo por SHA-256, que `/` sirva el `index.html` del manifest, el SRI y los
  recursos del documento, los headers de seguridad por ruta y el 403 a los scripts de service worker. Emite una
  `IntegrityAttestation` firmada por app (vence a los 5 min) en `GET /v1/attestations`.
- **Signer**: con `INTEGRITY_REQUIRED=true` (staging y producción) no co-firma sin atestaciones vigentes de las dos apps.
  `MISMATCH` → `COOPERATION_PAUSED` en el acto; `UNREACHABLE` → alerta y 15 min de gracia desde el último OK; sin
  atestación vigente (monitor caído) → pausa (fail-closed). El camino soberano (U + R) no pasa por el signer y no se
  afecta.
- **Backend**: adjunta las atestaciones a cada pedido de co-firma, registra `integrity_status`, audita
  `INTEGRITY_MISMATCH` / `COOPERATION_PAUSED` / `COOPERATION_RESUMED`, expone el estado en `GET /v1/platform/status` y
  la app Wallet muestra el banner de pausa.
- **Chequeo off-host** (`.github/workflows/wallet-integrity-offhost.yml`, cada 15 min): las mismas verificaciones contra
  las URLs públicas desde GitHub, con las públicas del repositorio; alerta por email y webhook. No depende del host de
  producción ni pausa al signer: si el host se compromete, la alerta igual sale.

## Síntomas

- Alerta crítica `mtw_integrity_status{app} == 2` (MISMATCH) o `mtw_integrity_paused{app} == 1`; email del chequeo
  off-host con el asunto `[MT Wallet] Integridad: <APP> MISMATCH`.
- Las operaciones asistidas fallan con `COOPERATION_PAUSED`; la app Wallet muestra "La plataforma pausó la co-firma".
- Eventos de auditoría `INTEGRITY_MISMATCH` y `COOPERATION_PAUSED`.

## 1. Contener (minutos)

1. **No reanudar** hasta entender la causa. La pausa es pegajosa: aunque el archivo vuelva a su estado, el monitor
   sigue atestando `MISMATCH` hasta la doble aprobación del paso 4, también después de un reinicio (estado persistido).
2. Ver qué difiere: `curl -s http://integrity-monitor:8092/v1/status` (red interna) → `pauseProblems` lista cada
   archivo, header o elemento distinto del release firmado.
3. Asumir JS malicioso en **ese** origin: avisar a los usuarios que no desbloqueen la clave de esa app (Wallet: U y
   Password U; Recovery: R y Password R) hasta nuevo aviso. Si el compromiso alcanza al host del backend, seguir
   además el playbook de host comprometido de `incident-response.md` (P26.T16).
4. Preservar evidencia antes de tocar el servidor: copia de los archivos servidos (`wget --mirror` del origin), logs del
   reverse proxy y del contenedor estático, `docker inspect` de la imagen corriendo.

## 2. Diagnóstico

- ¿El digest de la imagen del contenedor estático es el de `release/images.lock`? Si no, alguien desplegó otra cosa.
- ¿El manifest servido verifica con la clave fijada? `pnpm --dir frontend/<app> verify:manifest --dist <copia>`.
- ¿Un header cambió? Suele ser el reverse proxy reescribiendo headers (contrato de `DEPLOYMENT_VPS.md`): corregir la
  configuración del proxy, no el release.
- ¿El release es legítimo pero nuevo y se desplegó sin publicar su manifest firmado? Es un error de despliegue: volver
  al release anterior (paso 3) y desplegar el nuevo con su manifest firmado.

## 3. Restablecer el release firmado

Volver a desplegar el contenedor estático desde el artefacto firmado (`scripts/deploy/deploy.sh`, verifica la firma
`cosign` y el digest de `images.lock`; `rollback.md` para volver al anterior). Confirmar con el chequeo de una pasada:

```bash
MONITOR_TARGETS=WALLET=https://<wallet>,RECOVERY=https://<recovery> APP_ENV=production \
WALLET_RELEASE_PUBLIC_KEY="$(base64 -w0 < <(openssl pkey -pubin -in config/release-keys/wallet.pub -outform DER))" \
RECOVERY_RELEASE_PUBLIC_KEY="$(base64 -w0 < <(openssl pkey -pubin -in config/release-keys/recovery.pub -outform DER))" \
pnpm --dir backend/integrity-monitor check:once
```

Sale 0 sólo si las dos apps están OK. En el ciclo siguiente el monitor registra el chequeo OK (`lastCheckStatus: OK`) pero
la atestación sigue en `MISMATCH`.

## 4. Reanudar con doble aprobación (dos operadores distintos)

Cada operador firma con **su** clave Ed25519 (fijada en `MONITOR_OPERATOR_KEYS`; nunca la comparte ni la pega en un
chat) la reanudación del release exacto que ve el monitor (`releaseId` y `manifestSha256` de `GET /v1/status` y de la
atestación):

```bash
pnpm --dir backend/integrity-monitor resume:approve --operator <id> --key-file <clave del operador> \
  --app WALLET --release <releaseId> --manifest-sha256 0x<hex> \
  --platform <platformId> --environment production --monitor http://integrity-monitor:8092
```

El monitor rechaza (409) aprobaciones de otro release, vencidas (más de 1 h), de operadores desconocidos o con firma
inválida, y mientras el último chequeo no sea OK. Con la segunda aprobación de otro operador la atestación vuelve a OK
en el acto y el signer retoma la co-firma con la atestación siguiente. Queda registrado quiénes aprobaron
(`resumedBy`) y el backend audita `COOPERATION_RESUMED`.

## UNREACHABLE y monitor caído

- **UNREACHABLE** (el monitor no pudo descargar o verificar: red, timeout, 5xx): el signer sigue cooperando 15 min desde
  el último OK y después pausa. No hace falta doble aprobación: cuando el chequeo vuelve a dar OK la cooperación sigue
  sola. Investigar igual (un origin que no responde al monitor pero sí a los usuarios es sospechoso).
- **Monitor caído**: sin atestaciones vigentes el signer pausa a los 5 min (fail-closed). Reiniciar el contenedor; la
  pausa por MISMATCH, si había, se conserva.

## Rotación de una clave de release

1. Generar la clave nueva fuera del repositorio y cargarla como `RELEASE_SIGNING_KEY` del environment del pipeline de
   la app.
2. Fijar la pública nueva junto a la vieja: el monitor acepta varias públicas por app durante el solapamiento
   (`<APP>_RELEASE_PUBLIC_KEY` con las dos, separadas por comas, o un `_FILE` con los dos bloques PEM).
3. Publicar un release firmado con la clave nueva y confirmar el OK del monitor y del chequeo off-host.
4. Quitar la pública vieja de `config/release-keys/` y de la configuración del monitor; `node scripts/check-release-keys.mjs`.

## Simulacro del chequeo off-host

`gh workflow run wallet-integrity-offhost.yml -f selftest=true`: el runner compila Recovery, la sirve con `vite
preview`, altera un archivo y corre `check-once`, que tiene que fallar con MISMATCH y enviar la alerta (el job verifica
las dos cosas).
