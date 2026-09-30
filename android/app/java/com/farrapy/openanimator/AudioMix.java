package com.farrapy.openanimator;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The export's audio mix, in Java: each clip that sounds in the range is decoded (AudioDecoder), taken
 * to the output rate with a windowed-sinc filter, given its volume and fades and added up, in windows of
 * 30 s (little memory even for long videos). Each mixed window goes straight to the encoder as 16-bit
 * PCM. JavaScript used to do this and every piece went back and forth through the bridge (file, fetch,
 * base64): ~30 s for a 1-minute video on the tablet.
 *
 *   parts: [{path, start, duration, in, volume, fadeIn, fadeOut}]  (timeline seconds; "in" = offset in the file)
 *
 * Fades are linear over the clip's own time, like afade in FFmpeg on the PC. Mono goes to both sides; of
 * more than two channels, the first two are used.
 */
final class AudioMix {
    private static final String TAG = "OpenAnimator";
    private static final double WINDOW = 30;
    /** Audio decoded before and after each piece, so the filter doesn't see the cut. */
    private static final double MARGIN = 0.02;

    static final class Part {
        final File file;
        final double start, duration, in, volume, fadeIn, fadeOut;

        Part(File file, JSONObject o) {
            this.file = file;
            start = o.optDouble("start", 0);
            duration = o.optDouble("duration", 0);
            in = Math.max(0, o.optDouble("in", 0));
            volume = o.optDouble("volume", 1);
            fadeIn = Math.max(0, o.optDouble("fadeIn", 0));
            fadeOut = Math.max(0, o.optDouble("fadeOut", 0));
        }

        double gain(double lt) {
            double g = 1;
            if (fadeIn > 0 && lt < fadeIn) g = Math.min(g, Math.max(0, lt / fadeIn));
            if (fadeOut > 0 && lt > duration - fadeOut) g = Math.min(g, Math.max(0, (duration - lt) / fadeOut));
            return volume * g;
        }
    }

    /** Where the audio of a piece of a file comes from (AudioDecoder on the tablet; the test uses ffmpeg). */
    interface Decoder {
        Pcm decode(File f, double start, double dur) throws IOException;
    }

    /** Where the mix goes: 16-bit interleaved stereo PCM, window by window (the encoder). */
    interface Out {
        void write(byte[] pcm) throws IOException;
    }

    private AudioMix() {
    }

    /** Mixes [t0, t1] at rate (stereo) into the encoder; returns how many parts sounded and which failed. */
    static JSONObject mix(List<Part> parts, double t0, double t1, int rate, final Encoder encoder, Zip.Progress progress) throws Exception {
        return mix(parts, t0, t1, rate, new Out() {
            @Override
            public void write(byte[] pcm) throws IOException {
                encoder.audio(pcm);
            }
        }, progress, new Decoder() {
            @Override
            public Pcm decode(File f, double start, double dur) throws IOException {
                return decodeFile(f, start, dur);
            }
        });
    }

    static JSONObject mix(List<Part> parts, double t0, double t1, int rate, Out out, Zip.Progress progress, Decoder decoder) throws Exception {
        long total = Math.max(1, Math.round((t1 - t0) * rate));
        long windowFrames = Math.round(WINDOW * rate);
        Map<String, Resampler> filters = new HashMap<>();
        List<String> failed = new ArrayList<>();
        java.util.Set<Part> bad = new java.util.HashSet<>();
        byte[] bytes = new byte[0];
        for (long w0 = 0; w0 < total; w0 += windowFrames) {
            int n = (int) Math.min(windowFrames, total - w0);
            double ws = t0 + (double) w0 / rate, we = ws + (double) n / rate;
            float[] acc = new float[n * 2];
            for (Part p : parts) {
                if (bad.contains(p)) continue;
                double a = Math.max(p.start, ws), b = Math.min(p.start + p.duration, we);
                if (b - a < 0.0005) continue;
                try {
                    add(p, a, b, ws, rate, acc, n, filters, decoder);
                } catch (IOException e) {
                    // Un archivo que no se puede leer (o un video sin audio) no suma nada; los demás siguen.
                    Log.w(TAG, "mezcla: " + p.file.getName() + ": " + e.getMessage());
                    bad.add(p);
                    failed.add(p.file.getName() + ": " + e.getMessage());
                }
            }
            if (bytes.length < n * 4) bytes = new byte[n * 4];
            for (int i = 0; i < n * 2; i++) {
                int v = Math.round(acc[i] * 32767f);
                if (v > 32767) v = 32767;
                else if (v < -32768) v = -32768;
                bytes[i * 2] = (byte) v;
                bytes[i * 2 + 1] = (byte) (v >> 8);
            }
            out.write(bytes.length == n * 4 ? bytes : java.util.Arrays.copyOf(bytes, n * 4));
            if (progress != null) progress.onProgress(w0 + n, total);
        }
        JSONObject o = new JSONObject();
        o.put("parts", parts.size() - bad.size());
        JSONArray f = new JSONArray();
        for (String s : failed) f.put(s);
        o.put("failed", f);
        return o;
    }

    /** Adds the part's piece [a, b) (timeline seconds) into acc, the window that starts at ws. */
    private static void add(Part p, double a, double b, double ws, int rate, float[] acc, int n, Map<String, Resampler> filters, Decoder decoder) throws IOException {
        double la = a - p.start; // tiempo propio del clip
        double src = p.in + la;
        double pre = Math.min(MARGIN, src);
        Pcm pcm = decoder.decode(p.file, src - pre, (b - a) + pre + MARGIN);
        if (pcm.frames == 0) return;
        int off = (int) Math.round((a - ws) * rate);
        int count = Math.min(n - off, (int) Math.round((b - a) * rate));
        if (count <= 0) return;
        int ch = pcm.channels;
        short[] s = pcm.samples;
        if (pcm.rate == rate) {
            int first = (int) Math.round(pre * rate);
            for (int j = 0; j < count; j++) {
                int i = first + j;
                if (i >= pcm.frames) break;
                float l = s[i * ch] / 32768f, r = ch > 1 ? s[i * ch + 1] / 32768f : l;
                float g = (float) p.gain(la + (double) j / rate);
                acc[(off + j) * 2] += l * g;
                acc[(off + j) * 2 + 1] += r * g;
            }
            return;
        }
        String key = pcm.rate + ">" + rate;
        Resampler f = filters.get(key);
        if (f == null) filters.put(key, f = new Resampler(pcm.rate, rate));
        double step = (double) pcm.rate / rate;
        double x0 = pre * pcm.rate;
        for (int j = 0; j < count; j++) {
            double x = x0 + j * step;
            float g = (float) p.gain(la + (double) j / rate);
            float l = f.at(s, pcm.frames, ch, 0, x);
            acc[(off + j) * 2] += l * g;
            acc[(off + j) * 2 + 1] += (ch > 1 ? f.at(s, pcm.frames, ch, 1, x) : l) * g;
        }
    }

    /** Decoded audio: interleaved 16-bit samples. */
    static final class Pcm {
        short[] samples = new short[0];
        int frames, rate = 44100, channels = 2;
    }

    private static Pcm decodeFile(File f, double start, double dur) throws IOException {
        final Pcm pcm = new Pcm();
        AudioDecoder.decode(f, start, dur, new AudioDecoder.Sink() {
            @Override
            public void format(int sampleRate, int channels) {
                pcm.rate = sampleRate;
                pcm.channels = Math.max(1, channels);
            }

            @Override
            public boolean pcm(short[] s, int frames) {
                int need = (pcm.frames + frames) * pcm.channels;
                if (need > pcm.samples.length) pcm.samples = java.util.Arrays.copyOf(pcm.samples, Math.max(need, pcm.samples.length * 2));
                System.arraycopy(s, 0, pcm.samples, pcm.frames * pcm.channels, frames * pcm.channels);
                pcm.frames += frames;
                return true;
            }
        });
        return pcm;
    }

    /**
     * Windowed-sinc interpolation (Blackman window, 512 phases) from one rate to another; below the
     * lower of the two Nyquist frequencies, so going down doesn't fold high frequencies into the audio.
     */
    static final class Resampler {
        private static final int PHASES = 512, ZERO_CROSSINGS = 8;
        final int half, taps;
        final float[] table;

        Resampler(int from, int to) {
            double fc = 0.97 * Math.min(1.0, (double) to / from); // corte, relativo a la mitad de la frecuencia de origen
            half = (int) Math.ceil(ZERO_CROSSINGS / fc);
            taps = half * 2;
            table = new float[(PHASES + 1) * taps];
            for (int ph = 0; ph <= PHASES; ph++) {
                double frac = (double) ph / PHASES, sum = 0;
                double[] h = new double[taps];
                for (int i = 0; i < taps; i++) {
                    double t = frac + half - 1 - i; // distancia entre la posición buscada y la muestra i
                    double u = t / half;
                    if (Math.abs(u) >= 1) continue;
                    double win = 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u);
                    double arg = Math.PI * fc * t;
                    h[i] = (arg == 0 ? 1 : Math.sin(arg) / arg) * win;
                    sum += h[i];
                }
                for (int i = 0; i < taps; i++) table[ph * taps + i] = (float) (h[i] / sum);
            }
        }

        /** Channel c of the interleaved samples s at the fractional position x (in source frames). */
        float at(short[] s, int frames, int ch, int c, double x) {
            int base = (int) Math.floor(x);
            int ph = (int) Math.round((x - base) * PHASES);
            int first = base - half + 1;
            float acc = 0;
            int t = ph * taps;
            for (int i = 0; i < taps; i++) {
                int k = first + i;
                if (k < 0 || k >= frames) continue;
                acc += s[k * ch + c] * table[t + i];
            }
            return acc / 32768f;
        }
    }

    /** The parts of an enc.mix request (paths resolved and checked by the caller). */
    static List<Part> parts(JSONArray a, Fs fs) throws JSONException, IOException {
        List<Part> out = new ArrayList<>();
        for (int i = 0; a != null && i < a.length(); i++) {
            JSONObject o = a.getJSONObject(i);
            File f = fs.resolve(o.getString("path"));
            if (!f.isFile()) continue;
            Part p = new Part(f, o);
            if (p.duration > 0 && p.volume > 0) out.add(p);
        }
        return out;
    }
}
