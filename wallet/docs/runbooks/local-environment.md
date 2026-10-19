# Runbook: entorno local integrado

Todo el sistema en una máquina de desarrollo con cuatro comandos (P21), sobre el fork de Base en Anvil y servicios
reales (PostgreSQL 18, Valkey 9, Mailpit). Nada sale de la máquina salvo las lecturas del RPC del fork.

```bash
cd wallet
docker compose up -d          # PostgreSQL, Valkey, Anvil (fork del bloque fijado) y Mailpit
pnpm install                  # scripts/install-all.mjs: cada proyecto con su lockfile congelado + Soldeer verificado
pnpm preflight                # STOP con qué falta y dónde conseguirlo (docs/SETUP_EXTERNAL_SERVICES.md)
pnpm dev                      # scripts/dev.mjs: migraciones, deploy-local, policy, shards, seed y todos los procesos
```

`pnpm dev` deja corriendo, con logs con prefijo: los dos shards del signer (8090 dev-1, 8091 platform), la API (8080
Wallet, 8081 Recovery), el worker (watcher, indexer y reconciliación), el gas tank, el integrity monitor en modo local
(8092; observa los dos frontends sin pausar a nadie: `INTEGRITY_REQUIRED=false` en local) y los frontends con Vite
(Wallet 5173, Recovery 5174). Ctrl+C apaga en orden inverso. `pnpm dev:healthcheck` verifica cada servicio, los
contratos del deploy local y los dos frontends.

## Seed determinístico (`pnpm seed-local`, lo corre `pnpm dev`)

Sobre `LOCAL_SEED` de `wallet/.env` (sólo local; los flujos de producto generan claves con CSPRNG):

- Safe de prueba creada por la `WalletFactory` con U, R y S derivadas de `LOCAL_SEED` y el saltNonce del producto para
  su walletId determinístico; fondeada con USDC y USDT reales del fork; un destino de prueba agregado a la whitelist por
  U + S y activado con un warp de 24 h.
- S importada en el shard de desarrollo con su `SignerKeyAttestation`; usuario con el email verificado, wallet ACTIVE
  después de la verificación normal de la Safe (V9 §16), registro OPAQUE de U y el destino activo en la base.
- Sobres de prueba `U.enc.json` (Wallet) y `R.enc.json` (Recovery) y credenciales en `wallet/.secrets/seed/` (0600):
  se importan en los frontends como un usuario real (archivo + Password U/R). El seed imprime las credenciales al final.

`pnpm seed:check` inicia sesión por la API con el usuario del seed y verifica la wallet ACTIVE, el destino activo y los
saldos on-chain (`--report <archivo>` escribe direcciones y saldos para comparar corridas). El seed se niega a correr
fuera de `APP_ENV=local` o si el RPC no es Anvil.

## Escenario desde cero (`pnpm dev:fresh`)

Fork al bloque fijado (`anvil_reset`), bases del backend y de los shards vacías y migradas, secretos del seed y de los
shards borrados y `deploy-local`. Después, `pnpm dev` levanta todo y corre el seed. Dos `dev:fresh` + `seed:check
--report` dan los mismos contratos, la misma Safe y los mismos saldos.

## Problemas frecuentes

- **Puerto ocupado** (`EADDRINUSE`, o el preflight lo informa): `ss -ltnp | grep -E ':(5432|6379|8545|8080|8081|8090|8091|8092|5173|5174)'`;
  cerrar el proceso o cambiar el puerto en `wallet/.env` (`API_WALLET_PORT`, `SIGNER_PORT`, `ANVIL_HOST_PORT`, …).
- **RPC del fork sin estado histórico**: el fork lee el estado del bloque fijado; un endpoint sin acceso de archivo
  responde `missing trie node` o `header not found`. Usar un endpoint con estado histórico (`BASE_RPC_URL`, ver
  `docs/runbooks/fork.md`).
- **Fork lento o con 429**: Anvil reintenta con backoff y se limita a `ANVIL_COMPUTE_UNITS_PER_SECOND`; la caché RPC de
  Foundry (volumen `foundry-home`) acelera los arranques siguientes. Si quedó inconsistente: `pnpm fork:reset`.
- **El deploy local no verifica** (otro estado del fork): `pnpm fork:reset && pnpm deploy-local`.
- **El seed falla al importar S o al registrar la wallet**: `pnpm dev:fresh` (vuelve a crear bases, shards y seed).
- **Un frontend no carga** (CSP, Trusted Types): abrir la consola; en local la CSP permite sólo la API y el RPC locales.
