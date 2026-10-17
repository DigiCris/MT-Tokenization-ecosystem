# ADR-014 — Signer S self-hosted con keystores V3 cifrados

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-014), §3.5 (Clef, Web3Signer), §5.1, §5.5, §7.6 ([B-Q-02]), §7.8 ([B-RPC-04]), §7.10 ([B-SIG-01] a [B-SIG-09]), §9.1, §9.3, §13 (entrada del 2026-10-16); V9 §7, §8; prompt §18; CF-10

## Contexto

V9 §7 describe al executor S como `Application Backend → Auth/Policy → mTLS + red privada → Signer Shard → Clef o HSM → S`: cada Safe usa una S distinta, los usuarios se distribuyen entre varios signer shards para limitar el blast radius y cada S mantiene sólo ETH operativo para gas. Clef puede usarse inicialmente y la evolución de máxima seguridad es un HSM propio secp256k1 con S no exportable; el Backend/Signer no posee credenciales para desplegar o modificar los frontends. V9 §8 exige que el signer reconstruya la SafeTx y repita los checks críticos antes de co-firmar.

El prompt §18 pide una interfaz `SignerProvider` con un signer de desarrollo y uno de producción que siga la arquitectura `Backend → Policy → Signer Service → Clef / equivalente aislado`, con la migración a un HSM secp256k1 preparada, y prohíbe guardar S en claro en base de datos, `.env`, logs o código.

Hechos verificados el 2026-10-16 (§3.5): Clef fue removido de go-ethereum en v1.17.4 (2026-06-22, PR #35097, "no longer maintained"); el repositorio standalone `github.com/ethereum/clef` tiene 3 commits del 2026-06-02 y ninguna release ni tag; `account_new` siempre requiere UI. Web3Signer (Consensys, Apache-2.0) tiene release estable 26.9.0 (2026-09-30): firma digests de 32 bytes con `applyHash: false`, soporta `eth_signTransaction` (legacy y EIP-1559), `/reload` y keystores V3 con passwords en archivos separados, pero no genera claves ni tiene motor de políticas, y es una aplicación Java. La producción es self-hosted y sin cloud (ADR-022), decisión registrada por el owner el 2026-10-16 (§13).

## Decisión

Signer S **self-hosted**: un signer-service independiente por shard (mTLS sobre red Docker interna, política propia con snapshot firmado, DB propia, atestación de cada S creada) con **`SelfHostedSoftwareSignerProvider`**: una clave secp256k1 por Safe, generada con CSPRNG dentro del signer y guardada como **keystore Ethereum V3 cifrado** (scrypt + AES-128-CTR, formato estándar interoperable con geth, Foundry y Web3Signer) en el volumen del shard. La contraseña de cada keystore se deriva con HKDF-SHA256 de una **credencial de desbloqueo** por shard que vive aparte (secret de Docker Compose), nunca junto a los keystores. El signer firma el hash EIP-712 de la SafeTx y el hash de la tx EIP-1559 con `@noble/curves` (low-s, RFC 6979). `DevelopmentSignerProvider` es el mismo provider con guardas de desarrollo; `HardwareSignerProvider` (HSM físico propio vía PKCS#11/YubiHSM) queda como hardening futuro opcional.

Ciclo de vida de S ([B-SIG-08]):

- **Layout:** keystores en `SIGNER_KEYSTORE_DIR` (producción: `/var/lib/mtw-signer/keystore/<address>.json` en el volumen `signer-<shardId>-keystore`, archivos 0400 del UID del signer); credencial de desbloqueo del shard = 32 bytes aleatorios en `SIGNER_UNLOCK_CREDENTIAL_FILE` (producción: `/run/secrets/signer_unlock`, secret de Compose que vive en otro directorio del host). Las claves privadas nunca están en PostgreSQL, Valkey, la DB del backend, `.env`, código, logs ni ninguna API.
- **create:** CSPRNG → escalar válido → contraseña = `hex(HKDF-SHA256(credencial, salt="mtw-signer-keystore-v1", info=address))` → keystore V3 (scrypt de `@noble/hashes` con N=2^14, r=8, p=1, porque la contraseña ya tiene 256 bits; AES-128-CTR; MAC keccak) → escritura atómica (temporal + fsync + rename) → alta en la DB del signer → `SignerKeyAttestation`.
- **load / unlock / restart:** al arrancar se indexa el directorio y se concilia con la DB (faltantes o sobrantes alertan y no firman); cada firma lee el keystore, deriva la contraseña, descifra verificando el MAC, firma y sobrescribe buffers, sin caché de claves en claro; al reiniciar se compara el `credentialFingerprint` y, si no coincide, el shard queda `not ready`.
- **backup / restore:** tras cada alta y diariamente, keystores + dump de la DB del signer cifrados con `age` y copiados off-host, sin la credencial (ADR-031); el restore arranca en modo `restore-verify` (descifra cada keystore y comprueba la dirección, sin firmar) antes del modo normal.
- **rotation:** de S por Safe, clave nueva y rotación on-chain con timelock (ADR-007); la vieja pasa a RETIRED y su keystore se destruye 30 días después de la rotación si no hay operaciones pendientes. De la credencial del shard, re-cifrado de todos los keystores archivo por archivo (`kdfVersion` + 1).
- **lost/corrupted y shard migration:** MAC inválido o archivo faltante → clave `BROKEN`, alerta crítica y restore; si es irrecuperable, U+R reemplazan S (P15.T09). La migración entre shards es offline, con re-cifrado y actualización en dos fases, sin cambio on-chain.

Servicio y protocolo:

- **Transporte** ([B-SIG-01]): HTTPS con mTLS (CA privada por entorno) sobre la red Docker `signer` (`internal: true`); el signer no publica ningún puerto.
- **`POST /v1/sign-safe-tx`** ([B-SIG-02]): el signer repite con su propio RPC y su propia DB los pasos 2 a 8 (incluido 7b) de [B-Q-02]; rotación de S sólo hacia claves que él mismo creó para esa wallet; rotación de U o R sólo con `KeyAcceptance` válido; un `SWAP_APPROVE` sólo se co-firma junto con su `SWAP` N+1 firmado por U con el mismo executor y `amountIn == amount`; antigüedad ≤ 24 h.
- **Estado propio** ([B-SIG-03]): PostgreSQL propio del dominio signer (`mtw_signer_dev` en local; contenedor `signer-postgres` en producción, una DB lógica por shard) con la regla "a lo sumo una SafeTx activa firmada por (safe, nonce)", ledger de salidas de 24 h y registro de claves; nunca contiene claves privadas y el backend no tiene credenciales para esa base.
- **Interfaz** ([B-SIG-04]): `createKey(walletId)`, `getAddress(keyRef)`, `signDigest(keyRef, digest32)` y `health()`, elegida con `SIGNER_PROVIDER=development | selfhosted`. El provider de desarrollo sólo arranca con `APP_ENV=local` sobre un fork Anvil y guarda keystores en `wallet/.secrets/signer/<shard>/keystore/`.
- **Gas tank/relayer** ([B-SIG-05]): cuenta de plataforma en el shard `platform`; S sólo transmite `execTransaction` hacia su propia Safe (`to == safe asociada`, `value == 0`, chainId 8453 y topes de gas/fee).
- **Ruleset estático** ([B-SIG-06]) evaluado antes de cualquier lectura on-chain; **atestación** `SignerKeyAttestation` Ed25519 al crear S ([B-SIG-07]); **sharding** por hash estable de `walletId` guardado al crear la wallet ([B-SIG-09]); **RPC propio** ([B-RPC-04], ADR-017).

## Alternativas consideradas

- **Clef:** descartado; fue retirado de go-ethereum (v1.17.4), su repositorio standalone no tiene releases ni commits desde el 2026-06-02 y `account_new` exige UI (§3.5).
- **Web3Signer:** evaluado y no elegido para V1. Firma digests de 32 bytes, soporta EIP-1559, `/reload` y miles de claves, pero no crea claves ni tiene política: el servicio propio igual tendría que generar y cifrar cada keystore con la misma credencial, sumando una JVM por shard sin aislamiento real. Por la regla del owner (ciclo de vida dinámico no cubierto) se elige el provider propio, que conserva el formato V3 para migrar a Web3Signer o a un HSM más adelante sin rotar claves.
- **KMS cloud:** descartado porque la producción es sin cloud (ADR-022).
- **HSM físico propio en V1:** queda como hardening futuro opcional; V1 deja lista la interfaz y la suite de contrato común, y la migración se hace Safe por Safe rotando S por el timelock, sin exportar claves.

## Consecuencias

- S sólo existe en claro dentro del proceso del signer y durante cada firma; el formato V3 es verificable con herramientas estándar (`cast wallet decrypt-keystore`).
- El signer es una segunda capa de validación independiente del backend: re-verifica firma, policy, configuración de la Safe y estado on-chain con su propio RPC, y su atestación impide que un backend comprometido sustituya S por una clave propia.
- Riesgo residual: compromiso del root del host del signer = S comprometidas de todos los shards de ese host. Siguen necesitando U o R para alcanzar threshold (A3); la respuesta es rotar S de las Safes afectadas con firma del usuario y aplicar el playbook de incidente (§9.3, [B-SIG-08]). Los frontends se sirven desde servidores propios (ADR-022), así que ese compromiso no alcanza el JS de los origins de U y R (CF-10).
- La credencial de desbloqueo exige custodia offline aparte (dos copias selladas, custodios distintos); su pérdida junto con los backups vuelve irrecuperables los keystores y obliga a que U+R reemplacen S.
- Las alarmas del signer (keystore ilegible o con MAC inválido, fingerprint distinto al arrancar, archivos creados o borrados fuera del flujo, clave `BROKEN`, backup atrasado) se prueban en P24.T07.

## Verificación

- P11.T01 — `DevelopmentSignerProvider`: se niega a arrancar fuera de `APP_ENV=local` o fuera de un fork Anvil.
- P11.T02 — servidor mTLS con `POST /v1/sign-safe-tx`, `POST /v1/keys` y `GET /v1/health`.
- P11.T03 — política independiente del signer (tabla completa de rechazos y vectores compartidos).
- P11.T05 — reglas estáticas evaluadas antes de cualquier I/O.
- P11.T06 — `SelfHostedSoftwareSignerProvider`: create, load, unlock y restart, con interoperabilidad verificada con `cast`.
- P11.T07 — `HardwareSignerProvider` (interfaz y suite de contrato común), runbook de migración y evaluación de Clef y Web3Signer documentada en este ADR.
- P11.T08 — sharding con asignación guardada y soporte de N shards.
- P11.T10 — procedimientos del ciclo de vida ejecutados de punta a punta (backup, restore, rotación de credencial, `BROKEN`, migración entre shards, custodia).
- P11.T11 — `SignerKeyAttestation` Ed25519.
- P11.TST, P11.SEC y P11.MAN — firma S nunca emitida si falla un check, S nunca en DB/Valkey/`.env`/logs, keystores 0400, credencial separada, mTLS obligatorio y signer sin puertos publicados.
- P15.T09 y P15.TST.d — pérdida de una clave S y rotación de S con continuidad de operaciones.
- P24.T07 — alarmas del signer self-hosted.
- P26.T09 y P26.T14 — generación de credenciales de desbloqueo y rotación de claves del signer en el ensayo local.
- P27.T02.k — auditoría del compromiso del signer (un shard y root del host del backend).
- Trazabilidad: RQ-48, RQ-81, RQ-94.
