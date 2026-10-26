# E2E de MT Wallet (P22) y acceptance full-system (P23)

Proyecto propio (su `package.json`, su lockfile y la misma política de supply chain que el resto, ver
[`docs/VERSIONS.md`](../docs/VERSIONS.md#supply-chain)). Prueba los flujos de punta a punta con **las dos apps reales**
(Wallet y Recovery) compiladas contra **un mismo stack local real**: backend, worker, gas tank, signer, PostgreSQL,
Valkey, Mailpit y Anvil sobre el fork de Base en el bloque fijado, con los contratos del sistema desplegados.

## Correr

```bash
source ../scripts/env.sh
pnpm install --frozen-lockfile
pnpm test                                      # matriz completa: Chromium, Firefox y WebKit (P22.T05)
MTW_BROWSERS=chromium pnpm test specs/send     # un navegador y un filtro (argumentos de `playwright test`)
MTW_E2E_RECORD=1 pnpm test                     # video y trace de todo, para revisar los flujos críticos (P22.MAN)
pnpm lint && pnpm typecheck                    # `pnpm build` es el typecheck (checkpoint de P22)
```

`pnpm test` corre [`scripts/test-e2e.mjs`](scripts/test-e2e.mjs):

1. navegadores en la imagen fijada de Playwright si hacen falta (fuera de GitHub Actions, Firefox y WebKit corren en
   el contenedor de `wallet/scripts/lib/browser-server.mjs`);
2. un stack aislado (`wallet/scripts/stack/stack.mjs`) con los orígenes de las dos vistas previas
   (`MTW_E2E_WALLET_PORT`, por defecto 4274, y `MTW_E2E_RECOVERY_PORT`, 5274);
3. build de cada app contra ese stack (install congelado, design tokens verificados y el entorno `ci` con las URLs, los
   contratos y la clave de atestación del stack);
4. `playwright test` (el `webServer` de [`playwright.config.ts`](playwright.config.ts) levanta las dos vistas previas)
   y, pase lo que pase, desarma todo; si algo falla, deja los logs del stack e informa dónde.

Sin reintentos y con un solo worker: los specs comparten el stack, la cadena y la cuenta de prueba de Drive. El criterio
de P22 son tres corridas seguidas en verde en los tres navegadores.

## Estructura

| Ruta                                     | Qué tiene                                                                                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `specs/fixtures-selftest.spec.ts`        | P22.T01: las fixtures contra el stack real.                                                                                                          |
| `specs/*.spec.ts`                        | Un spec por flujo de P22.T02 (cuenta, Safe, enrollment de R, activos, whitelist, envíos, swaps, estados, recuperación, rotaciones, restauraciones).  |
| `specs/security/`                        | P22.T03: allowlist de hosts, CSP y Trusted Types, service workers, canarios de claves, Passwords y tokens, bloqueo por inactividad y sesión vencida. |
| `fixtures/stack.ts`                      | Estado del stack (`MTW_STACK_STATE`), orígenes, rate limiting y plataforma apagada.                                                                  |
| `fixtures/mailpit.ts`                    | Códigos y enlaces de los emails que el worker entregó a Mailpit.                                                                                     |
| `fixtures/fork.ts`                       | Sólo de test: reloj de la cadena con los bloques de confirmación, USDC/USDT reales y ETH para el gas.                                                |
| `fixtures/users.ts`                      | Cuentas y wallets armadas por API para los specs que no prueban esos pasos.                                                                          |
| `fixtures/test-wallet-provider.ts`       | Wallet externa de prueba (EIP-6963) que firma en Node con una clave de prueba.                                                                       |
| `fixtures/drive.ts`                      | Drive real: token de la cuenta de prueba y consentimiento respondido por el test.                                                                    |
| `fixtures/wallet/`, `fixtures/recovery/` | Helpers de pantalla y de API de cada app, adaptados de sus tests del stack.                                                                          |

Las fixtures importan módulos de las apps (cliente de API, cripto, ABIs) sólo para preparar escenarios desde Node, igual
que los tests del stack de cada app. Los helpers que usan Playwright viven acá: una corrida no puede mezclar dos
instancias de `@playwright/test`.

## Reglas

- **Nunca revocar el permiso de Google de la cuenta de prueba.** Las apps revocan el token de Drive al cerrar sesión o
  bloquearse; si un token real llega a `https://oauth2.googleapis.com/revoke`, Google revoca el permiso entero (Drive y
  Gmail juntos). `answerGoogleConsent` instala antes `blockGoogleRevocation` en el contexto: un script previo a la app
  responde ahí mismo cualquier `fetch` o `sendBeacon` a `/revoke` y la ruta del contexto es la segunda capa. Todo spec
  que entregue un token real a una página lo hace por ese camino.
- Los specs no comparten estado entre sí: cada uno crea sus cuentas y wallets.
- Después de un clic que dispara un pedido, se espera el efecto (un elemento visible o `expect.poll`), nunca se lee el
  estado enseguida.
- La app Recovery deja un espacio antes del texto de sus casillas: se buscan por el texto completo con `exact: true`.
