# Runbook: upgrade del Guard

Vía de corrección para Safes existentes ([C-GRD-17], ADR-029; P15.T08): un `SecurityGuard` sucesor (y, si hace falta,
un module guard sucesor) se registra en el `PolicyRegistry` y cada usuario lo instala con una rotación `GUARD` de 48 h
firmada por U. Lo prueba de punta a punta `backend/app/test/integration/guard-upgrade.test.ts` (Guard sucesor real
desplegado en el fork, upgrade del Guard y del module guard, operación y rotaciones posteriores con el sucesor).

## 1. Sucesor

- Contrato auditado; su suite P07 completa en verde contra el sucesor y su codehash publicado ([C-POL-06]).
- Constructor: los mismos `PolicyRegistry`, `DestinationWhitelist`, `DenyAllModuleGuard`, singleton y codehash del
  proxy de Safe y Permit2 que el Guard vigente, y `predecessor` = el Guard vigente (importa los roles de cada Safe en
  su primer uso). Cada sucesor crea su propio `RotationTimelock` (`ROTATION_TIMELOCK()`).
- Desplegarlo y verificar en el explorador el código y los argumentos.

## 2. Registro en el PolicyRegistry (Governance Safe, 24 h)

```text
PolicyRegistry.proposeSuccessorGuard(<Guard vigente>, <sucesor>)
PolicyRegistry.proposeSuccessorModuleGuard(<DenyAllModuleGuard>, <sucesor>)   # sólo si cambia el module guard
```

Los guardianes pueden cancelar durante las 24 h (`cancelChange`) y revocar después (`revokeSuccessorGuard`). Pasado el
plazo, `activateChange(<id>)`.

## 3. Snapshot de policy con el sucesor

El backend y el signer sólo aceptan como Guard de una Safe el del sistema o un sucesor **fijado en el snapshot de
policy firmado**: sin este paso, una Safe que instale el sucesor queda como configuración modificada (fail-closed).

```bash
cat > successors.json <<'JSON'
{ "guards": [{ "guard": "<sucesor>", "rotationTimelock": "<ROTATION_TIMELOCK() del sucesor>" }],
  "moduleGuards": ["<module guard sucesor, si hay>"] }
JSON
pnpm --dir backend/signer policy:build --env <entorno> --successors successors.json   # versión + 1
pnpm --dir backend/signer policy:sign <ruta del snapshot> --key-file <clave de policy del entorno>   # offline
```

Publicar el snapshot nuevo en el backend y en todos los shards del signer y reiniciarlos (anti-rollback: la versión
tiene que ser mayor que la vigente). Desde ahí, el indexer sigue también los eventos del `RotationTimelock` del sucesor.

## 4. Upgrade por Safe (usuario, 48 h)

1. Wallet: `POST /wallets/{id}/rotations` con `role: GUARD` (sólo U; sólo si `successorGuardOf(<Guard vigente>)`
   es el sucesor). La propuesta va al `RotationTimelock` del Guard que gobierna la Safe; se notifica por email e in-app
   y U o R pueden cancelarla durante las 48 h.
2. A las 48 h (reloj de la cadena): `POST /rotations/{id}/execute/prepare` → `setGuard(<sucesor>)` (`GUARD_UPGRADE`),
   firmado por U y ejecutado por S.
3. La Safe queda con el sucesor: sus roles se importan del Guard anterior en el primer uso y sigue operando en modo
   asistido; las rotaciones siguientes van al `RotationTimelock` del sucesor (cancelables por firma igual que antes).

El module guard sigue el mismo camino con `role: MODULE_GUARD` (`setModuleGuard`).

## Revocación

Si los guardianes revocan el sucesor, publicar un snapshot sin él: las Safes que ya lo instalaron quedan fuera del modo
asistido (U + R conservan el control soberano) hasta una nueva corrección.
