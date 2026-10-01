package com.farrapy.openanimator;

import android.app.Presentation;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Base64;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebView;
import android.widget.FrameLayout;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Fotogramas del proyecto con la GPU, para Claude (oa_ver_fotogramas, oa_hoja_contactos) y las miniaturas: el
 * compositor (capture=1) vive en una pantalla virtual privada cuyas imágenes llegan a un ImageReader. Antes cada
 * fotograma se rasterizaba en JavaScript (modern-screenshot): en la Tab S8+ tardaba 8–14 s con una escena pesada y el
 * primer cuadro de un canvas WebGL salía vacío. Así es lo que dibuja el motor.
 *
 * La página pinta el número de cada pedido en una franja de 16 píxeles abajo (como en Capture) y la imagen se toma
 * cuando la franja dice ese número; se espera un momento por si llega otra con el mismo número (mosaicos que
 * terminaron de rasterizarse). Los pedidos van de a uno (synchronized); close() no espera y corta el que esté.
 */
final class Snap {
    private static final String PREFIX = AppServer.PROJECT_ORIGIN + "/p/";
    private static final int MARK = 16;
    /** Después de la primera imagen con el número pedido, las que lleguen con el mismo número la reemplazan. */
    private static final long SETTLE_MS = 100;

    private final MainActivity act;
    private final Object lock = new Object();
    // Bajo lock
    private WebView web;
    private Presentation presentation;
    private VirtualDisplay display;
    private ImageReader reader;
    private HandlerThread thread;
    private int width, height;
    private int want = -1;
    private Bitmap got;
    private long gotAt;
    private int seq;

    Snap(MainActivity act) {
        this.act = act;
    }

    /** Abre el compositor en url a w×h píxeles y espera a que cargue. */
    synchronized JSONObject open(String url, final int w, final int h) throws Exception {
        close();
        if (url == null || !url.startsWith(PREFIX) || !url.contains("capture=1")) throw new IOException("Dirección de fotogramas inválida");
        if (w < 16 || h < 16 || w > 4096 || h > 4096) throw new IOException("Tamaño de fotogramas inválido");
        final HandlerThread th = new HandlerThread("oa-snap");
        th.start();
        final ImageReader r = ImageReader.newInstance(w, h + MARK, PixelFormat.RGBA_8888, 3);
        r.setOnImageAvailableListener(new ImageReader.OnImageAvailableListener() {
            @Override
            public void onImageAvailable(ImageReader rd) {
                take(rd);
            }
        }, new Handler(th.getLooper()));
        synchronized (lock) {
            width = w;
            height = h;
            reader = r;
            thread = th;
        }
        final String page = url + "&marker=1&vh=" + (h + MARK);
        final Exception[] err = new Exception[1];
        final CountDownLatch made = new CountDownLatch(1);
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                VirtualDisplay vd = null;
                Presentation pr = null;
                WebView v = null;
                try {
                    // Pantalla privada de la app (sin permisos): sólo muestra lo que la app pone en ella. 160 dpi: un
                    // píxel de la página es un píxel de la imagen.
                    DisplayManager dm = (DisplayManager) act.getSystemService(Context.DISPLAY_SERVICE);
                    vd = dm.createVirtualDisplay("OpenAnimator-fotogramas", w, h + MARK, 160, r.getSurface(), 0);
                    if (vd == null) throw new IOException("No se pudo crear la pantalla virtual");
                    pr = new Presentation(act, vd.getDisplay());
                    Window win = pr.getWindow();
                    if (win != null) {
                        if (Build.VERSION.SDK_INT < 30) win.setType(WindowManager.LayoutParams.TYPE_PRIVATE_PRESENTATION);
                        win.addFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE);
                    }
                    v = act.captureWebView(pr.getContext());
                    // Más memoria de mosaicos, como la captura de la exportación (ver Capture.memViews).
                    FrameLayout box = new FrameLayout(pr.getContext());
                    box.addView(v, new FrameLayout.LayoutParams(w, Math.round((h + MARK) * Capture.memViews(act))));
                    pr.setContentView(box, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                    pr.show();
                    synchronized (lock) {
                        if (reader != r) return; // se cerró mientras se creaba: se cierra acá abajo
                        web = v;
                        presentation = pr;
                        display = vd;
                    }
                    WebView mine = v;
                    vd = null;
                    pr = null;
                    v = null;
                    mine.loadUrl(page);
                } catch (Exception e) {
                    err[0] = e;
                } finally {
                    if (vd != null || pr != null || v != null) closeViews(v, pr, vd, null, null);
                    made.countDown();
                }
            }
        });
        try {
            if (!made.await(10, TimeUnit.SECONDS)) throw new IOException("No se pudo crear la pantalla virtual");
            if (err[0] != null) throw err[0];
            waitFor("String(window.__oaCapReady)", "true", 60000, "El compositor no cargó");
        } catch (Exception e) {
            close();
            throw e;
        }
        JSONObject o = new JSONObject();
        o.put("width", w);
        o.put("height", h);
        return o;
    }

    /** El proyecto o el timeline pudieron cambiar en disco: el compositor los vuelve a leer. */
    synchronized void reload() throws Exception {
        post("window.__oaSnapReload=0;window.__oaCompositor.reload().then(function(){window.__oaSnapReload='true'},"
                + "function(e){window.__oaSnapReload='error: '+(e&&e.message||e)});0");
        waitFor("String(window.__oaSnapReload)", "true", 60000, "El compositor no recargó");
    }

    /**
     * El fotograma en t, de outW píxeles de ancho, como JPEG o PNG en base64; con cost, además lo que le cuesta a la
     * escena (la medición mueve la escena: va después de la imagen y con la franja en 0).
     */
    synchronized JSONObject frame(double t, int outW, String format, double quality, boolean cost) throws Exception {
        long t0 = SystemClock.uptimeMillis();
        int n;
        synchronized (lock) {
            if (web == null) throw new IOException("cancelado");
            n = seq = seq % 0xFFFFFF + 1;
            want = n;
            dropGot();
        }
        // El error de un pedido anterior no es de éste (si no, todo pedido lento fallaba con el viejo).
        post("window.__oaCapError=0;window.__oaCap(" + t + "," + n + ");0");
        long deadline = t0 + 60000, check = t0 + 3000;
        Bitmap bm = null;
        while (bm == null) {
            synchronized (lock) {
                if (got != null) {
                    long until = gotAt + SETTLE_MS;
                    for (long now = SystemClock.uptimeMillis(); now < until && web != null; now = SystemClock.uptimeMillis()) lock.wait(until - now);
                    if (got == null) throw new IOException("cancelado"); // se cerró mientras esperaba
                    bm = got;
                    got = null;
                    want = -1;
                    break;
                }
                if (web == null) throw new IOException("cancelado");
                lock.wait(200);
            }
            long now = SystemClock.uptimeMillis();
            if (now > deadline) throw new IOException("La escena tardó demasiado en dibujarse (" + t + " s)");
            if (now > check) {
                check = now + 2000;
                String e = eval("String(window.__oaCapError || '')", 5000);
                if (e != null && e.startsWith("\"error")) throw new IOException(unquote(e));
            }
        }
        int w = bm.getWidth(), h = bm.getHeight();
        int ow = Math.max(16, Math.min(w, outW)), oh = Math.max(16, Math.round(ow * (float) h / w));
        Bitmap out = ow == w ? bm : Bitmap.createScaledBitmap(bm, ow, oh, true);
        boolean png = "png".equals(format);
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        out.compress(png ? Bitmap.CompressFormat.PNG : Bitmap.CompressFormat.JPEG, (int) Math.round(Math.max(0.5, Math.min(1, quality)) * 100), bo);
        if (out != bm) out.recycle();
        bm.recycle();
        JSONObject o = new JSONObject();
        o.put("data", Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP));
        o.put("mime", png ? "image/png" : "image/jpeg");
        o.put("width", ow);
        o.put("height", oh);
        o.put("ms", SystemClock.uptimeMillis() - t0);
        if (cost) {
            try {
                post("window.__oaCapCost(" + t + ");0");
                String c = waitFor("String(window.__oaCapCostResult || '')", null, 20000, "La medición no terminó");
                JSONObject co = new JSONObject(c);
                if (!co.has("error")) o.put("cost", co);
            } catch (Exception e) {
                // sin la medición: la imagen ya está
            }
        }
        return o;
    }

    /** Cierra sin esperar a que termine un pedido (el que esté falla con «cancelado»). */
    void close() {
        final WebView w;
        final Presentation p;
        final VirtualDisplay d;
        final ImageReader r;
        final HandlerThread th;
        synchronized (lock) {
            w = web;
            p = presentation;
            d = display;
            r = reader;
            th = thread;
            web = null;
            presentation = null;
            display = null;
            reader = null;
            thread = null;
            want = -1;
            dropGot();
            lock.notifyAll();
        }
        if (w == null && p == null && d == null && r == null) return;
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                closeViews(w, p, d, r, th);
            }
        });
    }

    boolean isOpen() {
        synchronized (lock) {
            return web != null;
        }
    }

    private void closeViews(WebView w, Presentation p, VirtualDisplay d, final ImageReader r, HandlerThread th) {
        if (p != null) {
            try {
                p.dismiss();
            } catch (Exception ignored) {
                // la pantalla ya no estaba
            }
        }
        if (w != null) {
            if (w.getParent() instanceof ViewGroup) ((ViewGroup) w.getParent()).removeView(w);
            w.destroy();
        }
        if (d != null) d.release();
        // Recién con la pantalla virtual cerrada se sueltan sus imágenes, y en su hilo: cerrar el ImageReader libera la
        // memoria que take() puede estar copiando.
        if (r != null && th != null) {
            new Handler(th.getLooper()).post(new Runnable() {
                @Override
                public void run() {
                    r.close();
                }
            });
        } else if (r != null) r.close();
        if (th != null) th.quitSafely();
    }

    /** Una imagen nueva de la pantalla virtual: si su franja dice el número pedido, queda como la última. */
    private void take(ImageReader rd) {
        Image img;
        try {
            img = rd.acquireLatestImage();
        } catch (Exception e) {
            return;
        }
        if (img == null) return;
        try {
            int w, h, n;
            synchronized (lock) {
                if (want < 0 || rd != reader) return;
                w = width;
                h = height;
                n = want;
            }
            Image.Plane p = img.getPlanes()[0];
            ByteBuffer b = p.getBuffer();
            int rs = p.getRowStride(), ps = p.getPixelStride();
            if (ps != 4 || mark(b, rs, w, h) != n) return;
            byte[] px = new byte[w * h * 4];
            for (int y = 0; y < h; y++) {
                b.position(y * rs);
                b.get(px, y * w * 4, w * 4);
            }
            Bitmap bm = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            bm.copyPixelsFromBuffer(ByteBuffer.wrap(px));
            synchronized (lock) {
                if (want != n) {
                    bm.recycle();
                    return;
                }
                if (got != null) got.recycle();
                got = bm;
                gotAt = SystemClock.uptimeMillis();
                lock.notifyAll();
            }
        } catch (Exception ignored) {
            // imagen ilegible: se espera la próxima
        } finally {
            img.close();
        }
    }

    /** El número de la franja: 8 celdas, 3 bits cada una (rojo, verde y azul prendidos o apagados). */
    private static int mark(ByteBuffer b, int rs, int w, int h) {
        int y = h + MARK / 2, n = 0;
        for (int i = 0; i < 8; i++) {
            int o = y * rs + (2 * i + 1) * w / 16 * 4;
            int v = ((b.get(o) & 0xFF) > 127 ? 1 : 0) | ((b.get(o + 1) & 0xFF) > 127 ? 2 : 0) | ((b.get(o + 2) & 0xFF) > 127 ? 4 : 0);
            n |= v << (3 * i);
        }
        return n;
    }

    private void dropGot() {
        if (got != null) got.recycle();
        got = null;
    }

    /** Evalúa js hasta que dé value (o cualquier cosa no vacía si value es null); un "error: …" corta. */
    private String waitFor(String js, String value, long timeoutMs, String timeoutMsg) throws Exception {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (true) {
            String s = eval(js, 5000);
            String v = s == null ? "" : unquote(s);
            if (v.startsWith("error")) throw new IOException(v);
            if (value == null ? v.length() > 0 && !"null".equals(v) && !"0".equals(v) : value.equals(v)) return v;
            if (SystemClock.uptimeMillis() > deadline) throw new IOException(timeoutMsg);
            Thread.sleep(20);
        }
    }

    /** Evalúa JavaScript en la página y devuelve el resultado como JSON ("\"texto\"", "null"…). */
    private String eval(final String js, long timeoutMs) throws Exception {
        final WebView w;
        synchronized (lock) {
            w = web;
        }
        if (w == null) throw new IOException("cancelado");
        final String[] out = new String[1];
        final CountDownLatch done = new CountDownLatch(1);
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (!isCurrent(w)) {
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
        if (!done.await(timeoutMs, TimeUnit.MILLISECONDS)) throw new IOException("La página de fotogramas no responde");
        if (!isCurrent(w)) throw new IOException("cancelado");
        return out[0];
    }

    private void post(final String js) throws IOException {
        final WebView w;
        synchronized (lock) {
            w = web;
        }
        if (w == null) throw new IOException("cancelado");
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (isCurrent(w)) w.evaluateJavascript(js, null);
            }
        });
    }

    private boolean isCurrent(WebView w) {
        synchronized (lock) {
            return web == w;
        }
    }

    private static String unquote(String json) {
        try {
            return new JSONArray("[" + json + "]").getString(0);
        } catch (JSONException e) {
            return json;
        }
    }
}
