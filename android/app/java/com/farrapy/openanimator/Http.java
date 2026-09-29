package com.farrapy.openanimator;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.Reader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * HTTP client for the AI services (Claude, OpenAI, Gemini, ElevenLabs, Fish Audio…).
 * Requests go through Java instead of fetch() so there are no CORS limits and the API keys
 * never reach JavaScript (see Bridge: "{{secret:…}}" placeholders are filled in here).
 */
final class Http {
    interface Listener {
        /** Status and headers, before the body (only with stream = true). */
        void onHead(int status, JSONObject headers);

        void onChunk(String text);
    }

    /** Lets another thread abort a request that is blocked reading. */
    static final class Handle {
        volatile HttpURLConnection conn;
        volatile boolean cancelled;

        void cancel() {
            cancelled = true;
            HttpURLConnection c = conn;
            if (c != null) {
                try {
                    c.disconnect();
                } catch (Exception ignored) {
                }
            }
        }
    }

    static final class Request {
        String method = "GET";
        String url;
        final Map<String, String> headers = new LinkedHashMap<>();
        byte[] body;
        /** Response body goes to this file (binary downloads: audio, images). */
        File saveTo;
        /** Deliver the response body as text chunks while it arrives (server-sent events). */
        boolean stream;
        int timeoutMs = 300000;
    }

    private Http() {
    }

    static JSONObject execute(Request r, Listener listener, Handle h) throws IOException, JSONException {
        HttpURLConnection c = (HttpURLConnection) new URL(r.url).openConnection();
        h.conn = c;
        if (h.cancelled) throw new IOException("cancelado");
        try {
            c.setRequestMethod(r.method.toUpperCase(Locale.ROOT));
            c.setConnectTimeout(30000);
            c.setReadTimeout(Math.max(10000, r.timeoutMs));
            c.setUseCaches(false);
            c.setRequestProperty("User-Agent", "OpenAnimator-Android/" + BuildInfo.VERSION_NAME);
            for (Map.Entry<String, String> e : r.headers.entrySet()) c.setRequestProperty(e.getKey(), e.getValue());
            if (r.body != null) {
                c.setDoOutput(true);
                c.setFixedLengthStreamingMode(r.body.length);
                try (OutputStream out = c.getOutputStream()) {
                    out.write(r.body);
                }
            }
            int status = c.getResponseCode();
            JSONObject res = new JSONObject();
            res.put("status", status);
            JSONObject hs = new JSONObject();
            for (Map.Entry<String, List<String>> e : c.getHeaderFields().entrySet()) {
                if (e.getKey() == null || e.getValue() == null || e.getValue().isEmpty()) continue;
                hs.put(e.getKey().toLowerCase(Locale.ROOT), e.getValue().get(0));
            }
            res.put("headers", hs);
            boolean ok = status >= 200 && status < 300;
            if (r.stream && listener != null) listener.onHead(status, hs);
            InputStream in = ok ? c.getInputStream() : c.getErrorStream();
            if (in == null) {
                res.put("text", "");
                return res;
            }
            try {
                if (ok && r.saveTo != null) {
                    File dir = r.saveTo.getParentFile();
                    if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("No se pudo crear " + dir);
                    File tmp = new File(dir, "." + r.saveTo.getName() + ".part");
                    long size;
                    try (OutputStream out = new FileOutputStream(tmp)) {
                        size = copy(in, out, h);
                    }
                    if (!tmp.renameTo(r.saveTo)) throw new IOException("No se pudo guardar " + r.saveTo.getName());
                    res.put("size", size);
                } else if (r.stream && listener != null) {
                    // Con stream, también los errores llegan en partes (el cliente de Claude los lee así).
                    Reader rd = new InputStreamReader(in, StandardCharsets.UTF_8);
                    char[] buf = new char[8192];
                    int n;
                    int carry = 0;
                    while ((n = rd.read(buf, carry, buf.length - carry)) > 0) {
                        if (h.cancelled) throw new IOException("cancelado");
                        int len = carry + n;
                        // Un emoji (par sustituto) partido entre dos lecturas: la mitad se guarda para la próxima.
                        carry = Character.isHighSurrogate(buf[len - 1]) ? 1 : 0;
                        if (len - carry > 0) listener.onChunk(new String(buf, 0, len - carry));
                        if (carry == 1) buf[0] = buf[len - 1];
                    }
                    if (carry == 1) listener.onChunk(new String(buf, 0, 1));
                } else {
                    byte[] b = readAll(in, 64L << 20, h);
                    res.put("text", new String(b, StandardCharsets.UTF_8));
                    res.put("size", b.length);
                }
            } finally {
                try {
                    in.close();
                } catch (IOException ignored) {
                }
            }
            return res;
        } catch (IOException e) {
            if (h.cancelled) throw new IOException("cancelado");
            throw e;
        } finally {
            c.disconnect();
            h.conn = null;
        }
    }

    private static long copy(InputStream in, OutputStream out, Handle h) throws IOException {
        byte[] buf = new byte[64 * 1024];
        long total = 0;
        int n;
        while ((n = in.read(buf)) > 0) {
            if (h.cancelled) throw new IOException("cancelado");
            out.write(buf, 0, n);
            total += n;
        }
        return total;
    }

    private static byte[] readAll(InputStream in, long max, Handle h) throws IOException {
        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) {
            if (h.cancelled) throw new IOException("cancelado");
            bo.write(buf, 0, n);
            if (bo.size() > max) throw new IOException("Respuesta demasiado grande");
        }
        return bo.toByteArray();
    }
}
