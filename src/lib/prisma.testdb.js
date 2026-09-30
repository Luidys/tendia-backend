// Base de datos de PRUEBA únicamente (no se usa en producción).
// Implementa el mismo "shape" de métodos que usa nuestro código de rutas
// (create, findMany, findUnique, update, delete) pero respaldado por
// SQLite real (node:sqlite, incluido en Node — no requiere descargar nada).
// Se activa solo cuando la variable de entorno USE_TEST_DB=1.

const { DatabaseSync } = require("node:sqlite");
const crypto = require("crypto");

const db = new DatabaseSync(":memory:");

db.exec(`
  CREATE TABLE comercio (
    id TEXT PRIMARY KEY, nombre TEXT, categoria TEXT, createdAt TEXT,
    whatsappPhoneNumberId TEXT, instagramPageId TEXT, logo TEXT,
    tasaBs REAL, tasaBsActualizada TEXT, metodosPago TEXT
  );
  CREATE TABLE usuario (
    id TEXT PRIMARY KEY, email TEXT UNIQUE, telefono TEXT, passwordHash TEXT,
    nombre TEXT, role TEXT, comercioId TEXT, createdAt TEXT,
    resetToken TEXT UNIQUE, resetTokenExpira TEXT
  );
  CREATE TABLE clienteComercio (
    id TEXT PRIMARY KEY, clienteId TEXT, comercioId TEXT,
    totalComprado INTEGER DEFAULT 0, createdAt TEXT
  );
  CREATE TABLE producto (
    id TEXT PRIMARY KEY, comercioId TEXT, nombre TEXT, categoria TEXT,
    precio INTEGER, precioAntes INTEGER, promo TEXT, stock INTEGER, createdAt TEXT,
    imagen1 TEXT, imagen2 TEXT
  );
  CREATE TABLE pedido (
    id TEXT PRIMARY KEY, comercioId TEXT, clienteId TEXT, items TEXT,
    total INTEGER, estado TEXT, estadoPago TEXT DEFAULT 'pendiente', canal TEXT, createdAt TEXT
  );
  CREATE TABLE pago (
    id TEXT PRIMARY KEY, pedidoId TEXT, comercioId TEXT, clienteId TEXT, metodo TEXT,
    montoUsd INTEGER, montoBs INTEGER, tasaBs REAL, referencia TEXT, comprobante TEXT,
    estado TEXT DEFAULT 'por_verificar', motivoRechazo TEXT, verificadoPor TEXT, verificadoEn TEXT,
    claveUnica TEXT UNIQUE, canal TEXT DEFAULT 'web', createdAt TEXT
  );
  CREATE TABLE conversacion (
    id TEXT PRIMARY KEY, comercioId TEXT, telefono TEXT, canal TEXT,
    estado TEXT DEFAULT 'inicio', carritoJson TEXT DEFAULT '[]',
    ultimoMenuJson TEXT DEFAULT '[]', updatedAt TEXT, createdAt TEXT
  );
`);

function rowToNullFixed(row) {
  if (!row) return row;
  const out = {};
  for (const k in row) out[k] = row[k] === null ? null : row[k];
  return out;
}

function cumple(valor, cond) {
  if (cond !== null && typeof cond === "object") {
    if ("gte" in cond && !(valor >= cond.gte)) return false;
    if ("gt" in cond && !(valor > cond.gt)) return false;
    if ("lte" in cond && !(valor <= cond.lte)) return false;
    if ("lt" in cond && !(valor < cond.lt)) return false;
    return true;
  }
  return valor === cond;
}

function matchWhere(row, where) {
  return Object.entries(where).every(([k, v]) => cumple(row[k], v));
}

function makeModel(table, columnsWithDefaults) {
  return {
    async create({ data }) {
      const id = data.id || crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const row = { id, createdAt, ...columnsWithDefaults, ...data };
      const cols = Object.keys(row);
      const placeholders = cols.map(() => "?").join(",");
      db.prepare(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${placeholders})`)
        .run(...cols.map((c) => (row[c] === undefined ? null : row[c])));
      return rowToNullFixed(row);
    },

    async findMany({ where = {}, orderBy } = {}) {
      let rows = db.prepare(`SELECT * FROM ${table}`).all();
      rows = rows.filter((r) => matchWhere(r, where));
      if (orderBy) {
        const [field] = Object.keys(orderBy);
        const dir = orderBy[field];
        rows.sort((a, b) => (a[field] > b[field] ? 1 : -1) * (dir === "desc" ? -1 : 1));
      }
      return rows.map(rowToNullFixed);
    },

    async findUnique({ where }) {
      // soporta claves compuestas tipo { clienteId_comercioId: { clienteId, comercioId } }
      const [key, val] = Object.entries(where)[0];
      const cond = key.includes("_") && typeof val === "object" ? val : { [key]: val };
      const rows = db.prepare(`SELECT * FROM ${table}`).all();
      const row = rows.find((r) => matchWhere(r, cond));
      return row ? rowToNullFixed(row) : null;
    },

    async update({ where, data }) {
      const existing = await this.findUnique({ where });
      if (!existing) return null;
      const merged = { ...existing, ...data };
      const cols = Object.keys(merged).filter((c) => c !== "id");
      const setSql = cols.map((c) => `${c} = ?`).join(", ");
      db.prepare(`UPDATE ${table} SET ${setSql} WHERE id = ?`)
        .run(...cols.map((c) => merged[c]), existing.id);
      return rowToNullFixed(merged);
    },

    // Igual que Prisma: actualiza todas las filas que cumplan `where` y devuelve
    // { count }. Soporta { decrement } / { increment } (operaciones atómicas).
    async updateMany({ where = {}, data }) {
      const filas = db.prepare(`SELECT * FROM ${table}`).all().filter((r) => matchWhere(r, where));
      for (const r of filas) {
        const cambios = {};
        for (const [k, v] of Object.entries(data)) {
          if (v !== null && typeof v === "object" && "decrement" in v) cambios[k] = r[k] - v.decrement;
          else if (v !== null && typeof v === "object" && "increment" in v) cambios[k] = r[k] + v.increment;
          else cambios[k] = v;
        }
        const cols = Object.keys(cambios);
        db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
          .run(...cols.map((c) => cambios[c]), r.id);
      }
      return { count: filas.length };
    },

    async delete({ where }) {
      const existing = await this.findUnique({ where });
      if (!existing) return null;
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(existing.id);
      return rowToNullFixed(existing);
    },
  };
}

module.exports = {
  // Transacción interactiva (misma forma que prisma.$transaction(async (tx) => ...)).
  // Es segura aquí porque todas las operaciones de este doble de prueba se
  // resuelven en el mismo turno del event loop (sin I/O real entre BEGIN y COMMIT).
  async $transaction(fn) {
    db.exec("BEGIN");
    try {
      const resultado = await fn(module.exports);
      db.exec("COMMIT");
      return resultado;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  },
  comercio: makeModel("comercio", { categoria: null, whatsappPhoneNumberId: null, instagramPageId: null, logo: null, tasaBs: null, tasaBsActualizada: null, metodosPago: null }),
  usuario: makeModel("usuario", { telefono: null, comercioId: null, resetToken: null, resetTokenExpira: null }),
  clienteComercio: makeModel("clienteComercio", { totalComprado: 0 }),
  producto: makeModel("producto", { categoria: null, precioAntes: null, promo: null, stock: 0, imagen1: null, imagen2: null }),
  pedido: makeModel("pedido", { estado: "nuevo", estadoPago: "pendiente", canal: "web" }),
  pago: makeModel("pago", { montoBs: null, tasaBs: null, comprobante: null, estado: "por_verificar", motivoRechazo: null, verificadoPor: null, verificadoEn: null, claveUnica: null, canal: "web" }),
  conversacion: makeModel("conversacion", { estado: "inicio", carritoJson: "[]", ultimoMenuJson: "[]" }),
};
