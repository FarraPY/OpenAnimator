package com.farrapy.openanimator;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** MIME types by file extension (same table as electron/protocol.ts). */
final class MimeTypes {
    private static final Map<String, String> MAP = new HashMap<>();

    static {
        put("text/html", "html", "htm");
        put("text/javascript", "js", "mjs");
        put("text/css", "css");
        put("application/json", "json", "map");
        put("image/svg+xml", "svg");
        put("image/png", "png");
        put("image/jpeg", "jpg", "jpeg");
        put("image/gif", "gif");
        put("image/webp", "webp");
        put("image/avif", "avif");
        put("image/bmp", "bmp");
        put("image/x-icon", "ico");
        put("video/mp4", "mp4", "m4v");
        put("video/webm", "webm");
        put("video/quicktime", "mov");
        put("video/x-matroska", "mkv");
        put("audio/mpeg", "mp3");
        put("audio/wav", "wav");
        put("audio/ogg", "ogg", "oga");
        put("audio/opus", "opus");
        put("audio/mp4", "m4a");
        put("audio/aac", "aac");
        put("audio/flac", "flac");
        put("font/woff", "woff");
        put("font/woff2", "woff2");
        put("font/ttf", "ttf");
        put("font/otf", "otf");
        put("model/gltf-binary", "glb");
        put("model/gltf+json", "gltf");
        put("text/plain", "txt", "srt", "vtt", "csv");
        put("text/markdown", "md");
        put("application/wasm", "wasm");
        put("application/pdf", "pdf");
        put("application/zip", "zip");
        put("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx");
    }

    private MimeTypes() {
    }

    private static void put(String mime, String... exts) {
        for (String e : exts) MAP.put(e, mime);
    }

    static String extension(String name) {
        if (name == null) return "";
        int slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
        int dot = name.lastIndexOf('.');
        if (dot <= slash) return "";
        return name.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    static String forName(String name) {
        String m = MAP.get(extension(name));
        return m != null ? m : "application/octet-stream";
    }

    static boolean isText(String mime) {
        return mime.startsWith("text/") || mime.equals("application/json") || mime.equals("image/svg+xml")
                || mime.equals("model/gltf+json");
    }

    /** Extensions for the system file picker (EXTRA_MIME_TYPES) from HTML accept values. */
    static String[] fromAcceptTypes(String[] accept) {
        java.util.LinkedHashSet<String> out = new java.util.LinkedHashSet<>();
        if (accept != null) {
            for (String raw : accept) {
                if (raw == null) continue;
                for (String a : raw.split(",")) {
                    a = a.trim().toLowerCase(Locale.ROOT);
                    if (a.isEmpty()) continue;
                    if (a.startsWith(".")) {
                        String m = MAP.get(a.substring(1));
                        if (m != null) out.add(m);
                    } else if (a.contains("/")) {
                        out.add(a);
                    }
                }
            }
        }
        return out.toArray(new String[0]);
    }
}
