package com.local.multiterminalai;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.JavascriptInterface;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public class MainActivity extends Activity {
    private static final String PREFS = "mtai_remote";
    private static final String KEY_CONNECTIONS = "connections";
    private static final String KEY_ACTIVE_ID = "active_id";
    private static final String KEY_TOKENS = "tokens";

    private WebView webView;
    private SharedPreferences prefs;
    private boolean choosingUrl = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        setupWebView();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                getWindow().setStatusBarColor(Color.TRANSPARENT);
                getWindow().setNavigationBarColor(Color.TRANSPARENT);
                getWindow().setDecorFitsSystemWindows(false);
            } catch (Exception ignored) {}
        }

        // Si no hay conexiones guardadas, mostrar dialogo de agregar
        // Si hay, ir directo al gestor de conexiones (que la PWA controla via bridge)
        if (countConnections() == 0) {
            showAddConnectionDialog(null);
        } else {
            String activeId = prefs.getString(KEY_ACTIVE_ID, null);
            if (activeId == null) {
                // No active, pick first
                try {
                    JSONArray arr = new JSONArray(prefs.getString(KEY_CONNECTIONS, "[]"));
                    if (arr.length() > 0) {
                        activeId = arr.getJSONObject(0).getString("id");
                        prefs.edit().putString(KEY_ACTIVE_ID, activeId).apply();
                    }
                } catch (JSONException e) {}
            }
            if (activeId != null) {
                String url = getUrlForId(activeId);
                if (url != null) loadRemote(url);
                else showAddConnectionDialog(null);
            } else {
                showAddConnectionDialog(null);
            }
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

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                // Si falla la conexion activa, mostrar opciones
                String activeId = prefs.getString(KEY_ACTIVE_ID, null);
                showConnectionErrorDialog(failingUrl, activeId);
            }
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                // Inyectar token guardado y bridge para guardar tokens
                String activeId = prefs.getString(KEY_ACTIVE_ID, null);
                String token = getTokenForId(activeId);
                String tokensJson = prefs.getString(KEY_TOKENS, "{}");
                if (token != null && !token.isEmpty()) {
                    view.evaluateJavascript(
                        "try { if (!localStorage.getItem('mtai_token')) localStorage.setItem('mtai_token', '" + token + "'); } catch(e) {}",
                        null);
                }
                view.evaluateJavascript(
                    "try { var t = localStorage.getItem('mtai_token'); if (t) NativeBridge.reportToken(t); } catch(e) {}",
                    null);
            }
        });
        webView.setWebChromeClient(new WebChromeClient());
        // Bridge: la PWA pide informacion y le decimos que hacer
        webView.addJavascriptInterface(new NativeBridge(this), "NativeBridge");
        setContentView(webView);
    }

    // === Connection management ===

    private int countConnections() {
        try {
            return new JSONArray(prefs.getString(KEY_CONNECTIONS, "[]")).length();
        } catch (JSONException e) {
            return 0;
        }
    }

    private String getUrlForId(String id) {
        try {
            JSONArray arr = new JSONArray(prefs.getString(KEY_CONNECTIONS, "[]"));
            for (int i = 0; i < arr.length(); i++) {
                JSONObject c = arr.getJSONObject(i);
                if (c.getString("id").equals(id)) {
                    return c.getString("url");
                }
            }
        } catch (JSONException e) {}
        return null;
    }

    private String getTokenForId(String id) {
        if (id == null) return null;
        try {
            JSONObject tokens = new JSONObject(prefs.getString(KEY_TOKENS, "{}"));
            return tokens.optString(id, "");
        } catch (JSONException e) {
            return null;
        }
    }

    private void saveTokenForId(String id, String token) {
        if (id == null) return;
        try {
            JSONObject tokens = new JSONObject(prefs.getString(KEY_TOKENS, "{}"));
            tokens.put(id, token);
            prefs.edit().putString(KEY_TOKENS, tokens.toString()).apply();
        } catch (JSONException e) {}
    }

    public void addOrUpdateConnection(String id, String name, String url) {
        if (url == null || url.isEmpty()) return;
        if (id == null || id.isEmpty()) {
            id = "conn_" + System.currentTimeMillis();
        }
        if (name == null || name.isEmpty()) {
            try {
                java.net.URI u = new java.net.URI(url);
                name = u.getHost();
                if (name == null) name = "Conexion";
            } catch (Exception e) {
                name = "Conexion";
            }
        }
        try {
            JSONArray arr = new JSONArray(prefs.getString(KEY_CONNECTIONS, "[]"));
            boolean found = false;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject c = arr.getJSONObject(i);
                if (c.getString("id").equals(id)) {
                    c.put("name", name);
                    c.put("url", url);
                    found = true;
                    break;
                }
            }
            if (!found) {
                JSONObject nc = new JSONObject();
                nc.put("id", id);
                nc.put("name", name);
                nc.put("url", url);
                arr.put(nc);
            }
            prefs.edit().putString(KEY_CONNECTIONS, arr.toString()).apply();
            // Si es la primera, hacerla activa
            if (prefs.getString(KEY_ACTIVE_ID, null) == null) {
                prefs.edit().putString(KEY_ACTIVE_ID, id).apply();
            }
        } catch (JSONException e) {}
    }

    public void removeConnection(String id) {
        try {
            JSONArray arr = new JSONArray(prefs.getString(KEY_CONNECTIONS, "[]"));
            JSONArray narr = new JSONArray();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject c = arr.getJSONObject(i);
                if (!c.getString("id").equals(id)) narr.put(c);
            }
            prefs.edit().putString(KEY_CONNECTIONS, narr.toString()).apply();
            // Eliminar token asociado
            JSONObject tokens = new JSONObject(prefs.getString(KEY_TOKENS, "{}"));
            tokens.remove(id);
            prefs.edit().putString(KEY_TOKENS, tokens.toString()).apply();
            // Si era la activa, elegir otra
            if (id.equals(prefs.getString(KEY_ACTIVE_ID, null))) {
                if (narr.length() > 0) {
                    try {
                        String newActive = narr.getJSONObject(0).getString("id");
                        prefs.edit().putString(KEY_ACTIVE_ID, newActive).apply();
                    } catch (JSONException e) {}
                } else {
                    prefs.edit().remove(KEY_ACTIVE_ID).apply();
                }
            }
        } catch (JSONException e) {}
    }

    public void setActiveConnection(String id) {
        prefs.edit().putString(KEY_ACTIVE_ID, id).apply();
    }

    public String getConnectionsJson() {
        return prefs.getString(KEY_CONNECTIONS, "[]");
    }

    public String getActiveId() {
        return prefs.getString(KEY_ACTIVE_ID, null);
    }

    public void switchToConnection(String id) {
        setActiveConnection(id);
        String url = getUrlForId(id);
        if (url != null) {
            loadRemote(url);
        }
    }

    public void showConnectionsScreen() {
        // Load a special page in the PWA that shows the connection manager
        String activeId = prefs.getString(KEY_ACTIVE_ID, null);
        String url = getUrlForId(activeId);
        if (url == null) {
            // No hay activa, mostrar dialogo
            showAddConnectionDialog(null);
            return;
        }
        // Cargar la PWA con un parametro que indica "mostrar gestor"
        String sep = url.contains("?") ? "&" : "?";
        String target = url + sep + "show=connections";
        loadRemote(target);
    }

    // === Dialog de error de conexion ===
    private void showConnectionErrorDialog(String failingUrl, String activeId) {
        String name = "Conexion";
        if (activeId != null) {
            try {
                JSONArray arr = new JSONArray(prefs.getString(KEY_CONNECTIONS, "[]"));
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject c = arr.getJSONObject(i);
                    if (c.getString("id").equals(activeId)) {
                        name = c.getString("name");
                        break;
                    }
                }
            } catch (JSONException e) {}
        }
        new AlertDialog.Builder(this)
            .setTitle("Conexion no disponible")
            .setMessage("No se pudo conectar a " + name + "\n\n" + failingUrl + "\n\nVerifica que el servidor este corriendo y la URL sea correcta.")
            .setCancelable(false)
            .setPositiveButton("Elegir otra", (dialog, which) -> showConnectionsScreen())
            .setNegativeButton("Reintentar", (dialog, which) -> loadRemote(failingUrl))
            .setNeutralButton("Salir", (dialog, which) -> finish())
            .show();
    }

    public void showAddConnectionDialog(String editId) {
        String existingName = "";
        String existingUrl = "";
        if (editId != null) {
            try {
                JSONArray arr = new JSONArray(prefs.getString(KEY_CONNECTIONS, "[]"));
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject c = arr.getJSONObject(i);
                    if (c.getString("id").equals(editId)) {
                        existingName = c.getString("name");
                        existingUrl = c.getString("url");
                        break;
                    }
                }
            } catch (JSONException e) {}
        }

        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(42, 28, 42, 0);

        TextView nameLabel = new TextView(this);
        nameLabel.setText("Nombre (opcional)");
        nameLabel.setTextColor(Color.DKGRAY);
        layout.addView(nameLabel, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        EditText nameInput = new EditText(this);
        nameInput.setSingleLine(true);
        nameInput.setHint("Mi portatil");
        nameInput.setText(existingName);
        layout.addView(nameInput, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView urlLabel = new TextView(this);
        urlLabel.setText("URL del servidor");
        urlLabel.setTextColor(Color.DKGRAY);
        urlLabel.setPadding(0, 20, 0, 0);
        layout.addView(urlLabel, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        EditText urlInput = new EditText(this);
        urlInput.setSingleLine(true);
        urlInput.setHint("http://100.x.y.z:4173/mobile/");
        urlInput.setText(existingUrl);
        urlInput.setInputType(EditorInfo.TYPE_TEXT_VARIATION_URI);
        layout.addView(urlInput, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        final String editIdFinal = editId;
        final EditText nameInputFinal = nameInput;
        final EditText urlInputFinal = urlInput;

        new AlertDialog.Builder(this)
            .setTitle(editId == null ? "Agregar conexion" : "Editar conexion")
            .setView(layout)
            .setCancelable(false)
            .setPositiveButton(editId == null ? "Agregar" : "Guardar", (dialog, which) -> {
                String name = nameInputFinal.getText().toString().trim();
                String url = normalizeUrl(urlInputFinal.getText().toString().trim());
                addOrUpdateConnection(editIdFinal, name, url);
                // Si es la primera o se pidio conectar, ir directo
                if (prefs.getString(KEY_ACTIVE_ID, null) == null) {
                    // pick first
                    try {
                        JSONArray arr = new JSONArray(prefs.getString(KEY_CONNECTIONS, "[]"));
                        if (arr.length() > 0) {
                            String firstId = arr.getJSONObject(0).getString("id");
                            setActiveConnection(firstId);
                            loadRemote(getUrlForId(firstId));
                            return;
                        }
                    } catch (JSONException e) {}
                } else if (editIdFinal != null) {
                    // editando: si era la activa, recargar
                    if (editIdFinal.equals(prefs.getString(KEY_ACTIVE_ID, null))) {
                        loadRemote(url);
                    } else {
                        // ir a gestor
                        showConnectionsScreen();
                    }
                } else if (countConnections() == 1) {
                    // Era la primera conexion y ya esta activa, cargar directo
                    try {
                        JSONArray arr = new JSONArray(prefs.getString(KEY_CONNECTIONS, "[]"));
                        if (arr.length() > 0) {
                            String firstId = arr.getJSONObject(0).getString("id");
                            loadRemote(getUrlForId(firstId));
                            return;
                        }
                    } catch (JSONException e) {}
                    showConnectionsScreen();
                } else {
                    // agregando nueva (ya hay otras): ir al gestor
                    showConnectionsScreen();
                }
            })
            .setNegativeButton("Cancelar", (dialog, which) -> {
                if (countConnections() > 0) {
                    // Volver al gestor
                    showConnectionsScreen();
                } else {
                    finish();
                }
            })
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
            // Show "add new" dialog
            showAddConnectionDialog(null);
        }
    }

    // === JS Bridge ===

    public class NativeBridge {
        private final MainActivity activity;
        public NativeBridge(MainActivity activity) {
            this.activity = activity;
        }

        @JavascriptInterface
        public String getConnections() {
            return activity.getConnectionsJson();
        }

        @JavascriptInterface
        public String getActiveId() {
            return activity.getActiveId();
        }

        @JavascriptInterface
        public void setActive(String id) {
            final String fid = id;
            activity.runOnUiThread(new Runnable() {
                @Override public void run() { activity.switchToConnection(fid); }
            });
        }

        @JavascriptInterface
        public void remove(String id) {
            activity.removeConnection(id);
            // Reload page so JS reads new state (must run on UI thread)
            final String fid = id;
            activity.runOnUiThread(new Runnable() {
                @Override public void run() {
                    String activeId = activity.getActiveId();
                    String url = activeId != null ? activity.getUrlForId(activeId) : null;
                    if (url != null) activity.loadRemote(url);
                    else activity.showAddConnectionDialog(null);
                }
            });
        }

        @JavascriptInterface
        public void addNew() {
            activity.runOnUiThread(new Runnable() {
                @Override public void run() { activity.showAddConnectionDialog(null); }
            });
        }

        @JavascriptInterface
        public void edit(String id) {
            final String fid = id;
            activity.runOnUiThread(new Runnable() {
                @Override public void run() { activity.showAddConnectionDialog(fid); }
            });
        }

        @JavascriptInterface
        public void reportToken(String token) {
            String id = activity.getActiveId();
            if (id != null) activity.saveTokenForId(id, token);
        }

        @JavascriptInterface
        public void goToActive() {
            activity.runOnUiThread(new Runnable() {
                @Override public void run() {
                    String id = activity.getActiveId();
                    if (id != null) {
                        String url = activity.getUrlForId(id);
                        if (url != null) activity.loadRemote(url);
                    }
                }
            });
        }

        @JavascriptInterface
        public void showManager() {
            activity.runOnUiThread(new Runnable() {
                @Override public void run() { activity.showConnectionsScreen(); }
            });
        }
    }
}
