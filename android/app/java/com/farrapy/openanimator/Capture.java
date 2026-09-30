package com.farrapy.openanimator;

import android.app.Presentation;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.hardware.display.VirtualDisplayConfig;
import android.os.Build;
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
import java.util.ArrayList;
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
 * strip is cropped), so the encoder knows which image is which. Which frames are requested and when (ahead,
 * and again if the display skipped one) is GpuFrames. Before starting, a test pattern checks colors,
 * orientation and cropping.
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
    private volatile VirtualDisplay display;
    private volatile Presentation presentation;
    /** Where the virtual display draws (the encoder's texture). */
    private volatile Surface surface;
    /** Which frames are asked for and when (after the test pattern). */
    private volatile GpuFrames gpuFrames;
    /** The capture page as GpuFrames sees it: requests go in order, and its state is read when something's late. */
    private final GpuFrames.Page page = new GpuFrames.Page() {
        @Override
        public void request(double t, int n) throws Exception {
            post("window.__oaCap(" + t + "," + n + ");0");
        }

        @Override
        public String status() throws Exception {
            String s = eval("String(window.__oaCapError || window.__oaCapDone)", 5000);
            return s == null ? null : unquote(s);
        }

        @Override
        public String error() throws Exception {
            String s = eval("String(window.__oaCapError)", 5000);
            return s == null ? null : unquote(s);
        }
    };
    /**
     * The views are created on the UI thread and close() can come from any thread (even while they are
     * being created): with this lock and the generation, views created for a capture that was already
     * closed are closed right there instead of being left open.
     */
    private final Object viewsLock = new Object();
    private int generation;
    // para los detalles de la exportación
    private long statFrames, statNs;
    private JSONObject stateAtStart;

    Capture(MainActivity act, Encoder encoder) {
        this.act = act;
        this.encoder = encoder;
    }

    /** An export's capture is open (for the record of why the web engine closed). */
    boolean active() {
        return web != null;
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
        statFrames = statNs = 0;
        gpuFrames = null;
        try {
            stateAtStart = deviceState();
        } catch (Exception e) {
            stateAtStart = null;
        }
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

    private int generation() {
        synchronized (viewsLock) {
            return generation;
        }
    }

    private void startDraw(final String url, final int width, final int height) throws Exception {
        final int gen = generation();
        final CountDownLatch made = new CountDownLatch(1);
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                WebView v = null;
                try {
                    if (gen != generation()) return;
                    v = act.newCaptureView(width, height);
                    synchronized (viewsLock) {
                        if (gen != generation) return;
                        web = v;
                    }
                    WebView mine = v;
                    v = null; // ya es de la captura: la cierra close()
                    mine.loadUrl(url);
                } finally {
                    if (v != null) act.removeCaptureView(v); // la captura se cerró mientras se creaba
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
        final int gen = generation();
        final Surface target = encoder.gpuSurface(width, height, MARK);
        synchronized (viewsLock) {
            if (gen != generation) {
                encoder.gpuRelease(target);
                throw new IOException("cancelado");
            }
            surface = target;
        }
        final Exception[] err = new Exception[1];
        final CountDownLatch made = new CountDownLatch(1);
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                VirtualDisplay vd = null;
                Presentation pr = null;
                WebView v = null;
                try {
                    if (gen != generation()) return;
                    // Pantalla privada de la app (sin permisos): sólo muestra lo que la app pone en ella.
                    DisplayManager dm = (DisplayManager) act.getSystemService(Context.DISPLAY_SERVICE);
                    if (Build.VERSION.SDK_INT >= 34) {
                        // Con la frecuencia más alta de la pantalla: cada imagen tarda un par de refrescos en llegar.
                        try {
                            vd = dm.createVirtualDisplay(new VirtualDisplayConfig.Builder("OpenAnimator-exportar", width, height + MARK, 160)
                                    .setSurface(target).setRequestedRefreshRate(act.fastestRefreshRate()).build());
                        } catch (RuntimeException e) {
                            vd = null;
                        }
                    }
                    if (vd == null) vd = dm.createVirtualDisplay("OpenAnimator-exportar", width, height + MARK, 160, target, 0);
                    if (vd == null) throw new IOException("No se pudo crear la pantalla virtual");
                    pr = new Presentation(act, vd.getDisplay());
                    Window win = pr.getWindow();
                    if (win != null) {
                        // Antes de Android 11, Presentation usa el tipo de las pantallas públicas y una privada lo rechaza.
                        if (Build.VERSION.SDK_INT < 30) win.setType(WindowManager.LayoutParams.TYPE_PRIVATE_PRESENTATION);
                        win.addFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE);
                    }
                    // Con el contexto de la pantalla virtual (160 dpi): un píxel de la página es un píxel del video.
                    v = act.captureWebView(pr.getContext());
                    pr.setContentView(v, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                    pr.show();
                    synchronized (viewsLock) {
                        if (gen != generation) return; // se cerró mientras se creaba: se cierra acá abajo
                        display = vd;
                        presentation = pr;
                        web = v;
                    }
                    WebView mine = v;
                    vd = null; // ya son de la captura: los cierra close()
                    pr = null;
                    v = null;
                    act.preferFastDisplay(true);
                    mine.loadUrl(url + "&marker=1");
                } catch (Exception e) {
                    err[0] = e;
                } finally {
                    if (vd != null || pr != null || v != null) closeViews(v, pr, vd, null);
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
        String bad = probe(false);
        // El patrón pasa por el anillo del codificador (la copia de cada imagen): si no coincide, se prueba sin él.
        if (bad != null && encoder.gpuRingOff("la prueba del patrón no coincidió: " + bad)) bad = probe(true);
        if (bad != null) throw new IOException(bad);
        gpuFrames = new GpuFrames(encoder, page, TEST_SEQ);
    }

    /**
     * Shows the test pattern and checks what reaches the encoder; null if it matches, otherwise why not. Again:
     * the pattern is already on screen, so a frame of the scene goes first (else no new image would come).
     */
    private String probe(boolean again) throws Exception {
        encoder.gpuForget();
        Encoder.Want w = encoder.gpuExpect(TEST_SEQ, false, true);
        if (again) post("window.__oaCap(0," + (TEST_SEQ - 1) + ");0");
        post("window.__oaCapTest(" + TEST_SEQ + ");0");
        if (!encoder.gpuAwait(w, 10000) || w.status != Encoder.Want.DONE) return "La pantalla virtual no mostró el patrón de prueba";
        String bad = checkPattern(w.pixels, w.pw, w.ph);
        return bad == null ? null : "La captura por GPU no coincide con la página (" + bad + ")";
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
        long t0 = System.nanoTime();
        JSONObject o = gpu ? frameGpu(t, upcoming) : frameDraw(t, preview);
        statNs += System.nanoTime() - t0;
        statFrames++;
        return o;
    }

    /**
     * How the capture went (for the export details): frames, average time per frame here, frames the
     * display skipped, frames requested ahead at the end and the page's own time per frame.
     */
    synchronized JSONObject stats() throws JSONException {
        JSONObject o = new JSONObject();
        o.put("mode", gpu ? "gpu" : "draw");
        o.put("frames", statFrames);
        o.put("msPerFrame", statFrames > 0 ? statNs / 1e6 / statFrames : 0);
        GpuFrames f = gpuFrames;
        if (gpu && f != null) {
            o.put("lost", f.lost);
            o.put("ahead", f.depth);
            JSONArray fa = new JSONArray(), da = new JSONArray();
            for (int i = 0; i <= GpuFrames.MAX_DEPTH; i++) {
                fa.put(f.framesAt[i]);
                da.put(f.dropsAt[i]);
            }
            o.put("framesAt", fa);
            o.put("dropsAt", da);
            o.put("encoder", encoder.gpuStats());
            o.put("screenHz", act.currentRefreshRate());
            VirtualDisplay d = display;
            if (d != null) o.put("displayHz", d.getDisplay().getRefreshRate());
            try {
                String raw = eval("JSON.stringify({log: window.__oaCapLog || null, dpr: window.devicePixelRatio, w: innerWidth, h: innerHeight})", 10000);
                if (raw != null && raw.startsWith("\"")) {
                    JSONObject pg = new JSONObject(unquote(raw));
                    o.put("view", pg.optDouble("w") + "×" + pg.optDouble("h") + " @" + pg.optDouble("dpr"));
                    JSONObject log = pg.optJSONObject("log");
                    if (log != null) timeline(log.optJSONArray("rows"), f.history, o);
                }
            } catch (Exception e) {
                o.put("timelineError", String.valueOf(e.getMessage()));
            }
        }
        if (stateAtStart != null) o.put("stateStart", stateAtStart);
        try {
            o.put("stateEnd", deviceState());
        } catch (Exception ignored) {
            // sin datos del equipo
        }
        try {
            String page = eval("JSON.stringify(window.__oaCapStats || null)", 3000);
            if (page != null && page.startsWith("\"")) o.put("page", new JSONObject(unquote(page)));
        } catch (Exception ignored) {
            // la página ya no está
        }
        return o;
    }

    private JSONObject frameGpu(double t, JSONArray upcoming) throws Exception {
        GpuFrames f = gpuFrames;
        if (web == null || f == null) throw new IOException("La captura no está abierta");
        double[] next = new double[upcoming == null ? 0 : upcoming.length()];
        for (int i = 0; i < next.length; i++) next[i] = upcoming.getDouble(i);
        Encoder.Want w = f.frame(t, next);
        JSONObject o = new JSONObject();
        if (w.pixels != null) {
            o.put("preview", jpeg(w.pixels, w.pw, w.ph));
            w.pixels = null; // la lista de pedidos queda para los detalles, sin las imágenes (medio MB cada una)
        }
        return o;
    }

    /**
     * Where each frame's time goes (median, p90, max in ms), joining the page's log (when the request
     * arrived, started, was ready, was handed over to be drawn) with Java's (requested, image arrived,
     * encoded): to the page · waiting in the page's queue · page's JavaScript · until handed over (rAF) ·
     * engine + virtual display until the image reaches the encoder · encoding · total. Also the time between
     * consecutive encoded frames, the page's frame interval and some frames in full.
     */
    private void timeline(JSONArray rows, java.util.List<Encoder.Want> history, JSONObject o) throws JSONException {
        if (rows == null) return;
        java.util.Map<Integer, double[]> bySeq = new java.util.HashMap<>();
        double[] rafs = new double[rows.length()];
        int nr = 0;
        for (int i = 0; i < rows.length(); i++) {
            JSONArray r = rows.optJSONArray(i);
            if (r == null || r.length() < 4) continue;
            double[] v = new double[5];
            for (int k = 0; k < 5; k++) v[k] = r.optDouble(k + 1, Double.NaN);
            bySeq.put(r.optInt(0), v);
            if (!Double.isNaN(v[4])) rafs[nr++] = v[4];
        }
        String[] names = {"toPage", "queue", "js", "commit", "display", "encode", "total"};
        ArrayList<double[]> segs = new ArrayList<>();
        ArrayList<Encoder.Want> done = new ArrayList<>();
        for (Encoder.Want w : history) {
            if (w.status != Encoder.Want.DONE || w.encodedAt == 0) continue;
            double[] v = bySeq.get(w.seq);
            if (v == null) continue;
            segs.add(new double[]{v[0] - w.requestedAt, v[1] - v[0], v[2] - v[1], v[3] - v[2], w.imageAt - v[3], w.encodedAt - w.imageAt, w.encodedAt - w.requestedAt});
            done.add(w);
        }
        JSONObject agg = new JSONObject();
        for (int k = 0; k < names.length && !segs.isEmpty(); k++) {
            double[] col = new double[segs.size()];
            for (int i = 0; i < col.length; i++) col[i] = segs.get(i)[k];
            agg.put(names[k], spread(col));
        }
        // ritmo: tiempo entre fotogramas codificados seguidos
        if (done.size() > 1) {
            double[] gaps = new double[done.size() - 1];
            for (int i = 1; i < done.size(); i++) gaps[i - 1] = done.get(i).encodedAt - done.get(i - 1).encodedAt;
            agg.put("cadence", spread(gaps));
        }
        o.put("timeline", agg);
        o.put("timelineN", segs.size());
        // intervalo de cuadros de la página: diferencias entre los rAF de entregas seguidas (el 10 % más chico)
        if (nr > 2) {
            double[] d = new double[nr - 1];
            int nd = 0;
            for (int i = 1; i < nr; i++) if (rafs[i] - rafs[i - 1] > 0.5) d[nd++] = rafs[i] - rafs[i - 1];
            if (nd > 0) {
                double[] dd = java.util.Arrays.copyOf(d, nd);
                java.util.Arrays.sort(dd);
                o.put("frameIntervalMs", dd[(int) (nd * 0.1)]);
            }
        }
        // unos fotogramas completos, del medio: ms desde el pedido hasta cada paso
        JSONArray sample = new JSONArray();
        int from = Math.max(0, done.size() / 2 - 6);
        for (int i = from; i < Math.min(done.size(), from + 12); i++) {
            Encoder.Want w = done.get(i);
            double[] v = bySeq.get(w.seq);
            JSONArray r = new JSONArray();
            r.put(w.depth);
            for (double x : new double[]{v[1], v[2], v[3], w.imageAt, w.encodedAt}) r.put(Math.round((x - w.requestedAt) * 10) / 10.0);
            sample.put(r);
        }
        o.put("sample", sample);
    }

    /** Median, 90th percentile and maximum. */
    private static JSONArray spread(double[] col) throws JSONException {
        double[] c = col.clone();
        java.util.Arrays.sort(c);
        JSONArray a = new JSONArray();
        a.put(Math.round(c[c.length / 2] * 10) / 10.0);
        a.put(Math.round(c[Math.min(c.length - 1, (int) (c.length * 0.9))] * 10) / 10.0);
        a.put(Math.round(c[c.length - 1] * 10) / 10.0);
        return a;
    }

    /** Heat (0 none … 6), power saving, free memory and the screen's refresh rate. */
    private JSONObject deviceState() throws JSONException {
        JSONObject st = new JSONObject();
        android.os.PowerManager pm = (android.os.PowerManager) act.getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            if (Build.VERSION.SDK_INT >= 29) st.put("thermal", pm.getCurrentThermalStatus());
            st.put("powerSave", pm.isPowerSaveMode());
        }
        android.app.ActivityManager am = (android.app.ActivityManager) act.getSystemService(Context.ACTIVITY_SERVICE);
        if (am != null) {
            android.app.ActivityManager.MemoryInfo mi = new android.app.ActivityManager.MemoryInfo();
            am.getMemoryInfo(mi);
            st.put("availMB", mi.availMem >> 20);
            st.put("lowMemory", mi.lowMemory);
        }
        st.put("screenHz", act.currentRefreshRate());
        return st;
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
        final WebView w;
        final Presentation p;
        final VirtualDisplay d;
        final Surface s;
        synchronized (viewsLock) {
            generation++;
            w = web;
            p = presentation;
            d = display;
            s = surface;
            web = null;
            presentation = null;
            display = null;
            surface = null;
        }
        final boolean wasGpu = s != null;
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

    /** A small RGBA image (rows top-down) as JPEG in base64, for the export dialog. */
    private static String jpeg(byte[] rgba, int w, int h) {
        Bitmap b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        b.copyPixelsFromBuffer(java.nio.ByteBuffer.wrap(rgba));
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        b.compress(Bitmap.CompressFormat.JPEG, 75, out);
        b.recycle();
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
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
