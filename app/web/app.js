const $ = (selector) => document.querySelector(selector);
function setAppAlert(id, message, title, retry = false) {
  const card = document.getElementById(id);
  const copy = card.querySelector('p');
  if (copy.textContent !== message) copy.textContent = message;
  card.hidden = !message;
  const heading = card.querySelector('strong');
  if (heading && heading.textContent !== title) heading.textContent = title;
  const button = card.querySelector('button');
  if (button) button.hidden = !retry;
}

function setInlineStatus(id, message, tone = 'error') {
  const node = document.getElementById(id);
  if (node.textContent !== message) node.textContent = message;
  node.classList.toggle('is-success', Boolean(message) && tone === 'success');
  node.classList.toggle('is-error', Boolean(message) && tone === 'error');
  node.classList.toggle('is-pending', Boolean(message) && tone === 'pending');
}
const PORTFOLIO_SYMBOL = 'PORTFOLIO';
const intro = $('.intro');
const scene = $('.intro-scene');
const powerButton = $('#power-button');
const nativeDevice = Boolean(window.AndroidBridge || window.webkit?.messageHandlers?.iosBridge);
const quoteList = $('#quote-list');
const lightStage = $('.light-stage');
const stripDots = [...document.querySelectorAll('.light-ticks i')];
const stripHitboxes = $('#strip-hitboxes');
const overlay = $('#detail-overlay');
const portfolioOverlay = $('#portfolio-overlay');
let state = null;
let powerConnecting = false;
let portfolioDraft = [];
let portfolioOriginal = '';
let portfolioRevision = null;
let selectedPortfolioSymbol = null;
let portfolioPreviousFocus = null;
let portfolioSaving = false;
let searchSequence = 0;
let searchTimer = null;
let selectedSymbol = null;
let previousFocus = null;
let scrollQueued = false;
let stripActiveSegment = null;
let stripPinnedSegment = null;
let selectedRange = '1D';
let currentPoints = [];
let chartView = null;
let showMA = false;
let showDividends = false;
let currentEvents = null;
let eventsRequest = 0;
let eventsError = null;
let lastExaminedTime = null;
let pinnedTime = null;
let suppressChartClick = false;
let drawMode = false;
let annotations = [];
let selectedAnnotation = null;
let activeDrag = null;
let historyRequest = 0;
let lastChartKey = '';
let rangeLoading = false;
let displayedScroll = 0;
let introGeometry = null;
let introCompleted = false;
let resizeFrame = null;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const revealObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    entry.target.classList.add('is-revealed');
    if (entry.target.classList.contains('quote-row')) {
      setTimeout(() => entry.target.classList.add('has-arrived'), 1800);
    }
    revealObserver.unobserve(entry.target);
  }
}, { threshold: .12 });

const money = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'always' });
const dateTime = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const hour = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' });
const date = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
const shortDate = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: '2-digit' });
const rangeLabels = { '1M': 'Último mes', '6M': 'Últimos 6 meses', '1Y': 'Último año', '5Y': 'Últimos 5 años' };
const svgNS = 'http://www.w3.org/2000/svg';
const quickPicks = [
  ['NVDA', 'NVIDIA'], ['MSFT', 'Microsoft'], ['META', 'Meta'], ['TSLA', 'Tesla'],
  ['AAPL', 'Apple'], ['AMZN', 'Amazon'], ['GOOGL', 'Alphabet'], ['AMD', 'AMD'],
  ['NFLX', 'Netflix'], ['JPM', 'JPMorgan'], ['KO', 'Coca-Cola'],
].map(([symbol, name]) => ({ symbol, name, market: 'US', exchange: ['JPM', 'KO'].includes(symbol) ? 'NYSE' : 'NASDAQ' }));

function svg(tag, attributes = {}) {
  const node = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function colorFor(quote) {
  return quote.change_pct < 0 ? '#d26870' : '#43986a';
}

function chartColor(quote, points) {
  if (selectedRange === '1D' || points.length < 2) return colorFor(quote);
  return points[points.length - 1].price < points[0].price ? '#d26870' : '#43986a';
}

function percentText(value) {
  return value === null || value === undefined ? '—' : `${percent.format(value)}%`;
}

function priceText(quote) {
  return quote.price === null || quote.price === undefined ? '—' : money.format(quote.price);
}

function reachedTarget(symbol) {
  return state?.pro?.targets?.[symbol]?.hit || null;
}

function renderPeriodValue(quote) {
  const intraday = selectedRange === '1D';
  const points = intraday || rangeLoading ? [] : (currentPoints || []).filter((point) => Number.isFinite(point.price));
  const first = points[0]?.price;
  const last = points.at(-1)?.price;
  const changeValue = intraday ? quote.change_pct
    : points.length >= 2 && first > 0 ? (last / first - 1) * 100 : null;
  $('.price-caption').textContent = quote.symbol === PORTFOLIO_SYMBOL ? 'ÍNDICE BASE 100' : intraday ? 'ÚLTIMO PRECIO' : 'ÚLTIMO CIERRE';
  $('#detail-price').textContent = intraday ? priceText(quote) : Number.isFinite(last) ? money.format(last) : '—';
  $('#detail-change').textContent = percentText(changeValue);
  $('#detail-change').classList.toggle('is-negative', changeValue < 0);
  $('#detail-change-basis').textContent = intraday ? 'Respecto al cierre anterior' : 'Desde el primer cierre';
}

function showStripPreview(index) {
  if (!state) return;
  stripActiveSegment = index;
  const quote = state.quotes.find((item) => item.segments.includes(index));
  const hasChange = quote?.change_pct !== null && quote?.change_pct !== undefined;
  const hit = quote ? reachedTarget(quote.symbol) : null;
  const color = hit || (hasChange ? (quote.change_pct < 0 ? 'red' : 'green') : null);
  $('#strip-name').textContent = quote ? `${quote.name} · ${quote.symbol === PORTFOLIO_SYMBOL ? 'Media' : quote.symbol}` : `Segmento ${index}`;
  $('#strip-change').textContent = hasChange ? percentText(quote.change_pct) : '—';
  $('#strip-color').textContent = color === 'sell' ? 'OBJETIVO' : color === 'stop' ? 'STOP' : color === 'red' ? 'ROJO' : color === 'green' ? 'VERDE' : 'SIN DATOS';
  for (const node of [$('#strip-change'), $('#strip-color')]) {
    node.classList.toggle('is-red', color === 'red');
    node.classList.toggle('is-green', color === 'green');
    node.classList.toggle('is-sell', color === 'sell');
    node.classList.toggle('is-stop', color === 'stop');
  }
  stripDots.forEach((dot, dotIndex) => dot.classList.toggle('is-linked', quote ? quote.segments.includes(dotIndex) : dotIndex === index));
  lightStage.classList.add('is-inspecting');
  $('#strip-readout').classList.add('is-visible');
}

function clearStripPreview() {
  stripActiveSegment = null;
  lightStage.classList.remove('is-inspecting');
  stripDots.forEach((dot) => dot.classList.remove('is-linked'));
  $('#strip-readout').classList.remove('is-visible');
}

function initializeStripPreview() {
  for (let index = 0; index < 15; index += 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.tabIndex = -1;
    button.dataset.segment = String(index);
    button.setAttribute('aria-label', `Segmento ${index}`);
    button.addEventListener('pointerenter', (event) => {
      if (event.pointerType === 'mouse') showStripPreview(index);
    });
    button.addEventListener('focus', () => showStripPreview(index));
    button.addEventListener('click', (event) => {
      if (event.detail === 0 || matchMedia('(hover: none)').matches) {
        stripPinnedSegment = stripPinnedSegment === index ? null : index;
        if (stripPinnedSegment === null) clearStripPreview();
        else showStripPreview(index);
      } else showStripPreview(index);
    });
    stripHitboxes.append(button);
  }
  lightStage.addEventListener('pointerleave', () => {
    if (stripPinnedSegment === null) clearStripPreview();
  });
  stripHitboxes.addEventListener('focusout', (event) => {
    if (!stripHitboxes.contains(event.relatedTarget) && stripPinnedSegment === null) clearStripPreview();
  });
  document.addEventListener('pointerdown', (event) => {
    if (stripPinnedSegment !== null && !lightStage.contains(event.target)) {
      stripPinnedSegment = null;
      clearStripPreview();
    }
  });
}

function plot(points, width, height, padding = 3, includeMA = false) {
  const valid = (points || []).filter((point) => Number.isFinite(point.price));
  if (valid.length < 2) return null;
  const values = valid.map((point) => point.price);
  if (includeMA) values.push(...valid.map((point) => point.ma200).filter(Number.isFinite));
  const low = Math.min(...values);
  const high = Math.max(...values);
  const range = Math.max(high - low, Math.abs(high) * .002, .01);
  const floor = low - range * .11;
  const ceiling = high + range * .11;
  const coordinates = valid.map((point, index) => [
    padding + index * (width - 2 * padding) / (valid.length - 1),
    padding + (ceiling - point.price) * (height - 2 * padding) / (ceiling - floor),
  ]);
  return { valid, coordinates, path: coordinates.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' '), floor, ceiling };
}

function miniChart(quote) {
  const chart = svg('svg', { class: 'mini-chart', viewBox: '0 0 220 54', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const data = plot(quote.points, 220, 54, 2);
  if (!data) return chart;
  const color = colorFor(quote);
  chart.append(svg('path', { d: `${data.path} L218,52 L2,52 Z`, fill: color, opacity: '.09' }));
  chart.append(svg('path', { class: 'spark-line', pathLength: 1, d: data.path, fill: 'none', stroke: color, 'stroke-width': '1.6', 'vector-effect': 'non-scaling-stroke', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  return chart;
}

function animateQuoteValue(node) {
  if (reducedMotion.matches || !node.animate) return;
  node.animate([
    { opacity: .55, transform: 'translateY(5px)' },
    { opacity: 1, transform: 'translateY(0)' },
  ], { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' });
}

function renderQuotes() {
  if (!state) return;
  stripDots.forEach((dot) => { dot.classList.remove('is-red', 'is-green', 'is-sell', 'is-stop'); });
  for (const button of stripHitboxes.children) {
    const index = Number(button.dataset.segment);
    const quote = state.quotes.find((item) => item.segments.includes(index));
    const change = quote?.change_pct;
    button.setAttribute('aria-label', quote
      ? `Segmento ${index}: ${quote.name}, ${percentText(change)}, ${reachedTarget(quote.symbol) === 'sell' ? 'objetivo alcanzado' : reachedTarget(quote.symbol) === 'stop' ? 'stop alcanzado' : change == null ? 'sin datos' : change < 0 ? 'rojo' : 'verde'}`
      : `Segmento ${index}: libre`);
  }
  for (const quote of state.quotes) {
    const hit = reachedTarget(quote.symbol);
    if (!hit && (quote.change_pct === null || quote.change_pct === undefined)) continue;
    for (const segment of quote.segments) {
      stripDots[segment]?.classList.add(hit ? `is-${hit}` : quote.change_pct < 0 ? 'is-red' : 'is-green');
    }
  }
  if (stripActiveSegment !== null) showStripPreview(stripActiveSegment);
  const positive = state.quotes.filter((quote) => quote.symbol !== PORTFOLIO_SYMBOL && quote.change_pct != null && quote.change_pct > 0).length;
  const negative = state.quotes.filter((quote) => quote.symbol !== PORTFOLIO_SYMBOL && quote.change_pct != null && quote.change_pct < 0).length;
  const breadth = $('#market-breadth');
  breadth.replaceChildren();
  for (const [label, className] of [[`${positive} suben`, 'is-positive'], [`${negative} bajan`, 'is-negative']]) {
    const item = Object.assign(document.createElement('span'), { className });
    if (className) item.append(document.createElement('i'));
    item.append(document.createTextNode(label));
    breadth.append(item);
  }
  const currentRows = new Map([...quoteList.children].map((row) => [row.dataset.symbol, row]));
  for (const [index, quote] of state.quotes.entries()) {
    let row = currentRows.get(quote.symbol);
    if (!row) {
      row = document.createElement('button');
      row.type = 'button';
      row.className = 'quote-row reveal-ready';
      row.dataset.symbol = quote.symbol;
      row.style.setProperty('--row-delay', `${(index % 5) * 65}ms`);
      const identity = document.createElement('span');
      identity.className = 'quote-identity';
      identity.append(Object.assign(document.createElement('span'), { className: 'quote-order', textContent: String(index + 1).padStart(2, '0') }));
      identity.append(Object.assign(document.createElement('span'), { className: 'quote-symbol' }));
      identity.append(Object.assign(document.createElement('span'), { className: 'quote-name' }));
      identity.append(Object.assign(document.createElement('span'), { className: 'quote-target', hidden: true }));
      const numbers = document.createElement('span');
      numbers.className = 'quote-numbers';
      numbers.append(Object.assign(document.createElement('span'), { className: 'quote-price' }));
      numbers.append(Object.assign(document.createElement('span'), { className: 'quote-currency' }));
      numbers.append(Object.assign(document.createElement('span'), { className: 'change-pill' }));
      const arrow = Object.assign(document.createElement('span'), { className: 'quote-arrow' });
      arrow.setAttribute('aria-hidden', 'true');
      arrow.innerHTML = '<svg viewBox="0 0 20 20"><path d="M4 10h11m-4-4 4 4-4 4"/></svg>';
      row.append(identity, miniChart(quote), numbers, arrow);
      row.addEventListener('click', () => openDetail(row.dataset.symbol));
      revealObserver.observe(row);
    }
    row.querySelector('.quote-order').textContent = String(index + 1).padStart(2, '0');
    row.querySelector('.quote-symbol').textContent = quote.symbol === PORTFOLIO_SYMBOL ? 'MEDIA' : quote.symbol;
    row.querySelector('.quote-name').textContent = quote.name;
    const hit = reachedTarget(quote.symbol);
    const targetMark = row.querySelector('.quote-target');
    targetMark.hidden = !hit;
    targetMark.textContent = hit === 'stop' ? 'STOP' : 'OBJETIVO';
    targetMark.classList.toggle('is-stop', hit === 'stop');
    row.classList.toggle('is-average', quote.symbol === PORTFOLIO_SYMBOL);
    const priceNode = row.querySelector('.quote-price');
    const nextPrice = priceText(quote);
    const nextChange = percentText(quote.change_pct);
    const priceChanged = row.dataset.rendered === 'true' && priceNode.textContent !== nextPrice;
    const changeChanged = row.dataset.rendered === 'true' && row.querySelector('.change-pill').textContent !== nextChange;
    priceNode.textContent = nextPrice;
    row.querySelector('.quote-currency').textContent = quote.currency;
    const badge = row.querySelector('.change-pill');
    badge.textContent = nextChange;
    badge.classList.toggle('is-negative', quote.change_pct < 0);
    badge.classList.toggle('is-empty', quote.change_pct === null || quote.change_pct === undefined);
    if (priceChanged) animateQuoteValue(priceNode);
    if (changeChanged) animateQuoteValue(badge);
    row.dataset.rendered = 'true';
    row.classList.toggle('is-empty', quote.price === null || quote.price === undefined);
    row.classList.toggle('is-selected', quote.symbol === selectedSymbol);
    row.classList.toggle('is-stale', Boolean(quote.stale && quote.price != null));
    row.setAttribute('aria-label', quote.symbol === PORTFOLIO_SYMBOL
      ? `Media de la cartera, índice ${priceText(quote)}, ${percentText(quote.change_pct)}. Ver gráfico`
      : `${quote.name}, ${quote.symbol}, ${priceText(quote)} ${quote.currency}, ${percentText(quote.change_pct)}. Ver gráfico`);
    const averageKey = quote.symbol === PORTFOLIO_SYMBOL ? JSON.stringify(state.pro?.average) : '';
    const chartKey = `${quote.asof}:${quote.price}:${quote.points?.length}:${averageKey}`;
    if (row.dataset.chartKey !== chartKey) {
      row.replaceChild(miniChart(quote), row.querySelector('.mini-chart'));
      row.dataset.chartKey = chartKey;
    }
    if (quoteList.children[index] !== row) quoteList.insertBefore(row, quoteList.children[index] || null);
    currentRows.delete(quote.symbol);
  }
  for (const row of currentRows.values()) row.remove();
  const stamp = state.last_fetch ? hour.format(new Date(state.last_fetch)) : null;
  $('#market-timestamp').textContent = stamp ? `Actualizada ${stamp}` : 'Actualizando…';
  setAppAlert('market-alert', state.market_error || '', 'Datos parciales');
}

// Estado de la conexión Bluetooth: mismo código en las dos versiones de idioma.
const uiLanguage = document.documentElement.lang === 'en' ? 'en' : 'es';
const connectionCopy = {
  es: {
    searching: (model) => `Buscando tiras ${model} cerca…`,
    connecting: (name) => `Conectando con ${name}…`,
    confirming: 'Comprobando el estado de la tira…',
    ready: (name) => `Conectada · ${name}`,
    error: 'Sin conexión',
    errorRetry: (seconds) => `Sin conexión · nuevo intento en ${seconds} s`,
    retrying: 'Sin conexión · reintentando…',
    offline: 'El servidor local no responde',
    wordConnecting: 'conectando',
    wordOffline: 'sin conexión',
    fallbackTitle: 'Conexión con la tira',
    toggleTitle: 'No se pudo cambiar la tira',
    offlineTitle: 'Conexión interrumpida',
    offlineWeb: 'La página no recibe respuesta del servidor. Comprueba que la ventana del Terminal con web_server.py sigue abierta.',
    offlineNative: 'No podemos contactar con la app. Comprueba la conexión e inténtalo de nuevo.',
    marketPaused: 'Las cotizaciones no se están actualizando. Los últimos datos visibles pueden estar desfasados.',
    marketPausedTitle: 'Actualización en pausa',
    busy: 'La tira está ocupada; espera un momento',
    errors: {
      bluetooth_off: ['El Bluetooth está desactivado', () => 'Actívalo desde el Centro de control del Mac y pulsa «Reintentar ahora».'],
      permission: ['Falta el permiso de Bluetooth', () => 'Abre Ajustes del Sistema › Privacidad y seguridad › Bluetooth, permite la app desde la que ejecutas el servidor (Terminal o VS Code) y vuelve a arrancarlo.'],
      not_found: ['No encuentro tu tira', (model) => `Comprueba que la ${model} está enchufada y a menos de 10 m. Cierra la app Govee del móvil: la tira solo acepta una conexión a la vez.`],
      timeout: ['La tira no responde', () => 'Puede que otro dispositivo la esté usando o que esté demasiado lejos. Cierra la app Govee y acércate a la tira.'],
      no_reply: ['La tira no confirma su estado', () => 'Se conectó, pero no respondió. Desenchúfala unos segundos y vuelve a intentarlo.'],
      rejected: ['La tira no cambió de estado', () => 'La orden llegó, pero la tira mantiene el estado anterior. Inténtalo de nuevo.'],
      disconnected: ['Se perdió la conexión', () => 'La tira se desconectó a mitad de la orden. Acércate y reinténtalo.'],
      unsupported: ['Bluetooth no disponible', () => 'Este equipo no tiene Bluetooth Low Energy compatible.'],
    },
  },
  en: {
    searching: (model) => `Looking for nearby ${model} strips…`,
    connecting: (name) => `Connecting to ${name}…`,
    confirming: 'Checking the strip state…',
    ready: (name) => `Connected · ${name}`,
    error: 'Not connected',
    errorRetry: (seconds) => `Not connected · retrying in ${seconds} s`,
    retrying: 'Not connected · retrying…',
    offline: 'The local server is not responding',
    wordConnecting: 'connecting',
    wordOffline: 'not connected',
    fallbackTitle: 'Strip connection',
    toggleTitle: 'Could not change the strip',
    offlineTitle: 'Connection lost',
    offlineWeb: 'The page gets no reply from the server. Make sure the Terminal window running web_server.py is still open.',
    offlineNative: 'The app cannot be reached. Check the connection and try again.',
    marketPaused: 'Quotes are not updating. The latest visible data may be out of date.',
    marketPausedTitle: 'Updates paused',
    busy: 'The strip is busy; please wait a moment',
    errors: {
      bluetooth_off: ['Bluetooth is turned off', () => 'Turn it on from the Mac Control Center, then press “Retry now”.'],
      permission: ['Bluetooth permission is missing', () => 'Open System Settings › Privacy & Security › Bluetooth, allow the app running the server (Terminal or VS Code) and start it again.'],
      not_found: ['Your strip was not found', (model) => `Make sure the ${model} is plugged in and within 10 m. Close the Govee app on your phone: the strip accepts only one connection at a time.`],
      timeout: ['The strip is not responding', () => 'Another device may be using it, or it may be too far away. Close the Govee app and move closer.'],
      no_reply: ['The strip did not confirm its state', () => 'It connected but did not reply. Unplug it for a few seconds and try again.'],
      rejected: ['The strip did not change state', () => 'The command arrived but the strip kept its previous state. Please try again.'],
      disconnected: ['Connection lost', () => 'The strip disconnected in the middle of the command. Move closer and retry.'],
      unsupported: ['Bluetooth unavailable', () => 'This computer has no compatible Bluetooth Low Energy radio.'],
    },
  },
}[uiLanguage];
const transitionalPhases = new Set(['searching', 'connecting', 'confirming']);
let serverUnreachable = false;
let retryDeadline = null;
let refreshTimer = null;

function supportsReconnect() {
  return Boolean(state && !nativeDevice && 'ble_phase' in state);
}

function friendlyDeviceName(name, model) {
  // «ihoment_H617A_1A2B» → «H617A · 1A2B», para distinguir tiras del mismo modelo.
  const match = /(H[0-9A-Z]{4,5})[_\s-]*([0-9A-F]{4})?$/i.exec(name || '');
  if (!match) return model;
  return match[2] ? `${match[1].toUpperCase()} · ${match[2].toUpperCase()}` : match[1].toUpperCase();
}

function connectionPhase() {
  if (serverUnreachable) return 'offline';
  if (!state) return 'searching';
  if (state.ble_phase) {
    if ((state.busy || powerConnecting) && !transitionalPhases.has(state.ble_phase)) return 'connecting';
    return state.ble_phase;
  }
  // Apps nativas: deducen la fase de los campos que ya publican.
  if (state.busy || powerConnecting) return 'connecting';
  if (state.ble_error) return 'error';
  return state.power_known ? 'ready' : 'searching';
}

function retrySeconds() {
  return retryDeadline === null ? null : Math.max(0, Math.ceil((retryDeadline - Date.now()) / 1000));
}

function renderConnection() {
  const phase = connectionPhase();
  const model = state?.device_model || 'H617A';
  const name = friendlyDeviceName(state?.device_name, model);
  const seconds = retrySeconds();
  const text = {
    searching: connectionCopy.searching(model),
    connecting: connectionCopy.connecting(name),
    confirming: connectionCopy.confirming,
    ready: connectionCopy.ready(name),
    error: seconds === null ? connectionCopy.error : seconds > 0 ? connectionCopy.errorRetry(seconds) : connectionCopy.retrying,
    offline: connectionCopy.offline,
  }[phase] || connectionCopy.error;
  const box = $('#connection-status');
  box.dataset.phase = phase;
  if ($('#connection-text').textContent !== text) $('#connection-text').textContent = text;
  $('#connection-change').hidden = !supportsReconnect() || !(phase === 'ready' || phase === 'error') || Boolean(state?.demo);
  powerButton.classList.toggle('is-connecting', transitionalPhases.has(phase));

  if (phase === 'offline') {
    setAppAlert('power-alert', nativeDevice ? connectionCopy.offlineNative : connectionCopy.offlineWeb, connectionCopy.offlineTitle, true);
    $('#power-forget').hidden = true;
    return;
  }
  if (phase !== 'error' || !state?.ble_error) {
    setAppAlert('power-alert', '', connectionCopy.fallbackTitle);
    $('#power-forget').hidden = true;
    return;
  }
  const known = connectionCopy.errors[state.ble_code];
  const title = known ? known[0] : connectionCopy.fallbackTitle;
  const message = known ? known[1](model) : state.ble_error;
  setAppAlert('power-alert', message, title, supportsReconnect());
  $('#power-alert').title = known ? state.ble_error : '';
  $('#power-forget').hidden = !supportsReconnect() || !['not_found', 'timeout', 'no_reply'].includes(state.ble_code);
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  let delay = 7000;
  if (transitionalPhases.has(connectionPhase()) || state?.busy || powerConnecting) delay = 1000;
  else if (serverUnreachable) delay = 3000;
  else if (retryDeadline !== null) delay = Math.max(1000, Math.min(delay, retryDeadline - Date.now() + 600));
  refreshTimer = setTimeout(refresh, delay);
}

async function requestReconnect(forget = false) {
  if (!supportsReconnect()) { refresh(); return; }
  for (const id of ['#power-retry', '#power-forget', '#connection-change']) $(id).disabled = true;
  try {
    const response = await fetch('/api/connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ forget }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || connectionCopy.busy);
    state = result;
    retryDeadline = null;
    renderPower();
  } catch (error) {
    setAppAlert('power-alert', error.message, connectionCopy.fallbackTitle, true);
  } finally {
    for (const id of ['#power-retry', '#power-forget', '#connection-change']) $(id).disabled = false;
    scheduleRefresh();
  }
}

setInterval(() => {
  if (retryDeadline !== null && connectionPhase() === 'error') renderConnection();
}, 1000);

function renderPower() {
  if (!state) return;
  const model = state.device_model || 'H617A';
  $('#device-brand').textContent = model;
  $('#device-model-label').textContent = `GOVEE ${model}`;
  $('#device-selector').hidden = !nativeDevice || Boolean(state.demo);
  if (nativeDevice && $('#device-model').value !== model) $('#device-model').value = model;
  if (state.demo) {
    scene.classList.add('is-on');
    $('#power-word').textContent = 'en vista previa';
    setAppAlert('power-alert', '', 'Conexión con la tira');
    powerButton.hidden = true;
    $('#connection-status').hidden = true;
    $('#edit-portfolio-button').hidden = true;
    return;
  }
  powerButton.hidden = false;
  $('#connection-status').hidden = false;
  $('#edit-portfolio-button').hidden = false;
  const confirmedOn = state.power_known && state.on;
  scene.classList.toggle('is-on', confirmedOn);
  const phase = connectionPhase();
  $('#power-word').textContent = !state.power_known || powerConnecting
    ? (transitionalPhases.has(phase) ? connectionCopy.wordConnecting : connectionCopy.wordOffline)
    : state.on ? 'encendida' : 'apagada';
  renderConnection();
  powerButton.disabled = powerConnecting || Boolean(state.busy);
  powerButton.setAttribute('aria-pressed', state.power_known ? String(state.on) : 'mixed');
  powerButton.setAttribute('aria-label', powerConnecting ? 'Conectando con la tira LED' : `${state.power_known ? '' : 'Intentar '}${state.on ? 'apagar' : 'encender'} tira LED`);
  renderPortfolioSpaces();
}

$('#device-model').addEventListener('change', async (event) => {
  if (!nativeDevice || !state || state.demo) return;
  const previous = state.device_model || 'H617A';
  const chosen = event.target.value;
  powerConnecting = true;
  renderPower();
  try {
    const response = await fetch('/api/device', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: chosen }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'No se pudo cambiar la tira');
    state = result;
  } catch (error) {
    event.target.value = previous;
    state.ble_error = error.message;
  } finally {
    powerConnecting = false;
    renderPower();
  }
});

let savingAlerts = false;
const proDialog = $('#pro-dialog');
const proShowcase = $('#pro-showcase');
const proOpen = $('#pro-pulse-action');
let proLevel = 2;
let proDirection = 1;
let proPreviewTimer;
let proCloseTimer;
let proPreviousOverflow = '';
const carouselDialog = $('#carousel-dialog');
let carouselItems = [];
let carouselSaving = false;
let carouselSearchSequence = 0;
let carouselSearchTimer = null;
let carouselPreviousFocus = null;
let carouselDraggingIndex = -1;
let carouselDraggedSymbol = null;
let carouselSelectedSymbol = null;
let carouselSuppressClick = false;

function stopProPreview() {
  clearTimeout(proPreviewTimer);
  proShowcase.classList.remove('is-playing');
}

function playProPreview() {
  stopProPreview();
  if (!proDialog.open || document.hidden) return;
  proShowcase.classList.toggle('is-negative', proDirection < 0);
  proShowcase.style.setProperty('--demo-pulses', proLevel);
  $('#pro-demo-value').innerHTML = `${proDirection > 0 ? '+' : '−'}${proLevel}<span>,00%</span>`;
  $('#pro-demo-duration').textContent = `${proLevel} ${proLevel === 1 ? 'segundo' : 'segundos'} de luz.`;
  $('#pro-demo').setAttribute('aria-label', `Simulación: ${proDirection > 0 ? 'subida' : 'bajada'} del ${proLevel}%, destello ${proDirection > 0 ? 'verde' : 'rojo'} de ${proLevel} ${proLevel === 1 ? 'segundo' : 'segundos'}`);
  document.querySelectorAll('[data-pro-level]').forEach((button) => button.setAttribute('aria-pressed', String(Number(button.dataset.proLevel) === proLevel)));
  document.querySelectorAll('[data-pro-direction]').forEach((button) => button.setAttribute('aria-pressed', String(Number(button.dataset.proDirection) === proDirection)));
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  // Restart only the finite, local preview; it never sends a command to the strip.
  void proShowcase.offsetWidth;
  proShowcase.classList.add('is-playing');
  proPreviewTimer = setTimeout(stopProPreview, proLevel * 1000);
}

function closePro() {
  if (!proDialog.open || proDialog.classList.contains('is-closing')) return;
  stopProPreview();
  proDialog.classList.add('is-closing');
  proCloseTimer = setTimeout(() => proDialog.close(), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180);
}

$('#pro-pulse-action').addEventListener('click', () => {
  if (!state || state.demo || proDialog.open) return;
  clearTimeout(proCloseTimer);
  proDialog.classList.remove('is-closing');
  setInlineStatus('light-alerts-status', '');
  proPreviousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  proDialog.showModal();
  renderAlerts();
  playProPreview();
});
$('#pro-close').addEventListener('click', closePro);
proDialog.addEventListener('cancel', (event) => { event.preventDefault(); closePro(); });
proDialog.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  const controls = [...proDialog.querySelectorAll('button:not(:disabled)')].filter(button => button.getClientRects().length);
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
proDialog.addEventListener('click', (event) => {
  if (event.target !== proDialog) return;
  const bounds = proDialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closePro();
});
proDialog.addEventListener('close', () => {
  clearTimeout(proCloseTimer);
  stopProPreview();
  proDialog.classList.remove('is-closing');
  document.body.style.overflow = proPreviousOverflow;
  proOpen.focus({ preventScroll: true });
});
document.addEventListener('visibilitychange', () => { if (document.hidden) stopProPreview(); });
$('#pro-replay').addEventListener('click', playProPreview);
document.querySelectorAll('[data-pro-level]').forEach((button) => button.addEventListener('click', () => {
  proLevel = Number(button.dataset.proLevel);
  playProPreview();
}));
document.querySelectorAll('[data-pro-direction]').forEach((button) => button.addEventListener('click', () => {
  proDirection = Number(button.dataset.proDirection);
  playProPreview();
}));

function renderAlerts() {
  const area = $('#light-alerts');
  area.hidden = !state || state.demo || typeof state.alerts_enabled !== 'boolean';
  if (area.hidden || !state) return;
  const button = $('#light-alerts-toggle');
  button.setAttribute('aria-pressed', String(Boolean(state.alerts_enabled)));
  $('#pro-activate-label').textContent = savingAlerts ? 'Guardando…' : state.alerts_enabled ? 'Desactivar destellos' : 'Activar destellos';
  button.disabled = savingAlerts;
  button.setAttribute('aria-busy', String(savingAlerts));
  const setState = (id, text, active) => {
    const node = $(id);
    node.textContent = text;
    node.classList.toggle('is-active', Boolean(active));
  };
  const pro = state.pro || {};
  const averageOnStrip = state.quotes?.some((quote) => quote.symbol === PORTFOLIO_SYMBOL);
  setState('#feature-pulse-state', state.alerts_enabled ? 'Activo' : 'Desactivado', state.alerts_enabled);
  setState('#feature-average-state', (pro.average?.mode === 'weighted' ? 'Personalizada' : 'Mismo peso') + (averageOnStrip ? ' · en la tira' : ''), averageOnStrip);
  setState('#feature-ambient-state', pro.ambient?.enabled ? 'Activo' : 'Desactivado', pro.ambient?.enabled);
  setState('#feature-carousel-state', state.carousel_enabled ? `En marcha · ${state.carousel_assets.length}` : 'Desactivado', state.carousel_enabled);
  const n = Object.values(pro.targets || {}).filter((target) => target && (target.sell != null || target.stop != null)).length;
  setState('#feature-target-state', n ? `${n} ${n === 1 ? 'activo' : 'activos'}` : 'Por empresa', n > 0);
  for (const chip of document.querySelectorAll('.feature-chip')) {
    const status = chip.querySelector('.feature-state');
    chip.classList.toggle('is-on', status.classList.contains('is-active'));
    chip.setAttribute('aria-description', status.textContent);
  }
  const averageAction = $('#pro-average-action');
  averageAction.disabled = state.portfolio_average_supported !== true;
  averageAction.title = averageAction.disabled ? 'Reinicia el programa para activar la media de cartera' : '';
}

let proSaving = false;
function proDraft() {
  const draft = JSON.parse(JSON.stringify(state.pro || {
    enabled: false, average: { mode: 'equal', weights: {} }, targets: {},
    ambient: { enabled: false, night: false, schedule: false, start: '22:00', end: '07:00' },
  }));
  // Todas las funciones están incluidas: se guardan siempre como activas.
  draft.enabled = true;
  return draft;
}

async function saveProSettings(next) {
  if (proSaving || !state || state.demo) throw new Error('Espera un momento');
  proSaving = true;
  try {
    const response = await fetch('/api/pro', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'No se pudieron guardar los ajustes');
    state = result;
    renderQuotes();
    renderAlerts();
    if (selectedSymbol) renderDetail(state.quotes.find((quote) => quote.symbol === selectedSymbol));
    return result;
  } finally {
    proSaving = false;
  }
}

const averageDialog = $('#average-dialog');
let averageMode = 'equal';
let averageWeights = {};
function averageCompanies() {
  return state.quotes.filter((quote) => quote.symbol !== PORTFOLIO_SYMBOL);
}
function savedAverageWeights(companies) {
  const raw = companies.map((quote) => state.pro.average.weights[quote.symbol] ?? 0);
  const cents = raw.map((weight) => Math.round(weight * 100));
  const difference = 10000 - cents.reduce((sum, value) => sum + value, 0);
  if (cents.length && difference) {
    const largest = cents.indexOf(Math.max(...cents));
    cents[largest] += difference;
  }
  return Object.fromEntries(companies.map((quote, index) => [quote.symbol, cents[index] / 100]));
}
function updateAverageTotal() {
  const inputs = [...$('#average-weights').querySelectorAll('input')];
  const total = inputs.reduce((sum, input) => sum + (Number(input.value) || 0), 0);
  const valid = inputs.length > 0 && inputs.every((input) =>
    input.value !== '' && input.validity.valid && /^\d+(?:\.\d{1,2})?$/.test(input.value)
  ) && Math.round(total * 100) === 10000;
  $('#average-total').textContent = `${money.format(total)} / 100 %`;
  $('#average-total').classList.toggle('is-invalid', !valid);
  $('#average-save').disabled = averageMode === 'weighted' && !valid;
  return valid;
}
function renderAverageWeights() {
  $('#average-equal').setAttribute('aria-pressed', String(averageMode === 'equal'));
  $('#average-weighted').setAttribute('aria-pressed', String(averageMode === 'weighted'));
  const show = averageMode === 'weighted';
  $('#average-weights').hidden = !show;
  $('#average-total').hidden = !show;
  if (!show) { $('#average-save').disabled = false; return; }
  const list = $('#average-weights');
  list.replaceChildren();
  for (const quote of averageCompanies()) {
    const label = document.createElement('label');
    label.className = 'average-weight-row';
    const name = document.createElement('span');
    name.innerHTML = '<strong></strong><small></small>';
    name.querySelector('strong').textContent = quote.symbol;
    name.querySelector('small').textContent = quote.name;
    const input = document.createElement('input');
    input.type = 'number'; input.min = '0'; input.max = '100'; input.step = '0.01'; input.inputMode = 'decimal';
    input.value = averageWeights[quote.symbol] ?? 0;
    input.setAttribute('aria-label', `Peso de ${quote.name} en porcentaje`);
    input.addEventListener('input', () => { averageWeights[quote.symbol] = Number(input.value); updateAverageTotal(); });
    const unit = Object.assign(document.createElement('span'), { textContent: '%' });
    label.append(name, input, unit);
    list.append(label);
  }
  updateAverageTotal();
}
$('#pro-average-action').addEventListener('click', () => {
  if (!state || state.demo || state.portfolio_average_supported !== true) return;
  averageMode = state.pro.average.mode;
  const companies = averageCompanies();
  averageWeights = averageMode === 'weighted'
    ? savedAverageWeights(companies)
    : Object.fromEntries(companies.map((quote) => [quote.symbol, 0]));
  setInlineStatus('average-status', '');
  renderAverageWeights();
  averageDialog.showModal();
});
$('#average-equal').addEventListener('click', () => { averageMode = 'equal'; renderAverageWeights(); });
$('#average-weighted').addEventListener('click', () => { averageMode = 'weighted'; renderAverageWeights(); });
$('#average-close').addEventListener('click', () => averageDialog.close());
averageDialog.addEventListener('close', () => proOpen.focus({ preventScroll: true }));
$('#average-save').addEventListener('click', async () => {
  if (proSaving) return;
  const next = proDraft();
  if (averageMode === 'weighted' && !updateAverageTotal()) {
    setInlineStatus('average-status', 'Los pesos deben sumar 100 %.');
    return;
  }
  next.average = { mode: averageMode, weights: averageMode === 'weighted' ? averageWeights : {} };
  $('#average-save').disabled = true;
  try {
    await saveProSettings(next);
    setInlineStatus('average-status', 'Media guardada.', 'success');
    setTimeout(() => { if (averageDialog.open) averageDialog.close(); }, 500);
  } catch (error) { setInlineStatus('average-status', error.message); }
  finally { renderAverageWeights(); }
});
$('#average-strip').addEventListener('click', () => {
  averageDialog.close();
  openPortfolioEditor();
  portfolioPreviousFocus = proOpen;
  const average = portfolioDraft.find((item) => item.symbol === PORTFOLIO_SYMBOL);
  if (average) {
    selectedPortfolioSymbol = PORTFOLIO_SYMBOL;
    updatePortfolioEditor();
    revealSelectedSegments(PORTFOLIO_SYMBOL);
  } else {
    addPortfolioAsset({ symbol: PORTFOLIO_SYMBOL, name: 'Mi cartera', market: 'AVG', exchange: 'MEDIA EQUIPONDERADA' });
  }
});

const ambientDialog = $('#ambient-dialog');
$('#pro-ambient-action').addEventListener('click', () => {
  if (!state || state.demo) return;
  const ambient = state.pro.ambient;
  $('#ambient-enabled').checked = ambient.enabled;
  $('#ambient-night').checked = ambient.night;
  $('#ambient-schedule').checked = ambient.schedule;
  $('#ambient-start').value = ambient.start;
  $('#ambient-end').value = ambient.end;
  setInlineStatus('ambient-status', '');
  updateAmbientFields();
  ambientDialog.showModal();
});
function updateAmbientFields() {
  const active = $('#ambient-enabled').checked;
  $('#ambient-night').disabled = !active;
  $('#ambient-schedule').disabled = !active;
  $('#ambient-hours').hidden = !active || !$('#ambient-schedule').checked;
}
$('#ambient-enabled').addEventListener('change', updateAmbientFields);
$('#ambient-night').addEventListener('change', () => {
  if ($('#ambient-night').checked) $('#ambient-schedule').checked = false;
  updateAmbientFields();
});
$('#ambient-schedule').addEventListener('change', () => {
  if ($('#ambient-schedule').checked) $('#ambient-night').checked = false;
  updateAmbientFields();
});
$('#ambient-close').addEventListener('click', () => ambientDialog.close());
ambientDialog.addEventListener('close', () => proOpen.focus({ preventScroll: true }));
$('#ambient-save').addEventListener('click', async () => {
  if (proSaving) return;
  const next = proDraft();
  next.ambient = {
    enabled: $('#ambient-enabled').checked,
    night: $('#ambient-night').checked,
    schedule: $('#ambient-schedule').checked,
    start: $('#ambient-start').value,
    end: $('#ambient-end').value,
  };
  $('#ambient-save').disabled = true;
  try {
    await saveProSettings(next);
    setInlineStatus('ambient-status', 'Ambiente guardado.', 'success');
    setTimeout(() => { if (ambientDialog.open) ambientDialog.close(); }, 500);
  } catch (error) { setInlineStatus('ambient-status', error.message); }
  finally { $('#ambient-save').disabled = false; }
});

function carouselPreviewRoute() {
  if (state.carousel_enabled && Array.isArray(state.carousel_route) && state.carousel_route.length === 15) {
    return state.carousel_route;
  }
  const active = carouselItems.slice(0, 15);
  if (!active.length) return Array(15).fill(null);
  const each = Math.floor(15 / active.length);
  const extra = 15 % active.length;
  return active.flatMap((asset, index) => Array(each + (index < extra ? 1 : 0)).fill(asset));
}

function swapCarouselSections(firstSymbol, secondSymbol) {
  if (carouselSaving || firstSymbol === secondSymbol) return;
  const first = carouselItems.findIndex((item) => item.symbol === firstSymbol);
  const second = carouselItems.findIndex((item) => item.symbol === secondSymbol);
  if (first < 0 || second < 0) return;
  [carouselItems[first], carouselItems[second]] = [carouselItems[second], carouselItems[first]];
  carouselSelectedSymbol = null;
  renderCarousel();
  saveCarousel(Boolean(state.carousel_enabled));
}

function renderCarousel() {
  if (!state) return;
  const quote = (state.carousel_quotes || []).find((item) => item.symbol === state.carousel_current_symbol);
  const preview = $('#carousel-preview');
  const position = Number.isInteger(state.carousel_position) ? state.carousel_position : -1;
  const route = carouselPreviewRoute();
  const routeCounts = new Map();
  route.forEach((item) => { if (item?.symbol) routeCounts.set(item.symbol, (routeCounts.get(item.symbol) || 0) + 1); });
  const quoteBySymbol = new Map([...(state.quotes || []), ...(state.carousel_quotes || [])].map((item) => [item.symbol, item]));
  const availableQuotes = carouselItems.filter((item) => Number.isFinite(quoteBySymbol.get(item.symbol)?.change_pct)).length;
  if (state.carousel_enabled && carouselItems.length && availableQuotes === 0 && !carouselSaving && !$('#carousel-status').classList.contains('is-error')) {
    setInlineStatus('carousel-status', state.loading ? 'Buscando cotizaciones…' : 'Esperando cotizaciones…', 'pending');
  } else if ($('#carousel-status').textContent === 'Buscando cotizaciones…' || $('#carousel-status').textContent === 'Esperando cotizaciones…') {
    setInlineStatus('carousel-status', '');
  }
  preview.replaceChildren(...Array.from({ length: 15 }, (_, index) => {
    const block = document.createElement('button');
    block.type = 'button';
    block.className = 'carousel-preview-block';
    const routeAsset = route[index];
    const previous = route[index - 1];
    const isGroupStart = Boolean(routeAsset && index > 0 && previous?.symbol !== routeAsset.symbol);
    block.classList.toggle('is-current', state.carousel_enabled && index === position);
    block.classList.toggle('is-group-start', isGroupStart);
    block.classList.toggle('is-selected', routeAsset?.symbol === carouselSelectedSymbol);
    block.setAttribute('aria-pressed', String(Boolean(routeAsset && routeAsset.symbol === carouselSelectedSymbol)));
    const change = quoteBySymbol.get(routeAsset?.symbol)?.change_pct;
    const hasChange = Number.isFinite(change);
    const color = hasChange ? (change < 0 ? '#e56a73' : '#62cc8a') : '#536057';
    block.style.setProperty('--block-color', color);
    const allocated = routeCounts.get(routeAsset?.symbol) || 0;
    block.title = routeAsset ? `${routeAsset.name} · ${routeAsset.symbol} · ${allocated} ${allocated === 1 ? 'bloque' : 'bloques'}${hasChange ? ` · ${percentText(change)}` : ' · cotización pendiente'}` : 'Sin empresa asignada';
    block.setAttribute('aria-label', routeAsset ? `${block.title}. Seleccionar sección para intercambiar` : 'Sin empresa asignada');
    block.disabled = !routeAsset || carouselSaving;
    block.draggable = Boolean(routeAsset && !carouselSaving);
    block.addEventListener('click', () => {
      if (carouselSuppressClick || !routeAsset) return;
      if (!carouselSelectedSymbol || carouselSelectedSymbol === routeAsset.symbol) {
        carouselSelectedSymbol = carouselSelectedSymbol === routeAsset.symbol ? null : routeAsset.symbol;
        renderCarousel();
      } else swapCarouselSections(carouselSelectedSymbol, routeAsset.symbol);
    });
    block.addEventListener('dragstart', (event) => {
      carouselDraggedSymbol = routeAsset.symbol;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', routeAsset.symbol);
    });
    block.addEventListener('dragend', () => { carouselDraggedSymbol = null; });
    block.addEventListener('dragover', (event) => {
      if (carouselDraggedSymbol && carouselDraggedSymbol !== routeAsset.symbol) {
        event.preventDefault(); event.dataTransfer.dropEffect = 'move';
      }
    });
    block.addEventListener('drop', (event) => {
      event.preventDefault();
      const source = carouselDraggedSymbol || event.dataTransfer.getData('text/plain');
      carouselDraggedSymbol = null;
      carouselSuppressClick = true;
      setTimeout(() => { carouselSuppressClick = false; }, 0);
      swapCarouselSections(source, routeAsset.symbol);
    });
    return block;
  }));
  $('#carousel-current').textContent = state.carousel_enabled && quote ? `${quote.name} · ${quote.symbol}` : carouselItems.length ? `${carouselItems.length} ${carouselItems.length === 1 ? 'empresa' : 'empresas'}` : 'Añade empresas';
  $('#carousel-current-change').textContent = state.carousel_enabled && quote ? percentText(quote.change_pct) : '—';
  $('#carousel-current-change').classList.toggle('is-negative', Number(quote?.change_pct) < 0);
  const list = $('#carousel-list');
  list.replaceChildren(...carouselItems.map((asset, index) => {
    const row = document.createElement('div');
    row.className = 'carousel-row';
    const assignedSegments = routeCounts.get(asset.symbol) || 0;
    const queued = assignedSegments === 0;
    row.classList.toggle('is-queued', queued);
    row.draggable = !carouselSaving;
    row.title = queued ? 'En cola · entra al rotar la ruta' : `Posición ${index + 1} · arrastra para reordenar`;
    const number = document.createElement('span'); number.className = 'carousel-row-index'; number.textContent = String(index + 1).padStart(2, '0');
    const name = document.createElement('strong'); name.textContent = asset.symbol;
    const company = document.createElement('span'); company.textContent = asset.name;
    const queue = document.createElement('small'); queue.className = `carousel-queue-label${queued ? ' is-waiting' : ''}`; queue.textContent = queued ? 'EN COLA' : `${assignedSegments} ${assignedSegments === 1 ? 'BLOQUE' : 'BLOQUES'}`;
    const remove = document.createElement('button'); remove.type = 'button'; remove.setAttribute('aria-label', `Quitar ${asset.symbol}`); remove.textContent = '×'; remove.disabled = carouselSaving;
    remove.addEventListener('click', () => {
      carouselItems.splice(index, 1);
      if (carouselSelectedSymbol === asset.symbol) carouselSelectedSymbol = null;
      renderCarousel(); saveCarousel(Boolean(state.carousel_enabled) && carouselItems.length > 0);
    });
    row.addEventListener('dragstart', (event) => {
      carouselDraggingIndex = index;
      row.classList.add('is-dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', asset.symbol);
    });
    row.addEventListener('dragend', () => { carouselDraggingIndex = -1; row.classList.remove('is-dragging'); });
    row.addEventListener('dragover', (event) => { if (carouselDraggingIndex >= 0) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } });
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      const from = carouselDraggingIndex;
      if (from < 0 || from === index) return;
      const [moved] = carouselItems.splice(from, 1);
      carouselItems.splice(index, 0, moved);
      carouselDraggingIndex = -1;
      renderCarousel(); saveCarousel(Boolean(state.carousel_enabled));
    });
    row.append(number, name, company, queue, remove); return row;
  }));
  const button = $('#carousel-toggle');
  button.disabled = carouselSaving || (!state.carousel_enabled && carouselItems.length === 0);
  button.textContent = carouselSaving ? 'Guardando…' : state.carousel_enabled ? 'Detener carrusel' : 'Activar carrusel';
  button.classList.toggle('is-on', Boolean(state.carousel_enabled));
  $('#carousel-search-input').disabled = carouselSaving;
}

async function saveCarousel(enabled) {
  if (!state || state.demo || carouselSaving) return;
  const wasEnabled = Boolean(state.carousel_enabled);
  carouselSaving = true; setInlineStatus('carousel-status', ''); renderCarousel();
  try {
    const response = await fetch('/api/carousel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled, symbols: carouselItems.map((item) => item.symbol) }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'No se pudo guardar el carrusel');
    state = payload; carouselItems = (state.carousel_assets || []).map((asset) => ({ ...asset }));
    setInlineStatus('carousel-status', state.carousel_enabled ? 'Carrusel activo.' : wasEnabled ? 'Cartera restaurada.' : 'Ruta guardada.', 'success');
  } catch (error) {
    setInlineStatus('carousel-status', error.message);
    carouselItems = (state.carousel_assets || []).map((asset) => ({ ...asset }));
  } finally { carouselSaving = false; renderCarousel(); }
}

$('#pro-carousel-action').addEventListener('click', () => {
  if (!state || state.demo || carouselDialog.open) return;
  carouselPreviousFocus = proOpen;
  carouselItems = (state.carousel_assets || []).map((asset) => ({ ...asset }));
  carouselSelectedSymbol = null;
  $('#carousel-search-input').value = '';
  $('#carousel-results').replaceChildren();
  carouselDialog.showModal(); renderCarousel(); $('#carousel-search-input').focus();
});
$('#carousel-close').addEventListener('click', () => carouselDialog.close());
carouselDialog.addEventListener('close', () => {
  clearTimeout(carouselSearchTimer);
  carouselSearchSequence++;
  carouselSelectedSymbol = null;
  if (carouselPreviousFocus?.isConnected) carouselPreviousFocus.focus({ preventScroll: true });
});
$('#carousel-toggle').addEventListener('click', () => saveCarousel(!state?.carousel_enabled));
async function searchCarousel(term) {
  const target = $('#carousel-results');
  const sequence = ++carouselSearchSequence;
  if (term.length < 2 || carouselSaving) { target.replaceChildren(); target.classList.remove('has-error'); return; }
  target.classList.remove('has-error');
  target.textContent = 'Buscando…';
  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(term)}`);
    const payload = await response.json(); if (!response.ok) throw new Error(payload.error || 'Búsqueda no disponible');
    if (sequence !== carouselSearchSequence || !carouselDialog.open) return;
    const results = (payload.results || []).filter((item) => !carouselItems.some((chosen) => chosen.symbol === item.symbol));
    target.replaceChildren(...results.slice(0, 8).map((asset) => {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'carousel-result';
      const symbol = document.createElement('strong'); symbol.textContent = asset.symbol;
      const name = document.createElement('span'); name.textContent = asset.name;
      row.append(symbol, name); row.addEventListener('click', () => {
        if (carouselItems.some((item) => item.symbol === asset.symbol)) return;
        carouselItems.push(asset); $('#carousel-search-input').value = ''; target.replaceChildren();
        target.classList.remove('has-error');
        carouselSearchSequence++;
        setInlineStatus('carousel-status', ''); renderCarousel(); saveCarousel(Boolean(state.carousel_enabled));
      }); return row;
    }));
    if (!results.length) target.textContent = 'Sin resultados';
  } catch (error) {
    if (sequence === carouselSearchSequence) {
      target.textContent = `Búsqueda no disponible: ${error.message}`;
      target.classList.add('has-error');
    }
  }
}
$('#carousel-search-input').addEventListener('input', (event) => {
  clearTimeout(carouselSearchTimer);
  const term = event.target.value.trim();
  carouselSearchSequence++;
  if (term.length < 2) { $('#carousel-results').replaceChildren(); $('#carousel-results').classList.remove('has-error'); return; }
  carouselSearchTimer = setTimeout(() => searchCarousel(term), 280);
});
$('#carousel-search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  clearTimeout(carouselSearchTimer);
  searchCarousel($('#carousel-search-input').value.trim());
});

$('#light-alerts-toggle').addEventListener('click', async () => {
  if (!state || state.demo || savingAlerts) return;
  savingAlerts = true;
  renderAlerts();
  setInlineStatus('light-alerts-status', '');
  try {
    const response = await fetch('/api/alerts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !state.alerts_enabled }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'No se pudo cambiar');
    state = result;
    setInlineStatus('light-alerts-status', state.alerts_enabled ? 'Destellos activados.' : 'Destellos desactivados.', 'success');
    if (state.alerts_enabled) playProPreview();
  } catch (error) {
    setInlineStatus('light-alerts-status', error.message);
  } finally {
    savingAlerts = false;
    renderAlerts();
  }
});

function storageKey() {
  return `h617a-drawings:${selectedSymbol}:${selectedRange}`;
}

function loadAnnotations() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey()) || '[]');
    annotations = Array.isArray(saved) ? saved.filter((item) =>
      item && typeof item.id === 'string' &&
      ['x1', 'x2', 'y1', 'y2'].every((key) => Number.isFinite(item[key]))
    ).slice(0, 100) : [];
  } catch { annotations = []; }
  selectedAnnotation = null;
  updateTools();
}

function saveAnnotations() {
  try { localStorage.setItem(storageKey(), JSON.stringify(annotations)); } catch { /* Storage disabled. */ }
}

function updateTools() {
  const daily = selectedRange !== '1D';
  const average = selectedSymbol === PORTFOLIO_SYMBOL;
  $('#ma200-button').hidden = average;
  $('#dividend-button').hidden = average;
  $('#ma200-button').disabled = !daily || average;
  $('#ma200-button').classList.toggle('is-active', daily && showMA && !average);
  $('#ma200-button').setAttribute('aria-pressed', String(daily && showMA && !average));
  $('#dividend-button').disabled = average;
  $('#dividend-button').classList.toggle('is-active', showDividends);
  $('#dividend-button').setAttribute('aria-pressed', String(showDividends));
  $('#rect-button').classList.toggle('is-active', drawMode);
  $('#rect-button').setAttribute('aria-pressed', String(drawMode));
  $('#duplicate-button').disabled = !selectedAnnotation;
  $('#delete-button').disabled = !selectedAnnotation;
  $('#annotation-actions').hidden = !selectedAnnotation;
  $('#ma-stat').hidden = !daily || !showMA;
  $('#detail-chart').classList.toggle('is-drawing', drawMode);
  const activeCount = Number(daily && showMA) + Number(showDividends) + Number(drawMode);
  $('#tools-count').hidden = activeCount === 0;
  $('#tools-count').textContent = String(activeCount);
  $('#tools-toggle').classList.toggle('has-active', activeCount > 0);
}

function lastChartReadout() {
  const point = chartView?.valid.at(-1);
  if (!point) return '—';
  const stamp = selectedRange === '1D'
    ? hour.format(new Date(point.time))
    : shortDate.format(new Date(`${point.time}T12:00:00`));
  return `${money.format(point.price)} · ${stamp}`;
}

function updateDividendSummary() {
  const summary = $('#dividend-summary');
  summary.hidden = !showDividends || selectedSymbol === PORTFOLIO_SYMBOL;
  if (summary.hidden) return;
  summary.replaceChildren();
  if (rangeLoading) { summary.textContent = 'Cargando dividendos del periodo…'; return; }
  if (eventsError) { summary.textContent = eventsError; return; }
  if (!currentEvents) { summary.textContent = 'Consultando dividendos…'; return; }
  if (currentEvents.dividends_available === false) {
    summary.textContent = 'No se pudieron verificar los dividendos ahora. Inténtalo más tarde.';
    return;
  }
  const visibleDates = new Set((chartView?.valid || []).map((point) => point.time.slice(0, 10)));
  const count = (currentEvents.dividends || []).filter((item) => visibleDates.has(item.date)).length;
  const note = document.createElement('span');
  note.textContent = count
    ? `${count} ${count === 1 ? 'dividendo' : 'dividendos'} en el periodo`
    : 'Sin dividendos en este periodo';
  summary.append(note);
  if (!count && selectedRange !== '5Y' && (currentEvents.dividends || []).length) {
    const wider = document.createElement('button');
    wider.type = 'button';
    wider.textContent = 'Ver 5 años →';
    wider.addEventListener('click', () => chooseRange('5Y'));
    summary.append(wider);
  }
  const next = currentEvents.next_dividend;
  const latest = currentEvents.dividends?.at(-1);
  const upcoming = document.createElement('span');
  upcoming.textContent = next?.estimated_percent != null
    ? `Próximo: ≈${money.format(next.estimated_percent)} % · estimado según el último pago`
    : latest?.percent != null
      ? `Último pago: ${money.format(latest.percent)} % · próximo porcentaje no anunciado`
      : 'Próximo porcentaje: no anunciado';
  summary.append(upcoming);
}

function showChartMessage(message) {
  const notice = $('#chart-message');
  notice.textContent = message;
  notice.hidden = !message;
}

function renderAnnotations() {
  const layer = $('#annotation-layer');
  if (!layer) return;
  layer.replaceChildren();
  const { plotWidth, plotHeight, padding } = chartView;
  const xScale = (plotWidth - 2 * padding) / 976;
  const yScale = (plotHeight - 2 * padding) / 343;
  for (const item of annotations) {
    const x = padding + (Math.min(item.x1, item.x2) - 12) * xScale;
    const y = padding + (Math.min(item.y1, item.y2) - 12) * yScale;
    const width = Math.abs(item.x2 - item.x1) * xScale;
    const height = Math.abs(item.y2 - item.y1) * yScale;
    const selected = item.id === selectedAnnotation;
    layer.append(svg('rect', {
      x, y, width, height, rx: 2,
      fill: selected ? 'rgba(71,122,91,.11)' : 'rgba(91,120,99,.08)',
      stroke: selected ? '#72947a' : '#9cac9c',
      'stroke-width': selected ? 1.5 : 1,
      'vector-effect': 'non-scaling-stroke',
      'data-annotation': item.id,
      style: 'cursor: move',
    }));
    if (selected) {
      for (const [corner, cx, cy] of [
        ['nw', x, y], ['ne', x + width, y],
        ['sw', x, y + height], ['se', x + width, y + height],
      ]) {
        layer.append(svg('circle', {
          cx, cy, r: 4, fill: '#fff', stroke: '#72947a', 'stroke-width': 1.5,
          'vector-effect': 'non-scaling-stroke', 'data-annotation': item.id,
          'data-handle': corner, style: 'cursor: nwse-resize',
        }));
      }
    }
  }
  updateTools();
}

function renderEventMarkers(data) {
  const layer = svg('g', { id: 'event-layer' });
  if (!currentEvents) return layer;
  const marks = [
    ...(currentEvents.earnings || []).map((day) => ({ day, type: 'earnings' })),
    ...(showDividends ? (currentEvents.dividends || []).map((item) => ({ day: item.date, type: 'dividend', percent: item.percent })) : []),
  ];
  for (const mark of marks) {
    const index = mark.type === 'earnings' && selectedRange === '1D'
      ? data.valid.findLastIndex((point) => point.time.slice(0, 10) === mark.day)
      : data.valid.findIndex((point) => point.time.slice(0, 10) === mark.day);
    if (index < 0) continue;
    const [x, y] = data.coordinates[index];
    const group = svg('g', { 'data-event': mark.type, 'data-date': mark.day, 'data-index': index, 'data-percent': mark.percent ?? '', 'pointer-events': 'all' });
    group.append(svg('circle', { cx: x, cy: y, r: 15, fill: 'transparent' }));
    if (mark.type === 'dividend') {
      group.append(svg('circle', { cx: x, cy: y, r: 5, fill: '#f0a15a', stroke: '#fff', 'stroke-width': 1.5, 'pointer-events': 'none' }));
    } else {
      group.append(svg('path', { d: `M${x},${y - 5} L${x + 5},${y} L${x},${y + 5} L${x - 5},${y} Z`, fill: '#747e88', stroke: '#fff', 'stroke-width': 1, 'pointer-events': 'none' }));
    }
    group.addEventListener('pointerenter', () => { if (!pinnedTime) showEventTooltip(group); });
    layer.append(group);
  }
  return layer;
}

function renderChart(transition = false) {
  const quote = state?.quotes.find((item) => item.symbol === selectedSymbol);
  if (!quote || overlay.hidden) return;
  const chart = $('#detail-chart');
  const width = Math.max(200, $('#chart-wrap').clientWidth);
  const height = Math.max(160, $('#chart-wrap').clientHeight);
  const plotWidth = width - 53;
  const plotHeight = height - 32;
  const padding = 8;
  const oldShapes = transition ? [...chart.querySelectorAll('[data-price-shape]')].map((node) => node.cloneNode(true)) : [];
  chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
  chart.replaceChildren();
  $('#chart-tooltip').hidden = true;
  chartView = plot(currentPoints, plotWidth, plotHeight, padding, showMA && selectedRange !== '1D');
  if (!chartView) {
    renderPeriodValue(quote);
    showChartMessage(selectedSymbol === PORTFOLIO_SYMBOL && selectedRange === '1D'
      ? 'Las sesiones aún no coinciden. Elige 1M para ver la evolución conjunta.'
      : 'Todavía no hay suficientes datos para este periodo.');
    for (const selector of ['#chart-first', '#chart-last', '#stat-high', '#stat-low', '#stat-ma200', '#chart-selection']) $(selector).textContent = '—';
    updateDividendSummary();
    return;
  }
  Object.assign(chartView, { width, height, plotWidth, plotHeight, padding });
  renderPeriodValue(quote);
  showChartMessage('');
  const data = chartView;
  const color = chartColor(quote, data.valid);
  const defs = svg('defs');
  const gradient = svg('linearGradient', { id: 'detail-fill', x1: 0, x2: 0, y1: 0, y2: 1 });
  gradient.append(svg('stop', { offset: 0, 'stop-color': color, 'stop-opacity': .16 }), svg('stop', { offset: 1, 'stop-color': color, 'stop-opacity': .015 }));
  defs.append(gradient);
  chart.append(defs, svg('rect', { width, height, fill: 'transparent' }));
  for (let index = 0; index < 4; index++) {
    const y = padding + index * (plotHeight - padding * 2) / 3;
    chart.append(svg('line', { x1: padding, x2: plotWidth, y1: y, y2: y, stroke: '#dde5da', 'stroke-width': 1, 'pointer-events': 'none' }));
    const value = data.ceiling - index * (data.ceiling - data.floor) / 3;
    const label = svg('text', { x: width - 1, y: y + 4, 'text-anchor': 'end', fill: '#94a390', 'font-size': 11, 'pointer-events': 'none' });
    label.textContent = money.format(value);
    chart.append(label);
  }
  const maxVolume = Math.max(1, ...data.valid.map((point) => point.volume || 0));
  $('.volume-caption').hidden = selectedSymbol === PORTFOLIO_SYMBOL;
  const volumeStride = Math.max(1, Math.ceil(data.valid.length / (plotWidth / 5)));
  data.valid.forEach((point, index) => {
    if (index % volumeStride) return;
    const volumeHeight = Math.min(19, ((point.volume || 0) / maxVolume) * 19);
    if (volumeHeight) chart.append(svg('rect', {
      x: data.coordinates[index][0] - 1, y: height - 2 - volumeHeight,
      width: Math.max(1, Math.min(4, plotWidth / data.valid.length * .6)), height: volumeHeight,
      fill: '#b4c1b1', opacity: .65, rx: .5, 'pointer-events': 'none',
    }));
  });
  const area = svg('path', { d: `${data.path} L${plotWidth - padding},${plotHeight} L${padding},${plotHeight} Z`, fill: 'url(#detail-fill)', 'pointer-events': 'none', 'data-price-shape': 'area' });
  const line = svg('path', { d: data.path, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'pointer-events': 'none', 'data-price-shape': 'line' });
  chart.append(area, line);
  if (showMA && selectedRange !== '1D') {
    let path = '';
    let active = false;
    data.valid.forEach((point, index) => {
      if (!Number.isFinite(point.ma200)) { active = false; return; }
      const x = data.coordinates[index][0];
      const y = padding + (data.ceiling - point.ma200) * (plotHeight - 2 * padding) / (data.ceiling - data.floor);
      path += `${active ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)} `;
      active = true;
    });
    chart.append(svg('path', { d: path, fill: 'none', stroke: '#7d8c76', 'stroke-width': 1.3, 'stroke-dasharray': '4 4', 'pointer-events': 'none' }));
  }
  const [endX, endY] = data.coordinates.at(-1);
  chart.append(svg('circle', { cx: endX, cy: endY, r: 7, fill: color, opacity: .10, 'pointer-events': 'none' }),
    svg('circle', { cx: endX, cy: endY, r: 3, fill: color, stroke: '#f7f9f5', 'stroke-width': 1.5, 'pointer-events': 'none' }));
  chart.append(renderEventMarkers(data));
  chart.append(svg('g', { id: 'annotation-layer' }));
  chart.append(svg('g', { id: 'hover-layer', 'pointer-events': 'none' }));
  renderAnnotations();
  if (oldShapes.length && !reducedMotion.matches) {
    const ghost = svg('g', { 'pointer-events': 'none' });
    ghost.append(...oldShapes);
    chart.insertBefore(ghost, $('#hover-layer'));
    ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 320, easing: 'ease-out' }).finished.then(() => ghost.remove()).catch(() => ghost.remove());
    for (const shape of [area, line]) shape.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: 'ease-out' });
  }
  const first = data.valid[0];
  const last = data.valid.at(-1);
  const label = (point) => selectedRange === '1D'
    ? hour.format(new Date(point.time)) : shortDate.format(new Date(`${point.time}T12:00:00`));
  $('#chart-first').textContent = label(first);
  $('#chart-last').textContent = label(last);
  $('#chart-selection').textContent = lastChartReadout();
  $('#stat-high').textContent = money.format(Math.max(...data.valid.map((point) => point.price)));
  $('#stat-low').textContent = money.format(Math.min(...data.valid.map((point) => point.price)));
  $('#stat-ma200').textContent = Number.isFinite(last.ma200) && selectedRange !== '1D' ? money.format(last.ma200) : '—';
  if (pinnedTime || lastExaminedTime) {
    const anchor = Date.parse(pinnedTime || lastExaminedTime);
    let nearest = 0;
    for (let index = 1; index < data.valid.length; index++) {
      if (Math.abs(Date.parse(data.valid[index].time) - anchor) < Math.abs(Date.parse(data.valid[nearest].time) - anchor)) nearest = index;
    }
    if (pinnedTime) pinnedTime = data.valid[nearest].time;
    showHoverIndex(nearest);
  }
  updateDividendSummary();
}

function renderDetail(quote, skipChart = false) {
  if (!quote) return;
  const average = quote.symbol === PORTFOLIO_SYMBOL;
  $('#detail-symbol').textContent = average ? 'MEDIA' : quote.symbol;
  $('#detail-name').textContent = quote.name;
  $('#detail-exchange').textContent = average ? `ÍNDICE BASE 100 · ${state.pro?.average?.mode === 'weighted' ? 'PONDERADA' : 'MISMO PESO'}` : `${quote.exchange} · ${quote.currency}`;
  renderPeriodValue(quote);
  $('.detail-overview').style.setProperty('--quote-light', quote.change_pct < 0 ? '#e78c92' : '#91dda8');
  const segments = $('#detail-segments');
  if (segments.dataset.assignment !== quote.segments.join(',')) {
    segments.replaceChildren(...Array.from({ length: 15 }, (_, index) => Object.assign(document.createElement('i'), { className: quote.segments.includes(index) ? 'is-assigned' : '' })));
    segments.dataset.assignment = quote.segments.join(',');
  }
  segments.classList.toggle('is-off', !state.power_known || !state.on);
  const reached = reachedTarget(quote.symbol);
  $('#detail-assignment').textContent = `${quote.segments.length === 1 ? 'Segmento' : 'Segmentos'} ${quote.segments.join(', ')} · ${reached === 'sell' ? 'objetivo' : reached === 'stop' ? 'stop' : quote.change_pct == null ? 'sin datos' : quote.change_pct < 0 ? 'rojo' : 'verde'}`;
  renderTargetPanel(quote);
  $('#detail-session').textContent = selectedRange === '1D'
    ? quote.session_date ? `Sesión · ${shortDate.format(new Date(`${quote.session_date}T12:00:00`))}` : average ? 'Últimas sesiones disponibles' : 'Última sesión disponible'
    : rangeLabels[selectedRange];
  $('#detail-asof').textContent = average
    ? `${state.quotes.filter((item) => item.symbol !== PORTFOLIO_SYMBOL).length} empresas · ${state.last_fetch ? `actualizada ${hour.format(new Date(state.last_fetch))}` : 'esperando cotizaciones'}${quote.stale ? ' · datos conservados' : ''}`
    : quote.asof ? `Último dato: ${dateTime.format(new Date(quote.asof))}${quote.stale ? ' · Dato conservado' : ''}` : 'Esperando cotizaciones';
  if (selectedRange === '1D' && !skipChart) {
    const averageKey = average ? JSON.stringify(state.pro?.average) : '';
    const key = `${quote.symbol}:${quote.asof}:${quote.points?.length}:${quote.price}:${averageKey}`;
    if (key !== lastChartKey) {
      lastChartKey = key;
      currentPoints = quote.points || [];
      renderChart();
    }
  }
}

function renderTargetPanel(quote) {
  const panel = $('#detail-targets');
  panel.hidden = !quote || state?.demo || quote.symbol === PORTFOLIO_SYMBOL;
  $('#detail-target-toggle').hidden = panel.hidden;
  if (panel.hidden) {
    panel.classList.remove('is-open');
    $('#detail-target-toggle').setAttribute('aria-expanded', 'false');
    return;
  }
  const target = state.pro.targets?.[quote.symbol] || {};
  if (panel.dataset.symbol !== quote.symbol) {
    panel.dataset.symbol = quote.symbol;
    panel.classList.remove('is-open');
    $('#detail-target-toggle').setAttribute('aria-expanded', 'false');
    $('#target-sell').value = target.sell ?? '';
    $('#target-stop').value = target.stop ?? '';
    setInlineStatus('target-status', '');
  }
  panel.querySelectorAll('.target-currency').forEach((unit) => { unit.textContent = quote.currency || ''; });
  $('#target-hit-label').textContent = target.hit === 'sell' ? 'OBJETIVO ALCANZADO' : target.hit === 'stop' ? 'STOP ALCANZADO' : target.acknowledged ? 'AVISO OCULTO' : '';
  panel.classList.toggle('is-sell', target.hit === 'sell');
  panel.classList.toggle('is-stop', target.hit === 'stop');
  $('#target-reset').hidden = !target.hit;
}

function closeMobileTargets() {
  $('#detail-targets').classList.remove('is-open');
  $('#detail-target-toggle').setAttribute('aria-expanded', 'false');
}

$('#feature-targets-action').addEventListener('click', () => {
  // Los objetivos viven en el detalle de cada empresa: abre la primera con su panel.
  const first = state?.quotes?.find((quote) => quote.symbol !== PORTFOLIO_SYMBOL);
  if (!first) return;
  openDetail(first.symbol);
  requestAnimationFrame(() => { if ($('#detail-targets').hidden) $('#detail-target-toggle').click(); });
});
$('#detail-target-toggle').addEventListener('click', () => {
  const panel = $('#detail-targets');
  if (panel.hidden) return;
  const open = panel.classList.toggle('is-open');
  $('#detail-target-toggle').setAttribute('aria-expanded', String(open));
  if (open) $('#target-sell').focus({ preventScroll: true });
});
$('#detail-target-close').addEventListener('click', () => {
  closeMobileTargets();
  $('#detail-target-toggle').focus({ preventScroll: true });
});

$('#detail-targets').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!selectedSymbol || proSaving) return;
  const sellText = $('#target-sell').value.trim();
  const stopText = $('#target-stop').value.trim();
  const sell = sellText ? Number(sellText) : null;
  const stop = stopText ? Number(stopText) : null;
  if ((sell !== null && (!Number.isFinite(sell) || sell <= 0)) || (stop !== null && (!Number.isFinite(stop) || stop <= 0)) || (sell !== null && stop !== null && stop >= sell)) {
    setInlineStatus('target-status', 'Revisa los precios: el stop debe ser menor que el objetivo.');
    return;
  }
  const next = proDraft();
  if (sell === null && stop === null) delete next.targets[selectedSymbol];
  else next.targets[selectedSymbol] = { sell, stop, hit: null, acknowledged: false };
  try {
    await saveProSettings(next);
    $('#detail-targets').dataset.symbol = '';
    renderTargetPanel(state.quotes.find((quote) => quote.symbol === selectedSymbol));
    setInlineStatus('target-status', 'Objetivos guardados.', 'success');
  } catch (error) { setInlineStatus('target-status', error.message); }
});
$('#target-reset').addEventListener('click', async () => {
  if (!selectedSymbol || proSaving) return;
  const next = proDraft();
  if (!next.targets[selectedSymbol]) return;
  next.targets[selectedSymbol].hit = null;
  next.targets[selectedSymbol].acknowledged = true;
  try {
    await saveProSettings(next);
    renderTargetPanel(state.quotes.find((quote) => quote.symbol === selectedSymbol));
    setInlineStatus('target-status', 'Aviso oculto hasta el siguiente cruce.', 'success');
  } catch (error) { setInlineStatus('target-status', error.message); }
});

async function chooseRange(rangeName) {
  if (!selectedSymbol || selectedRange === rangeName) return;
  selectedRange = rangeName;
  rangeLoading = rangeName !== '1D';
  if (rangeLoading) currentPoints = [];
  historyRequest += 1;
  const request = historyRequest;
  lastChartKey = '';
  drawMode = false;
  loadAnnotations();
  document.querySelectorAll('[data-range]').forEach((button) => {
    const active = button.dataset.range === rangeName;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const quote = state?.quotes.find((item) => item.symbol === selectedSymbol);
  renderDetail(quote, true);
  if (rangeName === '1D') {
    rangeLoading = false;
    $('#chart-wrap').classList.remove('chart-wrap-loading');
    $('#detail-chart').setAttribute('aria-busy', 'false');
    currentPoints = quote?.points || [];
    renderChart(true);
    return;
  }
  $('#chart-wrap').classList.add('chart-wrap-loading');
  $('#detail-chart').setAttribute('aria-busy', 'true');
  updateDividendSummary();
  try {
    const url = `/api/history?symbol=${encodeURIComponent(selectedSymbol)}&range=${rangeName}`;
    const response = await fetch(url, { cache: 'no-store' });
    const result = await response.json().catch(() => ({ error: 'Reinicia el programa de la web para activar los nuevos gráficos.' }));
    if (!response.ok) throw new Error(result.error || 'No se pudo cargar el histórico');
    if (request !== historyRequest) return;
    rangeLoading = false;
    $('#chart-wrap').classList.remove('chart-wrap-loading');
    $('#detail-chart').setAttribute('aria-busy', 'false');
    currentPoints = result.points;
    renderChart(true);
  } catch (error) {
    if (request === historyRequest) {
      rangeLoading = false;
      $('#chart-wrap').classList.remove('chart-wrap-loading');
      $('#detail-chart').setAttribute('aria-busy', 'false');
      renderPeriodValue(quote);
      showChartMessage(error.message);
      if (showDividends) $('#dividend-summary').textContent = 'No se pudieron cargar los dividendos de este periodo.';
    }
  }
}

async function loadEventsForSymbol(symbol) {
  const request = ++eventsRequest;
  currentEvents = null;
  eventsError = null;
  updateDividendSummary();
  try {
    const response = await fetch(`/api/events?symbol=${encodeURIComponent(symbol)}`, { cache: 'no-store' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'No se pudieron consultar los eventos');
    if (request !== eventsRequest || selectedSymbol !== symbol) return;
    currentEvents = result;
    if (!rangeLoading) renderChart();
    else updateDividendSummary();
  } catch (error) {
    if (request !== eventsRequest) return;
    eventsError = error.message;
    updateDividendSummary();
  }
}

function chartPoint(event) {
  const bounds = $('#detail-chart').getBoundingClientRect();
  const { plotWidth, plotHeight, padding } = chartView;
  return {
    x: Math.max(12, Math.min(988, 12 + (event.clientX - bounds.left - padding) * 976 / (plotWidth - 2 * padding))),
    y: Math.max(12, Math.min(355, 12 + (event.clientY - bounds.top - padding) * 343 / (plotHeight - 2 * padding))),
  };
}

function showHoverIndex(index, pin = false) {
  if (!chartView) return;
  const point = chartView.valid[index];
  lastExaminedTime = point.time;
  if (pin) pinnedTime = point.time;
  const [lineX, lineY] = chartView.coordinates[index];
  const layer = $('#hover-layer');
  if (!layer) return;
  layer.replaceChildren(
    svg('line', { x1: lineX, x2: lineX, y1: chartView.padding, y2: chartView.plotHeight, stroke: '#9aae9b', 'stroke-width': 1, 'stroke-dasharray': '3 4' }),
    svg('circle', { cx: lineX, cy: lineY, r: 4, fill: '#f7f9f5', stroke: chartColor(state.quotes.find((item) => item.symbol === selectedSymbol), chartView.valid), 'stroke-width': 1.8 }),
  );
  const tooltip = $('#chart-tooltip');
  const dateLabel = selectedRange === '1D' ? dateTime.format(new Date(point.time)) : shortDate.format(new Date(`${point.time}T12:00:00`));
  $('#chart-selection').textContent = pinnedTime
    ? `Fijado · ${money.format(point.price)} · ${dateLabel}`
    : `${money.format(point.price)} · ${dateLabel}`;
  $('#release-point').hidden = !pinnedTime;
  $('#chart-selection').setAttribute('aria-live', pin ? 'polite' : 'off');
  tooltip.replaceChildren(
    Object.assign(document.createElement('strong'), { textContent: money.format(point.price) }),
    Object.assign(document.createElement('span'), { textContent: dateLabel }),
  );
  tooltip.hidden = false;
  positionChartTooltip(index);
}

function positionChartTooltip(index) {
  const [x, y] = chartView.coordinates[index];
  const tooltip = $('#chart-tooltip');
  tooltip.style.left = `${Math.max(3, Math.min(chartView.width - tooltip.offsetWidth - 3, x + 13))}px`;
  tooltip.style.top = `${Math.max(3, Math.min(chartView.height - tooltip.offsetHeight - 3, y - tooltip.offsetHeight - 10))}px`;
}

function showEventTooltip(marker, pin = false) {
  if (!chartView || drawMode) return;
  showHoverIndex(Number(marker.dataset.index), pin);
  const label = date.format(new Date(`${marker.dataset.date}T12:00:00`));
  const tooltip = $('#chart-tooltip');
  tooltip.replaceChildren(
    Object.assign(document.createElement('strong'), { textContent: marker.dataset.event === 'dividend' ? `${money.format(Number(marker.dataset.percent))} %` : 'Resultados' }),
    Object.assign(document.createElement('span'), { textContent: marker.dataset.event === 'dividend' ? 'Dividendo' : label }),
  );
  if (marker.dataset.event === 'dividend') $('#chart-selection').textContent = `${pin ? 'Fijado · ' : ''}Dividendo · ${money.format(Number(marker.dataset.percent))} %`;
  positionChartTooltip(Number(marker.dataset.index));
}

function showHover(event) {
  if (!chartView || rangeLoading || drawMode || activeDrag || pinnedTime) return;
  const marker = event.target.closest('[data-event]');
  if (marker) { showEventTooltip(marker); return; }
  const { x } = chartPoint(event);
  const index = Math.max(0, Math.min(chartView.valid.length - 1, Math.round((x - 12) * (chartView.valid.length - 1) / 976)));
  showHoverIndex(index);
}

function chartIndexAt(event) {
  const { x } = chartPoint(event);
  return Math.max(0, Math.min(chartView.valid.length - 1, Math.round((x - 12) * (chartView.valid.length - 1) / 976)));
}

function unpinChartPoint() {
  pinnedTime = null;
  $('#chart-tooltip').hidden = true;
  $('#hover-layer')?.replaceChildren();
  $('#chart-selection').textContent = lastChartReadout();
  $('#release-point').hidden = true;
}

function chartClick(event) {
  if (suppressChartClick) { suppressChartClick = false; return; }
  if (!chartView || rangeLoading || drawMode || event.target.closest('[data-annotation]')) return;
  $('#detail-chart').focus({ preventScroll: true });
  const marker = event.target.closest('[data-event]');
  const index = marker ? Number(marker.dataset.index) : chartIndexAt(event);
  if (pinnedTime === chartView.valid[index].time) { unpinChartPoint(); return; }
  if (marker) showEventTooltip(marker, true);
  else showHoverIndex(index, true);
}

function chartKeydown(event) {
  if (!chartView || rangeLoading || drawMode || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const current = pinnedTime || lastExaminedTime;
  const position = current ? chartView.valid.findIndex((point) => point.time === current) : -1;
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? chartView.valid.length - 1
    : Math.max(0, Math.min(chartView.valid.length - 1, (position < 0 ? chartView.valid.length - 1 : position) + (event.key === 'ArrowLeft' ? -1 : 1)));
  showHoverIndex(index, true);
}

function chartPointerDown(event) {
  if (!chartView || event.button !== 0) return;
  const point = chartPoint(event);
  const id = event.target.getAttribute('data-annotation');
  if (drawMode) {
    const item = { id: `${Date.now()}-${Math.random()}`, x1: point.x, y1: point.y, x2: point.x, y2: point.y };
    annotations.push(item);
    selectedAnnotation = item.id;
    activeDrag = { kind: 'new', id: item.id, start: point };
  } else if (id) {
    const item = annotations.find((entry) => entry.id === id);
    selectedAnnotation = id;
    activeDrag = { kind: event.target.getAttribute('data-handle') || 'move', id, start: point, original: { ...item } };
  } else {
    selectedAnnotation = null;
    renderAnnotations();
    return;
  }
  event.preventDefault();
  $('#chart-tooltip').hidden = true;
  $('#detail-chart').setPointerCapture(event.pointerId);
  renderAnnotations();
}

function chartPointerMove(event) {
  if (!activeDrag) { showHover(event); return; }
  const item = annotations.find((entry) => entry.id === activeDrag.id);
  if (!item) return;
  const point = chartPoint(event);
  if (activeDrag.kind === 'new') {
    item.x2 = point.x;
    item.y2 = point.y;
  } else if (activeDrag.kind === 'move') {
    const dx = point.x - activeDrag.start.x;
    const dy = point.y - activeDrag.start.y;
    const original = activeDrag.original;
    const clampedX = Math.max(12 - Math.min(original.x1, original.x2), Math.min(988 - Math.max(original.x1, original.x2), dx));
    const clampedY = Math.max(12 - Math.min(original.y1, original.y2), Math.min(355 - Math.max(original.y1, original.y2), dy));
    item.x1 = original.x1 + clampedX;
    item.x2 = original.x2 + clampedX;
    item.y1 = original.y1 + clampedY;
    item.y2 = original.y2 + clampedY;
  } else {
    const corner = activeDrag.kind;
    const original = activeDrag.original;
    if (corner.includes('w')) item.x1 = point.x;
    if (corner.includes('e')) item.x2 = point.x;
    if (corner.includes('n')) item.y1 = point.y;
    if (corner.includes('s')) item.y2 = point.y;
    if (!corner.includes('w')) item.x1 = original.x1;
    if (!corner.includes('e')) item.x2 = original.x2;
    if (!corner.includes('n')) item.y1 = original.y1;
    if (!corner.includes('s')) item.y2 = original.y2;
  }
  renderAnnotations();
}

function chartPointerUp(event) {
  if (!activeDrag) return;
  const item = annotations.find((entry) => entry.id === activeDrag.id);
  if (item && (Math.abs(item.x2 - item.x1) < 7 || Math.abs(item.y2 - item.y1) < 7)) {
    annotations = annotations.filter((entry) => entry.id !== item.id);
    selectedAnnotation = null;
  }
  activeDrag = null;
  drawMode = false;
  suppressChartClick = true;
  setTimeout(() => { suppressChartClick = false; }, 0);
  saveAnnotations();
  renderAnnotations();
  try { $('#detail-chart').releasePointerCapture(event.pointerId); } catch { /* Capture already released. */ }
}

function openDetail(symbol) {
  if (!state) return;
  const quote = state.quotes.find((item) => item.symbol === symbol);
  if (!quote) return;
  previousFocus = document.activeElement;
  selectedSymbol = symbol;
  selectedRange = '1D';
  historyRequest += 1;
  eventsRequest += 1;
  lastChartKey = '';
  lastExaminedTime = null;
  pinnedTime = null;
  currentEvents = null;
  eventsError = null;
  rangeLoading = false;
  drawMode = false;
  showMA = false;
  if (symbol === PORTFOLIO_SYMBOL) showDividends = false;
  $('#chart-tools').hidden = true;
  $('#tools-toggle').setAttribute('aria-expanded', 'false');
  $('#chart-wrap').classList.remove('chart-wrap-loading');
  $('#detail-chart').setAttribute('aria-busy', 'false');
  $('#chart-selection').textContent = '—';
  $('#release-point').hidden = true;
  currentPoints = quote.points || [];
  document.querySelectorAll('[data-range]').forEach((button) => {
    const active = button.dataset.range === '1D';
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  overlay.hidden = false;
  $('main').inert = true;
  document.body.style.overflow = 'hidden';
  loadAnnotations();
  renderDetail(quote);
  updateTools();
  updateDividendSummary();
  if (symbol !== PORTFOLIO_SYMBOL) loadEventsForSymbol(symbol);
  else if (currentPoints.length < 2) chooseRange('1M');
  $('#detail-close').focus();
  renderQuotes();
}

function closeDetail() {
  closeMobileTargets();
  historyRequest += 1;
  eventsRequest += 1;
  rangeLoading = false;
  pinnedTime = null;
  overlay.hidden = true;
  document.body.style.overflow = '';
  $('main').inert = false;
  selectedSymbol = null;
  renderQuotes();
  if (previousFocus?.isConnected) previousFocus.focus();
}

function portfolioSignature() {
  return JSON.stringify(portfolioDraft.map(({ symbol, segments }) => ({ symbol, segments: [...segments].sort((a, b) => a - b) })));
}

const portfolioSpacesKey = 'mercado-en-luz:portfolio-spaces:v1';
const profileEnglish = document.documentElement.lang.toLowerCase().startsWith('en');
let portfolioSpaces = readPortfolioSpaces();
let portfolioSpacesReady = false;
let discardAction = null;
let discardReturnFocus = null;
let refreshGeneration = 0;

function readPortfolioSpaces() {
  const empty = { active: 0, slots: [null, null, null] };
  try {
    const saved = JSON.parse(localStorage.getItem(portfolioSpacesKey) || 'null');
    if (!saved || !Array.isArray(saved.slots) || saved.slots.length !== 3) return empty;
    const slots = saved.slots.map((slot) => {
      if (!Array.isArray(slot) || !slot.length || slot.length > 15) return null;
      const assets = slot.map((item) => ({
        symbol: typeof item?.symbol === 'string' ? item.symbol : '',
        segments: Array.isArray(item?.segments) ? item.segments.filter((n) => Number.isInteger(n) && n >= 0 && n <= 14) : [],
      }));
      return assets.every((item) => item.symbol && item.segments.length) ? assets : null;
    });
    return { active: Number.isInteger(saved.active) && saved.active >= 0 && saved.active < 3 ? saved.active : 0, slots };
  } catch { return empty; }
}

function savePortfolioSpaces() {
  try {
    localStorage.setItem(portfolioSpacesKey, JSON.stringify(portfolioSpaces));
    return true;
  } catch { return false; }
}

function currentPortfolioAssets() {
  return (state?.quotes || []).map(({ symbol, segments }) => ({ symbol, segments: [...segments] }));
}

function ensurePortfolioSpaces() {
  if (!state || state.demo || portfolioSpacesReady) return;
  portfolioSpacesReady = true;
  if (!portfolioSpaces.slots[portfolioSpaces.active]) {
    portfolioSpaces.slots[portfolioSpaces.active] = currentPortfolioAssets();
    savePortfolioSpaces();
  }
  renderPortfolioSpaces();
}

function renderPortfolioSpaces() {
  const group = $('.portfolio-profiles');
  if (!group || !state) return;
  group.hidden = false;
  for (const button of group.querySelectorAll('button[data-profile]')) {
    const index = Number(button.dataset.profile);
    const exists = Boolean(portfolioSpaces.slots[index]);
    button.textContent = exists ? String(index + 1) : '+' + (index + 1);
    button.setAttribute('aria-pressed', String(index === portfolioSpaces.active));
    button.setAttribute('aria-label', exists
      ? (profileEnglish ? 'Portfolio ' : 'Cartera ') + (index + 1)
      : (profileEnglish ? 'Create portfolio ' : 'Crear cartera ') + (index + 1) +
        (profileEnglish ? ' from the current one' : ' desde la actual'));
    button.disabled = portfolioSaving;
  }
}

function captureActivePortfolioSpace() {
  if (!state || !portfolioSpacesReady) return true;
  portfolioSpaces.slots[portfolioSpaces.active] = currentPortfolioAssets();
  return savePortfolioSpaces();
}

function resetPortfolioDraftFromState() {
  portfolioDraft = state.quotes.map(({ symbol, name, market, exchange, segments }) =>
    ({ symbol, name, market, exchange, segments: [...segments] }));
  portfolioOriginal = portfolioSignature();
  portfolioRevision = state.portfolio_revision || null;
  selectedPortfolioSymbol = null;
  clearRemovalUndo();
  $('#company-search').value = '';
  $('#search-results').replaceChildren();
  $('#search-results').classList.remove('has-error');
  updatePortfolioEditor();
}

function showDiscardConfirmation(action) {
  if (!$('#discard-confirm').hidden) return;
  discardAction = action;
  discardReturnFocus = document.activeElement;
  $('.portfolio-shell').inert = true;
  $('#discard-confirm').hidden = false;
  $('#discard-stay').focus();
}

function hideDiscardConfirmation() {
  $('#discard-confirm').hidden = true;
  $('.portfolio-shell').inert = false;
  discardAction = null;
  if (discardReturnFocus?.isConnected) discardReturnFocus.focus({ preventScroll: true });
  discardReturnFocus = null;
}

async function applyPortfolioSpace(index) {
  if (!state || portfolioSaving || index === portfolioSpaces.active) return;
  const current = currentPortfolioAssets();
  const target = portfolioSpaces.slots[index];
  if (!target || JSON.stringify(target) === JSON.stringify(current)) {
    portfolioSpaces.slots[portfolioSpaces.active] = current;
    portfolioSpaces.slots[index] = target || current.map(({ symbol, segments }) => ({ symbol, segments: [...segments] }));
    portfolioSpaces.active = index;
    const saved = savePortfolioSpaces();
    resetPortfolioDraftFromState();
    renderPortfolioSpaces();
    editorMessage(!saved
      ? (profileEnglish ? 'This device could not save the portfolio spaces.' : 'Este dispositivo no pudo guardar las carteras.')
      : !target
        ? (profileEnglish ? 'Portfolio ' : 'Cartera ') + (index + 1) +
          (profileEnglish ? ' created as a copy. You can edit it now.' : ' creada como copia. Ya puedes editarla.')
        : (profileEnglish ? 'Portfolio ' : 'Cartera ') + (index + 1) +
          (profileEnglish ? ' selected.' : ' seleccionada.'), !saved);
    return;
  }
  portfolioSaving = true;
  refreshGeneration += 1;
  updatePortfolioEditor();
  renderPortfolioSpaces();
  editorMessage(profileEnglish ? 'Opening saved portfolio…' : 'Abriendo la cartera guardada…');
  try {
    const response = await fetch('/api/portfolio', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: state.portfolio_revision, portfolio: target }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || (profileEnglish ? 'Could not open this portfolio' : 'No se pudo abrir esta cartera'));
    state = payload;
    portfolioSpaces.slots[portfolioSpaces.active] = current;
    portfolioSpaces.active = index;
    const saved = captureActivePortfolioSpace();
    portfolioSaving = false;
    resetPortfolioDraftFromState();
    renderPower();
    renderQuotes();
    renderAlerts();
    renderPortfolioSpaces();
    editorMessage(saved
      ? (profileEnglish ? 'Portfolio ' : 'Cartera ') + (index + 1) +
        (profileEnglish ? ' selected.' : ' seleccionada.')
      : (profileEnglish ? 'This device could not save the portfolio spaces.' : 'Este dispositivo no pudo guardar las carteras.'), !saved);
    setTimeout(refresh, 1000);
  } catch (error) {
    portfolioSaving = false;
    updatePortfolioEditor();
    renderPortfolioSpaces();
    editorMessage(error.message, true);
  }
}

function requestPortfolioSpace(index) {
  if (!state || portfolioSaving || index === portfolioSpaces.active) return;
  if (portfolioSignature() !== portfolioOriginal) {
    showDiscardConfirmation(() => {
      resetPortfolioDraftFromState();
      applyPortfolioSpace(index);
    });
  } else applyPortfolioSpace(index);
}

function editorMessage(message, error = false) {
  const node = $('#editor-status');
  node.textContent = message;
  node.classList.toggle('is-error', error);
  node.setAttribute('role', error ? 'alert' : 'status');
}

let removalUndo = null;
let removalUndoTimer = null;
function clearRemovalUndo() {
  clearTimeout(removalUndoTimer);
  removalUndo = null;
  $('#editor-undo').hidden = true;
  $('#editor-summary').hidden = false;
}

function offerRemovalUndo(asset, index) {
  clearRemovalUndo();
  removalUndo = { asset: { ...asset, segments: [...asset.segments] }, index };
  $('#undo-company').textContent = `${asset.symbol} quitada`;
  $('#editor-undo').hidden = false;
  $('#editor-summary').hidden = true;
  removalUndoTimer = setTimeout(clearRemovalUndo, 6500);
}

function revealSelectedSegments(symbol) {
  if (!matchMedia('(max-width: 700px)').matches) return;
  const index = portfolioDraft.find((item) => item.symbol === symbol)?.segments[0];
  if (index == null) return;
  requestAnimationFrame(() => {
    const viewport = $('.editor-segments-viewport');
    const segment = viewport.querySelector(`[data-segment="${index}"]`);
    if (!segment || portfolioOverlay.hidden) return;
    const view = viewport.getBoundingClientRect();
    const target = segment.getBoundingClientRect();
    viewport.scrollTo({
      left: viewport.scrollLeft + target.left + target.width / 2 - view.left - view.width / 2,
      behavior: reducedMotion.matches ? 'auto' : 'smooth',
    });
  });
}

const editorPalette = ['#7cc4ff', '#b59cff', '#f2c46d', '#5fd4c8', '#f59ac8', '#8fa8ff', '#ffab73', '#63d3f0', '#d6c08f', '#c9a7ff', '#9be0ff', '#ffc2a1', '#a3b8ff', '#e7d27a', '#8ee6d8'];
// Color de identidad de cada empresa en el editor: une la tira con su fila en la lista.
function editorTone(asset) {
  if (asset.symbol === PORTFOLIO_SYMBOL) return '#e9b888';
  const companies = portfolioDraft.filter((item) => item.symbol !== PORTFOLIO_SYMBOL);
  return editorPalette[Math.max(0, companies.indexOf(asset)) % editorPalette.length];
}

function updatePortfolioEditor() {
  const segments = $('#editor-segments');
  segments.replaceChildren();
  const owned = new Map(portfolioDraft.flatMap((asset) => asset.segments.map((segment) => [segment, asset])));
  const active = portfolioDraft.find((asset) => asset.symbol === selectedPortfolioSymbol);
  segments.classList.toggle('needs-assignment', Boolean(active && !active.segments.length));
  $('#editor-active').hidden = !active;
  $('#editor-active').classList.toggle('is-pro-average', active?.symbol === PORTFOLIO_SYMBOL);
  $('#active-company').textContent = active ? active.symbol === PORTFOLIO_SYMBOL ? 'Mi cartera · Media' : `${active.symbol} · ${active.name}` : '';
  segments.classList.toggle('has-active', Boolean(active));
  const runs = [];
  for (let index = 0; index < 15; index += 1) {
    const asset = owned.get(index) || null;
    const last = runs.at(-1);
    if (last && last.asset === asset) last.length += 1;
    else runs.push({ asset, start: index, length: 1 });
  }
  for (const run of runs) {
    const label = document.createElement('span');
    label.className = 'segment-label';
    label.style.gridColumn = `${run.start + 1} / span ${run.length}`;
    if (run.asset) {
      label.style.setProperty('--tone', editorTone(run.asset));
      label.textContent = run.asset.symbol === PORTFOLIO_SYMBOL ? 'MEDIA' : run.asset.symbol;
      label.classList.toggle('is-selected', run.asset === active);
      label.classList.toggle('is-dimmed', Boolean(active) && run.asset !== active);
    } else {
      label.classList.add('is-free');
      label.textContent = run.length > 1 ? 'Libre' : '';
    }
    segments.append(label);
  }
  for (const run of runs) {
    for (let index = run.start; index < run.start + run.length; index += 1) {
      const asset = run.asset;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'editor-segment';
      button.style.gridColumn = String(index + 1);
      if (asset) {
        button.classList.add('is-owned');
        button.style.setProperty('--tone', editorTone(asset));
        button.classList.toggle('is-run-start', index === run.start);
        button.classList.toggle('is-run-end', index === run.start + run.length - 1);
      }
      if (asset && asset === active) button.classList.add('is-selected');
      else if (active && (!asset || asset.segments.length > 1)) button.classList.add('is-assignment-target');
      else if (active && asset) { button.classList.add('is-blocked'); button.disabled = true; }
      button.dataset.segment = String(index);
      button.setAttribute('aria-pressed', String(Boolean(asset && asset === active)));
      button.innerHTML = `<span class="segment-dot"></span><span class="segment-index">${String(index).padStart(2, '0')}</span><span class="segment-action" aria-hidden="true"></span>`;
      const action = !active ? (asset ? `Seleccionar ${asset.symbol}` : 'Elige una empresa')
        : asset === active ? `Liberar de ${active.symbol}`
        : asset && asset.segments.length === 1 ? `${asset.symbol} necesita otro segmento antes de moverlo`
        : `Asignar a ${active.symbol}`;
      button.querySelector('.segment-action').textContent = !active ? '' : asset === active ? '−' : asset && asset.segments.length === 1 ? '' : '+';
      button.setAttribute('aria-label', `Segmento ${index}: ${asset?.name || 'libre'}. ${action}.`);
      button.addEventListener('click', (event) => {
        assignSegment(index);
        if (event.detail === 0) segments.querySelector(`[data-segment="${index}"]`)?.focus();
      });
      button.addEventListener('dragover', (event) => { event.preventDefault(); button.classList.add('is-drop-target'); });
      button.addEventListener('dragleave', () => button.classList.remove('is-drop-target'));
      button.addEventListener('drop', (event) => {
        event.preventDefault();
        button.classList.remove('is-drop-target');
        const symbol = event.dataTransfer.getData('text/plain');
        if (portfolioDraft.some((item) => item.symbol === symbol)) {
          selectedPortfolioSymbol = symbol;
          if (owned.get(index)?.symbol !== symbol) assignSegment(index);
          else updatePortfolioEditor();
        }
      });
      segments.append(button);
    }
  }
  const companies = $('#editor-companies');
  companies.replaceChildren();
  for (const asset of portfolioDraft) {
    const card = document.createElement('div');
    card.className = 'editor-company';
    card.classList.toggle('is-pro-average', asset.symbol === PORTFOLIO_SYMBOL);
    card.dataset.symbol = asset.symbol;
    card.style.setProperty('--tone', editorTone(asset));
    card.classList.toggle('is-selected', asset.symbol === selectedPortfolioSymbol);
    const select = document.createElement('button');
    select.type = 'button';
    select.draggable = true;
    select.className = 'editor-company-select';
    select.addEventListener('dragstart', (event) => {
      selectedPortfolioSymbol = asset.symbol;
      event.dataTransfer.setData('text/plain', asset.symbol);
      event.dataTransfer.effectAllowed = 'move';
    });
    select.innerHTML = '<span class="company-selection company-swatch" aria-hidden="true"></span><span class="company-symbol"></span><span class="company-name"></span><span class="company-segments"></span><span class="company-minimap" aria-hidden="true"></span>';
    select.querySelector('.company-selection').textContent = asset.symbol === selectedPortfolioSymbol ? '✓' : '';
    const minimap = select.querySelector('.company-minimap');
    for (let index = 0; index < 15; index += 1) {
      const tick = document.createElement('i');
      tick.classList.toggle('is-owned', asset.segments.includes(index));
      minimap.append(tick);
    }
    select.querySelector('.company-symbol').textContent = asset.symbol === PORTFOLIO_SYMBOL ? 'MEDIA' : asset.symbol;
    select.querySelector('.company-name').textContent = asset.name;
    select.querySelector('.company-segments').textContent = !asset.segments.length ? 'Sin segmento' : asset.segments.length === 1 ? `Segmento ${asset.segments[0]}` : `Segmentos ${[...asset.segments].sort((a, b) => a - b).join(', ')}`;
    select.classList.toggle('needs-segment', !asset.segments.length);
    select.setAttribute('aria-pressed', String(asset.symbol === selectedPortfolioSymbol));
    select.setAttribute('aria-label', `${asset.name}, ${asset.symbol === PORTFOLIO_SYMBOL ? 'media de cartera' : asset.symbol}. ${asset.symbol === selectedPortfolioSymbol ? 'Seleccionada' : 'Seleccionar'}`);
    select.addEventListener('click', (event) => {
      selectedPortfolioSymbol = selectedPortfolioSymbol === asset.symbol ? null : asset.symbol;
      updatePortfolioEditor();
      if (selectedPortfolioSymbol) revealSelectedSegments(selectedPortfolioSymbol);
      editorMessage(selectedPortfolioSymbol ? `${asset.name} activa. Toca un segmento para cambiar su asignación.` : 'Selección cancelada. Elige una empresa para editarla.');
      if (event.detail === 0) [...companies.querySelectorAll('.editor-company')].find((row) => row.dataset.symbol === asset.symbol)?.querySelector('.editor-company-select')?.focus();
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'editor-company-remove';
    remove.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8"/></svg>';
    remove.title = 'Quitar';
    remove.setAttribute('aria-label', `Quitar ${asset.name}`);
    remove.addEventListener('click', (event) => {
      const previousIndex = [...companies.children].indexOf(card);
      clearRemovalUndo();
      portfolioDraft = portfolioDraft.filter((item) => item.symbol !== asset.symbol);
      if (selectedPortfolioSymbol === asset.symbol) selectedPortfolioSymbol = null;
      updatePortfolioEditor();
      offerRemovalUndo(asset, previousIndex);
      if (portfolioDraft.length) editorMessage(`${asset.name} quitada.`);
      if (event.detail === 0) companies.querySelectorAll('.editor-company-select')[Math.min(previousIndex, portfolioDraft.length - 1)]?.focus();
    });
    card.append(select, remove);
    companies.append(card);
  }
  const hasAverage = portfolioDraft.some((item) => item.symbol === PORTFOLIO_SYMBOL);
  $('.company-section-head > span:first-child').textContent = hasAverage ? 'VALORES' : 'EMPRESAS';
  $('#company-count').textContent = `${portfolioDraft.length} ${hasAverage ? 'VALORES' : portfolioDraft.length === 1 ? 'EMPRESA' : 'EMPRESAS'}`;
  $('#editor-summary').textContent = `${owned.size} / 15 segmentos`;
  const dirty = portfolioSignature() !== portfolioOriginal;
  $('.portfolio-footer').classList.toggle('has-changes', dirty);
  const valid = portfolioDraft.length > 0 && portfolioDraft.every((item) => item.segments.length > 0);
  $('#portfolio-save').disabled = portfolioSaving || !dirty || !valid || !portfolioRevision;
  if (!valid) {
    const pending = portfolioDraft.find((item) => !item.segments.length);
    editorMessage(portfolioDraft.length ? `${pending?.symbol === PORTFOLIO_SYMBOL ? 'La media' : pending?.symbol} necesita un segmento.` : 'Añade una empresa para guardar.', true);
  }
  if (!$('#company-search').value.trim()) renderQuickPicks();
}

function assignSegment(index) {
  if (!selectedPortfolioSymbol) {
    const owner = portfolioDraft.find((item) => item.segments.includes(index));
    if (owner) {
      selectedPortfolioSymbol = owner.symbol;
      updatePortfolioEditor();
      editorMessage(`${owner.name} activa. Toca los segmentos para editar su asignación.`);
    } else editorMessage('Elige primero una empresa; después podrás asignarle este segmento.', true);
    return;
  }
  const target = portfolioDraft.find((item) => item.symbol === selectedPortfolioSymbol);
  const owner = portfolioDraft.find((item) => item.segments.includes(index));
  if (!target) return;
  if (owner === target) {
    if (target.segments.length === 1) { editorMessage('Cada empresa necesita al menos un segmento. Puedes quitarla entera con «Quitar».', true); return; }
    target.segments = target.segments.filter((segment) => segment !== index);
    editorMessage(`Segmento ${index} liberado. Guarda para aplicarlo.`);
  } else {
    if (owner && owner.segments.length === 1) { editorMessage(`${owner.name} se quedaría sin segmentos. Asígnale otro antes de mover este.`, true); return; }
    if (owner) owner.segments = owner.segments.filter((segment) => segment !== index);
    target.segments.push(index);
    target.segments.sort((a, b) => a - b);
    editorMessage(`Segmento ${index} asignado a ${target.symbol}. Guarda para aplicarlo.`);
  }
  clearRemovalUndo();
  updatePortfolioEditor();
  if (!reducedMotion.matches) {
    $('#editor-segments').querySelector(`[data-segment="${index}"]`)?.animate([
      { boxShadow: 'inset 0 -2px #a5efc3, 0 0 24px #8de6b438' },
      { boxShadow: 'inset 0 -2px transparent, 0 0 0 transparent' },
    ], { duration: 550, easing: 'ease-out' });
  }
}

let editorMotionTimer;
function closePortfolioEditor() {
  if (portfolioSaving || portfolioOverlay.hidden) return;
  if (!$('#discard-confirm').hidden) { hideDiscardConfirmation(); return; }
  if (portfolioSignature() !== portfolioOriginal) {
    showDiscardConfirmation(finishClosePortfolioEditor);
    return;
  }
  finishClosePortfolioEditor();
}

function finishClosePortfolioEditor() {
  if (portfolioSaving || portfolioOverlay.hidden || portfolioOverlay.classList.contains('is-closing')) return;
  searchSequence += 1;
  clearTimeout(searchTimer);
  clearRemovalUndo();
  clearTimeout(editorMotionTimer);
  portfolioOverlay.classList.remove('is-entering');
  portfolioOverlay.classList.add('is-closing');
  editorMotionTimer = setTimeout(() => {
    portfolioOverlay.hidden = true;
    portfolioOverlay.classList.remove('is-closing');
    document.body.style.overflow = '';
    $('main').inert = false;
    if (portfolioPreviousFocus?.isConnected) portfolioPreviousFocus.focus({ preventScroll: true });
  }, reducedMotion.matches ? 0 : 180);
}

function openPortfolioEditor() {
  if (!state) return;
  ensurePortfolioSpaces();
  portfolioPreviousFocus = document.activeElement;
  resetPortfolioDraftFromState();
  renderPortfolioSpaces();
  editorMessage(portfolioRevision ? '' : 'Reinicia el programa para activar el editor.', !portfolioRevision);
  portfolioOverlay.hidden = false;
  portfolioOverlay.classList.add('is-entering');
  clearTimeout(editorMotionTimer);
  editorMotionTimer = setTimeout(() => portfolioOverlay.classList.remove('is-entering'), 850);
  $('main').inert = true;
  document.body.style.overflow = 'hidden';
  $('#portfolio-close').focus();
}

async function searchCompanies(term) {
  const sequence = ++searchSequence;
  const results = $('#search-results');
  if (term.trim().length < 2) { results.replaceChildren(); results.classList.remove('has-error'); return; }
  results.classList.remove('has-error');
  results.textContent = 'Buscando empresas…';
  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(term.trim())}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'No se pudo buscar');
    if (sequence !== searchSequence || portfolioOverlay.hidden) return;
    results.replaceChildren();
    if (!payload.results.length) { results.textContent = 'Sin resultados en EE. UU. o Madrid. Prueba otro nombre o símbolo.'; return; }
    for (const asset of payload.results) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'search-result';
      button.innerHTML = '<strong></strong><span></span><small></small>';
      button.querySelector('strong').textContent = asset.symbol;
      button.querySelector('span').textContent = asset.name;
      button.querySelector('small').textContent = asset.market === 'ES' ? 'Madrid' : 'EE. UU.';
      button.addEventListener('click', () => addPortfolioAsset(asset));
      results.append(button);
    }
  } catch (error) {
    if (sequence === searchSequence) {
      results.textContent = `Búsqueda no disponible: ${error.message}`;
      results.classList.add('has-error');
    }
  }
}

function addPortfolioAsset(asset) {
  const existing = portfolioDraft.find((item) => item.symbol === asset.symbol);
  if (existing) {
    selectedPortfolioSymbol = asset.symbol;
    updatePortfolioEditor();
    revealSelectedSegments(asset.symbol);
    editorMessage(`${asset.symbol} seleccionada.`);
    return;
  }
  if (portfolioDraft.length >= 15) { editorMessage('Máximo 15 empresas. Quita una para continuar.', true); return; }
  const occupied = new Set(portfolioDraft.flatMap((item) => item.segments));
  const free = Array.from({ length: 15 }, (_, index) => index).find((index) => !occupied.has(index));
  if (free === undefined && !portfolioDraft.some((item) => item.segments.length > 1)) {
    editorMessage('Libera un segmento para añadir otra empresa.', true);
    return;
  }
  clearRemovalUndo();
  portfolioDraft.push({ ...asset, segments: free === undefined ? [] : [free] });
  selectedPortfolioSymbol = asset.symbol;
  updatePortfolioEditor();
  revealSelectedSegments(asset.symbol);
  editorMessage(free === undefined
    ? asset.symbol === PORTFOLIO_SYMBOL ? 'Elige para la media un tramo de una empresa que tenga varios.' : `${asset.symbol} necesita un segmento.`
    : `${asset.symbol === PORTFOLIO_SYMBOL ? 'Media de cartera' : asset.symbol} añadida.`, free === undefined);
}

function renderQuickPicks() {
  const results = $('#search-results');
  results.replaceChildren();
  for (const asset of quickPicks.filter((item) => !portfolioDraft.some((draft) => draft.symbol === item.symbol)).slice(0, 4)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'search-result';
    button.innerHTML = '<strong></strong><span></span>';
    button.querySelector('strong').textContent = asset.symbol;
    button.querySelector('span').textContent = asset.name;
    button.setAttribute('aria-label', `Añadir ${asset.name}`);
    button.addEventListener('click', () => addPortfolioAsset(asset));
    results.append(button);
  }
}

async function savePortfolioEditor() {
  if (portfolioSaving || !portfolioRevision) return;
  portfolioSaving = true;
  refreshGeneration += 1;
  updatePortfolioEditor();
  editorMessage('Guardando y actualizando la cartera…');
  try {
    const response = await fetch('/api/portfolio', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: portfolioRevision, portfolio: portfolioDraft.map(({ symbol, segments }) => ({ symbol, segments })) }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'No se pudieron guardar los cambios');
    state = payload;
    const spaceSaved = captureActivePortfolioSpace();
    portfolioSaving = false;
    finishClosePortfolioEditor();
    renderPower();
    renderQuotes();
    renderAlerts();
    if (carouselDialog.open) renderCarousel();
    $('#market-notice').textContent = spaceSaved
      ? 'Cartera guardada. La tira se actualizará con las nuevas cotizaciones.'
      : 'Cartera aplicada, pero este dispositivo no pudo guardar sus espacios de cartera.';
    setTimeout(refresh, 1000);
  } catch (error) {
    portfolioSaving = false;
    updatePortfolioEditor();
    editorMessage(error.message, true);
  }
}

async function refresh() {
  if (portfolioSaving) return;
  const generation = refreshGeneration;
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) throw new Error('No se pudo consultar el estado');
    const next = await response.json();
    if (generation !== refreshGeneration || portfolioSaving) return;
    state = next;
    serverUnreachable = false;
    retryDeadline = Number.isFinite(next.retry_in) ? Date.now() + next.retry_in * 1000 : null;
    if (next.pro && next.pro.enabled === false && !next.demo && !proSaving) saveProSettings(proDraft()).catch(() => {});
    ensurePortfolioSpaces();
    renderPower();
    renderQuotes();
    renderAlerts();
    if (carouselDialog.open && !carouselSaving) renderCarousel();
    if (selectedSymbol) renderDetail(state.quotes.find((quote) => quote.symbol === selectedSymbol));
  } catch {
    if (generation !== refreshGeneration || portfolioSaving) return;
    serverUnreachable = true;
    scene.classList.remove('is-on');
    $('#power-word').textContent = connectionCopy.wordOffline;
    powerButton.setAttribute('aria-pressed', 'mixed');
    renderConnection();
    setAppAlert('market-alert', connectionCopy.marketPaused, connectionCopy.marketPausedTitle);
    powerButton.disabled = true;
  } finally {
    scheduleRefresh();
  }
}

function introScrollFloor() {
  return Math.max(1, intro.offsetHeight - window.innerHeight);
}

function enforceIntroFloor() {
  const floor = introScrollFloor();
  if (!introCompleted && window.scrollY >= floor - 1) introCompleted = true;
  if (introCompleted && window.scrollY < floor) window.scrollTo(0, floor);
}

function updateScroll() {
  enforceIntroFloor();
  if (!introGeometry) {
    const activation = $('#activation');
    const height = scene.clientHeight;
    introGeometry = {
      center: activation.offsetTop + powerButton.offsetTop + powerButton.offsetHeight / 2,
      end: Math.min(height - 85, Math.max(height * .73, activation.offsetTop + activation.offsetHeight + 85)),
    };
  }
  const distance = introScrollFloor();
  const target = Math.max(0, Math.min(1, (introCompleted ? Math.max(window.scrollY, distance) : window.scrollY) / distance));
  displayedScroll = reducedMotion.matches || Math.abs(target - displayedScroll) < .0008
    ? target : displayedScroll + (target - displayedScroll) * .18;
  const progress = displayedScroll;
  const phase = (start, end) => {
    const value = Math.max(0, Math.min(1, (progress - start) / (end - start)));
    return value * value * (3 - 2 * value);
  };
  const reveal = phase(.08, .55);
  const stripReveal = phase(.29, .82);
  document.documentElement.style.setProperty('--intro-progress', progress.toFixed(4));
  document.documentElement.style.setProperty('--stage-y', `${introGeometry.end.toFixed(2)}px`);
  document.documentElement.style.setProperty('--control-y', `${introGeometry.center.toFixed(2)}px`);
  document.documentElement.style.setProperty('--strip-progress', stripReveal.toFixed(4));
  document.documentElement.style.setProperty('--strip-inset', `${((1 - stripReveal) * 50).toFixed(2)}%`);
  document.documentElement.style.setProperty('--reveal-progress', reveal.toFixed(4));
  scene.classList.toggle('is-ready', progress > .53);
  $('#activation').inert = progress <= .53;
  const settled = progress > .82;
  scene.classList.toggle('is-settled', settled);
  stripHitboxes.setAttribute('aria-hidden', String(!settled));
  for (const button of stripHitboxes.children) button.tabIndex = settled ? 0 : -1;
  if (!settled && stripActiveSegment !== null) {
    stripPinnedSegment = null;
    clearStripPreview();
  }
  scrollQueued = Math.abs(target - displayedScroll) >= .0008;
  if (scrollQueued) requestAnimationFrame(updateScroll);
}

function queueScroll() {
  enforceIntroFloor();
  if (!scrollQueued) {
    scrollQueued = true;
    requestAnimationFrame(updateScroll);
  }
}
window.addEventListener('scroll', queueScroll, { passive: true });
window.addEventListener('resize', queueScroll);
$('#scroll-hint').addEventListener('click', (event) => {
  event.preventDefault();
  window.scrollTo({ top: introScrollFloor(), behavior: reducedMotion.matches ? 'auto' : 'smooth' });
});
$('.brand').addEventListener('click', (event) => {
  if (!introCompleted) return;
  event.preventDefault();
  window.scrollTo({ top: introScrollFloor(), behavior: reducedMotion.matches ? 'auto' : 'smooth' });
});
powerButton.addEventListener('click', async () => {
  if (!state || state.demo || state.busy) return;
  powerConnecting = true;
  powerButton.disabled = true;
  renderPower();
  scheduleRefresh();
  try {
    const response = await fetch('/api/power', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: !state.on }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'No se pudo cambiar el estado');
    state = result;
    powerConnecting = false;
    renderPower();
    setTimeout(refresh, 500);
  } catch (error) {
    powerConnecting = false;
    renderPower();
    setAppAlert('power-alert', error.message, 'No se pudo cambiar la tira');
    scheduleRefresh();
  }
});
$('#power-retry').addEventListener('click', () => (serverUnreachable ? refresh() : requestReconnect(false)));
$('#power-forget').addEventListener('click', () => requestReconnect(true));
$('#connection-change').addEventListener('click', () => requestReconnect(true));
$('#detail-close').addEventListener('click', closeDetail);
overlay.addEventListener('click', (event) => { if (event.target === overlay) closeDetail(); });
$('#edit-portfolio-button').addEventListener('click', openPortfolioEditor);
$('#portfolio-close').addEventListener('click', closePortfolioEditor);
$('#portfolio-cancel').addEventListener('click', closePortfolioEditor);
$('#portfolio-save').addEventListener('click', savePortfolioEditor);
for (const button of document.querySelectorAll('.portfolio-profiles button[data-profile]')) {
  button.addEventListener('click', () => requestPortfolioSpace(Number(button.dataset.profile)));
}
$('#discard-stay').addEventListener('click', hideDiscardConfirmation);
$('#discard-changes').addEventListener('click', () => {
  const action = discardAction;
  hideDiscardConfirmation();
  action?.();
});
$('#discard-confirm').addEventListener('click', (event) => {
  if (event.target.id === 'discard-confirm') hideDiscardConfirmation();
});
$('#undo-remove').addEventListener('click', () => {
  if (!removalUndo) return;
  const { asset, index } = removalUndo;
  clearRemovalUndo();
  if (portfolioDraft.some((item) => item.symbol === asset.symbol)) return;
  portfolioDraft.splice(Math.min(index, portfolioDraft.length), 0, asset);
  selectedPortfolioSymbol = asset.symbol;
  updatePortfolioEditor();
  revealSelectedSegments(asset.symbol);
  editorMessage(`${asset.symbol} recuperada.`);
});
$('#clear-selection').addEventListener('click', () => {
  selectedPortfolioSymbol = null;
  updatePortfolioEditor();
  editorMessage('Selección cancelada. Elige una empresa para editarla.');
});
portfolioOverlay.addEventListener('click', (event) => { if (event.target === portfolioOverlay) closePortfolioEditor(); });
portfolioOverlay.addEventListener('pointerdown', (event) => {
  for (const menu of portfolioOverlay.querySelectorAll('.company-actions[open]')) {
    if (!menu.contains(event.target)) menu.open = false;
  }
});
$('#company-search').addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  searchSequence += 1;
  const term = event.target.value;
  if (term.trim().length < 2) { if (term.trim()) $('#search-results').replaceChildren(); else renderQuickPicks(); return; }
  searchTimer = setTimeout(() => searchCompanies(term), 320);
});
document.addEventListener('keydown', (event) => {
  if (!$('#discard-confirm').hidden) {
    if (event.key === 'Escape') { event.preventDefault(); hideDiscardConfirmation(); }
    if (event.key === 'Tab') {
      const first = $('#discard-stay'), last = $('#discard-changes');
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    return;
  }
  if (!portfolioOverlay.hidden) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (!$('#portfolio-save').disabled) savePortfolioEditor();
      return;
    }
    if (event.key === 'Escape') {
      const openMenu = portfolioOverlay.querySelector('.company-actions[open]');
      if (openMenu) { openMenu.open = false; openMenu.querySelector('summary')?.focus(); }
      else closePortfolioEditor();
      return;
    }
    if (event.key === 'Tab') {
    const controls = [...portfolioOverlay.querySelectorAll('button:not(:disabled), input:not(:disabled), summary')].filter((node) => node.getClientRects().length);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    return;
  }
  if (event.key === 'Escape' && !overlay.hidden) {
    if ($('#detail-targets').classList.contains('is-open')) {
      closeMobileTargets();
      $('#detail-target-toggle').focus({ preventScroll: true });
    } else if (pinnedTime) unpinChartPoint();
    else closeDetail();
    return;
  }
  if ((event.key === 'Delete' || event.key === 'Backspace') && !overlay.hidden && selectedAnnotation) {
    annotations = annotations.filter((item) => item.id !== selectedAnnotation);
    selectedAnnotation = null;
    saveAnnotations();
    renderAnnotations();
  }
  if (event.key === 'Tab' && !overlay.hidden) {
    const controls = [...overlay.querySelectorAll('button:not(:disabled), [tabindex="0"]')].filter((node) => node.getClientRects().length);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
document.querySelectorAll('[data-range]').forEach((button) => button.addEventListener('click', () => chooseRange(button.dataset.range)));
$('#tools-toggle').addEventListener('click', (event) => {
  const tools = $('#chart-tools');
  tools.hidden = !tools.hidden;
  $('#tools-toggle').setAttribute('aria-expanded', String(!tools.hidden));
  if (!tools.hidden && event.detail === 0) tools.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
});
$('#ma200-button').addEventListener('click', () => {
  if (selectedRange === '1D') return;
  showMA = !showMA;
  updateTools();
  renderChart();
});
$('#dividend-button').addEventListener('click', () => {
  showDividends = !showDividends;
  updateTools();
  renderChart();
  updateDividendSummary();
});
$('#release-point').addEventListener('click', () => {
  unpinChartPoint();
  $('#detail-chart').focus({ preventScroll: true });
});
$('#rect-button').addEventListener('click', () => {
  drawMode = !drawMode;
  updateTools();
});
$('#duplicate-button').addEventListener('click', () => {
  const source = annotations.find((item) => item.id === selectedAnnotation);
  if (!source) return;
  const dx = source.x2 > 960 ? -22 : 22;
  const dy = source.y2 > 325 ? -18 : 18;
  const copy = { id: `${Date.now()}-${Math.random()}`, x1: source.x1 + dx, x2: source.x2 + dx, y1: source.y1 + dy, y2: source.y2 + dy };
  annotations.push(copy);
  selectedAnnotation = copy.id;
  saveAnnotations();
  renderAnnotations();
});
$('#delete-button').addEventListener('click', () => {
  annotations = annotations.filter((item) => item.id !== selectedAnnotation);
  selectedAnnotation = null;
  saveAnnotations();
  renderAnnotations();
});
$('#detail-chart').addEventListener('pointerdown', chartPointerDown);
$('#detail-chart').addEventListener('click', chartClick);
$('#detail-chart').addEventListener('keydown', chartKeydown);
$('#detail-chart').addEventListener('pointermove', chartPointerMove);
$('#detail-chart').addEventListener('pointerup', chartPointerUp);
$('#detail-chart').addEventListener('pointercancel', chartPointerUp);
$('#detail-chart').addEventListener('pointerleave', () => {
  if (!activeDrag && !pinnedTime) {
    $('#chart-tooltip').hidden = true;
    $('#hover-layer')?.replaceChildren();
    $('#chart-selection').textContent = lastChartReadout();
  }
});
const chartResizeObserver = new ResizeObserver(() => {
  if (overlay.hidden || rangeLoading || activeDrag) return;
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    const wrap = $('#chart-wrap');
    if (overlay.hidden || rangeLoading || activeDrag) return;
    if (!chartView || Math.abs(wrap.clientWidth - chartView.width) > 1 || Math.abs(wrap.clientHeight - chartView.height) > 1) renderChart();
  });
});
chartResizeObserver.observe($('#chart-wrap'));
const introResizeObserver = new ResizeObserver(() => { introGeometry = null; queueScroll(); });
introResizeObserver.observe(scene);
introResizeObserver.observe($('#activation'));
document.documentElement.classList.add('motion-ready');
revealObserver.observe($('.market'));
initializeStripPreview();
updateScroll();
refresh();
