package com.farrapy.openanimator;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

/** Projects as .zip files, to move them between the PC and the tablet. */
final class Zip {
    interface Progress {
        void onProgress(long done, long total);
    }

    private Zip() {
    }

    /** Compresses {@code dir} into {@code out}; entries go under {@code prefix}/ (the project id). */
    static void zipDir(File dir, File out, String prefix, Pattern skip, Progress p) throws IOException {
        long total = Fs.sizeOf(dir);
        long[] done = {0};
        File tmp = new File(out.getParentFile(), "." + out.getName() + ".part");
        try (ZipOutputStream z = new ZipOutputStream(new BufferedOutputStream(new FileOutputStream(tmp)))) {
            add(z, dir, "", prefix, skip, p, done, total);
        }
        if (!tmp.renameTo(out)) throw new IOException("No se pudo escribir " + out.getName());
    }

    private static void add(ZipOutputStream z, File f, String rel, String prefix, Pattern skip, Progress p, long[] done, long total) throws IOException {
        if (!rel.isEmpty() && skip != null && skip.matcher(rel).find()) return;
        String name = prefix + (rel.isEmpty() ? "" : "/" + rel);
        if (f.isDirectory()) {
            if (!rel.isEmpty()) {
                ZipEntry e = new ZipEntry(name + "/");
                e.setTime(f.lastModified());
                z.putNextEntry(e);
                z.closeEntry();
            }
            File[] kids = f.listFiles();
            if (kids == null) return;
            java.util.Arrays.sort(kids);
            for (File k : kids) add(z, k, rel.isEmpty() ? k.getName() : rel + "/" + k.getName(), prefix, skip, p, done, total);
            return;
        }
        ZipEntry e = new ZipEntry(name);
        e.setTime(f.lastModified());
        // Medios ya comprimidos: guardarlos sin recomprimir es mucho más rápido.
        boolean packed = MimeTypes.forName(f.getName()).matches("^(video|audio|image/(png|jpeg|webp|gif|avif)).*");
        z.setLevel(packed ? java.util.zip.Deflater.NO_COMPRESSION : java.util.zip.Deflater.DEFAULT_COMPRESSION);
        z.putNextEntry(e);
        try (InputStream in = new BufferedInputStream(new FileInputStream(f))) {
            byte[] buf = new byte[128 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                z.write(buf, 0, n);
                done[0] += n;
                if (p != null) p.onProgress(done[0], total);
            }
        }
        z.closeEntry();
    }

    /**
     * Extracts a project zip into {@code dest} (a new, empty folder). Accepts zips with project.json
     * at the root or inside a single top folder (what you get by zipping the project folder on the PC).
     * Returns false when there is no project.json.
     */
    static boolean unzipProject(File zip, File dest, Progress p) throws IOException {
        String top = topFolderOf(zip);
        if (top == null) return false;
        if (!dest.isDirectory() && !dest.mkdirs()) throw new IOException("No se pudo crear " + dest);
        String destPath = dest.getCanonicalPath();
        long total = zip.length(), done = 0;
        try (ZipInputStream z = new ZipInputStream(new BufferedInputStream(new FileInputStream(zip)))) {
            ZipEntry e;
            byte[] buf = new byte[128 * 1024];
            while ((e = z.getNextEntry()) != null) {
                String name = e.getName().replace('\\', '/');
                if (!top.isEmpty()) {
                    if (!name.startsWith(top)) continue;
                    name = name.substring(top.length());
                }
                if (name.isEmpty() || name.startsWith("__MACOSX/") || name.contains("/.DS_Store") || name.equals(".DS_Store")) continue;
                File out = new File(dest, name);
                String op = out.getCanonicalPath();
                if (!op.startsWith(destPath + File.separator)) throw new IOException("Entrada inválida en el zip: " + e.getName());
                if (e.isDirectory()) {
                    if (!out.isDirectory() && !out.mkdirs()) throw new IOException("No se pudo crear " + name);
                    continue;
                }
                File dir = out.getParentFile();
                if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("No se pudo crear " + dir);
                try (OutputStream o = new BufferedOutputStream(new FileOutputStream(out))) {
                    int n;
                    while ((n = z.read(buf)) > 0) o.write(buf, 0, n);
                }
                if (e.getTime() > 0) {
                    //noinspection ResultOfMethodCallIgnored
                    out.setLastModified(e.getTime());
                }
                done += Math.max(0, e.getCompressedSize());
                if (p != null) p.onProgress(done, total);
            }
        }
        return true;
    }

    /** "" when project.json is at the root, "folder/" when it is inside one folder, null when missing. */
    static String topFolderOf(File zip) throws IOException {
        String best = null;
        try (ZipInputStream z = new ZipInputStream(new BufferedInputStream(new FileInputStream(zip)))) {
            ZipEntry e;
            while ((e = z.getNextEntry()) != null) {
                String name = e.getName().replace('\\', '/');
                if (name.startsWith("__MACOSX/")) continue;
                if (name.equals("project.json")) return "";
                int i = name.indexOf('/');
                if (i > 0 && name.substring(i + 1).equals("project.json")) best = name.substring(0, i + 1);
            }
        }
        return best;
    }
}
