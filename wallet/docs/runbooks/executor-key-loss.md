# Runbook: pérdida de una clave S

Procedimiento de P15.T09 para cuando la clave S (ejecutor) de una Safe se pierde o queda inutilizable en su shard del
signer (keystore destruido o corrupto, credencial irrecuperable sin backup). Lo prueba de punta a punta
`backend/app/test/integration/executor-key-loss.test.ts` (keystore borrado, CLI real de operadores, reemplazo
soberano y continuidad con la S nueva).

Sin S no hay camino asistido: S ejecuta y co-firma cada operación, y una rotación asistida de S también la necesita.
El reemplazo lo hacen **U + R por el camino soberano** (ADR-004): el Guard no aplica política en ese camino y la
plataforma no puede impedirlo ni hacerlo sola.

## Síntomas

- El shard responde `SIGNER_NOT_READY` (motivo `KEY_UNAVAILABLE`) para esa wallet y las operaciones quedan
  `FAILED_RETRYABLE`; el resto de las wallets del shard siguen operando.
- El signer marca la clave `BROKEN` y dispara la alarma `keystore_unreadable` / `keystore_mac_invalid`.

Antes de reemplazar S, intentar recuperar el keystore desde el backup del shard ([keystore corrupto o
faltante](signer-lifecycle.md#keystore-corrupto-o-faltante)): si se restaura, no hace falta este procedimiento.

## 1. S nueva en el shard (operador)

```bash
echo "<código TOTP>" | pnpm --dir backend/app operators executor:prepare --wallet <walletId> \
  --operator <email del operador> --out <directorio>
```

Crea S′ en el shard de la wallet (queda `PENDING`, con su `SignerKeyAttestation`) y escribe dos documentos de
intercambio soberano [W-05] (`mtw-sovereign-safetx`, sin firmas):

1. `swapOwner(prev, S, S′)` con el nonce actual N de la Safe;
2. `SecurityGuard.updateRoles(U, R, S′)` con el nonce N + 1 (re-registra los roles en el Guard que gobierna la Safe).

La salida muestra la Safe, S y S′, la atestación y las rutas de los documentos. Se los entrega al usuario por el canal
de soporte.

## 2. Reemplazo soberano (usuario, sin la plataforma)

1. Recovery (`/sovereign`) importa cada documento, **recalcula el SafeTxHash**, verifica la atestación de S′ con la
   clave de atestación fijada en la app [F-SEC-08] y R firma.
2. Wallet importa el documento (QR o archivo), lo muestra decodificado y U agrega su firma.
3. Recovery combina las firmas y transmite con una wallet externa (paga el gas) o exporta el calldata para cualquier
   relayer. Primero el documento 1 (N) y después el 2 (N + 1).

## 3. Activación (operador)

```bash
echo "<código TOTP>" | pnpm --dir backend/app operators executor:activate --wallet <walletId> --operator <email del operador>
```

Verifica on-chain con quórum que la S vigente de la Safe (roles del Guard y owners) es S′ y que la configuración sigue
siendo la de una wallet asistida; recién entonces S′ queda `ACTIVE`, la S perdida `RETIRED` (metadatos de claves
incluidos), se audita `EXECUTOR_REPLACED` y se avisa al usuario. Si U + R todavía no ejecutaron los documentos, falla
sin cambiar nada.

Después, sin intervención:

- la sincronización de rotaciones del worker pide al shard el retiro de la S perdida ([B-SIG-08]);
- el gas tank recarga a S′ en su pasada periódica;
- la wallet sigue `ACTIVE` y las operaciones vuelven a ejecutarse con S′.

## Verificaciones

- `SecurityGuard.rolesOf(<Safe>).executor == S′` y `Safe.getOwners()` contiene S′ y no S.
- `signer_keys`: S′ `ACTIVE`, S `RETIRED` con `signer_retired_at`.
- Una NoOp de prueba se ejecuta con S′ como emisor de la tx.
