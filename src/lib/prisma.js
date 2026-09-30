let prisma;

if (process.env.USE_TEST_DB === "1") {
  // Solo para pruebas locales/CI, sin depender de un Postgres externo.
  prisma = require("./prisma.testdb");
} else {
  const { PrismaClient } = require("@prisma/client");
  // Reutilizamos una sola instancia de Prisma en toda la app
  // (evita agotar conexiones a la base de datos en desarrollo).
  prisma = new PrismaClient();
}

module.exports = prisma;
