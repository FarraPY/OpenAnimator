package com.farrapy.openanimator;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * File operations inside the app's data folder (projects, templates, settings, caches).
 * Every path is relative to {@link #root} and can never escape it.
 */
final class Fs {
    final File root;
    private final String rootPath;

    Fs(File root) throws IOException {
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("No se pudo crear " + root);
        this.root = root.getCanonicalFile();
        this.rootPath = this.root.getPath();
    }

    /** Resolves a relative path ("projects/x/scenes/a.html") to a file inside the root. */
    File resolve(String rel) throws IOException {
        if (rel == null) rel = "";
        rel = rel.replace('\\', '/');
        while (rel.startsWith("/")) rel = rel.substring(1);
        for (String part : rel.split("/")) {
            if (part.equals("..")) throw new IOException("Ruta inválida: " + rel);
        }
        File f = rel.isEmpty() ? root : new File(root, rel);
        String p = f.getCanonicalPath();
        if (!p.equals(rootPath) && !p.startsWith(rootPath + File.separator)) throw new IOException("Ruta fuera de los datos: " + rel);
        return f;
    }

    String relative(File f) throws IOException {
        String p = f.getCanonicalPath();
        if (p.equals(rootPath)) return "";
        if (!p.startsWith(rootPath + File.separator)) throw new IOException("Ruta fuera de los datos");
        return p.substring(rootPath.length() + 1).replace(File.separatorChar, '/');
    }

    // ── lectura ──────────────────────────────────────────────────────────────────

    JSONObject stat(String rel) throws IOException, JSONException {
        File f = resolve(rel);
        if (!f.exists()) return null;
        return entry(f.getName(), f);
    }

    private static JSONObject entry(String name, File f) throws JSONException {
        JSONObject o = new JSONObject();
        o.put("name", name);
        o.put("dir", f.isDirectory());
        o.put("size", f.isDirectory() ? 0 : f.length());
        o.put("mtime", f.lastModified());
        return o;
    }

    JSONArray list(String rel) throws IOException, JSONException {
        File d = resolve(rel);
        JSONArray out = new JSONArray();
        File[] kids = d.listFiles();
        if (kids == null) return out;
        for (File k : kids) out.put(entry(k.getName(), k));
        return out;
    }

    /**
     * Recursive listing (paths relative to {@code rel}). Hidden entries (".x") are skipped when
     * {@code skipHidden}; directories named in {@code skipDirs} are listed but not entered.
     */
    JSONArray walk(String rel, int maxDepth, int max, boolean skipHidden, JSONArray skipDirs) throws IOException, JSONException {
        File d = resolve(rel);
        JSONArray out = new JSONArray();
        java.util.HashSet<String> skip = new java.util.HashSet<>();
        if (skipDirs != null) for (int i = 0; i < skipDirs.length(); i++) skip.add(skipDirs.getString(i));
        walkInto(d, "", 0, maxDepth, max, skipHidden, skip, out);
        return out;
    }

    private void walkInto(File d, String prefix, int depth, int maxDepth, int max, boolean skipHidden,
                          java.util.Set<String> skip, JSONArray out) throws JSONException {
        if (depth > maxDepth || out.length() >= max) return;
        File[] kids = d.listFiles();
        if (kids == null) return;
        java.util.Arrays.sort(kids);
        for (File k : kids) {
            if (out.length() >= max) return;
            String name = k.getName();
            if (skipHidden && name.startsWith(".")) continue;
            String p = prefix.isEmpty() ? name : prefix + "/" + name;
            JSONObject e = entry(name, k);
            e.put("path", p);
            out.put(e);
            if (k.isDirectory() && !skip.contains(name)) walkInto(k, p, depth + 1, maxDepth, max, skipHidden, skip, out);
        }
    }

    boolean exists(String rel) throws IOException {
        return resolve(rel).exists();
    }

    String readText(String rel) throws IOException {
        return new String(readBytes(resolve(rel), Long.MAX_VALUE), StandardCharsets.UTF_8);
    }

    /** Text of a file, cut at {@code max} bytes: {text, size, truncated}. */
    JSONObject readTextLimited(String rel, long max) throws IOException, JSONException {
        File f = resolve(rel);
        long size = f.length();
        byte[] b = readBytes(f, max);
        String text = new String(b, StandardCharsets.UTF_8);
        JSONObject o = new JSONObject();
        o.put("text", text);
        o.put("size", size);
        o.put("truncated", size > max);
        return o;
    }

    static byte[] readBytes(File f, long max) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream bo = new ByteArrayOutputStream((int) Math.min(Math.max(f.length(), 16), Math.min(max, 64L << 20)));
            byte[] buf = new byte[64 * 1024];
            long left = max;
            int n;
            while (left > 0 && (n = in.read(buf, 0, (int) Math.min(buf.length, left))) > 0) {
                bo.write(buf, 0, n);
                left -= n;
            }
            return bo.toByteArray();
        }
    }

    // ── escritura ────────────────────────────────────────────────────────────────

    /** Atomic write: temporary file in the same folder + rename. */
    void writeText(String rel, String text) throws IOException {
        writeAtomic(resolve(rel), text.getBytes(StandardCharsets.UTF_8));
    }

    static void writeAtomic(File f, byte[] data) throws IOException {
        File dir = f.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("No se pudo crear " + dir);
        File tmp = new File(dir, "." + f.getName() + "." + System.nanoTime() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(data);
            out.getFD().sync();
        }
        if (!tmp.renameTo(f)) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            throw new IOException("No se pudo escribir " + f.getName());
        }
    }

    void writeBytes(String rel, byte[] data, boolean append) throws IOException {
        File f = resolve(rel);
        File dir = f.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("No se pudo crear " + dir);
        if (!append) {
            writeAtomic(f, data);
            return;
        }
        try (OutputStream out = new FileOutputStream(f, true)) {
            out.write(data);
        }
    }

    void mkdirs(String rel) throws IOException {
        File d = resolve(rel);
        if (!d.isDirectory() && !d.mkdirs()) throw new IOException("No se pudo crear la carpeta " + rel);
    }

    boolean delete(String rel) throws IOException {
        File f = resolve(rel);
        if (f.equals(root)) throw new IOException("No se puede borrar la carpeta de datos");
        return deleteTree(f);
    }

    static boolean deleteTree(File f) {
        if (!f.exists()) return false;
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteTree(k);
        }
        return f.delete();
    }

    void rename(String from, String to) throws IOException {
        File a = resolve(from), b = resolve(to);
        if (!a.exists()) throw new IOException("No existe: " + from);
        File dir = b.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("No se pudo crear " + dir);
        if (b.isDirectory()) throw new IOException("Ya existe: " + to);
        if (!a.renameTo(b)) {
            // Distinto sistema de archivos (no debería pasar dentro de los datos): copiar y borrar.
            copyTree(a, b);
            deleteTree(a);
        }
    }

    void copy(String from, String to) throws IOException {
        copyTree(resolve(from), resolve(to));
    }

    static void copyTree(File a, File b) throws IOException {
        if (a.isDirectory()) {
            if (!b.isDirectory() && !b.mkdirs()) throw new IOException("No se pudo crear " + b);
            File[] kids = a.listFiles();
            if (kids != null) for (File k : kids) copyTree(k, new File(b, k.getName()));
            return;
        }
        File dir = b.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("No se pudo crear " + dir);
        try (InputStream in = new FileInputStream(a); OutputStream out = new FileOutputStream(b)) {
            copyStream(in, out);
        }
        //noinspection ResultOfMethodCallIgnored
        b.setLastModified(a.lastModified());
    }

    static long copyStream(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[128 * 1024];
        long total = 0;
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            total += n;
        }
        return total;
    }

    long du(String rel) throws IOException {
        return sizeOf(resolve(rel));
    }

    static long sizeOf(File f) {
        if (!f.exists()) return 0;
        if (!f.isDirectory()) return f.length();
        long total = 0;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) total += sizeOf(k);
        return total;
    }
}
