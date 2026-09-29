package com.farrapy.openanimator;

import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Termux, para correr ahí el Claude Code oficial del usuario con su plan: el permiso RUN_COMMAND,
 * comandos en Termux (con su resultado) y la conexión por 127.0.0.1 con el puente
 * (android/termux/bridge.mjs). La sesión de Claude queda en Termux: la app nunca la ve.
 */
final class TermuxLink {
    static final String PKG = "com.termux";
    static final String PERMISSION = PKG + ".permission.RUN_COMMAND";
    private static final String HOME = "/data/data/com.termux/files/home";

    private final MainActivity act;
    private final Bridge bridge;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AtomicInteger codes = new AtomicInteger(3000);
    private final Map<Integer, String> permissionWaits = new ConcurrentHashMap<>();
    private final Map<String, Link> links = new ConcurrentHashMap<>();

    TermuxLink(MainActivity act, Bridge bridge) {
        this.act = act;
        this.bridge = bridge;
    }

    private boolean granted() {
        return act.checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED;
    }

    @SuppressWarnings("deprecation")
    JSONObject status() throws JSONException {
        JSONObject o = new JSONObject();
        PackageInfo pi = null;
        try {
            pi = act.getPackageManager().getPackageInfo(PKG, 0);
        } catch (PackageManager.NameNotFoundException ignored) {
        }
        o.put("installed", pi != null);
        if (pi != null) {
            o.put("version", pi.versionName);
            String store = null;
            try {
                store = act.getPackageManager().getInstallerPackageName(PKG);
            } catch (Exception ignored) {
            }
            o.put("store", store == null ? "" : store);
        }
        o.put("permission", pi != null && granted());
        return o;
    }

    // ── permiso ──────────────────────────────────────────────────────────────────

    void requestPermission(final String id) {
        if (granted()) {
            bridge.resolve(id, Bridge.ok(true));
            return;
        }
        final int code = codes.incrementAndGet();
        permissionWaits.put(code, id);
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                act.requestPermissions(new String[]{PERMISSION}, code);
            }
        });
    }

    boolean onPermissionResult(int code, int[] results) {
        String id = permissionWaits.remove(code);
        if (id == null) return false;
        bridge.resolve(id, Bridge.ok(results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED));
        return true;
    }

    // ── comandos (RUN_COMMAND) ───────────────────────────────────────────────────

    void run(final String id, JSONObject a) throws Exception {
        if (!granted()) throw new IOException("OpenAnimator todavía no tiene permiso para usar Termux");
        Intent i = new Intent();
        i.setClassName(PKG, PKG + ".app.RunCommandService");
        i.setAction(PKG + ".RUN_COMMAND");
        i.putExtra(PKG + ".RUN_COMMAND_PATH", a.getString("path"));
        JSONArray arr = a.optJSONArray("args");
        if (arr != null) {
            String[] args = new String[arr.length()];
            for (int k = 0; k < args.length; k++) args[k] = arr.getString(k);
            i.putExtra(PKG + ".RUN_COMMAND_ARGUMENTS", args);
        }
        if (a.has("stdin")) i.putExtra(PKG + ".RUN_COMMAND_STDIN", a.getString("stdin"));
        i.putExtra(PKG + ".RUN_COMMAND_WORKDIR", a.optString("workdir", HOME));
        boolean background = a.optBoolean("background", true);
        i.putExtra(PKG + ".RUN_COMMAND_BACKGROUND", background);
        // Sesión visible: se crea sin abrir Termux (eso lo hace openTermux desde la app, que está al frente).
        if (!background) i.putExtra(PKG + ".RUN_COMMAND_SESSION_ACTION", a.optString("sessionAction", "2"));
        i.putExtra(PKG + ".RUN_COMMAND_COMMAND_LABEL", a.optString("label", "OpenAnimator"));
        boolean wantResult = a.optBoolean("result");
        if (wantResult) i.putExtra(PKG + ".RUN_COMMAND_PENDING_INTENT", resultIntent(id, a.optInt("timeoutMs", 120000)));
        try {
            act.startService(i);
        } catch (IllegalStateException e) {
            if (Build.VERSION.SDK_INT < 26) throw e;
            act.startForegroundService(i);
        } catch (SecurityException e) {
            throw new IOException("Termux no dejó ejecutar el comando: " + e.getMessage());
        }
        if (!wantResult) bridge.resolve(id, Bridge.ok(true));
    }

    /** Termux avisa el resultado con este PendingIntent (a un receptor propio, no exportado). */
    private PendingIntent resultIntent(final String id, int timeoutMs) {
        final int code = codes.incrementAndGet();
        final String action = act.getPackageName() + ".TERMUX_RESULT_" + code;
        final BroadcastReceiver[] self = new BroadcastReceiver[1];
        final Runnable timeout = new Runnable() {
            @Override
            public void run() {
                unregister(self[0]);
                bridge.resolve(id, Bridge.fail("Termux no respondió. Revisá que allow-external-apps esté activado (el comando de preparación lo hace)."));
            }
        };
        self[0] = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent intent) {
                main.removeCallbacks(timeout);
                unregister(this);
                try {
                    Bundle b = intent.getBundleExtra("result");
                    JSONObject o = new JSONObject();
                    if (b != null) {
                        o.put("stdout", b.getString("stdout", ""));
                        o.put("stderr", b.getString("stderr", ""));
                        o.put("exitCode", b.getInt("exitCode", -1));
                        o.put("err", b.getInt("err", 0));
                        o.put("errmsg", b.getString("errmsg", ""));
                    }
                    bridge.resolve(id, Bridge.ok(o));
                } catch (JSONException e) {
                    bridge.resolve(id, Bridge.fail(e.getMessage()));
                }
            }
        };
        IntentFilter filter = new IntentFilter(action);
        if (Build.VERSION.SDK_INT >= 33) act.registerReceiver(self[0], filter, Context.RECEIVER_NOT_EXPORTED);
        else act.registerReceiver(self[0], filter);
        main.postDelayed(timeout, timeoutMs);
        Intent result = new Intent(action).setPackage(act.getPackageName());
        int flags = PendingIntent.FLAG_ONE_SHOT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
        return PendingIntent.getBroadcast(act, code, result, flags);
    }

    private void unregister(BroadcastReceiver r) {
        try {
            act.unregisterReceiver(r);
        } catch (Exception ignored) {
        }
    }

    // ── conexión con el puente ───────────────────────────────────────────────────

    private static final class Link {
        final Socket socket;
        final OutputStream out;

        Link(Socket socket) throws IOException {
            this.socket = socket;
            this.out = new BufferedOutputStream(socket.getOutputStream(), 1 << 16);
        }

        synchronized void write(String line) throws IOException {
            out.write(line.getBytes(StandardCharsets.UTF_8));
            out.write('\n');
            out.flush();
        }

        void close() {
            try {
                socket.close();
            } catch (IOException ignored) {
            }
        }
    }

    /** Conecta con el puente y entrega cada línea que llega como evento; resuelve cuando se corta. */
    void link(String id, JSONObject a) throws Exception {
        Socket s = new Socket();
        try {
            s.connect(new InetSocketAddress("127.0.0.1", a.getInt("port")), 3000);
        } catch (ConnectException e) {
            s.close();
            throw new IOException("sin puente");
        }
        s.setTcpNoDelay(true);
        s.setKeepAlive(true);
        Link l = new Link(s);
        links.put(id, l);
        try {
            l.write(a.getString("hello"));
            BufferedReader r = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8), 1 << 16);
            for (String line; (line = r.readLine()) != null; ) {
                JSONObject ev = new JSONObject();
                ev.put("event", "line");
                ev.put("line", line);
                bridge.event(id, ev);
            }
            bridge.resolve(id, Bridge.ok(true));
        } catch (IOException e) {
            bridge.resolve(id, Bridge.ok(false));
        } finally {
            links.remove(id);
            l.close();
        }
    }

    void send(String link, String line) throws IOException {
        Link l = links.get(link);
        if (l == null) throw new IOException("El puente con Termux no está conectado");
        l.write(line);
    }

    void close(String link) {
        Link l = links.remove(link);
        if (l != null) l.close();
    }

    void closeAll() {
        for (Link l : links.values()) l.close();
        links.clear();
    }

    // ── abrir Termux y los ajustes ───────────────────────────────────────────────

    boolean openTermux() {
        Intent i = act.getPackageManager().getLaunchIntentForPackage(PKG);
        if (i == null) return false;
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            act.startActivity(i);
            return true;
        } catch (ActivityNotFoundException e) {
            return false;
        }
    }

    /** Ajustes de OpenAnimator en Android (si el permiso se negó dos veces, se da desde ahí). */
    void openAppSettings() {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", act.getPackageName(), null));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        act.startActivity(i);
    }
}
