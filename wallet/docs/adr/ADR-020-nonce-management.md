# ADR-020 — Gestión del nonce de la Safe

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-020), §2.3, §6.4 ([C-GRD-05]), §7.3 ([B-DB]), §7.4 ([B-SM-01], [B-SM-03]), §7.5 ([B-NONCE-01] a [B-NONCE-07]), §7.10 ([B-SIG-03]), §9.2 (A12, A13, A19); V9 §15, §19, §20; prompt §13, §15

## Contexto

El prompt §15 exige un manejo explícito del nonce de la Safe que evite la doble ejecución, las condiciones de carrera, dos operaciones con el mismo nonce y ejecuciones fuera de orden; pide considerar locking transaccional en la base, no confiar sólo en la memoria del worker e implementar la cancelación consumiendo el mismo nonce. El prompt §13 pide persistir las operaciones con su `safe_nonce` y estados explícitos.

V9 §15 establece que una SafeTx firmada sigue siendo válida hasta su ejecución o hasta que el usuario la cancele consumiendo el mismo nonce (NoOp con nonce N), y que los deadlines off-chain son herramientas operativas, no una garantía de seguridad. V9 §19 lo lista entre los supuestos autoritativos y §2.3 lo trata como comportamiento deliberado. A12 y A13 (V9 §20) exigen que una firma no pueda reusarse con otro nonce, Safe o cadena, y que cancelar con el nonce N invalide cualquier SafeTx pendiente con ese nonce.

## Decisión

Nonce con asignación transaccional en PostgreSQL (`FOR UPDATE`), índice único parcial por (safe, nonce) activo, lease con fencing por Safe, ejecución estricta en orden y cancelación por NoOp con el mismo nonce; en el signer, la regla "una SafeTx activa por (safe, nonce)".

Detalle ([B-NONCE]):

- **Asignación** ([B-NONCE-01]): en `prepare`, dentro de una transacción con `SELECT … FROM wallets WHERE id=$1 FOR UPDATE`, se calcula `n = max(onchainNonce(quorum), next_safe_nonce, max(nonce activo)+1)`, se inserta la operación `CREATED` con `safe_nonce = n` y se actualiza `next_safe_nonce = n+1`. Las transacciones que asignan nonces o transicionan estados usan `SERIALIZABLE` con reintento ante `40001` (P08.T04).
- **Índice único parcial** ([B-DB]): `UNIQUE(chain_id, safe_address, safe_nonce)` sobre `wallet_operations` para los estados activos (`USER_SIGNED`, `QUEUED`, `VALIDATING`, `READY`, `SUBMITTED`, `MINED`, `FAILED_RETRYABLE`, `REORGED`, `CONFIRMED`, `FINALIZED`), además de `UNIQUE(safe_tx_hash)`.
- **Liberación** ([B-NONCE-02]): si la operación expira o se cancela antes de `USER_SIGNED`, su nonce vuelve a estar disponible (recalculado bajo lock).
- **Orden estricto** ([B-NONCE-03]): el worker sólo procesa la operación cuyo `safe_nonce == onchainNonce`; las de nonce mayor quedan `QUEUED` con `blocked_reason=WAITING_LOWER_NONCE`.
- **Lease con fencing** ([B-NONCE-04]): `UPDATE wallets SET exec_lease_owner=$w, exec_lease_expires_at=now()+30s, exec_lease_version=exec_lease_version+1 WHERE id=$1 AND (exec_lease_expires_at < now() OR exec_lease_owner=$w) RETURNING exec_lease_version`; toda escritura posterior del worker incluye `lease_version`. Nada depende de la memoria del worker.
- **Transiciones** ([B-SM-01]): una única función `transitionOperation(id, fromStates[], toState, patch, leaseVersion)` que, en una sola transacción, hace `UPDATE … WHERE id=$1 AND status = ANY($2) AND lease_version=$3` e inserta auditoría y outbox; si no actualiza ninguna fila, aborta sin efectos.
- **Nonce de la cuenta S** ([B-NONCE-05]): `chain_transactions` con `UNIQUE(from_address, account_nonce, tx_hash)`; una sola tx en vuelo por S; el reemplazo (fee bump ≥ 12.5 %) reutiliza el mismo `account_nonce` y la misma SafeTx.
- **Cancelación** ([B-NONCE-06]): si la operación no está firmada, pasa a CANCELLED y libera el nonce. Si está firmada, la original pasa a `CANCEL_REQUESTED` (sale del índice de nonces activos y el worker deja de procesarla) y se prepara un `NOOP_CANCEL` con el **mismo** `safe_nonce` (SafeTx a la propia Safe, value 0, data vacía, CALL, permitida por [C-GRD-05]), que firma U o R y ejecuta S con prioridad. Si la original ya estaba SUBMITTED, la NoOp reemplaza la tx en vuelo de S (mismo nonce de cuenta, fee bump). Gana la que se mine primero: NoOp minada → original CANCELLED (`SUPERSEDED_BY_NOOP`); original minada → la NoOp queda FAILED_FINAL ("demasiado tarde para cancelar").
- **Doble ejecución** ([B-NONCE-07]): imposible on-chain por el nonce de la Safe; off-chain la previenen el índice único, el lease y `transitionOperation`. Con dos workers sobre la misma operación, sólo el poseedor del lease transmite.
- **Regla del signer** ([B-SIG-03]): a lo sumo una SafeTx activa firmada por (safe, nonce), salvo reemplazo explícito (NoOp o reemplazo con nueva firma del usuario).

## Alternativas consideradas

- **Llevar el nonce en la memoria del worker:** descartado por el prompt §15; todo el estado vive en PostgreSQL con lock de fila y fencing.
- **Cancelar mediante deadlines off-chain:** no alcanza; V9 §15 aclara que los deadlines off-chain son herramientas operativas y que sólo consumir el nonce invalida una SafeTx firmada.

## Consecuencias

- A12, A13 y A19 quedan cubiertas: no hay nonces duplicados ni doble ejecución bajo concurrencia, y los crashes se recuperan sin intervención (P13).
- Con orden estricto, una operación bloqueada con un nonce menor demora las posteriores de esa Safe (`WAITING_LOWER_NONCE`).
- Una operación `FAILED_FINAL` cuya firma sigue vigente obliga a ofrecer cancelación por NoOp, porque la SafeTx sigue siendo válida hasta consumir su nonce y sólo S puede transmitirla ([B-SM-03]).
- La validez indefinida de una SafeTx firmada hasta consumir su nonce es deliberada (§2.3); el backend agrega su propio límite operativo de antigüedad (24 h desde `submittedAt`, ADR-008).

## Verificación

- P08.T03 — el índice parcial impide dos operaciones activas con el mismo nonce (test de integración de migraciones).
- P08.T04 — repositorios con `SERIALIZABLE` y reintento ante `40001`.
- P13.T01 — máquina de estados y `transitionOperation` con todas las transiciones permitidas y prohibidas.
- P13.T02 — nonce manager con lock de fila y lease con fencing.
- P13.T05 — fees EIP-1559, reemplazo por fee bump y `chain_transactions`.
- P13.T08 — cancelación por NoOp con `CANCEL_REQUESTED` y reemplazo de la tx en vuelo.
- P13.TST.b y P13.TST.c — carrera de nonces y dos workers sobre la misma operación.
- P13.TST.g — crash en cada paso del pipeline y reinicio.
- P13.TST.i — NoOp ganando y perdiendo la carrera (original en QUEUED y en SUBMITTED).
- P11.TST — regla (safe, nonce) del signer.
- P07.T01.h — replay en otro nonce, otra Safe y otra cadena; nonce incorrecto.
- P22.T02.o — E2E de cola y estados con cancelación por NoOp.
- P27.T02.e — auditoría de replay y carreras de nonce.
- Trazabilidad: RQ-45, RQ-85.
