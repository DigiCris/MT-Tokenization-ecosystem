# ADR-010 — Dominios y hosts de API separados por app

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-010), §2.2, §5.1, §5.3, §5.5, §7.1 ([B-AUTH-04], [B-AUTH-05]), §7.11 ([B-AUTHZ]), §8.7 ([F-LNK-01], [F-LNK-02]), §13.1 (H-02, H-03); V9 §2, §17; prompt §3 (Trust domains), §4, §22; CF-07, CF-10, CF-11

## Contexto

V9 §2 exige que los tres trust domains sean administrativamente independientes: comprometer el Backend/Signer no debe permitir desplegar o modificar el Wallet Frontend ni el Recovery, y viceversa. V9 §17 incluye "Hosting/DNS separado" entre las separaciones entre Wallet y Recovery. El prompt §4 pide que Wallet y Recovery se puedan ejecutar y desplegar por separado, y el §22 exige cookies `HttpOnly`, `Secure` y `SameSite`.

CF-07 registra la tensión entre esos requisitos y el target de producción (backend en una VPS Linux propia) y la resuelve con un host y un host de API propios por frontend, ambos hosts de API apuntando al mismo backend, con cookies `__Host-` por host y sesiones separadas por cliente; por decisión del owner (2026-10-17) cada frontend se sirve desde un servidor propio. CF-10 registra el riesgo residual del host del backend y CF-11 el de la separación de DNS que exige V9 §17.

## Decisión

Dominios: `wallet.<WALLET_DOMAIN>` + `api.<WALLET_DOMAIN>`; `recovery.<RECOVERY_DOMAIN>` + `api.<RECOVERY_DOMAIN>`, siempre en origins distintos. Ambos hosts de API apuntan al mismo backend con listeners y scopes separados; las cookies son host-only por host de API.

**Aislamiento de hosting (decisión del owner, 2026-10-17):** en el despliegue final los subdominios de Wallet y de Recovery apuntan a **servidores distintos** entre sí y del backend. **DNS (CF-11):** V9 §17 pide DNS separado; se cumple si los hosts de Wallet y de Recovery están en dominios registrables distintos con cuentas de DNS distintas. Si el owner usa subdominios de un mismo dominio, el go-live exige su aceptación escrita de RR-11 (H-02, P30.T06). `WALLET_DOMAIN` y `RECOVERY_DOMAIN` son variables independientes: el software y los artefactos de P26 soportan ambas variantes sin cambios de código.

Detalle:

- **Listeners:** el proceso de la API expone un listener para el cliente Wallet (puerto interno 8080) y otro para el cliente Recovery (8081) (§5.3, §5.5); cada uno expone sólo sus rutas: el de Recovery no expone send, swap ni alta de whitelist, y el de Wallet no expone el envío de enrollment ni propuestas firmadas por R ([B-AUTHZ] punto 3).
- **Cookies de cuenta:** `__Host-mtw_sid` en el listener Wallet y `__Host-mtr_sid` en el listener Recovery, con `HttpOnly; Secure; SameSite=Strict; Path=/` ([B-AUTH-04]).
- **CORS y CSRF:** CORS estricto por listener (sólo el origin de su frontend, `credentials: true`, P08.T08) y `Origin` exacto permitido para ese listener en todo método no-GET ([B-AUTH-05]).
- **Enlaces entre apps:** por fragmento, que no llega a los servidores: `https://recovery.<RECOVERY_DOMAIN>/enroll#eid=<enrollmentId>&n=<nonce>&k=<k>` y `https://wallet.<WALLET_DOMAIN>/onboarding/confirm-recovery#eid=<id>&r=<R>&k=<k>` ([F-LNK-01], [F-LNK-02]); `k` es el secreto del pedido que genera la Wallet y el backend nunca ve (ADR-033).
- **En producción:** cada frontend se sirve desde su propio contenedor estático (`wallet-web`, `recovery-web`) en su propio servidor; los reverse proxies y el DNS se configuran a mano al desplegar (CF-07, ADR-022); TLS termina en el reverse proxy de cada servidor y la API sólo confía en `X-Forwarded-*` desde `TRUSTED_PROXY_CIDRS` (§5.5).

## Alternativas consideradas

- **Servir la API en el mismo origin que el frontend:** descartado; la API va en un origin distinto para que un backend comprometido no pueda servir JavaScript en el origin de U o de R (§4).
- **Subdominios de un mismo dominio para Wallet y Recovery sin más:** no se adopta como regla, porque deja una sola cuenta de DNS para ambas apps y contradice V9 §17. El software los admite (el owner eligió subdominios en servidores distintos), pero ese caso es un desvío registrado en CF-11 que requiere la aceptación escrita del owner en el go-live; dominios registrables con cuentas de DNS distintas para Wallet y Recovery lo eliminan sin cambios de código.
- **Un único host de API para los dos clientes:** no se adopta; un host por app permite cookies host-only y sesiones separadas por cliente (CF-07).

## Consecuencias

- Un backend comprometido no puede servir código en los origins criptográficos, y las sesiones de cuenta de Wallet y Recovery quedan aisladas entre sí.
- Hay que administrar los registros DNS de cuatro hosts (`wallet.`, `api.` de Wallet, `recovery.`, `api.` de Recovery), más la configuración de CORS, CSRF y Swagger por listener.
- El backend y S corren en la VPS (ADR-022); los frontends se sirven desde servidores distintos (decisión del owner), cada uno con su contenedor estático (`wallet-web`, `recovery-web`). Así el root del host del backend no puede modificar lo que se sirve a los navegadores (CF-10); queda el riesgo de DNS de CF-11 si ambos hosts comparten cuenta de DNS (RR-11).
- Los dominios reales y los servicios asociados (clientes OAuth, proyectos de Reown, claves de RPC por componente) se configuran en el despliegue final, fuera del planner (H-02, H-03). Durante el planner, el ensayo de producción usa dominios `*.mtw.test` resueltos localmente (P30.T04).

## Verificación

- P08.T08 — dos listeners con CORS estricto por listener (`test/api/server-cors.test.ts`).
- P08.MAN — la spec de `/docs` lista sólo lo que corresponde a cada listener.
- P09.T03 y P09.TST.c — CSRF ausente o incorrecto, `Origin` extraño y `Content-Type` no JSON.
- P09.TST.f — atributos de cookies (`__Host-`, HttpOnly, Secure, SameSite=Strict, Path=/).
- P14.T06 — tests de IDOR de [B-AUTHZ] en los endpoints de lectura.
- P26.T04 — contrato documentado con el reverse proxy existente.
- P26.T10 — requisitos de DNS y TLS: hosts `wallet.` y `recovery.` en servidores distintos, hosts `api.` apuntando al host del backend, y cuentas de DNS distintas o aceptación escrita de RR-11 (CF-11).
- P26.T11 — headers de seguridad verificados en el ensayo local de producción.
- P26.T17.j — riesgos residuales del host del backend (CF-10) y de la separación de hosting y DNS de los frontends (CF-11) documentados en `THREAT_MODEL.md`.
- P30.T04 — ensayo de producción con frontends construidos para dominios `*.mtw.test`.
- Trazabilidad: RQ-08, RQ-92.
