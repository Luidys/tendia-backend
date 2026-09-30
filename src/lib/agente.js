// Motor de conversación del agente de IA. Es el mismo "cerebro" para
// WhatsApp e Instagram: recibe un mensaje de texto y decide qué responder,
// llevando el estado de la conversación (menú mostrado, carrito en curso)
// en la tabla Conversacion.

const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const prisma = require("./prisma");
const { crearPedido, PedidoError } = require("./pedidosService");
const { formatoUsd, formatoDual } = require("./dinero");
const { declararPago, textoInstrucciones, PagoError } = require("./pagosService");

const PALABRAS_SALUDO = ["hola", "buenas", "menu", "menú", "hi", "hello"];
const PALABRAS_CONFIRMAR = ["confirmar", "listo", "finalizar", "eso es todo", "ya"];
const PALABRAS_CANCELAR = ["cancelar", "cancela"];

const formatoMoneda = formatoUsd; // montos en centavos de USD

/** Busca palabras completas (no trozos de otras palabras): "hi" no coincide con "hidratante". */
function tienePalabra(msg, lista) {
  return lista.some((k) => {
    const seguro = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\p{L}\\p{N}])${seguro}(?![\\p{L}\\p{N}])`, "iu").test(msg);
  });
}

/** "PAGUE zelle ABC123": el cliente reporta su pago por chat (sin captura; solo referencia). */
async function manejarPagoPorChat({ comercioId, cliente, canal, metodoTexto, referencia }) {
  const metodo = /zelle/i.test(metodoTexto) ? "zelle" : /binance/i.test(metodoTexto) ? "binance" : "pago_movil";
  const pedidos = await prisma.pedido.findMany({ where: { comercioId, clienteId: cliente.id }, orderBy: { createdAt: "desc" } });
  const objetivo = pedidos.find((p) => p.estado !== "cancelado");
  if (!objetivo) return { respuesta: 'No encuentro un pedido tuyo pendiente de pago. Escribe "menu" para hacer uno.' };
  try {
    await declararPago({ pedidoId: objetivo.id, clienteId: cliente.id, metodo, referencia, canal });
    return { respuesta: `✅ Recibimos tu pago (${metodo.replace("_", " ")}, ref. ${referencia.toUpperCase().replace(/\s+/g, "")}). Queda por verificar: el comercio lo revisa y te avisa cuando lo confirme.` };
  } catch (err) {
    if (err instanceof PagoError) return { respuesta: `No pude registrar tu pago: ${err.message}` };
    throw err;
  }
}

/** Encuentra o crea un usuario CLIENTE a partir de un teléfono/PSID de chat.
 *  Como estos clientes llegan sin correo/clave, se les genera un correo
 *  sintético estable para que, si vuelven a escribir, se reconozcan como
 *  el mismo cliente (y no se dupliquen en el CRM). */
async function obtenerOCrearClientePorTelefono(telefono, canal) {
  const idLimpio = String(telefono).replace(/[^a-zA-Z0-9]/g, "");
  const emailSintetico = `${canal}-${idLimpio}@chat.tendia.local`;
  let usuario = await prisma.usuario.findUnique({ where: { email: emailSintetico } });
  if (!usuario) {
    const passwordHash = await bcrypt.hash(crypto.randomUUID(), 10);
    usuario = await prisma.usuario.create({
      data: {
        email: emailSintetico,
        nombre: `Cliente ${canal} ${telefono}`,
        telefono: canal === "whatsapp" ? telefono : null,
        passwordHash,
        role: "CLIENTE",
      },
    });
  }
  return usuario;
}

async function obtenerConversacion(comercioId, telefono, canal) {
  const where = { comercioId_telefono_canal: { comercioId, telefono, canal } };
  let conv = await prisma.conversacion.findUnique({ where });
  if (!conv) {
    conv = await prisma.conversacion.create({
      data: { comercioId, telefono, canal, estado: "inicio", carritoJson: "[]", ultimoMenuJson: "[]" },
    });
  }
  return conv;
}

async function guardarConversacion(comercioId, telefono, canal, data) {
  const where = { comercioId_telefono_canal: { comercioId, telefono, canal } };
  return prisma.conversacion.update({ where, data });
}

function escaparRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Busca el producto cuyo nombre contiene el término como PALABRA completa
 *  (no como substring cualquiera). Así "empanada" encuentra "Empanada de
 *  pollo" pero no confunde con "Caja de 6 empanadas" (donde "empanada" es
 *  parte de otra palabra, "empanadas"). Si nada matchea por palabra
 *  completa, se hace un último intento por substring simple. */
function buscarProductoPorNombre(termino, listaProductos) {
  if (!termino) return null;
  const exacto = listaProductos.find((p) => p.nombre.toLowerCase() === termino);
  if (exacto) return exacto;

  const regexPalabra = new RegExp(`\\b${escaparRegex(termino)}\\b`, "i");
  const porPalabra = listaProductos.filter((p) => regexPalabra.test(p.nombre));
  if (porPalabra.length === 1) return porPalabra[0];
  if (porPalabra.length > 1) {
    // Varias coincidencias por palabra completa: se prefiere el nombre más
    // corto (más específico a lo que el cliente escribió).
    return porPalabra.sort((a, b) => a.nombre.length - b.nombre.length)[0];
  }

  const porSubstring = listaProductos.filter((p) => p.nombre.toLowerCase().includes(termino));
  if (porSubstring.length > 0) return porSubstring.sort((a, b) => a.nombre.length - b.nombre.length)[0];

  return null;
}

/** Interpreta un mensaje como selección de producto del menú.
 *  Soporta: "2" (índice del menú), "2 cafe" (cantidad + nombre), "cafe" (nombre solo). */
function interpretarSeleccion(mensaje, listaProductos) {
  const msg = mensaje.trim().toLowerCase();
  if (!msg) return null;

  // Solo un número -> índice del último menú mostrado
  if (/^\d+$/.test(msg)) {
    const idx = parseInt(msg, 10) - 1;
    return listaProductos[idx] ? { producto: listaProductos[idx], cantidad: 1 } : null;
  }

  // "<cantidad> <nombre>"
  const conCantidad = msg.match(/^(\d+)\s*[xX]?\s*(.+)$/);
  if (conCantidad) {
    const cantidad = parseInt(conCantidad[1], 10);
    const resto = conCantidad[2].trim();
    const producto = buscarProductoPorNombre(resto, listaProductos);
    if (producto) return { producto, cantidad };
  }

  // Solo el nombre (o parte de él)
  const producto = buscarProductoPorNombre(msg, listaProductos);
  if (producto) return { producto, cantidad: 1 };

  return null;
}

/**
 * Procesa un mensaje entrante y devuelve la respuesta del agente.
 * @returns {Promise<{respuesta: string, pedido?: object}>}
 */
async function procesarMensaje({ comercioId, telefono, texto, canal }) {
  const cliente = await obtenerOCrearClientePorTelefono(telefono, canal);
  const conv = await obtenerConversacion(comercioId, telefono, canal);
  const msg = (texto || "").trim().toLowerCase();

  const carrito = JSON.parse(conv.carritoJson || "[]");
  const ultimoMenu = JSON.parse(conv.ultimoMenuJson || "[]");
  const productos = await prisma.producto.findMany({ where: { comercioId } });
  const comercio = await prisma.comercio.findUnique({ where: { id: comercioId } });

  // --- Reportar pago: va primero para que ninguna otra palabra lo intercepte ---
  const mPago = /^\s*pagu[eé]\s+(pago\s*m[oó]vil|pagomovil|pm|zelle|binance)\s+(.+?)\s*$/iu.exec(texto || "");
  if (mPago) return manejarPagoPorChat({ comercioId, cliente, canal, metodoTexto: mPago[1], referencia: mPago[2] });

  // --- Saludo / pedir el menú ---
  if (tienePalabra(msg, PALABRAS_SALUDO)) {
    if (productos.length === 0) {
      return { respuesta: "¡Hola! Por ahora no tenemos productos cargados en el menú. Vuelve pronto 🙂" };
    }
    const menu = productos.map((p) => ({ productoId: p.id, nombre: p.nombre, precio: p.precio }));
    const lista = menu.map((p, i) => `${i + 1}. ${p.nombre} - ${formatoMoneda(p.precio)}`).join("\n");
    await guardarConversacion(comercioId, telefono, canal, { estado: "viendo_menu", ultimoMenuJson: JSON.stringify(menu) });
    return {
      respuesta: `¡Hola! 👋 Este es nuestro menú:\n\n${lista}\n\nEscribe el número o el nombre de lo que quieras (ej: "2 ${menu[0].nombre.split(" ")[0]}"), y cuando termines escribe "confirmar".`,
    };
  }

  // --- Confirmar pedido ---
  if (tienePalabra(msg, PALABRAS_CONFIRMAR)) {
    if (carrito.length === 0) {
      return { respuesta: 'Todavía no has agregado nada. Escribe "menu" para ver las opciones.' };
    }
    try {
      const items = carrito.map((c) => ({ productoId: c.productoId, cantidad: c.cantidad }));
      const pedido = await crearPedido({ comercioId, clienteId: cliente.id, items, canal });
      await guardarConversacion(comercioId, telefono, canal, { estado: "inicio", carritoJson: "[]", ultimoMenuJson: "[]" });
      const instrucciones = textoInstrucciones(pedido, comercio);
      return { respuesta: `¡Pedido confirmado! 🎉 Total: ${formatoDual(pedido.total, comercio?.tasaBs)}.${instrucciones || " El comercio coordinará contigo el pago."}`, pedido };
    } catch (err) {
      if (err instanceof PedidoError) return { respuesta: `No pude completar tu pedido: ${err.message}` };
      throw err;
    }
  }

  // --- Cancelar carrito en curso ---
  if (tienePalabra(msg, PALABRAS_CANCELAR)) {
    await guardarConversacion(comercioId, telefono, canal, { carritoJson: "[]" });
    return { respuesta: 'Listo, vacié tu pedido en curso. Escribe "menu" cuando quieras empezar de nuevo.' };
  }

  // --- Intentar interpretar como selección de producto ---
  const listaParaBuscar = ultimoMenu.length ? ultimoMenu : productos.map((p) => ({ productoId: p.id, nombre: p.nombre, precio: p.precio }));
  const seleccion = interpretarSeleccion(msg, listaParaBuscar);
  if (seleccion) {
    const existente = carrito.find((c) => c.productoId === seleccion.producto.productoId);
    if (existente) existente.cantidad += seleccion.cantidad;
    else carrito.push({ productoId: seleccion.producto.productoId, nombre: seleccion.producto.nombre, cantidad: seleccion.cantidad });

    const totalParcial = carrito.reduce((acc, c) => acc + (productos.find((p) => p.id === c.productoId)?.precio || 0) * c.cantidad, 0);
    await guardarConversacion(comercioId, telefono, canal, { estado: "armando_pedido", carritoJson: JSON.stringify(carrito) });
    return {
      respuesta: `Agregado: ${seleccion.cantidad} x ${seleccion.producto.nombre}. Total parcial: ${formatoDual(totalParcial, comercio?.tasaBs)}. Sigue agregando o escribe "confirmar".`,
    };
  }

  return { respuesta: 'No entendí eso 🤔. Escribe "menu" para ver los productos disponibles.' };
}

module.exports = { procesarMensaje, obtenerOCrearClientePorTelefono };
