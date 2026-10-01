/**
 * Codificador de la exportación (enc.* del puente, como Encoder.java en Android): WebCodecs (codificador de hardware
 * del iPhone) + Mediabunny para armar el MP4. El archivo se escribe en OPFS a medida que se codifica (nunca entero en
 * memoria). El audio se mezcla en ventanas de 30 s (audio.ts) mientras se capturan los fotogramas.
 * En la app siempre va por AVFoundation (ios/OpenAnimator/NativeEncoder.swift): los fotogramas le llegan de la captura de
 * iOS (NativeCapture.swift, sin pasar por la página) o, con el método compatible, en JPEG; el audio, en PCM. WebCodecs
 * queda para Safari.
 */
import { AudioSample, AudioSampleSource, CustomVideoEncoder, EncodedPacket, Mp4OutputFormat, Output, StreamTarget, VideoSample, VideoSampleSource, canEncodeAudio, canEncodeVideo, registerEncoder } from 'mediabunny'
import type { WebFS } from './webfs'
import { mixWindow } from './audio'
import { b64encode, isNative, nativeCall } from './native'

/** Veces que el codificador se trabó y hubo que vaciarlo (para el informe de la exportación). */
let stalls = 0
/** Fotogramas que devolvió el codificador (si al final faltan, WebCodecs no anduvo). */
let packets = 0
/** Por qué no anduvo WebCodecs en esta exportación (vacío: anduvo o no se usó). */
let webcodecsError = ''
/** WebCodecs ya falló en este equipo: se exporta con AVFoundation (hasta que se cierre la app). */
let avf = false
/**
 * El codificador de video de WebCodecs con su propia espera. Mediabunny, con 4 fotogramas en cola, espera el evento
 * `dequeue`; en el WebKit de iOS (simulador de iOS 26) el codificador tomaba 4 y se quedaba con los siguientes sin
 * devolver nada, y la exportación se trababa para siempre en el fotograma 8. Acá la cola se mira cada 5 ms y, si no
 * avanza en 300 ms, se vacía con flush() (sigue codificando después); si ni así responde, la exportación falla con
 * un error en vez de quedarse esperando.
 */
class PatientVideoEncoder extends CustomVideoEncoder {
  static supports(codec: string) { return (codec === 'avc' || codec === 'hevc') && typeof VideoEncoder !== 'undefined' }
  private enc!: VideoEncoder
  init() {
    this.enc = new VideoEncoder({ output: (chunk, meta) => { packets++; this.onPacket(EncodedPacket.fromEncodedChunk(chunk), meta) }, error: (e) => this.onError(e) })
    this.enc.configure(this.config)
  }
  async encode(sample: VideoSample, options: VideoEncoderEncodeOptions) {
    const f = sample.toVideoFrame()
    try { this.enc.encode(f, options) } finally { f.close() }
    let last = this.enc.encodeQueueSize, since = performance.now()
    while (this.enc.encodeQueueSize >= 4) {
      await new Promise((r) => setTimeout(r, 5))
      if (this.enc.encodeQueueSize < last) { last = this.enc.encodeQueueSize; since = performance.now() }
      else if (performance.now() - since > 300) { stalls++; await this.flush(); since = performance.now() }
    }
  }
  flush() {
    return Promise.race([this.enc.flush(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('El codificador de video del iPhone dejó de responder.')), 15000))])
  }
  close() { if (this.enc.state !== 'closed') this.enc.close() }
}
registerEncoder(PatientVideoEncoder)

type Job = {
  out: string; width: number; height: number; fps: number
  ready: Promise<void>; output?: Output; video?: VideoSampleSource; audio?: AudioSampleSource
  frames: number; done?: (size: number) => void; written: number; error?: unknown; cancelled: boolean; fs: WebFS
  /** AVFoundation (la app) en vez de WebCodecs; withAudio: el MP4 lleva pista de audio. */
  native?: boolean; withAudio?: boolean
}
let job: Job | null = null

export async function codecCaps() {
  const v = (c: 'avc' | 'hevc') => canEncodeVideo(c, { width: 1920, height: 1080, bitrate: 8e6 }).catch(() => false)
  const [avc, hevc, aac] = await Promise.all([v('avc'), v('hevc'), canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000, bitrate: 192e3 }).catch(() => false)])
  return { avc, hevc, aac, encoders: [{ name: 'WebCodecs (VideoToolbox)', type: 'video/avc', hardware: true }, ...(hevc ? [{ name: 'WebCodecs (VideoToolbox)', type: 'video/hevc', hardware: true }] : [])] }
}

/** enc.start (sincrónico en el puente): prepara el MP4; lo que tarda (abrir el archivo) queda en `ready`. */
export function start(fs: WebFS, a: { out: string; width: number; height: number; fps: number; bitrate: number; keyframeSec?: number; codec: 'avc' | 'hevc'; audio?: { sampleRate: number; channels: number; bitrate: number } }) {
  if (job && !job.cancelled) throw new Error('Ya hay una exportación en curso')
  const j: Job = { out: a.out, width: a.width, height: a.height, fps: a.fps, frames: 0, written: 0, cancelled: false, ready: Promise.resolve(), fs }
  stalls = 0; packets = 0; webcodecsError = ''
  if (avf || isNative()) {
    Object.assign(j, { native: true, withAudio: !!a.audio })
    j.ready = nativeCall('venc.start', a)
    j.ready.catch((e) => { j.error = e })
    job = j
    return { codec: a.codec === 'hevc' ? 'HEVC' : 'H.264', profile: '', native: true }
  }
  j.ready = (async () => {
    const { writable, done } = await fs.openWritable(a.out)
    j.done = done
    done(0) // en el índice desde ya: si se cancela, se borra
    // El archivo crece por partes (posición + datos) directo en OPFS.
    const counting = new WritableStream({
      write: async (chunk: any) => { await writable.write(chunk); j.written = Math.max(j.written, chunk.position + chunk.data.byteLength) },
      close: () => writable.close(), abort: (r) => writable.abort(r),
    })
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(counting, { chunked: true, chunkSize: 4 * 1024 * 1024 }) })
    const video = new VideoSampleSource({ codec: a.codec, bitrate: a.bitrate, keyFrameInterval: a.keyframeSec || 2, sizeChangeBehavior: 'contain' })
    output.addVideoTrack(video, { frameRate: a.fps })
    let audio: AudioSampleSource | undefined
    if (a.audio) { audio = new AudioSampleSource({ codec: 'aac', bitrate: a.audio.bitrate }); output.addAudioTrack(audio) }
    await output.start()
    Object.assign(j, { output, video, audio })
  })()
  j.ready.catch((e) => { j.error = e })
  job = j
  return { codec: a.codec === 'hevc' ? 'HEVC' : 'H.264', profile: '' }
}

/** Un fotograma: una ImageBitmap del compositor (camino directo) o un JPEG en base64 (el de Android). */
export async function frame(a: { bitmap?: ImageBitmap; data?: string }) {
  const j = job
  if (!j) throw new Error('No hay una exportación en curso')
  if (j.native) {
    await j.ready
    if (j.cancelled) throw new Error('cancelado')
    await nativeCall('venc.frame', { data: a.data })
    j.frames++
    return true
  }
  try {
    await j.ready
    if (j.cancelled) throw new Error('cancelado')
    const img = a.bitmap || await createImageBitmap(new Blob([Uint8Array.from(atob(a.data!), (c) => c.charCodeAt(0))], { type: 'image/jpeg' }))
    const sample = new VideoSample(img, { timestamp: j.frames / j.fps, duration: 1 / j.fps })
    try { await j.video!.add(sample) } finally { sample.close(); img.close() }
  } catch (e: any) {
    if (!j.cancelled) webcodecsError ||= String(e?.message || e)
    throw e
  }
  j.frames++
  return true
}
/** Los que ya están en el video (con la captura de iOS los cuenta AVFoundation: no pasan por acá). */
export const frames = async () => (job?.native ? nativeCall<number>('venc.frames') : job?.frames ?? 0)

/**
 * enc.mix: mezcla el audio de [start, end] en ventanas de 30 s (volumen y fundidos de cada clip, remuestreado a
 * sampleRate) y lo manda al codificador AAC a medida que sale. Memoria fija sin importar lo que dure el video.
 */
export async function mix(fs: WebFS, a: { start: number; end: number; sampleRate: number; parts: Array<{ path: string; start: number; duration: number; in: number; volume: number; fadeIn: number; fadeOut: number }> }, ev: (e: any) => void) {
  const j = job
  if (!j) throw new Error('No hay una exportación en curso')
  await j.ready
  if (j.native ? !j.withAudio : !j.audio) return { parts: 0, failed: [] }
  const t0 = performance.now()
  const WIN = 30, failed = new Set<string>()
  const total = Math.ceil((a.end - a.start) / WIN)
  for (let w = 0, at = a.start; at < a.end - 1e-6; w++, at += WIN) {
    if (j.cancelled) throw new Error('cancelado')
    const len = Math.min(WIN, a.end - at)
    const buf = await mixWindow(fs, a.parts, at, len, a.sampleRate, failed)
    const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L
    if (j.native) {
      // A AVFoundation en tramos de 10 s (el puente lleva texto: base64), cada uno con sus dos canales seguidos.
      for (let o = 0; o < buf.length; o += a.sampleRate * 10) {
        const n = Math.min(a.sampleRate * 10, buf.length - o), part = new Float32Array(n * 2)
        part.set(L.subarray(o, o + n), 0)
        part.set(R.subarray(o, o + n), n)
        await nativeCall('venc.audio', { data: b64encode(new Uint8Array(part.buffer)) })
      }
    } else {
      const planar = new Float32Array(buf.length * 2)
      planar.set(L, 0)
      planar.set(R, buf.length)
      const sample = new AudioSample({ data: planar, format: 'f32-planar', numberOfChannels: 2, sampleRate: a.sampleRate, timestamp: at - a.start })
      try { await j.audio!.add(sample) } finally { sample.close() }
    }
    ev({ event: 'progress', done: w + 1, total })
  }
  return { parts: a.parts.length, failed: [...failed], encodeMs: performance.now() - t0 }
}

export async function finish(_fs: WebFS) {
  const j = job
  if (!j) throw new Error('No hay una exportación en curso')
  await j.ready
  if (j.error) throw j.error
  if (j.native) {
    const r = await nativeCall<{ size: number; frames: number; duration: number }>('venc.finish')
    j.fs.noteFile(j.out, r.size)
    job = null
    return { path: j.out, size: r.size, frames: r.frames, duration: r.duration, native: true }
  }
  try {
    await j.output!.finalize()
    // Un codificador trabado puede "terminar" sin devolver los últimos: el video quedaría corto.
    if (packets < j.frames) throw new Error(`El codificador de video devolvió ${packets} de ${j.frames} fotogramas.`)
  } catch (e: any) {
    webcodecsError ||= String(e?.message || e)
    throw e
  }
  j.done?.(j.written)
  job = null
  return { path: j.out, size: j.written, frames: j.frames, duration: j.frames / j.fps, stalls }
}

/**
 * enc.fallback: después de un error, ¿se puede repetir con AVFoundation? Sólo en la app y si lo que falló fue
 * WebCodecs; desde ahí las exportaciones van por AVFoundation. Devuelve por qué falló (o false).
 */
export function fallback(): string | false {
  if (!isNative() || avf || !webcodecsError) return false
  avf = true
  return webcodecsError
}

export function cancel() {
  const j = job
  if (!j) return
  j.cancelled = true
  job = null
  if (j.native) { void nativeCall('venc.cancel').catch(() => {}); return }
  j.ready.then(() => j.output?.cancel()).catch(() => {}).finally(() => j.fs.delete(j.out))
}
