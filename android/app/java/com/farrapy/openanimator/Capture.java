package com.farrapy.openanimator;

import android.app.Presentation;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.util.Base64;
import android.view.Surface;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.ArrayDeque;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * Native frame capture for the export (the Android counterpart of capturePage on the PC). A second
 * WebView loads the compositor with capture=1 and Java moves it to each t (__oaCap). Two modes:
 *
 * "gpu": the WebView lives on a private virtual display (a Presentation) whose images go to a texture of
 * the encoder (Encoder.gpuSurface): what the web engine draws with the GPU reaches the video without ever
 * being copied to memory. The page paints the frame's number in a strip under the video (marker=1; the
 * strip is cropped), so the encoder knows which image is which; the next frames are requested ahead, so
 * the page prepares one while the previous one travels through the display. A frame the display skipped
 * is requested again. Before starting, a test pattern checks colors, orientation and cropping.
 *
 * "draw": the WebView, hidden behind the app and exactly the size of the video, is drawn into a bitmap
 * after postVisualStateCallback (two bitmaps take turns, so the next frame is captured while the
 * encoder uploads the previous one). Slower (the engine draws in software), used if "gpu" fails.
 *
 * The page gets no JavaScript interface: Java only reads window.__oaCapReady / __oaCapDone.
 */
final class Capture {
    private static final String PREFIX = AppServer.PROJECT_ORIGIN + "/p/";
    /** GPU: height in pixels of the marker strip under the video on the virtual display (not in the video). */
    private static final int MARK = 16;
    /** The page's test pattern (__oaCapTest): 3×2 patches, left to right and top to bottom. */
    private static final int[][] PATTERN = {{255, 0, 0}, {0, 255, 0}, {0, 0, 255}, {255, 255, 255}, {128, 128, 128}, {0, 0, 0}};
    /** Number of the test pattern: every cell of the strip red (if the strip slipped into the video, it shows). */
    private static final int TEST_SEQ = 0x249249;

    private final MainActivity act;
    private final Encoder encoder;
    private volatile WebView web;
    private volatile boolean gpu;
    private int seq;
    // draw
    private final Bitmap[] bufs = new Bitmap[2];
    private final Canvas[] canvases = new Canvas[2];
    private final Future<?>[] pending = new Future<?>[2];
    private int next, frames;
    private long lastPreview;
    /** Some WebViews only draw into a bitmap in software mode: tried once if the first frame comes out empty. */
    private boolean softwareLayer;
    // gpu
    private VirtualDisplay display;
    private Presentation presentation;
    /** Where the virtual display draws (the encoder's texture). */
    private Surface surface;
    /** Frames already requested to the page, in order (the next ones the export will ask for). */
    private final ArrayDeque<Req> ahead = new ArrayDeque<>();
    private int depth, drops;
    private boolean prepared;
    private long lastPreviewReq;

    private static final class Req {
        final double t;
        final Encoder.Want want;

        Req(double t, Encoder.Want want) {
            this.t = t;
            this.want = want;
        }
    }

    Capture(MainActivity act, Encoder encoder) {
        this.act = act;
        this.encoder = encoder;
    }

    /**
     * Opens the compositor at width×height pixels and waits until it has loaded. mode "gpu" needs the
     * encoder already started (the virtual display draws into it); if it fails, the caller tries "draw".
     */
    synchronized JSONObject start(final String url, final int width, final int height, String mode) throws Exception {
        stop();
        if (url == null || !url.startsWith(PREFIX) || !url.contains("capture=1")) throw new IOException("Dirección de captura inválida");
        if (width < 16 || height < 16 || width > 4096 || height > 4096) throw new IOException("Tamaño de captura inválido");
        gpu = "gpu".equals(mode);
        try {
            if (gpu) startGpu(url, width, height);
            else startDraw(url, width, height);
        } catch (Exception e) {
            close();
            throw e;
        }
        JSONObject o = new JSONObject();
        o.put("width", width);
        o.put("height", height);
        o.put("mode", gpu ? "gpu" : "draw");
        return o;
    }

    private void startDraw(final String url, final int width, final int height) throws Exception {
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
        waitReady();
        for (int i = 0; i < 2; i++) {
            bufs[i] = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
            canvases[i] = new Canvas(bufs[i]);
            pending[i] = null;
        }
        next = 0;
        frames = 0;
        lastPreview = 0;
        softwareLayer = false;
    }

    private void startGpu(final String url, final int width, final int height) throws Exception {
        final Surface surface = this.surface = encoder.gpuSurface(width, height, MARK);
        final Exception[] err = new Exception[1];
        final CountDownLatch made = new CountDownLatch(1);
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    // Pantalla privada de la app (sin permisos): sólo muestra lo que la app pone en ella.
                    DisplayManager dm = (DisplayManager) act.getSystemService(Context.DISPLAY_SERVICE);
                    display = dm.createVirtualDisplay("OpenAnimator-exportar", width, height + MARK, 160, surface, 0);
                    if (display == null) throw new IOException("No se pudo crear la pantalla virtual");
                    presentation = new Presentation(act, display.getDisplay());
                    Window win = presentation.getWindow();
                    if (win != null) win.addFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE);
                    // Con el contexto de la pantalla virtual (160 dpi): un píxel de la página es un píxel del video.
                    WebView v = act.captureWebView(presentation.getContext());
                    presentation.setContentView(v, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                    presentation.show();
                    act.preferFastDisplay(true);
                    web = v;
                    v.loadUrl(url + "&marker=1");
                } catch (Exception e) {
                    err[0] = e;
                } finally {
                    made.countDown();
                }
            }
        });
        if (!made.await(10, TimeUnit.SECONDS)) throw new IOException("No se pudo crear la pantalla virtual");
        if (err[0] != null) throw err[0];
        if (web == null) throw new IOException("No se pudo crear la vista de captura");
        waitReady();
        // Prueba: la página muestra un patrón conocido. Si lo que llega al codificador no es eso (colores,
        // orientación, recorte de la franja), este equipo usa el otro método.
        seq = TEST_SEQ;
        Encoder.Want w = encoder.gpuExpect(TEST_SEQ, false, true);
        post("window.__oaCapTest(" + TEST_SEQ + ");0");
        if (!encoder.gpuAwait(w, 10000) || w.status != Encoder.Want.DONE) throw new IOException("La pantalla virtual no mostró el patrón de prueba");
        String bad = checkPattern(w.pixels, w.pw, w.ph);
        if (bad != null) throw new IOException("La captura por GPU no coincide con la página (" + bad + ")");
        ahead.clear();
        depth = 2;
        drops = 0;
        prepared = false;
        lastPreviewReq = 0;
    }

    private void waitReady() throws Exception {
        long deadline = System.currentTimeMillis() + 60000;
        while (true) {
            String r = eval("String(window.__oaCapReady)", 5000);
            if ("\"true\"".equals(r)) return;
            if (r != null && r.startsWith("\"error")) throw new IOException(unquote(r));
            if (System.currentTimeMillis() > deadline) throw new IOException("El compositor no cargó");
            Thread.sleep(40);
        }
    }

    /**
     * Captures the frame at t and queues it in the encoder (already started). {@code upcoming}: the times
     * of the next frames of the export (the GPU mode requests them ahead). A small JPEG to show in the
     * export dialog comes back about once a second (with {@code preview}, in draw mode).
     */
    synchronized JSONObject frame(double t, JSONArray upcoming, boolean preview) throws Exception {
        return gpu ? frameGpu(t, upcoming) : frameDraw(t, preview);
    }

    private JSONObject frameGpu(double t, JSONArray upcoming) throws Exception {
        if (web == null) throw new IOException("La captura no está abierta");
        if (!prepared) {
            encoder.gpuPrepare();
            prepared = true;
        }
        long deadline = System.currentTimeMillis() + 60000;
        int lost = 0;
        while (true) {
            Req r = ahead.peekFirst();
            if (r != null && Math.abs(r.t - t) < 1e-9) ahead.pollFirst();
            else {
                // No es lo que se pidió por adelantado (el primero, o después de un fotograma perdido): de cero.
                ahead.clear();
                encoder.gpuForget();
                r = request(t);
            }
            // Los próximos se piden ya: la página prepara uno mientras el anterior viaja por la pantalla.
            for (int i = 0; upcoming != null && i < upcoming.length() && ahead.size() < depth; i++) {
                double tn = upcoming.getDouble(i);
                boolean asked = false;
                for (Req q : ahead) if (Math.abs(q.t - tn) < 1e-9) asked = true;
                if (!asked) ahead.addLast(request(tn));
            }
            long doneSince = 0;
            while (!encoder.gpuAwait(r.want, 1000)) {
                // Todavía no llegó: ¿la página falló, sigue cargando o ya lo mostró y la pantalla no lo entrega?
                String st = eval("String(window.__oaCapError || window.__oaCapDone)", 5000);
                if (st != null && st.startsWith("\"error")) throw new IOException(unquote(st));
                long now = System.currentTimeMillis();
                if (shown(unquote(String.valueOf(st)), r.want.seq)) {
                    if (doneSince == 0) doneSince = now;
                    else if (now - doneSince > 6000) throw new IOException("La pantalla virtual dejó de entregar imágenes");
                }
                if (now > deadline) throw new IOException("La escena tardó demasiado en dibujarse (" + t + " s)");
            }
            if (r.want.status == Encoder.Want.LOST) {
                // La pantalla mostró uno posterior sin mostrar este (o la página no lo pudo dibujar): se vuelve a
                // pedir y, si pasa seguido, con menos fotogramas por adelantado.
                String err = eval("String(window.__oaCapError)", 5000);
                if (err != null && err.startsWith("\"error")) throw new IOException(unquote(err));
                if (++drops % 3 == 0 && depth > 0) depth--;
                if (++lost > 5) throw new IOException("La pantalla virtual se saltea fotogramas");
                ahead.clear();
                encoder.gpuForget();
                continue;
            }
            JSONObject o = new JSONObject();
            if (r.want.previewJpeg != null) o.put("preview", r.want.previewJpeg);
            return o;
        }
    }

    /** Asks the page for the frame at t with a new number; the encoder will take the image with that number. */
    private Req request(double t) throws Exception {
        seq = seq % 0xFFFFFF + 1;
        long now = System.currentTimeMillis();
        boolean preview = now - lastPreviewReq > 1000;
        if (preview) lastPreviewReq = now;
        Encoder.Want w = encoder.gpuExpect(seq, preview, false);
        post("window.__oaCap(" + t + "," + seq + ");0");
        return new Req(t, w);
    }

    /** The page already finished the frame numbered n (its last one is n or a later one). */
    private static boolean shown(String done, int n) {
        try {
            int d = (Integer.parseInt(done) - n) & 0xFFFFFF;
            return d < 0x800000;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    private JSONObject frameDraw(double t, boolean preview) throws Exception {
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

    /** Waits for the frames still in the encoder and closes the capture. */
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
        // Con la GPU, se espera a que la pantalla virtual se cierre antes de que el codificador termine (y
        // suelte la textura en la que dibuja).
        CountDownLatch closed = close();
        if (closed != null && android.os.Looper.myLooper() != android.os.Looper.getMainLooper()) closed.await(5, TimeUnit.SECONDS);
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

    /**
     * Closes without waiting (the page was reloaded or the export was cancelled). The views close on the
     * UI thread: the latch (null if there was nothing to close) says when.
     */
    CountDownLatch close() {
        final WebView w = web;
        final Presentation p = presentation;
        final VirtualDisplay d = display;
        final Surface s = surface;
        final boolean wasGpu = s != null;
        web = null;
        presentation = null;
        display = null;
        surface = null;
        // Lo que se esperaba ya no llega: un frame() en curso termina (y ninguna imagen tardía entra al video).
        if (wasGpu) encoder.gpuForget();
        CountDownLatch closed = null;
        if (w != null || wasGpu) {
            final CountDownLatch done = closed = new CountDownLatch(1);
            act.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        closeViews(w, p, d, s);
                    } finally {
                        done.countDown();
                    }
                }
            });
        }
        // Los bitmaps no se reciclan acá: el codificador o un dibujo en curso los pueden estar usando (los libera el GC).
        for (int i = 0; i < 2; i++) {
            bufs[i] = null;
            canvases[i] = null;
        }
        return closed;
    }

    private void closeViews(WebView w, Presentation p, VirtualDisplay d, Surface s) {
        if (p != null) {
            try {
                p.dismiss();
            } catch (Exception ignored) {
                // la pantalla ya no estaba
            }
            if (w != null) w.destroy();
        } else if (w != null) act.removeCaptureView(w);
        if (d != null) d.release();
        if (s != null) {
            act.preferFastDisplay(false);
            // Recién con la pantalla virtual cerrada se suelta su textura.
            encoder.gpuRelease(s);
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

    /** Runs JavaScript in the capture page without waiting (the GPU mode learns the result from the images). */
    private void post(final String js) throws IOException {
        final WebView w = web;
        if (w == null) throw new IOException("cancelado");
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (web == w) w.evaluateJavascript(js, null);
            }
        });
    }

    private static String unquote(String json) {
        try {
            return new JSONArray("[" + json + "]").getString(0);
        } catch (JSONException e) {
            return json;
        }
    }

    /**
     * null if the small image (RGBA, rows top-down) is the page's test pattern; otherwise, what's off. Each
     * patch is checked at its center (exact color) and near its corners (the orientation, and the crop of the
     * strip: its cells are red, so they would show under the bottom patches).
     */
    static String checkPattern(byte[] px, int w, int h) {
        if (px == null || w < 12 || h < 12 || px.length < w * h * 4) return "sin imagen";
        for (int r = 0; r < 2; r++) {
            for (int c = 0; c < 3; c++) {
                int[] want = PATTERN[r * 3 + c];
                int x0 = w * c / 3 + 2, x1 = w * (c + 1) / 3 - 3, y0 = h * r / 2 + 2, y1 = h * (r + 1) / 2 - 3;
                int[][] pts = {{(x0 + x1) / 2, (y0 + y1) / 2, 10}, {x0, y0, 28}, {x1, y0, 28}, {x0, y1, 28}, {x1, y1, 28}};
                for (int[] p : pts) {
                    int i = (p[1] * w + p[0]) * 4;
                    int dr = Math.abs((px[i] & 0xFF) - want[0]), dg = Math.abs((px[i + 1] & 0xFF) - want[1]), db = Math.abs((px[i + 2] & 0xFF) - want[2]);
                    if (dr > p[2] || dg > p[2] || db > p[2]) {
                        return "en " + p[0] + "," + p[1] + " de " + w + "×" + h + " hay " + (px[i] & 0xFF) + "," + (px[i + 1] & 0xFF) + "," + (px[i + 2] & 0xFF)
                                + " y tenía que haber " + want[0] + "," + want[1] + "," + want[2];
                    }
                }
            }
        }
        return null;
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
