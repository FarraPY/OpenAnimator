/**
 * Datos de los medios sin FFmpeg (Android): duración con los elementos <audio>/<video>, audio
 * decodificado en Java (MediaCodec, por tramos: un video largo no entra en la memoria del WebView)
 * y miniaturas de video con <canvas>. Cacheados en data/cache.
 */
import { host } from '../host'
import { base64ToBytes, canvasBase64, fs, hash, join } from './fsx'

export const PEAKS_PER_SEC = 100
const CACHE = 'cache'

const inflight = new Map<string, Promise<any>>()
function once<T>(k: string, fn: () => Promise<T>): Promise<T> {
  if (!inflight.has(k)) inflight.set(k, fn().finally(() => inflight.delete(k)))
  return inflight.get(k)!
}
function keyOf(rel: string) {
  const st = fs.stat(rel)
  if (!st) throw new Error('No existe el archivo: ' + rel)
  return hash(`${rel}|${st.size}|${Math.round(st.mtime)}`)
}

const isVideo = (p: string) => /\.(mp4|webm|mov|mkv|m4v)$/i.test(p)
const isImage = (p: string) => /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(p)

/** Duración y tamaño de un audio/video (lo que en la PC da ffprobe). */
export function probe(rel: string): Promise<{ duration: number; video: { codec: string; width: number; height: number } | null; audio: { codec: string } | null }> {
  if (isImage(rel)) return Promise.resolve({ duration: 0, video: null, audio: null })
  return new Promise((resolve) => {
    const v = isVideo(rel)
    const el = document.createElement(v ? 'video' : 'audio') as HTMLVideoElement
    el.preload = 'metadata'
    el.muted = true
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      let d = ok ? el.duration : 0
      if (!isFinite(d)) d = 0
      const out = { duration: d, video: v && ok && el.videoWidth ? { codec: '', width: el.videoWidth, height: el.videoHeight } : null, audio: ok ? { codec: '' } : null }
      el.removeAttribute('src'); el.load()
      resolve(out)
    }
    const timer = setTimeout(() => finish(false), 20000)
    el.onloadedmetadata = () => {
      // Algunos archivos (MP3 VBR, WebM) informan Infinity hasta que se busca el final.
      if (!isFinite(el.duration)) { el.currentTime = 1e7; el.ontimeupdate = () => { el.ontimeupdate = null; finish(true) } } else finish(true)
    }
    el.onerror = () => finish(false)
    el.src = fs.url(rel)
  })
}

/** Duración de un audio en segundos (0 si no se puede leer). */
export async function probeDuration(rel: string) { return (await probe(rel)).duration }

let seq = 0

/** Cabecera WAV (PCM 16 bits) para un bloque de muestras intercaladas. */
function wavHeader(bytes: number, rate: number, channels: number) {
  const h = new DataView(new ArrayBuffer(44))
  const wr = (o: number, s: string) => { for (let i = 0; i < s.length; i++) h.setUint8(o + i, s.charCodeAt(i)) }
  wr(0, 'RIFF'); h.setUint32(4, 36 + bytes, true); wr(8, 'WAVE'); wr(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true)
  h.setUint16(22, channels, true); h.setUint32(24, rate, true); h.setUint32(28, rate * channels * 2, true); h.setUint16(32, channels * 2, true)
  h.setUint16(34, 16, true); wr(36, 'data'); h.setUint32(40, bytes, true)
  return h.buffer
}

/**
 * Un tramo del audio de un archivo (o de la pista de audio de un video): Java lo decodifica a PCM y
 * Web Audio lo pasa a `sampleRate` (con su remuestreo de calidad). null si el tramo cae después del
 * final; falla si el archivo no tiene audio o la tablet no lo puede leer.
 */
export async function decodeRange(rel: string, start: number, duration: number, sampleRate: number): Promise<AudioBuffer | null> {
  const out = join(CACHE, 'pcm', `${Date.now().toString(36)}-${++seq}.pcm`)
  try {
    const r = await host().callAsync<{ sampleRate: number; channels: number; frames: number }>('audio.decode', { path: rel, start, duration, out })
    if (!r.frames || !r.channels) return null
    const pcm = await fs.readBytes(out)
    const wav = await new Blob([wavHeader(pcm.byteLength, r.sampleRate, r.channels), pcm]).arrayBuffer()
    return await new OfflineAudioContext(1, 1, sampleRate).decodeAudioData(wav)
  } finally {
    if (fs.exists(out)) fs.delete(out)
  }
}

/** Picos de amplitud (Uint8 en base64) a PEAKS_PER_SEC por segundo, para la forma de onda del timeline. */
export function audioPeaks(rel: string): Promise<{ rate: number; data: string }> {
  const k = keyOf(rel)
  const out = join(CACHE, 'peaks', `${k}.b64`)
  if (fs.exists(out)) return Promise.resolve({ rate: PEAKS_PER_SEC, data: fs.readText(out) })
  return once(out, async () => {
    let r: { rate: number; data: string }
    try { r = await host().callAsync('audio.peaks', { path: rel, perSec: PEAKS_PER_SEC }) } catch { throw new Error('No se pudo leer el audio') }
    fs.writeText(out, r.data)
    return r
  })
}

/** Miniatura JPG de un video (fotograma a ~1 s), como data URL. */
export function videoThumb(rel: string): Promise<string> {
  const k = keyOf(rel)
  const out = join(CACHE, 'thumbs', `${k}.jpg`)
  if (fs.exists(out)) return Promise.resolve(`${fs.url(out)}`)
  return once(out, () => new Promise<string>((resolve, reject) => {
    const v = document.createElement('video')
    v.muted = true; v.preload = 'auto'; v.playsInline = true
    const timer = setTimeout(() => fail(), 20000)
    const fail = () => { clearTimeout(timer); v.removeAttribute('src'); v.load(); reject(new Error('sin miniatura')) }
    v.onloadeddata = () => { v.currentTime = Math.min(1, (v.duration || 1) * 0.1) }
    v.onseeked = async () => {
      try {
        const w = 320, h = Math.max(2, Math.round((w * (v.videoHeight || 180)) / (v.videoWidth || 320)))
        const c = document.createElement('canvas'); c.width = w; c.height = h
        c.getContext('2d')!.drawImage(v, 0, 0, w, h)
        await fs.writeBytes(out, base64ToBytes(canvasBase64(c, 'image/jpeg', 0.8).data))
        clearTimeout(timer)
        v.removeAttribute('src'); v.load()
        resolve(fs.url(out))
      } catch { fail() }
    }
    v.onerror = fail
    v.src = fs.url(rel)
  }))
}

/** Tamaño de cada caché (bytes), medido en Java en segundo plano: recorrer las carpetas no frena la interfaz. */
export async function cacheStats() {
  const perProject = fs.list('projects').filter((e) => e.dir).map((e) => fs.duAsync(join('projects', e.name, '.oa-cache')))
  const [frames, peaks, thumbs, ...caches] = await Promise.all([fs.duAsync(join(CACHE, 'frames')), fs.duAsync(join(CACHE, 'peaks')), fs.duAsync(join(CACHE, 'thumbs')), ...perProject])
  return { export: caches.reduce((n, x) => n + x, frames), peaks, thumbs }
}

export async function clearCache(kind: 'export' | 'peaks' | 'thumbs') {
  if (kind === 'export') {
    for (const e of fs.list('projects')) if (e.dir && fs.exists(join('projects', e.name, '.oa-cache'))) await fs.deleteAsync(join('projects', e.name, '.oa-cache'))
    if (fs.exists(join(CACHE, 'frames'))) await fs.deleteAsync(join(CACHE, 'frames'))
  } else if (fs.exists(join(CACHE, kind))) await fs.deleteAsync(join(CACHE, kind))
  return await cacheStats()
}

