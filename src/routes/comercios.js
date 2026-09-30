const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

const { imagenZod } = require("../lib/imagenes");
const logoSchema = imagenZod("El logo").nullable();

/**
 * GET /api/comercios/publico
 * Directorio público de comercios (sin datos sensibles), para que un
 * cliente pueda explorar qué negocios están disponibles antes de entrar
 * al menú de uno en particular.
 */
router.get("/publico", async (req, res) => {
  const comercios = await prisma.comercio.findMany({ orderBy: { createdAt: "desc" } });
  res.json({
    comercios: comercios.map((c) => ({ id: c.id, nombre: c.nombre, categoria: c.categoria, logo: c.logo })),
  });
});

/**
 * GET /api/comercios/:id/tasa
 * Tasa BCV (Bs por USD) que el comerciante tiene cargada. Es un dato público
 * y muy liviano: el carrito del cliente lo consulta para mostrar el monto en Bs.
 */
router.get("/:id/tasa", async (req, res) => {
  const comercio = await prisma.comercio.findUnique({ where: { id: req.params.id } });
  if (!comercio) return res.status(404).json({ error: "Comercio no encontrado." });
  res.json({ tasaBs: comercio.tasaBs ?? null, tasaBsActualizada: comercio.tasaBsActualizada ?? null });
});

/**
 * PUT /api/comercios/logo
 * Sube (o quita, mandando null) el logo del comercio autenticado.
 */
router.put("/logo", requireAuth, requireRole("COMERCIANTE"), async (req, res) => {
  try {
    const { logo } = z.object({ logo: logoSchema }).parse(req.body);
    const comercio = await prisma.comercio.update({ where: { id: req.user.comercioId }, data: { logo } });
    res.json({ logo: comercio.logo });
  } catch (err) {
    if (err.name === "ZodError") return res.status(400).json({ error: err.errors[0].message });
    console.error(err);
    res.status(500).json({ error: "No pudimos guardar el logo." });
  }
});

/**
 * GET /api/comercios/canales
 * Devuelve el estado de conexión de los canales del comercio autenticado.
 */
router.get("/canales", requireAuth, requireRole("COMERCIANTE"), async (req, res) => {
  const comercio = await prisma.comercio.findUnique({ where: { id: req.user.comercioId } });
  res.json({
    whatsapp: { conectado: !!comercio.whatsappPhoneNumberId, phoneNumberId: comercio.whatsappPhoneNumberId },
    instagram: { conectado: !!comercio.instagramPageId, pageId: comercio.instagramPageId },
  });
});

/**
 * PUT /api/comercios/canales
 * Guarda los identificadores que Meta usa para enrutar los mensajes
 * entrantes de WhatsApp/Instagram hacia este comercio. En producción,
 * estos valores se obtienen al conectar la cuenta de Meta Business del
 * comerciante (flujo OAuth), no se escriben a mano.
 */
router.put("/canales", requireAuth, requireRole("COMERCIANTE"), async (req, res) => {
  try {
    const datos = z.object({
      whatsappPhoneNumberId: z.string().min(1).nullable().optional(),
      instagramPageId: z.string().min(1).nullable().optional(),
    }).parse(req.body);

    const comercio = await prisma.comercio.update({ where: { id: req.user.comercioId }, data: datos });
    res.json({
      whatsapp: { conectado: !!comercio.whatsappPhoneNumberId, phoneNumberId: comercio.whatsappPhoneNumberId },
      instagram: { conectado: !!comercio.instagramPageId, pageId: comercio.instagramPageId },
    });
  } catch (err) {
    if (err.name === "ZodError") return res.status(400).json({ error: err.errors[0].message });
    console.error(err);
    res.status(500).json({ error: "No pudimos guardar la configuración de canales." });
  }
});

module.exports = router;
