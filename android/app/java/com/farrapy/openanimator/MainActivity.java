package com.farrapy.openanimator;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * OpenAnimator for Android: the same interface as the PC version (React) running in a full-screen
 * WebView, with Java doing what Electron's main process does on Windows (files, network, keys,
 * sharing and hardware video encoding). See Bridge and AppServer.
 */
public class MainActivity extends Activity {
    static final String TAG = "OpenAnimator";
    private static final String START_URL = AppServer.APP_ORIGIN + "/index.html";
    private static final int REQ_CHOOSER = 1001;
    private static final int REQ_STORAGE = 1002;

    private WebView web;
    private Bridge bridge;
    private AppServer server;
    private Fs fs;
    private SharedPreferences prefs;
    private boolean immersive = true;
    private ValueCallback<Uri[]> chooser;
    /** A project .zip opened from another app ("Abrir con OpenAnimator"), waiting for the page. */
    private volatile JSONObject pendingOpen;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        prefs = getSharedPreferences("app", MODE_PRIVATE);
        immersive = prefs.getBoolean("immersive", true);
        WebView.setWebContentsDebuggingEnabled(prefs.getBoolean("debug", false));
        try {
            fs = new Fs(new File(getFilesDir(), "data"));
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
        bridge = new Bridge(this, fs, new Secrets(new File(getFilesDir(), "secrets.json")));
        server = new AppServer(getAssets(), fs, new AppServer.PageToken() {
            @Override
            public String next() {
                return bridge.newPageToken();
            }
        });
        createWebView();
        handleIntent(getIntent());
    }

    /** El motor web se cerró y la página se volvió a crear (se le avisa con ?recovered=1). */
    private boolean recovered = false;

    private void createWebView() {
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0b0c0f"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setOffscreenPreRaster(true);
        web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.addJavascriptInterface(bridge, "AndroidBridge");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        setContentView(web);
        // Después de que el motor web se cerró, la página se entera (vuelve al proyecto y retoma a Claude).
        web.loadUrl(recovered ? START_URL + "?recovered=1" : START_URL);
    }

    WebView web() {
        return web;
    }

    // ── ciclo de vida ────────────────────────────────────────────────────────────

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    @Override
    protected void onPause() {
        emit("pause", null);
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        applyImmersive();
        emit("resume", null);
    }

    /** Android pide memoria: la página suelta lo que puede volver a armar (compositores ocultos sin uso). */
    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (level < TRIM_MEMORY_RUNNING_LOW) return;
        try {
            JSONObject o = new JSONObject();
            o.put("level", level);
            emit("memory", o);
        } catch (Exception ignored) {
        }
    }

    @Override
    protected void onDestroy() {
        if (bridge != null) bridge.destroy();
        if (web != null) {
            web.removeJavascriptInterface("AndroidBridge");
            web.destroy();
        }
        web = null;
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersive();
    }

    /** Sends an event to the page: window.__oaNativeEvent(name, data). */
    void emit(String name, JSONObject data) {
        if (web == null) return;
        web.evaluateJavascript("window.__oaNativeEvent&&window.__oaNativeEvent(" + JSONObject.quote(name) + "," + (data == null ? "null" : data.toString()) + ")", null);
    }

    // ── pantalla ─────────────────────────────────────────────────────────────────

    void setFullscreenMode(final boolean on) {
        prefs.edit().putBoolean("immersive", on).apply();
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                immersive = on;
                applyImmersive();
            }
        });
    }

    @SuppressWarnings("deprecation")
    private void applyImmersive() {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c == null) return;
            if (immersive) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            } else {
                c.show(WindowInsets.Type.systemBars());
            }
        } else {
            View d = getWindow().getDecorView();
            d.setSystemUiVisibility(immersive
                    ? View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_FULLSCREEN
                    : View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }

    void setKeepScreenOn(final boolean on) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
        });
    }

    void setDebugging(final boolean on) {
        prefs.edit().putBoolean("debug", on).apply();
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                WebView.setWebContentsDebuggingEnabled(on);
            }
        });
    }

    void requestStoragePermission() {
        if (Build.VERSION.SDK_INT < 29) requestPermissions(new String[]{android.Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
    }

    // ── botón Atrás ──────────────────────────────────────────────────────────────

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web == null) {
            super.onBackPressed();
            return;
        }
        // La interfaz cierra primero lo que tenga abierto (diálogos, menús, el editor…) con window.onAndroidBack().
        web.evaluateJavascript("(function(){try{return !!(window.onAndroidBack&&window.onAndroidBack())}catch(e){return false}})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String handled) {
                        if (!"true".equals(handled)) confirmExit();
                    }
                });
    }

    private void confirmExit() {
        if (isFinishing()) return;
        new AlertDialog.Builder(this)
                .setMessage("¿Salir de OpenAnimator?")
                .setPositiveButton("Salir", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface d, int which) {
                        finish();
                    }
                })
                .setNegativeButton("Cancelar", null)
                .show();
    }

    // ── archivos que llegan de otras apps (proyectos .zip) ───────────────────────

    private void handleIntent(final Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        Uri uri = null;
        if (Intent.ACTION_VIEW.equals(action)) uri = intent.getData();
        else if (Intent.ACTION_SEND.equals(action)) {
            Object extra = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (extra instanceof Uri) uri = (Uri) extra;
            else if (intent.getClipData() != null && intent.getClipData().getItemCount() > 0) uri = intent.getClipData().getItemAt(0).getUri();
        }
        if (uri == null) return;
        final Uri src = uri;
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    ContentResolver cr = getContentResolver();
                    String name = null;
                    try (android.database.Cursor c = cr.query(src, new String[]{android.provider.OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                        if (c != null && c.moveToFirst()) name = c.getString(0);
                    } catch (Exception ignored) {
                    }
                    if (name == null || name.isEmpty()) name = "proyecto.zip";
                    name = name.replaceAll("[\\\\/:*?\"<>|]", "_");
                    String rel = ".incoming/open-" + System.currentTimeMillis() + "/" + name;
                    File f = fs.resolve(rel);
                    //noinspection ResultOfMethodCallIgnored
                    f.getParentFile().mkdirs();
                    try (InputStream in = cr.openInputStream(src); OutputStream out = new FileOutputStream(f)) {
                        if (in == null) return;
                        Fs.copyStream(in, out);
                    }
                    JSONObject o = new JSONObject();
                    o.put("path", rel);
                    o.put("name", name);
                    o.put("size", f.length());
                    pendingOpen = o;
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            emit("open", null);
                        }
                    });
                } catch (Exception e) {
                    Log.w(TAG, "No se pudo abrir el archivo recibido", e);
                }
            }
        }).start();
    }

    /** The page asks for a file opened from another app (null when there is none). */
    JSONObject takePendingOpen() {
        JSONObject o = pendingOpen;
        pendingOpen = null;
        return o;
    }

    // ── resultados de actividades ────────────────────────────────────────────────

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_CHOOSER) {
            if (chooser == null) return;
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null && clip.getItemCount() > 0) {
                    result = new Uri[clip.getItemCount()];
                    for (int i = 0; i < clip.getItemCount(); i++) result[i] = clip.getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
            }
            chooser.onReceiveValue(result);
            chooser = null;
            return;
        }
        if (bridge != null && bridge.onActivityResult(requestCode, resultCode, data)) return;
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (bridge != null && bridge.onPermissionResult(requestCode, grantResults)) return;
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    // ── WebView ──────────────────────────────────────────────────────────────────

    private boolean ours(Uri u) {
        String h = u.getHost();
        return AppServer.APP_HOST.equals(h) || AppServer.PROJECT_HOST.equals(h);
    }

    private final class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            return server.handle(request);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (ours(u)) return false;
            // Enlaces externos (documentación, conseguir claves…): al navegador.
            if (request.isForMainFrame() || request.hasGesture()) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (ActivityNotFoundException ignored) {
                }
                return true;
            }
            return false;
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // Sin memoria u otro fallo del motor web: se vuelve a crear la página sin cerrar la app.
            Log.e(TAG, "El proceso del WebView terminó (crash=" + detail.didCrash() + ")");
            if (view == web) {
                setContentView(new View(MainActivity.this));
                web.destroy();
                web = null;
                recovered = true;
                createWebView();
            }
            return true;
        }
    }

    private final class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (chooser != null) chooser.onReceiveValue(null);
            chooser = callback;
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            String[] mimes = MimeTypes.fromAcceptTypes(params.getAcceptTypes());
            if (mimes.length > 0) intent.putExtra(Intent.EXTRA_MIME_TYPES, mimes);
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try {
                startActivityForResult(intent, REQ_CHOOSER);
                return true;
            } catch (ActivityNotFoundException e) {
                chooser = null;
                return false;
            }
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) Log.w(TAG, m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
            return true;
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            request.deny();
        }
    }
}
