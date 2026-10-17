# Versiones exactas fijadas

Fuente única de verdad de versiones del proyecto (R-10, P01.T01). Re-verificadas el **2026-10-17** contra fuentes oficiales (registry npm, nodejs.org, GitHub Releases, PyPI, Docker Hub, GHCR, binaries.soliditylang.org). Ninguna fila usa rangos: toda dependencia se instala con versión exacta y lockfile congelado. La toolchain local y las imágenes se instalan desde `scripts/tools/versions.json` (ADR-032), que este documento refleja y que `scripts/preflight.d/__tests__/versions-doc.test.mjs` contrasta.

## Toolchain local (`wallet/.tools/`, ADR-032)

| Componente | Versión | Fuente | Verificado | Integridad |
|---|---|---|---|---|
| Node.js | 26.12.0 | https://nodejs.org/dist/v26.12.0/SHASUMS256.txt | 2026-10-17 | linux-x64 `sha256:fd47865ecd6391ebb431fc815e01b9135bf83ded5cf373247e9331e196b7aded` · darwin-arm64 `sha256:a2e255e35347f727f29aa158c552a60140b17b6ba68719d5d6fc46c7d058aa75` |
| pnpm | 12.14.0 | https://registry.npmjs.org/pnpm/12.14.0 | 2026-10-17 | `sha512-wYum2HmT09Fky16JSPMrLAbuhUSH4GzY2GeBNC+z5btGNDZwNHEehoArqpw3vqkGzhkprQjXCITJfYAd8TOJpg==` |
| Foundry (forge, cast, anvil, chisel) | v1.8.5 | https://github.com/foundry-rs/foundry/releases/tag/v1.8.5 | 2026-10-17 | linux-x64 `sha256:6c66ffcc55fa4249197721baa3098bc208014ea1d8aa04b2ed50ac6bccffb226` · darwin-arm64 `sha256:56049728e25e44a61c7f2e49438023b0890cb45850ffcb7c882f90cd998baf83` |
| gitleaks | 8.30.1 | https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_checksums.txt | 2026-10-17 | linux-x64 `sha256:551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb` · darwin-arm64 `sha256:b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5` |
| age | 1.3.2 | https://github.com/FiloSottile/age/releases/tag/v1.3.2 (SHA-256 de los assets en la API de GitHub, verificado al descargar; publicada 2026-08-29) | 2026-10-17 | linux-x64 `sha256:cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10` · darwin-arm64 `sha256:e2020b073c44f692685a24d6abc378817eb81ffaaf49fd0531ef8565f767f2f5` |
| Slither (venv, pip 26.2.1) | 0.11.6 | https://pypi.org/project/slither-analyzer/0.11.6/ | 2026-10-17 | pip wheel `sha256:71138adf1f4ca900cdb7d289c21b7494329f2332b6d85f0e1c42108c0384ed3e`; tag `0.11.6` = commit `050cc0a094e77bfd58e8228ae3bb6aa15c65edb4` |

Mínimos del sistema exigidos por PF-01: bash ≥ 4.0, git ≥ 2.34, python ≥ 3.10.

## Imágenes Docker (fijadas por digest)

| Uso | Imagen | Verificado |
|---|---|---|
| stack local: postgres | `postgres:18.6@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336` | 2026-10-17 |
| stack local: valkey | `valkey/valkey:9.2@sha256:247b5e730bdc9dc29fddb8274d1731b203a1a1a46af63eae3a9d55b4bf74853f` | 2026-10-17 |
| stack local: foundry | `ghcr.io/foundry-rs/foundry:v1.8.5@sha256:32c8ea9ef052a440cb1620175987a3f49eff8b068a0c6a3d09ebf7f5f9a0e043` | 2026-10-17 |
| stack local: mailpit | `axllent/mailpit:v1.31.6@sha256:23fe39e81bde596a918000b3135c0f85dc8bb4c9ea6be274b051143f3e300387` | 2026-10-17 |
| seguridad: semgrep | `semgrep/semgrep:1.181.0@sha256:81474464c1f07483ba0682a44787fd93c91397419762a04abe2bafaae396304b` | 2026-10-17 |
| seguridad: osv-scanner | `ghcr.io/google/osv-scanner:v2.7.0@sha256:4f3b7e2c64b9d38a5febc5a7e4a3dfef1d1362f726dea7a2ef4762b46469fcd0` | 2026-10-17 |
| seguridad: zizmor | `ghcr.io/zizmorcore/zizmor:1.31.1@sha256:42d409dbb851d4c5d35a058cf042b828bea1e3f2884378c526eb0974780e18d9` | 2026-10-17 |
| seguridad: syft | `anchore/syft:v1.54.1@sha256:3eb5379ba7b409c3f4069b686110527af0c47df993fa5c10d13e7cf34f49b1aa` | 2026-10-17 |
| seguridad: trivy | `aquasec/trivy:0.76.0@sha256:2416d1f74045b57274df1a340eee6b510cacd73c66a6ccb8da092b117eb7d222` | 2026-10-17 |
| alternativa (sólo si falla el binario): gitleaks | `ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f` | 2026-10-17 |
| alternativa (sin Python ≥ 3.10 o `BOOTSTRAP_SLITHER_MODE=docker`): slither | `ghcr.io/crytic/slither:0.11.6@sha256:89d4127ec3bfeba9725a863c58dd96b01781ff73737871dd3b07606ebc4cf16b` | 2026-10-17 |

Las imágenes de producción (Caddy 2.11.7, Prometheus 3.15.0, Alertmanager 0.34.1, Grafana 13.2.4, pgBackRest 2.59.3, age 1.3.2) se fijan por digest en P26, cuando se crean sus servicios; sus versiones están verificadas abajo.

## Solidity

| Componente | Versión | Fuente | Verificado | Commit / integridad |
|---|---|---|---|---|
| solc | 0.8.37 | https://binaries.soliditylang.org/linux-amd64/list.json (`latestRelease`) | 2026-10-17 | `solc-linux-amd64-v0.8.37+commit.f401782d` sha256 `5de843c2c93563cc66425c99a4fb13fdbf32b4c4ae07469480faaf126e14404a` |
| forge-std | v1.17.0 | https://github.com/foundry-rs/forge-std/releases/tag/v1.17.0 | 2026-10-17 | `f3dae6e6ee381f25eb6a246f7da9b85c91a68219` |
| OpenZeppelin Contracts | v5.6.1 | https://github.com/OpenZeppelin/openzeppelin-contracts/releases/tag/v5.6.1 | 2026-10-17 | `5fd1781b1454fd1ef8e722282f86f9293cacf256` |
| Safe Smart Account | v1.5.0 | https://github.com/safe-fndn/safe-smart-account/releases/tag/v1.5.0 | 2026-10-17 | `dc437e8fba8b4805d76bcbd1c668c9fd3d1e83be` |

## Paquetes npm

Cada proyecto declara sólo lo que usa, con estas versiones exactas.

| Paquete | Versión | Fuente | Verificado | Integridad (registry) |
|---|---|---|---|---|
| `@coinbase/wallet-sdk` | 4.4.0 | https://www.npmjs.com/package/@coinbase/wallet-sdk/v/4.4.0 | 2026-10-17 | `sha512-smqgHEefN+ERH+WJ5W4BpnHSKydmoyM441PkzmeKEpPVaVHYHIwt2JnHEL+2ZDIEuEvNaCqBf5xq/pBAmZ2Rhg==` |
| `@fastify/cookie` | 11.1.3 | https://www.npmjs.com/package/@fastify/cookie/v/11.1.3 | 2026-10-17 | `sha512-RBhlMNsmSG6C5KGiTkhSXBF75xIrUMSytDDBcpnVewhJ8XVYnJTu+SV6FYKXClIRsBuRjOfKbBSULvnPD3X/mg==` |
| `@fastify/cors` | 11.3.1 | https://www.npmjs.com/package/@fastify/cors/v/11.3.1 | 2026-10-17 | `sha512-gZXNzd6FLHzOIfvoK4+Az3Wko2V6Y0MIsLxpyo4AEYl7a9q1JBPwPaxLea4nkr++8FCiJiPpYYo6E02uZW0dqw==` |
| `@fastify/helmet` | 13.2.0 | https://www.npmjs.com/package/@fastify/helmet/v/13.2.0 | 2026-10-17 | `sha512-2u41U5hR9o1u3HUHLT3Njp7vWuWw+XXw8qCBwVY17pRQAN179YYKiU9f7/qEn1ITabgNTkq/Yk6gmrYPSraagA==` |
| `@fastify/rate-limit` | 11.2.1 | https://www.npmjs.com/package/@fastify/rate-limit/v/11.2.1 | 2026-10-17 | `sha512-uTQjii3tJUnb6ZyEMcunuvKE3FDKNZEaPpxdyWADDgthHnUV1swdvwuiZfi3DDDgxm1iBrhOkQ/w0yDBQ8qJtA==` |
| `@fastify/swagger` | 9.9.2 | https://www.npmjs.com/package/@fastify/swagger/v/9.9.2 | 2026-10-17 | `sha512-ayxItVgf/1axBvw33lqsA5ns02YMpT1r59G/HCJraRNWWBzvLgN+oiCBPhuzTiN67TvctlCYkG0+40WLKYuusQ==` |
| `@fastify/swagger-ui` | 6.1.2 | https://www.npmjs.com/package/@fastify/swagger-ui/v/6.1.2 | 2026-10-17 | `sha512-rG5EvbuzzH38XYULa9OVrSg3XngXlHmPFbuU4MKdrzx/lGHCvfPITIy7twnECBf7Ws4t2ZvwMa5UUe0T2+V49w==` |
| `@metamask/connect-evm` | 2.1.1 | https://www.npmjs.com/package/@metamask/connect-evm/v/2.1.1 | 2026-10-17 | `sha512-pkaY0EslsWHe1slSsFSFMAHTqwSa1Twd4hBMe2KLuf+D01h0Al8X7YOYZnT6Zd2Ck0KmQGLSTUh7hZyHT4n0nw==` |
| `@noble/curves` | 2.4.0 | https://www.npmjs.com/package/@noble/curves/v/2.4.0 | 2026-10-17 | `sha512-P4/62zrgfH33CneE3Dn4WhJVA22YUU0eR51wKIan4NVRvwsA0YnPTwWGpNbpuacSujmSFLvyzpyuR30+fbq2Ew==` |
| `@noble/hashes` | 2.4.0 | https://www.npmjs.com/package/@noble/hashes/v/2.4.0 | 2026-10-17 | `sha512-X5XaVWZIBCT7HHZGm5I7ZQXDwLG+bGXuSrMQAW+7Zvl87h1kmc1ZB1VSRJcpUfoUrGQp4Fkoxm5kZ+Ms+aW+eA==` |
| `@node-rs/argon2` | 2.2.2 | https://www.npmjs.com/package/@node-rs/argon2/v/2.2.2 | 2026-10-17 | `sha512-NtdlPPWtR5U4BxX5EGJYza+UklNaoWORmkaKCMqf/nyKeXWKVwNt8KfQoRpNT7OB1DcEwmePafO4wZyW+sbfCQ==` |
| `@playwright/test` | 1.64.1 | https://www.npmjs.com/package/@playwright/test/v/1.64.1 | 2026-10-17 | `sha512-IaYGml/nSOiZWROfPtuIL7neuu9qDOZ3TNvNljUIrhDMxiGTgPjzj/g9p9RxpS2tSepPDRY+UwAaEeiKtUvIAg==` |
| `@scure/base` | 2.4.0 | https://www.npmjs.com/package/@scure/base/v/2.4.0 | 2026-10-17 | `sha512-thZ1TuJwFwBblOhgsjDKvvGirBxNp+wSvY/DR6tJBJOTDhdAAcHJ8Vbr2eFnqaxeca4+t0i9KBf+uHYGWwZORg==` |
| `@serenity-kit/opaque` | 1.1.0 | https://www.npmjs.com/package/@serenity-kit/opaque/v/1.1.0 | 2026-10-17 | `sha512-Y6v/+hRMn0MdMEk5+/ArM0vPIiFfFEbdTZc7oAx+cWyvGODGezAQ/sMjXBVogf7NsS9z9EV0Ve5paZCVULuedw==` |
| `@tanstack/react-query` | 5.104.3 | https://www.npmjs.com/package/@tanstack/react-query/v/5.104.3 | 2026-10-17 | `sha512-5Ts1ImwJKqoJgPkLxl9WrPQy1JEoEmti3MaaODCfBamHUGFk57IFrc+AIksPq+BAm10EsroX56qm398Z42LG7w==` |
| `@testcontainers/postgresql` | 12.2.1 | https://www.npmjs.com/package/@testcontainers/postgresql/v/12.2.1 | 2026-10-17 | `sha512-MIbI5KjZ9M4SY4+xzxg/w4ZLBeV+Jd6ognXoWn7dh/mhIhBbn7ss0MiZHNg2XbCbu03BW9YQ9+H9xW8PFkJWaA==` |
| `@testcontainers/redis` | 12.2.1 | https://www.npmjs.com/package/@testcontainers/redis/v/12.2.1 | 2026-10-17 | `sha512-pF/HAs0LEsSfuQv++Wyp36S9cFNo8vfweddUOJQl/+wuAW1ThlupJLQv7L4PKkpqYGq+epRuaKhPrNKKnmbU3g==` |
| `@vitejs/plugin-react` | 6.1.2 | https://www.npmjs.com/package/@vitejs/plugin-react/v/6.1.2 | 2026-10-17 | `sha512-fhJNGUdscQa4HkI0xFxwonWyhnVReCPDbXI7FH7jmzpnVCrFQI7PRrhWecO263610vOrs9tr2Y4xcf8uAdFxbw==` |
| `@wagmi/connectors` | 8.2.0 | https://www.npmjs.com/package/@wagmi/connectors/v/8.2.0 | 2026-10-17 | `sha512-hPwdmePYjQqSWlw9JmzrzVgmw2PJ+NJsUQ/BuPBYbzBS8+cW5vWdqiaKLB4qTF9m+yr+zSp7u91KBgvOWz50og==` |
| `@wagmi/core` | 3.6.5 | https://www.npmjs.com/package/@wagmi/core/v/3.6.5 | 2026-10-17 | `sha512-zfKvLNT1V1+/RgrrUcRvteKx+V+Iv9ZHPWseIVKFA9mX5WE0H8J6zWZGWXSQCKbz5xGSUoatNFCkNFSzqQp+AA==` |
| `@walletconnect/ethereum-provider` | 2.26.0 | https://www.npmjs.com/package/@walletconnect/ethereum-provider/v/2.26.0 | 2026-10-17 | `sha512-C6Ld+Gv1OurPYvAbFGXRuvthIp4datYqDlmRGjWRWXkkIerijo05vwrH5cGNj9bK93FSfGScqaL2Ig2LvX3QhQ==` |
| `bullmq` | 6.3.15 | https://www.npmjs.com/package/bullmq/v/6.3.15 | 2026-10-17 | `sha512-J6EZH/DhfGnsIafSK2FfNJ6XtSAQnD4YM1vts5+jT4usLYkxV2uU72oKNpmyxUQl9U4sFEvK5MO5SJ+dGlwOLQ==` |
| `eslint` | 10.13.0 | https://www.npmjs.com/package/eslint/v/10.13.0 | 2026-10-17 | `sha512-UohDjD4zSzEwhf58M3O7vc/ycc8O1I7dNlhtD0WxE8Px8EHNJKtUwzBqrzeGhisRuv2ag4sAYswszCJRgKXYUg==` |
| `fastify` | 5.12.7 | https://www.npmjs.com/package/fastify/v/5.12.7 | 2026-10-17 | `sha512-v4pEPsTRPuqlDIYiQFB+BHjVN4SdHX9u0ABk0ZDUKbbdY1vsNryUd1j4Z+jQEZajvYIVk047Kimva9/AJ79GYw==` |
| `fastify-type-provider-zod` | 7.0.0 | https://www.npmjs.com/package/fastify-type-provider-zod/v/7.0.0 | 2026-10-17 | `sha512-yUEKMyy+kml+4fzUU9GxVtYVKmPKNFo8OVd2N/RH2I/7JZiKvOqF1BUj3f/JJU3DDQDM7pMv2bf/Y8COPaxUWg==` |
| `ioredis` | 6.0.0 | https://www.npmjs.com/package/ioredis/v/6.0.0 | 2026-10-17 | `sha512-f+Dtubxfpf6KYFq7WVXJoOLn0bk4TJrMrN9SzeE+jrWrCWj7XX3fA6vkryafhADX+GMymRxgDJDOI33COkJc0w==` |
| `kysely` | 0.29.6 | https://www.npmjs.com/package/kysely/v/0.29.6 | 2026-10-17 | `sha512-hHaB8C/rfzDDtr/t8YZwxAuPJTT0zHyaPoVzcXwDYhYNAgH/4sIfVhi/XLLIY+bL/FqaIJnjATDbi8ObSELmxg==` |
| `niceware` | 4.0.0 | https://www.npmjs.com/package/niceware/v/4.0.0 | 2026-10-17 | `sha512-7uFcxHr5zwNZO4NEMwxK0N+GbqVMGp2YLZ8x/0dx/nxiT0qCt1zL3hZfqawQoq4XiP2OWa665Xid0g/LyoMfQA==` |
| `nodemailer` | 10.1.2 | https://www.npmjs.com/package/nodemailer/v/10.1.2 | 2026-10-17 | `sha512-rnQn9Rzh8RAwcp42MVsIvxbsv6YZ2a2/av+uyJ/LPU1+2QSlrRgFsWWZTKenyRUqkIl8urOI0c4+CEcmFdsvQw==` |
| `otpauth` | 9.5.2 | https://www.npmjs.com/package/otpauth/v/9.5.2 | 2026-10-17 | `sha512-GQ5emWR/x1tcExT62IBT0UfO95wZzJZyxYOJOGVeQF47SYEN9vmh0vISvDZaNMuFJRG+IaWCKtfm+t9Bfoal6w==` |
| `pg` | 8.23.1 | https://www.npmjs.com/package/pg/v/8.23.1 | 2026-10-17 | `sha512-aL96AHANtWjPLDOLqnhx+ngp9+UK7ETEU8VJrDCGvsSSi/mGLcWYsS6Herg7lmaBJe4uwrfqsa7gTEFaSizDoQ==` |
| `pino` | 10.4.0 | https://www.npmjs.com/package/pino/v/10.4.0 | 2026-10-17 | `sha512-bk1ZMTwG/Vymx+zPoa28MhNzucFvXJWp3csrSuxuHPSMeUettaCoQ5Jvg07mtC4JGNpcfTwz41oVCnNgBK9+vA==` |
| `prettier` | 3.9.10 | https://www.npmjs.com/package/prettier/v/3.9.10 | 2026-10-17 | `sha512-skGHTH1Yb9QvaTC4hWnRTzEYtCpApF0UMBPz+t/0ZPzP8ihefo/btKd+QA7pUE0fEwA1SbS/NmhyEcstdXOIdA==` |
| `prom-client` | 15.1.3 | https://www.npmjs.com/package/prom-client/v/15.1.3 | 2026-10-17 | `sha512-6ZiOBfCywsD4k1BN9IX0uZhF+tJkV8q8llP64G5Hajs4JOeVLPCwpPVcpXy3BwYiUGgyJzsJJQeOIv7+hDSq8g==` |
| `react` | 19.3.1 | https://www.npmjs.com/package/react/v/19.3.1 | 2026-10-17 | `sha512-QNhWdt7nrgVWWQG58QuGsAR3jv3Hbe4mb4vz7w2csnHavciZJgda1CPNaldF6eVxv90ud3jUXpKlHL69gO38yw==` |
| `react-dom` | 19.3.1 | https://www.npmjs.com/package/react-dom/v/19.3.1 | 2026-10-17 | `sha512-Y0bARz53lhEC1NMCASs0/j+faB/zqt3R8hpvg1e8+61ZVJ4UL0UdC4cBbXfZMcIuhrfgeILTLe+ZeBCavQPtKQ==` |
| `react-router` | 8.4.0 | https://www.npmjs.com/package/react-router/v/8.4.0 | 2026-10-17 | `sha512-JtydAkBvU9UTEe5qNC+POhu+ZBNM7rlKY2IegwXc7Idj7xfRG16x5RZrw3mju+XlqBxfvb2ky9P3jUp9WyWC1g==` |
| `testcontainers` | 12.2.1 | https://www.npmjs.com/package/testcontainers/v/12.2.1 | 2026-10-17 | `sha512-JfbCyOvLdzatwgqUI3AvYCwRW0P5mCkKQVBPO8U5qSH1efC2kHvnfWmi9VHloy1rAFG2MEqWZObRH4bq0gU1kQ==` |
| `typescript` | 6.0.3 | https://www.npmjs.com/package/typescript/v/6.0.3 | 2026-10-17 | `sha512-y2TvuxSZPDyQakkFRPZHKFm+KKVqIisdg9/CZwm9ftvKXLP8NRWj38/ODjNbr43SsoXqNuAisEf1GdCxqWcdBw==` |
| `typescript-eslint` | 8.71.2 | https://www.npmjs.com/package/typescript-eslint/v/8.71.2 | 2026-10-17 | `sha512-Rz4effbMy2g9wnvOJZG6SbVavX313Lap1vNEbk1RUochzickvzP8P4HB+bkNg5e50eVz1hQGjh9K1omI1xB4Bw==` |
| `viem` | 2.57.7 | https://www.npmjs.com/package/viem/v/2.57.7 | 2026-10-17 | `sha512-x3UqqrcQuESaRVK6a0BvNmoNP0SVhu913uxEAxYLJx1lNYnj6ylTntfUdakCUKjk1+T+63gkdwFGJQ2O5C/nRw==` |
| `vite` | 8.3.4 | https://www.npmjs.com/package/vite/v/8.3.4 | 2026-10-17 | `sha512-IftLE8phJhdNRIGNEV4JCCvfNScoZQVfcXaN8TQropWGJtOHcu+iAB9pHcuGvmEb/kddw0LBe/jS8ztdC6xdiQ==` |
| `vitest` | 5.0.5 | https://www.npmjs.com/package/vitest/v/5.0.5 | 2026-10-17 | `sha512-cPODOMF8YnkiiYtDdHo6n4wWmBrOBBbOIYH2d33M4l3CdNn72h+qMmO6uXffUN6A5AZFXNND/d+krS9mgkXRfg==` |
| `wagmi` | 3.7.7 | https://www.npmjs.com/package/wagmi/v/3.7.7 | 2026-10-17 | `sha512-J9YTRKwOVt+L135nMiitwGALrJqpXFhLX8AZzbECWeAQ1aI9Uz8Pz0GGMqtbKe7xJtmOx838OChT7YkMs9k8OA==` |
| `zod` | 4.6.7 | https://www.npmjs.com/package/zod/v/4.6.7 | 2026-10-17 | `sha512-g8W2D2kU6a8untc053fX1uVBKzM7yqAxW/3zwk83+6RyF2+SKOuV+c0wBDhUwzV1PaGapmZH+rmcUzPf+3CGwg==` |

Versiones adicionales fijadas en esta verificación (no estaban en la tabla §3.6 del planner):

- `jose` 6.2.12 — JWS/JWT (ADR-009) (dist-tag `latest` del registry al 2026-10-17).
- `@reown/walletkit` 1.6.0 — wallet headless para el test del relay real de WalletConnect (P19.MAN) (dist-tag `latest` del registry al 2026-10-17).
- `@walletconnect/core` 2.26.0 — dependencia de @reown/walletkit (misma línea que @walletconnect/ethereum-provider) (dist-tag `latest` del registry al 2026-10-17).

### Versiones efectivas de `backend/app` (edad mínima de publicación)

La política de [supply chain](#supply-chain) (`minimumReleaseAge: 10080`, 7 días) no instala versiones publicadas hace menos de una semana. Al crear `backend/app` (P08, 2026-10-17) estas versiones de la tabla todavía no tenían 7 días: se fijó la última versión de la misma línea que sí los cumplía. La versión de la tabla se adopta en el primer cambio de dependencias del proyecto posterior a su fecha de elegibilidad, con el mismo control de edad.

| Paquete | Tabla (publicada) | Elegible desde | Fijada en `backend/app` (publicada) | Integridad (lockfile) |
|---|---|---|---|---|
| `fastify` | 5.12.7 (2026-10-13) | 2026-10-20 | 5.12.5 (2026-09-16) | `sha512-OB2k1dlxs5/NAABqeKV2FUHkSD2BbENsCak8yULVcymn3fHIPDVa9TI3SDnJSWYSllZmSYuZXy2gTnsT+Sut1A==` |
| `@fastify/helmet` | 13.2.0 (2026-10-13) | 2026-10-20 | 13.1.2 (2026-10-08) | `sha512-fXTultrEFW9bczr3jcffZD7NLlsTYa8eCCzVFsJvLIVO7SUiY/VWp18qCJbf2N9AXIEzIC11NYlNB3BlzBEZeg==` |
| `zod` | 4.6.7 (2026-10-12) | 2026-10-19 | 4.6.5 (2026-09-13) | `sha512-v5l/aFXZQeai4awLbOpSoHecE9UiMrnfx75tEXLjNonXVARxQ5mOeipTjROUchszUNCqnE+hqAMujRsRHsut2Q==` |
| `bullmq` | 6.3.15 (2026-10-14) | 2026-10-21 | 6.3.12 (2026-10-09) | `sha512-zuPU+RbyiTzRtxVeokO0EotJ+PkHyAEXugEAYYyP+pm7bbJAbrvQR1SHW6MCUgA0e4C23/07dcOCymEe+GNGHw==` |
| `nodemailer` | 10.1.2 (2026-10-16) | 2026-10-23 | 10.0.16 (2026-10-07) | `sha512-VL9xKErxN+el77o8eBOuYKUPMyEx7F9hfnDCuiUKJRp9v3wnWMOudYgP/SWbwSHy8rUL4cylobuXtki1LpQS7A==` |
| `viem` | 2.57.7 (2026-10-14) | 2026-10-21 | 2.57.4 (2026-10-08) | `sha512-ro+8AKrcGU6tPfou0gBRYv6bxnU3tPxxJGY4qpJwjiR40eHCWzeGhrAgYMlIncFtlnry2/yGjz57WOC67oshCQ==` |
| `vitest` | 5.0.5 (2026-10-15) | 2026-10-22 | 5.0.3 (2026-09-30) | `sha512-xMw97S3rjdtj5dkVat7jCsqWBpvchs3RlpQctUqwJD0KkERk40vz2fJ77lDwW/Vzh/pk18eItYAzkodhSes3jQ==` |
| `testcontainers` | 12.2.1 (2026-10-13) | 2026-10-20 | 12.2.0 (2026-09-28) | `sha512-Pd0c2eU0DdIuK+Pb3c+vmBUdKjDLgxZmPecQGESFAKyn5LTqSaSw8l7htfMlLwabb/QsUILe6XkxMJw8Ly/ThA==` |
| `@testcontainers/postgresql` | 12.2.1 (2026-10-13) | 2026-10-20 | 12.2.0 (2026-09-28) | `sha512-14oNBbKdqIkWTiw8XwP6YqWnuBebiij8m4fF03WTSHvNt5FfvQpGTLwIV3p07UpDnqWRFvY50YFzbiYdB+SWuA==` |
| `@testcontainers/redis` | 12.2.1 (2026-10-13) | 2026-10-20 | 12.2.0 (2026-09-28) | `sha512-ZwD+aUL5LDHT4BIVzzbpPJitXqUibKt8UyFgWGzQbw9YoIaQdRrBbdY7Y+L4th7nYwmV+1UI1iO9XtJzadXnAw==` |
| `eslint` | 10.13.0 (2026-10-16) | 2026-10-23 | 10.12.0 (2026-10-02) | `sha512-npHjrHb2o4ehH3mE+YuxABR+0gyb0aVWCIolgJDArwCiHEIsonBm3ZKjel5b0U5+a+MbEvIyRCGCzD3eKKK2NA==` |
| `typescript-eslint` | 8.71.2 (2026-10-12) | 2026-10-19 | 8.71.1 (2026-10-05) | `sha512-oiNVPC3/NbV1FpaHU07l8O6ynqG9v4PAiW2WvTrAmZdR0f2HI/gE668ElMLCK7Xbsu5k2fK5C4fXNiq05j7/nQ==` |

El resto de las dependencias de `backend/app` usa exactamente la versión de la tabla. Dependencias de desarrollo que no figuran en la tabla (fijadas el 2026-10-17, todas con más de 7 días):

- `@vitest/coverage-v8` 5.0.3 (2026-09-30) — cobertura V8 de la misma línea que `vitest` — `sha512-+klsyz7BvT1vCU28Zkfzms1Ia78XD0V41U3FUtRaa3S+vOr/EXvK1O6BvVD7l1RzEjm6SONR2aybOvDDf9u0mQ==`.
- `@eslint/js` 10.0.1 (2026-02-06) — reglas base de ESLint 10 — `sha512-zeR9k5pd4gxjZ0abRoIaxdc7I3nDktoXZk2qOv9gCNWx3mVwEn32VRhyLaRsDiJjTs0xq/T8mfPtyuXu7GWBcA==`.
- `@types/node` 26.6.5 (2026-10-09) — tipos de Node 26 — `sha512-uMzsv9stDdofIZBx4UGh4Z9ZgXnGC9seRDscilBcTHAeOFk67MZg/k9bWVfO+bk4qZmG+l52hRnLwUiH2LnJTg==`.
- `@types/pg` 8.23.1 (2026-08-17) — tipos de `pg` — `sha512-fKVHpikPdg4GKks3JuLEhvwSyvwzF23hnabPy6DD8ljVbC7+6J5dQzdv4arV6jqq57djnMgs1HKBxX4P8aBI3A==`.
- `@types/nodemailer` 8.0.2 (2026-09-15) — tipos de `nodemailer` — `sha512-c7M5ox8p0nEOfbJ2E9Qcmt8/QCu/VzsiAhzBiZbvky2PhKZDHpKB3sQHBM5MEZNkCfBOaS6S9//AGPRTNB7IaA==`.

Scripts de instalación denegados en `backend/app/pnpm-workspace.yaml` (`allowBuilds: false`, cada uno con su motivo): `cpu-features` y `ssh2` (addons nativos opcionales de Testcontainers), `msgpackr-extract` (aceleración opcional de BullMQ) y `protobufjs` (postinstall de compatibilidad).

## Herramientas de seguridad y de infraestructura

| Componente | Versión | Tag / commit | Verificado |
|---|---|---|---|
| Semgrep | 1.181.0 | `v1.181.0` = `77a9477dbb1d7e8780d6113adc7c8204dac83150` | 2026-10-17 |
| OSV-Scanner | 2.7.0 | `v2.7.0` = `7ef17deffedb9e9b751fe6c6c328a88de29d9cf4` | 2026-10-17 |
| zizmor | 1.31.1 | `v1.31.1` = `effdb35fa7868863f11655db256d9008922fa427` | 2026-10-17 |
| syft | 1.54.1 | `v1.54.1` = `749cd89ef26db65d5102d879f5dd63a174312b1e` | 2026-10-17 |
| Trivy | 0.76.0 | `v0.76.0` = `531360e5d2a88e732373f1614ba99a38738538b8` | 2026-10-17 |
| pgBackRest | 2.59.3 | `release/2.59.3` = `46cdca625a73403cad4774d97354a1fac1e91e51` | 2026-10-17 |
| age | 1.3.2 | `v1.3.2` = `b74dce4cdbe35b5e5f66c06d9612b72f89028758` | 2026-10-17 |
| Caddy | 2.11.7 | `v2.11.7` = `87c43dc4f54861ec7e54302cfb2ad3e34508b6dc` | 2026-10-17 |
| Prometheus | 3.15.0 | `v3.15.0` = `e9d9395a3ff7b6f3bdb6833f0816e2716efa6dff` | 2026-10-17 |
| Alertmanager | 0.34.1 | `v0.34.1` = `35aab4b30bd2c50bc058d58fcb9fe817893f9ea5` | 2026-10-17 |
| Grafana (OSS) | 13.2.4 | `v13.2.4` = `6259becc8e86265fdf35a73e08eef5bd92b5cd73` | 2026-10-17 |

## GitHub Actions (fijadas por SHA de commit, P02)

| Acción | Release | Commit |
|---|---|---|
| `actions/checkout` | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `actions/cache` | v6.1.0 | `55cc8345863c7cc4c66a329aec7e433d2d1c52a9` |
| `actions/upload-artifact` | v7.0.2 | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` |
| `actions/download-artifact` | v8.0.2 | `9000827ccba6bdab643e8b6fd33ac0654aef8333` |

## Supply chain

Política aplicada a **cada** proyecto pnpm al crearlo (P01.T05) y verificada por `node scripts/check-pnpm-policy.mjs`. Con pnpm 12 sólo la autenticación y el registry se leen de `.npmrc`; el resto de los settings vive en el `pnpm-workspace.yaml` del proyecto (documentación oficial: https://pnpm.io/settings, https://pnpm.io/settings/dependency-resolution, https://pnpm.io/settings/build, https://pnpm.io/settings/peer-dependencies; consultada el 2026-10-17):

```yaml
# <proyecto>/pnpm-workspace.yaml
saveExact: true                # versiones exactas al agregar dependencias
strictPeerDependencies: true   # falla ante peers faltantes o inválidos
minimumReleaseAge: 10080       # 7 días: no instala versiones publicadas hace menos
strictDepBuilds: true          # falla si una dependencia tiene scripts de instalación no revisados
allowBuilds:                   # allowlist explícita (vacía salvo necesidad justificada)
  esbuild: true                # ejemplo: sólo si el proyecto lo usa, con su justificación
```

Además: `package.json` sólo con versiones exactas (sin `^`, `~`, `latest`) y `packageManager: "pnpm@12.14.0"`; instalación en CI con `pnpm install --frozen-lockfile`; un lockfile por proyecto (ADR-001); `dangerouslyAllowAllBuilds` prohibido. Cambio respecto del planner: la política se expresaba como `.npmrc`; se materializa en `pnpm-workspace.yaml` porque pnpm 12 ya no lee esos settings de `.npmrc`.
