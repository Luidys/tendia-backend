// Herramienta de un solo uso para resetear la contraseña de un usuario
// desde la terminal (uso administrativo). Los clientes/comerciantes deben
// usar el flujo real de "olvidé mi contraseña" desde la app.
//
// Uso:
//   node scripts/reset-password.js correo@ejemplo.com nuevaClave123

const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const [, , email, nuevaPassword] = process.argv;
  if (!email || !nuevaPassword) {
    console.error("Uso: node scripts/reset-password.js correo@ejemplo.com nuevaClave123");
    process.exit(1);
  }
  if (nuevaPassword.length < 6) {
    console.error("La nueva contraseña debe tener al menos 6 caracteres.");
    process.exit(1);
  }

  const usuario = await prisma.usuario.findUnique({ where: { email } });
  if (!usuario) {
    console.error(`No existe ningún usuario con el correo: ${email}`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(nuevaPassword, 10);
  await prisma.usuario.update({ where: { email }, data: { passwordHash } });

  console.log(`✔ Contraseña actualizada para ${email} (${usuario.nombre}, rol ${usuario.role}).`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
