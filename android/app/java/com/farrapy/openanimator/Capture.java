package com.farrapy.openanimator;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.util.Base64;
import android.webkit.WebView;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * Native frame capture for the export (the Android counterpart of capturePage on the PC).
 *
 * A second WebView, hidden behind the app and exactly the size of the video, loads the compositor with
 * capture=1. For each frame JavaScript moves it to t (__oaCap), postVisualStateCallback makes sure the
 * next draw has that state, and the WebView is drawn into a bitmap that goes straight to the encoder:
 * no re-rendering of the DOM, no JPEG and no base64 (before, that was ~90% of the export time).
 * Two bitmaps take turns, so the next frame is captured while the encoder uploads the previous one.
 *
 * The page gets no JavaScript interface: Java only reads window.__oaCapReady / __oaCapDone.
 */
final class Capture {
    private static final String PREFIX = AppServer.PROJECT_ORIGIN + "/p/";

    private final MainActivity act;
    private final Encoder encoder;
    private volatile WebView web;
    private final Bitmap[] bufs = new Bitmap[2];
    private final Canvas[] canvases = new Canvas[2];
    private final Future<?>[] pending = new Future<?>[2];
    private int next, seq, frames;
    private long lastPreview;
    /** Some WebViews only draw into a bitmap in software mode: tried once if the first frame comes out empty. */
    private boolean softwareLayer;

    Capture(MainActivity act, Encoder encoder) {
        this.act = act;
        this.encoder = encoder;
    }

    /** Opens the compositor at width×height pixels and waits until it has loaded. */
    synchronized JSONObject start(final String url, final int width, final int height) throws Exception {
        stop();
        if (url == null || !url.startsWith(PREFIX) || !url.contains("capture=1")) throw new IOException("Dirección de captura inválida");
        if (width < 16 || height < 16 || width > 4096 || height > 4096) throw new IOException("Tamaño de captura inválido");
        final CountDownLatch made = new CountDownLatch(1);
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    web = act.newCaptureView(width, height);
                    web.loadUrl(url);
                } finally {
                    made.countDown();
                }
            }
        });
        if (!made.await(10, TimeUnit.SECONDS) || web == null) throw new IOException("No se pudo crear la vista de captura");
        long deadline = System.currentTimeMillis() + 60000;
        while (true) {
            String r = eval("String(window.__oaCapReady)", 5000);
            if ("\"true\"".equals(r)) break;
            if (r != null && r.startsWith("\"error")) throw new IOException(unquote(r));
            if (System.currentTimeMillis() > deadline) throw new IOException("El compositor no cargó");
            Thread.sleep(40);
        }
        for (int i = 0; i < 2; i++) {
            bufs[i] = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
            canvases[i] = new Canvas(bufs[i]);
            pending[i] = null;
        }
        next = 0;
        frames = 0;
        lastPreview = 0;
        softwareLayer = false;
        JSONObject o = new JSONObject();
        o.put("width", width);
        o.put("height", height);
        return o;
    }

    /**
     * Captures the frame at t and queues it in the encoder (already started). With {@code preview}, it also
     * returns a small JPEG to show in the export dialog.
     */
    synchronized JSONObject frame(double t, boolean preview) throws Exception {
        final WebView w = web;
        if (w == null) throw new IOException("La captura no está abierta");
        final int n = ++seq;
        eval("window.__oaCap(" + t + "," + n + ")", 5000);
        String want = "\"" + n + "\"";
        long deadline = System.currentTimeMillis() + 60000;
        while (true) {
            String r = eval("String(window.__oaCapDone)", 5000);
            if (want.equals(r)) break;
            if (r != null && r.startsWith("\"error")) throw new IOException(unquote(r));
            if (System.currentTimeMillis() > deadline) throw new IOException("La escena tardó demasiado en dibujarse (" + t + " s)");
            Thread.sleep(1);
        }
        final int k = next;
        next ^= 1;
        if (pending[k] != null) await(pending[k]); // el codificador ya subió este bitmap
        final Bitmap b = bufs[k];
        draw(w, n, b, canvases[k]);
        // Los primeros fotogramas se revisan: si el motor no dibujó nada (queda transparente) se prueba una vez
        // en modo software y, si tampoco, la interfaz sigue con el método compatible.
        if (frames < 3 && blank(b)) {
            if (!softwareLayer) {
                softwareLayer = true;
                act.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (web == w) w.setLayerType(android.view.View.LAYER_TYPE_SOFTWARE, null);
                    }
                });
                draw(w, n, b, canvases[k]);
            }
            if (blank(b)) throw new IOException("captura vacía");
        }
        pending[k] = encoder.frameBitmap(b);
        frames++;
        JSONObject o = new JSONObject();
        long now = System.currentTimeMillis();
        if (preview && now - lastPreview > 1000) {
            lastPreview = now;
            o.put("preview", previewJpeg(b));
        }
        return o;
    }

    /** Waits for the frames still in the encoder and closes the hidden WebView. */
    synchronized void stop() throws Exception {
        Exception first = null;
        for (int i = 0; i < 2; i++) {
            Future<?> f = pending[i];
            pending[i] = null;
            if (f == null) continue;
            try {
                await(f);
            } catch (Exception e) {
                if (first == null) first = e;
            }
        }
        close();
        if (first != null && !(first instanceof java.util.concurrent.CancellationException)) throw first;
    }

    /** The encoder's error, not the wrapper's ("java.util.concurrent.ExecutionException: …"). */
    private static void await(Future<?> f) throws Exception {
        try {
            f.get(60, TimeUnit.SECONDS);
        } catch (java.util.concurrent.ExecutionException e) {
            Throwable c = e.getCause();
            throw c instanceof Exception ? (Exception) c : e;
        }
    }

    /** Closes without waiting (the page was reloaded or the export was cancelled). */
    void close() {
        final WebView w = web;
        web = null;
        if (w != null) {
            act.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    act.removeCaptureView(w);
                }
            });
        }
        // Los bitmaps no se reciclan acá: el codificador o un dibujo en curso los pueden estar usando (los libera el GC).
        for (int i = 0; i < 2; i++) {
            bufs[i] = null;
            canvases[i] = null;
        }
    }

    /** Draws the WebView into b as soon as its next draw includes the state requested with seq n. */
    private void draw(final WebView w, final int n, final Bitmap b, final Canvas c) throws Exception {
        final Exception[] err = new Exception[1];
        final CountDownLatch drawn = new CountDownLatch(1);
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (web != w) {
                    err[0] = new IOException("cancelado");
                    drawn.countDown();
                    return;
                }
                // El próximo dibujo del WebView ya tiene el estado de __oaCap (el DOM se procesa aparte).
                w.postVisualStateCallback(n, new WebView.VisualStateCallback() {
                    @Override
                    public void onComplete(long requestId) {
                        try {
                            b.eraseColor(Color.TRANSPARENT);
                            w.draw(c);
                        } catch (Exception e) {
                            err[0] = e;
                        } finally {
                            drawn.countDown();
                        }
                    }
                });
            }
        });
        if (!drawn.await(20, TimeUnit.SECONDS)) throw new IOException("La captura no respondió");
        if (err[0] != null) throw err[0];
    }

    // ── ayudantes ───────────────────────────────────────────────────────────────

    /** Runs JavaScript in the capture page and returns its result as JSON ("\"text\"", "null"…). */
    private String eval(final String js, long timeoutMs) throws Exception {
        final WebView w = web;
        if (w == null) throw new IOException("cancelado");
        final String[] out = new String[1];
        final CountDownLatch done = new CountDownLatch(1);
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (web != w) {
                    done.countDown();
                    return;
                }
                w.evaluateJavascript(js, new android.webkit.ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String v) {
                        out[0] = v;
                        done.countDown();
                    }
                });
            }
        });
        if (!done.await(timeoutMs, TimeUnit.MILLISECONDS)) throw new IOException("La página de captura no responde");
        if (web != w) throw new IOException("cancelado");
        return out[0];
    }

    private static String unquote(String json) {
        try {
            return new org.json.JSONArray("[" + json + "]").getString(0);
        } catch (JSONException e) {
            return json;
        }
    }

    /** True if no sampled pixel was drawn (all transparent). */
    private static boolean blank(Bitmap b) {
        int w = b.getWidth(), h = b.getHeight();
        for (int y = 1; y < 8; y += 2) {
            for (int x = 1; x < 8; x += 2) {
                if (Color.alpha(b.getPixel(w * x / 8, h * y / 8)) != 0) return false;
            }
        }
        return true;
    }

    private static String previewJpeg(Bitmap b) {
        int w = 480, h = Math.max(1, Math.round(480f * b.getHeight() / b.getWidth()));
        Bitmap small = Bitmap.createScaledBitmap(b, w, h, true);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        small.compress(Bitmap.CompressFormat.JPEG, 75, out);
        if (small != b) small.recycle();
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
    }
}
