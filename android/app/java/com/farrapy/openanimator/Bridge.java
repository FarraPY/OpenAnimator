package com.farrapy.openanimator;

import android.app.ActivityManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The "AndroidBridge" object that JavaScript sees. Every call carries a token that only the
 * interface page receives (see init): WebView injects this object into every frame, and project
 * scenes (AI-written HTML) must not be able to use it.
 *
 *   call(token, method, argsJson)            synchronous → {"ok":true,"value":…} | {"ok":false,"error":"…"}
 *   callAsync(token, id, method, argsJson)   the result arrives later in window.__oaNative(id, {ok, value|error})
 *                                            (and {event, …} messages for progress or streamed text)
 */
public final class Bridge {
    private static final String TAG = "OpenAnimator";
    private static final Pattern SECRET = Pattern.compile("\\{\\{secret:([\\w.\\-]+)\\}\\}");

    private final MainActivity act;
    final Fs fs;
    private final Secrets secrets;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Map<String, Http.Handle> requests = new ConcurrentHashMap<>();
    private final Map<Integer, Pending> pending = new ConcurrentHashMap<>();
    private final AtomicInteger reqCodes = new AtomicInteger(2000);
    private final Encoder encoder;
    private final TermuxLink termux;
    private volatile String token;

    private static final class Pending {
        final String id, kind;
        final JSONObject args;

        Pending(String id, String kind, JSONObject args) {
            this.id = id;
            this.kind = kind;
            this.args = args;
        }
    }

    Bridge(MainActivity act, Fs fs, Secrets secrets) {
        this.act = act;
        this.fs = fs;
        this.secrets = secrets;
        this.encoder = new Encoder(fs);
        this.termux = new TermuxLink(act, this);
        newPageToken();
    }

    /**
     * Each load of the interface gets a new token inside its own document (AppServer.page); the
     * previous one stops working. The bridge object is also visible to the project iframes, which
     * never see the document, so they cannot use it.
     */
    String newPageToken() {
        byte[] b = new byte[24];
        new SecureRandom().nextBytes(b);
        String t = Base64.encodeToString(b, Base64.NO_WRAP | Base64.URL_SAFE);
        token = t;
        return t;
    }

    void destroy() {
        for (Http.Handle h : requests.values()) h.cancel();
        encoder.cancel();
        termux.closeAll();
        pool.shutdownNow();
    }

    // ── entrada desde JavaScript ─────────────────────────────────────────────────

    /** Datos del equipo y de la app (el token no: viene en el documento, ver newPageToken). */
    @JavascriptInterface
    public String init() {
        try {
            JSONObject o = new JSONObject();
            o.put("info", appInfo());
            return o.toString();
        } catch (JSONException e) {
            return "{}";
        }
    }

    @JavascriptInterface
    public String call(String tok, String method, String args) {
        if (!token.equals(tok)) return fail("sin permiso");
        try {
            Object v = sync(method, args == null || args.isEmpty() ? new JSONObject() : new JSONObject(args));
            return ok(v);
        } catch (Throwable e) {
            Log.w(TAG, "call " + method, e);
            return fail(message(e));
        }
    }

    @JavascriptInterface
    public void callAsync(String tok, final String id, final String method, final String args) {
        if (!token.equals(tok)) return;
        final JSONObject a;
        try {
            a = args == null || args.isEmpty() ? new JSONObject() : new JSONObject(args);
        } catch (JSONException e) {
            resolve(id, fail("argumentos inválidos"));
            return;
        }
        pool.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    async(id, method, a);
                } catch (Throwable e) {
                    Log.w(TAG, "callAsync " + method, e);
                    resolve(id, fail(message(e)));
                }
            }
        });
    }

    private static String message(Throwable e) {
        String m = e.getMessage();
        return m == null || m.isEmpty() ? e.getClass().getSimpleName() : m;
    }

    static String ok(Object v) {
        try {
            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("value", v == null ? JSONObject.NULL : v);
            return o.toString();
        } catch (JSONException e) {
            return "{\"ok\":true}";
        }
    }

    static String fail(String msg) {
        try {
            JSONObject o = new JSONObject();
            o.put("ok", false);
            o.put("error", msg);
            return o.toString();
        } catch (JSONException e) {
            return "{\"ok\":false}";
        }
    }

    /** Delivers a result (or a progress event) to window.__oaNative(id, json). */
    void resolve(final String id, final String json) {
        final WebView w = act.web();
        if (w == null) return;
        final String js = "window.__oaNative&&window.__oaNative(" + JSONObject.quote(id) + "," + json + ")";
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                WebView cur = act.web();
                if (cur != null) cur.evaluateJavascript(js, null);
            }
        });
    }

    void event(String id, JSONObject ev) {
        resolve(id, ev.toString());
    }

    // ── métodos sincrónicos ──────────────────────────────────────────────────────

    private Object sync(String method, JSONObject a) throws Exception {
        switch (method) {
            case "fs.stat":
                return fs.stat(a.getString("path"));
            case "fs.list":
                return fs.list(a.getString("path"));
            case "fs.walk":
                return fs.walk(a.getString("path"), a.optInt("depth", 8), a.optInt("max", 10000), a.optBoolean("skipHidden", true), a.optJSONArray("skipDirs"));
            case "fs.exists":
                return fs.exists(a.getString("path"));
            case "fs.readText":
                return fs.readText(a.getString("path"));
            case "fs.readTextLimited":
                return fs.readTextLimited(a.getString("path"), a.optLong("max", 200000));
            case "fs.writeText":
                fs.writeText(a.getString("path"), a.getString("text"));
                return true;
            case "fs.writeBase64":
                fs.writeBytes(a.getString("path"), Base64.decode(a.getString("data"), Base64.DEFAULT), a.optBoolean("append"));
                return true;
            case "fs.mkdir":
                fs.mkdirs(a.getString("path"));
                return true;
            case "fs.delete":
                return fs.delete(a.getString("path"));
            case "fs.rename":
                fs.rename(a.getString("from"), a.getString("to"));
                return true;
            case "fs.copy":
                fs.copy(a.getString("from"), a.getString("to"));
                return true;
            case "fs.du":
                return fs.du(a.getString("path"));
            case "secrets.set":
                if (!SECRET_HOSTS.containsKey(a.getString("name"))) throw new IOException("Clave desconocida");
                secrets.set(a.getString("name"), a.optString("value", "").trim());
                return secrets.masked(a.getString("name"));
            case "secrets.masked":
                return secrets.masked(a.getString("name"));
            case "secrets.list": {
                JSONObject o = new JSONObject();
                JSONArray names = a.getJSONArray("names");
                for (int i = 0; i < names.length(); i++) o.put(names.getString(i), secrets.masked(names.getString(i)));
                return o;
            }
            case "http.cancel": {
                Http.Handle h = requests.remove(a.getString("id"));
                if (h != null) h.cancel();
                return true;
            }
            case "app.info":
                return appInfo();
            case "app.takePendingOpen":
                return act.takePendingOpen();
            case "app.toast":
                toast(a.getString("text"));
                return true;
            case "app.keepScreenOn":
                act.setKeepScreenOn(a.optBoolean("on"));
                return true;
            case "app.immersive":
                act.setFullscreenMode(a.optBoolean("on", true));
                return true;
            case "app.debug":
                act.setDebugging(a.optBoolean("on"));
                return true;
            case "app.openUrl":
                openUrl(a.getString("url"));
                return true;
            case "app.exit":
                act.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        act.finish();
                    }
                });
                return true;
            case "clipboard.text": {
                ClipboardManager cm = (ClipboardManager) act.getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText(a.optString("label", "OpenAnimator"), a.getString("text")));
                return true;
            }
            case "termux.status":
                return termux.status();
            case "termux.send":
                termux.send(a.getString("link"), a.getString("line"));
                return true;
            case "termux.close":
                termux.close(a.getString("link"));
                return true;
            case "termux.open":
                return termux.openTermux();
            case "app.openSettings":
                termux.openAppSettings();
                return true;
            case "codec.caps":
                return codecCaps();
            case "enc.start":
                return encoder.start(a);
            case "enc.audio":
                encoder.audio(Base64.decode(a.getString("data"), Base64.DEFAULT));
                return true;
            case "enc.cancel":
                encoder.cancel();
                return true;
            default:
                throw new IllegalArgumentException("Método desconocido: " + method);
        }
    }

    // ── métodos asincrónicos ─────────────────────────────────────────────────────

    private void async(final String id, String method, final JSONObject a) throws Exception {
        switch (method) {
            case "http.request":
                http(id, a);
                return;
            case "fs.copy":
                fs.copy(a.getString("from"), a.getString("to"));
                resolve(id, ok(true));
                return;
            case "fs.delete":
                resolve(id, ok(fs.delete(a.getString("path"))));
                return;
            case "zip.export": {
                String skip = a.optString("skip", "");
                Zip.zipDir(fs.resolve(a.getString("dir")), fs.resolve(a.getString("out")), a.getString("prefix"),
                        skip.isEmpty() ? null : Pattern.compile(skip), progress(id));
                resolve(id, ok(fs.stat(a.getString("out"))));
                return;
            }
            case "zip.import":
                resolve(id, ok(Zip.unzipProject(fs.resolve(a.getString("zip")), fs.resolve(a.getString("dest")), progress(id))));
                return;
            case "pick.files": {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                String[] mimes = strings(a.optJSONArray("accept"));
                if (mimes.length == 1) i.setType(mimes[0]);
                else if (mimes.length > 1) i.putExtra(Intent.EXTRA_MIME_TYPES, mimes);
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, a.optBoolean("multiple", true));
                startForResult(id, "pick", i, a);
                return;
            }
            case "file.save": {
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType(a.optString("mime", MimeTypes.forName(a.getString("name"))));
                i.putExtra(Intent.EXTRA_TITLE, a.getString("name"));
                startForResult(id, "save", i, a);
                return;
            }
            case "file.share": {
                File f = fs.resolve(a.getString("path"));
                if (!f.isFile()) throw new IOException("No existe el archivo");
                Uri uri = SharedFileProvider.uriFor(act, fs.relative(f), a.optString("name", f.getName()));
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType(a.optString("mime", MimeTypes.forName(f.getName())));
                send.putExtra(Intent.EXTRA_STREAM, uri);
                if (a.has("text")) send.putExtra(Intent.EXTRA_TEXT, a.getString("text"));
                send.setClipData(ClipData.newRawUri(f.getName(), uri));
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(Intent.createChooser(send, a.optString("title", "Compartir")));
                resolve(id, ok(true));
                return;
            }
            case "file.open": {
                File f = fs.resolve(a.getString("path"));
                if (!f.isFile()) throw new IOException("No existe el archivo");
                Uri uri = SharedFileProvider.uriFor(act, fs.relative(f), f.getName());
                Intent view = new Intent(Intent.ACTION_VIEW);
                view.setDataAndType(uri, a.optString("mime", MimeTypes.forName(f.getName())));
                view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try {
                    act.startActivity(Intent.createChooser(view, "Abrir con"));
                } catch (ActivityNotFoundException e) {
                    throw new IOException("No hay ninguna app para abrir este archivo");
                }
                resolve(id, ok(true));
                return;
            }
            case "gallery.save":
                resolve(id, ok(saveToGallery(fs.resolve(a.getString("path")), a.optString("name", ""), a.optString("mime", ""))));
                return;
            case "clipboard.image": {
                File f = fs.resolve(a.getString("path"));
                Uri uri = SharedFileProvider.uriFor(act, fs.relative(f), f.getName());
                ClipboardManager cm = (ClipboardManager) act.getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newUri(act.getContentResolver(), f.getName(), uri));
                resolve(id, ok(true));
                return;
            }
            case "audio.peaks":
                resolve(id, ok(AudioDecoder.peaks(existingFile(a.getString("path")), Math.max(1, Math.min(1000, a.optInt("perSec", 100))))));
                return;
            case "audio.decode": {
                // Tramos acotados: la exportación y la transcripción piden de a 30-60 s.
                double dur = a.getDouble("duration");
                if (!(dur > 0 && dur <= 600)) throw new IllegalArgumentException("Duración inválida");
                resolve(id, ok(AudioDecoder.segment(existingFile(a.getString("path")), Math.max(0, a.optDouble("start", 0)), dur, fs.resolve(a.getString("out")))));
                return;
            }
            case "termux.permission":
                termux.requestPermission(id);
                return;
            case "termux.run":
                termux.run(id, a);
                return;
            case "termux.link":
                termux.link(id, a);
                return;
            case "enc.frame":
                encoder.frame(Base64.decode(a.getString("data"), Base64.DEFAULT));
                resolve(id, ok(true));
                return;
            case "enc.finish":
                resolve(id, ok(encoder.finish()));
                return;
            default:
                throw new IllegalArgumentException("Método desconocido: " + method);
        }
    }

    private File existingFile(String path) throws IOException {
        File f = fs.resolve(path);
        if (!f.isFile()) throw new IOException("No existe el archivo: " + path);
        return f;
    }

    private Zip.Progress progress(final String id) {
        return new Zip.Progress() {
            long last;

            @Override
            public void onProgress(long done, long total) {
                long now = System.currentTimeMillis();
                if (now - last < 250) return;
                last = now;
                try {
                    JSONObject ev = new JSONObject();
                    ev.put("event", "progress");
                    ev.put("done", done);
                    ev.put("total", total);
                    event(id, ev);
                } catch (JSONException ignored) {
                }
            }
        };
    }

    private void http(final String id, JSONObject a) throws Exception {
        Http.Request r = new Http.Request();
        r.method = a.optString("method", "GET");
        r.url = a.getString("url");
        if (!r.url.startsWith("https://") && !r.url.startsWith("http://")) throw new IOException("URL inválida");
        JSONObject hs = a.optJSONObject("headers");
        if (hs != null) {
            for (Iterator<String> it = hs.keys(); it.hasNext(); ) {
                String k = it.next();
                String raw = hs.getString(k), filled = fillSecrets(raw, r.url);
                if (!filled.equals(raw)) r.noRedirects = true;
                r.headers.put(k, filled);
            }
        }
        JSONObject body = a.optJSONObject("body");
        if (body != null) {
            String type = body.optString("type", "text");
            if (type.equals("base64")) r.body = Base64.decode(body.getString("data"), Base64.DEFAULT);
            else if (type.equals("file")) r.body = Fs.readBytes(fs.resolve(body.getString("path")), 512L << 20);
            else r.body = body.getString("data").getBytes(StandardCharsets.UTF_8);
        }
        if (a.has("saveTo") && !a.isNull("saveTo")) r.saveTo = fs.resolve(a.getString("saveTo"));
        r.stream = a.optBoolean("stream");
        r.timeoutMs = a.optInt("timeoutMs", 300000);
        Http.Handle h = new Http.Handle();
        requests.put(id, h);
        try {
            JSONObject res = Http.execute(r, new Http.Listener() {
                @Override
                public void onHead(int status, JSONObject headers) {
                    try {
                        JSONObject ev = new JSONObject();
                        ev.put("event", "head");
                        ev.put("status", status);
                        ev.put("headers", headers);
                        event(id, ev);
                    } catch (JSONException ignored) {
                    }
                }

                @Override
                public void onChunk(String text) {
                    try {
                        JSONObject ev = new JSONObject();
                        ev.put("event", "chunk");
                        ev.put("text", text);
                        event(id, ev);
                    } catch (JSONException ignored) {
                    }
                }
            }, h);
            resolve(id, ok(res));
        } finally {
            requests.remove(id);
        }
    }

    /**
     * Each key only travels to its own service: even if something in the page asked for it,
     * {{secret:claude}} can't end up in a request to another host. Keys go in headers only
     * (never in the body, which carries text written by the AI or the user).
     */
    private static final Map<String, String[]> SECRET_HOSTS = new HashMap<>();

    static {
        SECRET_HOSTS.put("claude", new String[]{"api.anthropic.com"});
        SECRET_HOSTS.put("plugin.openai", new String[]{"api.openai.com"});
        SECRET_HOSTS.put("plugin.gemini", new String[]{"generativelanguage.googleapis.com"});
        SECRET_HOSTS.put("plugin.openrouter", new String[]{"openrouter.ai"});
        SECRET_HOSTS.put("plugin.elevenlabs", new String[]{"api.elevenlabs.io"});
        SECRET_HOSTS.put("plugin.fish", new String[]{"api.fish.audio"});
    }

    /** Replaces {{secret:plugin.openai}} with the stored key (only for that key's service, over HTTPS). */
    private String fillSecrets(String s, String url) throws IOException {
        if (s.indexOf("{{secret:") < 0) return s;
        Uri u = Uri.parse(url);
        String host = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.ROOT);
        Matcher m = SECRET.matcher(s);
        StringBuffer sb = new StringBuffer();
        while (m.find()) {
            String[] hosts = SECRET_HOSTS.get(m.group(1));
            boolean allowed = false;
            if (hosts != null && "https".equals(u.getScheme())) for (String x : hosts) if (host.equals(x)) allowed = true;
            if (!allowed) throw new IOException("La clave " + m.group(1) + " no se puede usar con " + host);
            String v = secrets.get(m.group(1));
            if (v.isEmpty()) throw new IOException("Falta la clave " + m.group(1));
            m.appendReplacement(sb, Matcher.quoteReplacement(v));
        }
        m.appendTail(sb);
        return sb.toString();
    }

    // ── actividades del sistema (selector de archivos, guardar como…) ────────────

    private void startForResult(final String id, String kind, final Intent intent, JSONObject a) {
        final int code = reqCodes.incrementAndGet();
        pending.put(code, new Pending(id, kind, a));
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    act.startActivityForResult(intent, code);
                } catch (ActivityNotFoundException e) {
                    pending.remove(code);
                    resolve(id, fail("No hay ninguna app para esta acción"));
                }
            }
        });
    }

    private void startActivity(final Intent intent) {
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    act.startActivity(intent);
                } catch (ActivityNotFoundException e) {
                    toast("No hay ninguna app para esta acción");
                }
            }
        });
    }

    /** Called by MainActivity.onActivityResult. Returns false when the code is not ours. */
    boolean onPermissionResult(int code, int[] results) {
        return termux.onPermissionResult(code, results);
    }

    boolean onActivityResult(int code, final int resultCode, final Intent data) {
        final Pending p = pending.remove(code);
        if (p == null) return false;
        pool.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    if (p.kind.equals("pick")) resolve(p.id, ok(importPicked(p.id, resultCode, data)));
                    else if (p.kind.equals("save")) resolve(p.id, ok(savePicked(p, resultCode, data)));
                } catch (Throwable e) {
                    Log.w(TAG, "activity result", e);
                    resolve(p.id, fail(message(e)));
                }
            }
        });
        return true;
    }

    /** Copies the chosen files to data/.incoming/<id>/ (JavaScript moves them to the project). */
    private JSONArray importPicked(String id, int resultCode, Intent data) throws IOException, JSONException {
        JSONArray out = new JSONArray();
        if (resultCode != MainActivity.RESULT_OK || data == null) return out;
        java.util.List<Uri> uris = new java.util.ArrayList<>();
        if (data.getClipData() != null) {
            for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(data.getClipData().getItemAt(i).getUri());
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }
        String dirRel = ".incoming/" + id.replaceAll("[^\\w-]", "_");
        File dir = fs.resolve(dirRel);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("No se pudo crear " + dirRel);
        ContentResolver cr = act.getContentResolver();
        int n = 0;
        for (Uri u : uris) {
            String name = displayName(cr, u);
            if (name == null || name.isEmpty()) name = "archivo-" + (++n);
            name = name.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_");
            File f = new File(dir, name);
            int k = 2;
            while (f.exists()) {
                int dot = name.lastIndexOf('.');
                f = new File(dir, dot > 0 ? name.substring(0, dot) + "-" + k + name.substring(dot) : name + "-" + k);
                k++;
            }
            long size;
            try (InputStream in = cr.openInputStream(u); OutputStream o = new FileOutputStream(f)) {
                if (in == null) continue;
                size = Fs.copyStream(in, o);
            }
            JSONObject e = new JSONObject();
            e.put("path", dirRel + "/" + f.getName());
            e.put("name", f.getName());
            e.put("size", size);
            String type = cr.getType(u);
            e.put("mime", type != null ? type : MimeTypes.forName(f.getName()));
            out.put(e);
        }
        return out;
    }

    private static String displayName(ContentResolver cr, Uri u) {
        try (Cursor c = cr.query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) {
        }
        String last = u.getLastPathSegment();
        return last == null ? null : last.substring(last.lastIndexOf('/') + 1);
    }

    private JSONObject savePicked(Pending p, int resultCode, Intent data) throws IOException, JSONException {
        JSONObject o = new JSONObject();
        if (resultCode != MainActivity.RESULT_OK || data == null || data.getData() == null) {
            o.put("saved", false);
            return o;
        }
        File src = fs.resolve(p.args.getString("path"));
        try (InputStream in = new FileInputStream(src); OutputStream out = act.getContentResolver().openOutputStream(data.getData(), "w")) {
            if (out == null) throw new IOException("No se pudo escribir el archivo");
            Fs.copyStream(in, out);
        }
        o.put("saved", true);
        o.put("uri", data.getData().toString());
        return o;
    }

    /** Copies a file to the gallery (Movies/OpenAnimator or Pictures/OpenAnimator). */
    private JSONObject saveToGallery(File src, String name, String mime) throws IOException, JSONException {
        if (!src.isFile()) throw new IOException("No existe el archivo");
        if (name.isEmpty()) name = src.getName();
        if (mime.isEmpty()) mime = MimeTypes.forName(name);
        boolean video = mime.startsWith("video/"), image = mime.startsWith("image/");
        String folder = (video ? Environment.DIRECTORY_MOVIES : image ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_DOWNLOADS) + "/OpenAnimator";
        JSONObject o = new JSONObject();
        if (Build.VERSION.SDK_INT >= 29) {
            ContentResolver cr = act.getContentResolver();
            Uri collection = video ? MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                    : image ? MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                    : MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, folder);
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri uri = cr.insert(collection, v);
            if (uri == null) throw new IOException("No se pudo crear el archivo en la galería");
            try (InputStream in = new FileInputStream(src); OutputStream out = cr.openOutputStream(uri, "w")) {
                if (out == null) throw new IOException("No se pudo escribir en la galería");
                Fs.copyStream(in, out);
            } catch (IOException e) {
                cr.delete(uri, null, null);
                throw e;
            }
            v.clear();
            v.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(uri, v, null, null);
            o.put("uri", uri.toString());
        } else {
            if (act.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                act.requestStoragePermission();
                throw new IOException("Hace falta el permiso de almacenamiento: aceptalo y volvé a intentar.");
            }
            @SuppressWarnings("deprecation")
            File dir = new File(Environment.getExternalStoragePublicDirectory(video ? Environment.DIRECTORY_MOVIES : image ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_DOWNLOADS), "OpenAnimator");
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("No se pudo crear " + dir);
            File dst = new File(dir, name);
            Fs.copyTree(src, dst);
            MediaScannerConnection.scanFile(act, new String[]{dst.getPath()}, new String[]{mime}, null);
            o.put("uri", Uri.fromFile(dst).toString());
        }
        o.put("folder", folder);
        return o;
    }

    // ── información del equipo ───────────────────────────────────────────────────

    private JSONObject appInfo() throws JSONException {
        JSONObject o = new JSONObject();
        o.put("platform", "android");
        o.put("sdk", Build.VERSION.SDK_INT);
        o.put("release", Build.VERSION.RELEASE);
        o.put("manufacturer", Build.MANUFACTURER);
        o.put("brand", Build.BRAND);
        o.put("model", Build.MODEL);
        o.put("device", Build.DEVICE);
        o.put("soc", Build.VERSION.SDK_INT >= 31 ? Build.SOC_MANUFACTURER + " " + Build.SOC_MODEL : Build.HARDWARE);
        o.put("versionName", BuildInfo.VERSION_NAME);
        o.put("versionCode", BuildInfo.VERSION_CODE);
        o.put("abi", Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "");
        PackageInfo wv = WebView.getCurrentWebViewPackage();
        if (wv != null) o.put("webview", wv.packageName + " " + wv.versionName);
        DisplayMetrics dm = act.getResources().getDisplayMetrics();
        o.put("density", dm.density);
        o.put("screenWidth", dm.widthPixels);
        o.put("screenHeight", dm.heightPixels);
        ActivityManager am = (ActivityManager) act.getSystemService(Context.ACTIVITY_SERVICE);
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        o.put("memory", mi.totalMem);
        o.put("dataDir", fs.root.getPath());
        return o;
    }

    private static JSONObject codecCaps() throws JSONException {
        JSONObject o = new JSONObject();
        JSONArray list = new JSONArray();
        MediaCodecList mcl = new MediaCodecList(MediaCodecList.REGULAR_CODECS);
        for (MediaCodecInfo info : mcl.getCodecInfos()) {
            if (!info.isEncoder()) continue;
            for (String type : info.getSupportedTypes()) {
                if (!type.equals("video/avc") && !type.equals("video/hevc") && !type.equals("audio/mp4a-latm")) continue;
                JSONObject c = new JSONObject();
                c.put("name", info.getName());
                c.put("type", type);
                if (Build.VERSION.SDK_INT >= 29) c.put("hardware", info.isHardwareAccelerated());
                MediaCodecInfo.CodecCapabilities caps = info.getCapabilitiesForType(type);
                MediaCodecInfo.VideoCapabilities vc = caps.getVideoCapabilities();
                if (vc != null) {
                    c.put("maxWidth", vc.getSupportedWidths().getUpper());
                    c.put("maxHeight", vc.getSupportedHeights().getUpper());
                    c.put("maxBitrate", vc.getBitrateRange().getUpper());
                    c.put("uhd", vc.isSizeSupported(3840, 2160));
                }
                list.put(c);
            }
        }
        o.put("encoders", list);
        o.put("avc", has(list, "video/avc"));
        o.put("hevc", has(list, "video/hevc"));
        o.put("aac", has(list, "audio/mp4a-latm"));
        return o;
    }

    private static boolean has(JSONArray list, String type) throws JSONException {
        for (int i = 0; i < list.length(); i++) if (list.getJSONObject(i).getString("type").equals(type)) return true;
        return false;
    }

    // ── varios ───────────────────────────────────────────────────────────────────

    private void toast(final String text) {
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(act, text, Toast.LENGTH_SHORT).show();
            }
        });
    }

    private void openUrl(String url) {
        if (!url.startsWith("https://") && !url.startsWith("http://") && !url.startsWith("mailto:")) return;
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(i);
    }

    private static String[] strings(JSONArray a) throws JSONException {
        if (a == null) return new String[0];
        String[] out = new String[a.length()];
        for (int i = 0; i < a.length(); i++) out[i] = a.getString(i);
        return out;
    }
}
