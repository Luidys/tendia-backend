// Límites de intentos por IP (anti fuerza bruta / abuso). Se pueden ajustar
// por variables de entorno. RATE_LIMIT_DISABLED=1 solo se respeta fuera de
// producción (para que las pruebas automáticas no choquen con los límites).
const rateLimit = require("express-rate-limit");

function numero(nombre, porDefecto) {
  const n = Number(process.env[nombre]);
  return Number.isFinite(n) && n > 0 ? n : porDefecto;
}

function crear({ ventanaMin, limite, mensaje }) {
  if (process.env.RATE_LIMIT_DISABLED === "1" && process.env.NODE_ENV !== "production") {
    return (req, res, next) => next();
  }
  return rateLimit({
    windowMs: ventanaMin * 60 * 1000,
    limit: limite,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: mensaje },
  });
}

module.exports = {
  // inicio de sesión / registro / cambio de clave
  limiteAuth: crear({ ventanaMin: 15, limite: numero("RATE_LIMIT_AUTH_MAX", 30), mensaje: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo." }),
  // pedir correo de recuperación (evita usarnos para spamear correos)
  limiteRecuperar: crear({ ventanaMin: 60, limite: numero("RATE_LIMIT_RECOVER_MAX", 5), mensaje: "Demasiadas solicitudes de recuperación. Inténtalo más tarde." }),
  // declarar/verificar pagos
  limitePagos: crear({ ventanaMin: 15, limite: numero("RATE_LIMIT_PAYMENTS_MAX", 30), mensaje: "Demasiadas operaciones de pago. Espera unos minutos." }),
  // tope general para toda la API
  limiteGeneral: crear({ ventanaMin: 15, limite: numero("RATE_LIMIT_GENERAL_MAX", 1000), mensaje: "Demasiadas solicitudes. Espera unos minutos." }),
};
