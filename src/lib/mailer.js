// Envío de correo (recuperación de contraseña, etc.) vía SMTP.
// Igual que con WhatsApp/Instagram: sin credenciales reales configuradas,
// opera en "modo simulación" — no envía nada de verdad, pero deja ver el
// contenido para poder probar el flujo completo sin un servidor de correo.

let nodemailer;
try { nodemailer = require("nodemailer"); } catch { nodemailer = null; }

function transportadorConfigurado() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && nodemailer);
}

const outboxSimulado = [];

async function enviarCorreo({ para, asunto, texto }) {
  if (!transportadorConfigurado()) {
    outboxSimulado.push({ para, asunto, texto, ts: Date.now() });
    console.log(`\n[simulación de correo → ${para}]\nAsunto: ${asunto}\n${texto}\n`);
    return { simulado: true };
  }

  const transportador = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  return transportador.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: para,
    subject: asunto,
    text: texto,
  });
}

module.exports = { enviarCorreo, outboxSimulado, transportadorConfigurado };
