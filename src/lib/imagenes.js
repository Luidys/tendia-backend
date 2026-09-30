// Validación de imágenes recibidas como "data URI" en base64.
// Además del formato declarado y el tamaño, se verifican los BYTES REALES
// del archivo (firma JPEG/PNG): un archivo que dice ser JPG pero contiene
// otra cosa (HTML, script, etc.) se rechaza.
const { z } = require("zod");

const MAX_BASE64 = 2_000_000; // caracteres (~1.5MB de imagen real)
const PATRON = /^data:image\/(jpeg|jpg|png);base64,([A-Za-z0-9+/]+={0,2})$/;

function validarImagenDataUri(valor, nombre = "La imagen") {
  if (typeof valor !== "string") return { ok: false, error: `${nombre} no es válida.` };
  if (valor.length > MAX_BASE64) return { ok: false, error: `${nombre} es muy pesada (máximo ~1.5MB). Usa una más liviana.` };
  const m = PATRON.exec(valor);
  if (!m) return { ok: false, error: `${nombre} debe ser un archivo JPG o PNG.` };
  const bytes = Buffer.from(m[2].slice(0, 24), "base64");
  const esJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const esPng = bytes.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const declaraPng = m[1] === "png";
  if ((declaraPng && !esPng) || (!declaraPng && !esJpeg)) {
    return { ok: false, error: `${nombre} no es realmente un archivo ${declaraPng ? "PNG" : "JPG"} válido.` };
  }
  return { ok: true };
}

/** Esquema zod reutilizable (string obligatorio; combínalo con .nullable().optional() si aplica). */
function imagenZod(nombre) {
  return z.string().superRefine((s, ctx) => {
    const r = validarImagenDataUri(s, nombre);
    if (!r.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: r.error });
  });
}

module.exports = { validarImagenDataUri, imagenZod, MAX_BASE64 };
