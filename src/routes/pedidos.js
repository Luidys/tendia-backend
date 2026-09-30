const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { requireAuth, requireRole } = require("../middleware/auth");
const { crearPedido, restaurarStock, PedidoError } = require("../lib/pedidosService");
const { liberarPagosPorCancelacion } = require("../lib/pagosService");

const router = express.Router();

const ESTADOS = ["nuevo", "proceso", "listo", "entregado", "cancelado"];
const AVANCE = { nuevo: 0, proceso: 1, listo: 2, entregado: 3 };
const TERMINALES = new Set(["entregado", "cancelado"]);

const crearPedidoSchema = z.object({
  comercioId: z.string().min(1),
  items: z
    .array(z.object({ productoId: z.string().min(1), cantidad: z.number().int().positive().max(1000) }))
    .max(50, "Un pedido admite máximo 50 líneas")
    .min(1, "El pedido debe tener al menos un producto"),
  canal: z.enum(["web", "whatsapp", "instagram", "marketplace"]).optional(),
});

/**
 * POST /api/pedidos
 * El cliente confirma su carrito. El precio y el total se calculan
 * SIEMPRE en el servidor a partir del catálogo real (nunca se confía
 * en lo que mande el navegador), y se descuenta el stock disponible.
 * Los items se guardan como JSON (string) en pedido.items.
 */
router.post("/", requireAuth, requireRole("CLIENTE"), async (req, res) => {
  try {
    const datos = crearPedidoSchema.parse(req.body);
    const pedido = await crearPedido({
      comercioId: datos.comercioId, clienteId: req.user.id,
      items: datos.items, canal: datos.canal || "web",
    });
    res.status(201).json({ pedido });
  } catch (err) {
    if (err.name === "ZodError") return res.status(400).json({ error: err.errors[0].message });
    if (err instanceof PedidoError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "No pudimos crear el pedido." });
  }
});

/**
 * GET /api/pedidos
 * Comerciante: ve los pedidos de su negocio (filtrable por ?estado=).
 * Cliente: ve sus propios pedidos, en cualquier comercio.
 */
router.get("/", requireAuth, async (req, res) => {
  const where = req.user.role === "COMERCIANTE"
    ? { comercioId: req.user.comercioId }
    : { clienteId: req.user.id };
  if (req.query.estado) where.estado = req.query.estado;

  const pedidos = await prisma.pedido.findMany({ where, orderBy: { createdAt: "desc" } });
  res.json({ pedidos });
});

/**
 * GET /api/pedidos/:id
 * Detalle de un pedido. Solo puede verlo el comerciante dueño del negocio
 * o el cliente que lo hizo.
 */
router.get("/:id", requireAuth, async (req, res) => {
  const pedido = await prisma.pedido.findUnique({ where: { id: req.params.id } });
  if (!pedido) return res.status(404).json({ error: "Pedido no encontrado." });

  const esDueno = req.user.role === "COMERCIANTE" && pedido.comercioId === req.user.comercioId;
  const esCliente = req.user.role === "CLIENTE" && pedido.clienteId === req.user.id;
  if (!esDueno && !esCliente) return res.status(403).json({ error: "No tienes acceso a este pedido." });

  res.json({ pedido });
});

/**
 * PATCH /api/pedidos/:id/estado
 * Solo el comerciante dueño del negocio puede mover el pedido por su flujo:
 * nuevo → proceso → listo → entregado, un paso a la vez (no se puede saltar
 * ni retroceder). También puede cancelarlo mientras no esté "entregado".
 * Una vez "entregado" o "cancelado", el pedido queda cerrado (no se puede
 * volver a mover). Al llegar a "entregado", se refleja automáticamente en
 * el CRM: se suma al total comprado del cliente y, si no estaba vinculado
 * todavía a este comercio, queda vinculado.
 */
router.patch("/:id/estado", requireAuth, requireRole("COMERCIANTE"), async (req, res) => {
  try {
    const { estado } = z.object({ estado: z.enum(ESTADOS) }).parse(req.body);

    const pedido = await prisma.pedido.findUnique({ where: { id: req.params.id } });
    if (!pedido) return res.status(404).json({ error: "Pedido no encontrado." });
    if (pedido.comercioId !== req.user.comercioId) {
      return res.status(403).json({ error: "Ese pedido no pertenece a tu negocio." });
    }
    if (TERMINALES.has(pedido.estado)) {
      return res.status(400).json({ error: `El pedido ya está "${pedido.estado}" y no se puede modificar.` });
    }
    if (estado !== "cancelado" && AVANCE[estado] !== AVANCE[pedido.estado] + 1) {
      return res.status(400).json({ error: `No puedes pasar de "${pedido.estado}" a "${estado}" directamente.` });
    }

    // Todo el cambio de estado (y sus efectos) ocurre en una sola transacción.
    const actualizado = await prisma.$transaction(async (tx) => {
      const pedidoActualizado = await tx.pedido.update({ where: { id: req.params.id }, data: { estado } });

      if (estado === "cancelado") {
        // Devuelve el stock y resuelve los pagos asociados (anula el que está en
        // revisión; si ya estaba pagado, queda "reembolso pendiente").
        await restaurarStock(tx, pedido);
        await liberarPagosPorCancelacion(tx, pedido);
      }

      if (estado === "entregado") {
        let vinculo = await tx.clienteComercio.findUnique({
          where: { clienteId_comercioId: { clienteId: pedido.clienteId, comercioId: pedido.comercioId } },
        });
        if (!vinculo) {
          vinculo = await tx.clienteComercio.create({
            data: { clienteId: pedido.clienteId, comercioId: pedido.comercioId, totalComprado: 0 },
          });
        }
        await tx.clienteComercio.update({
          where: { clienteId_comercioId: { clienteId: pedido.clienteId, comercioId: pedido.comercioId } },
          data: { totalComprado: vinculo.totalComprado + pedido.total },
        });
      }
      return pedidoActualizado;
    });

    res.json({ pedido: actualizado });
  } catch (err) {
    if (err.name === "ZodError") return res.status(400).json({ error: "Estado inválido." });
    console.error(err);
    res.status(500).json({ error: "No pudimos actualizar el estado del pedido." });
  }
});

module.exports = router;
