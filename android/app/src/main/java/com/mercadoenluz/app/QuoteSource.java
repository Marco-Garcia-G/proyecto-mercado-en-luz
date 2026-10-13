package com.mercadoenluz.app;

import org.json.JSONArray;
import org.json.JSONObject;

/** Punto único para cambiar de proveedor de datos antes de publicar. */
public interface QuoteSource {
    JSONObject quote(JSONObject asset) throws Exception;
    JSONArray history(String symbol, String range) throws Exception;
    JSONArray search(String text) throws Exception;
}
