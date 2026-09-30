const prisma = require("./prisma");

/**
 * Error de negocio para pedidos (stock insuficiente, producto ajeno, etc.)
 * Trae un `status` HTTP para que las rutas lo puedan reenviar tal cual.
 */
class PedidoError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_CANTIDAD_POR_PRODUCTO = 1000;
const MAX_TOTAL_CENTAVOS = 2_000_000_000; // por debajo del límite de un entero de 32 bits

/**
 * Crea un pedido calculando SIEMPRE el precio y el total en el servidor
 * (nunca confía en lo que mande el cliente/canal). Montos en CENTAVOS de USD.
 *
 * Todo ocurre en UNA transacción: o se crea el pedido completo con su stock
 * descontado, o no se toca nada. El descuento de stock es atómico
 * ("descuenta solo si todavía hay suficiente"), así dos compras simultáneas
 * de la última unidad no pueden vender más de lo que existe.
 *
 * La usan tanto la ruta HTTP POST /api/pedidos como el agente de
 * WhatsApp/Instagram, para que el checkout sea idéntico en cualquier canal.
 */
async function crearPedido({ comercioId, clienteId, items, canal }) {
  if (!items || items.length === 0) throw new PedidoError(400, "El pedido debe tener al menos un producto.");

  // Consolida líneas repetidas del mismo producto (si no, se podría eludir el
  // control de stock mandando el mismo producto varias veces).
  const consolidado = new Map();
  for (const it of items) {
    consolidado.set(it.productoId, (consolidado.get(it.productoId) || 0) + it.cantidad);
  }
  for (const cantidad of consolidado.values()) {
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > MAX_CANTIDAD_POR_PRODUCTO) {
      throw new PedidoError(400, `La cantidad por producto debe estar entre 1 y ${MAX_CANTIDAD_POR_PRODUCTO}.`);
    }
  }

  return prisma.$transaction(async (tx) => {
    const comercio = await tx.comercio.findUnique({ where: { id: comercioId } });
    if (!comercio) throw new PedidoError(404, "Comercio no encontrado.");

    const itemsDetallados = [];
    let total = 0;

    for (const [productoId, cantidad] of consolidado) {
      const producto = await tx.producto.findUnique({ where: { id: productoId } });
      if (!producto || producto.comercioId !== comercioId) {
        throw new PedidoError(404, "El producto solicitado no existe en este comercio.");
      }
      // Descuento atómico: solo si aún alcanza el stock.
      const r = await tx.producto.updateMany({
        where: { id: productoId, comercioId, stock: { gte: cantidad } },
        data: { stock: { decrement: cantidad } },
      });
      if (r.count !== 1) {
        throw new PedidoError(400, `No hay suficiente stock de "${producto.nombre}" (disponible: ${Math.max(producto.stock, 0)}).`);
      }
      const subtotal = producto.precio * cantidad;
      total += subtotal;
      itemsDetallados.push({ productoId: producto.id, nombre: producto.nombre, cantidad, precioUnitario: producto.precio, subtotal });
    }

    if (total > MAX_TOTAL_CENTAVOS) throw new PedidoError(400, "El total del pedido excede el máximo permitido.");

    return tx.pedido.create({
      data: {
        comercioId, clienteId,
        items: JSON.stringify(itemsDetallados),
        total, estado: "nuevo", estadoPago: "pendiente", canal: canal || "web",
      },
    });
  });
}

/** Devuelve al inventario las unidades de un pedido (al cancelarlo). */
async function restaurarStock(tx, pedido) {
  let items = [];
  try { items = JSON.parse(pedido.items); } catch { items = []; }
  for (const it of items) {
    await tx.producto.updateMany({
      where: { id: it.productoId, comercioId: pedido.comercioId },
      data: { stock: { increment: it.cantidad } },
    });
  }
}

module.exports = { crearPedido, restaurarStock, PedidoError };
