// Figura isométrica de Mercado en luz: una habitación con la tira Govee H617A en el
// borde del techo. Uso: node build.mjs [--light] [--es]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as k from "./kit/iso-kit.mjs";
import * as G from "./kit/lathe.mjs";
import { glCamera } from "./kit/gl.mjs";
import { tubePieces, tubeSvg } from "./kit/tube.mjs";
import { kitScript, glScript } from "./scripts/inline-kit.mjs";
import { PORTFOLIO, SEGMENTS } from "./model.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const theme = process.argv.includes("--light") ? "light" : "dark";
const lang = process.argv.includes("--es") ? "es" : "en";

const W = 720;
const H = 560;

// Habitación: suelo x ∈ [0, RW], y ∈ [0, RD]; paredes en x = 0 (izquierda) e y = 0 (derecha).
const T = 10; // grosor de pared
const FLOOR_H = 14;
const RW = 265;
const RD = 290;
const RH = 172;
const SEG = 33; // largo de un segmento de la H617A en la escena
const STRIP_Z = 150;
const STRIP_H = 5;
const STRIP_D = 3.2;
const LEFT_SEGS = 8; // 8 segmentos en la pared izquierda y 7 en la derecha, doblando en la esquina
const CORNER_GAP = 8;

// Centro, extremos y pared de cada segmento, en el orden de la tira (0 = arranque junto al controlador).
const SEGS = Array.from({ length: SEGMENTS }, (_, index) => {
  if (index < LEFT_SEGS) {
    const y1 = CORNER_GAP + (LEFT_SEGS - index) * SEG;
    return { wall: "A", a: y1 - SEG, b: y1, centre: [STRIP_D, y1 - SEG / 2, STRIP_Z + STRIP_H / 2] };
  }
  const x0 = CORNER_GAP + (index - LEFT_SEGS) * SEG;
  return { wall: "B", a: x0, b: x0 + SEG, centre: [x0 + SEG / 2, STRIP_D, STRIP_Z + STRIP_H / 2] };
});
const STRIP_A_END = CORNER_GAP + LEFT_SEGS * SEG + 7;
const STRIP_B_END = CORNER_GAP + (SEGMENTS - LEFT_SEGS) * SEG + 7;

const FLOOR = { x: -T, y: -T, w: RW + T, d: RD + T, r: 3 };
const P = k.fitProjection([...k.boxCorners(FLOOR, -FLOOR_H, RH)], W, H, { pad: 40, azimuth: 45, elevation: 30 });
const at = (point) => k.iso(point, P);
const S = (paths, style) => k.solidSvg(paths, style);
const Ln = (d, style) => k.lineSvg(d, style);
const Dots = (points, style) => k.dotsSvg(points, style);
const slab = (plan, z, h, steps = 3, bevel = 0) => k.slabOf(plan, z, h, P, steps, bevel);
const poly = (points) => k.pathOf(points.map(at), true);
const onA = (x, points) => poly(points.map(([y, z]) => [x, y, z])); // cara vertical x = const
const onB = (y, points) => poly(points.map(([x, z]) => [x, y, z])); // cara vertical y = const
const rect = (u0, u1, z0, z1) => [[u0, z0], [u1, z0], [u1, z1], [u0, z1]];
const UP = (o) => G.frameOf(o, [0, 0, 1], [1, 0, 0], [0, 1, 0]);
const byDepth = (points) => [...points].sort((a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P));
const cable = (points, r = 0.85) => tubePieces(G.fillet(points, 5, 8), r, P, { maxLength: 400, spacing: 1.2 }).map((piece) => tubeSvg(piece, { tone: "mid" })).join("");

const TEXT = {
  en: {
    label: "An isometric bedroom corner at night. A Govee H617A LED strip runs along the top of both walls in an aluminium channel and is split into 15 segments, each lit green or red by one company of a stock portfolio. A controller on the left wall feeds the strip, a phone on the nightstand shows the same 15 colours, and below sits a bed, a plant, a shelf of books and a framed chart.",
    title: "Market in Light",
    hint: "⇄ Drag the keys to reorder",
    keysLabel: "Portfolio keys, from the first segment to the last. Tap a key to flash its segments; drag it, or use Alt and the arrow keys, to move it along the strip.",
  },
  es: {
    label: "Una esquina de dormitorio de noche en isométrico. Una tira LED Govee H617A recorre el borde superior de las dos paredes en un perfil de aluminio y se divide en 15 segmentos, cada uno encendido en verde o rojo por una empresa de una cartera bursátil. Un controlador en la pared izquierda alimenta la tira, un móvil en la mesilla muestra los mismos 15 colores, y debajo hay una cama, una planta, una estantería con libros y un cuadro con un gráfico.",
    title: "Mercado en luz",
    hint: "⇄ Arrastra las teclas para reordenar",
    keysLabel: "Teclas de la cartera, del primer segmento al último. Toca una tecla para que destellen sus segmentos; arrástrala, o usa Alt y las flechas, para moverla por la tira.",
  },
}[lang];

// ---------- Capa trasera: suelo, paredes y todo lo que va colgado en ellas ----------
const back = [];
back.push(`<path class="iso-halo" d="${k.haloOf(FLOOR, -FLOOR_H, FLOOR_H, P)}"/>`);
back.push(S(slab(FLOOR, -FLOOR_H, FLOOR_H, 4, 1.2), { tone: "mid", inner: Ln(k.sideSeam(FLOOR, -FLOOR_H + 4, P, 4), { tone: "faint" }) }));

// Tarima: lamas paralelas a x, con juntas escalonadas que terminan en las líneas de lama.
const BOARD = 18;
const boards = [];
for (let y = BOARD; y < RD; y += BOARD) boards.push(k.lineOnTop([0, y], [RW, y], 0, P));
for (let row = 0; row * BOARD < RD; row++) {
  const y0 = row * BOARD;
  const y1 = Math.min(RD, y0 + BOARD);
  for (let x = 46 + ((row * 67) % 120); x < RW - 10; x += 120) boards.push(k.lineOnTop([x, y0], [x, y1], 0, P));
}
back.push(Ln(boards.join(""), { tone: "faint" }));

// Paredes (A en x = 0, B en y = 0) y sus rodapiés.
const WALL_A = { x: -T, y: -T, w: T, d: RD + T, r: 0 };
const WALL_B = { x: 0, y: -T, w: RW, d: T, r: 0 };
back.push(S(slab(WALL_A, 0, RH, 2, 0.8), { tone: "mid" }));
back.push(S(slab(WALL_B, 0, RH, 2, 0.8), { tone: "mid" }));
back.push(S(slab({ x: 0, y: 0, w: 1.6, d: RD, r: 0 }, 0, 9, 2, 0.3), { tone: "lo" }));
back.push(S(slab({ x: 1.6, y: 0, w: RW - 1.6, d: 1.6, r: 0 }, 0, 9, 2, 0.3), { tone: "lo" }));

// Cuadro con un gráfico, sobre el cabecero.
const POSTER = { x0: 132, x1: 200, z0: 84, z1: 130 };
back.push(S(slab({ x: POSTER.x0, y: 0, w: POSTER.x1 - POSTER.x0, d: 2.4, r: 0.6 }, POSTER.z0, POSTER.z1 - POSTER.z0, 2, 0.4), { tone: "mid" }));
const MAT = { x0: POSTER.x0 + 5, x1: POSTER.x1 - 5, z0: POSTER.z0 + 5, z1: POSTER.z1 - 5 };
back.push(`<path class="iso-fill fig-mat" d="${onB(2.4, rect(MAT.x0, MAT.x1, MAT.z0, MAT.z1))}"/>`);
back.push(Ln(onB(2.4, rect(MAT.x0, MAT.x1, MAT.z0, MAT.z1)), { tone: "lo" }));
const chart = [0, 0.18, 0.12, 0.34, 0.27, 0.5, 0.44, 0.62, 0.55, 0.78, 0.72, 0.9].map((v, i, all) => [MAT.x0 + (i / (all.length - 1)) * (MAT.x1 - MAT.x0), MAT.z0 + 6 + v * (MAT.z1 - MAT.z0 - 12)]);
back.push(Ln(k.pathOf(chart.map(([x, z]) => at([x, 2.4, z]))), { tone: "mid" }));
back.push(Ln(k.pathOf([at([MAT.x0, 2.4, MAT.z0 + 4]), at([MAT.x1, 2.4, MAT.z0 + 4])]), { tone: "faint" }));
back.push(Dots([at([(POSTER.x0 + POSTER.x1) / 2, 0.2, POSTER.z1 + 3])], { size: 0.5, tone: "mid" }));

// Estantería con escuadras y libros, en la pared izquierda.
const SHELF = { x: 0, y: 120, w: 18, d: 86, r: 1 };
for (const y of [SHELF.y + 12, SHELF.y + SHELF.d - 12]) back.push(S(k.extrude([[0, y - 1], [1.6, y - 1], [1.6, y + 1], [0, y + 1]], 86, 10, P), { tone: "lo" }) + S(slab({ x: 0, y: y - 1, w: 12, d: 2, r: 0 }, 92, 4, 2), { tone: "lo" }));
back.push(S(slab(SHELF, 96, 3, 3, 0.5), { tone: "mid" }));
const BOOKS = [[3, 15, 19], [3.6, 13, 22], [2.8, 14, 17], [4, 15, 21], [3, 12, 16], [3.4, 15, 20]];
let bookY = SHELF.y + 8;
for (const [thick, deep, tall] of BOOKS) {
  back.push(S(slab({ x: 2, y: bookY, w: deep, d: thick, r: 0.4 }, 99, tall, 2, 0.3), { tone: "mid", inner: Ln(k.sideSeam({ x: 2, y: bookY, w: deep, d: thick, r: 0.4 }, 99 + tall - 3, P, 2), { tone: "faint" }) }));
  bookY += thick + 0.4;
}
back.push(S(k.cylinder(9, SHELF.y + SHELF.d - 18, 5, 99, 8, P, 24, 0.4), { tone: "lo" }));
back.push(S(G.sphereOf([9, SHELF.y + SHELF.d - 18, 110], 6, P), { tone: "mid" }));
back.push(S(slab({ x: 4, y: SHELF.y + SHELF.d - 38, w: 11, d: 12, r: 1.2 }, 99, 6, 3, 0.4), { tone: "lo" }));

// Reloj de pared.
const CLOCK = G.frameOf([0, 222, 120], [1, 0, 0], [0, 1, 0], [0, 0, 1]);
back.push(S(G.disc(0, 2.6, 12, CLOCK, P), { tone: "mid" }));
back.push(Ln(G.circleOf(CLOCK, 2.6, 10.6, P, 64), { tone: "lo" }));
back.push(Ln(G.spokesOf(CLOCK, 2.6, 8.6, 10, 12, P), { tone: "mid" }));
back.push(Ln(k.pathOf([at([2.6, 222, 120]), at([2.6, 222 - 4.2, 120 + 3.4])]), { tone: "hi", free: "end" }) + Ln(k.pathOf([at([2.6, 222, 120]), at([2.6, 222 + 1.2, 120 + 7.6])]), { tone: "hi", free: "end" }));
back.push(Dots([at([2.6, 222, 120])], { size: 0.6, tone: "hi" }));

// Enchufe, controlador Govee y sus cables, al arranque de la tira.
const CTRL = { x: 0, y: STRIP_A_END - 22, w: 5.2, d: 18, r: 1.4 };
const CTRL_Z = 110;
back.push(S(slab({ x: 0, y: CTRL.y + 3, w: 1.2, d: 12, r: 1 }, 14, 13, 3, 0.3), { tone: "mid" }));
back.push(Dots([at([1.2, CTRL.y + 9, 24.5])], { size: 0.45 }));
back.push(S(slab({ x: 1.2, y: CTRL.y + 6, w: 3.2, d: 6, r: 1 }, 16.5, 6, 3, 0.4), { tone: "mid" }));
back.push(cable([[2.8, CTRL.y + 9, 22.5], [2.8, CTRL.y + 9, 60], [2.6, CTRL.y + 8, CTRL_Z]]));
back.push(S(slab({ x: 0, y: CTRL.y + 6.5, w: 4.4, d: 5, r: 0.8 }, 62, 3, 2, 0.3), { tone: "lo" }));
back.push(cable([[2.6, CTRL.y + 13, CTRL_Z + 12], [2.6, CTRL.y + 13, STRIP_Z - 8], [1.8, STRIP_A_END - 4, STRIP_Z]]));
back.push(S(slab(CTRL, CTRL_Z, 12, 4, 0.6), { tone: "mid", inner: Ln(k.sideSeam(CTRL, CTRL_Z + 3, P, 4), { tone: "faint" }) }));
back.push(Ln([0, 1, 2].map((i) => k.planOutline({ x: 1.2, y: CTRL.y + 4 + i * 3.4, w: 2.8, d: 1, r: 0.5 }, CTRL_Z + 12, P, 3)).join(""), { tone: "faint" }));
back.push(S(k.extrude([[CTRL.x + CTRL.w, CTRL.y + 11], [CTRL.x + CTRL.w + 1, CTRL.y + 11], [CTRL.x + CTRL.w + 1, CTRL.y + 15], [CTRL.x + CTRL.w, CTRL.y + 15]], CTRL_Z + 4, 3.4, P), { tone: "mid" }));
back.push(`<g class="fig-ctrl-led">${Dots([at([CTRL.x + CTRL.w, CTRL.y + 5, CTRL_Z + 6])], { size: 0.9, tone: "hi" })}</g>`);
back.push(Dots([at([CTRL.x + CTRL.w, CTRL.y + 2, CTRL_Z + 10]), at([CTRL.x + CTRL.w, CTRL.y + CTRL.d - 2, CTRL_Z + 10])], { size: 0.4 }));

// Perfil de aluminio con difusor y los 15 segmentos; tapas en los extremos y pieza de esquina.
const CH_A = { x: 0, y: 0, w: STRIP_D, d: STRIP_A_END, r: 0 };
const CH_B = { x: STRIP_D, y: 0, w: STRIP_B_END - STRIP_D, d: STRIP_D, r: 0 };
back.push(S(slab(CH_A, STRIP_Z - 0.6, STRIP_H + 1.2, 2, 0.3), { tone: "mid" }));
back.push(S(slab(CH_B, STRIP_Z - 0.6, STRIP_H + 1.2, 2, 0.3), { tone: "mid" }));
back.push(S(slab({ x: 0, y: STRIP_A_END - 1.6, w: STRIP_D + 0.6, d: 1.6, r: 0.3 }, STRIP_Z - 1, STRIP_H + 2, 2), { tone: "lo" }));
back.push(S(slab({ x: STRIP_B_END - 1.6, y: 0, w: 1.6, d: STRIP_D + 0.6, r: 0.3 }, STRIP_Z - 1, STRIP_H + 2, 2), { tone: "lo" }));
const segFaces = SEGS.map((seg, index) => {
  const face = seg.wall === "A"
    ? onA(STRIP_D, rect(seg.b - 0.5, seg.a + 0.5, STRIP_Z + 0.7, STRIP_Z + STRIP_H - 0.7))
    : onB(STRIP_D, rect(seg.a + 0.5, seg.b - 0.5, STRIP_Z + 0.7, STRIP_Z + STRIP_H - 0.7));
  return `<path class="fig-led" data-seg="${index}" d="${face}"/>`;
});
back.push(`<g class="fig-leds">${segFaces.join("")}</g>`);
// Pads de corte de cobre entre segmentos, como en la tira real.
const pads = [];
for (let index = 1; index < SEGMENTS; index++) {
  const seg = SEGS[index];
  if (seg.wall !== SEGS[index - 1].wall) continue;
  const u = seg.wall === "A" ? seg.b : seg.a;
  for (const z of [STRIP_Z + 1.6, STRIP_Z + STRIP_H - 1.6]) pads.push(at(seg.wall === "A" ? [STRIP_D, u, z] : [u, STRIP_D, z]));
}
back.push(Dots(pads, { size: 0.42, tone: "mid" }));

// Respaldo sin WebGL: un lavado de color bajo cada segmento, dibujado en el plano de su pared.
const WASH = 80;
const planeA = k.sideMatrix([0.1, 0], 0, P, "right");
const planeB = k.sideMatrix([0, 0.1], 0, P, "left");
const washes = SEGS.map((seg, index) => {
  const [u0, u1] = seg.wall === "A" ? [-seg.b, -seg.a] : [seg.a, seg.b];
  return `<rect class="fig-wash" data-seg="${index}" transform="${seg.wall === "A" ? planeA : planeB}" x="${u0}" y="${-STRIP_Z}" width="${u1 - u0}" height="${WASH}" fill="url(#fig-wash-green)"/>`;
});
back.push(`<defs>${["green", "red"].map((tone) => `<linearGradient id="fig-wash-${tone}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="fig-wash-stop" data-tone="${tone}" stop-opacity=".9"/><stop offset=".35" class="fig-wash-stop" data-tone="${tone}" stop-opacity=".35"/><stop offset="1" class="fig-wash-stop" data-tone="${tone}" stop-opacity="0"/></linearGradient>`).join("")}</defs>`);
back.push(`<g class="fig-fallback">${washes.join("")}</g>`);

// Alfombra.
const RUG = { x: 46, y: 150, w: 196, d: 112, r: 3 };
back.push(S(slab(RUG, 0, 1, 3), { tone: "lo", flat: true }));
back.push(Ln(k.planOutline(k.insetPlan(RUG, 6), 1, P, 3), { tone: "faint" }));
back.push(Ln(k.planOutline(k.insetPlan(RUG, 9), 1, P, 3), { tone: "faint" }));

// ---------- Capa delantera: muebles, por profundidad ----------
const front = [];

// Planta en la esquina del fondo.
const POT = [30, 34];
front.push(`<path class="iso-halo" d="${k.haloOf({ x: POT[0] - 12, y: POT[1] - 12, w: 24, d: 24, r: 12 }, 0, 4, P)}"/>`);
front.push(S(k.cylinder(POT[0], POT[1], 9, 0, 3, P, 40), { tone: "lo" }));
front.push(S(G.solidOf([[0, 9.5], [22, 12], [22, 13], [25, 13]], UP([POT[0], POT[1], 3]), P), { tone: "mid", inner: Ln(G.arcOf(UP([POT[0], POT[1], 3]), 22, 12, P), { tone: "faint" }) }));
front.push(Ln(k.ring(POT[0], POT[1], 11.6, 28, P, 40), { tone: "lo" }));
for (const [dx, dy, z, r] of [[-5, -4, 38, 10], [6, -5, 44, 9], [-3, 6, 50, 9.5], [5, 5, 36, 9], [0, 0, 58, 8]]) front.push(S(G.sphereOf([POT[0] + dx, POT[1] + dy, z], r, P), { tone: "mid" }));

// Mesilla con lámpara y el móvil con la app.
const NS = { x: 48, y: 6, w: 36, d: 32, r: 2 };
for (const [x, y] of byDepth(k.corners(NS, 3.5))) front.push(S(k.cylinder(x, y, 1.6, 0, 6, P, 16), { tone: "lo" }));
front.push(`<path class="iso-halo" d="${k.haloOf(NS, 0, 6, P)}"/>`);
front.push(S(slab(NS, 6, 32, 3, 0.6), { tone: "mid" }));
front.push(Ln(onB(NS.y + NS.d, rect(NS.x + 3, NS.x + NS.w - 3, 12, 34)), { tone: "lo" }));
front.push(Ln(onB(NS.y + NS.d, rect(NS.x + 3, NS.x + NS.w - 3, 23, 23.4)), { tone: "faint" }));
front.push(S(k.extrude([[NS.x + 15, NS.y + NS.d], [NS.x + 21, NS.y + NS.d], [NS.x + 21, NS.y + NS.d + 1.4], [NS.x + 15, NS.y + NS.d + 1.4]], 27.6, 2.2, P), { tone: "hi" }));
const NS_TOP = { x: NS.x - 2, y: NS.y - 1, w: NS.w + 4, d: NS.d + 3, r: 2 };
front.push(S(slab(NS_TOP, 38, 3, 3, 0.6), { tone: "mid" }));
const LAMP = [NS.x + 10, NS.y + 10];
front.push(S(k.cylinder(LAMP[0], LAMP[1], 6, 41, 2.4, P, 32, 0.4), { tone: "mid" }));
front.push(S(k.cylinder(LAMP[0], LAMP[1], 1, 43.4, 16, P, 12), { tone: "mid" }));
front.push(S(G.solidOf([[0, 10.5], [15, 6.5]], UP([LAMP[0], LAMP[1], 57]), P), { tone: "mid", inner: Ln(G.arcOf(UP([LAMP[0], LAMP[1], 57]), 2.5, 9.83, P, { slope: -4 / 15 }), { tone: "faint" }) }));
const PHONE = { x: NS.x + 20, y: NS.y + 9, w: 11, d: 20, r: 1.6 };
front.push(S(slab(PHONE, 41, 1.2, 4, 0.3), { tone: "lo" }));
const SCREEN = k.insetPlan(PHONE, 1.1);
front.push(`<path class="fig-screen" d="${k.planOutline(SCREEN, 42.21, P, 4)}"/>`);
const minis = [];
for (let index = 0; index < SEGMENTS; index++) {
  const y = SCREEN.y + 2.2 + index * ((SCREEN.d - 4.4) / SEGMENTS);
  minis.push(`<path class="fig-mini" data-seg="${index}" d="${k.pathOf([[SCREEN.x + 1.6, y], [SCREEN.x + SCREEN.w - 1.6, y], [SCREEN.x + SCREEN.w - 1.6, y + 0.8], [SCREEN.x + 1.6, y + 0.8]].map(([x, yy]) => at([x, yy, 42.22])), true)}"/>`);
}
front.push(`<g class="fig-minis">${minis.join("")}</g>`);

// Cama: cabecero, patas, somier, colchón, almohadas y nórdico.
const BED = { x: 100, y: 7, w: 124, d: 184, r: 2 };
front.push(`<path class="iso-halo" d="${k.haloOf(BED, 0, 10, P)}"/>`);
const HEAD = { x: BED.x - 4, y: 0, w: BED.w + 8, d: 7, r: 1.2 };
front.push(S(slab(HEAD, 0, 66, 3, 0.8), { tone: "mid" }));
for (let i = 0; i < 4; i++) {
  const x0 = HEAD.x + 7 + i * ((HEAD.w - 14) / 4);
  front.push(Ln(onB(HEAD.d, rect(x0 + 2, x0 + (HEAD.w - 14) / 4 - 2, 30, 59)), { tone: "faint" }));
}
for (const [x, y] of byDepth(k.corners(BED, 5))) front.push(S(k.cylinder(x, y, 2.6, 0, 8, P, 16), { tone: "lo" }));
const FRAME_PLAN = BED;
front.push(S(slab(FRAME_PLAN, 8, 14, 3, 0.6), { tone: "mid", inner: Ln(k.sideSeam(FRAME_PLAN, 12, P, 3), { tone: "faint" }) }));
const MATTRESS = { x: BED.x + 3, y: BED.y + 2, w: BED.w - 6, d: BED.d - 5, r: 6 };
front.push(S(slab(MATTRESS, 22, 15, 6, 0.8), { tone: "mid", inner: Ln(k.sideSeam(MATTRESS, 29.5, P, 6), { tone: "faint" }) }));
for (const x of [MATTRESS.x + 6, MATTRESS.x + MATTRESS.w / 2 + 2]) {
  const pillow = { x, y: MATTRESS.y + 6, w: MATTRESS.w / 2 - 8, d: 30, r: 9 };
  front.push(S(slab(pillow, 37, 9, 8, 1.2), { tone: "mid", inner: Ln(k.sideSeam(pillow, 41.5, P, 8), { tone: "faint" }) }));
}
const DUVET = { x: BED.x - 2, y: 66, w: BED.w + 4, d: BED.d - 57, r: 7 };
front.push(S(slab(DUVET, 26, 15, 8, 1), { tone: "mid", inner: Ln(k.sideSeam(DUVET, 30, P, 8), { tone: "faint" }) }));
const FOLD = { x: DUVET.x + 1, y: DUVET.y, w: DUVET.w - 2, d: 20, r: 6 };
front.push(S(slab(FOLD, 41, 2.2, 6, 0.6), { tone: "mid" }));
front.push(Ln(k.lineOnTop([DUVET.x, DUVET.y + 70], [DUVET.x + DUVET.w, DUVET.y + 70], 41, P) + k.segment([DUVET.x + DUVET.w, DUVET.y + 70, 41], [DUVET.x + DUVET.w, DUVET.y + 70, 26], P), { tone: "faint" }));

// MacBook abierto sobre el nórdico, con la web de la app en pantalla (imagen fija).
const LAP = { x: 138, y: 124, w: 46, d: 31, r: 1.8 };
const LAP_Z = 41;
front.push(`<path class="iso-halo" d="${k.haloOf(LAP, LAP_Z, 2, P)}"/>`);
front.push(S(slab(LAP, LAP_Z, 1.5, 4, 0.4), { tone: "mid" }));
const DECK = { x: LAP.x + 3, y: LAP.y + 3, w: LAP.w - 6, d: 14, r: 1 };
front.push(Ln(k.planOutline(DECK, LAP_Z + 1.5, P, 3), { tone: "lo" }));
front.push(Ln([1, 2, 3, 4].map((row) => k.lineOnTop([DECK.x, DECK.y + row * 2.8], [DECK.x + DECK.w, DECK.y + row * 2.8], LAP_Z + 1.5, P)).join(""), { tone: "faint" }));
front.push(Ln(k.planOutline({ x: LAP.x + 15, y: LAP.y + 19.5, w: 16, d: 9, r: 1 }, LAP_Z + 1.5, P, 3), { tone: "lo" }));
const LID = { x: LAP.x, y: LAP.y - 2, w: LAP.w, d: 2, r: 0.8 };
const LID_TOP = LAP_Z + 1.5 + 30;
front.push(S(slab(LID, LAP_Z + 0.6, LID_TOP - LAP_Z - 0.6, 3, 0.3), { tone: "mid" }));
const FACE_Y = LID.y + LID.d + 0.02;
const DISPLAY = { x0: LID.x + 1.8, x1: LID.x + LID.w - 1.8, z0: LAP_Z + 4, z1: LID_TOP - 1.8 };
const ui = [`<path class="fig-mac-screen" d="${onB(FACE_Y, rect(DISPLAY.x0, DISPLAY.x1, DISPLAY.z0, DISPLAY.z1))}"/>`];
const startOwners = PORTFOLIO.flatMap((item) => Array(item.segments).fill(item));
const STRIP_UI = { x0: DISPLAY.x0 + 4, x1: DISPLAY.x1 - 4, z: DISPLAY.z1 - 5.5 };
const cell = (STRIP_UI.x1 - STRIP_UI.x0) / SEGMENTS;
startOwners.forEach((item, i) => ui.push(`<path class="fig-ui" data-tone="${item.change < 0 ? "red" : "green"}" d="${onB(FACE_Y, rect(STRIP_UI.x0 + i * cell + 0.25, STRIP_UI.x0 + (i + 1) * cell - 0.25, STRIP_UI.z, STRIP_UI.z + 1))}"/>`));
ui.push(`<path class="fig-ui" data-tone="text" d="${onB(FACE_Y, rect(DISPLAY.x0 + 4, DISPLAY.x0 + 17, DISPLAY.z1 - 10.5, DISPLAY.z1 - 8.6))}"/>`);
const rows = [PORTFOLIO[0], PORTFOLIO[3], PORTFOLIO[4]];
rows.forEach((item, r) => {
  const z = DISPLAY.z1 - 14.5 - r * 4.6;
  const tone = item.change < 0 ? "red" : "green";
  ui.push(`<path class="fig-ui" data-tone="muted" d="${onB(FACE_Y, rect(DISPLAY.x0 + 4, DISPLAY.x0 + 10, z, z + 1.2))}"/>`);
  const spark = Array.from({ length: 9 }, (_, i) => [DISPLAY.x0 + 15 + i * 2, z + 0.6 + (tone === "green" ? i / 8 : 1 - i / 8) * 1.4 + (i % 2 ? 0.5 : -0.3)]);
  ui.push(`<path class="fig-ui-line" data-tone="${tone}" d="${k.pathOf(spark.map(([x, zz]) => at([x, FACE_Y, zz])))}"/>`);
  ui.push(`<path class="fig-ui" data-tone="${tone}" d="${onB(FACE_Y, rect(DISPLAY.x1 - 10, DISPLAY.x1 - 4, z - 0.1, z + 1.5))}"/>`);
});
front.push(`<g class="fig-mac">${ui.join("")}</g>`);
front.push(Ln(onB(FACE_Y, rect(DISPLAY.x0, DISPLAY.x1, DISPLAY.z0, DISPLAY.z1)), { tone: "lo" }));
front.push(Dots([at([(LID.x + LID.x + LID.w) / 2, FACE_Y, LID_TOP - 0.9])], { size: 0.35, tone: "mid" }));

// Puf junto a la alfombra.
const POUF = [70, 236];
front.push(`<path class="iso-halo" d="${k.haloOf({ x: POUF[0] - 15, y: POUF[1] - 15, w: 30, d: 30, r: 15 }, 0, 4, P)}"/>`);
front.push(S(G.solidOf([[0, 13], [2, 14.5, 1], [9, 15, 1], [16, 14, 1], [18, 11]], UP([POUF[0], POUF[1], 0]), P), { tone: "mid", inner: Ln(G.arcOf(UP([POUF[0], POUF[1], 0]), 9, 15, P), { tone: "faint" }) }));
front.push(Dots([at([POUF[0], POUF[1], 18])], { size: 0.55, tone: "mid" }));

// Volúmenes que la segunda capa de luz ilumina: los mismos planos que dibuja el SVG.
// Un prisma de planta redondeada es la unión de dos cajas en cruz y cuatro cilindros en las esquinas.
const BOXES = [];
const CYLS = [];
function volume(plan, z0, z1, round = true) {
  const { x, y, w, d, r } = plan;
  if (!round || r < 3) { BOXES.push([x, y, z0, x + w, y + d, z1]); return; }
  BOXES.push([x + r, y, z0, x + w - r, y + d, z1], [x, y + r, z0, x + w, y + d - r, z1]);
  for (const [cx, cy] of [[x + r, y + r], [x + w - r, y + r], [x + r, y + d - r], [x + w - r, y + d - r]]) CYLS.push([cx, cy, r, r, z0, z1]);
}
volume(HEAD, 0, 66);
volume(BED, 8, 22);
volume(MATTRESS, 22, 37);
volume({ x: MATTRESS.x + 6, y: MATTRESS.y + 6, w: MATTRESS.w / 2 - 8, d: 30, r: 9 }, 37, 46);
volume({ x: MATTRESS.x + MATTRESS.w / 2 + 2, y: MATTRESS.y + 6, w: MATTRESS.w / 2 - 8, d: 30, r: 9 }, 37, 46);
volume(DUVET, 26, 41);
volume(FOLD, 41, 43.2);
volume(NS, 6, 38);
volume(NS_TOP, 38, 41);
volume(LAP, LAP_Z, LAP_Z + 1.5);
volume(LID, LAP_Z + 0.6, LID_TOP);
// Troncos de cono verticales: [x, y, radio inferior, radio superior, z0, z1].
CYLS.push([LAMP[0], LAMP[1], 10.5, 6.5, 57, 72], [POT[0], POT[1], 9.5, 13, 3, 28], [POUF[0], POUF[1], 14.5, 11, 0, 18], [LAMP[0], LAMP[1], 6, 6, 41, 43.4]);
const SPHERES = [[-5, -4, 38, 10], [6, -5, 44, 9], [-3, 6, 50, 9.5], [5, 5, 36, 9], [0, 0, 58, 8]].map(([dx, dy, z, r]) => [POT[0] + dx, POT[1] + dy, z, r]);

const backSvg = k.figureSvg({ width: W, height: H, label: TEXT.label, body: back, className: "fig-back" });
const frontSvg = `<svg xmlns="http://www.w3.org/2000/svg" class="iso-svg fig-layer fig-front" viewBox="0 0 ${W} ${H}" aria-hidden="true">${front.join("")}</svg>`;

// ---------- Teclas tipo xilófono ----------
const keys = PORTFOLIO.map((item) => `<button type="button" class="fig-key" data-symbol="${item.symbol}" data-tone="${item.change < 0 ? "red" : "green"}">${item.symbol === "AVG" ? (lang === "es" ? "MEDIA" : "AVG") : item.symbol}</button>`).join("");
const stage = `<div class="fig-stage" tabindex="-1">${backSvg}<canvas class="fig-layer fig-gl" aria-hidden="true"></canvas>${frontSvg}<canvas class="fig-layer fig-gl fig-gl-front" aria-hidden="true"></canvas></div>
<div class="fig-keys" role="group" aria-label="${TEXT.keysLabel}"><div class="fig-keyrow">${keys}</div></div>
<span class="fig-sr" role="status" aria-live="polite" data-status></span>`;

const DATA = {
  W, H, camera: glCamera(P), lang,
  room: [RW, RD, RH], strip: [STRIP_Z, STRIP_H, STRIP_D],
  segs: SEGS.map((seg) => ({ wall: seg.wall, a: seg.a, b: seg.b, centre: seg.centre })),
  portfolio: PORTFOLIO,
  boxes: BOXES, spheres: SPHERES, cyls: CYLS,
};
const css = readFileSync(join(HERE, "figure.css"), "utf8");
const live = readFileSync(join(HERE, "live.js"), "utf8").replace("__DATA__", JSON.stringify(DATA));
const body = `<style>${css}</style>` + k.plateHtml({
  fig: TEXT.title,
  title: TEXT.hint,
  readout: "",
  body: stage,
});
const REPO = "https://github.com/Marco-Garcia-G/proyecto-mercado-en-luz";
const other = lang === "es" ? `market-in-light${theme === "light" ? "-light" : ""}.html` : `market-in-light-es${theme === "light" ? "-light" : ""}.html`;
const footer = `<p class="fig-source"><a href="${REPO}">${lang === "es" ? "Código en GitHub" : "Source on GitHub"}</a><span aria-hidden="true">·</span><a href="${other}" hreflang="${lang === "es" ? "en" : "es"}">${lang === "es" ? "English" : "Español"}</a></p>`;
const name = `market-in-light${lang === "es" ? "-es" : ""}${theme === "light" ? "-light" : ""}.html`;
writeFileSync(join(HERE, name), k.pageHtml({ title: TEXT.title, theme, body: body + footer, script: kitScript() + glScript() + live, width: 760 }).replace('<html lang="en">', `<html lang="${lang}">`));
console.log("wrote", name);
