package com.farrapy.openanimator;

import android.content.res.AssetManager;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Serves the app and the projects to the WebView (the Android version of electron/protocol.ts):
 *
 *   https://appassets.androidplatform.net/…        the interface (assets/www) and /fs/… (data files, only for the app)
 *   https://oaproject.androidplatform.net/p/<id>/…  project files, with the scene runtime injected into each HTML
 *   https://oaproject.androidplatform.net/p/<id>/__oa/…  runtime and compositor (same origin as the scenes)
 *   https://oaproject.androidplatform.net/ut/<id>/…      user templates (previews)
 *
 * Scenes live on a different origin than the interface, so an AI-written scene cannot reach the app.
 */
final class AppServer {
    static final String APP_HOST = "appassets.androidplatform.net";
    static final String PROJECT_HOST = "oaproject.androidplatform.net";
    static final String APP_ORIGIN = "https://" + APP_HOST;
    static final String PROJECT_ORIGIN = "https://" + PROJECT_HOST;
    private static final Pattern RANGE = Pattern.compile("bytes=(\\d*)-(\\d*)");

    /** Token nuevo del puente para cada carga de la interfaz (ver Bridge.newPageToken). */
    interface PageToken {
        String next();
    }

    private final AssetManager assets;
    private final Fs fs;
    private final PageToken pageToken;

    AppServer(AssetManager assets, Fs fs, PageToken pageToken) {
        this.assets = assets;
        this.fs = fs;
        this.pageToken = pageToken;
    }

    WebResourceResponse handle(WebResourceRequest req) {
        Uri u = req.getUrl();
        String host = u.getHost();
        if (!APP_HOST.equals(host) && !PROJECT_HOST.equals(host)) return null;
        String method = req.getMethod() == null ? "GET" : req.getMethod().toUpperCase(java.util.Locale.ROOT);
        boolean head = method.equals("HEAD");
        boolean app = APP_HOST.equals(host);
        Map<String, String> h = baseHeaders(app);
        if (!method.equals("GET") && !head) return error(405, "Method Not Allowed", h);
        String path = u.getPath() == null ? "/" : u.getPath();
        try {
            if (app) {
                if (path.startsWith("/fs/")) {
                    // La carpeta de datos se lee con fetch/img/audio/video, nunca como página: un HTML de un
                    // proyecto abierto acá correría en el origen de la interfaz (con acceso a todo).
                    h.put("Content-Security-Policy", "sandbox; default-src 'none'");
                    h.put("X-Frame-Options", "DENY");
                    h.put("X-Content-Type-Options", "nosniff");
                    return file(fs.resolve(safeRel(path.substring(4))), req, h, false, null, head);
                }
                if (path.equals("/") || path.isEmpty()) path = "/index.html";
                if (path.equals("/index.html") && req.isForMainFrame() && !head) return page(h);
                return asset("www" + path, h, head);
            }
            if (path.startsWith("/app/")) return asset("www" + path, h, head);
            if (path.startsWith("/ut/")) return file(fs.resolve("templates/" + safeRel(path.substring(4))), req, h, false, null, head);
            if (path.startsWith("/p/")) {
                String rest = path.substring(3);
                int slash = rest.indexOf('/');
                if (slash <= 0) return error(404, "Not Found", h);
                String id = rest.substring(0, slash), rel = safeRel(rest.substring(slash + 1));
                if (id.contains("..") || id.contains("\\")) return error(404, "Not Found", h);
                if (rel.startsWith("__oa/")) return asset("www/app/runtime/" + rel.substring(5), h, head);
                return file(fs.resolve("projects/" + id + "/" + rel), req, h, true, id, head);
            }
            return error(404, "Not Found", h);
        } catch (IOException e) {
            return error(404, "Not Found", h);
        } catch (RuntimeException e) {
            // Un pedido raro (Range inválido, ruta con "..") no puede tirar la app: shouldInterceptRequest no lo ataja.
            return error(400, "Bad Request", h);
        }
    }

    /** Ruta relativa sin ".." ni barras invertidas (una escena no puede leer fuera de su proyecto). */
    private static String safeRel(String rel) {
        if (rel.indexOf('\\') >= 0) throw new IllegalArgumentException("ruta inválida");
        for (String part : rel.split("/")) if (part.equals("..")) throw new IllegalArgumentException("ruta inválida");
        return rel;
    }

    private static Map<String, String> baseHeaders(boolean app) {
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-cache");
        // Los archivos de los proyectos los puede leer la interfaz (otro origen); /fs/ no se comparte con nadie.
        if (!app) h.put("Access-Control-Allow-Origin", APP_ORIGIN);
        return h;
    }

    private static WebResourceResponse error(int code, String reason, Map<String, String> h) {
        return new WebResourceResponse("text/plain", "UTF-8", code, reason, h, new ByteArrayInputStream(new byte[0]));
    }

    private static String encodingFor(String mime) {
        return MimeTypes.isText(mime) ? "UTF-8" : null;
    }

    /**
     * La interfaz con el token del puente de esta carga. Viaja dentro del documento principal (nunca
     * a un iframe ni a un fetch), así que ya está antes de que corra cualquier script de la página.
     */
    private WebResourceResponse page(Map<String, String> h) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        try (InputStream in = assets.open("www/index.html")) {
            byte[] buf = new byte[16384];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        }
        String html = new String(out.toByteArray(), StandardCharsets.UTF_8);
        String meta = "<meta name=\"oa-bridge\" content=\"" + pageToken.next() + "\">";
        int i = html.indexOf("<head>");
        html = i >= 0 ? html.substring(0, i + 6) + meta + html.substring(i + 6) : meta + html;
        h.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/html", "UTF-8", 200, "OK", h, new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)));
    }

    private WebResourceResponse asset(String path, Map<String, String> h, boolean head) {
        if (path.contains("..")) return error(404, "Not Found", h);
        try {
            InputStream in = assets.open(path);
            String mime = MimeTypes.forName(path);
            if (head) {
                in.close();
                in = new ByteArrayInputStream(new byte[0]);
            }
            return new WebResourceResponse(mime, encodingFor(mime), 200, "OK", h, in);
        } catch (IOException e) {
            return error(404, "Not Found", h);
        }
    }

    private WebResourceResponse file(File f, WebResourceRequest req, Map<String, String> h, boolean inject, String projectId, boolean head) throws IOException {
        if (!f.isFile()) return error(404, "Not Found", h);
        String mime = MimeTypes.forName(f.getName());
        long size = f.length();
        h.put("Accept-Ranges", "bytes");
        if (inject && mime.equals("text/html")) {
            String html = new String(Fs.readBytes(f, 64L << 20), StandardCharsets.UTF_8);
            byte[] b = injectRuntime(html, projectId).getBytes(StandardCharsets.UTF_8);
            return new WebResourceResponse(mime, "UTF-8", 200, "OK", h, new ByteArrayInputStream(head ? new byte[0] : b));
        }
        String range = header(req, "Range");
        if (range != null) {
            Matcher m = RANGE.matcher(range);
            if (m.find()) {
                long start, end;
                if (m.group(1).isEmpty() && !m.group(2).isEmpty()) {
                    start = Math.max(0, size - Long.parseLong(m.group(2)));
                    end = size - 1;
                } else {
                    start = m.group(1).isEmpty() ? 0 : Long.parseLong(m.group(1));
                    end = m.group(2).isEmpty() ? size - 1 : Math.min(Long.parseLong(m.group(2)), size - 1);
                }
                if (start > end || start >= size) {
                    h.put("Content-Range", "bytes */" + size);
                    return error(416, "Range Not Satisfiable", h);
                }
                long len = end - start + 1;
                h.put("Content-Range", "bytes " + start + "-" + end + "/" + size);
                h.put("Content-Length", String.valueOf(len));
                InputStream in = head ? new ByteArrayInputStream(new byte[0]) : new Slice(new FileInputStream(f), start, len);
                return new WebResourceResponse(mime, encodingFor(mime), 206, "Partial Content", h, in);
            }
        }
        h.put("Content-Length", String.valueOf(size));
        InputStream in = head ? new ByteArrayInputStream(new byte[0]) : new FileInputStream(f);
        return new WebResourceResponse(mime, encodingFor(mime), 200, "OK", h, in);
    }

    private static String header(WebResourceRequest req, String name) {
        Map<String, String> hs = req.getRequestHeaders();
        if (hs == null) return null;
        for (Map.Entry<String, String> e : hs.entrySet()) {
            if (e.getKey() != null && e.getKey().equalsIgnoreCase(name)) return e.getValue();
        }
        return null;
    }

    /** Same rule as the PC: the runtime is the first script of every project page. */
    static String injectRuntime(String html, String projectId) {
        if (html.contains("oa-runtime.js")) return html;
        String tag = "<script src=\"/p/" + projectId + "/__oa/oa-runtime.js\"></script>";
        Matcher head = Pattern.compile("<head[^>]*>", Pattern.CASE_INSENSITIVE).matcher(html);
        if (head.find()) return html.substring(0, head.end()) + tag + html.substring(head.end());
        Matcher doctype = Pattern.compile("<!doctype[^>]*>", Pattern.CASE_INSENSITIVE).matcher(html);
        if (doctype.find()) return html.substring(0, doctype.end()) + tag + html.substring(doctype.end());
        return tag + html;
    }

    /** A byte range of a file. */
    private static final class Slice extends FilterInputStream {
        private long left;

        Slice(InputStream in, long start, long len) throws IOException {
            super(in);
            long skipped = 0;
            while (skipped < start) {
                long n = in.skip(start - skipped);
                if (n <= 0) break;
                skipped += n;
            }
            left = len;
        }

        @Override
        public int read() throws IOException {
            if (left <= 0) return -1;
            int b = super.read();
            if (b >= 0) left--;
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int n = super.read(b, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }
    }
}
