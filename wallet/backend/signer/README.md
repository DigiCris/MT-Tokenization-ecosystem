# backend/signer — signer-service S

Servicio independiente del dominio de confianza de S ([B-SIG], ADR-014): un proceso por shard que guarda las claves S
como keystores Ethereum V3 cifrados, aplica **su propia** política (no importa código del backend) y co-firma una
SafeTx sólo después de repetir los checks del worker con su propio RPC, su propia DB y un snapshot de policy firmado.
Habla sólo por mTLS dentro de la red Docker `signer` y nunca publica puertos.

## Estructura

| Ruta             | Contenido                                                                                                                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/providers/` | `SignerProvider` y sus implementaciones: `SelfHostedSoftwareSignerProvider` (staging/producción), `DevelopmentSignerProvider` (el mismo, con guardas: sólo `APP_ENV=local` sobre un fork de Anvil) y `HardwareSignerProvider` (interfaz para un HSM futuro, no se usa en V1) |
| `src/keystore/`  | keystore V3 (scrypt + AES-128-CTR + MAC keccak), contraseña derivada por HKDF de la credencial del shard, escritura atómica, fingerprint de la credencial                                                                                                                    |
| `src/policy/`    | reglas estáticas (SR-xx / GT-xx, antes de cualquier E/S), clasificación de la SafeTx desde sus bytes, evaluación pura de la policy, PlatformSession y envelope, atestaciones (challenge, integridad, claves), snapshot firmado con anti-rollback                             |
| `src/chain/`     | decoders de calldata de longitud exacta, hash EIP-712 de la SafeTx y de los tipos de la plataforma, RPC propio con quórum, lecturas on-chain (roles, configuración de la Safe, whitelist, timelock, PolicyRegistry), `execTransaction` y tx EIP-1559                         |
| `src/sign/`      | `POST /v1/sign-safe-tx` (pasos 2–8 y 7b de [B-Q-02]) y `POST /v1/sign-platform-tx` (cuenta gas tank)                                                                                                                                                                         |
| `src/state/`     | DB propia del shard: shards, claves (sin material privado), eventos de ciclo de vida, snapshots aceptados, SafeTx co-firmadas (una activa por `(safe, nonce)`), firmas emitidas, txs del gas tank                                                                            |
| `src/lifecycle/` | alta de shard, backup/restore con `age`, rotación y custodia de la credencial, migración entre shards, retiro y destrucción de claves                                                                                                                                        |
| `src/api/`       | servidor HTTPS con mTLS obligatorio (TLS 1.3, cliente `mtw-backend`) y errores tipificados                                                                                                                                                                                   |
| `scripts/`       | CLIs del ciclo de vida, del snapshot de policy, de la clave pública de atestación y de la spec interna                                                                                                                                                                       |
| `openapi.json`   | spec OpenAPI 3.1 interna (generada desde los schemas Zod; nunca se publica)                                                                                                                                                                                                  |

## Orden de una co-firma (`POST /v1/sign-safe-tx`)

1. Reglas estáticas sobre la SafeTx (chainId 8453, CALL, sin gas/refund ni ETH, destino y selector en la allowlist del
   snapshot, calldata exacta, tipo declarado = tipo decodificado) y versión del snapshot.
2. Hash EIP-712 recalculado; PlatformSession (JWS EdDSA del emisor, audiencia `mtw-signer`) y envelope de envío
   firmado con la session key, válido al momento del envío y con ≤ 24 h; pausa por integridad si
   `INTEGRITY_REQUIRED=true`.
3. Firma U/R ECDSA estricta (65 bytes, low-s, `v` ∈ {27, 28}) contra el rol vigente on-chain.
4. Estado on-chain a un bloque común: Safe registrada por la factory, nonce, configuración intacta (Guard, module
   guard, fallback 0, sin módulos, threshold 2, owners = roles).
5. Hechos de la operación (saldos, whitelist, migración, ledger de 24 h, atestaciones de 2FA y whitelist,
   emparejamiento approve/swap, `KeyAcceptance`, atestación de la nueva S, propuestas del timelock) y policy.
6. Pre-check `SecurityGuard.evaluateAssisted`.
7. Una SafeTx activa por `(safe, nonce)` (salvo NoOp o reemplazo explícito).
8. Firma S de la SafeTx → simulación de `execTransaction` desde S → firma de la tx EIP-1559 → registro → respuesta.

Cualquier falla devuelve `{code, reason?, retryable}` y la firma S nunca sale del servicio.

## Configuración

Variables (ver `wallet/.env.example`): `APP_ENV`, `SIGNER_PROVIDER` (`development` | `selfhosted`),
`SIGNER_SHARD_ID`, `SIGNER_HOST`/`SIGNER_PORT`, `SIGNER_KEYSTORE_DIR`, `SIGNER_UNLOCK_CREDENTIAL_FILE` (fuera del
directorio de keystores), `SIGNER_DATABASE_URL[_FILE]`, `SIGNER_ATTESTATION_PRIVATE_KEY[_FILE]`,
`SIGNER_RPC_PRIMARY_URL[_FILE]`/`SIGNER_RPC_SECONDARY_URL[_FILE]`, `SIGNER_RPC_QUORUM_MODE`, `MTLS_CA_CERT_PATH`,
`MTLS_SIGNER_SERVER_CERT_PATH`/`MTLS_SIGNER_SERVER_KEY_PATH`, `MTLS_ALLOWED_CLIENT_NAMES` (default `mtw-backend`),
`POLICY_SNAPSHOT_PATH`, `POLICY_SIGNING_PUBLIC_KEY`, `SESSION_ISSUER_PUBLIC_KEY` (varias separadas por coma durante una
rotación del emisor), `INTEGRITY_REQUIRED`, `INTEGRITY_MONITOR_PUBLIC_KEY`, `LOG_LEVEL`. En staging/producción los
secretos se leen sólo de `<VAR>_FILE` (ADR-030), el quórum es `dual` e `INTEGRITY_REQUIRED=true`.

En local, `--shard platform` levanta la cuenta gas tank con sus variables `SIGNER_PLATFORM_*` (puerto, keystores,
credencial y DB propios).

## Uso local

```bash
cd wallet
pnpm secrets:local                         # credenciales de los shards dev-1 y platform, certificados mTLS, claves Ed25519
pnpm deploy-local                          # contratos en el fork local
pnpm --dir backend/signer policy:build && pnpm --dir backend/signer policy:sign
pnpm --dir backend/signer db:migrate
pnpm --dir backend/signer db:migrate -- --shard platform
pnpm --dir backend/signer shard:create -- --shard platform --gas-tank   # cuenta gas tank (una vez)
pnpm --dir backend/signer dev                                          # shard dev-1 (provider de desarrollo)
pnpm --dir backend/signer dev -- --shard platform                      # shard platform
pnpm --dir backend/signer attestation:public-key                       # clave pública de atestación para los frontends
```

El provider de desarrollo inicializa el shard `dev-1` la primera vez; el shard `platform` usa el provider configurado
y se inicializa con `shard:create`.

## Ciclo de vida

Alta de shard, backup y restore cifrados con `age`, `restore-verify`, keystore corrupto o faltante, rotación de la
credencial, custodia offline en dos copias, migración entre shards y destrucción de claves retiradas:
[docs/runbooks/signer-lifecycle.md](../../docs/runbooks/signer-lifecycle.md). Migración futura a un HSM:
[docs/runbooks/signer-hardware-migration.md](../../docs/runbooks/signer-hardware-migration.md).

## Tests

```bash
pnpm --dir backend/signer test            # unit + integración (PostgreSQL vía Testcontainers, Anvil sobre el fork) con cobertura
pnpm --dir backend/signer test:security   # P11.SEC
```

El global setup levanta PostgreSQL 18 (imagen fijada por digest) y despliega el sistema una vez en un fork de Base con
los scripts del repo (`scripts/deploy-core ci`); cada archivo clona su DB y levanta su propio Anvil con ese estado.
Necesita Docker, Foundry, `age` (toolchain) y `BASE_RPC_URL`. Los vectores compartidos
(`test/vectors/`, incluidos los de policy) se sincronizan con `pnpm sync:contracts` y CI verifica que sean idénticos a
los de `contracts/`.
