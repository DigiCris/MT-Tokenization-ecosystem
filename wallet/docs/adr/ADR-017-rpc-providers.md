# ADR-017 — Proveedores RPC independientes por trust domain

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-017), §3.1, §5.1 (regla 5), §7.7 ([B-FIN-02]), §7.8 ([B-RPC-01] a [B-RPC-04]), §7.14 ([B-OBS]), §8.5 ([F-SEC-01]), §9.3, §13.1 (H-03), P00 (PF-13, PF-14, PF-16); V9 §2; prompt §6, §17

## Contexto

El prompt §17 pide no acoplar el sistema a un único proveedor RPC: una abstracción con RPC primario y secundario, health checks, y decisiones sensibles que nunca se basen en una respuesta inconsistente sin posibilidad de reintento o revalidación. El prompt §6 define `BASE_RPC_URL` para el fork reproducible de Base mainnet, lo que exige un RPC archive (los checks PF-13 y PF-14 lo validan).

V9 §2 exige trust domains administrativamente independientes. Aplicado a la lectura de cadena, eso implica que el signer no debe depender de las credenciales RPC del backend y que los frontends deben poder verificar la Safe sin pasar sólo por el backend (§5.1, regla 5). El threat model (§9.3) incluye un proveedor RPC malicioso o inconsistente.

## Decisión

RPC: **Alchemy** (primario, archive, también para el fork) + **QuickNode** (secundario) en el backend; el signer usa **sus propias** claves de ambos proveedores; cada frontend usa su propia clave de Alchemy con allowlist de dominio. Las lecturas sensibles se hacen con quórum en un bloque fijo.

Detalle ([B-RPC]):

- **Cliente de quórum** ([B-RPC-01]): `RpcQuorumClient` sobre viem con dos transports independientes (primario y secundario) y health checks de chainId, head lag y latencia cada 10 s.
- **Lecturas sensibles** ([B-RPC-02]) —nonce de la Safe, roles, whitelist, saldo para policy, receipts, código y codehash—: se fija un `blockNumber` común (`min(headA, headB) - 1`) y se consulta en ambos; si las respuestas difieren, se reintenta con backoff; si el desacuerdo persiste, se registra `RPC_DISAGREEMENT` y no se toma la decisión. En local (`RPC_QUORUM_MODE=local-single`) ambos transports apuntan a Anvil y el modo dual se prueba con un proxy de inyección de fallas (sólo de test) delante del fork real.
- **Escrituras** ([B-RPC-03]): `eth_sendRawTransaction` a ambos proveedores; éxito si al menos uno acepta o si el tx hash ya es conocido.
- **Signer** ([B-RPC-04]): credenciales RPC propias, sin reutilizar las del backend.
- **Frontends** (§5.1, regla 5): leen la cadena con su propio RPC para verificar la Safe, saldos, whitelist y rotaciones pendientes; la URL de su RPC figura en el `connect-src` de la CSP ([F-SEC-01]).
- **Preflight:** PF-13 (`eth_chainId == 0x2105`, latencia < 2 s), PF-14 (`BASE_RPC_URL` archive en `FORK_BLOCK_NUMBER`) y PF-16 (secundario con chainId 8453, head a ≤ 10 bloques del primario y proveedor distinto).

## Alternativas consideradas

- **Un único proveedor RPC:** descartado por el prompt §17.
- **Compartir credenciales RPC entre backend, signer y frontends:** descartado; cada trust domain usa sus propias claves para mantener la independencia (§4).
- **Decidir con la respuesta de un solo proveedor cuando hay desacuerdo:** descartado; ante una inconsistencia el watcher reintenta y alerta sin transición de estado hasta lograr consistencia ([B-FIN-02], [B-RPC-02]).

## Consecuencias

- Un RPC malicioso o inconsistente no puede, por sí solo, empujar una decisión sensible: el quórum la frena y el Guard on-chain decide al final (§9.3).
- Un desacuerdo sostenido entre proveedores demora operaciones; se alerta con más de 3 desacuerdos en 5 minutos y ante un proveedor caído ([B-OBS]).
- Hay más credenciales que gestionar: por componente y por entorno, sin reutilizarlas entre staging y producción (ADR-024). Las claves de los frontends están expuestas por naturaleza en el navegador, por eso se restringen con allowlist de dominio.
- Las apps de Alchemy y los endpoints de QuickNode por componente para los dominios reales se configuran en el despliegue final (H-03); CI usa como secret la misma `BASE_RPC_URL` de local (P02.T04).
- La caché RPC de Foundry por `FORK_BLOCK_NUMBER` hace reproducibles y más baratos los tests sobre el fork.

## Verificación

- P00.T08 — PF-13 y PF-14 en verde con las credenciales encontradas y validadas sin mostrarlas.
- Check de preflight PF-16 — RPC secundario de otro proveedor, con chainId 8453 y head a ≤ 10 bloques del primario (obligatorio en staging y producción; en local si la variable está definida).
- P08.T05 — `RpcQuorumClient` probado con dos Anvil sobre el mismo fork y con el proxy de inyección de fallas (timeouts, respuesta divergente, chainId incorrecto).
- P13.TST.d — timeout y desacuerdo de RPC, sin transición hasta la consistencia.
- P23.T02 — desacuerdo de RPC con el proxy de fallas durante el acceptance → sin transición.
- P24.T02 — alertas de RPC caído y de desacuerdo provocadas en local.
- P27.T02.l — auditoría de manipulación de RPC.
- Trazabilidad: RQ-47.
