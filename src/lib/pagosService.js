// Pagos manuales con comprobante (Pago Móvil, Zelle, Binance Pay/USDT).
//
// Por qué manual: en Venezuela ninguna pasarela automática global atiende a
// comercios locales. El flujo estándar (y el que usamos) es: el cliente paga
// FUERA de la app, reporta referencia (+ captura opcional) y el comerciante
// verifica en su banco/app y aprueba o rechaza.
//
// SEGURIDAD: aquí nunca se recibe ni se guarda un número de tarjeta ni
// credenciales bancarias. Solo la referencia que reporta el cliente y los
// datos públicos donde el comerciante recibe pagos.

const { z } = require("zod");
const prisma = require("./prisma");
const { calcularMontoBs, formatoUsd, formatoBs, redondear4 } = require("./dinero");
const { validarImagenDataUri } = require("./imagenes");

class PagoError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const METODOS = ["pago_movil", "zelle", "binance"];
const NOMBRES = { pago_movil: "Pago Móvil", zelle: "Zelle", binance: "Binance Pay (USDT)" };
const MAX_INTENTOS = 5;

/* ---------------------- configuración de cobros del comercio ---------------------- */

const RE_TEL = /^[0-9+\-\s]{7,20}$/;
const RE_DOC = /^[VEJGPvejgp]?[-\s]?[0-9][0-9.\-]{4,14}$/;
const RE_PAYID = /^[A-Za-z0-9_.@\-]{3,60}$/;

function falta(ctx, mensaje) {
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: mensaje });
}

const esquemaPagoMovil = z.object({
  activo: z.boolean(),
  banco: z.string().trim().max(60).optional(),
  telefono: z.string().trim().max(20).optional(),
  documento: z.string().trim().max(20).optional(),
}).superRefine((v, ctx) => {
  if (!v.activo) return;
  if (!v.banco || v.banco.length < 2) falta(ctx, "Pago Móvil: indica el banco.");
  if (!v.telefono || !RE_TEL.test(v.telefono)) falta(ctx, "Pago Móvil: el teléfono no es válido.");
  if (!v.documento || !RE_DOC.test(v.documento)) falta(ctx, "Pago Móvil: la cédula/RIF no es válida.");
});

const esquemaZelle = z.object({
  activo: z.boolean(),
  contacto: z.string().trim().max(80).optional(),
  titular: z.string().trim().max(80).optional(),
}).superRefine((v, ctx) => {
  if (!v.activo) return;
  const c = v.contacto || "";
  const esCorreo = z.string().email().safeParse(c).success;
  if (!esCorreo && !RE_TEL.test(c)) falta(ctx, "Zelle: indica el correo o teléfono registrado en Zelle.");
  if (!v.titular || v.titular.length < 2) falta(ctx, "Zelle: indica el nombre del titular.");
});

const esquemaBinance = z.object({
  activo: z.boolean(),
  payId: z.string().trim().max(60).optional(),
  nombre: z.string().trim().max(60).optional(),
}).superRefine((v, ctx) => {
  if (!v.activo) return;
  if (!v.payId || !RE_PAYID.test(v.payId)) falta(ctx, "Binance Pay: indica tu Pay ID o usuario.");
});

const esquemaConfig = z.object({
  tasaBs: z.number().positive("La tasa debe ser mayor a cero.").max(10_000_000).nullable().optional(),
  metodos: z.object({
    pago_movil: esquemaPagoMovil.optional(),
    zelle: esquemaZelle.optional(),
    binance: esquemaBinance.optional(),
  }).optional(),
});

function leerMetodos(comercio) {
  try { return JSON.parse(comercio.metodosPago || "{}") || {}; } catch { return {}; }
}

function vistaConfig(comercio) {
  const m = leerMetodos(comercio);
  return {
    tasaBs: comercio.tasaBs ?? null,
    tasaBsActualizada: comercio.tasaBsActualizada ?? null,
    metodos: {
      pago_movil: m.pago_movil || { activo: false },
      zelle: m.zelle || { activo: false },
      binance: m.binance || { activo: false },
    },
  };
}

async function obtenerConfig(comercioId) {
  const comercio = await prisma.comercio.findUnique({ where: { id: comercioId } });
  if (!comercio) throw new PagoError(404, "Comercio no encontrado.");
  return vistaConfig(comercio);
}

async function guardarConfig(comercioId, entrada) {
  const datos = esquemaConfig.parse(entrada);
  const comercio = await prisma.comercio.findUnique({ where: { id: comercioId } });
  if (!comercio) throw new PagoError(404, "Comercio no encontrado.");

  const metodos = { ...leerMetodos(comercio), ...(datos.metodos || {}) };
  let tasa = comercio.tasaBs ?? null;
  let tasaAct = comercio.tasaBsActualizada ?? null;
  if (datos.tasaBs !== undefined) {
    tasa = datos.tasaBs === null ? null : redondear4(datos.tasaBs);
    tasaAct = tasa === null ? null : new Date().toISOString();
  }
  if (metodos.pago_movil?.activo && !tasa) {
    throw new PagoError(400, "Para activar Pago Móvil define primero la tasa del día (Bs por USD).");
  }
  const actualizado = await prisma.comercio.update({
    where: { id: comercioId },
    data: { metodosPago: JSON.stringify(metodos), tasaBs: tasa, tasaBsActualizada: tasaAct },
  });
  return vistaConfig(actualizado);
}

/* ---------------------- instrucciones de pago para el cliente ---------------------- */

/** Métodos activos con el monto exacto que debe pagar el cliente por este pedido. */
function cotizarMetodos(pedido, comercio) {
  const m = leerMetodos(comercio);
  const salida = [];
  if (m.pago_movil?.activo && comercio.tasaBs) {
    salida.push({
      tipo: "pago_movil", nombre: NOMBRES.pago_movil,
      datos: { banco: m.pago_movil.banco, telefono: m.pago_movil.telefono, documento: m.pago_movil.documento },
      montoUsd: pedido.total,
      montoBs: calcularMontoBs(pedido.total, comercio.tasaBs),
      tasaBs: comercio.tasaBs, tasaBsActualizada: comercio.tasaBsActualizada,
    });
  }
  if (m.zelle?.activo) {
    salida.push({ tipo: "zelle", nombre: NOMBRES.zelle, datos: { contacto: m.zelle.contacto, titular: m.zelle.titular }, montoUsd: pedido.total });
  }
  if (m.binance?.activo) {
    salida.push({ tipo: "binance", nombre: NOMBRES.binance, datos: { payId: m.binance.payId, nombre: m.binance.nombre || null }, montoUsd: pedido.total });
  }
  return salida;
}

async function cargarPedidoDelCliente(pedidoId, clienteId) {
  const pedido = await prisma.pedido.findUnique({ where: { id: pedidoId } });
  if (!pedido) throw new PagoError(404, "Pedido no encontrado.");
  if (pedido.clienteId !== clienteId) throw new PagoError(403, "Ese pedido no es tuyo.");
  return pedido;
}

async function obtenerInstrucciones(pedidoId, clienteId) {
  const pedido = await cargarPedidoDelCliente(pedidoId, clienteId);
  const comercio = await prisma.comercio.findUnique({ where: { id: pedido.comercioId } });
  const pagos = (await prisma.pago.findMany({ where: { pedidoId }, orderBy: { createdAt: "desc" } }))
    // No se devuelve el comprobante (imagen pesada) en el historial.
    .map((p) => ({ id: p.id, metodo: p.metodo, referencia: p.referencia, estado: p.estado, motivoRechazo: p.motivoRechazo, createdAt: p.createdAt }));
  return {
    pedidoId, totalUsd: pedido.total, estadoPedido: pedido.estado, estadoPago: pedido.estadoPago,
    // Las dos monedas: el cliente ve el total en USD y en Bs a la tasa BCV vigente.
    tasaBs: comercio.tasaBs ?? null, tasaBsActualizada: comercio.tasaBsActualizada ?? null,
    totalBs: comercio.tasaBs ? calcularMontoBs(pedido.total, comercio.tasaBs) : null,
    comercio: { id: comercio.id, nombre: comercio.nombre },
    metodos: cotizarMetodos(pedido, comercio), pagos,
  };
}

/** Texto para el agente de chat (WhatsApp/Instagram). */
function textoInstrucciones(pedido, comercio) {
  const metodos = cotizarMetodos(pedido, comercio);
  if (metodos.length === 0) return "";
  const lineas = metodos.map((m) => {
    if (m.tipo === "pago_movil") return `• Pago Móvil: ${m.datos.banco} · Tel. ${m.datos.telefono} · C.I./RIF ${m.datos.documento} · Monto: ${formatoBs(m.montoBs)} (tasa ${m.tasaBs})`;
    if (m.tipo === "zelle") return `• Zelle: ${m.datos.contacto} (${m.datos.titular}) · Monto: ${formatoUsd(m.montoUsd)}`;
    return `• Binance Pay: ID ${m.datos.payId} · Monto: ${(m.montoUsd / 100).toFixed(2)} USDT`;
  });
  return `\n\nPara pagar (total ${formatoUsd(pedido.total)}) elige un método:\n${lineas.join("\n")}\n\nCuando pagues, escríbeme: PAGUE <pagomovil|zelle|binance> <referencia>\nEj: PAGUE zelle ABC123456`;
}

/* ---------------------- declarar pago (cliente) ---------------------- */

const RE_REFERENCIA = /^[A-Z0-9][A-Z0-9\-_]{3,39}$/;

function normalizarReferencia(texto) {
  return String(texto || "").toUpperCase().replace(/\s+/g, "");
}

function esViolacionUnica(err) {
  return err && (err.code === "P2002" || /UNIQUE constraint failed/i.test(err.message || ""));
}

async function declararPago({ pedidoId, clienteId, metodo, referencia, comprobante, tasaBsVista, canal }) {
  if (!METODOS.includes(metodo)) throw new PagoError(400, "Método de pago inválido.");

  const ref = normalizarReferencia(referencia);
  if (!RE_REFERENCIA.test(ref)) {
    throw new PagoError(400, "La referencia debe tener entre 4 y 40 caracteres (letras, números o guiones).");
  }
  if (metodo !== "pago_movil" && ref.length < 6) {
    throw new PagoError(400, "La referencia de Zelle/Binance debe tener al menos 6 caracteres.");
  }
  if (comprobante !== undefined && comprobante !== null) {
    const r = validarImagenDataUri(comprobante, "El comprobante");
    if (!r.ok) throw new PagoError(400, r.error);
  }

  const pedido = await cargarPedidoDelCliente(pedidoId, clienteId);
  if (pedido.estado === "cancelado") throw new PagoError(400, "Este pedido fue cancelado.");
  if (pedido.estadoPago === "pagado") throw new PagoError(409, "Este pedido ya está pagado.");
  if (pedido.estadoPago === "reembolso_pendiente" || pedido.estadoPago === "reembolsado") {
    throw new PagoError(400, "Este pedido ya no admite pagos.");
  }

  const previos = await prisma.pago.findMany({ where: { pedidoId } });
  if (previos.some((p) => p.estado === "por_verificar")) {
    throw new PagoError(409, "Ya tienes un pago en revisión para este pedido. Espera la respuesta del comercio.");
  }
  if (previos.length >= MAX_INTENTOS) {
    throw new PagoError(400, "Llegaste al máximo de intentos de pago para este pedido. Contacta al comercio.");
  }

  const comercio = await prisma.comercio.findUnique({ where: { id: pedido.comercioId } });
  const cotizado = cotizarMetodos(pedido, comercio).find((m) => m.tipo === metodo);
  if (!cotizado) throw new PagoError(400, "Ese comercio no tiene activo ese método de pago.");

  let montoBs = null, tasaBs = null;
  if (metodo === "pago_movil") {
    tasaBs = comercio.tasaBs;
    // Si el cliente vio otra tasa, el monto que pagó podría no coincidir: se le avisa.
    if (tasaBsVista !== undefined && tasaBsVista !== null && Math.abs(Number(tasaBsVista) - tasaBs) > 1e-9) {
      throw new PagoError(409, "La tasa del día cambió mientras pagabas. Vuelve a abrir las instrucciones para ver el monto actualizado.");
    }
    montoBs = cotizado.montoBs;
  }

  // Un mismo comprobante no puede usarse dos veces en el mismo comercio.
  // Pago Móvil: las referencias bancarias son cortas y pueden repetirse entre
  // bancos, así que la clave incluye también el monto en Bs.
  const claveUnica = metodo === "pago_movil"
    ? `${pedido.comercioId}|${metodo}|${ref}|${montoBs}`
    : `${pedido.comercioId}|${metodo}|${ref}`;

  try {
    return await prisma.$transaction(async (tx) => {
      const pago = await tx.pago.create({
        data: {
          pedidoId, comercioId: pedido.comercioId, clienteId, metodo,
          montoUsd: pedido.total, montoBs, tasaBs,
          referencia: ref, comprobante: comprobante || null,
          estado: "por_verificar", claveUnica, canal: canal || "web",
        },
      });
      await tx.pedido.update({ where: { id: pedidoId }, data: { estadoPago: "por_verificar" } });
      const { comprobante: _omitido, claveUnica: _clave, ...publico } = pago;
      return publico;
    });
  } catch (err) {
    if (esViolacionUnica(err)) throw new PagoError(409, "Esa referencia ya fue registrada en otro pago. Revisa que sea la de TU transferencia.");
    throw err;
  }
}

/* ---------------------- verificación (comerciante) ---------------------- */

async function listarPagos({ comercioId, estado }) {
  const where = { comercioId };
  if (estado) where.estado = estado;
  const pagos = (await prisma.pago.findMany({ where, orderBy: { createdAt: "desc" } })).slice(0, 100);
  const salida = [];
  for (const p of pagos) {
    const cliente = await prisma.usuario.findUnique({ where: { id: p.clienteId } });
    const pedido = await prisma.pedido.findUnique({ where: { id: p.pedidoId } });
    const { claveUnica: _c, ...resto } = p;
    salida.push({ ...resto, cliente: { id: p.clienteId, nombre: cliente?.nombre || "Cliente" }, pedido: pedido ? { id: pedido.id, items: pedido.items, total: pedido.total, estado: pedido.estado } : null });
  }
  return salida;
}

async function cargarPagoDelComercio(pagoId, comercioId) {
  const pago = await prisma.pago.findUnique({ where: { id: pagoId } });
  if (!pago) throw new PagoError(404, "Pago no encontrado.");
  if (pago.comercioId !== comercioId) throw new PagoError(403, "Ese pago no pertenece a tu negocio.");
  return pago;
}

async function aprobarPago({ pagoId, comercioId, usuarioId }) {
  return prisma.$transaction(async (tx) => {
    const pago = await tx.pago.findUnique({ where: { id: pagoId } });
    if (!pago) throw new PagoError(404, "Pago no encontrado.");
    if (pago.comercioId !== comercioId) throw new PagoError(403, "Ese pago no pertenece a tu negocio.");
    if (pago.estado !== "por_verificar") throw new PagoError(409, `Este pago ya fue ${pago.estado}.`);
    const pedido = await tx.pedido.findUnique({ where: { id: pago.pedidoId } });
    if (!pedido || pedido.estado === "cancelado") throw new PagoError(409, "El pedido de este pago fue cancelado.");

    const actualizado = await tx.pago.update({
      where: { id: pagoId },
      data: { estado: "aprobado", verificadoPor: usuarioId, verificadoEn: new Date().toISOString() },
    });
    await tx.pedido.update({ where: { id: pago.pedidoId }, data: { estadoPago: "pagado" } });
    const { comprobante: _o, claveUnica: _c, ...publico } = actualizado;
    return publico;
  });
}

async function rechazarPago({ pagoId, comercioId, usuarioId, motivo }) {
  const texto = String(motivo || "").trim();
  if (texto.length < 3 || texto.length > 200) throw new PagoError(400, "Indica el motivo del rechazo (entre 3 y 200 caracteres).");
  return prisma.$transaction(async (tx) => {
    const pago = await tx.pago.findUnique({ where: { id: pagoId } });
    if (!pago) throw new PagoError(404, "Pago no encontrado.");
    if (pago.comercioId !== comercioId) throw new PagoError(403, "Ese pago no pertenece a tu negocio.");
    if (pago.estado !== "por_verificar") throw new PagoError(409, `Este pago ya fue ${pago.estado}.`);

    const actualizado = await tx.pago.update({
      where: { id: pagoId },
      // claveUnica: null libera la referencia para poder corregirla y reenviarla.
      data: { estado: "rechazado", motivoRechazo: texto, claveUnica: null, verificadoPor: usuarioId, verificadoEn: new Date().toISOString() },
    });
    await tx.pedido.update({ where: { id: pago.pedidoId }, data: { estadoPago: "rechazado" } });
    const { comprobante: _o, claveUnica: _c, ...publico } = actualizado;
    return publico;
  });
}

/** El comerciante confirma que ya devolvió el dinero de un pedido pagado y luego cancelado. */
async function marcarReembolsado({ pedidoId, comercioId }) {
  const pedido = await prisma.pedido.findUnique({ where: { id: pedidoId } });
  if (!pedido) throw new PagoError(404, "Pedido no encontrado.");
  if (pedido.comercioId !== comercioId) throw new PagoError(403, "Ese pedido no pertenece a tu negocio.");
  if (pedido.estadoPago !== "reembolso_pendiente") throw new PagoError(409, "Este pedido no tiene un reembolso pendiente.");
  return prisma.pedido.update({ where: { id: pedidoId }, data: { estadoPago: "reembolsado" } });
}

/** Se llama DENTRO de la transacción de cancelación de un pedido. */
async function liberarPagosPorCancelacion(tx, pedido) {
  const pagos = await tx.pago.findMany({ where: { pedidoId: pedido.id } });
  for (const p of pagos) {
    if (p.estado === "por_verificar") {
      await tx.pago.update({
        where: { id: p.id },
        data: { estado: "rechazado", motivoRechazo: "Pedido cancelado", claveUnica: null, verificadoEn: new Date().toISOString() },
      });
    }
  }
  let nuevo = pedido.estadoPago;
  if (pedido.estadoPago === "pagado") nuevo = "reembolso_pendiente";
  else if (pedido.estadoPago === "por_verificar") nuevo = "pendiente";
  if (nuevo !== pedido.estadoPago) await tx.pedido.update({ where: { id: pedido.id }, data: { estadoPago: nuevo } });
}

module.exports = {
  PagoError, METODOS, NOMBRES, MAX_INTENTOS,
  esquemaConfig, obtenerConfig, guardarConfig,
  cotizarMetodos, obtenerInstrucciones, textoInstrucciones,
  declararPago, listarPagos, aprobarPago, rechazarPago, marcarReembolsado,
  liberarPagosPorCancelacion, normalizarReferencia,
};
