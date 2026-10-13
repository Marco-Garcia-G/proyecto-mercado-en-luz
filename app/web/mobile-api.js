// La web local sigue usando fetch; las apps móviles sustituyen solo su API local.
if (window.AndroidBridge || window.webkit?.messageHandlers?.iosBridge) {
  const browserFetch = window.fetch.bind(window);
  window.fetch = async (input, options = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('/api/')) return browserFetch(input, options);
    const request = { method: options.method || 'GET', url, body: options.body || '' };
    const result = window.AndroidBridge
      ? JSON.parse(window.AndroidBridge.request(request.method, request.url, request.body))
      : await window.webkit.messageHandlers.iosBridge.postMessage(request);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}
