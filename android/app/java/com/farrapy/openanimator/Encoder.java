package com.farrapy.openanimator;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.SurfaceTexture;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.opengl.EGL14;
import android.opengl.EGLConfig;
import android.opengl.EGLContext;
import android.opengl.EGLDisplay;
import android.opengl.EGLExt;
import android.opengl.EGLSurface;
import android.opengl.GLES11Ext;
import android.opengl.GLES20;
import android.opengl.GLUtils;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Base64;
import android.util.Log;
import android.view.Surface;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;

/**
 * Video export with the tablet's hardware encoder (the Android counterpart of NVENC on the PC).
 *
 * Each frame arrives as a bitmap captured natively by Capture (or, as a fallback, a JPEG rendered by
 * JavaScript) and this class draws it with OpenGL onto the encoder's input surface (with an exact
 * timestamp). The timeline audio arrives first as 16-bit PCM, is encoded to AAC and interleaved with
 * the video in an MP4 (MediaMuxer).
 *
 *   start({out, width, height, fps, bitrate, codec: avc|hevc, keyframeSec, audio: {sampleRate, channels, bitrate}})
 *   audio(pcm16le)   (all the audio, before the first frame)
 *   frame(jpeg) | frameBitmap(bitmap) …    finish() → {path, size, frames}     cancel()
 *
 * GPU capture (Capture, mode "gpu"): gpuSurface() gives the Surface of a SurfaceTexture that a virtual
 * display draws into. The capture says which images it expects (gpuExpect: the number the page painted
 * in the marker strip under the video) and each image is taken on this thread as soon as it arrives: the
 * expected one is drawn into the encoder without ever leaving the GPU (the strip is cropped), older ones
 * are skipped, and a newer one means the expected image was never shown (gpuAwait says it's lost).
 */
final class Encoder {
    private static final String TAG = "OpenAnimator";
    private final Fs fs;
    private ExecutorService thread;
    private Job job;

    Encoder(Fs fs) {
        this.fs = fs;
    }

    synchronized JSONObject start(final JSONObject a) throws Exception {
        cancel();
        thread = Executors.newSingleThreadExecutor();
        job = new Job(fs, a);
        final Job j = job;
        try {
            return run(new Callable<JSONObject>() {
                @Override
                public JSONObject call() throws Exception {
                    return j.init();
                }
            });
        } catch (Exception e) {
            // Un codificador a medio configurar se libera ya (si no, queda tomado hasta la próxima exportación).
            cancel();
            throw e;
        }
    }

    void audio(byte[] pcm) throws IOException {
        Job j = job;
        if (j == null) throw new IOException("No hay una exportación en curso");
        j.appendAudio(pcm);
    }

    void frame(final byte[] jpeg) throws Exception {
        final Job j = job;
        if (j == null) throw new IOException("No hay una exportación en curso");
        run(new Callable<Object>() {
            @Override
            public Object call() throws Exception {
                j.frame(jpeg);
                return null;
            }
        });
    }

    /**
     * A frame already in a bitmap: it's queued on the encoder's thread and returns at once (the caller
     * doesn't touch the bitmap until the Future is done, so it can capture the next frame meanwhile).
     */
    Future<?> frameBitmap(final Bitmap bmp) throws IOException {
        final Job j = job;
        final ExecutorService t = thread;
        if (j == null || t == null) throw new IOException("No hay una exportación en curso");
        return t.submit(new Callable<Object>() {
            @Override
            public Object call() throws Exception {
                j.frame(bmp);
                return null;
            }
        });
    }

    /** An image the GPU capture expects: the one whose marker strip says seq. */
    static final class Want {
        static final int WAITING = 0, DONE = 1, LOST = 2;
        final int seq;
        final boolean preview, probe;
        int status;
        /** With preview: the encoded image, small, as JPEG in base64. */
        String previewJpeg;
        /** With probe (nothing is encoded): the image, small, RGBA with the rows from top to bottom. */
        byte[] pixels;
        int pw, ph;

        Want(int seq, boolean preview, boolean probe) {
            this.seq = seq;
            this.preview = preview;
            this.probe = probe;
        }
    }

    /** Surface for a virtual display of width×(height+marker) pixels (GPU capture). */
    Surface gpuSurface(final int width, final int height, final int marker) throws Exception {
        final Job j = job;
        final ExecutorService t = thread;
        if (j == null || t == null) throw new IOException("No hay una exportación en curso");
        return run(new Callable<Surface>() {
            @Override
            public Surface call() throws Exception {
                return j.gpuSetup(width, height, marker, t);
            }
        });
    }

    /** Before the first frame: the audio is encoded now, not while images from the virtual display arrive. */
    void gpuPrepare() throws Exception {
        final Job j = job;
        if (j == null) throw new IOException("No hay una exportación en curso");
        run(new Callable<Object>() {
            @Override
            public Object call() throws Exception {
                if (j.hasAudio && !j.audioEncoded) j.encodeAudio();
                return null;
            }
        });
    }

    /**
     * The next image to wait for. Images are taken in the order they are expected, as soon as they arrive
     * (even before gpuAwait): so the virtual display never piles up images waiting for this side.
     */
    Want gpuExpect(int seq, boolean preview, boolean probe) throws IOException {
        Job j = job;
        if (j == null) throw new IOException("No hay una exportación en curso");
        return j.expect(seq, preview, probe);
    }

    /** Waits until w is done (encoded, or read if it's a probe) or lost; false if the time ran out first. */
    boolean gpuAwait(Want w, long timeoutMs) throws Exception {
        Job j = job;
        if (j == null) throw new IOException("La exportación se canceló");
        return j.await(w, timeoutMs);
    }

    /** Forgets the images still expected (the capture starts over from another frame). */
    void gpuForget() {
        Job j = job;
        if (j != null) j.forget();
    }

    /** Releases the texture behind surface (only that one: a newer capture may have its own by now). */
    void gpuRelease(final Surface surface) {
        final Job j = job;
        final ExecutorService t = thread;
        if (j == null || t == null) return;
        try {
            t.execute(new Runnable() {
                @Override
                public void run() {
                    if (j.stSurface == surface) j.gpuRelease();
                }
            });
        } catch (Exception ignored) {
            // ya cerrado
        }
    }

    /** Frames already encoded (after what was queued): where to go on if the capture method changes. */
    long frames() throws Exception {
        final Job j = job;
        if (j == null) throw new IOException("No hay una exportación en curso");
        return run(new Callable<Long>() {
            @Override
            public Long call() {
                return j.frames;
            }
        });
    }

    JSONObject finish() throws Exception {
        final Job j = job;
        if (j == null) throw new IOException("No hay una exportación en curso");
        try {
            return run(new Callable<JSONObject>() {
                @Override
                public JSONObject call() throws Exception {
                    try {
                        return j.finish();
                    } catch (Exception e) {
                        // Falló al cerrar (sin espacio, el codificador no terminó…): se libera todo y se borra el parcial.
                        j.release(true);
                        throw e;
                    }
                }
            });
        } finally {
            synchronized (this) {
                if (job == j) {
                    job = null;
                    thread.shutdown();
                    thread = null;
                }
            }
        }
    }

    synchronized void cancel() {
        final Job j = job;
        job = null;
        if (j == null) return;
        j.cancelled = true;
        ExecutorService t = thread;
        thread = null;
        if (t != null) {
            t.execute(new Runnable() {
                @Override
                public void run() {
                    j.release(true);
                }
            });
            t.shutdown();
        }
    }

    private <T> T run(Callable<T> c) throws Exception {
        ExecutorService t = thread;
        if (t == null) throw new IOException("La exportación se canceló");
        Future<T> f = t.submit(c);
        try {
            return f.get();
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            throw new IOException(String.valueOf(cause));
        }
    }

    /**
     * Texture coordinates in high precision where the GPU has it: with mediump (10 bits) a coordinate
     * near 1.0 on a 1080-row image can be off by about a pixel.
     */
    private static final String HIGHP = "#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n";

    /** One export: codecs, EGL and muxer. Everything runs on the encoder thread. */
    private static final class Job {
        final Fs fs;
        final File out, tmp, pcm;
        final int width, height, videoBitrate, keyframeSec;
        final double fps;
        final String videoMime;
        final int sampleRate, channels, audioBitrate;
        final boolean hasAudio;
        volatile boolean cancelled;

        MediaCodec video;
        Surface input;
        MediaMuxer muxer;
        int videoTrack = -1, audioTrack = -1;
        boolean muxing;
        long frames;
        final MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();

        // audio ya codificado (AAC), se intercala con el video por tiempo
        MediaFormat audioFormat;
        final List<byte[]> audioData = new ArrayList<>();
        final List<Long> audioPts = new ArrayList<>();
        final List<Integer> audioFlags = new ArrayList<>();
        int audioNext;
        boolean audioEncoded;
        OutputStream pcmOut;

        EGLDisplay eglDisplay = EGL14.EGL_NO_DISPLAY;
        EGLContext eglContext = EGL14.EGL_NO_CONTEXT;
        EGLSurface eglSurface = EGL14.EGL_NO_SURFACE;
        int program, texture, aPos, aTex;
        FloatBuffer quad;

        Job(Fs fs, JSONObject a) throws IOException, JSONException {
            this.fs = fs;
            out = fs.resolve(a.getString("out"));
            tmp = new File(out.getParentFile(), "." + out.getName() + ".part");
            pcm = new File(out.getParentFile(), "." + out.getName() + ".pcm");
            width = a.getInt("width") / 2 * 2;
            height = a.getInt("height") / 2 * 2;
            fps = a.optDouble("fps", 30);
            videoBitrate = a.optInt("bitrate", 12000000);
            keyframeSec = Math.max(1, a.optInt("keyframeSec", 1));
            videoMime = "hevc".equals(a.optString("codec")) ? MediaFormat.MIMETYPE_VIDEO_HEVC : MediaFormat.MIMETYPE_VIDEO_AVC;
            JSONObject au = a.optJSONObject("audio");
            hasAudio = au != null;
            sampleRate = au != null ? au.optInt("sampleRate", 48000) : 48000;
            channels = au != null ? au.optInt("channels", 2) : 2;
            audioBitrate = au != null ? au.optInt("bitrate", 192000) : 192000;
        }

        JSONObject init() throws Exception {
            File dir = out.getParentFile();
            if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("No se pudo crear " + dir);
            video = MediaCodec.createEncoderByType(videoMime);
            MediaFormat f = MediaFormat.createVideoFormat(videoMime, width, height);
            f.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
            f.setInteger(MediaFormat.KEY_BIT_RATE, videoBitrate);
            f.setInteger(MediaFormat.KEY_FRAME_RATE, (int) Math.max(1, Math.round(fps)));
            f.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, keyframeSec);
            String profile = "baseline";
            if (videoMime.equals(MediaFormat.MIMETYPE_VIDEO_AVC) && supportsProfile(video, MediaCodecInfo.CodecProfileLevel.AVCProfileHigh)) {
                MediaFormat hi = MediaFormat.createVideoFormat(videoMime, width, height);
                hi.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
                hi.setInteger(MediaFormat.KEY_BIT_RATE, videoBitrate);
                hi.setInteger(MediaFormat.KEY_FRAME_RATE, (int) Math.max(1, Math.round(fps)));
                hi.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, keyframeSec);
                hi.setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileHigh);
                hi.setInteger(MediaFormat.KEY_LEVEL, levelFor(width, height, fps));
                try {
                    video.configure(hi, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
                    profile = "high";
                } catch (Exception e) {
                    Log.w(TAG, "perfil High no aceptado; se usa el predeterminado", e);
                    video.release();
                    video = MediaCodec.createEncoderByType(videoMime);
                    video.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
                }
            } else {
                video.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
                profile = videoMime.equals(MediaFormat.MIMETYPE_VIDEO_HEVC) ? "main" : "baseline";
            }
            input = video.createInputSurface();
            video.start();
            setupEgl();
            muxer = new MediaMuxer(tmp.getPath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
            if (hasAudio) pcmOut = new FileOutputStream(pcm);
            JSONObject o = new JSONObject();
            o.put("codec", video.getName());
            o.put("mime", videoMime);
            o.put("profile", profile);
            o.put("width", width);
            o.put("height", height);
            return o;
        }

        private static boolean supportsProfile(MediaCodec codec, int profile) {
            try {
                MediaCodecInfo.CodecCapabilities caps = codec.getCodecInfo().getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC);
                for (MediaCodecInfo.CodecProfileLevel pl : caps.profileLevels) if (pl.profile == profile) return true;
            } catch (Exception ignored) {
            }
            return false;
        }

        private static int levelFor(int w, int h, double fps) {
            long mbps = (long) Math.ceil(w / 16.0) * (long) Math.ceil(h / 16.0) * (long) Math.ceil(fps);
            if (mbps <= 108000) return MediaCodecInfo.CodecProfileLevel.AVCLevel31;
            if (mbps <= 245760) return MediaCodecInfo.CodecProfileLevel.AVCLevel4;
            if (mbps <= 522240) return MediaCodecInfo.CodecProfileLevel.AVCLevel42;
            if (mbps <= 983040) return MediaCodecInfo.CodecProfileLevel.AVCLevel51;
            return MediaCodecInfo.CodecProfileLevel.AVCLevel52;
        }

        synchronized void appendAudio(byte[] data) throws IOException {
            if (pcmOut == null) throw new IOException("Esta exportación no tiene audio");
            pcmOut.write(data);
        }

        // ── video ────────────────────────────────────────────────────────────────

        void frame(byte[] jpeg) throws Exception {
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inPreferredConfig = Bitmap.Config.ARGB_8888;
            Bitmap bmp = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length, o);
            if (bmp == null) throw new IOException("Fotograma inválido");
            try {
                frame(bmp);
            } finally {
                bmp.recycle();
            }
        }

        void frame(Bitmap bmp) throws Exception {
            if (cancelled) throw new IOException("cancelado");
            if (hasAudio && !audioEncoded) encodeAudio();
            drain(false);
            GLES20.glViewport(0, 0, width, height);
            GLES20.glClearColor(0f, 0f, 0f, 1f);
            GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);
            GLES20.glUseProgram(program);
            GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture);
            GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, bmp, 0);
            quad.position(0);
            GLES20.glVertexAttribPointer(aPos, 2, GLES20.GL_FLOAT, false, 16, quad);
            GLES20.glEnableVertexAttribArray(aPos);
            quad.position(2);
            GLES20.glVertexAttribPointer(aTex, 2, GLES20.GL_FLOAT, false, 16, quad);
            GLES20.glEnableVertexAttribArray(aTex);
            GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
            checkGl("draw");
            long ptsNs = Math.round(frames * 1e9 / fps);
            EGLExt.eglPresentationTimeANDROID(eglDisplay, eglSurface, ptsNs);
            if (!EGL14.eglSwapBuffers(eglDisplay, eglSurface)) throw new IOException("eglSwapBuffers falló: 0x" + Integer.toHexString(EGL14.eglGetError()));
            frames++;
            drain(false);
        }

        /** Moves encoded video to the muxer; with eos, waits until the encoder is empty. */
        private void drain(boolean eos) throws IOException {
            if (eos) video.signalEndOfInputStream();
            long deadline = System.currentTimeMillis() + 20000;
            while (true) {
                int idx = video.dequeueOutputBuffer(info, eos ? 10000 : 0);
                if (idx == MediaCodec.INFO_TRY_AGAIN_LATER) {
                    if (!eos) return;
                    if (System.currentTimeMillis() > deadline) throw new IOException("El codificador no terminó a tiempo");
                } else if (idx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    if (muxing) throw new IOException("El formato del video cambió durante la exportación");
                    videoTrack = muxer.addTrack(video.getOutputFormat());
                    if (hasAudio && audioFormat != null) audioTrack = muxer.addTrack(audioFormat);
                    muxer.start();
                    muxing = true;
                } else if (idx >= 0) {
                    ByteBuffer buf = video.getOutputBuffer(idx);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) info.size = 0;
                    if (info.size > 0 && muxing && buf != null) {
                        buf.position(info.offset);
                        buf.limit(info.offset + info.size);
                        muxer.writeSampleData(videoTrack, buf, info);
                        writeAudioUpTo(info.presentationTimeUs);
                    }
                    video.releaseOutputBuffer(idx, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) return;
                }
            }
        }

        // ── audio ────────────────────────────────────────────────────────────────

        /** Encodes all the PCM received so far to AAC (kept in memory, ~24 KB per second). */
        private void encodeAudio() throws IOException {
            audioEncoded = true;
            synchronized (this) {
                if (pcmOut != null) {
                    pcmOut.close();
                    pcmOut = null;
                }
            }
            MediaFormat f = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, channels);
            f.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
            f.setInteger(MediaFormat.KEY_BIT_RATE, audioBitrate);
            f.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 65536);
            MediaCodec aac = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
            try {
                aac.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
                aac.start();
                MediaCodec.BufferInfo ai = new MediaCodec.BufferInfo();
                int frameBytes = 2 * channels;
                long samples = 0;
                boolean inputDone = false, outputDone = false;
                byte[] chunk = new byte[65536];
                long deadline = System.currentTimeMillis() + 600000;
                try (InputStream in = new BufferedInputStream(new FileInputStream(pcm), 1 << 20)) {
                    while (!outputDone) {
                        if (cancelled) throw new IOException("cancelado");
                        if (System.currentTimeMillis() > deadline) throw new IOException("El codificador de audio no terminó a tiempo");
                        if (!inputDone) {
                            int ii = aac.dequeueInputBuffer(10000);
                            if (ii >= 0) {
                                ByteBuffer ib = aac.getInputBuffer(ii);
                                int want = Math.min(chunk.length, ib.capacity()) / frameBytes * frameBytes;
                                int got = readFully(in, chunk, want);
                                long pts = samples * 1000000L / sampleRate;
                                if (got <= 0) {
                                    aac.queueInputBuffer(ii, 0, 0, pts, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                                    inputDone = true;
                                } else {
                                    ib.clear();
                                    ib.put(chunk, 0, got);
                                    aac.queueInputBuffer(ii, 0, got, pts, 0);
                                    samples += got / frameBytes;
                                }
                            }
                        }
                        int oi = aac.dequeueOutputBuffer(ai, 10000);
                        if (oi == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                            audioFormat = aac.getOutputFormat();
                        } else if (oi >= 0) {
                            ByteBuffer ob = aac.getOutputBuffer(oi);
                            if ((ai.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && ai.size > 0 && ob != null) {
                                byte[] d = new byte[ai.size];
                                ob.position(ai.offset);
                                ob.get(d, 0, ai.size);
                                audioData.add(d);
                                audioPts.add(ai.presentationTimeUs);
                                audioFlags.add(ai.flags & ~MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            }
                            aac.releaseOutputBuffer(oi, false);
                            if ((ai.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outputDone = true;
                        }
                    }
                }
            } finally {
                try {
                    aac.stop();
                } catch (Exception ignored) {
                }
                aac.release();
                //noinspection ResultOfMethodCallIgnored
                pcm.delete();
            }
            if (audioFormat == null) throw new IOException("El codificador de audio no devolvió formato");
        }

        private static int readFully(InputStream in, byte[] b, int len) throws IOException {
            int got = 0;
            while (got < len) {
                int n = in.read(b, got, len - got);
                if (n < 0) break;
                got += n;
            }
            return got;
        }

        private void writeAudioUpTo(long ptsUs) {
            if (audioTrack < 0) return;
            MediaCodec.BufferInfo bi = new MediaCodec.BufferInfo();
            while (audioNext < audioData.size() && audioPts.get(audioNext) <= ptsUs) {
                byte[] d = audioData.get(audioNext);
                bi.set(0, d.length, audioPts.get(audioNext), audioFlags.get(audioNext));
                muxer.writeSampleData(audioTrack, ByteBuffer.wrap(d), bi);
                audioData.set(audioNext, null);
                audioNext++;
            }
        }

        // ── cierre ───────────────────────────────────────────────────────────────

        JSONObject finish() throws Exception {
            if (hasAudio && !audioEncoded) encodeAudio();
            if (frames == 0) throw new IOException("No se recibió ningún fotograma");
            drain(true);
            if (!muxing) throw new IOException("El codificador no produjo video");
            writeAudioUpTo(Long.MAX_VALUE);
            muxer.stop();
            release(false);
            if (out.exists() && !out.delete()) throw new IOException("No se pudo reemplazar " + out.getName());
            if (!tmp.renameTo(out)) throw new IOException("No se pudo guardar " + out.getName());
            JSONObject o = new JSONObject();
            o.put("path", fs.relative(out));
            o.put("size", out.length());
            o.put("frames", frames);
            o.put("duration", frames / fps);
            return o;
        }

        void release(boolean deleteOutput) {
            try {
                if (pcmOut != null) pcmOut.close();
            } catch (IOException ignored) {
            }
            pcmOut = null;
            gpuRelease();
            if (frameThread != null) {
                frameThread.quitSafely();
                frameThread = null;
            }
            if (eglDisplay != EGL14.EGL_NO_DISPLAY) {
                EGL14.eglMakeCurrent(eglDisplay, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT);
                if (eglSurface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(eglDisplay, eglSurface);
                if (eglContext != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(eglDisplay, eglContext);
                EGL14.eglReleaseThread();
                EGL14.eglTerminate(eglDisplay);
            }
            eglDisplay = EGL14.EGL_NO_DISPLAY;
            eglContext = EGL14.EGL_NO_CONTEXT;
            eglSurface = EGL14.EGL_NO_SURFACE;
            if (video != null) {
                try {
                    video.stop();
                } catch (Exception ignored) {
                }
                video.release();
                video = null;
            }
            if (input != null) {
                input.release();
                input = null;
            }
            if (muxer != null) {
                try {
                    if (muxing && deleteOutput) muxer.stop();
                } catch (Exception ignored) {
                }
                try {
                    muxer.release();
                } catch (Exception ignored) {
                }
                muxer = null;
            }
            if (deleteOutput) {
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
            }
            //noinspection ResultOfMethodCallIgnored
            pcm.delete();
        }

        // ── OpenGL ES sobre la superficie del codificador ────────────────────────

        private void setupEgl() throws IOException {
            eglDisplay = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
            if (eglDisplay == EGL14.EGL_NO_DISPLAY) throw new IOException("Sin pantalla EGL");
            int[] ver = new int[2];
            if (!EGL14.eglInitialize(eglDisplay, ver, 0, ver, 1)) throw new IOException("eglInitialize falló");
            int[] attribs = {
                    EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_ALPHA_SIZE, 8,
                    EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
                    0x3142 /* EGL_RECORDABLE_ANDROID */, 1,
                    EGL14.EGL_NONE};
            EGLConfig[] configs = new EGLConfig[1];
            int[] num = new int[1];
            if (!EGL14.eglChooseConfig(eglDisplay, attribs, 0, configs, 0, 1, num, 0) || num[0] < 1) throw new IOException("Sin configuración EGL grabable");
            eglContext = EGL14.eglCreateContext(eglDisplay, configs[0], EGL14.EGL_NO_CONTEXT, new int[]{EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE}, 0);
            if (eglContext == null || eglContext == EGL14.EGL_NO_CONTEXT) throw new IOException("No se pudo crear el contexto EGL");
            eglSurface = EGL14.eglCreateWindowSurface(eglDisplay, configs[0], input, new int[]{EGL14.EGL_NONE}, 0);
            if (eglSurface == null || eglSurface == EGL14.EGL_NO_SURFACE) throw new IOException("No se pudo crear la superficie EGL");
            if (!EGL14.eglMakeCurrent(eglDisplay, eglSurface, eglSurface, eglContext)) throw new IOException("eglMakeCurrent falló");

            String vs = "attribute vec2 aPos; attribute vec2 aTex; varying vec2 vTex;\n"
                    + "void main() { gl_Position = vec4(aPos, 0.0, 1.0); vTex = aTex; }\n";
            String fsh = HIGHP + "varying vec2 vTex; uniform sampler2D uTex;\n"
                    + "void main() { gl_FragColor = texture2D(uTex, vTex); }\n";
            program = GLES20.glCreateProgram();
            GLES20.glAttachShader(program, shader(GLES20.GL_VERTEX_SHADER, vs));
            GLES20.glAttachShader(program, shader(GLES20.GL_FRAGMENT_SHADER, fsh));
            GLES20.glLinkProgram(program);
            int[] linked = new int[1];
            GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, linked, 0);
            if (linked[0] == 0) throw new IOException("Shader: " + GLES20.glGetProgramInfoLog(program));
            aPos = GLES20.glGetAttribLocation(program, "aPos");
            aTex = GLES20.glGetAttribLocation(program, "aTex");
            GLES20.glUseProgram(program);
            GLES20.glUniform1i(GLES20.glGetUniformLocation(program, "uTex"), 0);
            // Tira de 2 triángulos que cubre la superficie; la fila de arriba del bitmap va arriba.
            float[] v = {
                    -1f, -1f, 0f, 1f,
                    1f, -1f, 1f, 1f,
                    -1f, 1f, 0f, 0f,
                    1f, 1f, 1f, 0f};
            quad = ByteBuffer.allocateDirect(v.length * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
            quad.put(v).position(0);
            int[] t = new int[1];
            GLES20.glGenTextures(1, t, 0);
            texture = t[0];
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture);
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
            checkGl("setup");
        }

        // ── captura por GPU: una pantalla virtual dibuja en una textura de esta misma GPU ──────────

        SurfaceTexture st;
        Surface stSurface;
        HandlerThread frameThread;
        int oesTex, oesProgram, oesPos, oesTexAttr, oesMatrix, oesT0, oesFlip;
        int markProgram, markPos, markMatrix, markRow, markFbo, markTexture;
        int prevFbo, prevTexture, prevW, prevH;
        FloatBuffer oesQuad;
        final float[] stMatrix = new float[16];
        int capHeight, capMarker;
        final ByteBuffer markPixels = ByteBuffer.allocateDirect(8 * 4).order(ByteOrder.nativeOrder());
        /** Lo que espera la captura, en orden (lo agrega otro hilo: se protege con gpuLock). */
        final Object gpuLock = new Object();
        final ArrayDeque<Want> wants = new ArrayDeque<>();
        Exception gpuError;

        Surface gpuSetup(int w, int h, int marker, final Executor exec) throws IOException {
            gpuRelease();
            capHeight = h;
            capMarker = marker;
            if (oesProgram == 0) gpuPrograms();
            int[] t = new int[1];
            GLES20.glGenTextures(1, t, 0);
            oesTex = t[0];
            GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTex);
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
            // La franja de marca (8 celdas) se lee de una textura de 8×1.
            markTexture = texture2d(8, 1);
            markFbo = framebuffer(markTexture);
            if (frameThread == null) {
                frameThread = new HandlerThread("oa-frames");
                frameThread.start();
            }
            final SurfaceTexture s = new SurfaceTexture(oesTex);
            s.setDefaultBufferSize(w, h + marker);
            // Cada imagen nueva se toma en el hilo del codificador (el del contexto de OpenGL), una por aviso.
            s.setOnFrameAvailableListener(new SurfaceTexture.OnFrameAvailableListener() {
                @Override
                public void onFrameAvailable(SurfaceTexture x) {
                    try {
                        exec.execute(new Runnable() {
                            @Override
                            public void run() {
                                latch(s);
                            }
                        });
                    } catch (RejectedExecutionException ignored) {
                        // la exportación ya terminó
                    }
                }
            }, new Handler(frameThread.getLooper()));
            st = s;
            stSurface = new Surface(s);
            checkGl("gpu");
            return stSurface;
        }

        Want expect(int seq, boolean preview, boolean probe) {
            Want w = new Want(seq, preview, probe);
            synchronized (gpuLock) {
                wants.addLast(w);
            }
            return w;
        }

        boolean await(Want w, long timeoutMs) throws Exception {
            long deadline = System.currentTimeMillis() + timeoutMs;
            synchronized (gpuLock) {
                while (w.status == Want.WAITING) {
                    if (gpuError != null) throw gpuError;
                    if (cancelled) throw new IOException("cancelado");
                    long left = deadline - System.currentTimeMillis();
                    if (left <= 0) return false;
                    gpuLock.wait(left);
                }
            }
            return true;
        }

        void forget() {
            synchronized (gpuLock) {
                for (Want w : wants) w.status = Want.LOST;
                wants.clear();
                gpuLock.notifyAll();
            }
        }

        /** a is after b (sequence numbers of 24 bits that go around). */
        private static boolean after(int a, int b) {
            int d = (a - b) & 0xFFFFFF;
            return d != 0 && d < 0x800000;
        }

        /** One image of the virtual display (on the encoder's thread, one call per image, in order). */
        void latch(SurfaceTexture s) {
            if (s != st || cancelled) return;
            try {
                s.updateTexImage();
                s.getTransformMatrix(stMatrix);
                int m = readMarker();
                Want w;
                synchronized (gpuLock) {
                    w = wants.peekFirst();
                    if (w == null || m == 0) return; // no se espera nada, o la página está cambiando de fotograma
                    if (m != w.seq) {
                        // Una imagen anterior se ignora. Una posterior quiere decir que la esperada nunca se mostró:
                        // se pierde con todo lo que venía detrás (el video no puede saltear ni desordenar fotogramas).
                        if (after(m, w.seq)) {
                            for (Want x : wants) x.status = Want.LOST;
                            wants.clear();
                            gpuLock.notifyAll();
                        }
                        return;
                    }
                    wants.pollFirst();
                }
                if (w.probe) {
                    ByteBuffer px = readSmall();
                    w.pixels = new byte[px.capacity()];
                    px.position(0);
                    px.get(w.pixels);
                    w.pw = prevW;
                    w.ph = prevH;
                } else {
                    encodeOes();
                    if (w.preview) w.previewJpeg = previewJpeg();
                }
                synchronized (gpuLock) {
                    w.status = Want.DONE;
                    gpuLock.notifyAll();
                }
            } catch (Exception e) {
                Log.w(TAG, "captura por GPU", e);
                synchronized (gpuLock) {
                    gpuError = e;
                    gpuLock.notifyAll();
                }
            }
        }

        /** The current image of the virtual display (without its marker strip) goes to the encoder. */
        private void encodeOes() throws IOException {
            if (hasAudio && !audioEncoded) encodeAudio();
            drain(false);
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0);
            GLES20.glViewport(0, 0, width, height);
            drawOes(false);
            checkGl("gpu draw");
            long ptsNs = Math.round(frames * 1e9 / fps);
            EGLExt.eglPresentationTimeANDROID(eglDisplay, eglSurface, ptsNs);
            if (!EGL14.eglSwapBuffers(eglDisplay, eglSurface)) throw new IOException("eglSwapBuffers falló: 0x" + Integer.toHexString(EGL14.eglGetError()));
            frames++;
            drain(false);
        }

        void gpuRelease() {
            synchronized (gpuLock) {
                for (Want w : wants) w.status = Want.LOST;
                wants.clear();
                gpuError = null;
                gpuLock.notifyAll();
            }
            if (st != null) {
                st.setOnFrameAvailableListener(null);
                st.release();
                st = null;
            }
            if (stSurface != null) {
                stSurface.release();
                stSurface = null;
            }
            if (eglDisplay == EGL14.EGL_NO_DISPLAY) return;
            int[] one = new int[1];
            if (oesTex != 0) { one[0] = oesTex; GLES20.glDeleteTextures(1, one, 0); oesTex = 0; }
            if (markFbo != 0) { one[0] = markFbo; GLES20.glDeleteFramebuffers(1, one, 0); markFbo = 0; }
            if (markTexture != 0) { one[0] = markTexture; GLES20.glDeleteTextures(1, one, 0); markTexture = 0; }
            if (prevFbo != 0) { one[0] = prevFbo; GLES20.glDeleteFramebuffers(1, one, 0); prevFbo = 0; }
            if (prevTexture != 0) { one[0] = prevTexture; GLES20.glDeleteTextures(1, one, 0); prevTexture = 0; }
        }

        /** The number the page painted in its marker strip: 8 cells, 3 bits each (R, G, B on or off). */
        private int readMarker() {
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, markFbo);
            GLES20.glViewport(0, 0, 8, 1);
            GLES20.glUseProgram(markProgram);
            GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
            GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTex);
            GLES20.glUniformMatrix4fv(markMatrix, 1, false, stMatrix, 0);
            GLES20.glUniform1f(markRow, (capMarker * 0.5f) / (capHeight + capMarker));
            oesQuad.position(0);
            GLES20.glVertexAttribPointer(markPos, 2, GLES20.GL_FLOAT, false, 16, oesQuad);
            GLES20.glEnableVertexAttribArray(markPos);
            GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
            markPixels.position(0);
            GLES20.glReadPixels(0, 0, 8, 1, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, markPixels);
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0);
            int v = 0;
            for (int i = 0; i < 8; i++) {
                if ((markPixels.get(i * 4) & 0xFF) > 127) v |= 1 << (3 * i);
                if ((markPixels.get(i * 4 + 1) & 0xFF) > 127) v |= 1 << (3 * i + 1);
                if ((markPixels.get(i * 4 + 2) & 0xFF) > 127) v |= 1 << (3 * i + 2);
            }
            return v;
        }

        /** The virtual display's image without the marker strip; flip=true for reading it back (rows top-down). */
        private void drawOes(boolean flip) {
            GLES20.glClearColor(0f, 0f, 0f, 1f);
            GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);
            GLES20.glUseProgram(oesProgram);
            GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
            GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTex);
            GLES20.glUniformMatrix4fv(oesMatrix, 1, false, stMatrix, 0);
            GLES20.glUniform1f(oesT0, (float) capMarker / (capHeight + capMarker));
            GLES20.glUniform1f(oesFlip, flip ? -1f : 1f);
            oesQuad.position(0);
            GLES20.glVertexAttribPointer(oesPos, 2, GLES20.GL_FLOAT, false, 16, oesQuad);
            GLES20.glEnableVertexAttribArray(oesPos);
            oesQuad.position(2);
            GLES20.glVertexAttribPointer(oesTexAttr, 2, GLES20.GL_FLOAT, false, 16, oesQuad);
            GLES20.glEnableVertexAttribArray(oesTexAttr);
            GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
        }

        /** The current image, 480 pixels wide, RGBA with the rows from top to bottom. */
        private ByteBuffer readSmall() throws IOException {
            if (prevFbo == 0) {
                prevW = 480;
                prevH = Math.max(2, Math.round(480f * height / width));
                prevTexture = texture2d(prevW, prevH);
                prevFbo = framebuffer(prevTexture);
            }
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, prevFbo);
            GLES20.glViewport(0, 0, prevW, prevH);
            drawOes(true);
            ByteBuffer px = ByteBuffer.allocateDirect(prevW * prevH * 4).order(ByteOrder.nativeOrder());
            GLES20.glReadPixels(0, 0, prevW, prevH, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, px);
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0);
            GLES20.glViewport(0, 0, width, height);
            return px;
        }

        private String previewJpeg() throws IOException {
            ByteBuffer px = readSmall();
            Bitmap b = Bitmap.createBitmap(prevW, prevH, Bitmap.Config.ARGB_8888);
            px.position(0);
            b.copyPixelsFromBuffer(px);
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            b.compress(Bitmap.CompressFormat.JPEG, 75, out);
            b.recycle();
            return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        }

        private void gpuPrograms() throws IOException {
            String vs = "attribute vec2 aPos; attribute vec2 aTex; uniform mat4 uTexM; uniform float uT0; uniform float uFlip; varying vec2 vTex;\n"
                    + "void main() { gl_Position = vec4(aPos.x, aPos.y * uFlip, 0.0, 1.0);\n"
                    + "  vTex = (uTexM * vec4(aTex.x, uT0 + aTex.y * (1.0 - uT0), 0.0, 1.0)).xy; }\n";
            String fs = "#extension GL_OES_EGL_image_external : require\n"
                    + HIGHP + "varying vec2 vTex; uniform samplerExternalOES sTex;\n"
                    + "void main() { gl_FragColor = texture2D(sTex, vTex); }\n";
            oesProgram = link(vs, fs);
            oesPos = GLES20.glGetAttribLocation(oesProgram, "aPos");
            oesTexAttr = GLES20.glGetAttribLocation(oesProgram, "aTex");
            oesMatrix = GLES20.glGetUniformLocation(oesProgram, "uTexM");
            oesT0 = GLES20.glGetUniformLocation(oesProgram, "uT0");
            oesFlip = GLES20.glGetUniformLocation(oesProgram, "uFlip");
            GLES20.glUseProgram(oesProgram);
            GLES20.glUniform1i(GLES20.glGetUniformLocation(oesProgram, "sTex"), 0);
            String mvs = "attribute vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }\n";
            String mfs = "#extension GL_OES_EGL_image_external : require\n"
                    + HIGHP + "uniform samplerExternalOES sTex; uniform mat4 uTexM; uniform float uRowT;\n"
                    + "void main() { float cell = floor(gl_FragCoord.x);\n"
                    + "  vec2 p = vec2((cell + 0.5) / 8.0, uRowT);\n"
                    + "  gl_FragColor = texture2D(sTex, (uTexM * vec4(p, 0.0, 1.0)).xy); }\n";
            markProgram = link(mvs, mfs);
            markPos = GLES20.glGetAttribLocation(markProgram, "aPos");
            markMatrix = GLES20.glGetUniformLocation(markProgram, "uTexM");
            markRow = GLES20.glGetUniformLocation(markProgram, "uRowT");
            GLES20.glUseProgram(markProgram);
            GLES20.glUniform1i(GLES20.glGetUniformLocation(markProgram, "sTex"), 0);
            // Posición y coordenada (de abajo hacia arriba, como la matriz de la SurfaceTexture).
            float[] v = {
                    -1f, -1f, 0f, 0f,
                    1f, -1f, 1f, 0f,
                    -1f, 1f, 0f, 1f,
                    1f, 1f, 1f, 1f};
            oesQuad = ByteBuffer.allocateDirect(v.length * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
            oesQuad.put(v).position(0);
            checkGl("gpu programs");
        }

        private static int link(String vs, String fs) throws IOException {
            int p = GLES20.glCreateProgram();
            GLES20.glAttachShader(p, shader(GLES20.GL_VERTEX_SHADER, vs));
            GLES20.glAttachShader(p, shader(GLES20.GL_FRAGMENT_SHADER, fs));
            GLES20.glLinkProgram(p);
            int[] linked = new int[1];
            GLES20.glGetProgramiv(p, GLES20.GL_LINK_STATUS, linked, 0);
            if (linked[0] == 0) throw new IOException("Shader: " + GLES20.glGetProgramInfoLog(p));
            return p;
        }

        private static int texture2d(int w, int h) {
            int[] t = new int[1];
            GLES20.glGenTextures(1, t, 0);
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, t[0]);
            GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_RGBA, w, h, 0, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, null);
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_NEAREST);
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_NEAREST);
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
            return t[0];
        }

        private static int framebuffer(int texture) throws IOException {
            int[] f = new int[1];
            GLES20.glGenFramebuffers(1, f, 0);
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, f[0]);
            GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0, GLES20.GL_TEXTURE_2D, texture, 0);
            int status = GLES20.glCheckFramebufferStatus(GLES20.GL_FRAMEBUFFER);
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0);
            if (status != GLES20.GL_FRAMEBUFFER_COMPLETE) throw new IOException("Framebuffer incompleto: 0x" + Integer.toHexString(status));
            return f[0];
        }

        private static int shader(int type, String src) throws IOException {
            int s = GLES20.glCreateShader(type);
            GLES20.glShaderSource(s, src);
            GLES20.glCompileShader(s);
            int[] ok = new int[1];
            GLES20.glGetShaderiv(s, GLES20.GL_COMPILE_STATUS, ok, 0);
            if (ok[0] == 0) throw new IOException("Shader: " + GLES20.glGetShaderInfoLog(s));
            return s;
        }

        private static void checkGl(String what) throws IOException {
            int e = GLES20.glGetError();
            if (e != GLES20.GL_NO_ERROR) throw new IOException("OpenGL " + what + ": 0x" + Integer.toHexString(e));
        }
    }
}
