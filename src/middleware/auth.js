const jwt = require("jsonwebtoken");

/**
 * Verifica que la petición traiga un token JWT válido en el header:
 *   Authorization: Bearer <token>
 * Si es válido, agrega el usuario decodificado a req.user y continúa.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "No se envió token de sesión." });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, role, comercioId? }
    next();
  } catch (err) {
    return res.status(401).json({ error: "Sesión inválida o expirada. Inicia sesión de nuevo." });
  }
}

/**
 * Restringe una ruta a uno o más roles específicos.
 * Uso: router.get("/ruta", requireAuth, requireRole("COMERCIANTE"), handler)
 */
function requireRole(...rolesPermitidos) {
  return (req, res, next) => {
    if (!req.user || !rolesPermitidos.includes(req.user.role)) {
      return res.status(403).json({ error: "No tienes permiso para acceder a este recurso." });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
