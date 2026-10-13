package com.mercadoenluz.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;

public final class MainActivity extends Activity {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final int BLUETOOTH_PERMISSION_REQUEST = 17;
    private static final int NOTIFICATION_PERMISSION_REQUEST = 18;
    private WebView webView;

    @SuppressLint("SetJavaScriptEnabled")
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        webView = new WebView(this);
        webView.setBackgroundColor(0xff07090b);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setAllowFileAccess(false);
        webView.getSettings().setAllowContentAccess(false);
        webView.addJavascriptInterface(new Object() {
            @JavascriptInterface public String request(String method, String url, String body) {
                return LedService.getApi(MainActivity.this).request(method, url, body);
            }
        }, "AndroidBridge");
        webView.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!ORIGIN.equals(uri.getScheme() + "://" + uri.getHost())) return null;
                String path = uri.getPath();
                if (path == null || !path.startsWith("/assets/")) return null;
                String asset = path.substring("/assets/".length());
                if (asset.isEmpty() || asset.contains("..") || asset.contains("\\")) return null;
                String mime = asset.endsWith(".html") ? "text/html" : asset.endsWith(".css") ? "text/css"
                    : asset.endsWith(".js") ? "application/javascript" : asset.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
                try {
                    InputStream stream = getAssets().open(asset);
                    return new WebResourceResponse(mime, "UTF-8", stream);
                } catch (IOException ignored) { return null; }
            }

            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                return !ORIGIN.equals(uri.getScheme() + "://" + uri.getHost());
            }
        });
        setContentView(webView);
        Locale locale = getResources().getConfiguration().getLocales().get(0);
        String page = "en".equals(locale.getLanguage()) ? "en/index.html" : "index.html";
        webView.loadUrl(ORIGIN + "/assets/" + page);
        askBluetoothPermission();
    }

    private void askBluetoothPermission() {
        String[] permissions = Build.VERSION.SDK_INT >= 31
            ? new String[] { Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT }
            : new String[] { Manifest.permission.ACCESS_FINE_LOCATION };
        for (String permission : permissions) {
            if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(permissions, BLUETOOTH_PERMISSION_REQUEST);
                return;
            }
        }
        startLedService();
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != BLUETOOTH_PERMISSION_REQUEST) return;
        if (results.length == 0) { LedService.getApi(this).permissionDenied(); return; }
        for (int result : results) {
            if (result != PackageManager.PERMISSION_GRANTED) { LedService.getApi(this).permissionDenied(); return; }
        }
        startLedService();
    }

    private void startLedService() {
        try {
            startForegroundService(new Intent(this, LedService.class));
        } catch (RuntimeException error) {
            LedService.getApi(this).backgroundUnavailable();
        }
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, NOTIFICATION_PERMISSION_REQUEST);
        }
    }

    @Override public void onBackPressed() {
        webView.evaluateJavascript("(() => { if (!document.querySelector('#portfolio-overlay').hidden) { closePortfolioEditor(); return true; } if (!document.querySelector('#detail-overlay').hidden) { closeDetail(); return true; } return false; })()", result -> {
            if (!"true".equals(result)) MainActivity.super.onBackPressed();
        });
    }

    @Override protected void onDestroy() {
        webView.destroy();
        super.onDestroy();
    }
}
