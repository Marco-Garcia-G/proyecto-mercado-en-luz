// Translate API messages for the English interface without changing its data contract.
const browserFetch = window.fetch.bind(window);
const messages = new Map(Object.entries({
  'Mi cartera': 'My portfolio',
  'MEDIA EQUIPONDERADA': 'EQUAL-WEIGHT AVERAGE',
  'Activa Bluetooth en el iPhone': 'Turn on Bluetooth on the phone',
  'Activa el Bluetooth del móvil': 'Turn on Bluetooth on the phone',
  'Concede permiso de Bluetooth para conectar la tira': 'Allow Bluetooth access to connect the strip',
  'Permite el acceso a Bluetooth para conectar la tira': 'Allow Bluetooth access to connect the strip',
  'No se pudo conectar con la H617A': 'Could not connect to the H617A',
  'No encuentro la H617A. Acerca el iPhone a la tira': 'H617A not found. Move the phone closer to the strip',
  'No encuentro la H617A. Acerca el móvil a la tira': 'H617A not found. Move the phone closer to the strip',
  'No se puede buscar la tira por Bluetooth': 'The strip cannot be searched for over Bluetooth',
  'La tira no ofrece el control esperado': 'The strip does not support the expected control',
  'No se pudo leer el estado de la tira': 'Could not read the strip status',
  'La tira no respondió a la consulta': 'The strip did not respond',
  'La tira no confirmó el cambio de estado': 'The strip did not confirm the power change',
  'La tira no aceptó el comando Bluetooth': 'The strip did not accept the Bluetooth command',
  'Error de Bluetooth': 'Bluetooth error',
  'No se pudo iniciar la actualización en segundo plano': 'Background updates could not start',
  'El proveedor de cotizaciones no está disponible': 'The quote provider is unavailable',
  'Respuesta bursátil no válida': 'Invalid market data response',
  'Sin precios para este símbolo': 'No prices for this ticker',
  'Símbolo no válido': 'Invalid ticker',
  'Periodo no válido': 'Invalid period',
  'Sin histórico': 'No price history',
  'Ruta no válida': 'Invalid route',
  'Ruta desconocida': 'Unknown route',
  'Estado no válido': 'Invalid state',
  'La cartera cambió; vuelve a abrir el editor': 'The portfolio changed; reopen the editor',
  'La cartera admite entre 1 y 15 valores': 'The portfolio needs 1 to 15 holdings',
  'La cartera admite entre 1 y 15 empresas': 'The portfolio needs 1 to 15 companies',
  'Símbolo o segmentos no válidos': 'Invalid ticker or segments',
  'Símbolo repetido o inválido': 'Duplicate or invalid ticker',
  'Segmento repetido o inválido': 'Duplicate or invalid segment',
  'La media necesita al menos una empresa real': 'The average needs at least one company',
  'Ajustes Pro no válidos': 'Invalid Pro settings',
  'Media no válida': 'Invalid average',
  'Los pesos de la media deben sumar 100 %': 'Average weights must add up to 100%',
  'Objetivo no válido': 'Invalid target',
  'Precio objetivo no válido': 'Invalid target price',
  'El stop debe ser menor que el objetivo': 'The stop must be below the target',
  'Lista del carrusel no válida': 'Invalid carousel list',
  'Carrusel no válido': 'Invalid carousel',
  'Añade al menos una empresa': 'Add at least one company',
  'La media necesita empresas': 'The average needs companies',
  'Falta el histórico de una empresa': 'Price history is missing for a company',
  'No hay suficientes cierres para la media': 'Not enough closing prices for the average',
  'Error de la app': 'App error',
  'Error interno': 'Internal error',
  'Origen no permitido': 'Origin not allowed',
  'No pude consultar los eventos de esta empresa': 'Could not load events for this company',
  'La búsqueda no está disponible ahora. Inténtalo de nuevo': 'Search is unavailable right now. Try again',
  'Carrusel no válido': 'Invalid carousel',
  'Símbolo de empresa no válido': 'Invalid company ticker',
  'Mi cartera no se añade al carrusel': 'The portfolio average cannot be added to the carousel',
  'enabled debe ser verdadero o falso': 'enabled must be true or false',
  'No llegó la confirmación Bluetooth; comprueba la tira': 'Bluetooth confirmation did not arrive; check the strip',
  'Periodo desconocido': 'Unknown period',
  'Empresa desconocida': 'Unknown company',
  'No hay suficientes cierres para la media de cartera': 'Not enough closing prices for the portfolio average',
  'Escribe al menos dos letras para buscar': 'Enter at least two letters to search',
  'Falta la versión de la cartera; vuelve a abrir el editor': 'Portfolio version is missing; reopen the editor',
  'Elige entre 1 y 15 empresas para esta tira': 'Choose 1 to 15 companies for this strip',
  'Empresa inválida': 'Invalid company',
  'Cada empresa necesita un símbolo y segmentos': 'Each company needs a ticker and segments',
  'Disponible en este Mac o en su red Wi-Fi si se activa --lan': 'Available on this Mac or its Wi-Fi network when --lan is enabled',
  'Se espera JSON': 'JSON is required',
  'Petición demasiado grande o vacía': 'Request is too large or empty',
  'Se espera un objeto JSON': 'A JSON object is required',
  'No pude guardar la cartera en el Mac': 'Could not save the portfolio on this Mac',
  'No pude guardar la cartera. Inténtalo de nuevo': 'Could not save the portfolio. Try again',
  'No pude guardar los ajustes Pro': 'Could not save Pro settings',
  'No pude guardar la lista del carrusel': 'Could not save the carousel list',
  'on debe ser verdadero o falso': 'on must be true or false',
  'La tira sigue ocupada; inténtalo de nuevo': 'The strip is still busy; try again',
  'sin cotizaciones intradía ni diarias': 'no intraday or daily quotes',
  'sin cierre diario anterior': 'no previous daily close',
  'precio diario inválido': 'invalid daily price',
  'no hay histórico disponible': 'no price history available',
  'no hay cierres válidos': 'no valid closing prices',
}));

function translateMessage(value) {
  if (messages.has(value)) return messages.get(value);
  let match = value.match(/^(\d+) cotizaciones no disponibles ahora$/);
  if (match) return `${match[1]} quotes unavailable right now`;
  match = value.match(/^No encontré (.+) en las bolsas admitidas$/);
  if (match) return `${match[1]} was not found on supported exchanges`;
  match = value.match(/^Sin (?:cotizaciones|precios|datos) para (.+)$/);
  if (match) return `No prices for ${match[1]}`;
  match = value.match(/^Proveedor sin datos para (.+)$/);
  if (match) return `Provider has no data for ${match[1]}`;
  match = value.match(/^Cotización no disponible para (.+)$/);
  if (match) return `Quote unavailable for ${match[1]}`;
  match = value.match(/^Peso no válido para (.+)$/);
  if (match) return `Invalid weight for ${match[1]}`;
  match = value.match(/^Objetivo no válido para (.+)$/);
  if (match) return `Invalid target for ${match[1]}`;
  match = value.match(/^El proveedor de cotizaciones no está disponible \((\d+)\)$/);
  if (match) return `The quote provider is unavailable (${match[1]})`;
  match = value.match(/^No pude verificar (.+) ahora\. Inténtalo de nuevo$/);
  if (match) return `Could not verify ${match[1]} right now. Try again`;
  match = value.match(/^No pude verificar (.+) como acción de Madrid o EE\. UU\.$/);
  if (match) return `Could not verify ${match[1]} as a Madrid or US stock`;
  if (value.startsWith('No pude leer el estado inicial: ')) return `Could not read the initial status: ${translateMessage(value.slice('No pude leer el estado inicial: '.length))}`;
  if (value.startsWith('Destellos: ')) return `Flashes: ${translateMessage(value.slice('Destellos: '.length))}`;
  if (value.startsWith('Carrusel: ')) return `Carousel: ${translateMessage(value.slice('Carrusel: '.length))}`;
  if (value.startsWith('No pude cargar el histórico: ')) return `Could not load price history: ${translateMessage(value.slice('No pude cargar el histórico: '.length))}`;
  return value;
}

function localizePayload(value, key = '') {
  if (Array.isArray(value)) return value.map((item) => localizePayload(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, localizePayload(item, field)]));
  }
  if (typeof value === 'string' && ['error', 'market_error', 'ble_error', 'name', 'exchange'].includes(key)) {
    return translateMessage(value);
  }
  return value;
}

window.fetch = async (input, options = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.startsWith('/api/')) return browserFetch(input, options);
  let response;
  if (window.AndroidBridge || window.webkit?.messageHandlers?.iosBridge) {
    const request = { method: options.method || 'GET', url, body: options.body || '' };
    const result = window.AndroidBridge
      ? JSON.parse(window.AndroidBridge.request(request.method, request.url, request.body))
      : await window.webkit.messageHandlers.iosBridge.postMessage(request);
    response = new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } else {
    response = await browserFetch(input, options);
  }
  const body = await response.clone().json().catch(() => null);
  if (!body) return response;
  return new Response(JSON.stringify(localizePayload(body)), {
    status: response.status,
    headers: { 'Content-Type': 'application/json' },
  });
};
