# Runbook: ciclo de vida del signer S

Procedimientos de [B-SIG-08] para cada shard del signer (`backend/signer`, `SelfHostedSoftwareSignerProvider`, ADR-014).
Cada uno es un script del proyecto y tiene un test que lo ejecuta de punta a punta sobre un shard de prueba
(`backend/signer/test/lifecycle/lifecycle.test.ts`). Todos imprimen JSON en stdout y **nunca** muestran la credencial
de desbloqueo ni claves.

## Conceptos

| Pieza | Dónde vive | Notas |
|---|---|---|
| Keystores V3 (una S por Safe) | `SIGNER_KEYSTORE_DIR` (prod: `/var/lib/mtw-signer/keystore/` en el volumen `signer-<shard>-keystore`) | `<dirección>.json`, 0400 del UID del signer, directorio 0700 |
| Credencial de desbloqueo | `SIGNER_UNLOCK_CREDENTIAL_FILE` (prod: `/run/secrets/signer_unlock`) | 32 bytes en hex; **nunca** dentro del directorio de keystores; 0400/0600 |
| DB del shard | `SIGNER_DATABASE_URL[_FILE]` | registro de claves (sin material privado), SafeTx co-firmadas, ledger, eventos |
| Contraseña de cada keystore | derivada | `hex(HKDF-SHA256(credencial, "mtw-signer-keystore-v1", dirección))` |
| `credentialFingerprint` | DB | HMAC de una constante con la credencial: el shard no arranca listo si no coincide |

Los comandos se corren desde `wallet/` con `pnpm --dir backend/signer <script>` y el entorno del shard (en local,
`wallet/.env`; el shard `platform` usa `--shard platform` y sus variables `SIGNER_PLATFORM_*`). En producción, dentro
del contenedor del shard (P26), con los secrets montados.

## Alta de un shard

```bash
pnpm --dir backend/signer shard:create [--shard <id>] [--generate-credential] [--gas-tank]
```

Migra la DB del shard, exige el directorio de keystores vacío (lo crea 0700), genera la credencial en su directorio
propio si se pide y registra el fingerprint. Para `platform` crea además la cuenta gas tank. Después: custodia de la
credencial (más abajo) y alta del shard en `SIGNER_SHARDS` del backend.

## Backup

```bash
pnpm --dir backend/signer shard:backup --out <shard>-<fecha>.age --recipient <age1… de backup> [--recipient …]
```

Tras cada alta de clave y diariamente (P26 lo programa). Paquete JSON con los keystores (ya cifrados) y la DB del shard,
cifrado con `age` hacia la clave pública de backup y copiado off-host (ADR-031). **No** incluye la credencial. El sha256
queda como evento `BACKUP_CREATED` en la DB del shard.

## Restore en un host nuevo

```bash
pnpm --dir backend/signer shard:restore --in <archivo.age> --identity <identidad age de backup>
pnpm --dir backend/signer restore-verify
pnpm --dir backend/signer start     # recién después
```

1. DB del shard vacía y directorio de keystores vacío (el restore se niega si no).
2. Montar la credencial de desbloqueo recuperada de su custodia (no viene en el backup).
3. `restore-verify` descifra cada keystore y comprueba su dirección **sin firmar**; termina con código 1 si alguna
   clave no verifica o si hay archivos sobrantes. Las claves que estaban `BROKEN` y verifican vuelven a `ACTIVE`.

## Keystore corrupto o faltante

Al arrancar, una clave sin archivo queda `BROKEN`; al firmar, un MAC inválido o una dirección distinta también. Ambas
disparan la alarma (`mtw_signer_keystore_alarms_total`) y la clave no firma. Respuesta:

1. Restaurar el archivo de esa dirección desde el último backup (`age -d -i <identidad> <backup> | …` o un restore
   completo en un host aparte) con permisos 0400.
2. `pnpm --dir backend/signer restore-verify` → la clave vuelve a `ACTIVE`.
3. Si es irrecuperable, la Safe queda sin camino asistido: aplicar P15.T09 (U+R reemplazan S por camino soberano).

## Rotación de la credencial de desbloqueo

Con el shard detenido:

```bash
pnpm --dir backend/signer credential:rotate --new-credential <archivo con la credencial nueva>
```

Re-cifra cada keystore con la contraseña derivada de la credencial nueva, archivo por archivo y de forma atómica
(`kdfVersion` + 1); si se corta, se vuelve a correr y retoma (detecta los archivos ya re-cifrados). Recién al final el
shard pasa a la credencial nueva. Después: reemplazar el secret montado por la credencial nueva, arrancar el shard,
verificar `/v1/health` (`ready: true`), rehacer la custodia y destruir la credencial anterior y sus copias.

## Custodia offline de la credencial

```bash
pnpm --dir backend/signer credential:escrow --out-dir <dir> \
  --custodian <nombre-1>=<age1… del custodio 1> --custodian <nombre-2>=<age1… del custodio 2>
```

Dos copias selladas (cada una cifrada para un custodio distinto) más un manifiesto con el fingerprint. Cada custodio
guarda su copia offline (por ejemplo, impresa o en un medio sin red) y su identidad `age` por separado. Recuperación:

```bash
pnpm --dir backend/signer credential:escrow --recover <copia.age> --identity <identidad del custodio> --out <archivo>
```

El comando verifica que la credencial recuperada coincide con el fingerprint del shard antes de escribirla (0400).

## Migración de wallets entre shards

Offline, en el host del signer, con los dos shards detenidos (o sin tráfico para esas wallets):

```bash
TARGET_SIGNER_SHARD_ID=<destino> TARGET_SIGNER_KEYSTORE_DIR=… TARGET_SIGNER_UNLOCK_CREDENTIAL_FILE=… \
TARGET_SIGNER_DATABASE_URL_FILE=… \
pnpm --dir backend/signer shard:migrate --wallet <walletId> [--wallet …]
```

Fase 1: copia cada S activa al destino re-cifrándola con la credencial destino (`MIGRATING`), verifica que descifre
a la misma dirección y la pasa a `ACTIVE`. Fase 2: el origen queda `MIGRATED` (ya no firma). No hay cambio on-chain:
la Safe sigue con la misma S. Con la salida, el backend actualiza la asignación (`signer_keys.shard_id`) con
`pnpm --dir backend/app signer:reassign`.

## Rotación de S y destrucción de la clave vieja

La rotación de S por Safe es on-chain (P15): clave nueva con `POST /v1/keys` (`reason: ROTATION`), propuesta con
timelock de 48 h y ejecución co-firmada por la S saliente. La pide un operador con
`pnpm --dir backend/app operators executor:rotation-request --wallet <id> --reason
SHARD_MIGRATION|HSM_MIGRATION|KEY_COMPROMISE|MAINTENANCE --operator <email> [--to-shard <id>]` (TOTP por stdin): deja
el borrador con el motivo y la atestación de la S nueva, y el usuario firma la propuesta desde su app (U en Wallet o R
en Recovery). Ejecutada la rotación, el backend llama a
`POST /v1/keys/retire` (`{walletId, address, safe}`): el shard verifica on-chain que la clave ya no es la S de esa Safe
y la deja `RETIRED` (no firma más). A los 30 días, sin SafeTx activas firmadas por ella:

```bash
pnpm --dir backend/signer shard:destroy-retired
```

## Compromiso del host del signer

Root del host = S comprometidas de todos los shards de ese host. Siguen necesitando U o R para alcanzar el threshold
(A3). Respuesta: rotar S de las Safes afectadas con firma del usuario hacia claves de un shard en un host limpio
(nueva credencial, nuevo volumen, nuevo certificado mTLS) y aplicar el playbook de incidente.
