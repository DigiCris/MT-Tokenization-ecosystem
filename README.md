# Tokenization Mock

Mock funcional de una plataforma de tokenización de inversiones. Incluye una landing comercial completamente separada de la aplicación y una plataforma navegable con Backoffice de constructora, Portal del inversor y una vista interna de Master Backoffice reservada para evaluar la operación completa del mock.

Todo es una simulación de frontend. No hay backend, base de datos, wallets reales, blockchain, firmas reales, KYC real, AML real, Bitbase real ni integración con Caja de Valores o BYMA.

## Qué incluye

### Landing

La ruta `/` es una landing independiente hecha en **HTML + CSS + JavaScript vanilla**. No usa React. Está planteada como una landing comercial orientada al cliente y presenta únicamente lo que se ofrece hacia afuera: el Backoffice de constructora, el Portal del inversor, el ciclo de inversión y el ecosistema Bitbase, Kuantica y Astera Studio. No expone el Master Backoffice ni la arquitectura operativa interna.

Archivos de la landing:

```text
index.html
landing.css
landing.js
```

El CTA `Ver plataforma` abre `/app/?audience=client`. Ese modo muestra únicamente las experiencias de Constructora e Inversor. La vista Master sigue disponible para evaluación interna entrando directamente a `/app/`.

### Master Backoffice

Permite:

- Ver todas las constructoras, proyectos, personas y tenencias.
- Crear nuevas constructoras y generar su usuario administrador.
- Crear cualquier cantidad de tokens y asignarlos a una constructora específica.
- Publicar y despublicar proyectos.
- Recibir solicitudes de emisión de las constructoras y aprobarlas o rechazarlas.
- Ver una identidad global que relaciona a una misma persona entre distintos tenants.
- Ver una vista consolidada de tenencias.
- Ver eventos regulatorios simulados que deberían sincronizarse con la ADCVN correspondiente.
- Congelar y descongelar usuarios.
- Simular transferencias forzadas dentro del tenant del token.
- Consultar un registro operativo de acciones.

### Backoffice de constructora

Cada constructora ve únicamente la información de su tenant. Puede:

- Ver métricas y proyectos propios.
- Revisar colocación, soft cap, hard cap, escrow e inversores de cada proyecto.
- Publicar proyectos que estén en borrador.
- Liberar el escrow cuando el proyecto alcanzó el soft cap.
- Simular un vencimiento sin soft cap, devolver USDC y quemar las tenencias.
- Solicitar una nueva emisión al Master Backoffice.
- Simular pagos de intereses proporcionales a tenedores.
- Simular devolución total de capital y burn de tokens.
- Configurar la wallet del emisor.

### Portal del inversor

Cada inversor ingresa dentro de una plataforma concreta y sólo ve sus proyectos. Puede:

- Registrarse en un tenant.
- Simular KYC y AML.
- Ver su wallet y saldo.
- Ingresar USDC.
- Simular compra de USDC con pesos vía Bitbase.
- Explorar proyectos y ver su información, caps, deadline y documentos.
- Simular una suscripción con OTP, consentimiento y firma.
- Invertir en mercado primario.
- Ver tenencias y movimientos.
- Recibir refunds, intereses y devolución de capital creados desde el Backoffice de la constructora.
- Retirar USDC a una address.
- Simular retiro en pesos vía Bitbase.
- Publicar y comprar órdenes en un mercado secundario simplificado.

## Estructura técnica

```text
/
├── index.html          # Landing comercial vanilla
├── landing.css        # Estilos exclusivos de la landing
├── landing.js         # Menú responsive y animaciones simples
├── app/
│   └── index.html      # Entrada de la plataforma
├── src/
│   ├── main.jsx
│   ├── App.jsx         # Plataforma funcional en React
│   ├── store.jsx
│   └── styles.css
├── vite.config.js      # Build multipágina: landing + app
└── package.json
```

La separación es deliberada: **la landing no depende de React**, mientras que la plataforma funcional sí utiliza React porque tiene una cantidad importante de estados, vistas y flujos simulados.

## Persistencia y sincronización

Los datos de negocio se guardan en `localStorage` con la clave:

```text
astera_tokenization_mock_v1
```

La sesión se guarda en `sessionStorage` con la clave:

```text
astera_tokenization_session_v1
```

Esto es intencional. Permite abrir varias pestañas del mismo navegador, usar un rol distinto en cada pestaña y compartir los cambios entre ellas. Por ejemplo, se puede invertir como usuario en una pestaña y ver inmediatamente la nueva inversión desde el Backoffice de la constructora en otra.

La aplicación escucha el evento `storage`, por lo que los cambios realizados en una pestaña se reflejan en las demás.

## Cómo abrir la landing

La landing es completamente estática y usa rutas relativas. Por lo tanto, también puede abrirse directamente haciendo doble clic sobre `index.html` sin ejecutar npm. En ese modo se cargan correctamente `landing.css` y `landing.js`.

El botón `Ver plataforma` apunta a la carpeta `app`. La plataforma funcional sí debe ejecutarse con Vite porque utiliza React y módulos ES.

## Cómo levantar el proyecto

Requisitos:

- Node.js 20.19 o superior, o Node.js 22.12 o superior.
- npm.

Desde la carpeta del proyecto:

```bash
npm install
npm run dev
```

Vite mostrará la URL local, normalmente:

```text
http://localhost:5173/                       # landing vanilla
http://localhost:5173/app/?audience=client  # demo comercial: constructora + inversor
http://localhost:5173/app/                  # demo interna completa
```

Para generar un build:

```bash
npm run build
npm run preview
```

## Credenciales demo

La contraseña de todas las cuentas precargadas es:

```text
demo123
```

### Master Admin

```text
admin@tokeniza.demo
```

### Constructoras

```text
Madero Urban       admin@madero.demo
Arena Desarrollos  admin@arena.demo
Andes Habitat      admin@andes.demo
```

### Inversor

```text
inversor@demo.com
```

`inversor@demo.com` existe tanto en Madero Urban como en Arena Desarrollos y comparte el mismo `globalUserId`. Esto permite probar el concepto de una única persona global con cuentas en más de una plataforma.

## Datos precargados

La demo inicia con tres constructoras y cinco proyectos:

- Madero Urban: MURRD y MUPK.
- Arena Desarrollos: AREI y ARLOG.
- Andes Habitat: ANDL.

Hay proyectos en estado de colocación, fondeados y borrador para poder recorrer distintos estados sin tener que construirlos primero.

## Cómo evaluarlo

La mejor forma de evaluar el mock es usar tres pestañas del navegador sobre la misma URL. Cada pestaña tiene su propia sesión pero comparte los datos.

### Escenario 1: aislamiento multi tenant

1. Abrir una pestaña como Master Admin.
2. Crear una nueva constructora.
3. Crear un token y asignarlo sólo a esa constructora.
4. Cambiar a la vista de una constructora existente y verificar que el token nuevo no aparece.
5. Ingresar como admin de la constructora nueva y verificar que el token sí aparece allí.

Resultado esperado: cada backoffice y cada portal de inversor sólo ve datos de su tenant, mientras el Master ve todo.

### Escenario 2: solicitud de emisión

1. Ingresar como admin de Madero Urban.
2. Ir a Emisiones y crear una solicitud.
3. En otra pestaña entrar como Master Admin.
4. Abrir Solicitudes y aprobarla.
5. Volver al backoffice de Madero Urban.

Resultado esperado: el proyecto aprobado aparece como borrador sólo dentro de Madero Urban. Luego puede publicarse.

### Escenario 3: onboarding e inversión completa

1. Ingresar como inversor o crear un usuario nuevo.
2. Si es un usuario nuevo, simular el KYC.
3. Ir a Fondos e ingresar USDC o comprar USDC con pesos.
4. Abrir un proyecto en colocación.
5. Firmar la suscripción usando OTP `123456`, aceptar el consentimiento y confirmar la firma.
6. Invertir un monto.
7. Revisar Tenencias y Movimientos.
8. Abrir el Backoffice de la constructora en otra pestaña y revisar el proyecto.

Resultado esperado: saldo, raised del proyecto, escrow, tenencias, movimientos y cantidad de inversores cambian de forma coherente en todas las vistas.

### Escenario 4: AML

1. Crear un inversor nuevo o usar uno con AML pendiente.
2. Intentar superar el umbral simulado de 1.500 USDC de posición neta.
3. Verificar que la inversión queda bloqueada.
4. Ir a Fondos y simular AML.
5. Repetir la operación.

Resultado esperado: la operación sólo puede continuar después de la validación AML simulada.

### Escenario 5: soft cap exitoso

1. Desde un inversor realizar inversiones hasta alcanzar el soft cap de un proyecto.
2. Entrar al Backoffice de esa constructora.
3. Abrir el proyecto y usar Liberar escrow.

Resultado esperado: el proyecto pasa a fondeado, el escrow queda liberado y la acción aparece en el registro operativo del Master.

### Escenario 6: colocación fallida y refund

1. Abrir desde una constructora un proyecto que siga por debajo del soft cap.
2. Usar Simular vencimiento y refund.
3. Volver a una cuenta inversora que tenía posición en ese proyecto.

Resultado esperado: el USDC vuelve al saldo, aparece un movimiento de refund, las tenencias se queman y el proyecto queda como colocación fallida.

### Escenario 7: intereses y devolución de capital

1. Entrar al Backoffice de una constructora.
2. Ir a Distribuciones.
3. Seleccionar un proyecto con tenedores.
4. Simular un pago de intereses.
5. Verificar desde un inversor que el pago aparece en saldo y movimientos sin quemar tokens.
6. Repetir el proceso seleccionando Devolución de capital.

Resultado esperado: el capital se distribuye proporcionalmente, las tenencias se queman y el proyecto pasa a finalizado.

### Escenario 8: identidad global y reporting

1. Entrar como `inversor@demo.com` en Madero Urban y realizar una operación.
2. En otra pestaña entrar con el mismo email en Arena Desarrollos y realizar otra operación.
3. Desde Master Admin abrir Identidad global.
4. Revisar Reportes regulatorios.

Resultado esperado: ambas cuentas se muestran bajo el mismo `globalUserId`, aunque pertenezcan a plataformas distintas, y los eventos reportables mantienen la relación entre persona, token y tenant.

## Reset de la demo

En la pantalla de login existe la opción `Restablecer demo`. El reset elimina los cambios locales y vuelve a cargar el dataset inicial.

También puede hacerse desde DevTools eliminando las dos claves mencionadas arriba y recargando la página.

## Qué está deliberadamente simulado

Este mock valida producto, UX, navegación, aislamiento multi tenant y coherencia de los flujos. No pretende validar implementación técnica de producción.

Por eso no implementa:

- Smart contracts reales.
- ERC20 reales ni security tokens reales.
- Custodia de USDC.
- Escrow on chain.
- Relayer real.
- Firmas holográficas reales.
- OTP real.
- Bitbase real.
- KYC o AML real.
- Integración real con Caja de Valores o BYMA.
- Motor real de compliance.
- Matching engine de mercado secundario.
- Autenticación segura ni autorización de servidor.

Todas esas piezas se representan sólo lo suficiente para que el flujo visible pueda ser evaluado antes de construir la arquitectura definitiva.
