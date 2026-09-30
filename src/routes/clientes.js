const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { requireAuth, requireRole } = require("../middleware/auth");
const { usdCsv } = require("../lib/dinero");

const router = express.Router();

/**
 * GET /api/clientes
 * Mini CRM: lista los clientes vinculados al comercio del comerciante
 * autenticado, con su total comprado y fecha de última compra.
 */
router.get("/", requireAuth, requireRole("COMERCIANTE"), async (req, res) => {
  const vinculos = await prisma.clienteComercio.findMany({
    where: { comercioId: req.user.comercioId },
    orderBy: { totalComprado: "desc" },
  });

  const clientes = [];
  for (const v of vinculos) {
    const usuario = await prisma.usuario.findUnique({ where: { id: v.clienteId } });
    const pedidos = await prisma.pedido.findMany({
      where: { comercioId: req.user.comercioId, clienteId: v.clienteId },
      orderBy: { createdAt: "desc" },
    });
    clientes.push({
      id: v.clienteId,
      nombre: usuario?.nombre || "Cliente",
      email: usuario?.email || "",
      telefono: usuario?.telefono || "",
      totalComprado: v.totalComprado,
      ultimaCompra: pedidos[0]?.createdAt || null,
      cantidadCompras: pedidos.length,
    });
  }
  res.json({ clientes });
});

/**
 * POST /api/clientes
 * Vincula un cliente ya registrado (por correo) a mi comercio,
 * para empezar a construir su historial dentro de mi CRM.
 */
router.post("/", requireAuth, requireRole("COMERCIANTE"), async (req, res) => {
  try {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const cliente = await prisma.usuario.findUnique({ where: { email } });
    if (!cliente || cliente.role !== "CLIENTE") {
      return res.status(404).json({ error: "No existe un cliente registrado con ese correo." });
    }
    const yaVinculado = await prisma.clienteComercio.findUnique({
      where: { clienteId_comercioId: { clienteId: cliente.id, comercioId: req.user.comercioId } },
    });
    if (yaVinculado) return res.status(409).json({ error: "Ese cliente ya está en tu CRM." });

    const vinculo = await prisma.clienteComercio.create({
      data: { clienteId: cliente.id, comercioId: req.user.comercioId },
    });
    res.status(201).json({ vinculo, cliente: { id: cliente.id, nombre: cliente.nombre, email: cliente.email } });
  } catch (err) {
    if (err.name === "ZodError") return res.status(400).json({ error: "Correo inválido." });
    console.error(err);
    res.status(500).json({ error: "No pudimos vincular al cliente." });
  }
});

/**
 * GET /api/clientes/:clienteId/historial
 * Historial detallado de compras de un cliente específico en mi comercio.
 */
router.get("/:clienteId/historial", requireAuth, requireRole("COMERCIANTE"), async (req, res) => {
  const pedidos = await prisma.pedido.findMany({
    where: { comercioId: req.user.comercioId, clienteId: req.params.clienteId },
    orderBy: { createdAt: "desc" },
  });
  res.json({ pedidos });
});

/**
 * POST /api/clientes/:clienteId/compras
 * Registra manualmente una compra (útil para cargar historial previo,
 * ventas de mostrador, o mientras se activa el flujo automático de pedidos).
 */
router.post("/:clienteId/compras", requireAuth, requireRole("COMERCIANTE"), async (req, res) => {
  try {
    const { items, total } = z
      .object({ items: z.string().min(1).max(200), total: z.number().int().positive().max(100_000_000) })
      .parse(req.body);

    const clienteReal = await prisma.usuario.findUnique({ where: { id: req.params.clienteId } });
    if (!clienteReal || clienteReal.role !== "CLIENTE") {
      return res.status(404).json({ error: "Cliente no encontrado." });
    }

    const pedido = await prisma.pedido.create({
      data: {
        comercioId: req.user.comercioId,
        clienteId: req.params.clienteId,
        items: JSON.stringify([{ nombre: items, cantidad: 1, precioUnitario: total, subtotal: total }]),
        total,
        estado: "entregado",
        estadoPago: "pagado",
        canal: "manual",
      },
    });

    let vinculo = await prisma.clienteComercio.findUnique({
      where: { clienteId_comercioId: { clienteId: req.params.clienteId, comercioId: req.user.comercioId } },
    });
    if (!vinculo) {
      vinculo = await prisma.clienteComercio.create({
        data: { clienteId: req.params.clienteId, comercioId: req.user.comercioId, totalComprado: 0 },
      });
    }
    await prisma.clienteComercio.update({
      where: { clienteId_comercioId: { clienteId: req.params.clienteId, comercioId: req.user.comercioId } },
      data: { totalComprado: vinculo.totalComprado + total },
    });

    res.status(201).json({ pedido });
  } catch (err) {
    if (err.name === "ZodError") return res.status(400).json({ error: err.errors[0].message });
    console.error(err);
    res.status(500).json({ error: "No pudimos registrar la compra." });
  }
});

/**
 * GET /api/clientes/export
 * Exporta la base de clientes del comercio en CSV real, generado en el servidor.
 */
router.get("/export/csv", requireAuth, requireRole("COMERCIANTE"), async (req, res) => {
  const vinculos = await prisma.clienteComercio.findMany({ where: { comercioId: req.user.comercioId } });
  const filas = [["Nombre", "Correo", "Teléfono", "Total comprado (USD)", "Última compra"]];

  for (const v of vinculos) {
    const usuario = await prisma.usuario.findUnique({ where: { id: v.clienteId } });
    const pedidos = await prisma.pedido.findMany({
      where: { comercioId: req.user.comercioId, clienteId: v.clienteId },
      orderBy: { createdAt: "desc" },
    });
    filas.push([
      usuario?.nombre || "",
      usuario?.email || "",
      usuario?.telefono || "",
      usdCsv(v.totalComprado),
      pedidos[0]?.createdAt || "",
    ]);
  }

  // Celdas que empiezan con = + - @ podrían ejecutarse como fórmula al abrir el CSV en Excel.
  const celda = (c) => {
    let t = String(c ?? "");
    if (/^[=+\-@\t\r]/.test(t) && !/^\+[0-9\s\-]{6,}$/.test(t)) t = "'" + t; // los teléfonos +58... son legítimos
    return `"${t.replace(/"/g, '""')}"`;
  };
  const csv = filas.map((f) => f.map(celda).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=clientes_tendia.csv");
  res.send(csv);
});

module.exports = router;
