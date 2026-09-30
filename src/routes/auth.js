const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { enviarCorreo, transportadorConfigurado } = require("../lib/mailer");
const { limiteAuth, limiteRecuperar } = require("../middleware/limites");

const router = express.Router();

const registroComercianteSchema = z.object({
  role: z.literal("COMERCIANTE"),
  nombre: z.string().min(2, "El nombre es muy corto"),
  email: z.string().email("Correo inválido"),
  password: z.string().min(6, "La contraseña debe tener al menos 6 caracteres"),
  comercioNombre: z.string().min(2, "El nombre del negocio es muy corto"),
  categoria: z.string().optional(),
});

const registroClienteSchema = z.object({
  role: z.literal("CLIENTE"),
  nombre: z.string().min(2, "El nombre es muy corto"),
  email: z.string().email("Correo inválido"),
  password: z.string().min(6, "La contraseña debe tener al menos 6 caracteres"),
  telefono: z.string().optional(),
  comercioId: z.string().uuid().optional(), // opcional: a qué negocio se vincula primero
});

function firmarToken(usuario) {
  return jwt.sign(
    { id: usuario.id, role: usuario.role, comercioId: usuario.comercioId || null },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "12h" }
  );
}

// Bloqueo temporal por cuenta tras varios intentos fallidos (anti fuerza bruta).
// Vive en memoria: protege una instancia; con varias instancias usa un almacén compartido (ej. Redis).
const FALLIDOS = new Map();
const MAX_FALLIDOS = Number(process.env.LOGIN_MAX_FALLIDOS || 5);
const BLOQUEO_MS = 15 * 60 * 1000;

function estaBloqueado(email) {
  const r = FALLIDOS.get(email);
  if (!r) return false;
  if (Date.now() - r.desde > BLOQUEO_MS) { FALLIDOS.delete(email); return false; }
  return r.cuenta >= MAX_FALLIDOS;
}
function registrarFallo(email) {
  if (FALLIDOS.size > 10000) FALLIDOS.clear();
  const r = FALLIDOS.get(email);
  if (!r || Date.now() - r.desde > BLOQUEO_MS) FALLIDOS.set(email, { cuenta: 1, desde: Date.now() });
  else r.cuenta += 1;
}

function usuarioPublico(usuario) {
  const { passwordHash, resetToken, resetTokenExpira, ...resto } = usuario;
  return resto;
}

/**
 * POST /api/auth/register
 * Crea un usuario nuevo. Si role = COMERCIANTE, también crea su Comercio.
 * Si role = CLIENTE, opcionalmente lo vincula a un comercio existente.
 */
router.post("/register", limiteAuth, async (req, res) => {
  try {
    const esComerciante = req.body?.role === "COMERCIANTE";
    const schema = esComerciante ? registroComercianteSchema : registroClienteSchema;
    const datos = schema.parse(req.body);

    const yaExiste = await prisma.usuario.findUnique({ where: { email: datos.email } });
    if (yaExiste) {
      return res.status(409).json({ error: "Ya existe una cuenta con ese correo." });
    }

    const passwordHash = await bcrypt.hash(datos.password, 10);

    let usuario;
    if (esComerciante) {
      const comercio = await prisma.comercio.create({
        data: { nombre: datos.comercioNombre, categoria: datos.categoria || null },
      });
      usuario = await prisma.usuario.create({
        data: {
          email: datos.email,
          nombre: datos.nombre,
          passwordHash,
          role: "COMERCIANTE",
          comercioId: comercio.id,
        },
      });
    } else {
      usuario = await prisma.usuario.create({
        data: {
          email: datos.email,
          nombre: datos.nombre,
          telefono: datos.telefono || null,
          passwordHash,
          role: "CLIENTE",
        },
      });
      if (datos.comercioId) {
        await prisma.clienteComercio.create({
          data: { clienteId: usuario.id, comercioId: datos.comercioId },
        });
      }
    }

    const token = firmarToken(usuario);
    res.status(201).json({ token, usuario: usuarioPublico(usuario) });
  } catch (err) {
    if (err.name === "ZodError") {
      return res.status(400).json({ error: err.errors[0].message });
    }
    console.error(err);
    res.status(500).json({ error: "No pudimos crear la cuenta. Intenta de nuevo." });
  }
});

/**
 * POST /api/auth/login
 * Valida email + contraseña y devuelve un token de sesión (JWT).
 */
router.post("/login", limiteAuth, async (req, res) => {
  try {
    const { email, password } = z
      .object({ email: z.string().email(), password: z.string().min(1) })
      .parse(req.body);

    const clave = email.toLowerCase();
    if (estaBloqueado(clave)) {
      return res.status(429).json({ error: "Demasiados intentos fallidos. Espera 15 minutos o recupera tu contraseña." });
    }

    const usuario = await prisma.usuario.findUnique({ where: { email } });
    if (!usuario) {
      registrarFallo(clave);
      return res.status(401).json({ error: "Correo o contraseña incorrectos." });
    }

    const claveValida = await bcrypt.compare(password, usuario.passwordHash);
    if (!claveValida) {
      registrarFallo(clave);
      return res.status(401).json({ error: "Correo o contraseña incorrectos." });
    }
    FALLIDOS.delete(clave);

    const token = firmarToken(usuario);
    res.json({ token, usuario: usuarioPublico(usuario) });
  } catch (err) {
    if (err.name === "ZodError") {
      return res.status(400).json({ error: "Correo o contraseña con formato inválido." });
    }
    console.error(err);
    res.status(500).json({ error: "No pudimos iniciar sesión. Intenta de nuevo." });
  }
});

/**
 * GET /api/auth/me
 * Ruta protegida de ejemplo: confirma que el token funciona y
 * devuelve los datos del usuario autenticado (comerciante o cliente).
 */
router.get("/me", requireAuth, async (req, res) => {
  const usuario = await prisma.usuario.findUnique({ where: { id: req.user.id } });
  if (!usuario) return res.status(404).json({ error: "Usuario no encontrado." });
  res.json({ usuario: usuarioPublico(usuario) });
});

/**
 * POST /api/auth/forgot-password
 * Genera un token de recuperación de un solo uso, válido por 1 hora, y
 * "envía" el enlace por correo (modo simulación si no hay SMTP
 * configurado — ver src/lib/mailer.js).
 * Responde igual exista o no el correo, para no revelar qué correos
 * están registrados. En modo simulación (sin SMTP real) SÍ devuelve el
 * token en la respuesta, para poder probar el flujo sin servidor de correo.
 */
router.post("/forgot-password", limiteRecuperar, async (req, res) => {
  try {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const usuario = await prisma.usuario.findUnique({ where: { email } });

    if (usuario) {
      const token = crypto.randomBytes(32).toString("hex");
      const expira = new Date(Date.now() + 60 * 60 * 1000); // 1 hora
      await prisma.usuario.update({ where: { email }, data: { resetToken: token, resetTokenExpira: expira.toISOString() } });

      const enlace = `${process.env.FRONTEND_URL || "tu-app"}?resetToken=${token}`;
      await enviarCorreo({
        para: email,
        asunto: "Recupera tu contraseña de Tendia",
        texto: `Hola ${usuario.nombre},\n\nUsa este enlace para elegir una nueva contraseña (válido por 1 hora):\n${enlace}\n\nSi no fuiste tú, ignora este mensaje.`,
      });

      if (!transportadorConfigurado()) {
        return res.json({ ok: true, modoSimulacion: true, resetToken: token, mensaje: "SMTP no configurado: aquí tienes el token directamente para poder probar." });
      }
    }

    res.json({ ok: true, mensaje: "Si el correo existe, te enviamos un enlace para recuperar tu contraseña." });
  } catch (err) {
    if (err.name === "ZodError") return res.status(400).json({ error: "Correo inválido." });
    console.error(err);
    res.status(500).json({ error: "No pudimos procesar la solicitud." });
  }
});

/**
 * POST /api/auth/reset-password
 * Confirma el cambio de contraseña usando el token recibido por correo.
 */
router.post("/reset-password", limiteAuth, async (req, res) => {
  try {
    const { token, password } = z.object({ token: z.string().min(1), password: z.string().min(6) }).parse(req.body);

    const usuario = await prisma.usuario.findUnique({ where: { resetToken: token } });
    if (!usuario || !usuario.resetTokenExpira || new Date(usuario.resetTokenExpira) < new Date()) {
      return res.status(400).json({ error: "El enlace de recuperación es inválido o ya venció. Solicita uno nuevo." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.usuario.update({ where: { id: usuario.id }, data: { passwordHash, resetToken: null, resetTokenExpira: null } });

    FALLIDOS.delete(String(usuario.email).toLowerCase());
    const nuevoToken = firmarToken(usuario);
    res.json({ ok: true, token: nuevoToken, usuario: usuarioPublico({ ...usuario, passwordHash }) });
  } catch (err) {
    if (err.name === "ZodError") return res.status(400).json({ error: err.errors[0].message });
    console.error(err);
    res.status(500).json({ error: "No pudimos actualizar la contraseña." });
  }
});

module.exports = router;
