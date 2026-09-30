// Manejo de dinero. REGLA DEL PROYECTO: todos los montos en USD se guardan
// y viajan por la API como enteros en CENTAVOS (ej: $3,50 = 350). Así se
// evitan los errores de redondeo de los decimales flotantes.
// Los bolívares (solo para Pago Móvil) se calculan en céntimos de Bs.

const OPCIONES = { minimumFractionDigits: 2, maximumFractionDigits: 2 };

function formatoUsd(centavos) {
  return "$" + (Number(centavos || 0) / 100).toLocaleString("es-VE", OPCIONES);
}

function formatoBs(centimos) {
  return "Bs. " + (Number(centimos || 0) / 100).toLocaleString("es-VE", OPCIONES);
}

/** Centavos de USD -> texto decimal simple con punto, para CSV (ej: "12.50"). */
function usdCsv(centavos) {
  return (Number(centavos || 0) / 100).toFixed(2);
}

/** Céntimos de Bs para un total en centavos de USD y una tasa (Bs por USD). */
function calcularMontoBs(usdCentavos, tasaBs) {
  return Math.round(usdCentavos * tasaBs);
}

function redondear4(n) {
  return Math.round(n * 10000) / 10000;
}

/** "$12,50 (≈ Bs. 456,78)" si hay tasa; solo "$12,50" si no. */
function formatoDual(usdCentavos, tasaBs) {
  if (!tasaBs) return formatoUsd(usdCentavos);
  return `${formatoUsd(usdCentavos)} (≈ ${formatoBs(calcularMontoBs(usdCentavos, tasaBs))})`;
}

module.exports = { formatoDual, formatoUsd, formatoBs, usdCsv, calcularMontoBs, redondear4 };
