# Tendia Backend

Backend real y completo de Tendia: autenticación (Comerciante / Cliente),
catálogo de **productos** con menú público, **CRM de clientes** con
historial y exportación CSV, **pedidos** (checkout con precios calculados
en el servidor, control de stock, flujo de estados, cancelación), y
**automatización con WhatsApp e Instagram** (un agente conversacional que
muestra el menú, arma el carrito y confirma el pedido por chat, usando la
misma lógica de checkout que el resto del sistema). Base de datos
PostgreSQL vía Prisma.

Verificado en este entorno con una suite de **81 pruebas de integración
reales** (servidor real + base de datos real + simulación de mensajes
reales de Meta, no solo revisión de código): registro, login, seguridad
por rol, aislamiento entre comercios y clientes distintos, productos,
CRM, historial, exportación, checkout, control de stock, flujo completo
de estados de un pedido, verificación de webhooks, conversación completa
del agente terminando en un pedido real, prevención de clientes
duplicados por chat, manejo de stock insuficiente vía chat, y
Instagram. Ver sección 8 para correrlas tú mismo. La conexión a Postgres
en sí no se pudo probar dentro de este sandbox porque no tiene salida a
internet hacia proveedores de base de datos externos ni hacia Meta; se
prueba en tu servidor real siguiendo los pasos de abajo (para las
pruebas automatizadas se usa SQLite en memoria y un "modo simulación"
para los envíos de WhatsApp/Instagram).

## 1. Crear una base de datos Postgres gratis

Recomendado para empezar (elige una):
- **Neon** → https://neon.tech (plan gratuito, arranca en 1 minuto)
- **Supabase** → https://supabase.com (también incluye otras cosas útiles a futuro)

Copia la cadena de conexión que te dan (empieza con `postgresql://...`).

## 2. Configurar el proyecto

```bash
cd tendia-backend
npm install
cp .env.example .env
```

Edita `.env` y pega tu `DATABASE_URL`. Genera un `JWT_SECRET` real con:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 3. Crear las tablas en la base de datos

```bash
npm run prisma:migrate
```

Esto crea las tablas `Comercio`, `Usuario`, `ClienteComercio`, `Producto`
y `Pedido` en tu base de datos, listas para usar.

## 4. Levantar el servidor

```bash
npm run dev
```

Debe mostrar: `Tendia backend escuchando en http://localhost:4000`

## 5. Probar los endpoints

**Registrar un comerciante** (crea su cuenta y su negocio en un solo paso):
```bash
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"role":"COMERCIANTE","nombre":"Marta Ruiz","email":"marta@panaderia.com","password":"123456","comercioNombre":"Panadería Doña Marta","categoria":"Panadería"}'
```

**Registrar un cliente**:
```bash
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"role":"CLIENTE","nombre":"Laura Gómez","email":"laura@correo.com","password":"123456","telefono":"+573112223344"}'
```

**Iniciar sesión** (te devuelve un `token`):
```bash
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"marta@panaderia.com","password":"123456"}'
```

**Ruta protegida de ejemplo** (usa el token que te devolvió el login):
```bash
curl http://localhost:4000/api/auth/me \
  -H "Authorization: Bearer TU_TOKEN_AQUI"
```

## 6. Probar Productos y CRM

**Crear un producto** (con tu token de comerciante):
```bash
curl -X POST http://localhost:4000/api/productos \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_TOKEN" \
  -d '{"nombre":"Torta de chocolate","categoria":"Repostería","precio":38000,"precioAntes":48000,"promo":"20% off","stock":6}'
```

**Ver el menú público** (sin login, como lo vería un cliente):
```bash
curl http://localhost:4000/api/productos/publico/TU_COMERCIO_ID
```

**Vincular un cliente a tu CRM** (el cliente debe existir, es decir, ya haberse registrado):
```bash
curl -X POST http://localhost:4000/api/clientes \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_TOKEN" \
  -d '{"email":"laura@correo.com"}'
```

**Registrar una compra en el historial del cliente:**
```bash
curl -X POST http://localhost:4000/api/clientes/ID_DEL_CLIENTE/compras \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_TOKEN" \
  -d '{"items":"Torta de chocolate","total":38000}'
```

**Ver tu CRM completo:**
```bash
curl http://localhost:4000/api/clientes -H "Authorization: Bearer TU_TOKEN"
```

**Exportar el CRM en CSV** (esta vez generado en el servidor, con datos reales):
```bash
curl http://localhost:4000/api/clientes/export/csv -H "Authorization: Bearer TU_TOKEN" -o clientes.csv
```

## 7. Probar Pedidos

**Crear un pedido** (el cliente arma su carrito; el precio y el total
SIEMPRE se calculan con los datos reales del servidor, nunca con lo que
mande el navegador — y se descuenta el stock automáticamente):
```bash
curl -X POST http://localhost:4000/api/pedidos \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN_DEL_CLIENTE" \
  -d '{"comercioId":"ID_DEL_COMERCIO","canal":"whatsapp","items":[{"productoId":"ID_PRODUCTO","cantidad":2}]}'
```

**Ver mis pedidos** (comerciante ve los de su negocio, cliente ve los suyos):
```bash
curl http://localhost:4000/api/pedidos -H "Authorization: Bearer TU_TOKEN"
# filtrar por estado:
curl "http://localhost:4000/api/pedidos?estado=nuevo" -H "Authorization: Bearer TU_TOKEN"
```

**Avanzar el estado del pedido** (solo el comerciante dueño; un paso a la
vez: nuevo → proceso → listo → entregado, o cancelado en cualquier punto
antes de entregar):
```bash
curl -X PATCH http://localhost:4000/api/pedidos/ID_DEL_PEDIDO/estado \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN_DEL_COMERCIANTE" \
  -d '{"estado":"proceso"}'
```

Al marcar un pedido como `entregado`, el CRM del comercio se actualiza
solo: el total comprado del cliente sube y, si nunca había comprado ahí
antes, queda vinculado automáticamente a ese negocio.

## 8. Correr la suite de pruebas automáticas

Este proyecto incluye una prueba de integración real: levanta el servidor
con una base de datos SQLite en memoria (no toca tu Postgres) y hace
peticiones HTTP reales a cada endpoint, verificando registro, login,
productos, seguridad entre comercios distintos, CRM, historial y
exportación CSV.

```bash
npm run test:integration
```

Debe terminar con algo como `RESULTADO: 81 pruebas correctas, 0 fallidas.`
Ejecútala después de cualquier cambio para asegurarte de que nada se rompió.

## 9. Desplegarlo en internet (para que tu app lo use de verdad)

Vas a hacer 4 cosas en orden: **A)** subir el código a GitHub, **B)**
desplegar el backend en Railway, **C)** desplegar el frontend en
Netlify (o Vercel), **D)** conectar los dos. Tu base de datos de Neon no
cambia — ya está en la nube, así que se conecta igual desde donde sea.

### A) Subir el código a GitHub (con GitHub Desktop, sin comandos de git)

1. Si no tienes cuenta, créala gratis en **github.com**.
2. Descarga **GitHub Desktop** (desktop.github.com) e instálalo — es una
   app con ventanas, no una terminal.
3. Ábrelo, inicia sesión con tu cuenta de GitHub.
4. Menú **File → New repository**. Nombre: `tendia-backend`. En "Local
   Path" elige la carpeta que contiene tu proyecto (o copia tu carpeta
   `tendia-backend` a donde te deje elegir). Click **Create repository**.
5. Abajo a la izquierda vas a ver todos los archivos listados como
   cambios. Escribe un mensaje corto (ej: "Primera versión") y dale
   **Commit to main**.
6. Arriba, botón **Publish repository**. Déjalo público o privado, como
   prefieras (privado está bien, Railway igual puede leerlo si conectas
   tu cuenta).

Listo — tu código ya está en GitHub. Cada vez que yo te dé un archivo
nuevo o una actualización, repites: reemplazas el archivo local →
GitHub Desktop te muestra el cambio → escribes un mensaje → **Commit** →
**Push origin**. Railway se entera solo y despliega la versión nueva.

### B) Desplegar el backend en Railway

1. Entra a **railway.app**, crea cuenta (lo más fácil: "Login with GitHub").
2. **New Project → Deploy from GitHub repo** → elige `tendia-backend`.
3. Railway va a intentar desplegar automáticamente (detecta que es
   Node.js por el `package.json`). Mientras termina, ve a la pestaña
   **Variables** de tu proyecto y agrega, una por una:
   ```
   DATABASE_URL       = (la misma que tienes en tu .env de Neon)
   JWT_SECRET          = (genera una nueva y real, ver abajo)
   NODE_ENV            = production
   META_VERIFY_TOKEN   = (el mismo que uses al conectar el webhook de Meta)
   META_APP_SECRET     = (de tu app de Meta, ver sección 10)
   WHATSAPP_ACCESS_TOKEN = (cuando lo tengas, ver sección 10)
   INSTAGRAM_ACCESS_TOKEN = (cuando lo tengas)
   SMTP_HOST, SMTP_USER, SMTP_PASS, MAIL_FROM = (si activas correo real, sección 13)
   ```
   Para generar un `JWT_SECRET` real, en tu terminal local:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   y pega el resultado como valor de `JWT_SECRET` en Railway (no lo
   reutilices del `.env` local si ahí tenías uno de prueba/débil).
4. En la pestaña **Settings → Networking**, click **Generate Domain**.
   Te da una URL pública como `https://tendia-backend-production.up.railway.app`
   — **cópiala**, la necesitas en el siguiente paso.
5. Prueba que responde: abre `TU_URL/api/health` en el navegador. Debe
   mostrar `{"ok":true,"servicio":"tendia-backend"}`.
6. Corre la migración de la base de datos **una sola vez**, apuntando a
   producción (usa la Terminal integrada de Railway, pestaña del
   proyecto, o corre localmente con tu `.env` de producción):
   ```
   npx prisma db push
   ```

### C) Desplegar el frontend en Netlify

1. **Antes de subirlo**, edita `tendia-mini-agente.html` en tu
   computadora (Bloc de notas o VS Code): busca la línea
   ```js
   const API_URL = "http://localhost:4000";
   ```
   y cámbiala por tu URL real de Railway del paso B4:
   ```js
   const API_URL = "https://tendia-backend-production.up.railway.app";
   ```
   Guarda el archivo.
2. Entra a **app.netlify.com/drop** (no hace falta cuenta para probar,
   pero créala para que el sitio no se borre — es gratis).
3. Arrastra el archivo `tendia-mini-agente.html` directo a esa página.
   En segundos te da una URL pública, algo como
   `https://tendia-random-nombre.netlify.app`.
4. (Opcional) En **Site settings → Change site name**, ponle un nombre
   más lindo, ej: `tendia-app` → `https://tendia-app.netlify.app`.

**Alternativa con Vercel:** entra a **vercel.com/new**, "Deploy" un
proyecto, y cuando te pida el código puedes arrastrar una carpeta que
solo contenga tu `tendia-mini-agente.html` (renómbralo a `index.html`
antes de subirlo, Vercel lo espera así). También te da una URL pública.

### D) Conectar los dos (el paso que la gente olvida)

Vuelve a Railway → tu proyecto → **Variables**, y agrega/edita:
```
CORS_ORIGINS = https://tendia-app.netlify.app
```
(la URL exacta que te dio Netlify o Vercel, sin `/` al final). Guarda —
Railway redespliega solo. **Sin este paso, el navegador va a bloquear
las peticiones de tu app al backend** aunque todo lo demás esté bien
configurado (es una protección de seguridad del propio navegador, no un
error tuyo).

### E) Probarlo de punta a punta
Abre tu URL de Netlify/Vercel desde el celular (datos móviles, no wifi
de tu casa, para probar que de verdad es "internet" y no solo tu red
local). Crea una cuenta, entra como cliente desde otro dispositivo, haz
un pedido completo. Si algo falla, abre la consola del navegador (en el
celular es más difícil — pruébalo primero desde una laptop) y mándame el
error tal como hemos hecho hasta ahora.

## 10. Configurar la automatización con WhatsApp e Instagram

Esto requiere que tu backend ya esté desplegado en una URL pública con
HTTPS (paso 9) — Meta no acepta `localhost`.

**A) Crear la app en Meta:**
1. Ve a https://developers.facebook.com → "Mis apps" → "Crear app" → tipo "Negocio".
2. Dentro de la app, agrega el producto **WhatsApp** (te da un número de
   prueba gratis para empezar) y, si quieres Instagram, agrega también
   **Messenger** (Instagram usa la misma infraestructura de mensajería).

**B) Configurar el webhook:**
1. En la sección WhatsApp → Configuración, busca "Webhook".
2. URL de callback: `https://tu-backend.up.railway.app/api/webhooks/whatsapp`
3. Verify token: el mismo valor que pusiste en `META_VERIFY_TOKEN` en tu `.env`.
4. Suscríbete al campo `messages`.
5. Repite lo mismo para Instagram con la URL `/api/webhooks/instagram`
   (dentro de la configuración de Messenger/Instagram).

**C) Conseguir tus credenciales y guardarlas:**
- `META_APP_SECRET`: en Configuración básica de tu app de Meta ("App
  Secret"). **Sin esto, tu webhook queda sin protección**: cualquiera que
  descubra la URL podría fabricar mensajes falsos y crear pedidos o pagos
  a nombre de un cliente que no existe. Con `NODE_ENV=production` y sin
  este valor, el webhook se apaga solo (503) en vez de quedar expuesto.
- `WHATSAPP_ACCESS_TOKEN`: en WhatsApp → Configuración de la API, genera un
  token permanente (token de sistema) para tu número.
- `INSTAGRAM_ACCESS_TOKEN`: token de página de tu cuenta de Instagram
  Business conectada.
- Agrega ambos a las variables de entorno de tu servidor desplegado y
  reinicia el servicio.

**D) Vincular el número/página a tu comercio en Tendia:**
Cada comercio guarda a qué número de WhatsApp / página de Instagram
responde. Esto se hace con tu token de comerciante:
```bash
curl -X PUT https://tu-backend.up.railway.app/api/comercios/canales \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN_DEL_COMERCIANTE" \
  -d '{"whatsappPhoneNumberId":"EL_PHONE_NUMBER_ID_QUE_TE_DIO_META","instagramPageId":"EL_ID_DE_TU_PAGINA"}'
```

**E) Probar:** escríbele por WhatsApp a tu número de prueba: "hola". El
agente debería responder con el menú real de tu comercio. Escribe el
nombre de un producto para agregarlo, y "confirmar" para cerrar el
pedido — aparecerá de inmediato en `/api/pedidos` con `canal:"whatsapp"`.

**Mientras no configures los tokens reales**, el sistema queda en "modo
simulación": el webhook, el agente y toda la lógica de negocio funcionan
igual, solo que en vez de mandar el mensaje a Meta, lo registra
internamente (así es como lo probamos en este proyecto, sin necesitar
una cuenta de Meta real).

**Nota de escalabilidad:** en este MVP, `WHATSAPP_ACCESS_TOKEN` e
`INSTAGRAM_ACCESS_TOKEN` son un solo token global (pensado para un
comercio o para probar). Para que *cada* comercio conecte su propia
cuenta de Meta de forma independiente (multi-tenant real), el siguiente
paso es guardar un token de acceso por comercio (encriptado en la base de
datos) en vez de una variable de entorno global, y armar el flujo OAuth
de Meta para que el comerciante conecte su cuenta con un clic desde el
panel en vez de pegar IDs a mano.

## 11. Pagos en Venezuela: Pago Móvil, Zelle y Binance Pay

**Por qué es manual y no automático:** en 2026, ninguna pasarela de pago
global (Stripe, Mercado Pago, etc.) opera con comercios venezolanos por las
restricciones bancarias del país. El estándar real que usan los negocios
online en Venezuela es: el cliente paga por fuera (Pago Móvil, Zelle o
Binance Pay/USDT), reporta la referencia (+ opcionalmente una captura), y
el comercio verifica y aprueba desde su panel. Todos los precios de la
app están en **dólares** (guardados como centavos, ej. $3,50 = 350), y
Pago Móvil se calcula en bolívares a la tasa que tú cargas.

**Seguridad de este flujo (para que quede claro qué SÍ y qué NO se maneja):**
- Nunca se recibe ni se guarda número de tarjeta ni credenciales bancarias
  — solo la referencia que reporta el cliente y, opcionalmente, una
  imagen del comprobante.
- Las imágenes se validan por sus bytes reales (no solo por el nombre/tipo
  declarado), para que no se pueda colar un archivo malicioso disfrazado de foto.
- Una misma referencia de pago no se puede reutilizar dos veces en el
  mismo comercio (anti-fraude), y hay un máximo de 5 intentos de pago por pedido.
- El total que paga el cliente **siempre** se calcula en el servidor a
  partir del pedido real — nunca se confía en un monto que mande el navegador.
- El descuento de stock y la creación del pedido ocurren en una sola
  transacción atómica: no es posible vender más unidades de las que hay,
  ni siquiera con compras simultáneas.
- Cada pago aprobado o rechazado queda registrado con quién lo verificó y
  cuándo — es un historial de auditoría que nunca se borra.

### Configurar tus cobros (como comerciante)
En la app, entra a la pestaña **"Cobros"**:
1. Carga la tasa BCV del día (cópiala de bcv.org.ve). Actualízala cuando
   cambie — se aplica al instante al monto en bolívares que ve el cliente.
2. Activa los métodos que uses (Pago Móvil, Zelle, Binance Pay) con tus
   datos reales (banco/teléfono/cédula, correo de Zelle, o tu Pay ID).
3. Cuando un cliente reporte un pago, aparece en "Pagos por verificar" con
   su comprobante — revisas en tu banco/app y le das Aprobar o Rechazar
   (con motivo).

### Probarlo por API directamente
```bash
# Configurar tasa y métodos
curl -X PUT http://localhost:4000/api/pagos/config \
  -H "Content-Type: application/json" -H "Authorization: Bearer TOKEN_COMERCIANTE" \
  -d '{"tasaBs":40.50,"metodos":{"zelle":{"activo":true,"contacto":"tu@correo.com","titular":"Tu Nombre"}}}'

# El cliente consulta cómo pagar un pedido
curl http://localhost:4000/api/pagos/pedido/ID_DEL_PEDIDO/instrucciones -H "Authorization: Bearer TOKEN_CLIENTE"

# El cliente reporta su pago
curl -X POST http://localhost:4000/api/pagos/pedido/ID_DEL_PEDIDO/declarar \
  -H "Content-Type: application/json" -H "Authorization: Bearer TOKEN_CLIENTE" \
  -d '{"metodo":"zelle","referencia":"ABC123456"}'

# El comerciante aprueba
curl -X POST http://localhost:4000/api/pagos/ID_DEL_PAGO/aprobar -H "Authorization: Bearer TOKEN_COMERCIANTE"
```

### Por chat (WhatsApp/Instagram)
Al confirmar un pedido, el agente ya muestra los métodos activos y el
monto en las dos monedas. El cliente reporta su pago escribiendo:
```
PAGUE zelle ABC123456
```
(o `pago movil` / `binance` en vez de `zelle`). Igual queda "por
verificar" hasta que el comerciante lo apruebe desde Cobros.

### Camino a futuro: Binance Pay automático
Quedó fuera de este alcance (decisión tuya: "todo manual por ahora"). Si
más adelante te vuelves comerciante verificado en Binance, Binance Pay sí
tiene una API real con webhooks que confirma pagos al instante — sería el
siguiente paso natural para automatizar al menos ese método.

## 12. Actualizar una instalación que ya tenías corriendo

Si ya tenías el backend funcionando (con datos reales) y quieres subir a
esta versión, sigue estos pasos **en orden** — no pierdes tus datos:

1. **Guarda tu archivo `.env`** en otro lado (Notepad, otra carpeta) — tiene
   tu `DATABASE_URL` real, no lo pierdas.
2. Reemplaza el contenido de la carpeta `tendia-backend` por el de este
   paquete nuevo (puedes borrar la carpeta vieja y descomprimir esta).
3. Vuelve a poner tu archivo `.env` (con tu `DATABASE_URL` real) dentro de
   la carpeta. Revisa `.env.example` por si quieres copiar alguna variable
   nueva (como `META_APP_SECRET`, ver sección 10).
4. Instala las dependencias nuevas:
   ```
   npm install
   ```
5. Actualiza las tablas de la base de datos con los campos nuevos (esto
   NO borra tus datos existentes, solo agrega columnas y la tabla de pagos).
   **Usa `db push`, no `migrate`** — con datos reales, `migrate` a veces
   ofrece "resetear" la base si el historial de migraciones no coincide
   exactamente, y eso sí borraría todo:
   ```
   npx prisma db push
   ```
6. Reinicia el servidor (`Ctrl+C` si estaba corriendo, luego `npm run dev`).
7. Reemplaza también tu archivo `tendia-mini-agente.html` por el nuevo.
8. (Recomendado) corre `npm test` para confirmar que todo sigue funcionando
   en tu máquina antes de seguir usándolo.

### Qué hay de nuevo en esta actualización

**Precios en dólares** — todos los precios ahora son en USD (antes eran
pesos colombianos, un supuesto inicial que ya no aplica). Al crear o
editar un producto, escribes el precio normal con decimales (ej: `5.50`)
y la app lo convierte sola a centavos para guardarlo con precisión exacta.

**Pagos (Pago Móvil, Zelle, Binance Pay)** — ver la sección 11 completa.
En resumen: nueva pestaña "Cobros" para el comerciante (tasa BCV +
métodos + verificar pagos), y una pantalla de pago para el cliente después
de confirmar su pedido.

**Seguridad reforzada** — cabeceras de seguridad HTTP, límites de intentos
por IP (login, recuperar clave, pagos), bloqueo temporal de una cuenta
tras 5 contraseñas incorrectas seguidas, sesiones que expiran (12h por
defecto), verificación de firma en los webhooks de Meta (`META_APP_SECRET`
— sin esto, cualquiera podría fabricar mensajes falsos a tu webhook), CORS
restringido a tu dominio en producción, y el servidor ahora se niega a
arrancar en producción si detecta una configuración insegura (clave débil,
base de datos de pruebas, etc.).

**Fotos de producto y logo** (de la actualización anterior, sigue igual)
— dos fotos por producto y logo del negocio, ahora validados también por
el contenido real del archivo (no solo por su nombre), para que no se
pueda subir algo malicioso disfrazado de imagen.

## 13. Conectar el correo real de "olvidé mi contraseña" (opcional)

Si quieres que los enlaces de recuperación lleguen de verdad al correo del
usuario (en vez del modo simulación), la forma más simple es usar tu
propio Gmail:

1. Entra a tu cuenta de Google → activa la **verificación en 2 pasos** si
   no la tienes.
2. Ve a **myaccount.google.com/apppasswords** y genera una "contraseña de
   aplicación" (un código de 16 letras).
3. En tu `.env`:
   ```
   SMTP_HOST="smtp.gmail.com"
   SMTP_PORT=587
   SMTP_USER="tu-correo@gmail.com"
   SMTP_PASS="la-contraseña-de-aplicación-de-16-letras"
   MAIL_FROM="Tendia <tu-correo@gmail.com>"
   FRONTEND_URL="https://donde-publiques-tu-html"
   ```
4. Reinicia el servidor. Ya los correos de recuperación se envían de verdad.

## 14. Conectar con el archivo `tendia-mini-agente.html`

En el archivo del frontend, el formulario de login actualmente **simula**
el ingreso. Para conectarlo de verdad, reemplaza el `onsubmit` del
`loginForm` por una llamada a estos endpoints:

```js
const API_URL = "https://tendia-backend.up.railway.app"; // tu URL real

document.getElementById("loginForm").onsubmit = async (e) => {
  e.preventDefault();
  const email = e.target.querySelector('input[type="text"]').value;
  const password = e.target.querySelector('input[type="password"]').value;

  const resp = await fetch(`${API_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await resp.json();

  if (!resp.ok) { toast(data.error); return; }

  // Guarda el token para futuras peticiones.
  // Nota: dentro de un Artifact de Claude.ai no se permite localStorage;
  // pero una vez este HTML esté publicado como tu propio sitio (fuera de
  // Claude.ai), localStorage o cookies funcionan normalmente.
  localStorage.setItem("tendia_token", data.token);

  state.role = data.usuario.role.toLowerCase();
  // ... cargar datos reales del usuario en vez de los datos de ejemplo (DB)
  render();
};
```

Y en cada llamada futura al backend (por ejemplo para traer productos o
pedidos reales) agregas el token:

```js
fetch(`${API_URL}/api/productos`, {
  headers: { Authorization: `Bearer ${localStorage.getItem("tendia_token")}` }
});
```

## Estado del proyecto

**Completo y probado (183 pruebas de integración + 22 pruebas de
seguridad de infraestructura + 16 pruebas de contrato del frontend = 221
pruebas, todas contra servidores reales — no revisión de código; incluye
verificación por mutación: rompí el código a propósito varias veces para
confirmar que la suite realmente detecta los errores):**
- Autenticación real (Comerciante / Cliente) con JWT, contraseñas
  encriptadas, bloqueo por intentos fallidos y sesiones con vencimiento.
- Recuperación de contraseña por correo (con modo simulación si no configuras SMTP).
- Productos y menú público en **dólares**, con hasta 2 fotos por producto
  (JPG/PNG, validadas por su contenido real, no solo por el nombre).
- Logo del negocio, visible en la barra superior y en el directorio de comercios.
- CRM de clientes con historial de compras y exportación CSV (a prueba de
  inyección de fórmulas de Excel).
- Pedidos: checkout con precios calculados en el servidor, control de
  stock **atómico** (sin sobreventa, ni con compras simultáneas), flujo de
  estados (nuevo → proceso → listo → entregado / cancelado) — cancelar
  devuelve el stock automáticamente.
- **Pagos para Venezuela** (Pago Móvil, Zelle, Binance Pay): flujo manual
  con comprobante y verificación del comerciante, monto en USD y Bs a la
  tasa BCV que el comerciante actualiza, anti-fraude (referencias que no
  se repiten, límite de intentos), y reembolso marcado cuando se cancela
  un pedido ya pagado.
- Seguridad de infraestructura: cabeceras HTTP (helmet), CORS restringido
  en producción, límites de intentos por IP, verificación de firma en los
  webhooks de Meta, y el servidor se niega a arrancar en producción con
  una configuración insegura.
- Automatización con WhatsApp e Instagram: webhooks reales (firmados),
  agente conversacional que muestra el menú, arma el carrito, confirma
  pedidos y ahora también recibe el reporte de pago por chat ("PAGUE
  zelle ABC123"), reconoce al mismo cliente si vuelve a escribir, y
  respeta el stock disponible.
- Frontend (`tendia-mini-agente.html`) conectado de verdad al backend vía
  `fetch()`: login, registro, recuperar clave, dashboard con datos reales,
  catálogo con fotos, logo, CRM, pedidos, pantalla de Cobros (tasa +
  métodos + verificación) y pantalla de pago para el cliente.

Con esto, el ciclo completo del negocio que pediste al inicio ya está
resuelto de punta a punta: ofrecer productos según el cliente (con foto),
mini CRM exportable, menú por comercio con ofertas, pedidos gestionables
por estado, pago real (aunque manual, como corresponde en Venezuela),
atención automatizada por WhatsApp/Instagram, y recuperación de
contraseña — todo con sesión separada para comerciante y cliente, y con
la seguridad tratada como prioridad, no como un extra.

**Para dejarlo funcionando con datos, correos, pagos y mensajes reales**,
solo falta que tú (fuera de este entorno, que no tiene salida a internet
hacia esos servicios): crees la base de datos en Neon/Supabase (paso 1),
despliegues el servidor en Railway/Render con `NODE_ENV=production` (paso
9), conectes tu cuenta de Meta Business (paso 10), configures tus datos
reales de cobro en la pestaña Cobros (paso 11), y opcionalmente actives
el envío real de correo (paso 13). El código y la lógica ya están listos
y probados; lo que falta es infraestructura externa que solo se puede
crear con tus propias credenciales.

**Pendiente, fuera del alcance actual** (mencionado y en espera por
decisión tuya):
- **Marketplace** de Meta como tercer canal de automatización (solo están
  WhatsApp e Instagram).
- **Binance Pay automático** (API real con webhooks) — hoy Binance Pay
  también es manual con comprobante, igual que Pago Móvil y Zelle.

**Próximos pasos opcionales** (dime si quieres que construya alguno):
- Un LLM real (en vez de las reglas por palabras clave) para que el
  agente entienda pedidos más naturales y ambiguos.
- Notificaciones al comerciante (push o WhatsApp) cuando entra un pedido
  nuevo o un pago por verificar.
- Mover las imágenes de la base de datos a un servicio de almacenamiento
  (Cloudinary/S3) si el catálogo crece mucho.
- Guía paso a paso para desplegar todo en producción y empezar a ofrecer
  Tendia a comerciantes reales.
