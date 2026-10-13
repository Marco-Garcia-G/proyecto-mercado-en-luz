const D = __DATA__;
const ES = D.lang === "es";
const root = document.querySelector(".fig-stage");
const plate = root.closest(".iso-plate");
const LIGHT = (root.closest("[data-theme]")?.getAttribute("data-theme") || "dark") === "light" ? 1 : 0;
const still = matchMedia("(prefers-reduced-motion: reduce)");
const status = plate.querySelector("[data-status]");
const keyRow = plate.querySelector(".fig-keyrow");
const leds = [...root.querySelectorAll(".fig-led")];
const washes = [...root.querySelectorAll(".fig-wash")];
const minis = [...root.querySelectorAll(".fig-mini")];
const ctrlLed = root.querySelector(".fig-ctrl-led");
const N = D.segs.length;

// Colores de la app (config.json): #00FF00 y #FF0000, suavizados para la escena.
const HUE = LIGHT
  ? { green: [0.12, 0.78, 0.36], red: [0.98, 0.13, 0.17] }
  : { green: [0.16, 1.0, 0.42], red: [1.12, 0.1, 0.13] };
const css = (rgb, k = 1) => `rgb(${rgb.map((v) => Math.round(Math.min(1, v * k) * 255)).join(",")})`;
const company = (symbol) => D.portfolio.find((item) => item.symbol === symbol);
const toneOf = (item) => (item.change < 0 ? "red" : "green");
const nameOf = (item) => (item.symbol === "AVG" ? (ES ? "Media" : "Average") : item.symbol);

let order = D.portfolio.map((item) => item.symbol);
// Cada segmento muestra un color puro; al cambiar, se atenúa, se repinta y vuelve (sin mezclas rojo-verde).
const seg = Array.from({ length: N }, () => ({ shown: null, target: null, fade: { x: 0, v: 0 }, level: { x: 0, v: 0 }, due: 0, flash: null, pulse: -9, hover: 0 }));
let clock = 0;

function ownersOf(list) {
  const owners = [];
  for (const symbol of list) for (let i = 0; i < company(symbol).segments; i++) owners.push(symbol);
  return owners;
}
let owners = ownersOf(order);

// Un cambio de reparto viaja por la tira desde el controlador, segmento a segmento.
function assign(stagger = 0.045) {
  owners = ownersOf(order);
  owners.forEach((symbol, index) => {
    const next = HUE[toneOf(company(symbol))];
    const s = seg[index];
    if (next !== s.target) {
      s.target = next;
      s.due = clock + (still.matches ? 0 : index * stagger);
    }
  });
  pulseController();
  run();
}

let ctrlAge = 9;
function pulseController() { ctrlAge = 0; }

// Destellos: N parpadeos de 0,5 s apagado y 0,5 s encendido, como la app (1 % = 1 s de luz).
function play(symbol, { user = false, soft = false } = {}) {
  const item = company(symbol);
  const blinks = Math.max(1, Math.min(5, Math.floor(Math.abs(item.change)) || 1));
  owners.forEach((owner, index) => { if (owner !== symbol) return; if (soft) seg[index].pulse = clock; else seg[index].flash = { start: clock + 0.02, blinks }; });
  pulseController();
  const indices = owners.flatMap((owner, index) => (owner === symbol ? [index] : []));
  const range = indices.length > 1 ? `${String(indices[0]).padStart(2, "0")}–${String(indices.at(-1)).padStart(2, "0")}` : String(indices[0]).padStart(2, "0");
  const colour = toneOf(item) === "red" ? (ES ? "rojo" : "red") : (ES ? "verde" : "green");
  status.textContent = `${item.name}: ${ES ? "segmentos" : "segments"} ${range}, ${colour}.`;
  const key = keyRow.querySelector(`[data-symbol="${symbol}"]`);
  key.classList.remove("is-struck");
  void key.offsetWidth;
  key.classList.add("is-struck");
  if (user) chime(order.indexOf(symbol));
  run();
}

// Mazo de xilófono: escala pentatónica, solo cuando toca una persona.
let audio = null;
function chime(position) {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const steps = [0, 2, 4, 7, 9];
    const semis = steps[position % 5] + 12 * Math.floor(position / 5);
    const f = 523.25 * Math.pow(2, semis / 12);
    const now = audio.currentTime;
    for (const [mult, gain, decay] of [[1, 0.09, 0.9], [3.9, 0.025, 0.18]]) {
      const osc = audio.createOscillator();
      const amp = audio.createGain();
      osc.type = "sine";
      osc.frequency.value = f * mult;
      amp.gain.setValueAtTime(0.0001, now);
      amp.gain.exponentialRampToValueAtTime(gain, now + 0.008);
      amp.gain.exponentialRampToValueAtTime(0.0001, now + decay);
      osc.connect(amp).connect(audio.destination);
      osc.start(now);
      osc.stop(now + decay + 0.05);
    }
  } catch { /* sin audio */ }
}

// ---------- WebGL: la luz de cada segmento sobre paredes y suelo ----------
const FRAGMENT = `
#define NBOX ${D.boxes.length}
#define NCYL ${D.cyls.length}
uniform vec3 uSeg[15];
uniform vec3 uSegC[15];
uniform vec3 uRoom;
uniform vec3 uStrip;
uniform float uLight;
uniform float uPass;
uniform vec3 uBoxA[NBOX];
uniform vec3 uBoxB[NBOX];
uniform vec3 uCylA[NCYL];
uniform vec3 uCylB[NCYL];
uniform vec4 uSph[5];
const float SEGL=33.;
vec3 axisOf(int i){return i<8?vec3(0.,1.,0.):vec3(1.,0.,0.);}
vec3 lightAt(vec3 p,vec3 n){
  vec3 sum=vec3(0.);
  for(int i=0;i<15;i++){
    vec3 ax=axisOf(i);
    vec3 ns=i<8?vec3(1.,0.,0.):vec3(0.,1.,0.);
    vec3 c=uSegC[i];
    float t=clamp(dot(p-c,ax),-SEGL*.5,SEGL*.5);
    vec3 d=c+ax*t-p;
    float r2=dot(d,d);
    vec3 dir=d*inversesqrt(r2+1.);
    float lobe=.3+.7*max(-dot(dir,ns),0.);
    float face=.22+max(dot(n,dir),0.);
    float below=smoothstep(uStrip.x+uStrip.y+6.,uStrip.x-2.,p.z);
    float r=sqrt(r2);
    sum+=uSeg[i]*lobe*face*mix(.4,1.,below)*3.4*exp(-r/95.)/(1.+r2/700.);
  }
  return sum;
}
float segDist(vec2 vb,vec3 c,vec3 ax){vec2 a=project(c-ax*SEGL*.5);vec2 b=project(c+ax*SEGL*.5);vec2 ab=b-a;float h=clamp(dot(vb-a,ab)/dot(ab,ab),0.,1.);return length(vb-a-ab*h)/uK;}
// Rayo del píxel hacia la escena y su primer impacto con un mueble.
float boxHit(vec3 o,vec3 d,vec3 a,vec3 b,out vec3 n){
  vec3 inv=1./d;vec3 t0=(a-o)*inv;vec3 t1=(b-o)*inv;vec3 lo=min(t0,t1);vec3 hi=max(t0,t1);
  float tn=max(max(lo.x,lo.y),lo.z);float tf=min(min(hi.x,hi.y),hi.z);
  n=lo.x>=lo.y&&lo.x>=lo.z?vec3(-sign(d.x),0.,0.):lo.y>=lo.z?vec3(0.,-sign(d.y),0.):vec3(0.,0.,-sign(d.z));
  return tn<=tf&&tn>0.?tn:1e9;
}
// Tronco de cono vertical (pantalla, maceta, puf): lateral y tapa superior.
float cylHit(vec3 o,vec3 d,vec3 a,vec3 b,out vec3 n){
  float best=1e9;
  vec2 q=o.xy-a.xy;
  float z0=b.y;float z1=b.z;float r0=a.z;float r1=b.x;
  float s=(r1-r0)/(z1-z0);
  float rz0=r0-s*z0;
  float A=dot(d.xy,d.xy)-s*s*d.z*d.z;
  float B=2.*(dot(q,d.xy)-s*d.z*(rz0+s*o.z));
  float C=dot(q,q)-(rz0+s*o.z)*(rz0+s*o.z);
  float h=B*B-4.*A*C;
  if(h>0.){
    float t=(-B-sqrt(h))/(2.*A);
    float z=o.z+d.z*t;
    if(t>0.&&z>z0&&z<z1){best=t;vec3 pt=o+d*t;n=normalize(vec3(pt.xy-a.xy,-s*(rz0+s*pt.z)));}
  }
  float tc=(z1-o.z)/d.z;
  vec3 pc=o+d*tc;
  if(tc>0.&&tc<best&&length(pc.xy-a.xy)<r1){best=tc;n=vec3(0.,0.,1.);}
  return best;
}
float sphHit(vec3 o,vec3 d,vec4 s){vec3 q=o-s.xyz;float b=dot(q,d);float c=dot(q,q)-s.w*s.w;float h=b*b-c;return h>0.?-b-sqrt(h):1e9;}
vec4 inkFor(vec3 seen,float cover){vec3 absorbed=1.-seen;float a=max(max(absorbed.r,max(absorbed.g,absorbed.b)),cover);return vec4(vec3(a)-absorbed,a);}
void main(){
  vec2 vb=viewOf(gl_FragCoord.xy);
  float soft=.7*pixelOf();
  vec3 V=towardViewer();
  vec3 pA=onWallX(vb,0.);
  vec3 pB=onWallY(vb,0.);
  vec3 pF=onFloor(vb,0.);
  float mA=window(pA.y,0.,uRoom.y,soft)*window(pA.z,0.,uRoom.z,soft);
  float mB=window(pB.x,0.,uRoom.x,soft)*window(pB.z,0.,uRoom.z,soft);
  float mF=window(pF.x,0.,uRoom.x,soft)*window(pF.y,0.,uRoom.y,soft);
  float dA=mA>0.?dot(pA,V):-1e5;
  float dB=mB>0.?dot(pB,V):-1e5;
  float dF=mF>0.?dot(pF,V):-1e5;
  vec3 e=vec3(0.);
  vec3 glow=vec3(0.);
  if(uPass<.5){
    float m=0.;
    if(dF>=dA&&dF>=dB&&mF>0.){e=lightAt(pF,vec3(0.,0.,1.))*.6;m=mF;}
    else if(dA>=dB&&mA>0.){e=lightAt(pA,vec3(1.,0.,0.));m=mA;}
    else if(mB>0.){e=lightAt(pB,vec3(0.,1.,0.));m=mB;}
    e*=m;
    // Brillo del difusor: distancia del rayo de este píxel a cada segmento.
    for(int i=0;i<15;i++){float d=segDist(vb,uSegC[i],axisOf(i));glow+=uSeg[i]*(exp(-d*d/16.)*.9+exp(-d*d/180.)*.25);}
  }else{
    vec3 o=rayOf(vb)+V*900.;
    vec3 dir=-V;
    float best=1e9;vec3 n=vec3(0.,0.,1.);
    for(int i=0;i<NBOX;i++){vec3 nb;float t=boxHit(o,dir,uBoxA[i],uBoxB[i],nb);if(t<best){best=t;n=nb;}}
    for(int i=0;i<NCYL;i++){vec3 nc;float t=cylHit(o,dir,uCylA[i],uCylB[i],nc);if(t<best){best=t;n=nc;}}
    for(int i=0;i<5;i++){float t=sphHit(o,dir,uSph[i]);if(t<best){best=t;n=normalize(o+dir*t-uSph[i].xyz);}}
    if(best<1e8)e=lightAt(o+dir*best,n)*.8;
  }
  if(uLight<.5){
    vec3 col=tonemap(e+glow,1.05);
    float a=max(col.r,max(col.g,col.b));
    float n=(hash12(gl_FragCoord.xy+fract(uTime*.61)*91.)+hash12(gl_FragCoord.yx*1.37+fract(uTime*.37)*57.)-1.)/255.;
    col=max(col+n*smoothstep(0.,1.5/255.,a),0.);
    gl_FragColor=vec4(col,max(col.r,max(col.g,col.b)));
  }else{
    vec3 lit=e*.9+glow;
    float energy=max(lit.r,max(lit.g,lit.b));
    vec3 hue=lit/max(energy,1e-4);
    float a=.8*(1.-exp(-2.8*energy));
    vec3 seen=mix(vec3(1.),mix(hue,vec3(1.),.1),a);
    vec4 ink=inkFor(seen,0.);
    ink.rgb=min(ink.rgb,vec3(ink.a));
    float n=(hash12(gl_FragCoord.xy+fract(uTime*.61)*91.)-.5)/255.;
    gl_FragColor=max(ink+n*smoothstep(0.,1.5/255.,ink.a),0.);
  }
}`;

const centres = new Float32Array(D.segs.flatMap((s) => s.centre));
const fixed = {
  uSegC: centres, uRoom: D.room, uStrip: D.strip, uLight: LIGHT,
  uBoxA: new Float32Array(D.boxes.flatMap((b) => b.slice(0, 3))), uBoxB: new Float32Array(D.boxes.flatMap((b) => b.slice(3))),
  uSph: new Float32Array(D.spheres.flat()),
  uCylA: new Float32Array(D.cyls.flatMap(([x, y, r0]) => [x, y, r0])), uCylB: new Float32Array(D.cyls.flatMap(([, , , r1, z0, z1]) => [r1, z0, z1])),
};
const [roomCanvas, furnitureCanvas] = root.querySelectorAll(".fig-gl");
const layer = glLayer({ canvas: roomCanvas, fragment: FRAGMENT, view: [D.W, D.H], camera: D.camera, uniforms: ["uSeg"], fixed: { ...fixed, uPass: 0 } });
const layer2 = layer && glLayer({ canvas: furnitureCanvas, fragment: FRAGMENT, view: [D.W, D.H], camera: D.camera, uniforms: ["uSeg"], fixed: { ...fixed, uPass: 1 } });
if (layer) root.setAttribute("data-gl", "");
const segData = new Float32Array(N * 3);

// ---------- Bucle ----------
let frame = 0, last = 0, visible = false;
// Destellos como la app: N ciclos de 0,5 s apagado y 0,5 s encendido, sin pasar del brillo normal.
function levelOf(s) {
  const pulse = clock - s.pulse;
  let level = 1 + s.hover * 0.3 + (pulse >= 0 && pulse < 1.2 ? 0.45 * Math.sin(Math.PI * pulse / 1.2) ** 2 : 0);
  if (!s.flash) return level;
  const age = clock - s.flash.start;
  if (age < 0) return level;
  const cycle = Math.floor(age);
  if (cycle >= s.flash.blinks) { s.flash = null; return level; }
  return age - cycle < 0.5 ? 0.05 : level;
}
function tick(now) {
  const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
  last = now;
  const calm = still.matches;
  clock += dt;
  ctrlAge += dt;
  let moving = false;
  seg.forEach((s, index) => {
    // Repintado: baja a oscuro, cambia de color y vuelve a subir.
    let fadeTarget = 1;
    if (s.target && s.shown !== s.target) {
      if (clock < s.due) moving = true;
      else if (!s.shown || s.fade.x < 0.04 || calm) { s.shown = s.target; }
      else fadeTarget = 0;
    }
    if (!s.shown) fadeTarget = 0;
    moving = settle(s.fade, fadeTarget, dt, 0.09, calm) || moving;
    const want = levelOf(s);
    moving = settle(s.level, want, dt, s.flash ? 0.045 : 0.14, calm) || moving;
    if (s.flash || clock - s.pulse < 1.2) moving = true;
    const lv = Math.max(0, Math.min(1.5, s.level.x * Math.max(0, s.fade.x)));
    const rgb = s.shown || [0, 0, 0];
    segData.set(rgb.map((v) => v * lv), index * 3);
    const shown = LIGHT ? css(rgb.map((v) => 1 - (1 - v) * Math.min(1, lv))) : css(rgb, Math.min(1.25, 0.12 + lv));
    leds[index].style.fill = shown;
    minis[index].style.fill = shown;
    washes[index].setAttribute("fill", `url(#fig-wash-${rgb[0] > rgb[1] ? "red" : "green"})`);
    washes[index].style.opacity = Math.min(1, lv * 0.8).toFixed(3);
  });
  const blink = Math.max(0, 1 - ctrlAge / 0.35);
  ctrlLed.style.opacity = (0.35 + 0.65 * blink).toFixed(2);
  if (blink > 0) moving = true;
  if (layer) layer.draw({ uSeg: segData }, calm ? 0.8 : clock);
  if (layer2) layer2.draw({ uSeg: segData }, calm ? 0.8 : clock);
  frame = visible && (moving || dragging) ? requestAnimationFrame(tick) : 0;
}
function run() { if (!frame && visible) { last = 0; frame = requestAnimationFrame(tick); } }
new IntersectionObserver((entries) => { visible = entries[entries.length - 1].isIntersecting; if (visible) run(); }, { rootMargin: "120px 0px" }).observe(root);
addEventListener("resize", run);

// ---------- Teclas: tocar y reordenar ----------
const keyEls = () => [...keyRow.querySelectorAll(".fig-key")];
function flip(mutate) {
  const before = new Map(keyEls().map((el) => [el, [el.offsetLeft, el.offsetTop]]));
  mutate();
  for (const el of keyEls()) {
    if (el === dragKey) continue;
    const dx = before.get(el)[0] - el.offsetLeft;
    const dy = before.get(el)[1] - el.offsetTop;
    if ((!dx && !dy) || still.matches) continue;
    el.style.transition = "none";
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => { el.style.transition = ""; el.style.transform = ""; });
  }
}
function applyOrder() {
  flip(() => order.forEach((symbol) => keyRow.append(keyRow.querySelector(`[data-symbol="${symbol}"]`))));
  assign();
}

let dragKey = null, dragging = false, startX = 0, grab = 0, moved = false;
let grabY = 0, startY = 0;
keyRow.addEventListener("pointerdown", (event) => {
  const key = event.target.closest(".fig-key");
  if (!key || event.button > 0) return;
  takeOver();
  dragKey = key;
  moved = false;
  startX = event.clientX;
  startY = event.clientY;
  const box = key.getBoundingClientRect();
  grab = event.clientX - box.left;
  grabY = event.clientY - box.top;
  key.setPointerCapture(event.pointerId);
});
keyRow.addEventListener("pointermove", (event) => {
  if (!dragKey) return;
  if (!moved && Math.hypot(event.clientX - startX, event.clientY - startY) < 6) return;
  if (!moved) { moved = true; dragging = true; dragKey.classList.add("is-dragging"); run(); }
  const row = keyRow.getBoundingClientRect();
  const left = event.clientX - row.left - grab;
  const top = event.clientY - row.top - grabY;
  const cx = left + dragKey.offsetWidth / 2;
  const cy = top + dragKey.offsetHeight / 2;
  const keys = keyEls();
  const index = keys.indexOf(dragKey);
  // La tecla cae en el hueco cuyo centro está más cerca del puntero.
  let target = index, best = Infinity;
  keys.forEach((el, i) => {
    const d = Math.hypot(el.offsetLeft + el.offsetWidth / 2 - cx, el.offsetTop + el.offsetHeight / 2 - cy);
    if (d < best) { best = d; target = i; }
  });
  if (target !== index && best < dragKey.offsetWidth * 0.7) {
    const symbol = dragKey.dataset.symbol;
    order.splice(index, 1);
    order.splice(target, 0, symbol);
    applyOrder();
  }
  dragKey.style.transform = `translate(${(left - dragKey.offsetLeft).toFixed(1)}px, ${(top - dragKey.offsetTop).toFixed(1)}px)`;
});
function endDrag(event) {
  if (!dragKey) return;
  const key = dragKey;
  dragKey = null;
  dragging = false;
  key.classList.remove("is-dragging");
  key.style.transform = "";
  if (!moved && event.type === "pointerup") play(key.dataset.symbol, { user: true });
  else if (moved) { status.textContent = `${nameOf(company(key.dataset.symbol))} → ${ES ? "posición" : "position"} ${order.indexOf(key.dataset.symbol) + 1}`; play(key.dataset.symbol); }
}
keyRow.addEventListener("pointerup", endDrag);
keyRow.addEventListener("pointercancel", endDrag);
keyRow.addEventListener("keydown", (event) => {
  const key = event.target.closest(".fig-key");
  if (!key) return;
  takeOver();
  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); play(key.dataset.symbol, { user: true }); return; }
  if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    event.preventDefault();
    const index = order.indexOf(key.dataset.symbol);
    const target = index + (event.key === "ArrowLeft" ? -1 : 1);
    if (target < 0 || target >= order.length) return;
    order.splice(index, 1);
    order.splice(target, 0, key.dataset.symbol);
    applyOrder();
    key.focus();
    play(key.dataset.symbol);
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    const keys = keyEls();
    keys[(keys.indexOf(key) + (event.key === "ArrowLeft" ? keys.length - 1 : 1)) % keys.length].focus();
  }
});
const hover = (symbol, on) => owners.forEach((owner, index) => { if (owner === symbol) seg[index].hover = on ? 1 : 0; });
keyRow.addEventListener("pointerover", (event) => { const key = event.target.closest(".fig-key"); if (key) { hover(key.dataset.symbol, true); run(); } });
keyRow.addEventListener("pointerout", (event) => { const key = event.target.closest(".fig-key"); if (key) { hover(key.dataset.symbol, false); run(); } });

// ---------- Recorrido automático ----------
let touring = !still.matches, tourStep = 0, tourTimer = 0, idleTimer = 0;
function tour() {
  if (!touring) return;
  // El recorrido solo ilumina las teclas una a una; el orden lo cambia únicamente quien las arrastra.
  play(order[tourStep % order.length], { soft: true });
  tourStep++;
  tourTimer = setTimeout(tour, 2100);
}
function takeOver() {
  touring = false;
  clearTimeout(tourTimer);
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (still.matches) return; touring = true; tour(); }, 12000);
}

// Primera luz: la tira se enciende desde el controlador.
assign(still.matches ? 0 : 0.07);
if (touring) tourTimer = setTimeout(tour, 1800);
