# Claves públicas de release (P20.T01, ADR-023)

Claves Ed25519 que firman el manifest de cada release de los frontends ([W-04]). Wallet y Recovery tienen claves
**distintas** (trust domains separados) y staging no comparte ninguna con producción. Acá sólo están las públicas
(SPKI PEM); las fija el integrity monitor (`backend/integrity-monitor`, `WALLET_RELEASE_PUBLIC_KEY` y
`RECOVERY_RELEASE_PUBLIC_KEY`), el chequeo off-host (`.github/workflows/wallet-integrity-offhost.yml`) y
`pnpm verify:manifest` de cada app.

| Entorno | Wallet | Recovery |
|---|---|---|
| production | `wallet.pub` | `recovery.pub` |
| staging | `staging/wallet.pub` | `staging/recovery.pub` |

- **Privadas**: nunca en el repositorio ni en el backend. Staging y producción: secretos `WALLET_RELEASE_SIGNING_KEY` y
  `RECOVERY_RELEASE_SIGNING_KEY` (PKCS#8 DER en base64) de los GitHub Environments `wallet-staging` y `wallet-production`
  (sólo tags `wallet-v*`); el pipeline de release firma cada app en su propio job, que recibe sólo la clave de esa app
  (P26.T02.a). Para los ensayos locales de P25/P26/P30, una copia en `~/.config/mtw/secrets/<entorno>/release-<app>.pem`
  (0600, fuera del repo).
  Desarrollo local: claves propias de cada máquina en `wallet/.env` (`pnpm secrets:local`), nunca fijadas acá.
- **Verificación**: `node scripts/check-release-keys.mjs` (públicas fijadas, distintas por app y entorno, ninguna
  privada versionada ni mencionada por el backend).
- **Rotación**: ver `docs/runbooks/integrity-mismatch.md#rotación-de-una-clave-de-release` (la pública nueva se fija y
  el monitor acepta las dos durante el solapamiento).
