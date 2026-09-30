require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { limiteGeneral } = require("./middleware/limites");
const authRoutes = require("./routes/auth");
const productosRoutes = require("./routes/productos");
const clientesRoutes = require("./routes/clientes");
const pedidosRoutes = require("./routes/pedidos");
const comerciosRoutes = require("./routes/comercios");
const pagosRoutes = require("./routes/pagos");
const webhooksRoutes = require("./routes/webhooks");

const esProduccion = process.env.NODE_ENV === "production";

// ---- Comprobaciones de arranque: en producción NO se arranca mal configurado ----
if (esProduccion) {
  const secreto = process.env.JWT_SECRET || "";
  if (secreto.length < 32 || /cambia-esto|secreto|password|12345/i.test(secreto)) {
    console.error("JWT_SECRET falta o es débil. Genera uno de 32+ caracteres: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
    process.exit(1);
  }
  if (process.env.USE_TEST_DB === "1") {
    console.error("USE_TEST_DB=1 no está permitido en producción.");
    process.exit(1);
  }
  if (!process.env.CORS_ORIGINS) console.warn("Aviso: CORS_ORIGINS no está definido; la API acepta llamadas desde cualquier sitio web.");
}

const app = express();

// Detrás de Railway/Render/etc. la IP real del usuario viene en cabeceras del proxy
// (necesario para que los límites de intentos por IP funcionen bien).
app.set("trust proxy", Number(process.env.TRUST_PROXY ?? (esProduccion ? 1 : 0)));

app.use(helmet());

// CORS: en producción define CORS_ORIGINS con la(s) URL(s) de tu app, separadas por coma.
const origenes = (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors(origenes.length
  ? { origin: (origin, cb) => cb(null, !origin || origenes.includes(origin)) }
  : {}));

// Límite de 8mb: las imágenes viajan como base64 dentro del JSON.
// Se conserva el cuerpo original (rawBody) para verificar la firma de los webhooks de Meta.
app.use(express.json({ limit: "8mb", verify: (req, res, buf) => { req.rawBody = buf; } }));

app.get("/api/health", (req, res) => res.json({ ok: true, servicio: "tendia-backend" }));

for (const prefijo of ["auth", "productos", "clientes", "pedidos", "comercios", "pagos"]) {
  app.use(`/api/${prefijo}`, limiteGeneral);
}
app.use("/api/auth", authRoutes);
app.use("/api/productos", productosRoutes);
app.use("/api/clientes", clientesRoutes);
app.use("/api/pedidos", pedidosRoutes);
app.use("/api/comercios", comerciosRoutes);
app.use("/api/pagos", pagosRoutes);
app.use("/api/webhooks", webhooksRoutes);

// Solo existe cuando se corre con USE_TEST_DB=1 (nuestras pruebas automáticas).
// Deja ver qué mensajes "envió" el agente en modo simulación, ya que en las
// pruebas no hay credenciales reales de Meta para verificar el envío real.
if (process.env.USE_TEST_DB === "1") {
  const { outboxSimulado: outboxWhatsapp } = require("./lib/canales/whatsapp");
  const { outboxSimulado: outboxInstagram } = require("./lib/canales/instagram");
  app.get("/api/test/outbox", (req, res) => {
    res.json({ whatsapp: outboxWhatsapp, instagram: outboxInstagram });
  });
}

// Manejador de errores: respuestas claras sin filtrar detalles internos.
app.use((err, req, res, next) => {
  if (err && err.type === "entity.too.large") return res.status(413).json({ error: "El archivo o los datos enviados son demasiado grandes." });
  if (err instanceof SyntaxError && err.status === 400) return res.status(400).json({ error: "El cuerpo de la solicitud no es un JSON válido." });
  console.error(err);
  res.status(500).json({ error: "Error inesperado del servidor." });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Tendia backend escuchando en http://localhost:${PORT}`));
