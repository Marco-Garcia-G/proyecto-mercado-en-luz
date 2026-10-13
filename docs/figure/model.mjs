// Modelo de la figura: la misma cartera, segmentos y colores que usa la app.
// Variaciones ilustrativas (mitad verde, mitad roja), sin llamadas de red.

export const PORTFOLIO = [
  { symbol: "GOOGL", name: "Alphabet", change: 0.31, segments: 2 },
  { symbol: "ENG.MC", name: "Enagás", change: -0.24, segments: 2 },
  { symbol: "UBER", name: "Uber", change: -0.02, segments: 2 },
  { symbol: "AAPL", name: "Apple", change: 1.32, segments: 2 },
  { symbol: "TSM", name: "TSMC", change: -1.92, segments: 2 },
  { symbol: "IBE.MC", name: "Iberdrola", change: 1.5, segments: 1 },
  { symbol: "AVG", name: "Media", change: null, segments: 1 },
  { symbol: "MCD", name: "McDonald's", change: -0.2, segments: 1 },
  { symbol: "KO", name: "Coca-Cola", change: 1.98, segments: 1 },
  { symbol: "AMZN", name: "Amazon", change: -1.16, segments: 1 },
];

// La media equiponderada de la cartera ocupa su propio segmento, como en la app.
const real = PORTFOLIO.filter((item) => item.symbol !== "AVG");
PORTFOLIO.find((item) => item.symbol === "AVG").change = Math.round((real.reduce((sum, item) => sum + item.change, 0) / real.length) * 100) / 100;

export const SEGMENTS = 15;
// config.json: rojo #FF0000 si baja, verde #00FF00 si sube o no cambia.
export const colorOf = (change) => (change < 0 ? "red" : "green");

// Destellos: cruzar ±N % hace parpadear el tramo N veces (1 % = 1 segundo de luz).
export const flashesOf = (change) => Math.max(1, Math.min(5, Math.floor(Math.abs(change)) || 1));

// Asigna los 15 segmentos en el orden de las teclas, como el editor de cartera.
export function layoutOf(order) {
  const owner = [];
  for (const symbol of order) {
    const item = PORTFOLIO.find((entry) => entry.symbol === symbol);
    for (let index = 0; index < item.segments; index++) owner.push(symbol);
  }
  return owner;
}

// Paquete Bluetooth real de la H617A: 0x33 0x05 0x15 0x01 RGB … máscara de segmentos, XOR final.
export function packetOf(rgb, mask) {
  const packet = new Array(20).fill(0);
  packet.splice(0, 7, 0x33, 0x05, 0x15, 0x01, ...rgb);
  packet[12] = mask & 0xff;
  packet[13] = (mask >> 8) & 0xff;
  packet[19] = packet.slice(0, 19).reduce((a, b) => a ^ b, 0);
  return packet;
}
