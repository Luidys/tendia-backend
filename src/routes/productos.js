const express = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

const { imagenZod } = require("../lib/imagenes");

// Las imágenes llegan como "data URI" en base64; se validan formato, tamaño y bytes reales.
const imagenSchema = imagenZod("La imagen").nullable().optional();

// PRECIOS EN CENTAVOS DE USD (ej: $3,50 = 350).
const productoSchema = z.object({
  nombre: z.string().min(2, "El nombre del producto es muy corto"),
  categoria: z.string().optional(),
  precio: z.number().int().positive("El precio debe ser mayor a cero").max(100_000_000, "El precio es demasiado alto"),
  precioAntes: z.number().int().positive().max(100_000_000).optional(),
  promo: z.string().optional(),
  stock: z.number().int().min(0).max(1_000_000).optional(),
  imagen1: imagenSchema,
  imagen2: imagenSchema,
});

/**
 * POST /api/productos
 * Crea un producto o servicio en el catálogo del comerciante autenticado.
 */
router.post("/", requireAuth, requireRole("COMERCIANTE"), async (req, res) => {
  try {
    const datos = productoSchema.parse(req.body);
    if (datos.precioAntes && datos.precioAntes <= datos.precio) {
      return res.status(400).json({ error: "El precio antes debe ser mayor al precio actual." });
    }
    const producto = await prisma.producto.create({
      data: { ...datos, comercioId: req.user.comercioId },
    });
    res.status(201).json({ producto });
  } catch (err) {
    if (err.name === "ZodError") return res.status(400).json({ error: err.errors[0].message });
    console.error(err);
    res.status(500).json({ error: "No pudimos crear el producto." });
  }
});

/**
 * GET /api/productos
 * Lista el catálogo del comerciante autenticado (para su panel de administración).
 */
router.get("/", requireAuth, requireRole("COMERCIANTE"), async (req, res) => {
  const productos = await prisma.producto.findMany({
    where: { comercioId: req.user.comercioId },
    orderBy: { createdAt: "desc" },
  });
  res.json({ productos });
});

/**
 * GET /api/comercios/:comercioId/productos
 * Menú público: lo que ve un cliente al entrar a la vitrina de un comercio.
 * No requiere sesión, para que cualquiera pueda explorar antes de pedir.
 */
router.get("/publico/:comercioId", async (req, res) => {
  const comercio = await prisma.comercio.findUnique({ where: { id: req.params.comercioId } });
  if (!comercio) return res.status(404).json({ error: "Comercio no encontrado." });
  const productos = await prisma.producto.findMany({
    where: { comercioId: req.params.comercioId },
    orderBy: { createdAt: "desc" },
  });
  // Lista blanca: nunca se exponen datos de cobro, canales ni contacto.
  res.json({
    comercio: {
      id: comercio.id, nombre: comercio.nombre, categoria: comercio.categoria, logo: comercio.logo,
      tasaBs: comercio.tasaBs ?? null, tasaBsActualizada: comercio.tasaBsActualizada ?? null,
    },
    productos,
  });
});

/**
 * PUT /api/productos/:id
 * Actualiza un producto. Solo el comerciante dueño del negocio puede editarlo.
 */
router.put("/:id", requireAuth, requireRole("COMERCIANTE"), async (req, res) => {
  try {
    const existente = await prisma.producto.findUnique({ where: { id: req.params.id } });
    if (!existente) return res.status(404).json({ error: "Producto no encontrado." });
    if (existente.comercioId !== req.user.comercioId) {
      return res.status(403).json({ error: "Ese producto no pertenece a tu negocio." });
    }
    const datos = productoSchema.partial().parse(req.body);
    const producto = await prisma.producto.update({ where: { id: req.params.id }, data: datos });
    res.json({ producto });
  } catch (err) {
    if (err.name === "ZodError") return res.status(400).json({ error: err.errors[0].message });
    console.error(err);
    res.status(500).json({ error: "No pudimos actualizar el producto." });
  }
});

/**
 * DELETE /api/productos/:id
 * Elimina un producto. Solo el comerciante dueño del negocio puede borrarlo.
 */
router.delete("/:id", requireAuth, requireRole("COMERCIANTE"), async (req, res) => {
  const existente = await prisma.producto.findUnique({ where: { id: req.params.id } });
  if (!existente) return res.status(404).json({ error: "Producto no encontrado." });
  if (existente.comercioId !== req.user.comercioId) {
    return res.status(403).json({ error: "Ese producto no pertenece a tu negocio." });
  }
  await prisma.producto.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

module.exports = router;
