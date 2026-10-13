package com.mercadoenluz.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/** API local del móvil. La pantalla conserva el mismo contrato que la web del Mac. */
public final class LocalApi {
    private static final String PORTFOLIO_SYMBOL = "PORTFOLIO";
    private final SharedPreferences preferences;
    private final QuoteSource provider = new YahooPrototypeQuotes();
    private final ScheduledExecutorService poller = Executors.newSingleThreadScheduledExecutor();
    private volatile boolean stopped;
    private final GoveeBleController ble;
    private final ThresholdAlerts alerts;
    private JSONArray portfolio;
    private JSONArray carouselAssets;
    private final Map<String, JSONObject> quotes = new HashMap<>();
    private long revision;
    private String lastFetch;
    private String lastLedUpdate;
    private String marketError = "";
    private String bleError = "";
    private boolean on;
    private boolean powerKnown;
    private boolean busy;
    private int lastRed = -1;
    private int lastGreen = -1;
    private int lastBlack = -1;
    private String lastPalette = "";
    private JSONObject pro;
    private boolean alertsEnabled;
    private String lastAlert;
    private boolean carouselEnabled;
    private String carouselCurrentSymbol;
    private int carouselPosition = -1;
    private int carouselWindowStart;

    public LocalApi(Context context) {
        preferences = context.getSharedPreferences("portfolio", Context.MODE_PRIVATE);
        loadQuoteCache();
        alertsEnabled = preferences.getBoolean("alerts_enabled", false);
        alerts = new ThresholdAlerts(preferences.getStringSet("alert_fired", new HashSet<>()));
        try { portfolio = new JSONArray(preferences.getString("assets", defaults().toString())); }
        catch (Exception ignored) { portfolio = defaults(); }
        try { carouselAssets = new JSONArray(preferences.getString("carousel_assets", "[]")); }
        catch (Exception ignored) { carouselAssets = new JSONArray(); }
        carouselEnabled = preferences.getBoolean("carousel_enabled", false) && carouselAssets.length() > 0;
        try { pro = ProFeatures.validate(new JSONObject(preferences.getString("pro_settings", ProFeatures.defaults().toString())), portfolio); }
        catch (Exception ignored) { try { pro = ProFeatures.defaults(); } catch (Exception impossible) { throw new IllegalStateException(impossible); } }
        if (!preferences.contains("pro_settings") && (alertsEnabled || carouselEnabled || containsSymbol(portfolio, PORTFOLIO_SYMBOL))) {
            try { pro.put("enabled", true); } catch (Exception ignored) { }
        }
        revision = preferences.getLong("revision", 1);
        ble = new GoveeBleController(context, (known, active, working, error) -> {
            synchronized (LocalApi.this) {
                powerKnown = known;
                on = active;
                busy = working;
                bleError = error;
                if ((!known && !working) || (known && !active)) {
                    lastRed = lastGreen = lastBlack = -1;
                    lastPalette = "";
                }
            }
            if (known && active && !working) {
                if (carouselEnabled) updateCarouselColors();
                else applyColors();
            }
        }, (assetIndex, position, windowStart) -> {
            synchronized (LocalApi.this) {
                carouselPosition = position;
                carouselWindowStart = windowStart;
                JSONObject asset = carouselAssets.optJSONObject(assetIndex);
                carouselCurrentSymbol = asset == null ? null : asset.optString("symbol");
            }
        });
    }

    public void start() { poller.scheduleWithFixedDelay(this::refreshQuotes, 0, 600, TimeUnit.SECONDS); }
    public void stop() { stopped = true; carouselEnabled = false; poller.shutdownNow(); ble.shutdown(); }
    public void checkPower() { ble.queryPower(); }
    public synchronized void permissionDenied() { bleError = "Concede permiso de Bluetooth para conectar la tira"; }
    public synchronized void backgroundUnavailable() { bleError = "No se pudo iniciar la actualización en segundo plano"; }

    public String request(String method, String address, String body) {
        try {
            Uri uri = Uri.parse(address);
            String path = uri.getPath();
            if ("GET".equals(method) && "/api/state".equals(path)) return answer(200, snapshot());
            if ("GET".equals(method) && "/api/search".equals(path)) return answer(200, new JSONObject().put("results", provider.search(uri.getQueryParameter("q"))));
            if ("GET".equals(method) && "/api/history".equals(path)) {
                String symbol = uri.getQueryParameter("symbol");
                String range = uri.getQueryParameter("range");
                return answer(200, new JSONObject().put("points", PORTFOLIO_SYMBOL.equals(symbol) ? portfolioHistory(range) : provider.history(symbol, range)));
            }
            if ("GET".equals(method) && "/api/events".equals(path)) return answer(200, new JSONObject().put("dividends", new JSONArray()).put("earnings", new JSONArray()).put("dividends_available", false).put("earnings_available", false));
            if ("POST".equals(method) && "/api/device".equals(path)) {
                String model = new JSONObject(body).getString("model");
                if (!GoveeBleController.isSupportedModel(model)) return error(400, "Modelo no admitido");
                ble.selectModel(model);
                synchronized (this) {
                    powerKnown = false;
                    on = false;
                    bleError = "";
                    lastPalette = "";
                }
                return answer(200, snapshot());
            }
            if ("POST".equals(method) && "/api/alerts".equals(path)) {
                boolean enabled = new JSONObject(body).getBoolean("enabled");
                synchronized (this) {
                    alertsEnabled = enabled;
                    alerts.resetBaseline();
                    if (enabled) pro.put("enabled", true);
                    preferences.edit().putBoolean("alerts_enabled", enabled).apply();
                    preferences.edit().putString("pro_settings", pro.toString()).apply();
                }
                return answer(200, snapshot());
            }
            if ("POST".equals(method) && "/api/carousel".equals(path)) return saveCarousel(new JSONObject(body));
            if ("POST".equals(method) && "/api/pro".equals(path)) return savePro(new JSONObject(body));
            if ("POST".equals(method) && "/api/power".equals(path)) {
                JSONObject input = new JSONObject(body);
                if (busy) return error(409, "Bluetooth ocupado");
                boolean desired = input.getBoolean("on");
                synchronized (this) { busy = true; }
                ble.setPower(desired);
                return answer(200, snapshot());
            }
            if ("POST".equals(method) && "/api/portfolio".equals(path)) return savePortfolio(new JSONObject(body));
            return error(404, "Ruta no encontrada");
        } catch (Exception exception) {
            return error(502, exception.getMessage() == null ? "Error de la app" : exception.getMessage());
        }
    }

    public synchronized JSONObject snapshot() throws Exception {
        JSONObject state = new JSONObject();
        state.put("on", on).put("power_known", powerKnown).put("busy", busy);
        state.put("loading", lastFetch == null).put("portfolio_revision", Long.toString(revision));
        JSONArray visible = new JSONArray();
        for (int i = 0; i < portfolio.length(); i++) {
            JSONObject asset = portfolio.getJSONObject(i);
            JSONObject stored = quotes.get(asset.getString("symbol"));
            JSONObject quote = stored == null ? new JSONObject(asset.toString()) : new JSONObject(stored.toString());
            quote.put("name", asset.getString("name"));
            quote.put("market", asset.getString("market"));
            quote.put("segments", asset.getJSONArray("segments"));
            quote.put("exchange", asset.optString("exchange", PORTFOLIO_SYMBOL.equals(asset.optString("symbol")) ? "MEDIA EQUIPONDERADA" : asset.optString("market").equals("ES") ? "BME" : "NASDAQ"));
            quote.put("currency", asset.optString("currency", PORTFOLIO_SYMBOL.equals(asset.optString("symbol")) ? "pts" : asset.optString("market").equals("ES") ? "EUR" : "USD"));
            if (stored == null) {
                quote.put("price", JSONObject.NULL).put("change_pct", JSONObject.NULL);
                quote.put("points", new JSONArray()).put("stale", true);
            }
            boolean open = false;
            if (PORTFOLIO_SYMBOL.equals(asset.optString("symbol"))) {
                for (int j = 0; j < portfolio.length(); j++) {
                    JSONObject member = portfolio.optJSONObject(j);
                    if (member != null && !PORTFOLIO_SYMBOL.equals(member.optString("symbol")) && isOpen(member.optString("market"))) { open = true; break; }
                }
            } else open = isOpen(asset.optString("market"));
            quote.put("market_open", open);
            visible.put(quote);
        }
        state.put("quotes", visible).put("last_fetch", lastFetch == null ? JSONObject.NULL : lastFetch);
        state.put("last_led_update", lastLedUpdate == null ? JSONObject.NULL : lastLedUpdate);
        state.put("market_error", marketError).put("ble_error", bleError).put("refresh_seconds", 600);
        state.put("device_model", ble.selectedModel())
            .put("device_models", new JSONArray(GoveeBleController.SUPPORTED_MODELS));
        state.put("alerts_enabled", alertsEnabled).put("last_alert", lastAlert == null ? JSONObject.NULL : lastAlert);
        state.put("pro", new JSONObject(pro.toString()));
        state.put("portfolio_average_supported", true);
        state.put("carousel_enabled", carouselEnabled);
        JSONArray carouselVisible = new JSONArray();
        JSONArray carouselQuoteList = new JSONArray();
        for (int i = 0; i < carouselAssets.length(); i++) {
            JSONObject asset = carouselAssets.optJSONObject(i);
            if (asset == null) continue;
            JSONObject item = new JSONObject().put("symbol", asset.optString("symbol"))
                .put("name", asset.optString("name")).put("market", asset.optString("market"))
                .put("exchange", asset.optString("exchange"));
            carouselVisible.put(item);
            JSONObject quote = quotes.get(asset.optString("symbol"));
            Object change = quote == null || !quote.has("change_pct") || quote.isNull("change_pct")
                ? JSONObject.NULL : quote.opt("change_pct");
            carouselQuoteList.put(new JSONObject().put("symbol", asset.optString("symbol"))
                .put("name", asset.optString("name")).put("change_pct", change));
        }
        state.put("carousel_assets", carouselVisible).put("carousel_quotes", carouselQuoteList)
            .put("carousel_current_symbol", carouselCurrentSymbol == null ? JSONObject.NULL : carouselCurrentSymbol)
            .put("carousel_position", carouselPosition).put("carousel_window_start", carouselWindowStart)
            .put("carousel_route", carouselRoute());
        return state;
    }

    private String saveCarousel(JSONObject input) throws Exception {
        if (!input.has("enabled") || !(input.get("enabled") instanceof Boolean)) return error(400, "Carrusel no válido");
        boolean enabled = input.getBoolean("enabled");
        JSONArray symbols = input.optJSONArray("symbols");
        if (symbols == null || symbols.length() > 100) return error(400, "Lista del carrusel no válida");
        JSONArray next = new JSONArray();
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < symbols.length(); i++) {
            String symbol = symbols.optString(i, "").trim().toUpperCase(Locale.ROOT);
            if (!symbol.matches("[A-Z0-9.-]{1,16}") || PORTFOLIO_SYMBOL.equals(symbol) || !seen.add(symbol)) continue;
            JSONArray matches = provider.search(symbol);
            JSONObject found = null;
            for (int j = 0; j < matches.length(); j++) {
                JSONObject candidate = matches.optJSONObject(j);
                if (candidate != null && symbol.equals(candidate.optString("symbol"))) { found = candidate; break; }
            }
            if (found == null) return error(400, "No encontré " + symbol + " en las bolsas admitidas");
            next.put(new JSONObject(found.toString()));
        }
        if (enabled && next.length() == 0) return error(400, "Añade al menos una empresa");
        synchronized (this) {
            carouselAssets = next;
            carouselEnabled = enabled;
            carouselCurrentSymbol = null;
            carouselPosition = -1;
            carouselWindowStart = 0;
            preferences.edit().putString("carousel_assets", next.toString()).putBoolean("carousel_enabled", enabled).apply();
        }
        if (enabled) {
            updateCarouselColors();
            poller.execute(this::refreshQuotes);
        } else {
            ble.setCarousel(new int[0], false);
            applyColors();
        }
        return answer(200, snapshot());
    }

    private String savePro(JSONObject input) throws Exception {
        JSONObject next;
        synchronized (this) {
            try { next = ProFeatures.validate(input, portfolio); }
            catch (Exception error) { return error(400, error.getMessage() == null ? "Ajustes Pro no válidos" : error.getMessage()); }
            pro = next;
            if (!pro.optBoolean("enabled")) {
                alertsEnabled = false;
                alerts.resetBaseline();
                carouselEnabled = false;
                carouselCurrentSymbol = null;
                carouselPosition = -1;
                carouselWindowStart = 0;
                ble.setCarousel(new int[0], false);
            }
            lastPalette = "";
            preferences.edit().putString("pro_settings", pro.toString())
                .putBoolean("alerts_enabled", alertsEnabled).putBoolean("carousel_enabled", carouselEnabled).apply();
            if (containsSymbol(portfolio, PORTFOLIO_SYMBOL)) {
                try { quotes.put(PORTFOLIO_SYMBOL, portfolioAverageQuote(portfolio, quotes, pro)); }
                catch (Exception ignored) { quotes.remove(PORTFOLIO_SYMBOL); }
            }
            for (Map.Entry<String, JSONObject> entry : quotes.entrySet()) observeTarget(entry.getKey(), entry.getValue());
        }
        applyColors();
        updateCarouselColors();
        return answer(200, snapshot());
    }

    private String savePortfolio(JSONObject input) throws Exception {
        JSONArray next = input.getJSONArray("portfolio");
        synchronized (this) {
            if (!Long.toString(revision).equals(input.optString("revision"))) return error(409, "La cartera cambió; vuelve a abrir el editor");
            if (next.length() < 1 || next.length() > 15) return error(400, "La cartera admite entre 1 y 15 empresas");
            Map<String, JSONObject> old = new HashMap<>();
            for (int i = 0; i < portfolio.length(); i++) old.put(portfolio.getJSONObject(i).getString("symbol"), portfolio.getJSONObject(i));
            Set<String> symbols = new HashSet<>();
            Set<Integer> used = new HashSet<>();
            JSONArray validated = new JSONArray();
            for (int i = 0; i < next.length(); i++) {
                JSONObject item = next.getJSONObject(i);
                String symbol = item.getString("symbol").toUpperCase(Locale.ROOT);
                if (!symbol.matches("[A-Z0-9.-]{1,16}") || !symbols.add(symbol)) return error(400, "Símbolo repetido o inválido");
                JSONArray positions = item.getJSONArray("segments");
                if (positions.length() == 0) return error(400, symbol + " necesita un segmento");
                for (int j = 0; j < positions.length(); j++) {
                    int position = positions.getInt(j);
                    if (position < 0 || position > 14 || !used.add(position)) return error(400, "Segmento repetido o inválido");
                }
                JSONObject asset = old.get(symbol);
                if (asset == null && PORTFOLIO_SYMBOL.equals(symbol)) {
                    asset = new JSONObject().put("name", "Mi cartera").put("symbol", PORTFOLIO_SYMBOL)
                        .put("market", "AVG").put("exchange", "MEDIA EQUIPONDERADA").put("currency", "pts");
                }
                if (asset == null) {
                    JSONArray matches = provider.search(symbol);
                    for (int j = 0; j < matches.length(); j++) {
                        JSONObject candidate = matches.getJSONObject(j);
                        if (symbol.equals(candidate.optString("symbol"))) { asset = candidate; break; }
                    }
                    if (asset == null) return error(400, "No encontré " + symbol + " en las bolsas admitidas");
                }
                validated.put(new JSONObject(asset.toString()).put("segments", positions));
            }
            boolean hasReal = false;
            for (int i = 0; i < validated.length(); i++) if (!PORTFOLIO_SYMBOL.equals(validated.getJSONObject(i).getString("symbol"))) hasReal = true;
            if (!hasReal) return error(400, "La media necesita al menos una empresa real");
            portfolio = validated;
            pro = ProFeatures.reconcile(pro, portfolio);
            revision++;
            preferences.edit().putString("assets", portfolio.toString()).putLong("revision", revision)
                .putString("pro_settings", pro.toString()).apply();
            lastRed = lastGreen = lastBlack = -1;
            lastPalette = "";
        }
        applyColors();
        poller.execute(this::refreshQuotes);
        return answer(200, snapshot());
    }

    private void refreshQuotes() {
        if (stopped) return;
        JSONArray assets;
        JSONArray carousel;
        synchronized (this) { assets = portfolio; carousel = carouselAssets; }
        List<Runnable> flashes = new ArrayList<>();
        int unavailable = 0;
        for (int i = 0; i < assets.length(); i++) {
            try {
                JSONObject asset = assets.getJSONObject(i);
                String symbol = asset.getString("symbol");
                if (PORTFOLIO_SYMBOL.equals(symbol)) continue;
                JSONObject quote = provider.quote(asset);
                quote.put("stale", false);
                String session = quote.optString("session_date");
                synchronized (this) {
                    quotes.put(symbol, quote);
                    observeTarget(symbol, quote);
                    if (!quote.isNull("change_pct")) {
                        List<Integer> crossed = alerts.observe(symbol, session, quote.getDouble("change_pct"));
                        if (alertsEnabled && powerKnown && on && !carouselEnabled && !hasTargetHit(symbol)) {
                            int mask = 0;
                            JSONArray positions = asset.optJSONArray("segments");
                            for (int j = 0; positions != null && j < positions.length(); j++) mask |= 1 << positions.optInt(j);
                            final int segmentMask = mask;
                            for (int level : crossed) {
                                final int threshold = level;
                                flashes.add(() -> ble.flash(segmentMask, threshold > 0 ? 0x00ff00 : 0xff0000,
                                    Math.abs(threshold), () -> {
                                        synchronized (LocalApi.this) {
                                            if (alerts.mark(symbol, session, threshold)) {
                                                preferences.edit().putStringSet("alert_fired", alerts.saved()).apply();
                                                lastAlert = symbol + " " + (threshold > 0 ? "+" : "") + threshold + "%";
                                            }
                                        }
                                    }));
                            }
                        }
                    }
                }
            } catch (Exception error) {
                synchronized (this) {
                    JSONObject asset = assets.optJSONObject(i);
                    JSONObject old = asset == null ? null : quotes.get(asset.optString("symbol"));
                    if (old != null) {
                        try { old.put("stale", true); } catch (Exception ignored) { /* Se conserva el último precio. */ }
                    } else unavailable++;
                }
            }
        }
        for (int i = 0; i < carousel.length(); i++) {
            JSONObject asset = carousel.optJSONObject(i);
            if (asset == null) continue;
            String symbol = asset.optString("symbol");
            synchronized (this) { if (quotes.containsKey(symbol) && containsSymbol(assets, symbol)) continue; }
            try {
                JSONObject quote = provider.quote(asset);
                quote.put("stale", false);
                synchronized (this) { quotes.put(symbol, quote); observeTarget(symbol, quote); }
            } catch (Exception error) {
                synchronized (this) {
                    JSONObject old = quotes.get(symbol);
                    if (old != null) try { old.put("stale", true); } catch (Exception ignored) { }
                    else unavailable++;
                }
            }
        }
        synchronized (this) {
            for (int i = 0; i < assets.length(); i++) {
                JSONObject asset = assets.optJSONObject(i);
                if (asset == null || !PORTFOLIO_SYMBOL.equals(asset.optString("symbol"))) continue;
                try {
                    JSONObject average = portfolioAverageQuote(assets, quotes, pro);
                    quotes.put(PORTFOLIO_SYMBOL, average);
                    if (!average.isNull("change_pct") && !average.isNull("session_date")) {
                        String session = average.getString("session_date");
                        List<Integer> crossed = alerts.observe(PORTFOLIO_SYMBOL, session, average.getDouble("change_pct"));
                        if (alertsEnabled && powerKnown && on && !carouselEnabled && !hasTargetHit(PORTFOLIO_SYMBOL)) {
                            int mask = 0;
                            JSONArray positions = asset.optJSONArray("segments");
                            for (int j = 0; positions != null && j < positions.length(); j++) mask |= 1 << positions.optInt(j);
                            final int segmentMask = mask;
                            for (int level : crossed) {
                                final int threshold = level;
                                flashes.add(() -> ble.flash(segmentMask, threshold > 0 ? 0x00ff00 : 0xff0000,
                                    Math.abs(threshold), () -> {
                                        synchronized (LocalApi.this) {
                                            if (alerts.mark(PORTFOLIO_SYMBOL, session, threshold)) {
                                                preferences.edit().putStringSet("alert_fired", alerts.saved()).apply();
                                                lastAlert = "Mi cartera " + (threshold > 0 ? "+" : "") + threshold + "%";
                                            }
                                        }
                                    }));
                            }
                        }
                    }
                } catch (Exception ignored) { quotes.remove(PORTFOLIO_SYMBOL); }
                break;
            }
            lastFetch = Instant.now().toString();
            marketError = unavailable == 0 ? "" : unavailable + " cotizaciones no disponibles ahora";
            saveQuoteCache();
        }
        if (stopped) return;
        updateCarouselColors();
        applyColors();
        if (!carouselEnabled && !busy && (!powerKnown || !on)) ble.queryPower();
        for (Runnable flash : flashes) flash.run();
    }

    private void loadQuoteCache() {
        String raw = preferences.getString("quotes_cache", "[]");
        try {
            JSONArray cached = new JSONArray(raw);
            for (int i = 0; i < cached.length(); i++) {
                JSONObject quote = cached.optJSONObject(i);
                if (quote == null) continue;
                String symbol = quote.optString("symbol", "");
                double price = quote.optDouble("price", Double.NaN);
                double change = quote.optDouble("change_pct", Double.NaN);
                if (symbol.isEmpty() || PORTFOLIO_SYMBOL.equals(symbol)
                        || !Double.isFinite(price) || price <= 0 || !Double.isFinite(change)) continue;
                quote.put("stale", true);
                quotes.put(symbol, quote);
            }
        } catch (Exception ignored) {
            // Si el contenido guardado se dañó, la app continúa y volverá a llenarlo.
        }
    }

    private void saveQuoteCache() {
        try {
            JSONArray cached = new JSONArray();
            List<JSONObject> ordered = new ArrayList<>(quotes.values());
            ordered.sort((a, b) -> b.optString("asof", "").compareTo(a.optString("asof", "")));
            int saved = 0;
            for (JSONObject quote : ordered) {
                if (saved >= 300) break;
                String symbol = quote.optString("symbol", "");
                double price = quote.optDouble("price", Double.NaN);
                double change = quote.optDouble("change_pct", Double.NaN);
                if (symbol.isEmpty() || PORTFOLIO_SYMBOL.equals(symbol)
                        || !Double.isFinite(price) || price <= 0 || !Double.isFinite(change)) continue;
                JSONObject item = new JSONObject();
                for (String key : new String[]{"symbol", "name", "market", "exchange", "currency",
                        "price", "previous_close", "change_pct", "session_date", "asof"}) {
                    if (quote.has(key)) item.put(key, quote.get(key));
                }
                item.put("stale", quote.optBoolean("stale", false));
                cached.put(item);
                saved++;
            }
            preferences.edit().putString("quotes_cache", cached.toString()).apply();
        } catch (Exception ignored) {
            // Persistir la caché nunca debe interrumpir la consulta ni el control BLE.
        }
    }

    private static JSONObject portfolioAverageQuote(JSONArray assets, Map<String, JSONObject> quotes, JSONObject pro) throws Exception {
        List<JSONObject> members = new ArrayList<>();
        double[] weights = ProFeatures.weights(assets, pro);
        double sum = 0;
        boolean complete = true;
        boolean stale = false;
        String session = null;
        String asof = null;
        for (int i = 0; i < assets.length(); i++) {
            JSONObject asset = assets.getJSONObject(i);
            if (PORTFOLIO_SYMBOL.equals(asset.getString("symbol"))) continue;
            JSONObject quote = quotes.get(asset.getString("symbol"));
            members.add(quote);
            if (quote == null || quote.isNull("change_pct") || !Double.isFinite(quote.optDouble("change_pct", Double.NaN))) complete = false;
            else sum += quote.getDouble("change_pct") * weights[members.size() - 1];
            if (quote == null || quote.optBoolean("stale", false)) stale = true;
            String day = quote == null ? "" : quote.optString("session_date", "");
            if (day.isEmpty() || (session != null && !session.equals(day))) session = "";
            else if (session == null) session = day;
            String stamp = quote == null ? "" : quote.optString("asof", "");
            if (!stamp.isEmpty() && (asof == null || stamp.compareTo(asof) > 0)) asof = stamp;
        }
        if (members.isEmpty()) complete = false;
        double change = complete ? sum : Double.NaN;
        JSONObject result = new JSONObject().put("symbol", PORTFOLIO_SYMBOL).put("name", "Mi cartera")
            .put("market", "AVG").put("exchange", pro.optBoolean("enabled") && "weighted".equals(pro.getJSONObject("average").optString("mode")) ? "MEDIA PONDERADA" : "MEDIA EQUIPONDERADA").put("currency", "pts")
            .put("previous_close", 100).put("change_pct", complete ? change : JSONObject.NULL)
            .put("price", complete ? 100 + change : JSONObject.NULL).put("stale", stale)
            .put("session_date", session == null || session.isEmpty() ? JSONObject.NULL : session)
            .put("asof", asof == null ? JSONObject.NULL : asof);
        JSONArray points = new JSONArray();
        if (complete && session != null && !session.isEmpty()) {
            TreeMap<Instant, List<double[]>> events = new TreeMap<>();
            double[] previous = new double[members.size()];
            double[] current = new double[members.size()];
            for (int i = 0; i < members.size(); i++) {
                JSONObject quote = members.get(i);
                previous[i] = quote.optDouble("previous_close", Double.NaN);
                current[i] = previous[i];
                if (!Double.isFinite(previous[i]) || previous[i] <= 0) { events.clear(); break; }
                JSONArray series = quote.optJSONArray("points");
                for (int j = 0; series != null && j < series.length(); j++) {
                    JSONObject point = series.optJSONObject(j);
                    if (point == null || point.isNull("price")) continue;
                    double price = point.optDouble("price", Double.NaN);
                    if (!Double.isFinite(price) || price <= 0) continue;
                    events.computeIfAbsent(Instant.parse(point.getString("time")), key -> new ArrayList<>()).add(new double[]{i, price});
                }
            }
            if (!events.isEmpty()) {
                List<JSONObject> samples = new ArrayList<>();
                samples.add(new JSONObject().put("time", events.firstKey().minusSeconds(60).toString()).put("price", 100).put("volume", 0));
                for (Map.Entry<Instant, List<double[]>> entry : events.entrySet()) {
                    for (double[] item : entry.getValue()) current[(int) item[0]] = item[1];
                    double value = 0;
                    for (int i = 0; i < current.length; i++) value += current[i] / previous[i] * 100 * weights[i];
                    samples.add(new JSONObject().put("time", entry.getKey().toString()).put("price", value).put("volume", 0));
                }
                int stride = Math.max(1, samples.size() / 180);
                for (int i = 0; i < samples.size(); i += stride) points.put(samples.get(i));
                if (points.getJSONObject(points.length() - 1) != samples.get(samples.size() - 1)) points.put(samples.get(samples.size() - 1));
            }
        }
        result.put("points", points);
        return result;
    }

    private JSONArray portfolioHistory(String range) throws Exception {
        List<String> symbols = new ArrayList<>();
        double[] weights;
        synchronized (this) {
            weights = ProFeatures.weights(portfolio, pro);
            for (int i = 0; i < portfolio.length(); i++) {
                String symbol = portfolio.getJSONObject(i).getString("symbol");
                if (!PORTFOLIO_SYMBOL.equals(symbol)) symbols.add(symbol);
            }
        }
        if (symbols.isEmpty()) throw new IllegalArgumentException("La media necesita empresas");
        ExecutorService pool = Executors.newFixedThreadPool(Math.min(3, symbols.size()));
        try {
            List<Future<JSONArray>> jobs = new ArrayList<>();
            for (String symbol : symbols) jobs.add(pool.submit(() -> provider.history(symbol, range)));
            List<TreeMap<LocalDate, Double>> series = new ArrayList<>();
            TreeSet<LocalDate> days = new TreeSet<>();
            for (Future<JSONArray> job : jobs) {
                JSONArray raw = job.get();
                TreeMap<LocalDate, Double> prices = new TreeMap<>();
                for (int i = 0; i < raw.length(); i++) {
                    JSONObject point = raw.optJSONObject(i);
                    if (point == null) continue;
                    double price = point.optDouble("price", Double.NaN);
                    if (Double.isFinite(price) && price > 0) prices.put(LocalDate.parse(point.getString("time")), price);
                }
                if (prices.isEmpty()) throw new IllegalStateException("Falta el histórico de una empresa");
                series.add(prices);
                days.addAll(prices.keySet());
            }
            JSONArray result = new JSONArray();
            double[] current = new double[series.size()];
            double[] baseline = new double[series.size()];
            int count = 0;
            for (LocalDate day : days) {
                boolean ready = true;
                for (int i = 0; i < series.size(); i++) {
                    Double price = series.get(i).get(day);
                    if (price != null) current[i] = price;
                    if (current[i] <= 0) ready = false;
                }
                if (!ready) continue;
                if (count == 0) System.arraycopy(current, 0, baseline, 0, current.length);
                double value = 0;
                for (int i = 0; i < current.length; i++) value += current[i] / baseline[i] * 100 * weights[i];
                count++;
                result.put(new JSONObject().put("time", day.toString()).put("price", value).put("volume", 0));
            }
            if (result.length() < 2) throw new IllegalStateException("No hay suficientes cierres para la media");
            return result;
        } finally { pool.shutdownNow(); }
    }

    private boolean hasTargetHit(String symbol) {
        JSONObject target = pro.optJSONObject("targets").optJSONObject(symbol);
        return pro.optBoolean("enabled") && target != null && !target.isNull("hit");
    }

    private void observeTarget(String symbol, JSONObject quote) {
        if (!pro.optBoolean("enabled") || quote.optBoolean("stale")) return;
        JSONObject target = pro.optJSONObject("targets").optJSONObject(symbol);
        if (target == null) return;
        boolean changed = false;
        double price = quote.optDouble("price", Double.NaN);
        if (target.optBoolean("acknowledged") && Double.isFinite(price)
                && (target.isNull("stop") || price > target.optDouble("stop"))
                && (target.isNull("sell") || price < target.optDouble("sell"))) {
            try { target.put("acknowledged", false); changed = true; } catch (Exception ignored) { }
        }
        String hit = ProFeatures.reached(target, quote);
        if (hit != null) {
            try { target.put("hit", hit); changed = true; } catch (Exception ignored) { }
        }
        if (changed) {
            lastPalette = "";
            preferences.edit().putString("pro_settings", pro.toString()).apply();
        }
    }

    private void applyColors() {
        int[] palette;
        synchronized (this) {
            if (stopped || carouselEnabled || !powerKnown || !on || busy || quotes.isEmpty()) return;
            TreeMap<Integer, Integer> masks = new TreeMap<>();
            int assigned = 0;
            for (int i = 0; i < portfolio.length(); i++) {
                JSONObject asset = portfolio.optJSONObject(i);
                if (asset == null) continue;
                String symbol = asset.optString("symbol");
                JSONObject quote = quotes.get(symbol);
                int rgb = 0;
                JSONObject target = pro.optBoolean("enabled") ? pro.optJSONObject("targets").optJSONObject(symbol) : null;
                if (target != null && !target.isNull("hit")) {
                    rgb = "sell".equals(target.optString("hit")) ? 0xffbe00 : 0xff00b4;
                } else if (quote != null && !quote.isNull("change_pct")) {
                    double change = quote.optDouble("change_pct");
                    rgb = ProFeatures.color(change < 0 ? 0xff0000 : 0x00ff00, change, pro);
                }
                JSONArray segments = asset.optJSONArray("segments");
                for (int j = 0; segments != null && j < segments.length(); j++) {
                    int mask = 1 << segments.optInt(j);
                    assigned |= mask;
                    masks.put(rgb, masks.getOrDefault(rgb, 0) | mask);
                }
            }
            int missing = 0x7fff & ~assigned;
            if (missing != 0) masks.put(0, masks.getOrDefault(0, 0) | missing);
            String signature = masks.toString();
            if (signature.equals(lastPalette)) return;
            lastPalette = signature;
            palette = new int[masks.size() * 2];
            int index = 0;
            for (Map.Entry<Integer, Integer> entry : masks.entrySet()) {
                palette[index++] = entry.getKey();
                palette[index++] = entry.getValue();
            }
            lastLedUpdate = Instant.now().toString();
        }
        ble.showPalette(palette);
    }

    private void updateCarouselColors() {
        int[] colors;
        synchronized (this) {
            if (stopped || !carouselEnabled || !powerKnown || !on) return;
            colors = new int[carouselAssets.length()];
            for (int i = 0; i < carouselAssets.length(); i++) {
                JSONObject asset = carouselAssets.optJSONObject(i);
                JSONObject quote = asset == null ? null : quotes.get(asset.optString("symbol"));
                if (quote != null && !quote.isNull("change_pct")) {
                    double change = quote.optDouble("change_pct");
                    colors[i] = ProFeatures.color(change < 0 ? 0xff0000 : 0x00ff00, change, pro);
                }
            }
        }
        ble.setCarousel(colors, true);
    }

    private JSONArray carouselRoute() throws Exception {
        JSONArray result = new JSONArray();
        int count = carouselAssets.length();
        if (count == 0) return result;
        int start = Math.floorMod(carouselWindowStart, count);
        int activeCount = Math.min(15, count);
        JSONObject[] active = new JSONObject[activeCount];
        for (int i = 0; i < activeCount; i++) active[i] = carouselAssets.getJSONObject((start + i) % count);
        int each = 15 / activeCount;
        int extra = 15 % activeCount;
        List<JSONObject> route = new ArrayList<>(15);
        for (int i = 0; i < activeCount; i++) {
            int segments = each + (i < extra ? 1 : 0);
            for (int j = 0; j < segments; j++) route.add(active[i]);
        }
        int shift = Math.max(0, carouselPosition) % 15;
        for (int position = 0; position < 15; position++) {
            JSONObject asset = route.get(Math.floorMod(position - shift, 15));
            JSONObject quote = quotes.get(asset.optString("symbol"));
            Object change = quote == null || !quote.has("change_pct") || quote.isNull("change_pct")
                ? JSONObject.NULL : quote.opt("change_pct");
            result.put(new JSONObject().put("symbol", asset.optString("symbol"))
                .put("name", asset.optString("name")).put("change_pct", change));
        }
        return result;
    }

    private static boolean containsSymbol(JSONArray assets, String symbol) {
        for (int i = 0; i < assets.length(); i++) {
            JSONObject asset = assets.optJSONObject(i);
            if (asset != null && symbol.equals(asset.optString("symbol"))) return true;
        }
        return false;
    }

    private static boolean isOpen(String market) {
        ZoneId zone = ZoneId.of(market.equals("ES") ? "Europe/Madrid" : "America/New_York");
        ZonedDateTime now = ZonedDateTime.now(zone);
        if (now.getDayOfWeek().getValue() > 5) return false;
        LocalTime start = market.equals("ES") ? LocalTime.of(9, 0) : LocalTime.of(9, 30);
        LocalTime end = market.equals("ES") ? LocalTime.of(17, 30) : LocalTime.of(16, 0);
        return !now.toLocalTime().isBefore(start) && now.toLocalTime().isBefore(end);
    }

    private static JSONArray defaults() {
        JSONArray values = new JSONArray();
        add(values, "Alphabet", "GOOGL", "US", 0, 1);
        add(values, "Enagás", "ENG.MC", "ES", 2, 3);
        add(values, "Uber", "UBER", "US", 4, 5);
        add(values, "Apple", "AAPL", "US", 6, 7);
        add(values, "TSMC", "TSM", "US", 8, 9);
        add(values, "Iberdrola", "IBE.MC", "ES", 10, 11);
        add(values, "McD", "MCD", "US", 12);
        add(values, "Coca-Cola", "KO", "US", 13);
        add(values, "Amazon", "AMZN", "US", 14);
        return values;
    }

    private static void add(JSONArray values, String name, String symbol, String market, int... segments) {
        try {
            JSONArray positions = new JSONArray();
            for (int segment : segments) positions.put(segment);
            values.put(new JSONObject().put("name", name).put("symbol", symbol).put("market", market)
                .put("exchange", market.equals("ES") ? "BME" : symbol.equals("UBER") || symbol.equals("TSM") || symbol.equals("MCD") || symbol.equals("KO") ? "NYSE" : "NASDAQ")
                .put("currency", market.equals("ES") ? "EUR" : "USD").put("segments", positions));
        } catch (Exception ignored) { /* Constantes locales válidas. */ }
    }

    private static String answer(int status, JSONObject body) {
        try { return new JSONObject().put("status", status).put("body", body).toString(); }
        catch (Exception ignored) { return "{\"status\":500,\"body\":{\"error\":\"Error interno\"}}"; }
    }
    private static String error(int status, String message) {
        try { return answer(status, new JSONObject().put("error", message)); }
        catch (Exception ignored) { return answer(500, new JSONObject()); }
    }
}
