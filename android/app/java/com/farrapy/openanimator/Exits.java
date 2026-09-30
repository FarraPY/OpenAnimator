package com.farrapy.openanimator;

import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * Why the app or its web engine closed, for the user to see (and send) the next time it opens:
 * - Android's record of how the app's process ended (Android 11+): out of memory, a crash in Java or in native
 *   code, not responding, killed…;
 * - the web engine's crashes (onRenderProcessGone: the page is recreated, the app keeps running);
 * - uncaught Java errors, with their stack (Android keeps only the message).
 * The page asks once per start (app.exits) and gets each one once.
 */
final class Exits {
    private static final String PREFS = "exits";
    /** Our own records (the web engine and Java errors), one JSON per line; the last few are kept. */
    private static final String FILE = "exits.jsonl";
    /** Without a previous check (first start with this version), only what happened in the last days. */
    private static final long FIRST_WINDOW_MS = 3L * 24 * 3600 * 1000;

    private Exits() {
    }

    /** Uncaught Java errors: the stack goes to a file before Android closes the app. */
    static void install(final Context c) {
        final Context app = c.getApplicationContext();
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override
            public void uncaughtException(Thread t, Throwable e) {
                try {
                    StringWriter sw = new StringWriter();
                    e.printStackTrace(new PrintWriter(sw));
                    String stack = sw.toString();
                    JSONObject o = new JSONObject();
                    o.put("kind", "java");
                    o.put("at", System.currentTimeMillis());
                    o.put("thread", t.getName());
                    o.put("error", String.valueOf(e));
                    o.put("stack", stack.length() > 6000 ? stack.substring(0, 6000) : stack);
                    memory(app, o);
                    append(app, o);
                } catch (Throwable ignored) {
                    // lo que importa es que Android siga con su manejo
                }
                if (prev != null) prev.uncaughtException(t, e);
            }
        });
    }

    /**
     * The web engine's process ended (the page is recreated): crashed, or Android took it for its memory
     * (crashed false). doing: what Java knows the app was doing ("exportando"), or "".
     */
    static void webGone(Context c, boolean crashed, int priority, String doing) {
        try {
            JSONObject o = new JSONObject();
            o.put("kind", "web");
            o.put("at", System.currentTimeMillis());
            o.put("crashed", crashed);
            o.put("priority", priority);
            if (doing != null && !doing.isEmpty()) o.put("doing", doing);
            memory(c, o);
            append(c, o);
        } catch (Exception ignored) {
            // sin registro
        }
    }

    /** What's new since the page last asked, oldest first: Android's record of the app's processes and ours. */
    static synchronized JSONArray take(Context c) throws JSONException {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        long seen = p.getLong("seen", now - FIRST_WINDOW_MS);
        JSONArray out = new JSONArray();
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                ActivityManager am = (ActivityManager) c.getSystemService(Context.ACTIVITY_SERVICE);
                List<ApplicationExitInfo> list = am.getHistoricalProcessExitReasons(null, 0, 16);
                for (int i = list.size() - 1; i >= 0; i--) { // la lista viene de la más nueva a la más vieja
                    ApplicationExitInfo x = list.get(i);
                    if (x.getTimestamp() <= seen || !abnormal(x)) continue;
                    JSONObject o = new JSONObject();
                    o.put("kind", "android");
                    o.put("at", x.getTimestamp());
                    o.put("reason", reasonName(x.getReason()));
                    o.put("status", x.getStatus());
                    o.put("importance", x.getImportance());
                    o.put("process", x.getProcessName());
                    if (x.getDescription() != null) o.put("description", x.getDescription());
                    o.put("pssMB", x.getPss() / 1024);
                    o.put("rssMB", x.getRss() / 1024);
                    if (x.getReason() == ApplicationExitInfo.REASON_ANR) {
                        String main = anrMain(x);
                        if (main != null) o.put("stack", main);
                    }
                    out.put(o);
                }
            } catch (Exception e) {
                JSONObject o = new JSONObject();
                o.put("kind", "error");
                o.put("at", now);
                o.put("error", "No se pudo leer el registro de Android: " + e.getMessage());
                out.put(o);
            }
        }
        File f = new File(c.getFilesDir(), FILE);
        if (f.isFile()) {
            try {
                String text = new String(java.nio.file.Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
                for (String line : text.split("\n")) {
                    if (line.trim().isEmpty()) continue;
                    try {
                        JSONObject o = new JSONObject(line);
                        if (o.optLong("at") > seen) out.put(o);
                    } catch (JSONException ignored) {
                        // una línea cortada (se cerró escribiendo)
                    }
                }
            } catch (Exception ignored) {
                // sin registro propio
            }
        }
        p.edit().putLong("seen", now).apply();
        return out;
    }

    /**
     * An exit the user would call a crash: an error, not responding, or killed while it was in use (being killed
     * in the background, or closed by the user or by an update, is how Android works).
     */
    private static boolean abnormal(ApplicationExitInfo x) {
        switch (x.getReason()) {
            case ApplicationExitInfo.REASON_CRASH:
            case ApplicationExitInfo.REASON_CRASH_NATIVE:
            case ApplicationExitInfo.REASON_ANR:
            case ApplicationExitInfo.REASON_INITIALIZATION_FAILURE:
            case ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE:
                return true;
            case ApplicationExitInfo.REASON_LOW_MEMORY:
            case ApplicationExitInfo.REASON_SIGNALED:
            case ApplicationExitInfo.REASON_DEPENDENCY_DIED:
            case ApplicationExitInfo.REASON_OTHER:
            case ApplicationExitInfo.REASON_UNKNOWN:
                // En uso o a la vista (primer plano, visible, servicio en primer plano o perceptible).
                return x.getImportance() <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_PERCEPTIBLE;
            default:
                return false;
        }
    }

    /** Not responding: where the main thread was (Android keeps the threads' stacks of that moment). */
    private static String anrMain(ApplicationExitInfo x) {
        try (InputStream in = x.getTraceInputStream()) {
            if (in == null) return null;
            BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            long read = 0;
            boolean main = false;
            for (String l; (l = r.readLine()) != null && read < (8 << 20); ) {
                read += l.length() + 1;
                if (!main) {
                    if (!l.startsWith("\"main\"")) continue;
                    main = true;
                } else if (l.trim().isEmpty()) break;
                sb.append(l).append('\n');
                if (sb.length() > 5000) break;
            }
            return sb.length() > 0 ? sb.toString() : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static String reasonName(int r) {
        switch (r) {
            case ApplicationExitInfo.REASON_CRASH:
                return "crash";
            case ApplicationExitInfo.REASON_CRASH_NATIVE:
                return "crash-native";
            case ApplicationExitInfo.REASON_ANR:
                return "anr";
            case ApplicationExitInfo.REASON_LOW_MEMORY:
                return "low-memory";
            case ApplicationExitInfo.REASON_SIGNALED:
                return "signaled";
            case ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE:
                return "excessive-resource-usage";
            case ApplicationExitInfo.REASON_INITIALIZATION_FAILURE:
                return "initialization-failure";
            case ApplicationExitInfo.REASON_DEPENDENCY_DIED:
                return "dependency-died";
            case ApplicationExitInfo.REASON_OTHER:
                return "other";
            default:
                return "unknown";
        }
    }

    /** Free memory now (and if Android considers it low). */
    private static void memory(Context c, JSONObject o) throws JSONException {
        ActivityManager am = (ActivityManager) c.getSystemService(Context.ACTIVITY_SERVICE);
        if (am == null) return;
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        o.put("availMB", mi.availMem >> 20);
        o.put("lowMemory", mi.lowMemory);
        Runtime rt = Runtime.getRuntime();
        o.put("javaMB", (rt.totalMemory() - rt.freeMemory()) >> 20);
    }

    /** One line more; the file keeps the last 20 (it's read back whole). */
    private static synchronized void append(Context c, JSONObject o) {
        File f = new File(c.getFilesDir(), FILE);
        try {
            java.util.ArrayList<String> lines = new java.util.ArrayList<>();
            if (f.isFile()) {
                for (String l : new String(java.nio.file.Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8).split("\n")) {
                    if (!l.trim().isEmpty()) lines.add(l);
                }
            }
            lines.add(o.toString());
            while (lines.size() > 20) lines.remove(0);
            StringBuilder sb = new StringBuilder();
            for (String l : lines) sb.append(l).append('\n');
            try (FileOutputStream out = new FileOutputStream(f)) {
                out.write(sb.toString().getBytes(StandardCharsets.UTF_8));
                out.getFD().sync();
            }
        } catch (Exception ignored) {
            // sin registro
        }
    }
}
