const express = require("express");
const crypto = require("crypto");
const prisma = require("../lib/prisma");
const { procesarMensaje } = require("../lib/agente");
const { enviarMensajeWhatsApp } = require("../lib/canales/whatsapp");
const { enviarMensajeInstagram } = require("../lib/canales/instagram");

const router = express.Router();

/**
 * Verifica que el POST realmente venga de Meta: Meta firma el cuerpo con el
 * "App Secret" de tu app (cabecera X-Hub-Signature-256). Sin esto, cualquiera
 * que conozca la URL podría inventar mensajes (crear pedidos, declarar pagos).
 * - Con META_APP_SECRET definido: firma inválida o ausente => 401.
 * - Sin secreto en producción: se rechaza (503). Sin secreto en pruebas/desarrollo: se acepta.
 */
function verificarFirmaMeta(req, res) {
  const secreto = process.env.META_APP_SECRET;
  if (!secreto) {
    if (process.env.NODE_ENV === "production") {
      res.status(503).json({ error: "Webhook sin configurar (falta META_APP_SECRET)." });
      return false;
    }
    return true;
  }
  const recibida = Buffer.from(req.get("x-hub-signature-256") || "");
  const esperada = Buffer.from("sha256=" + crypto.createHmac("sha256", secreto).update(req.rawBody || Buffer.alloc(0)).digest("hex"));
  if (recibida.length !== esperada.length || !crypto.timingSafeEqual(recibida, esperada)) {
    res.status(401).json({ error: "Firma inválida." });
    return false;
  }
  return true;
}

/**
 * GET /api/webhooks/whatsapp
 * GET /api/webhooks/instagram
 * Meta llama esta ruta UNA vez al conectar el webhook, para verificar que
 * el servidor es dueño de la URL. Hay que devolver `hub.challenge` tal
 * cual si el `hub.verify_token` coincide con el que configuraste en Meta.
 */
function verificarWebhook(req, res) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.status(403).json({ error: "Token de verificación inválido." });
}

router.get("/whatsapp", verificarWebhook);
router.get("/instagram", verificarWebhook);

/**
 * POST /api/webhooks/whatsapp
 * Meta manda aquí cada mensaje entrante de WhatsApp. Siempre respondemos
 * 200 rápido (aunque algo interno falle) porque si Meta no recibe 200
 * reintenta y puede desactivar el webhook.
 */
router.post("/whatsapp", async (req, res) => {
  if (!verificarFirmaMeta(req, res)) return;
  res.status(200).json({ ok: true }); // ack inmediato a Meta

  try {
    const cambios = req.body?.entry?.[0]?.changes?.[0]?.value;
    const mensaje = cambios?.messages?.[0];
    if (!mensaje || mensaje.type !== "text") return; // ignoramos estados/otros tipos por ahora

    const phoneNumberId = cambios.metadata?.phone_number_id;
    const telefono = mensaje.from;
    const texto = mensaje.text?.body || "";

    const comercio = await prisma.comercio.findUnique({ where: { whatsappPhoneNumberId: phoneNumberId } });
    if (!comercio) {
      console.warn(`Mensaje de WhatsApp recibido para un phone_number_id sin comercio asociado: ${phoneNumberId}`);
      return;
    }

    const { respuesta } = await procesarMensaje({ comercioId: comercio.id, telefono, texto, canal: "whatsapp" });
    await enviarMensajeWhatsApp({ phoneNumberId, telefonoDestino: telefono, texto: respuesta });
  } catch (err) {
    console.error("Error procesando webhook de WhatsApp:", err);
  }
});

/**
 * POST /api/webhooks/instagram
 * Igual que WhatsApp, pero con el formato de Instagram Messaging.
 */
router.post("/instagram", async (req, res) => {
  if (!verificarFirmaMeta(req, res)) return;
  res.status(200).json({ ok: true });

  try {
    const entry = req.body?.entry?.[0];
    const evento = entry?.messaging?.[0];
    if (!evento?.message?.text) return; // ignoramos "seen", reacciones, etc.

    const pageId = entry.id;
    const psid = evento.sender?.id;
    const texto = evento.message.text;

    const comercio = await prisma.comercio.findUnique({ where: { instagramPageId: pageId } });
    if (!comercio) {
      console.warn(`Mensaje de Instagram recibido para una página sin comercio asociado: ${pageId}`);
      return;
    }

    const { respuesta } = await procesarMensaje({ comercioId: comercio.id, telefono: psid, texto, canal: "instagram" });
    await enviarMensajeInstagram({ pageId, psidDestino: psid, texto: respuesta });
  } catch (err) {
    console.error("Error procesando webhook de Instagram:", err);
  }
});

module.exports = router;
