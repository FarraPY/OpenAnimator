/**
 * Codificador de la exportación (enc.* del puente, como Encoder.java en Android): WebCodecs (codificador de hardware
 * del iPhone) + Mediabunny para armar el MP4. El archivo se escribe en OPFS a medida que se codifica (nunca entero en
 * memoria). El audio se mezcla en ventanas de 30 s (audio.ts) mientras se capturan los fotogramas.
 */
import { AudioSample, AudioSampleSource, Mp4OutputFormat, Output, StreamTarget, VideoSample, VideoSampleSource, canEncodeAudio, canEncodeVideo } from 'mediabunny'
import type { WebFS } from './webfs'
import { mixWindow } from './audio'

type Job = {
  out: string; width: number; height: number; fps: number
  ready: Promise<void>; output?: Output; video?: VideoSampleSource; audio?: AudioSampleSource
  frames: number; done?: (size: number) => void; written: number; error?: unknown; cancelled: boolean; fs: WebFS
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
  await j.ready
  if (j.cancelled) throw new Error('cancelado')
  const img = a.bitmap || await createImageBitmap(new Blob([Uint8Array.from(atob(a.data!), (c) => c.charCodeAt(0))], { type: 'image/jpeg' }))
  const sample = new VideoSample(img, { timestamp: j.frames / j.fps, duration: 1 / j.fps })
  try { await j.video!.add(sample) } finally { sample.close(); img.close() }
  j.frames++
  return true
}
export const frames = async () => job?.frames ?? 0

/**
 * enc.mix: mezcla el audio de [start, end] en ventanas de 30 s (volumen y fundidos de cada clip, remuestreado a
 * sampleRate) y lo manda al codificador AAC a medida que sale. Memoria fija sin importar lo que dure el video.
 */
export async function mix(fs: WebFS, a: { start: number; end: number; sampleRate: number; parts: Array<{ path: string; start: number; duration: number; in: number; volume: number; fadeIn: number; fadeOut: number }> }, ev: (e: any) => void) {
  const j = job
  if (!j) throw new Error('No hay una exportación en curso')
  await j.ready
  if (!j.audio) return { parts: 0, failed: [] }
  const t0 = performance.now()
  const WIN = 30, failed = new Set<string>()
  const total = Math.ceil((a.end - a.start) / WIN)
  for (let w = 0, at = a.start; at < a.end - 1e-6; w++, at += WIN) {
    if (j.cancelled) throw new Error('cancelado')
    const len = Math.min(WIN, a.end - at)
    const buf = await mixWindow(fs, a.parts, at, len, a.sampleRate, failed)
    const planar = new Float32Array(buf.length * 2)
    planar.set(buf.getChannelData(0), 0)
    planar.set(buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0), buf.length)
    const sample = new AudioSample({ data: planar, format: 'f32-planar', numberOfChannels: 2, sampleRate: a.sampleRate, timestamp: at - a.start })
    try { await j.audio.add(sample) } finally { sample.close() }
    ev({ event: 'progress', done: w + 1, total })
  }
  return { parts: a.parts.length, failed: [...failed], encodeMs: performance.now() - t0 }
}

export async function finish(_fs: WebFS) {
  const j = job
  if (!j) throw new Error('No hay una exportación en curso')
  await j.ready
  if (j.error) throw j.error
  await j.output!.finalize()
  j.done?.(j.written)
  job = null
  return { path: j.out, size: j.written, frames: j.frames, duration: j.frames / j.fps }
}

export function cancel() {
  const j = job
  if (!j) return
  j.cancelled = true
  job = null
  j.ready.then(() => j.output?.cancel()).catch(() => {}).finally(() => j.fs.delete(j.out))
}
