// Prueba de integración real: levanta el servidor Express de verdad
// (con la base de datos de prueba SQLite) y le hace peticiones HTTP reales,
// exactamente como lo haría el frontend.

const { spawn } = require("child_process");
const path = require("path");

const PORT = 4501;
const BASE = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✔ ${msg}`); }
  else { fail++; console.log(`  ✘ FALLA: ${msg}`); }
}

async function esperarServidor(intentos = 30) {
  for (let i = 0; i < intentos; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("El servidor no arrancó a tiempo.");
}

// El webhook responde 200 a Meta de inmediato y sigue procesando el
// mensaje en segundo plano (así debe ser: Meta exige un ack rápido).
// Esta función espera hasta que aparezca la condición esperada, con
// reintentos cortos, en vez de un sleep fijo poco confiable.
async function esperarHasta(condicionAsync, intentos = 25, esperaMs = 100) {
  for (let i = 0; i < intentos; i++) {
    const resultado = await condicionAsync();
    if (resultado) return resultado;
    await new Promise((r) => setTimeout(r, esperaMs));
  }
  return null;
}

async function main() {
  const server = spawn("node", ["src/index.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT, USE_TEST_DB: "1", RATE_LIMIT_DISABLED: "1", JWT_SECRET: "clave-de-prueba-integracion", META_VERIFY_TOKEN: "token-de-verificacion-prueba" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

  try {
    await esperarServidor();
    console.log("Servidor de prueba arriba en", BASE, "\n");

    // ---------- 1) Registro de dos comerciantes distintos ----------
    console.log("1) Registro y login de comerciantes");
    let r = await fetch(`${BASE}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "COMERCIANTE", nombre: "Marta Ruiz", email: "marta@panaderia.com", password: "123456", comercioNombre: "Panadería Doña Marta", categoria: "Panadería" }),
    });
    let data = await r.json();
    assert(r.status === 201 && data.token, "Comerciante 1 (Marta) se registra y recibe token");
    const tokenMarta = data.token;
    const comercioMartaId = data.usuario.comercioId;

    r = await fetch(`${BASE}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "COMERCIANTE", nombre: "Julián Pérez", email: "julian@ferreteria.com", password: "123456", comercioNombre: "Ferretería El Tornillo" }),
    });
    data = await r.json();
    assert(r.status === 201, "Comerciante 2 (Julián) se registra correctamente");
    const tokenJulian = data.token;

    r = await fetch(`${BASE}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "COMERCIANTE", nombre: "Otra Marta", email: "marta@panaderia.com", password: "123456", comercioNombre: "Otro negocio" }),
    });
    assert(r.status === 409, "Rechaza registrar dos cuentas con el mismo correo");

    // ---------- 2) Registro de clientes ----------
    console.log("\n2) Registro de clientes");
    r = await fetch(`${BASE}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "CLIENTE", nombre: "Laura Gómez", email: "laura@correo.com", password: "123456", telefono: "+573112223344" }),
    });
    data = await r.json();
    assert(r.status === 201, "Cliente Laura se registra correctamente");
    const laura = data.usuario;

    r = await fetch(`${BASE}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "CLIENTE", nombre: "Andrés Ríos", email: "andres@correo.com", password: "123456" }),
    });
    data = await r.json();
    const andres = data.usuario;
    assert(r.status === 201, "Cliente Andrés se registra correctamente");

    // ---------- 3) Productos: creación y validaciones ----------
    console.log("\n3) Productos: crear, validar, listar");
    r = await fetch(`${BASE}/api/productos`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ nombre: "Torta de chocolate", categoria: "Repostería", precio: 38000, precioAntes: 48000, promo: "20% off · miércoles", stock: 6 }),
    });
    data = await r.json();
    assert(r.status === 201 && data.producto.id, "Crea producto con promoción válida");
    const productoTortaId = data.producto.id;

    r = await fetch(`${BASE}/api/productos`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ nombre: "Pan de yuca (docena)", categoria: "Panadería", precio: 14000, stock: 32 }),
    });
    assert(r.status === 201, "Crea producto sin promoción");

    r = await fetch(`${BASE}/api/productos`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ nombre: "Producto raro", precio: -500 }),
    });
    assert(r.status === 400, "Rechaza precio negativo");

    r = await fetch(`${BASE}/api/productos`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ nombre: "Torta engañosa", precio: 40000, precioAntes: 30000 }),
    });
    assert(r.status === 400, "Rechaza promo donde 'precio antes' es menor al precio actual");

    r = await fetch(`${BASE}/api/productos`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nombre: "Sin sesión", precio: 1000 }),
    });
    assert(r.status === 401, "Rechaza crear producto sin token");

    r = await fetch(`${BASE}/api/productos`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${await tokenClienteLaura(BASE, laura)}` },
      body: JSON.stringify({ nombre: "Intento de cliente", precio: 1000 }),
    });
    assert(r.status === 403, "Rechaza crear producto si el usuario es CLIENTE, no COMERCIANTE");

    r = await fetch(`${BASE}/api/productos`, { headers: { Authorization: `Bearer ${tokenMarta}` } });
    data = await r.json();
    assert(r.status === 200 && data.productos.length === 2, "Marta ve exactamente sus 2 productos en su panel");

    // ---------- 4) Menú público (lo que ve el cliente) ----------
    console.log("\n4) Menú público del comercio");
    r = await fetch(`${BASE}/api/productos/publico/${comercioMartaId}`);
    data = await r.json();
    assert(r.status === 200 && data.comercio.nombre === "Panadería Doña Marta", "El menú público muestra el nombre del comercio");
    assert(data.productos.length === 2, "El menú público muestra los productos sin necesidad de login");

    // ---------- 5) Aislamiento entre comerciantes ----------
    console.log("\n5) Un comerciante no puede tocar productos de otro");
    r = await fetch(`${BASE}/api/productos/${productoTortaId}`, {
      method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenJulian}` },
      body: JSON.stringify({ precio: 1 }),
    });
    assert(r.status === 403, "Julián no puede editar un producto de Marta");

    r = await fetch(`${BASE}/api/productos/${productoTortaId}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${tokenJulian}` },
    });
    assert(r.status === 403, "Julián no puede borrar un producto de Marta");

    r = await fetch(`${BASE}/api/productos/${productoTortaId}`, {
      method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ precio: 35000 }),
    });
    data = await r.json();
    assert(r.status === 200 && data.producto.precio === 35000, "Marta sí puede actualizar su propio producto");

    console.log("\n5b) Borrar productos y manejar 404");
    r = await fetch(`${BASE}/api/productos/${productoTortaId}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${tokenMarta}` },
    });
    assert(r.status === 200, "Marta sí puede borrar su propio producto");

    r = await fetch(`${BASE}/api/productos/${productoTortaId}`, {
      method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ precio: 1000 }),
    });
    assert(r.status === 404, "Editar un producto ya borrado devuelve 404");

    r = await fetch(`${BASE}/api/productos`, { headers: { Authorization: `Bearer ${tokenMarta}` } });
    data = await r.json();
    assert(data.productos.length === 1, "Tras el borrado, Marta ahora ve solo 1 producto");

    // ---------- 6) CRM: vincular clientes ----------
    console.log("\n6) CRM: vincular clientes al comercio");
    r = await fetch(`${BASE}/api/clientes`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ email: "laura@correo.com" }),
    });
    assert(r.status === 201, "Vincula a Laura como cliente del negocio de Marta");

    r = await fetch(`${BASE}/api/clientes`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ email: "laura@correo.com" }),
    });
    assert(r.status === 409, "No permite vincular al mismo cliente dos veces");

    r = await fetch(`${BASE}/api/clientes`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ email: "noexiste@correo.com" }),
    });
    assert(r.status === 404, "Rechaza vincular un correo que no existe como cliente");

    r = await fetch(`${BASE}/api/clientes`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ email: "andres@correo.com" }),
    });
    assert(r.status === 201, "Vincula a Andrés como cliente del negocio de Marta");

    // ---------- 7) CRM: registrar compras e historial ----------
    console.log("\n7) CRM: registrar compras y ver historial");
    r = await fetch(`${BASE}/api/clientes/${laura.id}/compras`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ items: "Torta de chocolate", total: 35000 }),
    });
    assert(r.status === 201, "Registra la 1ra compra de Laura");

    r = await fetch(`${BASE}/api/clientes/${laura.id}/compras`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ items: "Pan de yuca (docena) x2", total: 28000 }),
    });
    assert(r.status === 201, "Registra la 2da compra de Laura");

    r = await fetch(`${BASE}/api/clientes/${laura.id}/historial`, { headers: { Authorization: `Bearer ${tokenMarta}` } });
    data = await r.json();
    assert(data.pedidos.length === 2, "El historial de Laura muestra sus 2 compras");

    r = await fetch(`${BASE}/api/clientes`, { headers: { Authorization: `Bearer ${tokenMarta}` } });
    data = await r.json();
    const lauraEnCRM = data.clientes.find((c) => c.id === laura.id);
    assert(lauraEnCRM.totalComprado === 63000, `El total comprado de Laura suma correctamente (63000, obtuvo ${lauraEnCRM.totalComprado})`);
    assert(data.clientes.length === 2, "El CRM de Marta muestra exactamente 2 clientes (Laura y Andrés)");

    // ---------- 8) Aislamiento del CRM entre comercios ----------
    console.log("\n8) El CRM de un comercio no mezcla clientes de otro");
    r = await fetch(`${BASE}/api/clientes`, { headers: { Authorization: `Bearer ${tokenJulian}` } });
    data = await r.json();
    assert(data.clientes.length === 0, "El CRM de Julián está vacío (no ve los clientes de Marta)");

    // ---------- 9) Exportar CSV real ----------
    console.log("\n9) Exportar CRM en CSV");
    r = await fetch(`${BASE}/api/clientes/export/csv`, { headers: { Authorization: `Bearer ${tokenMarta}` } });
    const csv = await r.text();
    assert(r.headers.get("content-type").includes("text/csv"), "El export responde con content-type text/csv");
    assert(csv.includes("Laura Gómez") && csv.includes("630.00"), "El CSV contiene los datos reales de Laura y su total");
    assert(csv.split("\n").length === 3, "El CSV tiene encabezado + 2 clientes (3 líneas)");

    r = await fetch(`${BASE}/api/clientes/export/csv`);
    assert(r.status === 401, "El export rechaza peticiones sin sesión");

    // ---------- 10) Pedidos: checkout real desde el carrito ----------
    console.log("\n10) Pedidos: crear desde el carrito con cálculo de precio en servidor");
    r = await fetch(`${BASE}/api/productos`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ nombre: "Café + croissant", categoria: "Combos", precio: 9500, stock: 40 }),
    });
    data = await r.json();
    const productoCafeId = data.producto.id;

    r = await fetch(`${BASE}/api/productos`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ nombre: "Caja de 6 empanadas", categoria: "Salado", precio: 18000, stock: 20 }),
    });
    data = await r.json();
    const productoEmpanadasId = data.producto.id;

    const tokenLaura = await tokenClienteLaura(BASE, laura);

    r = await fetch(`${BASE}/api/pedidos`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenLaura}` },
      body: JSON.stringify({ comercioId: comercioMartaId, items: [{ productoId: productoCafeId, cantidad: 2 }, { productoId: productoEmpanadasId, cantidad: 1 }] }),
    });
    data = await r.json();
    assert(r.status === 201, "Laura crea un pedido con 2 productos");
    assert(data.pedido.total === 9500 * 2 + 18000, `El total se calcula en el servidor correctamente (obtuvo ${data.pedido.total})`);
    assert(data.pedido.estado === "nuevo", "El pedido nace en estado 'nuevo'");
    assert(data.pedido.items.includes("Café + croissant") && data.pedido.items.includes("Caja de 6 empanadas"), "El resumen de items incluye ambos productos");
    const pedidoId = data.pedido.id;

    r = await fetch(`${BASE}/api/productos`, { headers: { Authorization: `Bearer ${tokenMarta}` } });
    data = await r.json();
    const cafeActualizado = data.productos.find((p) => p.id === productoCafeId);
    assert(cafeActualizado.stock === 38, `El stock del café se descontó correctamente (2 unidades, quedó en ${cafeActualizado.stock})`);

    // ---------- 11) Pedidos: validaciones de negocio ----------
    console.log("\n11) Pedidos: validaciones (stock, producto ajeno, roles)");
    r = await fetch(`${BASE}/api/pedidos`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenLaura}` },
      body: JSON.stringify({ comercioId: comercioMartaId, items: [{ productoId: productoCafeId, cantidad: 999 }] }),
    });
    assert(r.status === 400, "Rechaza pedido sin stock suficiente");

    // Julián no tiene productos aún, le creamos uno para probar aislamiento
    r = await fetch(`${BASE}/api/productos`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenJulian}` },
      body: JSON.stringify({ nombre: "Martillo", precio: 25000, stock: 10 }),
    });
    data = await r.json();
    const productoMartilloId = data.producto.id;

    r = await fetch(`${BASE}/api/pedidos`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenLaura}` },
      body: JSON.stringify({ comercioId: comercioMartaId, items: [{ productoId: productoMartilloId, cantidad: 1 }] }),
    });
    assert(r.status === 404, "Rechaza pedir un producto que no pertenece al comercio indicado (martillo de Julián vs comercio de Marta)");

    r = await fetch(`${BASE}/api/pedidos`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ comercioId: comercioMartaId, items: [{ productoId: productoCafeId, cantidad: 1 }] }),
    });
    assert(r.status === 403, "Un COMERCIANTE no puede hacer pedidos como si fuera cliente (solo CLIENTE)");

    r = await fetch(`${BASE}/api/pedidos`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comercioId: comercioMartaId, items: [{ productoId: productoCafeId, cantidad: 1 }] }),
    });
    assert(r.status === 401, "Rechaza crear pedido sin sesión");

    // ---------- 12) Pedidos: listar con aislamiento por rol ----------
    console.log("\n12) Pedidos: listar según el rol de quien pregunta");
    r = await fetch(`${BASE}/api/pedidos`, { headers: { Authorization: `Bearer ${tokenMarta}` } });
    data = await r.json();
    assert(
      data.pedidos.length === 3 && data.pedidos.some((p) => p.id === pedidoId),
      `Marta ve los 3 pedidos de su negocio (2 compras manuales previas + el checkout nuevo), obtuvo ${data.pedidos.length}`
    );

    r = await fetch(`${BASE}/api/pedidos`, { headers: { Authorization: `Bearer ${tokenJulian}` } });
    data = await r.json();
    assert(data.pedidos.length === 0, "Julián no ve pedidos ajenos (no le han pedido nada a él)");

    r = await fetch(`${BASE}/api/pedidos`, { headers: { Authorization: `Bearer ${tokenLaura}` } });
    data = await r.json();
    assert(
      data.pedidos.length === 3 && data.pedidos.some((p) => p.id === pedidoId),
      `Laura ve sus 3 pedidos en 'mis compras' (incluye el checkout nuevo), obtuvo ${data.pedidos.length}`
    );

    const tokenAndres = await tokenClienteLaura(BASE, andres); // reutilizamos el helper (login genérico)
    r = await fetch(`${BASE}/api/pedidos/${pedidoId}`, { headers: { Authorization: `Bearer ${tokenAndres}` } });
    assert(r.status === 403, "Andrés no puede ver el detalle del pedido de Laura");

    r = await fetch(`${BASE}/api/pedidos/${pedidoId}`, { headers: { Authorization: `Bearer ${tokenJulian}` } });
    assert(r.status === 403, "Julián (otro comercio) no puede ver el detalle del pedido de Marta");

    r = await fetch(`${BASE}/api/pedidos/${pedidoId}`, { headers: { Authorization: `Bearer ${tokenLaura}` } });
    assert(r.status === 200, "Laura sí puede ver el detalle de su propio pedido");

    // ---------- 13) Pedidos: flujo de estados ----------
    console.log("\n13) Pedidos: flujo de estados nuevo → proceso → listo → entregado");
    r = await fetch(`${BASE}/api/pedidos/${pedidoId}/estado`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenLaura}` },
      body: JSON.stringify({ estado: "proceso" }),
    });
    assert(r.status === 403, "El cliente no puede cambiar el estado de su propio pedido (solo el comerciante)");

    r = await fetch(`${BASE}/api/pedidos/${pedidoId}/estado`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenJulian}` },
      body: JSON.stringify({ estado: "proceso" }),
    });
    assert(r.status === 403, "Julián no puede cambiar el estado de un pedido de otro negocio");

    r = await fetch(`${BASE}/api/pedidos/${pedidoId}/estado`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ estado: "entregado" }),
    });
    assert(r.status === 400, "No permite saltar de 'nuevo' directo a 'entregado'");

    r = await fetch(`${BASE}/api/pedidos/${pedidoId}/estado`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ estado: "proceso" }),
    });
    data = await r.json();
    assert(r.status === 200 && data.pedido.estado === "proceso", "Marta avanza el pedido de 'nuevo' a 'proceso'");

    r = await fetch(`${BASE}/api/pedidos/${pedidoId}/estado`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ estado: "listo" }),
    });
    assert(r.status === 200, "Marta avanza el pedido de 'proceso' a 'listo'");

    // Antes de entregar: el total comprado de Laura debe seguir igual al de antes
    // (63000, de sus 2 compras manuales de la sección 7) — el pedido nuevo aún no cuenta.
    r = await fetch(`${BASE}/api/clientes`, { headers: { Authorization: `Bearer ${tokenMarta}` } });
    data = await r.json();
    let lauraCRM = data.clientes.find((c) => c.id === laura.id);
    assert(lauraCRM.totalComprado === 63000, `El total comprado de Laura NO sube mientras el pedido no esté 'entregado' (sigue en 63000, obtuvo ${lauraCRM.totalComprado})`);

    r = await fetch(`${BASE}/api/pedidos/${pedidoId}/estado`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ estado: "entregado" }),
    });
    assert(r.status === 200, "Marta marca el pedido como 'entregado'");

    r = await fetch(`${BASE}/api/pedidos/${pedidoId}/estado`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ estado: "nuevo" }),
    });
    assert(r.status === 400, "Un pedido 'entregado' no se puede reabrir ni cambiar de estado");

    // ---------- 14) Pedidos: al entregarse sí se refleja en el CRM ----------
    console.log("\n14) El total comprado sube en el CRM al momento de entregar");
    r = await fetch(`${BASE}/api/clientes`, { headers: { Authorization: `Bearer ${tokenMarta}` } });
    data = await r.json();
    lauraCRM = data.clientes.find((c) => c.id === laura.id);
    assert(lauraCRM.totalComprado === 63000 + (9500 * 2 + 18000), `El total comprado de Laura ahora suma también el pedido entregado (63000 + 37000 = 100000, obtuvo ${lauraCRM.totalComprado})`);

    // ---------- 15) Pedidos: cancelación ----------
    console.log("\n15) Pedidos: cancelar antes de que esté listo");
    r = await fetch(`${BASE}/api/pedidos`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenLaura}` },
      body: JSON.stringify({ comercioId: comercioMartaId, items: [{ productoId: productoEmpanadasId, cantidad: 1 }] }),
    });
    data = await r.json();
    const pedidoCancelableId = data.pedido.id;

    r = await fetch(`${BASE}/api/pedidos/${pedidoCancelableId}/estado`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ estado: "cancelado" }),
    });
    assert(r.status === 200, "Se puede cancelar un pedido en estado 'nuevo'");

    r = await fetch(`${BASE}/api/pedidos/${pedidoCancelableId}/estado`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ estado: "proceso" }),
    });
    assert(r.status === 400, "Un pedido cancelado no se puede reactivar");

    // ---------- 16) Automatización: verificación del webhook ----------
    console.log("\n16) Webhook: verificación (handshake de Meta)");
    r = await fetch(`${BASE}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=token-de-verificacion-prueba&hub.challenge=abc123`);
    let texto = await r.text();
    assert(r.status === 200 && texto === "abc123", "Responde el challenge cuando el verify_token es correcto");

    r = await fetch(`${BASE}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=token-incorrecto&hub.challenge=abc123`);
    assert(r.status === 403, "Rechaza la verificación si el verify_token no coincide");

    // ---------- 17) Conectar canal de WhatsApp del comercio ----------
    console.log("\n17) Comerciante conecta su número de WhatsApp");
    const PHONE_ID_MARTA = "wa-phone-marta-001";
    r = await fetch(`${BASE}/api/comercios/canales`, {
      method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ whatsappPhoneNumberId: PHONE_ID_MARTA }),
    });
    data = await r.json();
    assert(r.status === 200 && data.whatsapp.conectado === true, "Marta conecta su WhatsApp Business");

    // Producto fresco y predecible para la conversación del agente.
    r = await fetch(`${BASE}/api/productos`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ nombre: "Empanada de pollo", categoria: "Salado", precio: 5000, stock: 10 }),
    });
    data = await r.json();
    const productoEmpanadaId = data.producto.id;

    // ---------- 18) Conversación real de WhatsApp: saludo → menú ----------
    console.log("\n18) Agente de WhatsApp: saludo y menú");
    const telefonoChat = "573009998877";
    function payloadWhatsapp(telefono, texto, phoneNumberId) {
      return {
        object: "whatsapp_business_account",
        entry: [{
          id: "WABA_ID",
          changes: [{
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: phoneNumberId, display_phone_number: phoneNumberId },
              contacts: [{ profile: { name: "Cliente prueba" }, wa_id: telefono }],
              messages: [{ from: telefono, id: "wamid." + Date.now(), timestamp: String(Date.now()), type: "text", text: { body: texto } }],
            },
          }],
        }],
      };
    }

    async function ultimoMensajeWhatsapp(telefonoEsperado) {
      const resp = await fetch(`${BASE}/api/test/outbox`);
      const d = await resp.json();
      const propios = d.whatsapp.filter((m) => m.telefonoDestino === telefonoEsperado);
      return propios[propios.length - 1] || null;
    }

    r = await fetch(`${BASE}/api/webhooks/whatsapp`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payloadWhatsapp(telefonoChat, "Hola", PHONE_ID_MARTA)),
    });
    assert(r.status === 200, "El webhook responde 200 (ack) de inmediato al recibir un mensaje");

    let msj = await esperarHasta(async () => {
      const m = await ultimoMensajeWhatsapp(telefonoChat);
      return m && m.texto.includes("menú") ? m : null;
    });
    assert(!!msj, "El agente respondió con el saludo y el menú");
    assert(msj && msj.texto.includes("Empanada de pollo"), "El menú enviado incluye el producto real del comercio");

    // ---------- 19) Agente arma el carrito por nombre ----------
    console.log("\n19) Agente de WhatsApp: agregar producto al carrito por nombre");
    await fetch(`${BASE}/api/webhooks/whatsapp`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payloadWhatsapp(telefonoChat, "empanada", PHONE_ID_MARTA)),
    });
    msj = await esperarHasta(async () => {
      const m = await ultimoMensajeWhatsapp(telefonoChat);
      return m && m.texto.startsWith("Agregado") ? m : null;
    });
    assert(!!msj, "El agente confirma que agregó la empanada al pedido");
    assert(msj && msj.texto.includes("$50,00"), "El total parcial refleja el precio real del producto en USD ($50,00 = 5000 centavos)");

    // ---------- 20) Agente confirma el pedido: se crea un pedido real ----------
    console.log("\n20) Agente de WhatsApp: confirmar crea un pedido real");
    await fetch(`${BASE}/api/webhooks/whatsapp`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payloadWhatsapp(telefonoChat, "confirmar", PHONE_ID_MARTA)),
    });
    msj = await esperarHasta(async () => {
      const m = await ultimoMensajeWhatsapp(telefonoChat);
      return m && m.texto.includes("confirmado") ? m : null;
    });
    assert(!!msj, "El agente confirma el pedido por chat");

    r = await fetch(`${BASE}/api/pedidos?estado=nuevo`, { headers: { Authorization: `Bearer ${tokenMarta}` } });
    data = await r.json();
    const pedidoDesdeChat = data.pedidos.find((p) => p.canal === "whatsapp" && p.total === 5000);
    assert(!!pedidoDesdeChat, "El pedido creado por WhatsApp aparece de verdad en el panel de Marta, con canal='whatsapp'");

    r = await fetch(`${BASE}/api/productos`, { headers: { Authorization: `Bearer ${tokenMarta}` } });
    data = await r.json();
    const empanadaActualizada = data.productos.find((p) => p.id === productoEmpanadaId);
    assert(empanadaActualizada.stock === 9, `El stock también se descuenta cuando el pedido llega por WhatsApp (quedó en 9, obtuvo ${empanadaActualizada.stock})`);

    // ---------- 21) El mismo teléfono no duplica cliente ----------
    console.log("\n21) El mismo número de WhatsApp no crea un cliente duplicado");
    await fetch(`${BASE}/api/webhooks/whatsapp`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payloadWhatsapp(telefonoChat, "empanada", PHONE_ID_MARTA)),
    });
    await esperarHasta(async () => {
      const m = await ultimoMensajeWhatsapp(telefonoChat);
      return m && m.texto.startsWith("Agregado") ? m : null;
    });
    await fetch(`${BASE}/api/webhooks/whatsapp`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payloadWhatsapp(telefonoChat, "confirmar", PHONE_ID_MARTA)),
    });
    await esperarHasta(async () => {
      const m = await ultimoMensajeWhatsapp(telefonoChat);
      return m && m.texto.includes("confirmado") && m.ts > (msj?.ts || 0) ? m : null;
    });

    r = await fetch(`${BASE}/api/pedidos`, { headers: { Authorization: `Bearer ${tokenMarta}` } });
    data = await r.json();
    const pedidosDeEsteTelefono = data.pedidos.filter((p) => p.canal === "whatsapp" && p.total === 5000);
    const clienteIdsUnicos = new Set(pedidosDeEsteTelefono.map((p) => p.clienteId));
    assert(pedidosDeEsteTelefono.length === 2, "El mismo teléfono ya hizo 2 pedidos por chat");
    assert(clienteIdsUnicos.size === 1, "Ambos pedidos pertenecen al mismo cliente (no se duplicó por escribir de nuevo)");

    // ---------- 22) Sin stock suficiente, el agente no crea el pedido ----------
    console.log("\n22) Agente de WhatsApp: rechaza pedidos sin stock suficiente");
    await fetch(`${BASE}/api/webhooks/whatsapp`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payloadWhatsapp(telefonoChat, "20 empanada", PHONE_ID_MARTA)),
    });
    await esperarHasta(async () => {
      const m = await ultimoMensajeWhatsapp(telefonoChat);
      return m && m.texto.startsWith("Agregado") ? m : null;
    });
    r = await fetch(`${BASE}/api/pedidos`, { headers: { Authorization: `Bearer ${tokenMarta}` } });
    const totalPedidosAntes = (await r.json()).pedidos.length;

    await fetch(`${BASE}/api/webhooks/whatsapp`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payloadWhatsapp(telefonoChat, "confirmar", PHONE_ID_MARTA)),
    });
    msj = await esperarHasta(async () => {
      const m = await ultimoMensajeWhatsapp(telefonoChat);
      return m && m.texto.includes("No pude completar") ? m : null;
    });
    assert(!!msj, "El agente avisa por chat que no hay stock suficiente");

    r = await fetch(`${BASE}/api/pedidos`, { headers: { Authorization: `Bearer ${tokenMarta}` } });
    data = await r.json();
    assert(data.pedidos.length === totalPedidosAntes, "No se creó ningún pedido nuevo cuando falló por falta de stock");

    // ---------- 23) Mensaje a un número no conectado a ningún comercio ----------
    console.log("\n23) Webhook ignora mensajes de números no conectados, sin caerse");
    r = await fetch(`${BASE}/api/webhooks/whatsapp`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payloadWhatsapp("573000000000", "hola", "phone-id-fantasma-sin-comercio")),
    });
    assert(r.status === 200, "El webhook igual responde 200 aunque el número no esté vinculado a ningún comercio");
    r = await fetch(`${BASE}/api/health`);
    assert(r.status === 200, "El servidor sigue sano después de un mensaje sin comercio asociado");

    // ---------- 24) Automatización de Instagram ----------
    console.log("\n24) Agente de Instagram: conectar página y conversar");
    const PAGE_ID_MARTA = "ig-page-marta-001";
    r = await fetch(`${BASE}/api/comercios/canales`, {
      method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ instagramPageId: PAGE_ID_MARTA }),
    });
    data = await r.json();
    assert(r.status === 200 && data.instagram.conectado === true, "Marta conecta su página de Instagram");

    const psidChat = "ig-psid-usuario-001";
    function payloadInstagram(psid, texto, pageId) {
      return {
        object: "instagram",
        entry: [{
          id: pageId, time: Date.now(),
          messaging: [{ sender: { id: psid }, recipient: { id: pageId }, timestamp: Date.now(), message: { mid: "m_" + Date.now(), text: texto } }],
        }],
      };
    }

    r = await fetch(`${BASE}/api/webhooks/instagram`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payloadInstagram(psidChat, "hola", PAGE_ID_MARTA)),
    });
    assert(r.status === 200, "El webhook de Instagram responde 200 (ack) de inmediato");

    msj = await esperarHasta(async () => {
      const resp = await fetch(`${BASE}/api/test/outbox`);
      const d = await resp.json();
      const propios = d.instagram.filter((m) => m.psidDestino === psidChat);
      return propios[propios.length - 1] || null;
    });
    assert(!!msj, "El agente respondió por Instagram");
    assert(msj && msj.texto.includes("Empanada de pollo"), "El menú por Instagram también refleja el catálogo real del comercio");

    // ---------- 25) Directorio público de comercios ----------
    console.log("\n25) Directorio público de comercios (para que el cliente explore)");
    r = await fetch(`${BASE}/api/comercios/publico`);
    data = await r.json();
    assert(r.status === 200, "El directorio público responde sin necesidad de sesión");
    assert(data.comercios.some((c) => c.nombre === "Panadería Doña Marta"), "El directorio incluye el comercio de Marta");
    assert(data.comercios.some((c) => c.nombre === "Ferretería El Tornillo"), "El directorio incluye el comercio de Julián");
    assert(!("email" in (data.comercios[0] || {})) , "El directorio no expone datos sensibles, solo id/nombre/categoría");

    // ---------- 26) Recuperación de contraseña ----------
    console.log("\n26) Recuperación de contraseña (olvidé mi clave)");
    r = await fetch(`${BASE}/api/auth/forgot-password`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "laura@correo.com" }),
    });
    data = await r.json();
    assert(r.status === 200 && data.resetToken, "Solicitar recuperación devuelve un token (modo simulación, sin SMTP configurado)");
    const tokenReset = data.resetToken;

    r = await fetch(`${BASE}/api/auth/forgot-password`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "no-existe-este-correo@x.com" }),
    });
    assert(r.status === 200, "Pedir recuperación de un correo que no existe también responde 200 (no revela qué correos existen)");

    r = await fetch(`${BASE}/api/auth/reset-password`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "token-inventado-que-no-existe", password: "nuevaClave123" }),
    });
    assert(r.status === 400, "Rechaza un token de recuperación inválido");

    r = await fetch(`${BASE}/api/auth/reset-password`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: tokenReset, password: "nuevaClave123" }),
    });
    data = await r.json();
    assert(r.status === 200 && data.token, "Cambia la contraseña con el token válido y devuelve una nueva sesión");

    r = await fetch(`${BASE}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "laura@correo.com", password: "123456" }),
    });
    assert(r.status === 401, "La contraseña vieja de Laura ya no funciona");

    r = await fetch(`${BASE}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "laura@correo.com", password: "nuevaClave123" }),
    });
    assert(r.status === 200, "La contraseña nueva de Laura sí funciona");

    r = await fetch(`${BASE}/api/auth/reset-password`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: tokenReset, password: "otraClave456" }),
    });
    assert(r.status === 400, "El mismo token no se puede volver a usar una segunda vez (de un solo uso)");

    // ---------- 27) Imágenes de producto ----------
    console.log("\n27) Imágenes de producto (JPG/PNG)");
    const jpgValido = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=";

    r = await fetch(`${BASE}/api/productos`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ nombre: "Producto con foto", precio: 12000, stock: 5, imagen1: jpgValido }),
    });
    data = await r.json();
    assert(r.status === 201 && data.producto.imagen1 === jpgValido, "Crea un producto con imagen JPG válida y la guarda tal cual");
    const productoConFotoId = data.producto.id;

    r = await fetch(`${BASE}/api/productos`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ nombre: "Producto con archivo inválido", precio: 5000, imagen1: "no-es-una-imagen-real" }),
    });
    assert(r.status === 400, "Rechaza una imagen que no viene en formato JPG/PNG base64 válido");

    r = await fetch(`${BASE}/api/productos`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ nombre: "Producto con foto pesada", precio: 5000, imagen1: "data:image/png;base64," + "A".repeat(2_500_000) }),
    });
    assert(r.status === 400, "Rechaza una imagen demasiado pesada (más de ~1.5MB)");

    r = await fetch(`${BASE}/api/productos/${productoConFotoId}`, {
      method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ imagen2: jpgValido }),
    });
    data = await r.json();
    assert(r.status === 200 && data.producto.imagen1 === jpgValido && data.producto.imagen2 === jpgValido, "Editar el producto para agregar la segunda imagen conserva la primera");

    r = await fetch(`${BASE}/api/productos/publico/${comercioMartaId}`);
    data = await r.json();
    const conFotoEnMenuPublico = data.productos.find((p) => p.id === productoConFotoId);
    assert(conFotoEnMenuPublico && conFotoEnMenuPublico.imagen1 === jpgValido, "El menú público que ve el cliente también trae las fotos del producto");

    // ---------- 28) Logo del comercio ----------
    console.log("\n28) Logo del comercio");
    r = await fetch(`${BASE}/api/comercios/logo`, {
      method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ logo: jpgValido }),
    });
    data = await r.json();
    assert(r.status === 200 && data.logo === jpgValido, "Marta sube el logo de su negocio");

    r = await fetch(`${BASE}/api/comercios/publico`);
    data = await r.json();
    const martaEnDirectorio = data.comercios.find((c) => c.nombre === "Panadería Doña Marta");
    assert(martaEnDirectorio.logo === jpgValido, "El logo aparece en el directorio público de comercios, junto al nombre");

    r = await fetch(`${BASE}/api/comercios/logo`, {
      method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenJulian}` },
      body: JSON.stringify({ logo: "esto-no-es-una-imagen" }),
    });
    assert(r.status === 400, "Rechaza un logo que no es una imagen JPG/PNG válida");

    r = await fetch(`${BASE}/api/comercios/publico`);
    data = await r.json();
    const julianEnDirectorio = data.comercios.find((c) => c.nombre === "Ferretería El Tornillo");
    assert(!julianEnDirectorio.logo, "El negocio de Julián sigue sin logo (sin foto de perfil todavía, y no truena por eso)");

    // =====================================================================
    // PAGOS (USD en centavos + tasa BCV + comprobantes manuales)
    // =====================================================================
    const call = async (method, path, token, body) => {
      const resp = await fetch(`${BASE}${path}`, {
        method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      let json = null; try { json = await resp.json(); } catch {}
      return { status: resp.status, data: json };
    };
    const stockDe = async (id) => (await call("GET", "/api/productos", tokenMarta)).data.productos.find((p) => p.id === id).stock;
    const nuevoPedido = async (token, productoId, cantidad) =>
      (await call("POST", "/api/pedidos", token, { comercioId: comercioMartaId, items: [{ productoId, cantidad }] })).data.pedido;

    // ---------- 29) El menú público no filtra datos sensibles ----------
    console.log("\n29) Menú público: lista blanca (sin datos de cobro ni canales)");
    let rr = await call("GET", `/api/productos/publico/${comercioMartaId}`);
    assert(rr.status === 200 && rr.data.comercio.nombre === "Panadería Doña Marta", "El menú público sigue mostrando el comercio");
    assert(!("metodosPago" in rr.data.comercio) && !("whatsappPhoneNumberId" in rr.data.comercio) && !("instagramPageId" in rr.data.comercio), "El menú público NO expone datos de cobro ni IDs de canales");
    assert("tasaBs" in rr.data.comercio, "El menú público sí incluye la tasa BCV (dato público)");
    rr = await call("GET", `/api/comercios/${comercioMartaId}/tasa`);
    assert(rr.status === 200 && rr.data.tasaBs === null, "Endpoint de tasa: sin tasa cargada devuelve null");
    rr = await call("GET", "/api/comercios/no-existe/tasa");
    assert(rr.status === 404, "Endpoint de tasa: comercio inexistente devuelve 404");

    // ---------- 30) Configuración de cobros del comerciante ----------
    console.log("\n30) Configuración de cobros y tasa BCV");
    const cfgValida = {
      tasaBs: 36.5432,
      metodos: {
        pago_movil: { activo: true, banco: "Banesco", telefono: "0414-1234567", documento: "V-12345678" },
        zelle: { activo: true, contacto: "marta@panaderia.com", titular: "Marta Ruiz" },
        binance: { activo: true, payId: "123456789", nombre: "Marta" },
      },
    };
    rr = await call("PUT", "/api/pagos/config", tokenLaura, cfgValida);
    assert(rr.status === 403, "Un cliente no puede configurar cobros");
    rr = await call("PUT", "/api/pagos/config", null, cfgValida);
    assert(rr.status === 401, "Sin sesión no se puede configurar cobros");
    rr = await call("PUT", "/api/pagos/config", tokenMarta, { metodos: { pago_movil: cfgValida.metodos.pago_movil } });
    assert(rr.status === 400, "No deja activar Pago Móvil si no hay tasa BCV definida");
    rr = await call("PUT", "/api/pagos/config", tokenMarta, { tasaBs: -5 });
    assert(rr.status === 400, "Rechaza una tasa negativa");
    rr = await call("PUT", "/api/pagos/config", tokenMarta, { tasaBs: 36.5, metodos: { pago_movil: { ...cfgValida.metodos.pago_movil, telefono: "abc" } } });
    assert(rr.status === 400, "Rechaza un teléfono de Pago Móvil inválido");
    rr = await call("PUT", "/api/pagos/config", tokenMarta, { metodos: { zelle: { activo: true, contacto: "no-es-correo", titular: "X Y" } } });
    assert(rr.status === 400, "Rechaza un Zelle sin correo/teléfono válido");
    rr = await call("PUT", "/api/pagos/config", tokenMarta, cfgValida);
    assert(rr.status === 200 && rr.data.tasaBs === 36.5432 && rr.data.tasaBsActualizada, "Guarda tasa (con hora de actualización) y los 3 métodos");
    rr = await call("GET", "/api/pagos/config", tokenMarta);
    assert(rr.data.metodos.pago_movil.activo && rr.data.metodos.zelle.activo && rr.data.metodos.binance.activo, "La configuración se lee de vuelta completa");
    rr = await call("GET", `/api/comercios/${comercioMartaId}/tasa`);
    assert(rr.data.tasaBs === 36.5432, "La tasa BCV queda visible públicamente para el carrito del cliente");
    rr = await call("GET", `/api/productos/publico/${comercioMartaId}`);
    assert(rr.data.comercio.tasaBs === 36.5432 && !("metodosPago" in rr.data.comercio), "El menú público muestra la tasa pero sigue sin exponer los datos de cobro");

    // ---------- 31) Instrucciones de pago con las dos monedas ----------
    console.log("\n31) Instrucciones de pago: total en USD y en Bs");
    r = await fetch(`${BASE}/api/productos`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ nombre: "Producto pagos", precio: 1250, stock: 50 }),
    });
    const prodPagosId = (await r.json()).producto.id;
    const P1 = await nuevoPedido(tokenLaura, prodPagosId, 2);          // Laura: $25,00
    assert(P1.total === 2500 && P1.estadoPago === "pendiente", "El pedido nace con total en centavos (2500 = $25,00) y pago pendiente");
    rr = await call("GET", `/api/pagos/pedido/${P1.id}/instrucciones`, tokenLaura);
    assert(rr.status === 200 && rr.data.metodos.length === 3, "Laura ve los 3 métodos activos");
    assert(rr.data.totalUsd === 2500 && rr.data.totalBs === 91358 && rr.data.tasaBs === 36.5432, "Ve el total en USD y en Bs a la tasa BCV (2500 × 36,5432 = 91358 céntimos de Bs)");
    assert(rr.data.metodos.find((m) => m.tipo === "pago_movil").montoBs === 91358, "Pago Móvil trae el monto exacto en Bs");
    assert(!JSON.stringify(rr.data).includes("comprobante"), "Las instrucciones no incluyen imágenes de comprobantes");
    rr = await call("GET", `/api/pagos/pedido/${P1.id}/instrucciones`, tokenAndres);
    assert(rr.status === 403, "Otro cliente no puede ver las instrucciones de un pedido ajeno");
    rr = await call("GET", `/api/pagos/pedido/${P1.id}/instrucciones`, tokenMarta);
    assert(rr.status === 403, "El comerciante no usa las instrucciones del cliente (403)");
    rr = await call("GET", `/api/pagos/pedido/${P1.id}/instrucciones`, null);
    assert(rr.status === 401, "Sin sesión no se ven instrucciones");

    // ---------- 32) Declarar pago ----------
    console.log("\n32) Declarar pago: validaciones y anti-duplicados");
    const htmlFalso = "data:image/jpeg;base64," + Buffer.from("<script>alert(1)</script>").toString("base64");
    rr = await call("POST", `/api/pagos/pedido/${P1.id}/declarar`, tokenLaura, { metodo: "zelle", referencia: "ab" });
    assert(rr.status === 400, "Rechaza una referencia demasiado corta");
    rr = await call("POST", `/api/pagos/pedido/${P1.id}/declarar`, tokenLaura, { metodo: "zelle", referencia: "ABC12" });
    assert(rr.status === 400, "Zelle exige referencia de al menos 6 caracteres");
    rr = await call("POST", `/api/pagos/pedido/${P1.id}/declarar`, tokenLaura, { metodo: "paypal", referencia: "ABCDEF123" });
    assert(rr.status === 400, "Rechaza un método que no existe");
    rr = await call("POST", `/api/pagos/pedido/${P1.id}/declarar`, tokenLaura, { metodo: "zelle", referencia: "ZELLE-ABC-12345", comprobante: htmlFalso });
    assert(rr.status === 400, "Rechaza un 'comprobante' que dice ser JPG pero es HTML/script");
    rr = await call("POST", `/api/pagos/pedido/${P1.id}/declarar`, tokenLaura, { metodo: "pago_movil", referencia: "998877", tasaBsVista: 30 });
    assert(rr.status === 409, "Si la tasa cambió respecto a la que vio el cliente, avisa (409) en vez de registrar un monto errado");
    rr = await call("POST", `/api/pagos/pedido/${P1.id}/declarar`, tokenAndres, { metodo: "zelle", referencia: "ZELLE-ABC-12345" });
    assert(rr.status === 403, "Otro cliente no puede declarar pago por un pedido ajeno");
    rr = await call("POST", `/api/pagos/pedido/${P1.id}/declarar`, tokenMarta, { metodo: "zelle", referencia: "ZELLE-ABC-12345" });
    assert(rr.status === 403, "El comerciante no puede declarar pagos como si fuera cliente");
    rr = await call("POST", `/api/pagos/pedido/${P1.id}/declarar`, tokenLaura, { metodo: "zelle", referencia: "ZELLE-ABC-12345", comprobante: jpgValido });
    assert(rr.status === 201 && rr.data.pago.estado === "por_verificar" && rr.data.pago.montoUsd === 2500, "Laura declara su pago Zelle con comprobante: queda por verificar");
    assert(!("comprobante" in rr.data.pago) && !("claveUnica" in rr.data.pago), "La respuesta no devuelve el comprobante ni la clave interna");
    const pagoP1Id = rr.data.pago.id;
    rr = await call("GET", "/api/pedidos", tokenLaura);
    assert(rr.data.pedidos.find((p) => p.id === P1.id).estadoPago === "por_verificar", "El pedido de Laura muestra estadoPago 'por_verificar'");
    rr = await call("POST", `/api/pagos/pedido/${P1.id}/declarar`, tokenLaura, { metodo: "zelle", referencia: "OTRAREF-1234" });
    assert(rr.status === 409, "No permite declarar otro pago mientras hay uno en revisión");

    const P2 = await nuevoPedido(tokenAndres, prodPagosId, 1);          // Andrés: $12,50 -> 45679 céntimos Bs
    rr = await call("POST", `/api/pagos/pedido/${P2.id}/declarar`, tokenAndres, { metodo: "pago_movil", referencia: "654321", tasaBsVista: 36.5432 });
    assert(rr.status === 201 && rr.data.pago.montoBs === 45679 && rr.data.pago.tasaBs === 36.5432, "Pago Móvil de Andrés guarda monto Bs y tasa usados (1250 × 36,5432 = 45679)");
    const pagoP2Id = rr.data.pago.id;
    const P3 = await nuevoPedido(tokenLaura, prodPagosId, 1);           // Laura: mismo monto que P2
    rr = await call("POST", `/api/pagos/pedido/${P3.id}/declarar`, tokenLaura, { metodo: "pago_movil", referencia: "654321" });
    assert(rr.status === 409, "No se puede reutilizar la misma referencia de Pago Móvil con el mismo monto (aunque sea otro cliente)");
    rr = await call("POST", `/api/pagos/pedido/${P3.id}/declarar`, tokenLaura, { metodo: "zelle", referencia: "zelle-abc-12345" });
    assert(rr.status === 409, "La misma referencia de Zelle (aunque cambien mayúsculas/espacios) tampoco se puede reutilizar");
    const P4 = await nuevoPedido(tokenLaura, prodPagosId, 3);           // Laura: $37,50
    rr = await call("POST", `/api/pagos/pedido/${P4.id}/declarar`, tokenLaura, { metodo: "pago_movil", referencia: "654321" });
    assert(rr.status === 201, "La misma referencia corta con OTRO monto sí se acepta (los bancos repiten referencias cortas)");
    const pagoP4Id = rr.data.pago.id;

    // ---------- 33) El comerciante verifica ----------
    console.log("\n33) Verificación del comerciante: aprobar y rechazar");
    rr = await call("GET", "/api/pagos?estado=por_verificar", tokenMarta);
    assert(rr.status === 200 && rr.data.pagos.length === 3, "Marta ve sus 3 pagos por verificar");
    const verP1 = rr.data.pagos.find((p) => p.id === pagoP1Id);
    assert(verP1.cliente.nombre === "Laura Gómez" && verP1.comprobante === jpgValido && !("claveUnica" in verP1), "Cada pago trae el cliente y su comprobante (sin la clave interna)");
    rr = await call("GET", "/api/pagos?estado=por_verificar", tokenJulian);
    assert(rr.data.pagos.length === 0, "Julián (otro comercio) no ve pagos de Marta");
    rr = await call("GET", "/api/pagos", tokenLaura);
    assert(rr.status === 403, "Un cliente no puede listar pagos del comercio");
    rr = await call("POST", `/api/pagos/${pagoP1Id}/aprobar`, tokenJulian);
    assert(rr.status === 403, "Julián no puede aprobar un pago de otro comercio");
    rr = await call("POST", `/api/pagos/${pagoP1Id}/aprobar`, tokenLaura);
    assert(rr.status === 403, "Un cliente no puede aprobar su propio pago");
    rr = await call("POST", `/api/pagos/${pagoP1Id}/aprobar`, tokenMarta);
    assert(rr.status === 200 && rr.data.pago.estado === "aprobado" && rr.data.pago.verificadoPor && rr.data.pago.verificadoEn, "Marta aprueba: queda registrado quién y cuándo verificó");
    rr = await call("GET", "/api/pedidos", tokenLaura);
    assert(rr.data.pedidos.find((p) => p.id === P1.id).estadoPago === "pagado", "El pedido de Laura pasa a 'pagado'");
    rr = await call("POST", `/api/pagos/${pagoP1Id}/aprobar`, tokenMarta);
    assert(rr.status === 409, "No se puede aprobar dos veces el mismo pago");
    rr = await call("POST", `/api/pagos/${pagoP2Id}/rechazar`, tokenMarta, { motivo: "" });
    assert(rr.status === 400, "Rechazar exige un motivo");
    rr = await call("POST", `/api/pagos/${pagoP2Id}/rechazar`, tokenMarta, { motivo: "El monto recibido no coincide" });
    assert(rr.status === 200 && rr.data.pago.estado === "rechazado", "Marta rechaza el pago de Andrés con motivo");
    rr = await call("GET", `/api/pagos/pedido/${P2.id}/instrucciones`, tokenAndres);
    assert(rr.data.estadoPago === "rechazado" && rr.data.pagos[0].motivoRechazo === "El monto recibido no coincide", "Andrés ve que fue rechazado y por qué");
    rr = await call("POST", `/api/pagos/pedido/${P2.id}/declarar`, tokenAndres, { metodo: "pago_movil", referencia: "654321", tasaBsVista: 36.5432 });
    assert(rr.status === 201, "Al rechazarse, la referencia queda libre: Andrés puede corregir y reenviar");

    // Límite de intentos por pedido (máx. 5)
    let intentos = 2;
    for (let i = 3; i <= 5; i++) {
      const pend = (await call("GET", "/api/pagos?estado=por_verificar", tokenMarta)).data.pagos.find((p) => p.pedido.id === P2.id);
      await call("POST", `/api/pagos/${pend.id}/rechazar`, tokenMarta, { motivo: "Referencia no encontrada" });
      const d = await call("POST", `/api/pagos/pedido/${P2.id}/declarar`, tokenAndres, { metodo: "zelle", referencia: `LIMITE-${i}0000` });
      if (d.status === 201) intentos++;
    }
    const pend5 = (await call("GET", "/api/pagos?estado=por_verificar", tokenMarta)).data.pagos.find((p) => p.pedido.id === P2.id);
    await call("POST", `/api/pagos/${pend5.id}/rechazar`, tokenMarta, { motivo: "Referencia no encontrada" });
    rr = await call("POST", `/api/pagos/pedido/${P2.id}/declarar`, tokenAndres, { metodo: "zelle", referencia: "LIMITE-600000" });
    assert(intentos === 5 && rr.status === 400, "Después de 5 intentos el pedido no admite más declaraciones (anti-abuso)");

    // ---------- 34) Cancelaciones: stock, pago en revisión y reembolso ----------
    console.log("\n34) Cancelar pedidos: devuelve stock y resuelve pagos");
    const stockAntes = await stockDe(prodPagosId);
    rr = await call("PATCH", `/api/pedidos/${P4.id}/estado`, tokenMarta, { estado: "cancelado" });
    assert(rr.status === 200, "Marta cancela el pedido de Laura que tenía un pago en revisión");
    assert((await stockDe(prodPagosId)) === stockAntes + 3, "El stock del pedido cancelado (3 unidades) vuelve al inventario");
    rr = await call("GET", "/api/pagos?estado=rechazado", tokenMarta);
    assert(rr.data.pagos.some((p) => p.id === pagoP4Id && p.motivoRechazo === "Pedido cancelado"), "El pago en revisión se anula automáticamente con motivo 'Pedido cancelado'");
    rr = await call("POST", `/api/pagos/pedido/${P4.id}/declarar`, tokenLaura, { metodo: "zelle", referencia: "TARDE-123456" });
    assert(rr.status === 400, "No se puede declarar pago de un pedido cancelado");
    rr = await call("PATCH", `/api/pedidos/${P1.id}/estado`, tokenMarta, { estado: "cancelado" });
    assert(rr.status === 200, "Marta cancela un pedido que ya estaba pagado");
    rr = await call("GET", "/api/pedidos", tokenMarta);
    assert(rr.data.pedidos.find((p) => p.id === P1.id).estadoPago === "reembolso_pendiente", "El pedido pagado y cancelado queda en 'reembolso_pendiente'");
    rr = await call("POST", `/api/pagos/pedido/${P1.id}/reembolsado`, tokenLaura);
    assert(rr.status === 403, "Un cliente no puede marcar su propio reembolso como hecho");
    rr = await call("POST", `/api/pagos/pedido/${P1.id}/reembolsado`, tokenMarta);
    assert(rr.status === 200 && rr.data.pedido.estadoPago === "reembolsado", "Marta marca el reembolso como realizado");
    rr = await call("POST", `/api/pagos/pedido/${P1.id}/reembolsado`, tokenMarta);
    assert(rr.status === 409, "No se puede marcar dos veces el mismo reembolso");

    // ---------- 35) Stock: sin sobreventa ----------
    console.log("\n35) Stock atómico: sin sobreventa ni trampas");
    r = await fetch(`${BASE}/api/productos`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ nombre: "Edición limitada", precio: 500, stock: 3 }),
    });
    const limitadoId = (await r.json()).producto.id;
    rr = await call("POST", "/api/pedidos", tokenLaura, { comercioId: comercioMartaId, items: [{ productoId: limitadoId, cantidad: 2 }, { productoId: limitadoId, cantidad: 2 }] });
    assert(rr.status === 400 && (await stockDe(limitadoId)) === 3, "Repetir el mismo producto en varias líneas no elude el control de stock (y no descuenta nada)");
    rr = await call("POST", "/api/pedidos", tokenLaura, { comercioId: comercioMartaId, items: [{ productoId: limitadoId, cantidad: 1001 }] });
    assert(rr.status === 400, "Rechaza cantidades absurdas (más de 1000)");
    const resultados = await Promise.all(Array.from({ length: 6 }, () => call("POST", "/api/pedidos", tokenLaura, { comercioId: comercioMartaId, items: [{ productoId: limitadoId, cantidad: 1 }] })));
    const ok = resultados.filter((x) => x.status === 201).length;
    assert(ok === 3 && (await stockDe(limitadoId)) === 0, `6 compras simultáneas de 3 unidades: exactamente 3 se concretan y el stock queda en 0 (obtuvo ${ok})`);

    // ---------- 36) Agente de chat: pagos ----------
    console.log("\n36) Agente de WhatsApp: instrucciones y reporte de pago por chat");
    r = await fetch(`${BASE}/api/productos`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenMarta}` },
      body: JSON.stringify({ nombre: "Crema hidratante", precio: 800, stock: 10 }),
    });
    const chat = async (telefono, texto) => {
      const outbox = async () => (await (await fetch(`${BASE}/api/test/outbox`)).json()).whatsapp.filter((m) => m.telefonoDestino === telefono);
      const antes = (await outbox()).length;
      await fetch(`${BASE}/api/webhooks/whatsapp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payloadWhatsapp(telefono, texto, PHONE_ID_MARTA)) });
      const m = await esperarHasta(async () => { const o = await outbox(); return o.length > antes ? o[o.length - 1] : null; });
      return m ? m.texto : null;
    };
    const tel2 = "584121112233";
    await chat(tel2, "hola");
    let txt = await chat(tel2, "hidratante");
    assert(txt && txt.startsWith("Agregado"), "La palabra 'hidratante' ya no se confunde con el saludo 'hi'");
    txt = await chat(tel2, "confirmar");
    assert(txt && txt.includes("Pedido confirmado") && txt.includes("≈ Bs."), "El pedido por chat muestra el total en USD y su equivalente en Bs");
    assert(txt.includes("Pago Móvil") && txt.includes("Zelle") && txt.includes("Binance") && txt.includes("PAGUE"), "El mensaje incluye los métodos de pago y cómo reportar el pago");
    txt = await chat(tel2, "pague zelle CHAT-REF-9999");
    assert(txt && txt.includes("Recibimos tu pago"), "El cliente reporta su pago por chat y el agente lo registra");
    rr = await call("GET", "/api/pagos?estado=por_verificar", tokenMarta);
    const pagoChat = rr.data.pagos.find((p) => p.referencia === "CHAT-REF-9999");
    assert(pagoChat && pagoChat.canal === "whatsapp" && pagoChat.metodo === "zelle", "El pago aparece al comerciante como por verificar, con canal whatsapp");
    txt = await chat(tel2, "pague zelle CHAT-REF-9999");
    assert(txt && txt.includes("No pude registrar tu pago"), "Repetir el reporte no duplica el pago (queda en revisión)");
    txt = await chat("584129990000", "pague zelle SINPEDIDO-123");
    assert(txt && txt.includes("No encuentro un pedido"), "Sin pedido previo, el agente lo explica en vez de fallar");

    // ---------- 37) Imágenes: verificación de bytes reales ----------
    console.log("\n37) Imágenes: se valida el contenido real, no solo lo que dice ser");
    const pngValido = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    rr = await call("PUT", "/api/comercios/logo", tokenMarta, { logo: pngValido });
    assert(rr.status === 200, "Un PNG real se acepta como logo");
    rr = await call("PUT", "/api/comercios/logo", tokenMarta, { logo: jpgValido.replace("image/jpeg", "image/png") });
    assert(rr.status === 400, "Un JPG declarado como PNG se rechaza");
    rr = await call("POST", "/api/productos", tokenMarta, { nombre: "Con imagen falsa", precio: 100, imagen1: htmlFalso });
    assert(rr.status === 400, "Un producto con 'imagen' que en realidad es HTML se rechaza");
    rr = await call("POST", "/api/productos", tokenMarta, { nombre: "Con imagen rara", precio: 100, imagen1: "data:image/jpeg;base64,/9j/4AAQ\"onerror=\"alert(1)" });
    assert(rr.status === 400, "Una imagen con comillas/atributos inyectados se rechaza");

    // ---------- 38) CSV a prueba de fórmulas ----------
    console.log("\n38) Exportación CSV: protección contra inyección de fórmulas");
    rr = await call("POST", "/api/auth/register", null, { role: "CLIENTE", nombre: "=HYPERLINK(\"http://malo.com\",\"clic\")", email: "formula@x.com", password: "123456" });
    await call("POST", "/api/clientes", tokenMarta, { email: "formula@x.com" });
    r = await fetch(`${BASE}/api/clientes/export/csv`, { headers: { Authorization: `Bearer ${tokenMarta}` } });
    const csv2 = await r.text();
    assert(csv2.includes("\"'=HYPERLINK") && !csv2.includes(",\"=HYPERLINK"), "Un nombre que empieza con '=' se neutraliza en el CSV");
    assert(csv2.includes("Total comprado (USD)") && csv2.includes("+573112223344"), "El CSV declara la moneda (USD) y conserva los teléfonos con +");

    // ---------- 39) Cambiar la tasa BCV se aplica a los montos ----------
    console.log("\n39) La tasa BCV nueva se aplica al monto a pagar");
    const P5 = await nuevoPedido(tokenAndres, prodPagosId, 1);
    rr = await call("PUT", "/api/pagos/config", tokenMarta, { tasaBs: 40.1234 });
    assert(rr.status === 200 && rr.data.tasaBs === 40.1234, "Marta actualiza la tasa BCV del día");
    rr = await call("GET", `/api/pagos/pedido/${P5.id}/instrucciones`, tokenAndres);
    assert(rr.data.totalBs === 50154 && rr.data.metodos.find((m) => m.tipo === "pago_movil").montoBs === 50154, "El monto en Bs se recalcula con la tasa nueva (1250 × 40,1234 = 50154)");
    rr = await call("POST", `/api/pagos/pedido/${P5.id}/declarar`, tokenAndres, { metodo: "pago_movil", referencia: "778899", tasaBsVista: 36.5432 });
    assert(rr.status === 409, "Si el cliente había visto la tasa anterior, debe reabrir las instrucciones antes de pagar");
    rr = await call("GET", `/api/comercios/${comercioMartaId}/tasa`);
    assert(rr.data.tasaBs === 40.1234, "El carrito de cualquier cliente ve la tasa nueva");
    rr = await call("PUT", "/api/pagos/config", tokenMarta, { tasaBs: null });
    assert(rr.status === 400, "No se puede borrar la tasa mientras Pago Móvil está activo");

    // ---------- resumen ----------
    console.log(`\n${"=".repeat(50)}`);
    console.log(`RESULTADO: ${pass} pruebas correctas, ${fail} fallidas.`);
    if (fail > 0) process.exitCode = 1;
  } finally {
    server.kill();
  }
}

async function tokenClienteLaura(base, laura) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: laura.email, password: "123456" }),
  });
  const data = await r.json();
  return data.token;
}

main();
