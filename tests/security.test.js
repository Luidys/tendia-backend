// Pruebas de seguridad de infraestructura: levantan servidores reales con
// distintas configuraciones y comprueban que las protecciones funcionan.
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log(`  ✔ ${m}`); } else { fail++; console.log(`  ✘ FALLA: ${m}`); } };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const cwd = path.join(__dirname, "..");

function levantar(puerto, env) {
  const p = spawn("node", ["src/index.js"], { cwd, env: { ...process.env, PORT: String(puerto), USE_TEST_DB: "1", JWT_SECRET: "clave-de-pruebas-seguridad-larga-1234567890", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  p.stderr.on("data", () => {});
  return p;
}
async function esperar(base) {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {} await dormir(150); }
  throw new Error("El servidor no arrancó");
}
const json = (base, method, ruta, token, body, extra = {}) =>
  fetch(`${base}${ruta}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });

async function main() {
  // ======================= Servidor A: límites de intentos por IP =======================
  console.log("A) Límites de intentos por IP");
  const A = levantar(4601, { RATE_LIMIT_AUTH_MAX: "6", RATE_LIMIT_RECOVER_MAX: "2" });
  const BA = "http://localhost:4601";
  try {
    await esperar(BA);
    const estados = [];
    for (let i = 0; i < 8; i++) estados.push((await json(BA, "POST", "/api/auth/login", null, { email: `nadie${i}@x.com`, password: "123456" })).status);
    assert(estados.slice(0, 6).every((s) => s === 401) && estados[6] === 429 && estados[7] === 429, `Tras 6 intentos desde la misma IP, los siguientes reciben 429 (${estados.join(",")})`);
    const r429 = await json(BA, "POST", "/api/auth/login", null, { email: "otro@x.com", password: "123456" });
    assert(r429.headers.get("ratelimit-limit") === "6" || !!r429.headers.get("retry-after"), "La respuesta informa el límite (cabeceras estándar RateLimit)");
    const rec = [];
    for (let i = 0; i < 3; i++) rec.push((await json(BA, "POST", "/api/auth/forgot-password", null, { email: `x${i}@x.com` })).status);
    assert(rec[0] === 200 && rec[1] === 200 && rec[2] === 429, `Pedir recuperación de clave está limitado (no se puede usar para spamear correos): ${rec.join(",")}`);
  } finally { A.kill(); }

  // ======================= Servidor B: el resto de protecciones =======================
  console.log("\nB) Cabeceras, CORS, bloqueo de cuenta, sesión y firma de Meta");
  const SECRETO = "app-secret-de-prueba";
  const B = levantar(4602, { RATE_LIMIT_DISABLED: "1", META_APP_SECRET: SECRETO, CORS_ORIGINS: "https://app.ejemplo.com", JWT_EXPIRES_IN: "2s" });
  const BB = "http://localhost:4602";
  try {
    await esperar(BB);

    let r = await fetch(`${BB}/api/health`);
    assert(r.headers.get("x-content-type-options") === "nosniff" && !r.headers.get("x-powered-by"), "Cabeceras de seguridad (helmet): nosniff y sin 'x-powered-by'");
    r = await fetch(`${BB}/api/health`, { headers: { Origin: "https://app.ejemplo.com" } });
    assert(r.headers.get("access-control-allow-origin") === "https://app.ejemplo.com", "CORS: el origen autorizado recibe permiso");
    r = await fetch(`${BB}/api/health`, { headers: { Origin: "https://sitio-malicioso.com" } });
    assert(!r.headers.get("access-control-allow-origin"), "CORS: un sitio no autorizado NO recibe permiso");

    r = await fetch(`${BB}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{esto no es json" });
    assert(r.status === 400, "Un cuerpo que no es JSON válido responde 400 (no 500)");
    r = await fetch(`${BB}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ x: "a".repeat(9 * 1024 * 1024) }) });
    assert(r.status === 413, "Un cuerpo de más de 8MB responde 413");

    // Bloqueo por cuenta tras varios intentos fallidos
    await json(BB, "POST", "/api/auth/register", null, { role: "CLIENTE", nombre: "Ana Prueba", email: "ana.seg@x.com", password: "claveBuena1" });
    const fallos = [];
    for (let i = 0; i < 5; i++) fallos.push((await json(BB, "POST", "/api/auth/login", null, { email: "ana.seg@x.com", password: "mala" + i })).status);
    assert(fallos.every((s) => s === 401), "5 claves incorrectas seguidas responden 401");
    r = await json(BB, "POST", "/api/auth/login", null, { email: "ana.seg@x.com", password: "claveBuena1" });
    assert(r.status === 429, "La 6ª vez la cuenta queda bloqueada temporalmente, incluso con la clave correcta");
    r = await json(BB, "POST", "/api/auth/login", null, { email: "ANA.SEG@x.com", password: "claveBuena1" });
    assert(r.status === 429 || r.status === 401, "Cambiar mayúsculas del correo no evade el bloqueo (429 o rechazo)");
    const fg = await (await json(BB, "POST", "/api/auth/forgot-password", null, { email: "ana.seg@x.com" })).json();
    const rs = await json(BB, "POST", "/api/auth/reset-password", null, { token: fg.resetToken, password: "claveNueva2" });
    assert(rs.status === 200, "Recuperar la contraseña sigue disponible estando bloqueada");
    r = await json(BB, "POST", "/api/auth/login", null, { email: "ana.seg@x.com", password: "claveNueva2" });
    assert(r.status === 200, "Tras cambiar la clave el bloqueo se levanta y puede entrar");

    // Expiración de sesión (JWT_EXPIRES_IN=2s en este servidor)
    const { token } = await r.json();
    assert((await json(BB, "GET", "/api/auth/me", token)).status === 200, "El token recién emitido funciona");
    await dormir(2600);
    assert((await json(BB, "GET", "/api/auth/me", token)).status === 401, "El token vence y deja de funcionar (sesión con caducidad)");

    // Firma de los webhooks de Meta
    const cm = await (await json(BB, "POST", "/api/auth/register", null, { role: "COMERCIANTE", nombre: "Comer Seg", email: "comer.seg@x.com", password: "123456", comercioNombre: "Tienda Seg" })).json();
    await json(BB, "PUT", "/api/comercios/canales", cm.token, { whatsappPhoneNumberId: "phone-seg" });
    await json(BB, "POST", "/api/productos", cm.token, { nombre: "Cosa", precio: 100, stock: 5 });
    const cuerpo = (tel) => JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "W", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "phone-seg" }, messages: [{ from: tel, id: "w1", type: "text", text: { body: "hola" } }] } }] }] });
    const firmar = (raw) => "sha256=" + crypto.createHmac("sha256", SECRETO).update(raw).digest("hex");
    const enviar = (tel, cabeceras) => { const raw = cuerpo(tel); return fetch(`${BB}/api/webhooks/whatsapp`, { method: "POST", headers: { "Content-Type": "application/json", ...cabeceras(raw) }, body: raw }); };
    const respuestasPara = async (tel) => (await (await fetch(`${BB}/api/test/outbox`)).json()).whatsapp.filter((m) => m.telefonoDestino === tel);

    r = await enviar("58400001", (raw) => ({ "x-hub-signature-256": firmar(raw) }));
    await dormir(500);
    assert(r.status === 200 && (await respuestasPara("58400001")).length === 1, "Un webhook con firma VÁLIDA de Meta se procesa y el agente responde");
    r = await enviar("58400002", () => ({ "x-hub-signature-256": "sha256=" + "0".repeat(64) }));
    await dormir(400);
    assert(r.status === 401 && (await respuestasPara("58400002")).length === 0, "Un webhook con firma inválida se rechaza (401) y NO se procesa");
    r = await enviar("58400003", () => ({}));
    await dormir(400);
    assert(r.status === 401 && (await respuestasPara("58400003")).length === 0, "Un webhook sin firma se rechaza (401) y NO se procesa");
    const raw2 = cuerpo("58400004");
    r = await fetch(`${BB}/api/webhooks/whatsapp`, { method: "POST", headers: { "Content-Type": "application/json", "x-hub-signature-256": firmar(raw2) }, body: raw2.replace("hola", "hola ") });
    assert(r.status === 401, "Alterar el cuerpo después de firmarlo invalida la firma");
  } finally { B.kill(); }

  // ======================= Arranque en producción =======================
  console.log("\nC) Arranque en producción: no arranca mal configurado");
  const prod = (env) => spawnSync("node", ["src/index.js"], { cwd, env: { ...process.env, NODE_ENV: "production", PORT: "4603", ...env }, encoding: "utf8", timeout: 8000 });
  let o = prod({ USE_TEST_DB: "1", JWT_SECRET: "corto" });
  assert(o.status === 1 && /JWT_SECRET/.test(o.stderr), "Con JWT_SECRET débil el servidor se niega a arrancar");
  o = prod({ USE_TEST_DB: "1", JWT_SECRET: "cambia-esto-por-una-clave-larga-y-secreta-xxxxxxxx" });
  assert(o.status === 1 && /JWT_SECRET/.test(o.stderr), "Con el secreto de ejemplo del .env.example tampoco arranca");
  o = prod({ USE_TEST_DB: "1", JWT_SECRET: crypto.randomBytes(32).toString("hex") });
  assert(o.status === 1 && /USE_TEST_DB/.test(o.stderr), "No permite la base de datos de pruebas en producción");

  console.log(`\n${"=".repeat(50)}\nRESULTADO SEGURIDAD: ${pass} pruebas correctas, ${fail} fallidas.`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
