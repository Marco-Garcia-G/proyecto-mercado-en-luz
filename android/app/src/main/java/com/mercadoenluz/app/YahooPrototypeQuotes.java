package com.mercadoenluz.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Datos provisionales de desarrollo. Sustituir antes de distribución comercial. */
public final class YahooPrototypeQuotes implements QuoteSource {
    @Override public JSONObject quote(JSONObject asset) throws Exception {
        String symbol = asset.getString("symbol");
        try {
            return quoteFromChart(asset, chart(symbol, "5d", "1m"));
        } catch (Exception intradayUnavailable) {
            // El proveedor gratuito a veces no entrega velas de un minuto; el cierre diario
            // permite seguir obteniendo una variación válida para la tira.
            return quoteFromChart(asset, chart(symbol, "1mo", "1d"));
        }
    }

    private JSONObject quoteFromChart(JSONObject asset, JSONObject result) throws Exception {
        String symbol = asset.getString("symbol");
        JSONObject meta = result.getJSONObject("meta");
        JSONArray timestamps = result.optJSONArray("timestamp");
        JSONObject raw = result.getJSONObject("indicators").getJSONArray("quote").getJSONObject(0);
        JSONArray closes = raw.optJSONArray("close");
        JSONArray volumes = raw.optJSONArray("volume");
        if (timestamps == null || closes == null) throw new IllegalStateException("Sin cotizaciones para " + symbol);
        ZoneId exchangeZone = zone(meta.optString("exchangeTimezoneName", "UTC"));
        List<Integer> valid = new ArrayList<>();
        for (int i = 0; i < Math.min(timestamps.length(), closes.length()); i++) {
            if (!closes.isNull(i) && Double.isFinite(closes.optDouble(i, Double.NaN))) valid.add(i);
        }
        if (valid.isEmpty()) throw new IllegalStateException("Sin precios para " + symbol);
        int last = valid.get(valid.size() - 1);
        LocalDate session = Instant.ofEpochSecond(timestamps.getLong(last)).atZone(exchangeZone).toLocalDate();
        double previous = Double.NaN;
        for (int i = valid.size() - 2; i >= 0; i--) {
            int index = valid.get(i);
            LocalDate day = Instant.ofEpochSecond(timestamps.getLong(index)).atZone(exchangeZone).toLocalDate();
            if (day.isBefore(session)) { previous = closes.getDouble(index); break; }
        }
        if (!Double.isFinite(previous)) previous = meta.optDouble("chartPreviousClose", Double.NaN);
        double price = closes.getDouble(last);
        JSONArray points = new JSONArray();
        for (int index : valid) {
            LocalDate day = Instant.ofEpochSecond(timestamps.getLong(index)).atZone(exchangeZone).toLocalDate();
            if (!day.equals(session)) continue;
            points.put(point(Instant.ofEpochSecond(timestamps.getLong(index)).toString(), closes.getDouble(index), volumes == null ? 0 : volumes.optLong(index, 0)));
        }
        JSONObject output = new JSONObject(asset.toString());
        output.put("exchange", asset.optString("exchange", meta.optString("exchangeName", "BOLSA")));
        output.put("currency", meta.optString("currency", asset.optString("market").equals("ES") ? "EUR" : "USD"));
        output.put("price", price);
        output.put("previous_close", Double.isFinite(previous) ? previous : JSONObject.NULL);
        output.put("change_pct", Double.isFinite(previous) && previous > 0 ? (price / previous - 1) * 100 : JSONObject.NULL);
        output.put("session_date", session.toString());
        output.put("asof", Instant.ofEpochSecond(timestamps.getLong(last)).toString());
        output.put("points", points);
        output.put("stale", false);
        return output;
    }

    @Override public JSONArray history(String symbol, String range) throws Exception {
        if (!Arrays.asList("1M", "6M", "1Y", "5Y").contains(range)) throw new IllegalArgumentException("Periodo no válido");
        JSONObject result = chart(symbol, "5y", "1d");
        JSONArray timestamps = result.optJSONArray("timestamp");
        JSONArray closes = result.getJSONObject("indicators").getJSONArray("quote").getJSONObject(0).optJSONArray("close");
        JSONArray volumes = result.getJSONObject("indicators").getJSONArray("quote").getJSONObject(0).optJSONArray("volume");
        if (timestamps == null || closes == null) throw new IllegalStateException("Sin histórico");
        ZoneId zone = zone(result.getJSONObject("meta").optString("exchangeTimezoneName", "UTC"));
        LocalDate from = LocalDate.now(zone).minusDays(range.equals("1M") ? 31 : range.equals("6M") ? 183 : range.equals("1Y") ? 366 : 1827);
        JSONArray points = new JSONArray();
        double[] rolling = new double[200];
        int count = 0;
        double sum = 0;
        for (int i = 0; i < Math.min(timestamps.length(), closes.length()); i++) {
            if (closes.isNull(i)) continue;
            double price = closes.optDouble(i, Double.NaN);
            if (!Double.isFinite(price)) continue;
            if (count >= 200) sum -= rolling[count % 200];
            rolling[count % 200] = price;
            sum += price;
            count++;
            LocalDate day = Instant.ofEpochSecond(timestamps.getLong(i)).atZone(zone).toLocalDate();
            if (day.isBefore(from)) continue;
            JSONObject point = point(day.toString(), price, volumes == null ? 0 : volumes.optLong(i, 0));
            point.put("ma200", count >= 200 ? sum / 200 : JSONObject.NULL);
            points.put(point);
        }
        return points;
    }

    @Override public JSONArray search(String text) throws Exception {
        JSONObject response = get("https://query1.finance.yahoo.com/v1/finance/search?q=" + encode(text) + "&quotesCount=12&newsCount=0");
        JSONArray raw = response.optJSONArray("quotes");
        JSONArray results = new JSONArray();
        if (raw == null) return results;
        for (int i = 0; i < raw.length() && results.length() < 8; i++) {
            JSONObject item = raw.optJSONObject(i);
            if (item == null || !"EQUITY".equals(item.optString("quoteType"))) continue;
            String symbol = item.optString("symbol", "").toUpperCase();
            String exchange = item.optString("exchange", "");
            boolean spanish = symbol.endsWith(".MC") && (exchange.equals("MCE") || exchange.equals("MCM"));
            boolean american = Arrays.asList("NMS", "NCM", "NGM", "NYQ", "ASE").contains(exchange);
            if (!spanish && !american) continue;
            JSONObject asset = new JSONObject();
            asset.put("symbol", symbol);
            asset.put("name", item.optString("longname", item.optString("shortname", symbol)));
            asset.put("market", spanish ? "ES" : "US");
            asset.put("exchange", spanish ? "BME" : exchange.equals("NYQ") ? "NYSE" : "NASDAQ");
            asset.put("currency", spanish ? "EUR" : "USD");
            results.put(asset);
        }
        return results;
    }

    private JSONObject chart(String symbol, String range, String interval) throws Exception {
        Exception lastError = null;
        String[] hosts = {"query1.finance.yahoo.com", "query2.finance.yahoo.com"};
        for (String host : hosts) {
            try {
                JSONObject response = get("https://" + host + "/v8/finance/chart/" + encode(symbol)
                    + "?range=" + range + "&interval=" + interval + "&includePrePost=false");
                JSONObject chart = response.getJSONObject("chart");
                if (!chart.isNull("error")) throw new IllegalStateException("Proveedor sin datos para " + symbol);
                JSONArray results = chart.optJSONArray("result");
                if (results == null || results.length() == 0) throw new IllegalStateException("Proveedor sin datos para " + symbol);
                return results.getJSONObject(0);
            } catch (Exception error) {
                lastError = error;
            }
        }
        throw lastError == null ? new IllegalStateException("Cotización no disponible para " + symbol) : lastError;
    }

    private JSONObject get(String address) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        connection.setConnectTimeout(8000);
        connection.setReadTimeout(12000);
        connection.setRequestProperty("User-Agent", "MercadoEnLuz-Prototype/0.1");
        try {
            if (connection.getResponseCode() != 200) throw new IllegalStateException("El proveedor de cotizaciones no está disponible (" + connection.getResponseCode() + ")");
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream buffer = new ByteArrayOutputStream()) {
                byte[] chunk = new byte[8192];
                int size;
                while ((size = input.read(chunk)) != -1) {
                    buffer.write(chunk, 0, size);
                    if (buffer.size() > 3_000_000) throw new IllegalStateException("Respuesta demasiado grande");
                }
                return new JSONObject(new String(buffer.toByteArray(), StandardCharsets.UTF_8));
            }
        } finally { connection.disconnect(); }
    }

    private static JSONObject point(String time, double price, long volume) throws Exception {
        return new JSONObject().put("time", time).put("price", price).put("volume", volume);
    }

    private static ZoneId zone(String name) {
        try { return ZoneId.of(name); } catch (java.time.DateTimeException error) { return ZoneId.of("UTC"); }
    }

    private static String encode(String text) throws Exception { return URLEncoder.encode(text, "UTF-8"); }
}
