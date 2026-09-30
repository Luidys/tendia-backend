// Adaptador de envío de WhatsApp (Meta Cloud API).
// Si no hay credenciales reales configuradas, opera en "modo simulación":
// no llama a Meta, solo registra el mensaje en `outboxSimulado` (usado por
// las pruebas automáticas y útil para probar el agente sin cuenta real).

const outboxSimulado = [];

async function enviarMensajeWhatsApp({ phoneNumberId, telefonoDestino, texto }) {
  if (!process.env.WHATSAPP_ACCESS_TOKEN) {
    outboxSimulado.push({ canal: "whatsapp", phoneNumberId, telefonoDestino, texto, ts: Date.now() });
    console.log(`[simulación WhatsApp → ${telefonoDestino}] ${texto}`);
    return { simulado: true };
  }

  const resp = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: telefonoDestino,
      text: { body: texto },
    }),
  });
  return resp.json();
}

module.exports = { enviarMensajeWhatsApp, outboxSimulado };
