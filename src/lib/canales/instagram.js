// Adaptador de envío de Instagram DM (Meta Graph API para Instagram
// Messaging). Mismo patrón que WhatsApp: sin token real, modo simulación.

const outboxSimulado = [];

async function enviarMensajeInstagram({ pageId, psidDestino, texto }) {
  if (!process.env.INSTAGRAM_ACCESS_TOKEN) {
    outboxSimulado.push({ canal: "instagram", pageId, psidDestino, texto, ts: Date.now() });
    console.log(`[simulación Instagram → ${psidDestino}] ${texto}`);
    return { simulado: true };
  }

  const resp = await fetch(`https://graph.facebook.com/v19.0/${pageId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.INSTAGRAM_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      recipient: { id: psidDestino },
      message: { text: texto },
    }),
  });
  return resp.json();
}

module.exports = { enviarMensajeInstagram, outboxSimulado };
