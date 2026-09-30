const express = require("express");
const { z } = require("zod");
const { requireAuth, requireRole } = require("../middleware/auth");
const { limitePagos } = require("../middleware/limites");
const servicio = require("../lib/pagosService");

const router = express.Router();

/** Traduce errores de negocio/validación a respuestas HTTP claras. */
function manejar(res, err, mensajeGenerico) {
  if (err instanceof servicio.PagoError) return res.status(err.status).json({ error: err.message });
  if (err && err.name === "ZodError") return res.status(400).json({ error: err.errors[0].message });
  console.error(err);
  return res.status(500).json({ error: mensajeGenerico });
}

/* ------------------------- Comerciante: configuración de cobros ------------------------- */

router.get("/config", requireAuth, requireRole("COMERCIANTE"), async (req, res) => {
  try { res.json(await servicio.obtenerConfig(req.user.comercioId)); }
  catch (err) { manejar(res, err, "No pudimos leer la configuración de cobros."); }
});

router.put("/config", requireAuth, requireRole("COMERCIANTE"), async (req, res) => {
  try { res.json(await servicio.guardarConfig(req.user.comercioId, req.body)); }
  catch (err) { manejar(res, err, "No pudimos guardar la configuración de cobros."); }
});

/* ------------------------- Comerciante: verificar pagos ------------------------- */

router.get("/", requireAuth, requireRole("COMERCIANTE"), async (req, res) => {
  try {
    const estado = ["por_verificar", "aprobado", "rechazado"].includes(req.query.estado) ? req.query.estado : undefined;
    res.json({ pagos: await servicio.listarPagos({ comercioId: req.user.comercioId, estado }) });
  } catch (err) { manejar(res, err, "No pudimos listar los pagos."); }
});

router.post("/:id/aprobar", requireAuth, requireRole("COMERCIANTE"), limitePagos, async (req, res) => {
  try {
    const pago = await servicio.aprobarPago({ pagoId: req.params.id, comercioId: req.user.comercioId, usuarioId: req.user.id });
    res.json({ pago });
  } catch (err) { manejar(res, err, "No pudimos aprobar el pago."); }
});

router.post("/:id/rechazar", requireAuth, requireRole("COMERCIANTE"), limitePagos, async (req, res) => {
  try {
    const { motivo } = z.object({ motivo: z.string() }).parse(req.body);
    const pago = await servicio.rechazarPago({ pagoId: req.params.id, comercioId: req.user.comercioId, usuarioId: req.user.id, motivo });
    res.json({ pago });
  } catch (err) { manejar(res, err, "No pudimos rechazar el pago."); }
});

router.post("/pedido/:pedidoId/reembolsado", requireAuth, requireRole("COMERCIANTE"), limitePagos, async (req, res) => {
  try {
    const pedido = await servicio.marcarReembolsado({ pedidoId: req.params.pedidoId, comercioId: req.user.comercioId });
    res.json({ pedido });
  } catch (err) { manejar(res, err, "No pudimos marcar el reembolso."); }
});

/* ------------------------- Cliente: pagar un pedido ------------------------- */

router.get("/pedido/:pedidoId/instrucciones", requireAuth, requireRole("CLIENTE"), async (req, res) => {
  try { res.json(await servicio.obtenerInstrucciones(req.params.pedidoId, req.user.id)); }
  catch (err) { manejar(res, err, "No pudimos cargar las instrucciones de pago."); }
});

router.post("/pedido/:pedidoId/declarar", requireAuth, requireRole("CLIENTE"), limitePagos, async (req, res) => {
  try {
    const datos = z.object({
      metodo: z.string(),
      referencia: z.string(),
      comprobante: z.string().nullable().optional(),
      tasaBsVista: z.number().nullable().optional(),
    }).parse(req.body);
    const pago = await servicio.declararPago({
      pedidoId: req.params.pedidoId, clienteId: req.user.id, canal: "web", ...datos,
    });
    res.status(201).json({ pago });
  } catch (err) { manejar(res, err, "No pudimos registrar tu pago."); }
});

module.exports = router;
