package com.farrapy.openanimator;

import java.io.IOException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;

/**
 * Which frames the GPU capture asks the page for, and when (Capture's "gpu" mode; apart from the views, so the
 * PC can test it against a simulated page, display and GPU).
 *
 * The next frames are requested ahead: the page prepares one while the previous one travels through the
 * virtual display. The display sometimes never shows one (on the Tab S8+, when the page draws one per refresh
 * the web engine skips some). Two ways to go on:
 * - in order (without the ring): the lost frame and everything requested after it are asked for again;
 * - reorder (with the ring, Encoder.gpuReorder): what arrives after the lost one waits in the ring and only the
 *   lost frame is asked for again (at the end of the page's queue); the encoder puts them in the video in order.
 * How far ahead: in order, by blocks of 60 frames (down if 10 % were lost, up if almost none); reorder, by the
 * speed of each block (it keeps going the way that made the last block faster).
 */
final class GpuFrames {
    /** The capture page: Capture drives the WebView; the test, a simulated page. */
    interface Page {
        /** Asks for the frame at t, painted with number seq. The page draws the requests in the order they come. */
        void request(double t, int seq) throws Exception;

        /** window.__oaCapError || window.__oaCapDone: the page's error ("error: …") or the last number it finished. */
        String status() throws Exception;

        /** window.__oaCapError ("error: …"), or anything else if there's none. */
        String error() throws Exception;
    }

    static final int MAX_DEPTH = 6;
    /** In order, at most this many ahead (a lost frame takes all of them with it). */
    static final int IN_ORDER_MAX = 4;

    private final Encoder encoder;
    private final Page page;
    int seq;
    int depth;
    private int blockFrames, blockDrops, dir = 1;
    private long blockStart;
    private double lastBlockFps;
    /** For the export details: frames lost (each asked for again), and frames / losses at each depth. */
    long lost;
    final long[] framesAt = new long[MAX_DEPTH + 1], dropsAt = new long[MAX_DEPTH + 1];
    /** Every frame requested, with its times (the details show where the time goes). */
    final ArrayList<Encoder.Want> history = new ArrayList<>();
    private long lastPreviewReq;
    /** In order: requested ahead, in order. */
    private final ArrayDeque<Req> ahead = new ArrayDeque<>();
    /** Reorder: requested and not yet in the video, by key. */
    private final Map<Long, Req> reqs = new HashMap<>();

    private static final class Req {
        final double t;
        final Encoder.Want want;

        Req(double t, Encoder.Want want) {
            this.t = t;
            this.want = want;
        }
    }

    GpuFrames(Encoder encoder, Page page, int seq) {
        this.encoder = encoder;
        this.page = page;
        this.seq = seq;
        depth = encoder.gpuReorder() ? Math.min(3, maxDepth()) : 2;
        blockStart = System.nanoTime();
    }

    /** The frame's place in the video (its time in µs). */
    static long key(double t) {
        return Math.round(t * 1e6);
    }

    /** Captures the frame at t (upcoming: the times of the next ones); returns once it's in the video. */
    Encoder.Want frame(double t, double[] upcoming) throws Exception {
        return encoder.gpuReorder() ? reorder(t, upcoming) : inOrder(t, upcoming);
    }

    private int maxDepth() {
        return Math.max(1, Math.min(MAX_DEPTH, encoder.gpuSlots() - 2));
    }

    private Encoder.Want inOrder(double t, double[] upcoming) throws Exception {
        if (!reqs.isEmpty()) {
            // Venía reordenando y el anillo se apagó: se olvida todo y sigue en orden desde acá.
            reqs.clear();
            encoder.gpuForget();
            depth = Math.min(depth, 2);
        }
        long deadline = System.currentTimeMillis() + 60000;
        int lostHere = 0;
        boolean again = false;
        while (true) {
            Req r = ahead.peekFirst();
            if (r != null && Math.abs(r.t - t) < 1e-9 && r.want.status != Encoder.Want.LOST) ahead.pollFirst();
            else {
                // No es lo que se pidió por adelantado (el primero, o después de un fotograma perdido): de cero.
                again |= r != null && Math.abs(r.t - t) < 1e-9 && r.want.preview;
                ahead.clear();
                encoder.gpuForget();
                r = request(t, again);
            }
            // Los próximos se piden ya: la página prepara uno mientras el anterior viaja por la pantalla (salvo que
            // éste ya se haya perdido, o que se haya perdido dos veces: solo, sin otros detrás, no se puede perder,
            // porque no llega ninguna imagen más nueva que lo reemplace).
            int want = lostHere >= 2 ? 0 : Math.min(depth, IN_ORDER_MAX);
            for (int i = 0; upcoming != null && i < upcoming.length && ahead.size() < want && r.want.status != Encoder.Want.LOST; i++) {
                double tn = upcoming[i];
                boolean asked = false;
                for (Req q : ahead) if (Math.abs(q.t - tn) < 1e-9) asked = true;
                if (!asked) ahead.addLast(request(tn));
            }
            long doneSince = 0;
            while (!encoder.gpuAwait(r.want, 1000)) {
                // Todavía no llegó: ¿la página falló, sigue cargando o ya lo mostró y la pantalla no lo entrega?
                String st = page.status();
                if (st != null && st.startsWith("error")) throw new IOException(st);
                long now = System.currentTimeMillis();
                if (shown(st, r.want.seq)) {
                    if (doneSince == 0) doneSince = now;
                    else if (now - doneSince > 6000) throw new IOException("La pantalla virtual dejó de entregar imágenes");
                }
                if (now > deadline) throw new IOException("La escena tardó demasiado en dibujarse (" + t + " s)");
            }
            if (r.want.status == Encoder.Want.LOST) {
                // La pantalla mostró uno posterior sin mostrar este (o la página no lo pudo dibujar): se vuelve a pedir.
                again = r.want.preview;
                countLost();
                ahead.clear();
                encoder.gpuForget();
                String err = page.error();
                if (err != null && err.startsWith("error")) throw new IOException(err);
                if (++lostHere > 5) throw new IOException("La pantalla virtual se saltea fotogramas");
                continue;
            }
            framesAt[Math.min(depth, MAX_DEPTH)]++;
            block(false);
            return r.want;
        }
    }

    private Encoder.Want reorder(double t, double[] upcoming) throws Exception {
        ahead.clear();
        long deadline = System.currentTimeMillis() + 60000;
        long key = key(t);
        int lostHere = 0;
        long shownSince = 0;
        while (true) {
            long seen = encoder.gpuLosses();
            if (!encoder.gpuReorder()) return inOrder(t, upcoming); // el anillo se apagó: en orden desde acá
            Req r = reqs.get(key);
            if (r == null || r.want.status == Encoder.Want.LOST) {
                if (r != null) {
                    countLost();
                    String err = page.error();
                    if (err != null && err.startsWith("error")) throw new IOException(err);
                    if (++lostHere > 5) throw new IOException("La pantalla virtual se saltea fotogramas");
                }
                r = request(t, r != null && r.want.preview);
                reqs.put(key, r);
                shownSince = 0;
            }
            // Los siguientes: los nuevos y, otra vez, los que se perdieron. Si éste se perdió dos veces va solo al final
            // de la cola de la página: sin nada detrás que lo reemplace, no se puede perder.
            int want = lostHere >= 2 ? 0 : Math.min(depth, maxDepth());
            for (int i = 0; upcoming != null && i < upcoming.length && i < want; i++) {
                long kn = key(upcoming[i]);
                Req q = reqs.get(kn);
                if (q != null && q.want.status != Encoder.Want.LOST) continue;
                if (q != null) countLost();
                reqs.put(kn, request(upcoming[i], q != null && q.want.preview));
            }
            Encoder.Want w = r.want;
            int ch = w.status == Encoder.Want.DONE ? 1 : encoder.gpuAwaitChange(w, 1000, seen);
            if (w.status == Encoder.Want.DONE) {
                reqs.remove(key);
                framesAt[Math.min(depth, MAX_DEPTH)]++;
                block(true);
                return w;
            }
            if (ch == 0) {
                // Nada en un segundo: ¿la página falló, sigue dibujando, o ya lo terminó y la pantalla no lo muestra?
                String st = page.status();
                if (st != null && st.startsWith("error")) throw new IOException(st);
                long now = System.currentTimeMillis();
                if (w.status == Encoder.Want.WAITING && shown(st, w.seq)) {
                    if (shownSince == 0) shownSince = now;
                    else if (now - shownSince > 1500) encoder.gpuLose(w); // se pide otra vez arriba
                }
                if (now > deadline) throw new IOException("La escena tardó demasiado en dibujarse (" + t + " s)");
            }
            // perdido éste u otro: arriba se vuelve a pedir lo que haga falta
        }
    }

    private void countLost() {
        lost++;
        dropsAt[Math.min(depth, MAX_DEPTH)]++;
        blockDrops++;
    }

    /**
     * Every 60 frames, how far ahead. In order: fewer if many were lost (each one takes everything requested after
     * it), more if almost none. Reorder (a lost frame costs little): one step each block, the same way while the
     * blocks get faster, the other way when one gets slower.
     */
    private void block(boolean byRate) {
        if (++blockFrames < 60) return;
        long now = System.nanoTime();
        if (byRate) {
            double fps = 60e9 / Math.max(1, now - blockStart);
            if (lastBlockFps > 0 && fps < lastBlockFps) dir = -dir;
            lastBlockFps = fps;
            depth = Math.max(1, Math.min(maxDepth(), depth + dir));
        } else if (blockDrops >= 6 && depth > 0) depth--;
        else if (blockDrops <= 1 && depth < IN_ORDER_MAX) depth++;
        blockFrames = blockDrops = 0;
        blockStart = now;
    }

    /** Asks the page for the frame at t with a new number; the encoder will take the image with that number. */
    private Req request(double t) throws Exception {
        return request(t, false);
    }

    /** again: a lost one that had asked for its small image (for the export dialog) asks for it again. */
    private Req request(double t, boolean again) throws Exception {
        seq = seq % 0xFFFFFF + 1;
        long now = System.currentTimeMillis();
        boolean preview = again || now - lastPreviewReq > 1000;
        if (preview) lastPreviewReq = now;
        Encoder.Want w = encoder.gpuExpect(seq, key(t), preview, false);
        w.requestedAt = Encoder.wallMs();
        w.depth = depth;
        history.add(w);
        page.request(t, seq);
        return new Req(t, w);
    }

    /** The page already finished the frame numbered n (its last one is n or a later one). */
    static boolean shown(String done, int n) {
        try {
            int d = (Integer.parseInt(done) - n) & 0xFFFFFF;
            return d < 0x800000;
        } catch (NumberFormatException e) {
            return false;
        }
    }
}
