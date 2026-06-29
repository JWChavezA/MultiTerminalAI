package com.local.multiterminalai;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.JavascriptInterface;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MainActivity extends Activity {
    private static final String PREFS = "mtai_remote";
    private static final String KEY_URL = "remote_url";
    private static final String KEY_TOKEN = "device_token";

    private WebView webView;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        setupWebView();

        // Edge-to-edge
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                getWindow().setStatusBarColor(Color.TRANSPARENT);
                getWindow().setNavigationBarColor(Color.TRANSPARENT);
                getWindow().setDecorFitsSystemWindows(false);
            } catch (Exception ignored) {}
        }

        String savedUrl = prefs.getString(KEY_URL, "");
        if (savedUrl.isEmpty()) {
            showUrlDialog();
        } else {
            loadRemote(savedUrl);
        }
    }

    private void setupWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(Color.BLACK);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " MultiTerminalAI-Android");

        // Intercept URL loads to capture token from pairing flow
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                // Inject saved token into localStorage so PWA skips pairing
                String savedToken = prefs.getString(KEY_TOKEN, "");
                if (!savedToken.isEmpty()) {
                    view.evaluateJavascript(
                        "try { if (!localStorage.getItem('mtai_token')) localStorage.setItem('mtai_token', '" + savedToken + "'); } catch(e) {}",
                        null);
                }
                // Also capture token when PWA saves it
                view.evaluateJavascript(
                    "(function() { " +
                    "  var orig = localStorage.setItem.bind(localStorage); " +
                    "  localStorage.setItem = function(k, v) { " +
                    "    orig(k, v); " +
                    "    if (k === 'mtai_token') { " +
                    "      AndroidBridge.saveToken(v); " +
                    "    } " +
                    "  }; " +
                    "  var existing = orig('mtai_token'); " +
                    "  if (existing) AndroidBridge.saveToken(existing); " +
                    "})();",
                    null);
            }
        });
        webView.setWebChromeClient(new WebChromeClient());
        // Add JS interface for token persistence
        webView.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void saveToken(String token) {
                prefs.edit().putString(KEY_TOKEN, token).apply();
            }
        }, "AndroidBridge");

        setContentView(webView);
    }

    private void showUrlDialog() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(42, 28, 42, 0);

        TextView help = new TextView(this);
        help.setText("Introduce la URL que muestra MultiTerminalAI en Remoto. Ejemplo: http://100.x.y.z:12345/mobile/");
        help.setTextColor(Color.DKGRAY);
        help.setGravity(Gravity.START);
        layout.addView(help, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setHint("http://IP_TAILSCALE:PUERTO/mobile/");
        input.setText(prefs.getString(KEY_URL, ""));
        layout.addView(input, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        new AlertDialog.Builder(this)
            .setTitle("MultiTerminalAI Remote")
            .setView(layout)
            .setCancelable(false)
            .setPositiveButton("Conectar", (dialog, which) -> {
                String url = normalizeUrl(input.getText().toString());
                prefs.edit().putString(KEY_URL, url).apply();
                loadRemote(url);
            })
            .setNegativeButton("Salir", (dialog, which) -> finish())
            .show();
    }

    private String normalizeUrl(String raw) {
        String url = raw == null ? "" : raw.trim();
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "http://" + url;
        }
        if (!url.endsWith("/mobile/")) {
            if (!url.endsWith("/")) url += "/";
            if (!url.endsWith("mobile/")) url += "mobile/";
        }
        return url;
    }

    private void loadRemote(String url) {
        webView.loadUrl(url);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            showUrlDialog();
        }
    }
}
