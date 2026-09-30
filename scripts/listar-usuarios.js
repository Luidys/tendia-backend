// Lista todos los usuarios registrados (comerciantes y clientes), útil
// para soporte/depuración desde la terminal.
//
// Uso:
//   node scripts/listar-usuarios.js

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const usuarios = await prisma.usuario.findMany({ orderBy: { createdAt: "asc" } });
  if (usuarios.length === 0) {
    console.log("No hay ningún usuario registrado todavía.");
    process.exit(0);
  }
  console.log(`\nUsuarios registrados (${usuarios.length}):\n`);
  usuarios.forEach((u) => {
    console.log(`- ${u.nombre}  |  ${u.email}  |  rol: ${u.role}${u.comercioId ? `  |  comercioId: ${u.comercioId}` : ""}`);
  });
  console.log("");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
