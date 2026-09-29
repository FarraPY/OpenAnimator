package com.farrapy.openanimator;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
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
import android.opengl.GLES20;
import android.opengl.GLUtils;
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
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/**
 * Video export with the tablet's hardware encoder (the Android counterpart of NVENC on the PC).
 *
 * JavaScript renders each frame, sends it as a JPEG and this class draws it with OpenGL onto the
 * encoder's input surface (with an exact timestamp). The timeline audio arrives first as 16-bit PCM,
 * is encoded to AAC and interleaved with the video in an MP4 (MediaMuxer).
 *
 *   start({out, width, height, fps, bitrate, codec: avc|hevc, keyframeSec, audio: {sampleRate, channels, bitrate}})
 *   audio(pcm16le)   (all the audio, before the first frame)
 *   frame(jpeg) …    finish() → {path, size, frames}     cancel()
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
            if (cancelled) throw new IOException("cancelado");
            if (hasAudio && !audioEncoded) encodeAudio();
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inPreferredConfig = Bitmap.Config.ARGB_8888;
            Bitmap bmp = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length, o);
            if (bmp == null) throw new IOException("Fotograma inválido");
            try {
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
            } finally {
                bmp.recycle();
            }
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
            String fsh = "precision mediump float; varying vec2 vTex; uniform sampler2D uTex;\n"
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
