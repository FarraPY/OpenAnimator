package com.farrapy.openanimator;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Environment;
import android.os.storage.StorageManager;
import android.os.storage.StorageVolume;
import android.util.Log;

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
import java.util.HashSet;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * File operations inside the app's data (projects, templates, settings, caches). Every path is
 * relative and can never escape its folder:
 *
 *   <rel>              the internal data folder (files/data)
 *   projects/<id>/…    a project, wherever it is: in the tablet (files/data/projects) or on the SD card
 *                      (Android/data/<package>/files/projects on the card). A project that doesn't exist
 *                      yet goes where the user chose (Ajustes › Almacenamiento).
 *   @sd/…              the app's folder on the SD card (its trash and exported videos)
 *
 * "projects" by itself lists and measures the projects of both places. One instance per process
 * ({@link #get}): the page, the file server and the share provider see the same thing.
 */
final class Fs {
    static final String SD = "@sd";
    static final String NO_CARD = "La tarjeta SD no está disponible.";
    private static final String TAG = "OpenAnimator";
    /** Free space left on the destination after moving a project. */
    private static final long MOVE_MARGIN = 64L << 20;

    private static Fs instance;

    static synchronized Fs get(Context c) throws IOException {
        if (instance == null) instance = new Fs(c.getApplicationContext(), null);
        return instance;
    }

    /** Finds the card. Only tests pass their own (on a PC there's no Android storage service). */
    interface CardProbe {
        Card find();
    }

    /** The SD card: the app's folder in it (like the internal one, it's deleted with the app). */
    static final class Card {
        final File base, projects;
        final String uuid, label;

        Card(File base, String uuid, String label) {
            this.base = base;
            this.projects = new File(base, "projects");
            this.uuid = uuid;
            this.label = label;
        }
    }

    private final Context ctx;
    private final CardProbe probe;
    private final SharedPreferences prefs;
    final File root;
    private final String rootPath;
    private final File projects;
    private volatile Card card;
    /** Moves and their cleanup never run at the same time. */
    private final Object moveLock = new Object();

    Fs(Context ctx, CardProbe probe) throws IOException {
        this.ctx = ctx;
        this.probe = probe;
        this.prefs = ctx.getSharedPreferences("storage", Context.MODE_PRIVATE);
        File r = new File(ctx.getFilesDir(), "data");
        if (!r.isDirectory() && !r.mkdirs()) throw new IOException("No se pudo crear " + r);
        root = r.getCanonicalFile();
        rootPath = root.getPath();
        projects = new File(root, "projects");
        if (!projects.isDirectory() && !projects.mkdirs()) throw new IOException("No se pudo crear " + projects);
        if (refreshCard() == null) recoverInBackground();
    }

    // ── tarjeta SD ───────────────────────────────────────────────────────────────

    /** Looks for the card again: at start, when one is inserted or removed, and for the storage settings. */
    Card refreshCard() {
        Card found = probe != null ? probe.find() : findCard();
        Card before = card;
        card = found;
        if (found != null) {
            rememberCardProjects(found);
            if (before == null || !before.base.equals(found.base)) recoverInBackground();
        }
        return found;
    }

    private Card findCard() {
        Card found = null;
        File[] dirs;
        try {
            dirs = ctx.getExternalFilesDirs(null);
        } catch (RuntimeException e) {
            dirs = new File[0];
        }
        // [0] is the tablet's own shared storage; the rest are removable volumes (the card).
        for (int i = 1; i < dirs.length && found == null; i++) {
            File d = dirs[i];
            if (d == null) continue;
            try {
                if (!Environment.MEDIA_MOUNTED.equals(Environment.getExternalStorageState(d))) continue;
                if (!Environment.isExternalStorageRemovable(d)) continue;
                if (!d.isDirectory() && !d.mkdirs()) continue;
                String uuid = "", label = "";
                StorageManager sm = (StorageManager) ctx.getSystemService(Context.STORAGE_SERVICE);
                StorageVolume v = sm == null ? null : sm.getStorageVolume(d);
                if (v != null) {
                    if (v.getUuid() != null) uuid = v.getUuid();
                    String desc = v.getDescription(ctx);
                    if (desc != null) label = desc;
                }
                found = new Card(d.getCanonicalFile(), uuid, label);
            } catch (Exception e) {
                Log.w(TAG, "tarjeta " + d, e);
            }
        }
        return found;
    }

    Card card() {
        return card;
    }

    private Card requireCard() throws IOException {
        Card c = card;
        if (c == null) throw new IOException(NO_CARD);
        return c;
    }

    /** Remembers which projects are on the card: while it's out, a new project can't take their names. */
    private void rememberCardProjects(Card c) {
        StringBuilder sb = new StringBuilder();
        File[] kids = c.projects.listFiles();
        if (kids != null) for (File k : kids) if (!k.getName().startsWith(".") && k.isDirectory()) sb.append(k.getName()).append('/');
        String ids = sb.toString();
        if (!ids.equals(prefs.getString("cardProjects", "")) || !c.label.equals(prefs.getString("cardLabel", ""))) {
            prefs.edit().putString("cardProjects", ids).putString("cardLabel", c.label).apply();
        }
    }

    /** After creating or bringing a project to the card (mkdirs, rename): it's remembered right away. */
    private void noteCard(File f) {
        Card c = card;
        if (c != null && c.projects.equals(f.getParentFile())) rememberCardProjects(c);
    }

    private boolean onMissingCard(String id) {
        return card == null && ("/" + prefs.getString("cardProjects", "")).contains("/" + id + "/");
    }

    private int missingProjects() {
        if (card != null) return 0;
        int n = 0;
        for (String s : prefs.getString("cardProjects", "").split("/")) if (!s.isEmpty()) n++;
        return n;
    }

    /** Where new projects go: the card, if the user chose it and it's there; otherwise the tablet. */
    private File newProjectsDir() {
        Card c = card;
        return c != null && "sd".equals(prefs.getString("newProjects", "internal")) ? c.projects : projects;
    }

    void setNewProjects(String volume) {
        prefs.edit().putString("newProjects", "sd".equals(volume) ? "sd" : "internal").apply();
    }

    /** Space in each place, where new projects go and how many projects are on a card that isn't there. */
    JSONObject info() throws JSONException {
        Card c = refreshCard();
        JSONObject o = new JSONObject();
        JSONObject in = new JSONObject();
        in.put("free", root.getUsableSpace());
        in.put("total", root.getTotalSpace());
        o.put("internal", in);
        if (c != null) {
            JSONObject s = new JSONObject();
            s.put("label", c.label);
            s.put("uuid", c.uuid);
            s.put("free", c.base.getUsableSpace());
            s.put("total", c.base.getTotalSpace());
            o.put("sd", s);
        }
        o.put("newProjects", "sd".equals(prefs.getString("newProjects", "internal")) ? "sd" : "internal");
        o.put("missing", missingProjects());
        o.put("cardLabel", prefs.getString("cardLabel", ""));
        return o;
    }

    // ── rutas ────────────────────────────────────────────────────────────────────

    /** "a//b/./c/" → "a/b/c"; ".." is rejected. */
    private static String clean(String rel) throws IOException {
        if (rel == null) return "";
        StringBuilder sb = new StringBuilder();
        for (String part : rel.replace('\\', '/').split("/")) {
            if (part.isEmpty() || part.equals(".")) continue;
            if (part.equals("..")) throw new IOException("Ruta inválida: " + rel);
            if (sb.length() > 0) sb.append('/');
            sb.append(part);
        }
        return sb.toString();
    }

    private static File inside(File base, String rel) throws IOException {
        File f = rel.isEmpty() ? base : new File(base, rel);
        String b = base.getPath(), p = f.getCanonicalPath();
        if (!p.equals(b) && !p.startsWith(b + File.separator)) throw new IOException("Ruta fuera de los datos: " + rel);
        return f;
    }

    /** The part of {@code path} inside {@code base} ("" if it's the same folder), or null. */
    private static String under(String path, String base) {
        if (path.equals(base)) return "";
        return path.startsWith(base + File.separator) ? path.substring(base.length() + 1).replace(File.separatorChar, '/') : null;
    }

    /** Resolves a relative path ("projects/x/scenes/a.html") to a file in the tablet or on the card. */
    File resolve(String rel) throws IOException {
        return resolve(rel, null);
    }

    /** {@code near}: for a project that doesn't exist yet, the projects folder to put it in (null: the chosen one). */
    private File resolve(String rel, File near) throws IOException {
        rel = clean(rel);
        if (rel.equals(SD) || rel.startsWith(SD + "/")) {
            return inside(requireCard().base, rel.substring(Math.min(rel.length(), SD.length() + 1)));
        }
        if (rel.startsWith("projects/")) {
            String rest = rel.substring(9);
            int slash = rest.indexOf('/');
            File base = projectsWith(slash < 0 ? rest : rest.substring(0, slash));
            if (base == null) base = near != null ? near : newProjectsDir();
            return inside(base, rest);
        }
        return inside(root, rel);
    }

    /** The projects folder that has project {@code id} (the tablet's first), or null. */
    private File projectsWith(String id) {
        if (new File(projects, id).exists()) return projects;
        Card c = card;
        if (c != null && new File(c.projects, id).exists()) return c.projects;
        return null;
    }

    /** The projects folder on the same side (tablet or card) as {@code f}. */
    private File projectsBeside(File f) throws IOException {
        Card c = card;
        return c != null && onCard(f) ? c.projects : projects;
    }

    boolean onCard(File f) throws IOException {
        Card c = card;
        return c != null && under(f.getCanonicalPath(), c.base.getPath()) != null;
    }

    /** "sd" if the path is on the card, "internal" if it's in the tablet. */
    String volume(String rel) throws IOException {
        return onCard(resolve(rel)) ? "sd" : "internal";
    }

    /** The inverse of resolve: what's on the card goes with @sd/ (exact even if a name is in both places). */
    String relative(File f) throws IOException {
        String p = f.getCanonicalPath();
        Card c = card;
        if (c != null) {
            String r = under(p, c.base.getPath());
            if (r != null) return r.isEmpty() ? SD : SD + "/" + r;
        }
        String r = under(p, rootPath);
        if (r == null) throw new IOException("Ruta fuera de los datos");
        return r;
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
        if (clean(rel).equals("projects")) return listProjects();
        File d = resolve(rel);
        JSONArray out = new JSONArray();
        File[] kids = d.listFiles();
        if (kids == null) return out;
        for (File k : kids) out.put(entry(k.getName(), k));
        return out;
    }

    /** The projects of both places; the ones on the card come with "vol": "sd". */
    private JSONArray listProjects() throws JSONException {
        JSONArray out = new JSONArray();
        HashSet<String> seen = new HashSet<>();
        File[] kids = projects.listFiles();
        if (kids != null) for (File k : kids) if (seen.add(k.getName())) out.put(entry(k.getName(), k));
        Card c = card;
        if (c != null) {
            kids = c.projects.listFiles();
            if (kids != null) for (File k : kids) {
                if (!seen.add(k.getName())) continue;
                JSONObject e = entry(k.getName(), k);
                e.put("vol", "sd");
                out.put(e);
            }
            rememberCardProjects(c);
        }
        return out;
    }

    /**
     * Recursive listing (paths relative to {@code rel}). Hidden entries (".x") are skipped when
     * {@code skipHidden}; directories named in {@code skipDirs} are listed but not entered.
     */
    JSONArray walk(String rel, int maxDepth, int max, boolean skipHidden, JSONArray skipDirs) throws IOException, JSONException {
        File d = resolve(rel);
        JSONArray out = new JSONArray();
        HashSet<String> skip = new HashSet<>();
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
        rel = clean(rel);
        // The name of a project on a card that isn't there is taken (so it can't be reused meanwhile).
        if (rel.startsWith("projects/") && rel.indexOf('/', 9) < 0 && onMissingCard(rel.substring(9))) return true;
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
        if (tmp.renameTo(f)) return;
        // Some card file systems don't replace a file when renaming: delete it and try again,
        // and as a last resort write it in place.
        //noinspection ResultOfMethodCallIgnored
        f.delete();
        if (tmp.renameTo(f)) return;
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(data);
            out.getFD().sync();
        } finally {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
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

    /** {@code volume} ("sd" | "internal" | null): where to create a project that doesn't exist yet. */
    void mkdirs(String rel, String volume) throws IOException {
        File near = "sd".equals(volume) ? requireCard().projects : "internal".equals(volume) ? projects : null;
        File d = resolve(rel, near);
        if (d.isDirectory()) return;
        if (!d.mkdirs()) throw new IOException("No se pudo crear la carpeta " + rel);
        noteCard(d);
    }

    boolean delete(String rel) throws IOException {
        File f = resolve(rel);
        String p = f.getCanonicalPath();
        Card c = card;
        if (p.equals(rootPath) || p.equals(projects.getPath()) || (c != null && (p.equals(c.base.getPath()) || p.equals(c.projects.getPath())))) {
            throw new IOException("No se puede borrar esa carpeta");
        }
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

    /** A project that doesn't exist yet at {@code to} stays on the same side as {@code from} (restoring, importing). */
    void rename(String from, String to) throws IOException {
        File a = resolve(from);
        if (!a.exists()) throw new IOException("No existe: " + from);
        File b = resolve(to, projectsBeside(a));
        File dir = b.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("No se pudo crear " + dir);
        if (b.isDirectory()) throw new IOException("Ya existe: " + to);
        if (!a.renameTo(b)) {
            // From the tablet to the card or the other way around: copy and delete.
            try {
                copyTree(a, b);
            } catch (IOException e) {
                deleteTree(b);
                throw e;
            }
            deleteTree(a);
        }
        noteCard(b);
    }

    void copy(String from, String to) throws IOException {
        File a = resolve(from);
        copyTree(a, resolve(to, projectsBeside(a)));
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
        if (clean(rel).equals("projects")) {
            Card c = card;
            return sizeOf(projects) + (c != null ? sizeOf(c.projects) : 0);
        }
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

    // ── mover proyectos entre la tablet y la tarjeta ─────────────────────────────

    /**
     * Copies the project next to the destination with a hidden name, checks the copy, and only then
     * swaps the names and deletes the original. If the app closes halfway, {@link #recover} leaves
     * the project whole in one place.
     */
    JSONObject moveProject(String id, String to, Zip.Progress progress, AtomicBoolean cancel) throws IOException, JSONException {
        if (id == null || id.isEmpty() || id.startsWith(".") || !clean(id).equals(id) || id.indexOf('/') >= 0) throw new IOException("Proyecto inválido");
        synchronized (moveLock) {
            File from = projectsWith(id);
            if (from == null) throw new IOException("No existe el proyecto");
            File dest = "sd".equals(to) ? requireCard().projects : projects;
            JSONObject o = new JSONObject();
            o.put("moved", false);
            if (from.equals(dest)) return o;
            String where = dest == projects ? "en la tablet" : "en la tarjeta SD";
            File src = new File(from, id), dst = new File(dest, id);
            if (dst.exists()) throw new IOException("Ya hay un proyecto «" + id + "» " + where + ".");
            if (!dest.isDirectory() && !dest.mkdirs()) throw new IOException("No se pudo crear la carpeta de proyectos " + where + ".");
            long[] size = tally(src, new long[2]);
            long free = dest.getUsableSpace();
            if (free < size[0] + MOVE_MARGIN) {
                throw new IOException("No hay lugar " + where + ": el proyecto ocupa " + human(size[0]) + " y quedan " + human(free) + " libres.");
            }
            File tmp = new File(dest, ".moving-" + id), old = new File(from, ".moved-" + id);
            deleteTree(tmp);
            try {
                new Copier(size[0], progress, cancel).copy(src, tmp);
                long[] got = tally(tmp, new long[2]);
                if (got[0] != size[0] || got[1] != size[1]) {
                    throw new IOException("La copia no coincide con el original (¿cambió mientras se copiaba?). El proyecto quedó donde estaba.");
                }
            } catch (IOException e) {
                deleteTree(tmp);
                throw e;
            }
            deleteTree(old);
            if (!src.renameTo(old)) {
                deleteTree(tmp);
                throw new IOException("No se pudo mover el proyecto. Quedó donde estaba.");
            }
            if (!tmp.renameTo(dst)) {
                if (!old.renameTo(src)) Log.e(TAG, "no se pudo devolver " + old);
                deleteTree(tmp);
                throw new IOException("No se pudo terminar de mover el proyecto. Quedó donde estaba.");
            }
            deleteTree(old);
            Card c = card;
            if (c != null) rememberCardProjects(c);
            o.put("moved", true);
            o.put("size", size[0]);
            return o;
        }
    }

    /** {bytes, files} of a folder, added to {@code acc}. */
    private static long[] tally(File f, long[] acc) {
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) tally(k, acc);
        } else if (f.exists()) {
            acc[0] += f.length();
            acc[1]++;
        }
        return acc;
    }

    static String human(long b) {
        if (b < 1L << 20) return Math.max(1, b >> 10) + " KB";
        if (b < 1L << 30) return (b >> 20) + " MB";
        return String.format(Locale.ROOT, "%.1f GB", b / (double) (1L << 30)).replace('.', ',');
    }

    /** Copy with progress and cancel; each file is synced before the original is deleted. */
    private static final class Copier {
        private final long total;
        private final Zip.Progress progress;
        private final AtomicBoolean cancel;
        private final byte[] buf = new byte[1 << 20];
        private long done;

        Copier(long total, Zip.Progress progress, AtomicBoolean cancel) {
            this.total = total;
            this.progress = progress;
            this.cancel = cancel;
        }

        void copy(File a, File b) throws IOException {
            if (cancel != null && cancel.get()) throw new IOException("Cancelado");
            if (a.isDirectory()) {
                if (!b.isDirectory() && !b.mkdirs()) throw new IOException("No se pudo crear " + b.getName());
                File[] kids = a.listFiles();
                if (kids != null) for (File k : kids) copy(k, new File(b, k.getName()));
                return;
            }
            try (InputStream in = new FileInputStream(a); FileOutputStream out = new FileOutputStream(b)) {
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    done += n;
                    if (progress != null) progress.onProgress(done, total);
                    if (cancel != null && cancel.get()) throw new IOException("Cancelado");
                }
                out.getFD().sync();
            }
            //noinspection ResultOfMethodCallIgnored
            b.setLastModified(a.lastModified());
        }
    }

    private void recoverInBackground() {
        new Thread(new Runnable() {
            @Override
            public void run() {
                recover();
            }
        }, "oa-storage").start();
    }

    /**
     * After a move that was cut off: ".moving-x" is an unfinished copy (the original is intact) and
     * ".moved-x" an original waiting to be deleted, or to go back if the copy never got its name.
     */
    void recover() {
        synchronized (moveLock) {
            Card c = card;
            File[] bases = c == null ? new File[]{projects} : new File[]{projects, c.projects};
            for (File base : bases) {
                File[] kids = base.listFiles();
                if (kids == null) continue;
                for (File k : kids) {
                    String n = k.getName();
                    if (n.startsWith(".moving-")) {
                        deleteTree(k);
                    } else if (n.startsWith(".moved-") && c != null) {
                        // Without the card we can't know if the copy got there: this waits for it.
                        String id = n.substring(7);
                        if (new File(projects, id).exists() || new File(c.projects, id).exists()) deleteTree(k);
                        else if (!k.renameTo(new File(base, id))) Log.w(TAG, "no se pudo recuperar " + k);
                    }
                }
            }
        }
    }
}
