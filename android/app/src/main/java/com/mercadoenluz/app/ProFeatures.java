package com.mercadoenluz.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.LocalTime;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;

/** Reglas Pro compartidas por la API local y el controlador de luz. */
final class ProFeatures {
    private ProFeatures() { }

    static JSONObject defaults() throws Exception {
        return new JSONObject().put("enabled", true)
            .put("average", new JSONObject().put("mode", "equal").put("weights", new JSONObject()))
            .put("targets", new JSONObject())
            .put("ambient", new JSONObject().put("enabled", false).put("night", false)
                .put("schedule", false).put("start", "22:00").put("end", "07:00"));
    }

    static JSONObject validate(JSONObject input, JSONArray assets) throws Exception {
        if (!(input.get("enabled") instanceof Boolean)) throw new IllegalArgumentException("Ajustes Pro no válidos");
        Set<String> symbols = new HashSet<>();
        for (int i = 0; i < assets.length(); i++) {
            JSONObject asset = assets.getJSONObject(i);
            if (!"PORTFOLIO".equals(asset.getString("symbol"))) symbols.add(asset.getString("symbol"));
        }
        JSONObject average = input.getJSONObject("average");
        String mode = average.getString("mode");
        if (!mode.equals("equal") && !mode.equals("weighted")) throw new IllegalArgumentException("Media no válida");
        JSONObject weights = average.getJSONObject("weights");
        double total = 0;
        for (Iterator<String> keys = weights.keys(); keys.hasNext();) {
            String symbol = keys.next();
            double value = weights.getDouble(symbol);
            if (!symbols.contains(symbol) || !Double.isFinite(value) || value < 0 || value > 100)
                throw new IllegalArgumentException("Peso no válido para " + symbol);
            total += value;
        }
        if (mode.equals("weighted") && (weights.length() != symbols.size() || Math.abs(total - 100) > .01))
            throw new IllegalArgumentException("Los pesos de la media deben sumar 100 %");
        JSONObject targets = input.getJSONObject("targets");
        for (Iterator<String> keys = targets.keys(); keys.hasNext();) {
            String symbol = keys.next();
            if (!symbols.contains(symbol)) throw new IllegalArgumentException("Objetivo no válido para " + symbol);
            JSONObject target = targets.getJSONObject(symbol);
            Double sell = price(target, "sell");
            Double stop = price(target, "stop");
            if (sell != null && stop != null && stop >= sell) throw new IllegalArgumentException("El stop debe ser menor que el objetivo");
            String hit = target.isNull("hit") ? "" : target.optString("hit", "");
            if (!hit.isEmpty() && !hit.equals("sell") && !hit.equals("stop")) throw new IllegalArgumentException("Objetivo no válido");
            if ((hit.equals("sell") && sell == null) || (hit.equals("stop") && stop == null)) throw new IllegalArgumentException("Falta el precio alcanzado");
            if (target.has("acknowledged") && !(target.get("acknowledged") instanceof Boolean)) throw new IllegalArgumentException("Objetivo no válido");
        }
        JSONObject ambient = input.getJSONObject("ambient");
        for (String key : new String[]{"enabled", "night", "schedule"})
            if (!(ambient.get(key) instanceof Boolean)) throw new IllegalArgumentException("Ambiente no válido");
        for (String key : new String[]{"start", "end"})
            if (!ambient.getString(key).matches("(?:[01]\\d|2[0-3]):[0-5]\\d")) throw new IllegalArgumentException("Hora de Ambiente no válida");
        return new JSONObject(input.toString());
    }

    private static Double price(JSONObject target, String key) throws Exception {
        if (!target.has(key) || target.isNull(key)) return null;
        double value = target.getDouble(key);
        if (!Double.isFinite(value) || value <= 0) throw new IllegalArgumentException("Precio no válido");
        return value;
    }

    static double[] weights(JSONArray assets, JSONObject pro) throws Exception {
        int count = 0;
        for (int i = 0; i < assets.length(); i++) if (!"PORTFOLIO".equals(assets.getJSONObject(i).getString("symbol"))) count++;
        double[] result = new double[count];
        if (count == 0) return result;
        JSONObject average = pro.getJSONObject("average");
        if (!pro.optBoolean("enabled") || !"weighted".equals(average.optString("mode"))) {
            for (int i = 0; i < count; i++) result[i] = 1.0 / count;
            return result;
        }
        JSONObject saved = average.getJSONObject("weights");
        double total = 0;
        int index = 0;
        for (int i = 0; i < assets.length(); i++) {
            String symbol = assets.getJSONObject(i).getString("symbol");
            if ("PORTFOLIO".equals(symbol)) continue;
            result[index++] = saved.optDouble(symbol, 0);
            total += result[index - 1];
        }
        if (total <= 0) {
            for (int i = 0; i < count; i++) result[i] = 1.0 / count;
        } else {
            for (int i = 0; i < count; i++) result[i] /= total;
        }
        return result;
    }

    static JSONObject reconcile(JSONObject pro, JSONArray assets) throws Exception {
        JSONObject updated = new JSONObject(pro.toString());
        JSONObject weights = updated.getJSONObject("average").getJSONObject("weights");
        JSONObject targets = updated.getJSONObject("targets");
        JSONObject nextWeights = new JSONObject();
        JSONObject nextTargets = new JSONObject();
        double total = 0;
        for (int i = 0; i < assets.length(); i++) {
            String symbol = assets.getJSONObject(i).getString("symbol");
            if ("PORTFOLIO".equals(symbol)) continue;
            double value = weights.optDouble(symbol, 1);
            nextWeights.put(symbol, value);
            total += value;
            if (targets.has(symbol)) nextTargets.put(symbol, targets.get(symbol));
        }
        if (total <= 0) total = nextWeights.length();
        for (Iterator<String> keys = nextWeights.keys(); keys.hasNext();) {
            String symbol = keys.next();
            nextWeights.put(symbol, nextWeights.optDouble(symbol, 1) / total * 100);
        }
        updated.getJSONObject("average").put("weights", nextWeights);
        updated.put("targets", nextTargets);
        return updated;
    }

    static String reached(JSONObject target, JSONObject quote) {
        if (target == null || quote == null || quote.optBoolean("stale") || (target.has("hit") && !target.isNull("hit")) || target.optBoolean("acknowledged")) return null;
        double value = quote.optDouble("price", Double.NaN);
        if (!Double.isFinite(value)) return null;
        if (!target.isNull("stop") && value <= target.optDouble("stop")) return "stop";
        if (!target.isNull("sell") && value >= target.optDouble("sell")) return "sell";
        return null;
    }

    static boolean night(JSONObject ambient) {
        if (!ambient.optBoolean("enabled")) return false;
        if (ambient.optBoolean("night")) return true;
        if (!ambient.optBoolean("schedule")) return false;
        String start = ambient.optString("start", "22:00");
        String end = ambient.optString("end", "07:00");
        if (start.equals(end)) return false;
        String now = LocalTime.now().toString().substring(0, 5);
        return start.compareTo(end) < 0 ? now.compareTo(start) >= 0 && now.compareTo(end) < 0
            : now.compareTo(start) >= 0 || now.compareTo(end) < 0;
    }

    static int color(int rgb, double change, JSONObject pro) {
        if (!pro.optBoolean("enabled")) return rgb;
        JSONObject ambient = pro.optJSONObject("ambient");
        if (ambient == null || !ambient.optBoolean("enabled")) return rgb;
        double scale = night(ambient) ? .23 : .42 + .28 * (Double.isFinite(change) ? Math.min(Math.abs(change) / 3, 1) : 0);
        int red = (int) Math.round(((rgb >> 16) & 255) * scale);
        int green = (int) Math.round(((rgb >> 8) & 255) * scale);
        int blue = (int) Math.round((rgb & 255) * scale);
        return (red << 16) | (green << 8) | blue;
    }
}
