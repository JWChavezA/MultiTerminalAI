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
import android.content.pm.PackageManager;
import android.net.Uri;
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

        // Siempre ir al administrador de conexiones (la PWA muestra el gestor HTML)
        // Si el usuario quiere conectar a una, toca la card y el WebView navega alla
        String activeId = prefs.getString(KEY_ACTIVE_ID, null);
        String activeUrl = activeId != null ? getUrlForId(activeId) : null;
        if (activeUrl == null && countConnections() > 0) {
            // Hay conexiones pero sin activa, elegir la primera
            try {
                JSONArray arr = new JSONArray(prefs.getString(KEY_CONNECTIONS, "[]"));
                if (arr.length() > 0) {
                    activeId = arr.getJSONObject(0).getString("id");
                    prefs.edit().putString(KEY_ACTIVE_ID, activeId).apply();
                    activeUrl = arr.getJSONObject(0).getString("url");
                }
            } catch (JSONException e) {}
        }
        // Cargar el gestor con la conexion activa como parametro (para resaltarla)
        if (activeUrl != null) {
            String sep = activeUrl.contains("?") ? "&" : "?";
            loadRemote(activeUrl + sep + "show=connections&active=" + activeId);
        } else {
            // No hay conexiones, mostrar gestor vacio
            showConnectionsScreen();
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
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(android.webkit.PermissionRequest request) {
                request.grant(request.getResources());
            }
            @Override
            public boolean onShowFileChooser(WebView webView,
                    android.webkit.ValueCallback<Uri[]> filePathCallback,
                    FileChooserParams fileChooserParams) {
                mFilePathCallback = filePathCallback;
                // Verificar permiso de camara
                if (checkSelfPermission(android.Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                    // Pedir permiso. El resultado se procesa en onRequestPermissionsResult
                    pendingFileChooser = filePathCallback;
                    requestPermissions(new String[]{android.Manifest.permission.CAMERA}, 2001);
                    return true;
                }
                return openCameraChooser();
            }
        });
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
        // Si hay conexiones, cargar la PWA con parametro gestor
        // Si no hay, mostrar el gestor HTML inline (no dialog nativo) con empty state
        String activeId = prefs.getString(KEY_ACTIVE_ID, null);
        String url = getUrlForId(activeId);
        if (url == null) {
            showConnectionsEmptyState();
            return;
        }
        String sep = url.contains("?") ? "&" : "?";
        String target = url + sep + "show=connections";
        loadRemote(target);
    }

    private void showScanUrlDialog() {
        // Dialogo para pegar la URL del QR (o escribir manualmente)
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(42, 28, 42, 0);

        TextView help = new TextView(this);
        help.setText("Pega la URL del QR mostrado en el escritorio, o escribe la direccion del servidor.");
        help.setTextColor(Color.DKGRAY);
        layout.addView(help, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setHint("http://100.x.y.z:4173/mobile/?pair=...");
        layout.addView(input, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        new AlertDialog.Builder(this)
            .setTitle("Conectar via QR")
            .setView(layout)
            .setCancelable(true)
            .setPositiveButton("Conectar", (dialog, which) -> {
                String url = normalizeUrl(input.getText().toString().trim());
                // Si tiene ?pair=, extraer el codigo
                processQRUrl(url);
            })
            .setNegativeButton("Cancelar", null)
            .show();
    }

    public void processQRUrl(String url) {
        // Extraer pair code si existe
        String pairCode = "";
        String baseUrl = url;
        if (url.contains("?pair=") || url.contains("&pair=")) {
            try {
                java.net.URI uri = new java.net.URI(url);
                String query = uri.getRawQuery();
                if (query != null) {
                    for (String param : query.split("&")) {
                        if (param.startsWith("pair=")) {
                            pairCode = param.substring(5);
                            break;
                        }
                    }
                }
                baseUrl = uri.getScheme() + "://" + uri.getHost();
                if (uri.getPort() > 0) baseUrl += ":" + uri.getPort();
                baseUrl += "/mobile/";
            } catch (Exception e) {}
        }
        // Crear la conexion
        addOrUpdateConnection(null, null, baseUrl);
        // Si hay pair code, cargar la URL con el pair
        if (!pairCode.isEmpty()) {
            loadRemote(baseUrl + "?pair=" + pairCode);
        } else {
            loadRemote(baseUrl);
        }
    }

    private void showConnectionsEmptyState() {
        // Cargar HTML inline con el gestor en empty state.
        // El boton Agregar llama a NativeBridge.addNew() (bridge existente).
        String html =
            "<!DOCTYPE html>" +
            "<html lang='es'>" +
            "<head>" +
            "<meta charset='utf-8'>" +
            "<meta name='viewport' content='width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover'>" +
            "<meta name='theme-color' content='#06070d'>" +
            "<title>Conexiones - MultiTerminalAI Remote</title>" +
            "<style>" +
            ":root{color-scheme:dark;--bg:#06070d;--bg-grad:radial-gradient(ellipse 600px 400px at 80% -5%,rgba(34,211,238,.12),transparent 55%),radial-gradient(ellipse 500px 350px at -10% 5%,rgba(48,207,145,.10),transparent 55%),radial-gradient(ellipse 400px 300px at 50% 110%,rgba(160,85,247,.08),transparent 55%),linear-gradient(180deg,#070b16 0%,#06070d 40%,#04050a 100%);--text:#eef4ff;--muted:#8b9bb4;--panel:rgba(18,26,44,.72);--line:rgba(36,53,79,.5);--cyan:#22d3ee;--green:#3ccf91;--radius:18px}" +
            "*{box-sizing:border-box;margin:0;padding:0}" +
            "html,body{height:100%;overflow:hidden;font:16px/1.4 -apple-system,system-ui,sans-serif;color:var(--text);background:var(--bg-grad);background-attachment:fixed}" +
            ".screen{height:100dvh;display:flex;flex-direction:column;padding:env(safe-area-inset-top) 16px env(safe-area-inset-bottom) 16px env(safe-area-inset-left) env(safe-area-inset-right)}" +
            ".screen[hidden]{display:none}" +
            ".mobile-header{padding:max(12px,env(safe-area-inset-top)) 0 12px;display:flex;align-items:center}" +
            ".mobile-header h1{font-size:18px;font-weight:700;flex:1;text-align:center}" +
            ".conn-header{padding:0 4px 16px;border-bottom:1px solid var(--line);margin-bottom:16px}" +
            ".conn-header p{color:var(--muted);font-size:14px}" +
            ".conn-list{display:flex;flex-direction:column;gap:8px;flex:1 1 auto;overflow-y:auto;-webkit-overflow-scrolling:touch}" +
            ".conn-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 20px;text-align:center;color:var(--muted);gap:8px;flex:1}" +
            ".conn-empty-icon{width:80px;height:80px;display:grid;place-items:center;border-radius:24px;background:linear-gradient(135deg,rgba(34,211,238,.15),rgba(160,85,247,.1));margin-bottom:8px}" +
            ".conn-empty-icon svg{width:40px;height:40px;color:var(--cyan)}" +
            ".conn-empty h3{font-size:22px;font-weight:800;background:linear-gradient(135deg,var(--cyan),var(--green));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:8px}" +
            ".conn-empty p{max-width:280px;font-size:14px;line-height:1.5;color:var(--muted)}" +
            ".conn-add-button{display:flex;align-items:center;justify-content:center;gap:8px;height:54px;border:1.5px dashed var(--line);border-radius:16px;background:transparent;color:var(--cyan);font-size:15px;font-weight:700;cursor:pointer;margin-top:12px;transition:all .15s ease;-webkit-tap-highlight-color:transparent;font-family:inherit}" +
            ".conn-add-button:active{background:rgba(34,211,238,.08);border-color:var(--cyan)}" +
            ".conn-add-button svg{width:18px;height:18px}" +
            ".conn-scan-button{display:flex;align-items:center;justify-content:center;gap:8px;height:54px;border:0;border-radius:16px;background:linear-gradient(135deg,rgba(34,211,238,.15),rgba(160,85,247,.1));color:#22d3ee;font-size:15px;font-weight:700;cursor:pointer;margin-top:8px;font-family:inherit;-webkit-tap-highlight-color:transparent}" +
            ".conn-scan-button:active{transform:scale(.97)}" +
            ".conn-scan-button svg{width:20px;height:20px}" +
            "</style>" +
            "</head>" +
            "<body>" +
            "<main id='connectionsView' class='screen connections-screen'>" +
            "<header class='mobile-header'><h1>Conexiones</h1></header>" +
            "<div class='conn-header'><p>Tus servidores MultiTerminalAI. Toca uno para conectar.</p></div>" +
            "<div id='connList' class='conn-list'>" +
            "<div class='conn-empty'>" +
            "<div class='conn-empty-icon'>" +
            "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.5'>" +
            "<rect x='2' y='3' width='20' height='14' rx='2'/><path d='M8 21h8M12 17v4'/>" +
            "</svg></div>" +
            "<h3>Bienvenido</h3>" +
            "<p>Conectate a tus servidores MultiTerminalAI para empezar a controlar sesiones de terminal desde tu telefono.</p>" +
            "</div></div>" +
            "<button id='connAddButton' class='conn-add-button' onclick='NativeBridge.addNew()'>" +
            "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.5'><path d='M12 5v14M5 12h14'/></svg>" +
            " Agregar conexion" +
            "</button>" +
            "<button class='conn-scan-button' onclick='NativeBridge.scanQR()'>" +
            "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'><rect x='3' y='3' width='7' height='7' rx='1'/><rect x='14' y='3' width='7' height='7' rx='1'/><rect x='3' y='14' width='7' height='7' rx='1'/><path d='M14 14h3M14 17h7M17 14v3M20 17v4'/></svg>" +
            " Escanear QR" +
            "</button>" +
            "</main>" +
            "</body></html>";
        webView.loadDataWithBaseURL("http://localhost", html, "text/html", "utf-8", null);
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

    private android.webkit.ValueCallback<Uri[]> mFilePathCallback;
    private android.webkit.ValueCallback<Uri[]> pendingFileChooser;

    private boolean openCameraChooser() {
        try {
            android.content.Intent galIntent = new android.content.Intent(android.content.Intent.ACTION_GET_CONTENT);
            galIntent.setType("image/*");
            android.content.Intent camIntent = new android.content.Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE);
            android.content.Intent chooser = android.content.Intent.createChooser(galIntent, "Capturar QR");
            chooser.putExtra(android.content.Intent.EXTRA_INITIAL_INTENTS, new android.content.Intent[]{camIntent});
            startActivityForResult(chooser, 1001);
        } catch (Exception e) {
            if (mFilePathCallback != null) {
                mFilePathCallback.onReceiveValue(null);
                mFilePathCallback = null;
            }
            return false;
        }
        return true;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == 2001) {
            boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (granted && pendingFileChooser != null) {
                mFilePathCallback = pendingFileChooser;
                pendingFileChooser = null;
                openCameraChooser();
            } else if (pendingFileChooser != null) {
                // Permiso denegado: sin camara, solo galeria
                mFilePathCallback = pendingFileChooser;
                pendingFileChooser = null;
                try {
                    android.content.Intent galIntent = new android.content.Intent(android.content.Intent.ACTION_GET_CONTENT);
                    galIntent.setType("image/*");
                    startActivityForResult(android.content.Intent.createChooser(galIntent, "Elegir imagen"), 1001);
                } catch (Exception e) {
                    mFilePathCallback.onReceiveValue(null);
                    mFilePathCallback = null;
                }
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, android.content.Intent data) {
        if (requestCode == 1001 && mFilePathCallback != null) {
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                results = new Uri[]{ data.getData() };
            } else if (resultCode == RESULT_OK && data != null && data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                results = new Uri[count];
                for (int i = 0; i < count; i++) {
                    results[i] = data.getClipData().getItemAt(i).getUri();
                }
            }
            mFilePathCallback.onReceiveValue(results);
            mFilePathCallback = null;
        }
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
        public void addConnection(String url) {
            activity.addOrUpdateConnection(null, null, url);
        }

        @JavascriptInterface
        public void processQR(final String url) {
            activity.runOnUiThread(new Runnable() {
                @Override public void run() { activity.processQRUrl(url); }
            });
        }

        @JavascriptInterface
        public void scanQR() {
            // En el empty state (sin server cargado), no tenemos jsQR disponible.
            // Mostrar dialogo nativo para pegar URL del QR.
            activity.runOnUiThread(new Runnable() {
                @Override public void run() { activity.showScanUrlDialog(); }
            });
        }

        @JavascriptInterface
        public void saveConnection(String url) {
            activity.addOrUpdateConnection(null, null, url);
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
