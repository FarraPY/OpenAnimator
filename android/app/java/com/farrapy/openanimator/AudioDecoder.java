package com.farrapy.openanimator;

import android.media.AudioFormat;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.os.Build;
import android.util.Base64;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * Audio de un archivo (audio o video) con MediaExtractor + MediaCodec, sin cargarlo entero en
 * memoria: picos para la forma de onda del timeline y tramos en PCM para la mezcla de la
 * exportación y la transcripción. Un video 4K de la cámara pesa más de un GB; un tramo de su
 * audio decodificado, pocos MB.
 */
final class AudioDecoder {
    /** Recibe el audio decodificado: primero el formato, después bloques de muestras intercaladas. */
    interface Sink {
        void format(int sampleRate, int channels);

        /** @return false para dejar de decodificar. */
        boolean pcm(short[] samples, int frames) throws IOException;
    }

    private AudioDecoder() {
    }

    /** Pista de audio del archivo (o -1). */
    private static int audioTrack(MediaExtractor ex) {
        for (int i = 0; i < ex.getTrackCount(); i++) {
            String mime = ex.getTrackFormat(i).getString(MediaFormat.KEY_MIME);
            if (mime != null && mime.startsWith("audio/")) return i;
        }
        return -1;
    }

    /** Decodifica desde startSec durante durSec (durSec <= 0: hasta el final). */
    static void decode(File f, double startSec, double durSec, Sink sink) throws IOException {
        MediaExtractor ex = new MediaExtractor();
        MediaCodec codec = null;
        try {
            ex.setDataSource(f.getPath());
            int track = audioTrack(ex);
            if (track < 0) throw new IOException("El archivo no tiene audio");
            ex.selectTrack(track);
            MediaFormat fmt = ex.getTrackFormat(track);
            String mime = fmt.getString(MediaFormat.KEY_MIME);
            long startUs = Math.max(0, Math.round(startSec * 1e6));
            long endUs = durSec > 0 ? startUs + Math.round(durSec * 1e6) : Long.MAX_VALUE;
            // Un poco más allá del final, para que el decodificador entregue todo el tramo.
            long stopUs = durSec > 0 ? endUs + 500000 : Long.MAX_VALUE;
            if (startUs > 0) ex.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC);

            int rate = fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE);
            int channels = fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
            if ("audio/raw".equals(mime)) {
                // WAV/PCM: no hace falta decodificar.
                int enc = Build.VERSION.SDK_INT >= 24 && fmt.containsKey(MediaFormat.KEY_PCM_ENCODING) ? fmt.getInteger(MediaFormat.KEY_PCM_ENCODING) : AudioFormat.ENCODING_PCM_16BIT;
                sink.format(rate, channels);
                ByteBuffer buf = ByteBuffer.allocate(1 << 20);
                while (true) {
                    buf.clear();
                    int n = ex.readSampleData(buf, 0);
                    if (n < 0) break;
                    long pts = ex.getSampleTime();
                    buf.position(0);
                    buf.limit(n);
                    if (!emit(sink, toShorts(buf, enc), channels, rate, pts, startUs, endUs)) break;
                    ex.advance();
                }
                return;
            }

            codec = MediaCodec.createDecoderByType(mime);
            codec.configure(fmt, null, null, 0);
            codec.start();
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            boolean inDone = false, formatSent = false;
            int outEnc = AudioFormat.ENCODING_PCM_16BIT;
            long idleSince = System.currentTimeMillis();
            while (true) {
                if (!inDone) {
                    int ii = codec.dequeueInputBuffer(5000);
                    if (ii >= 0) {
                        ByteBuffer ib = codec.getInputBuffer(ii);
                        int n = ib == null ? -1 : ex.readSampleData(ib, 0);
                        long pts = ex.getSampleTime();
                        if (n < 0 || pts > stopUs) {
                            codec.queueInputBuffer(ii, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inDone = true;
                        } else {
                            codec.queueInputBuffer(ii, 0, n, pts, 0);
                            ex.advance();
                        }
                    }
                }
                int oi = codec.dequeueOutputBuffer(info, 5000);
                if (oi == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat of = codec.getOutputFormat();
                    rate = of.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    channels = of.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                    if (Build.VERSION.SDK_INT >= 24 && of.containsKey(MediaFormat.KEY_PCM_ENCODING)) outEnc = of.getInteger(MediaFormat.KEY_PCM_ENCODING);
                    if (!formatSent) { sink.format(rate, channels); formatSent = true; }
                } else if (oi >= 0) {
                    idleSince = System.currentTimeMillis();
                    ByteBuffer ob = codec.getOutputBuffer(oi);
                    boolean more = true;
                    if (ob != null && info.size > 0) {
                        if (!formatSent) { sink.format(rate, channels); formatSent = true; }
                        ob.limit(info.offset + info.size);
                        ob.position(info.offset);
                        more = emit(sink, toShorts(ob, outEnc), channels, rate, info.presentationTimeUs, startUs, endUs);
                    }
                    codec.releaseOutputBuffer(oi, false);
                    if (!more || (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break;
                } else if (System.currentTimeMillis() - idleSince > 15000) {
                    throw new IOException("El decodificador de audio no respondió");
                }
            }
            if (!formatSent) sink.format(rate, channels);
        } finally {
            if (codec != null) {
                try {
                    codec.stop();
                } catch (Exception ignored) {
                }
                codec.release();
            }
            ex.release();
        }
    }

    /** Entrega al sink sólo la parte del bloque que cae en [startUs, endUs). */
    private static boolean emit(Sink sink, short[] s, int channels, int rate, long ptsUs, long startUs, long endUs) throws IOException {
        int frames = s.length / Math.max(1, channels);
        if (frames == 0) return true;
        long firstUs = ptsUs, lastUs = ptsUs + frames * 1000000L / rate;
        if (lastUs <= startUs) return true;
        if (firstUs >= endUs) return false;
        int from = firstUs < startUs ? (int) Math.min(frames, (startUs - firstUs) * rate / 1000000L) : 0;
        int to = lastUs > endUs ? (int) Math.max(from, Math.min(frames, (endUs - firstUs) * rate / 1000000L)) : frames;
        if (to <= from) return lastUs < endUs;
        short[] part = s;
        if (from > 0 || to < frames) {
            part = new short[(to - from) * channels];
            System.arraycopy(s, from * channels, part, 0, part.length);
        }
        return sink.pcm(part, to - from) && lastUs < endUs;
    }

    private static short[] toShorts(ByteBuffer b, int enc) {
        b = b.slice().order(ByteOrder.LITTLE_ENDIAN);
        if (enc == AudioFormat.ENCODING_PCM_FLOAT) {
            short[] out = new short[b.remaining() / 4];
            for (int i = 0; i < out.length; i++) out[i] = (short) Math.max(-32768, Math.min(32767, Math.round(b.getFloat() * 32767f)));
            return out;
        }
        if (enc == 21) { // ENCODING_PCM_24BIT_PACKED (API 31)
            short[] out = new short[b.remaining() / 3];
            for (int i = 0; i < out.length; i++) {
                b.get();
                int mid = b.get() & 0xff, hi = b.get();
                out[i] = (short) ((hi << 8) | mid);
            }
            return out;
        }
        if (enc == 22) { // ENCODING_PCM_32BIT (API 31)
            short[] out = new short[b.remaining() / 4];
            for (int i = 0; i < out.length; i++) out[i] = (short) (b.getInt() >> 16);
            return out;
        }
        if (enc == AudioFormat.ENCODING_PCM_8BIT) {
            short[] out = new short[b.remaining()];
            for (int i = 0; i < out.length; i++) out[i] = (short) (((b.get() & 0xff) - 128) << 8);
            return out;
        }
        short[] out = new short[b.remaining() / 2];
        b.asShortBuffer().get(out);
        return out;
    }

    /** Picos (0-255, escala con raíz como en la PC) a perSec por segundo, en base64. */
    static JSONObject peaks(File f, final int perSec) throws IOException, JSONException {
        final java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        decode(f, 0, 0, new Sink() {
            int win = 441, ch = 2, n = 0;
            float max = 0;

            @Override
            public void format(int sampleRate, int channels) {
                win = Math.max(1, sampleRate / perSec);
                ch = Math.max(1, channels);
            }

            @Override
            public boolean pcm(short[] s, int frames) {
                for (int i = 0; i < frames; i++) {
                    for (int c = 0; c < ch; c++) {
                        float v = Math.abs(s[i * ch + c]) / 32768f;
                        if (v > max) max = v;
                    }
                    if (++n >= win) {
                        out.write(Math.min(255, Math.round((float) Math.sqrt(Math.min(1f, max)) * 255f)));
                        n = 0;
                        max = 0;
                    }
                }
                return true;
            }
        });
        JSONObject o = new JSONObject();
        o.put("rate", perSec);
        o.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
        return o;
    }

    /** Un tramo en PCM 16 bits intercalado (little endian) en outFile. */
    static JSONObject segment(File f, double startSec, double durSec, File outFile) throws IOException, JSONException {
        File dir = outFile.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("No se pudo crear " + dir);
        final int[] fmt = {44100, 2};
        final long[] total = {0};
        try (final OutputStream os = new BufferedOutputStream(new FileOutputStream(outFile), 1 << 16)) {
            decode(f, startSec, durSec, new Sink() {
                byte[] bytes = new byte[0];

                @Override
                public void format(int sampleRate, int channels) {
                    fmt[0] = sampleRate;
                    fmt[1] = channels;
                }

                @Override
                public boolean pcm(short[] s, int frames) throws IOException {
                    if (bytes.length < s.length * 2) bytes = new byte[s.length * 2];
                    for (int i = 0; i < s.length; i++) {
                        bytes[i * 2] = (byte) s[i];
                        bytes[i * 2 + 1] = (byte) (s[i] >> 8);
                    }
                    os.write(bytes, 0, s.length * 2);
                    total[0] += frames;
                    return true;
                }
            });
        }
        JSONObject o = new JSONObject();
        o.put("sampleRate", fmt[0]);
        o.put("channels", fmt[1]);
        o.put("frames", total[0]);
        return o;
    }
}
