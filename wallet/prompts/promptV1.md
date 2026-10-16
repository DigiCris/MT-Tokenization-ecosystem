Quiero que en esta ejecución **NO implementes todavía el producto**. Tu objetivo es inspeccionar el repositorio y crear un **planner técnico completo, ejecutable paso a paso**, para construir el sistema que describo abajo.

El planner debe estar pensado para que posteriormente Claude Code pueda seguirlo de principio a fin y terminar con un producto real, funcional, testeado, auditado y preparado para producción.

No quiero una PoC, mocks del funcionamiento blockchain ni simulaciones que sustituyan componentes reales. Para desarrollo y testing utilizaremos un **fork reproducible de Base mainnet con Foundry/Anvil**, pero ejecutando contratos y flujos reales contra ese fork.

---

# 1. Git

Primero inspeccioná el repositorio y su estado.

Todo este trabajo debe hacerse en:

```text
feat/walletWeb/cmarchese
```

Si el branch no existe:

```bash
git checkout -b feat/walletWeb/cmarchese
```

Si existe, utilizarlo.

Todo lo relacionado con este proyecto debe quedar en ese branch.

Podés hacer los:

```text
git add
git commit
git push
```

que sean necesarios.

Los commits deben ser profesionales y descriptivos.

No mencionar:

```text
Claude
Anthropic
AI
Co-Authored-By
```

ni agregar coauthors.

No modificar ni destruir trabajo no relacionado que ya exista en el repositorio.

---

# 2. Objetivo del planner

Crear:

```text
docs/PLANNER_WALLET_WEB.md
```

Debe ser un planner extremadamente concreto, dividido en fases, tareas y subtareas ejecutables.

Cada fase debe incluir:

```text
- objetivo
- archivos/componentes involucrados
- implementación requerida
- dependencias
- tests a implementar
- checks manuales
- acceptance criteria
- security checks
- condición para poder pasar a la siguiente fase
```

Usar checkboxes:

```text
[ ]
```

para poder ir ejecutándolo y marcándolo posteriormente.

El planner debe estar suficientemente detallado como para que otra instancia de Claude Code pueda ejecutarlo sin tener que rediseñar la arquitectura.

No quiero sólo títulos del estilo:

```text
[ ] Implement authentication
```

Quiero que se indique concretamente qué debe construirse, cómo se conecta con los demás componentes, qué debe validarse y cuándo se considera terminado.

---

# 3. Especificación de seguridad autoritativa

Si dentro del repositorio existe la especificación:

```text
Wallet_Web_Self_Custodial_V9_Definitiva.pdf
```

o una versión posterior equivalente, leerla completa antes de crear el planner.

Esa especificación es autoritativa.

Si no está disponible, utilizar como mínimo las siguientes invariantes.

## Safe

Cada usuario tiene una Safe 2-de-3:

```text
U = User Key
R = Recovery Key
S = Server Executor

threshold = 2
```

Flujos:

```text
U + S = operación normal asistida
R + S = recovery asistido
U + R = control soberano del usuario
```

`U` y `R` pertenecen exclusivamente al usuario.

`S` pertenece al backend.

`S` nunca origina intención.

`S` únicamente valida y completa una operación previamente autorizada por U o R.

## Trust domains

Existen tres trust domains independientes:

```text
Wallet Frontend → U

Recovery Frontend → R

Backend / Signer → S
```

Comprometer uno no debe otorgar capacidad administrativa sobre los otros.

Wallet y Recovery deben ser aplicaciones separadas aunque visualmente el flujo para el usuario parezca integrado.

Deben tener builds separados y evitar compartir runtime code innecesario.

## SecurityGuard

Debe existir un Guard inmutable.

Camino asistido:

```text
S + U
o
S + R
```

Camino soberano:

```text
U + R
```

El Guard debe clasificar el camino únicamente utilizando signers realmente validados por Safe.

El camino `U + R` mantiene soberanía completa y no debe quedar bloqueado por business policies de la plataforma.

Camino asistido:

```text
operation = CALL

safeTxGas = 0
baseGas = 0
gasPrice = 0
gasToken = address(0)
refundReceiver = address(0)
```

No permitir `DELEGATECALL`.

## Modules

Inicialmente:

```text
modules = none
ModuleGuard = DenyAllModuleGuard
fallbackHandler = address(0)
```

`U + R` puede cambiar estas configuraciones soberanamente.

## Factory

Debe existir un:

```text
WalletFactory
```

inmutable, con configuración fijada.

Debe fijar como mínimo:

```text
Safe release exacta
Safe singleton
SafeProxyFactory
runtime bytecode/codehash esperado
SafeBootstrap
threshold = 2
SecurityGuard
DenyAllModuleGuard
RotationTimelock
PolicyRegistry
fallbackHandler = 0
payment = 0
executor = S
```

Deploy e inicialización deben ser atómicos.

El frontend debe poder calcular/verificar la Safe esperada y posteriormente comprobar on-chain la configuración antes de marcarla `ACTIVE`.

## Rotaciones

Cambios de:

```text
U
R
S
```

mediante camino asistido utilizan:

```text
propose
→ 48h timelock
→ execute
```

`U` o `R` actuales pueden cancelar individualmente durante el timelock.

`U + R` mantiene soberanía directa.

## Policy

Backend y Signer validan la operación independientemente.

Debe existir `PolicyRegistry`.

Puede existir `BOOTSTRAP` durante desarrollo, pero **el acceptance gate de producción debe exigir `RESTRICTED/default DENY` para todas las operaciones que formen parte de esta V1**.

La aplicación sólo debe permitir las operaciones explícitamente soportadas.

No crear generic arbitrary transaction execution.

## Destinos

Toda salida de valor hacia una dirección externa elegida por el usuario requiere que esa dirección esté previamente whitelisteada.

Un envío a otra dirección debe fallar incluso aunque el frontend intente construirlo.

El enforcement final debe existir on-chain.

## Autoridades económicas indirectas

Tratar como salida económica cualquier operación que permita a terceros mover fondos posteriormente:

```text
approve
increaseAllowance
Permit2
setApprovalForAll
operator approvals
etc.
```

No dejar approvals persistentes genéricos.

## Frontend

En los origins criptográficos:

```text
no third-party JS innecesario
no analytics
no GTM
no service workers
CSP estricta
Trusted Types
dependencies fijadas
builds reproducibles
release manifests
```

---

# 4. Arquitectura del repositorio

El planner debe mantener completamente separadas estas tres áreas:

```text
contracts/
backend/
frontend/
```

Dentro de frontend:

```text
frontend/wallet/
frontend/recovery/
```

Wallet y Recovery son aplicaciones diferentes.

Deben poder ejecutarse y desplegarse por separado.

Visualmente pueden compartir design system/look & feel, pero no quiero que la separación criptográfica se pierda por abstraer ambas claves dentro de una misma aplicación.

No compartir código que tenga acceso a U/R en runtime.

Si el repositorio ya posee una arquitectura distinta, inspeccionarla primero y adaptar estos nombres sin perder esta separación.

---

# 5. Stack

Primero inspeccionar qué tecnologías utiliza actualmente el repositorio.

Priorizar reutilizar tecnologías existentes si son adecuadas.

Si es greenfield, proponer en el planner un stack concreto y justificarlo brevemente.

Preferencias:

```text
Smart contracts:
Solidity + Foundry

Blockchain client:
viem

Wallet connections:
wagmi
WalletConnect
injected wallets
MetaMask
Coinbase Wallet
otras wallets compatibles

Frontend:
React + TypeScript

Backend:
TypeScript

Database:
PostgreSQL

Queue:
Redis + worker queue

API documentation:
OpenAPI + Swagger UI

E2E:
Playwright
```

No fijar versiones por memoria.

Antes de implementar, verificar las versiones estables actuales y los deployments oficiales mediante documentación oficial y luego **pinnear versiones exactas**.

---

# 6. Base mainnet fork

Todo el desarrollo blockchain inicial debe ejecutarse sobre:

```text
Base mainnet fork
```

usando Foundry/Anvil.

El planner debe definir:

```text
BASE_RPC_URL
FORK_BLOCK_NUMBER
CHAIN_ID
```

Fijar un block number para que CI/tests sean reproducibles.

Agregar scripts del estilo:

```text
start-fork
stop-fork
reset-fork
deploy-local
seed-local
```

El fork debe utilizar los contratos reales de Base cuando corresponda:

```text
USDC
USDT
Uniswap
Safe dependencies
```

No desplegar falsos USDC/USDT si los contratos reales pueden utilizarse mediante el fork.

Para tests se puede impersonar/fondear cuentas dentro del fork únicamente como herramienta de testing, pero el flujo final debe utilizar los contratos reales.

---

# 7. Funcionalidades de usuario

El planner debe construir un producto completo que incluya:

## Authentication

```text
Create account
Login
Logout
Forgot password
Reset password
Session management
Session expiry
Session revocation
```

La cuenta centralizada es independiente de U/R.

Password de login y Password U no deben confundirse conceptualmente.

Un reset del password centralizado no descifra la U anterior.

## Wallet

Después del login mostrar:

```text
Safe address
copy address
balances
transaction history/status
```

Debe poder recibir USDC enviándolo directamente a la Safe.

## Assets

Crear una sección:

```text
Assets
```

Mostrar inicialmente:

```text
USDC
USDT
```

con:

```text
balance
symbol
decimals
contract
```

Leer balances reales del fork.

---

# 8. User Key U

Implementar según la especificación de seguridad.

U:

```text
secp256k1 EOA
generada client-side con CSPRNG
```

Password U independiente.

Derivación mediante Argon2id y cifrado mediante AES-256-GCM.

U descifrada solamente durante el tiempo necesario para firmar.

Nunca enviar private key U al backend.

Nunca guardar U plaintext en DB, logs, localStorage, analytics o observability.

Planificar:

```text
Google Drive appDataFolder
backup cifrado
export manual
backup humano
```

La integración Drive debe ser directa desde el frontend cuando sea posible y no convertir al backend en custodio de U.

---

# 9. Recovery Key R

Aplicación:

```text
frontend/recovery
```

R:

```text
secp256k1
generada independientemente
password independiente
storage independiente
```

Permitir además utilizar una wallet externa como R.

Integración prevista con:

```text
wagmi
WalletConnect
injected wallets
MetaMask
Coinbase Wallet
otros connectors compatibles
```

R puede usarse para:

```text
recuperar/cambiar U
cancelar rotaciones
operaciones soberanas junto a U
```

No utilizar R para el flujo cotidiano.

Planificar onboarding integrado:

```text
Wallet
→ Activate Recovery
→ QR/link
→ Recovery frontend
→ crear/importar R
→ enrollment
→ volver a Wallet
```

---

# 10. Whitelist on-chain

Crear un contrato dedicado de whitelist de destinos.

Conceptualmente:

```text
DestinationWhitelist
```

Debe permitir consultar:

```text
isWhitelisted(safe, destination)
```

Toda operación asistida de envío debe comprobar on-chain ese registry.

Una transferencia a una dirección que no esté whitelisteada debe revertir.

El proceso de whitelist debe ser:

```text
usuario solicita dirección
→ backend crea challenge
→ email/2FA muestra la dirección exacta
→ usuario confirma
→ U autoriza el cambio
→ S lo ejecuta
→ DestinationWhitelist queda actualizado on-chain
```

El challenge debe quedar ligado como mínimo a:

```text
userId
Safe
chainId
destination
action
nonce
expiresAt
```

Debe ser:

```text
single-use
expirable
auditable
idempotente
```

El planner debe decidir el mecanismo exacto más seguro para actualizar el registry, pero **backend solo no debe poder falsificar una autorización del usuario**.

---

# 11. Send

Crear una pantalla similar conceptualmente al flujo de MetaMask:

```text
Send
```

Campos:

```text
token
destination
amount
review
confirm
```

Inicialmente soportar:

```text
USDC
USDT
```

La lista de destinos seleccionables debe venir del whitelist.

Aunque se modifique manualmente el frontend o la API:

```text
destination no whitelisted
→ transacción debe fallar
```

El backend:

```text
reconstruye SafeTxHash
valida policy
valida whitelist
valida balance
valida nonce
```

El Signer vuelve a hacerlo independientemente.

El Guard/policy on-chain hace el enforcement final.

---

# 12. Swap USDC / USDT con Uniswap

Crear:

```text
Swap
```

Sólo soportar:

```text
USDC → USDT
USDT → USDC
```

en Base.

Utilizar contratos oficiales actuales de Uniswap sobre Base.

Antes de fijar router/quoter/Permit2/Universal Router/etc.:

1. consultar documentación oficial actual;
2. identificar contratos correctos;
3. registrar address y codehash;
4. pinnearlos en configuración/contracts;
5. documentarlos.

No permitir arbitrary Uniswap calldata desde el frontend.

Para reducir superficie de ataque, considerar un contrato propio mínimo:

```text
SwapExecutor
```

que permita exclusivamente:

```text
USDC ↔ USDT
canonical Uniswap route/router
recipient = Safe
amountIn explícito
minAmountOut
deadline
slippage bounds
```

El planner debe analizar y elegir el diseño de menor riesgo.

Evitar approvals persistentes.

Preferencia:

```text
approve exact amount
→ swap
→ allowance final = 0
```

en una operación atómica cuando técnicamente sea posible.

Si se utiliza Permit2 o cualquier autorización persistente, debe entrar explícitamente al threat model y tener límites estrictos.

El resultado del swap siempre vuelve a la Safe.

---

# 13. Operaciones U → Backend → S

Necesitamos persistencia de operaciones.

Crear una tabla equivalente a:

```text
wallet_operations
```

Debe almacenar como mínimo:

```text
id
user_id
safe_address
chain_id
safe_nonce
operation_type
safe_tx_hash
target
value
calldata / canonical intent
u_signature
status
created_at
updated_at
submitted_at
executed_at
tx_hash
block_number
failure_reason
retry_count
```

Nunca almacenar private keys.

Estados explícitos, por ejemplo:

```text
CREATED
USER_SIGNED
QUEUED
VALIDATING
READY
SUBMITTED
CONFIRMED
FAILED_RETRYABLE
FAILED_FINAL
CANCELLED
REORGED
```

Definir máquina de estados.

Toda transición importante debe quedar auditada.

---

# 14. Queue y worker S

Una vez U firma:

```text
U
→ backend
→ DB
→ queue
→ S worker
```

El worker:

```text
1. carga operación
2. verifica sesión/intención original cuando corresponda
3. reconstruye SafeTxHash
4. valida firma U/R
5. consulta nonce actual
6. consulta policy
7. consulta whitelist
8. simula/eth_call si corresponde
9. solicita firma S
10. envía execTransaction
11. espera receipt
12. actualiza estado
```

La firma S jamás debe generarse antes de completar nuevamente todos los checks.

## Batch

Analizar batching.

Si permite ahorrar gas/latencia sin debilitar:

```text
nonce ordering
atomicidad
policy
failure isolation
```

implementarlo.

Si agrega complejidad o riesgo relevante, V1 puede ejecutar de a una.

El planner debe justificar la decisión.

---

# 15. Nonce management

Diseñar explícitamente el manejo de nonce de Safe.

Debe evitar:

```text
double execution
race conditions
dos operaciones utilizando accidentalmente mismo nonce
operaciones ejecutadas fuera de orden
```

Considerar locking transaccional en DB.

No confiar únicamente en memoria del worker.

Implementar cancelación mediante consumo del mismo Safe nonce cuando el usuario lo solicite.

---

# 16. Blockchain finality y reorgs

No marcar una operación como definitiva inmediatamente después del receipt.

Definir:

```text
SUBMITTED
MINED
CONFIRMED
```

y política de confirmaciones para Base.

El planner debe contemplar:

```text
reorg detection
receipt disappeared
block hash changed
transaction replaced/dropped
RPC inconsistency
```

y reconciliación periódica DB ↔ chain.

---

# 17. RPC

No acoplar todo a un único RPC provider.

Diseñar una abstracción para:

```text
primary RPC
secondary RPC
```

y health checks.

Las decisiones sensibles no deben basarse en una respuesta inconsistente sin posibilidad de retry/revalidation.

---

# 18. Signer S

Cada Safe debe tener su propia `S`.

Nunca almacenar S plaintext:

```text
database
.env
application logs
source code
```

Para local/fork puede existir un signer adapter específico para desarrollo.

Pero el producto debe incluir un signer de producción.

Diseñar una interfaz:

```text
SignerProvider
```

con al menos:

```text
development signer
production signer
```

La opción production debe seguir la arquitectura de la especificación:

```text
Backend
→ Policy
→ Signer Service
→ Clef / equivalente aislado
```

y dejar preparada la migración a:

```text
HSM secp256k1
```

Si se utiliza Clef:

```text
IPC/private network
rules extremadamente restrictivas
ruleset attested
sin exposición pública
```

Clef no sustituye las policies del backend.

---

# 19. Backend API

Crear API versionada:

```text
/api/v1/...
```

Como mínimo planificar endpoints para:

```text
auth
users
wallet
balances
whitelist
send
swap
operations
recovery
rotations
sessions
health
```

Definir:

```text
request schemas
response schemas
error schemas
authentication
authorization
rate limits
idempotency
```

---

# 20. Swagger

Debe existir:

```text
/docs
```

con Swagger UI/OpenAPI.

Todos los endpoints deben documentarse.

Swagger debe permitir probar endpoints seguros en development.

No exponer operaciones administrativas sensibles en production sin la protección correspondiente.

---

# 21. Database

PostgreSQL.

Además de users y operations, analizar tablas para:

```text
users
sessions
wallets
wallet_keys_metadata
recovery_metadata
whitelist_requests
whitelisted_destinations
wallet_operations
rotation_requests
security_challenges
audit_events
chain_transactions
```

No guardar U/R private keys.

Agregar:

```text
migrations
constraints
foreign keys
unique indexes
transaction boundaries
```

Definir backup/restore.

---

# 22. Authentication security

La autenticación centralizada debe ser production-grade.

Incluir:

```text
password hashing fuerte
HttpOnly cookies si corresponde
Secure
SameSite
session rotation
CSRF protection
logout invalidation
password reset single-use
OTP expiry
brute-force protection
rate limiting
account lock/risk controls
```

No almacenar auth tokens sensibles en `localStorage` si puede evitarse.

---

# 23. Email / challenge provider

Elegir proveedor real.

El planner debe indicar qué credenciales obtener.

Los emails sensibles deben mostrar claramente:

```text
acción
address
network
expiry
```

Especialmente para whitelist y cambios de seguridad.

---

# 24. Secrets y API keys

Crear:

```text
.env.example
```

con todas las variables requeridas y sin secretos.

Crear también localmente:

```text
.env
```

con placeholders vacíos si no existe.

Agregar `.env` a `.gitignore`.

Nunca commitear secretos.

Crear:

```text
docs/SETUP_EXTERNAL_SERVICES.md
```

Debe contener para **cada secret/API key**:

```text
VARIABLE
para qué sirve
proveedor
URL/sección donde obtenerla
pasos concretos
permisos mínimos necesarios
en qué entorno se necesita
si es obligatoria u opcional
```

Ejemplos esperables, sujeto a la arquitectura final:

```text
BASE_RPC_URL
BASE_RPC_URL_SECONDARY

DATABASE_URL
REDIS_URL

WALLETCONNECT_PROJECT_ID

GOOGLE_CLIENT_ID_WALLET
GOOGLE_CLIENT_SECRET_WALLET
GOOGLE_CLIENT_ID_RECOVERY
...

EMAIL_PROVIDER_API_KEY
EMAIL_FROM

SESSION_SECRET
CSRF_SECRET

RPC/API keys adicionales
```

No inventar valores.

---

# 25. Preflight obligatorio

La **primera fase ejecutable del planner** debe ser:

```text
PHASE 0 — PREFLIGHT
```

Crear un script:

```text
scripts/preflight
```

que verifique como mínimo:

```text
Node
package manager
Foundry
forge
cast
anvil
Docker
database
Redis
RPC connectivity
fork block availability
env variables
API keys
WalletConnect
Google OAuth config
email provider
ports
required binaries
```

Si algo obligatorio falta:

```text
STOP
```

y mostrar exactamente:

```text
qué falta
variable
cómo obtenerla
documentación interna donde seguir los pasos
```

No continuar parcialmente dejando funcionalidades falsas.

Cuando todos los checks pasen:

```text
PREFLIGHT PASSED
```

y recién entonces el planner puede continuar de punta a punta.

---

# 26. Local environment

Quiero poder levantar todo con un número mínimo de comandos.

Idealmente:

```bash
docker compose up -d
pnpm install
pnpm preflight
pnpm dev
```

o equivalente según el stack.

Debe levantar:

```text
PostgreSQL
Redis
Base fork
contracts deployed
backend
worker
Wallet frontend
Recovery frontend
```

Proponer scripts claros.

---

# 27. Seed de entorno local

Crear un mecanismo determinístico para preparar el fork:

```text
deploy contracts
crear usuario test
crear Safe
configurar U/R/S
fondear Safe con USDC
opcionalmente fondear USDT
```

Utilizar tokens reales del fork.

Debe permitir reiniciar el entorno y obtener el mismo escenario reproducible.

---

# 28. Tests smart contracts

Exigir:

```text
unit tests
integration tests
fuzz tests
invariant tests
fork tests
```

Como mínimo atacar:

```text
non-whitelisted send
delegatecall
module execution
fallback
wrong executor
wrong signer combination
U alone
R alone
S alone
malformed signatures
replay
wrong nonce
wrong chain
wrong Safe
rotation bypass
timelock bypass
whitelist bypass
swap arbitrary token
swap arbitrary recipient
swap malicious calldata
persistent allowance
factory initialization
wrong Safe implementation
```

Coverage alto del código propio.

Ejecutar Slither y otras herramientas adecuadas.

---

# 29. Backend tests

Agregar:

```text
unit
integration
DB
queue
API
security
```

Testear:

```text
duplicate requests
idempotency
nonce races
two workers same operation
RPC timeout
RPC disagreement
failed transaction
reverted transaction
reorg
queue retry
process crash
backend restart
expired session
expired OTP
reused OTP
unauthorized destination
```

---

# 30. Frontend tests

Agregar:

```text
unit
integration
E2E Playwright
```

Flujos E2E:

```text
create account
login
logout
forgot password
Safe creation
recovery enrollment
copy Safe address
receive USDC
assets
whitelist address
send USDC
reject non-whitelisted address
swap USDC→USDT
swap USDT→USDC
operation queue/status
recover U with R
recover R with U
cancel rotation
```

---

# 31. Full-system acceptance tests

Debe existir un escenario automatizado sobre Base fork que haga de principio a fin:

```text
1. create account
2. create U
3. create R
4. create S
5. deploy Safe
6. verify Safe
7. fund Safe with real forked USDC
8. verify balance
9. request whitelist
10. complete challenge
11. whitelist destination on-chain
12. send USDC
13. verify destination balance
14. attempt non-whitelisted send
15. prove it fails
16. swap USDC→USDT
17. verify balances
18. swap USDT→USDC
19. verify balances
20. verify DB operation states
21. exercise recovery flow
22. exercise rotation cancellation
```

El test debe comprobar tanto:

```text
happy paths
como security failure paths
```

---

# 32. Security tooling

El planner debe incorporar como mínimo:

```text
forge test
forge coverage
forge fuzz/invariant
Slither
dependency audit
secret scanning
SAST
lint
typecheck
```

Agregar tooling adicional si aporta valor real.

No llenar el planner de herramientas sólo por tenerlas.

---

# 33. CI

Crear una fase para CI que ejecute:

```text
install locked dependencies
lint
typecheck
unit tests
backend tests
contract tests
fork tests
fuzz/invariants
coverage
Slither
frontend tests
builds
secret scan
dependency scan
```

Ningún deploy production si CI falla.

---

# 34. Observabilidad

Production debe tener:

```text
structured logs
metrics
alerts
health checks
queue metrics
RPC health
failed tx alerts
signer health
stuck operation alerts
reorg alerts
balance ETH de S
```

Nunca loggear:

```text
U
R
passwords
raw secrets
OTP completos
session secrets
```

Definir redaction.

---

# 35. Audit log

Crear audit trail para eventos de seguridad:

```text
login
logout
password reset
whitelist requested
whitelist confirmed
transaction proposed
U/R signature received
S execution
rotation proposed
rotation cancelled
recovery
admin/security events
```

Debe ser append-oriented y difícil de alterar accidentalmente.

---

# 36. Rate limiting y abuse prevention

Planificar límites para:

```text
login
forgot password
OTP
whitelist
send
swap
recovery
operation creation
Swagger/API
```

Distinguir por:

```text
IP
user
session
Safe
```

según corresponda.

---

# 37. Deployment environments

Separar:

```text
local
staging
production
```

No reutilizar:

```text
databases
OAuth clients
signer keys
session secrets
email config
RPC keys
```

entre staging y production.

---

# 38. Production deployment

El planner debe terminar con una fase específica:

```text
PRODUCTION READINESS
```

Incluyendo:

```text
Dockerfiles
docker-compose para desarrollo
production deployment layout
reverse proxy
TLS
database migrations
Redis persistence cuando corresponda
backup strategy
restore test
secret injection
DNS
CSP/security headers
monitoring
log retention
key rotation
rollback procedure
incident procedure
```

---

# 39. Contract deployment production

Preparar scripts para Base mainnet pero **no desplegar mainnet durante la ejecución automática del planner sin aprobación explícita**.

Scripts deben:

```text
deploy
verify
record addresses
record bytecode hashes
record compiler settings
record git commit
```

Generar:

```text
deployments/base-mainnet.json
```

o estructura equivalente.

---

# 40. Contract verification

Todo contrato production debe quedar verificado en explorer.

Documentar:

```text
address
implementation
compiler
commit
codehash
verification URL
```

---

# 41. Security audit final

Una vez implementado todo el planner, ejecutar una auditoría adversarial completa.

Crear:

```text
docs/SECURITY_AUDIT.md
```

Cada finding:

```text
ID
Severity
Title
Component
Description
Attack prerequisites
Step-by-step exploitation
Impact
Evidence
Recommended fix
Recommendation:
  MUST FIX
  SHOULD FIX
  ACCEPTABLE RISK
```

Severity:

```text
Critical
High
Medium
Low
Informational
```

No generar findings genéricos.

Cada finding debe comprobarse contra el threat model específico antes de incluirlo.

No marcar como vulnerabilidad comportamientos deliberados tales como:

```text
U + R tienen soberanía
U/R pueden cancelar rotaciones
S necesita U/R
SafeTx válida hasta ejecución/cancelación
```

La auditoría debe intentar activamente:

```text
drain
takeover
bypass de S
bypass del Guard
bypass whitelist
bypass rotation timelock
replay
nonce races
signature confusion
malicious swap calldata
allowance abuse
backend compromise
frontend U compromise
frontend R compromise
signer compromise
DB tampering
queue tampering
RPC manipulation
reorgs
```

---

# 42. Security remediation gate

Después de la auditoría, el planner debe incluir:

```text
SECURITY REMEDIATION
```

No considerar production-ready mientras exista:

```text
Critical abierto
High abierto
```

salvo decisión explícita y documentada del owner del proyecto.

Después de fixes:

```text
retest
rerun audit
document residual risks
```

---

# 43. Documentación final

Crear finalmente:

```text
README.md
```

con:

```text
qué es el sistema
arquitectura
requisitos
setup local
env
Base fork
database
contracts
backend
frontend Wallet
frontend Recovery
tests
build
production deploy
troubleshooting
```

Crear además un documento muy corto:

```text
docs/HOW_IT_WORKS.md
```

Debe explicar en lenguaje simple y sintético:

```text
qué es U
qué es R
qué es S
cómo se forma la Safe
cómo se firma una operación
qué hace S
cómo funciona whitelist
cómo funciona send
cómo funciona swap
cómo funciona recovery
por qué sigue siendo self-custodial
```

No más largo de lo necesario.

---

# 44. Swagger / API docs

Mantener OpenAPI generado desde código cuando sea posible.

README debe enlazar:

```text
/docs
```

y explicar cómo autenticarse y probar la API.

---

# 45. Planner execution checkpoints

Cada fase del planner debe terminar con algo equivalente a:

```text
CHECKPOINT X

[ ] build pasa
[ ] tests pasan
[ ] security tests pasan
[ ] integración anterior sigue funcionando
[ ] documentación actualizada
[ ] no secrets committed
[ ] git status revisado
```

No avanzar al siguiente checkpoint si falla algo crítico.

---

# 46. Git durante la implementación

El planner debe indicar commits lógicos por fase.

Ejemplos:

```text
feat(wallet): add deterministic safe deployment
feat(auth): add account and session management
feat(recovery): add independent recovery frontend
feat(policy): add destination whitelist enforcement
feat(swap): add restricted usdc usdt swaps
test(security): add wallet invariants and adversarial tests
docs(wallet): add production deployment guide
```

Sin menciones a Claude/AI/coauthors.

Push periódico al branch:

```text
feat/walletWeb/cmarchese
```

---

# 47. Qué debés hacer AHORA

En esta ejecución quiero únicamente preparar el proyecto para poder implementar después.

Hacé lo siguiente:

1. Inspeccioná completamente el repositorio relevante.
2. Identificá stack actual, estructura, scripts y restricciones.
3. Revisá git status y branch.
4. Creá/cambiá a `feat/walletWeb/cmarchese`.
5. Si existe la especificación V9, leela completa.
6. Verificá con documentación oficial las tecnologías/dependencias externas que condicionen el planner.
7. Creá:

```text
docs/PLANNER_WALLET_WEB.md
docs/SETUP_EXTERNAL_SERVICES.md
.env.example
.env local vacío/placeholder y gitignored
```

8. En el planner elegí arquitectura concreta; no dejes decisiones importantes como “TBD”.
9. Enumerá todas las API keys/secrets necesarias.
10. Hacé una revisión final del planner buscando fases faltantes, inconsistencias o huecos de seguridad.
11. Verificá que todos los requisitos de este prompt aparezcan en el planner.
12. Agregá una sección final:

```text
REQUIREMENTS TRACEABILITY
```

mapeando cada requisito importante de este prompt contra la fase del planner que lo implementa.

13. No empieces todavía la implementación del producto.
14. Commit de los archivos del planner.
15. Push a:

```text
origin feat/walletWeb/cmarchese
```

Al terminar informame únicamente:

```text
- branch utilizado
- archivos creados/modificados
- cantidad de fases del planner
- stack elegido
- secrets/API keys que voy a tener que conseguir
- cualquier blocker real encontrado
- commit hash
- confirmación de push
```

No me des una explicación extensa del planner en consola: quiero leer el planner directamente en el archivo.

El criterio principal es:

**esto debe terminar en una wallet web self-custodial real, production-grade y segura; el planner no debe aceptar atajos propios de una PoC.**

Nota: Todo debe generarse dentro de la carpeta wallet de este repsitorio. La única carpeta que tienes permiso y solo de lectura fuera de esto es documentacion para que puedas ver cual es el proyecto que se va a estar construyendo y el model de wallet que estamos usando, pero inclusive la documentación que crees con todo esto debe estar dentro de la carpeta wallet igual que backend y ambos frontends y los smart contracts que necesites. Además quiero que te acuerdes que el planner utilices por cada acción [] para que cada vez que se termine de ejecutar algo se pueda completar con una cruz, para saber en todo momento por donde vamos y que si se detiene por cualquier motivo pueda retomarse desde ese punto (quizá con un checkeo de los ultimos por las dudas pero no tener que empezar desde el principio).