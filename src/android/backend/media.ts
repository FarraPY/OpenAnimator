/**
 * Datos de los medios sin FFmpeg (Android): duración con los elementos <audio>/<video>,
 * formas de onda con Web Audio y miniaturas de video con <canvas>. Cacheados en data/cache.
 */
import { fs, hash, join } from './fsx'

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

/** Decodifica un audio (o la pista de audio de un video) a la frecuencia pedida. */
export async function decodeAudio(rel: string, sampleRate = 48000): Promise<AudioBuffer> {
  const data = await fs.readBytes(rel)
  const ctx = new OfflineAudioContext(2, 1, sampleRate)
  return ctx.decodeAudioData(data)
}

/** Picos de amplitud (Uint8 en base64) a PEAKS_PER_SEC por segundo, para la forma de onda del timeline. */
export function audioPeaks(rel: string): Promise<{ rate: number; data: string }> {
  const k = keyOf(rel)
  const out = join(CACHE, 'peaks', `${k}.b64`)
  if (fs.exists(out)) return Promise.resolve({ rate: PEAKS_PER_SEC, data: fs.readText(out) })
  return once(out, async () => {
    const sr = 8000, win = sr / PEAKS_PER_SEC
    let buf: AudioBuffer
    try { buf = await decodeAudio(rel, sr) } catch { throw new Error('No se pudo leer el audio') }
    const n = Math.ceil(buf.length / win)
    const peaks = new Uint8Array(n)
    const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c))
    for (let i = 0; i < n; i++) {
      let max = 0
      const a = i * win, b = Math.min(buf.length, a + win)
      for (const ch of chans) for (let j = a; j < b; j++) { const v = Math.abs(ch[j]); if (v > max) max = v }
      // Escala con raíz para que las partes suaves (voz baja, música de fondo) se vean.
      peaks[i] = Math.min(255, Math.round(Math.sqrt(Math.min(1, max)) * 255))
    }
    let bin = ''
    for (let i = 0; i < peaks.length; i += 0x8000) bin += String.fromCharCode.apply(null, Array.from(peaks.subarray(i, i + 0x8000)))
    const b64 = btoa(bin)
    fs.writeText(out, b64)
    return { rate: PEAKS_PER_SEC, data: b64 }
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
        const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.8))
        if (!blob) throw new Error('sin miniatura')
        await fs.writeBytes(out, blob)
        clearTimeout(timer)
        v.removeAttribute('src'); v.load()
        resolve(fs.url(out))
      } catch { fail() }
    }
    v.onerror = fail
    v.src = fs.url(rel)
  }))
}

/** Tamaño de cada caché (bytes). */
export function cacheStats() {
  let exportCache = 0
  for (const e of fs.list('projects')) if (e.dir) exportCache += fs.du(join('projects', e.name, '.oa-cache'))
  return { export: exportCache + fs.du(join(CACHE, 'frames')), peaks: fs.du(join(CACHE, 'peaks')), thumbs: fs.du(join(CACHE, 'thumbs')) }
}

export async function clearCache(kind: 'export' | 'peaks' | 'thumbs') {
  if (kind === 'export') {
    for (const e of fs.list('projects')) if (e.dir && fs.exists(join('projects', e.name, '.oa-cache'))) await fs.deleteAsync(join('projects', e.name, '.oa-cache'))
    if (fs.exists(join(CACHE, 'frames'))) await fs.deleteAsync(join(CACHE, 'frames'))
  } else if (fs.exists(join(CACHE, kind))) await fs.deleteAsync(join(CACHE, kind))
  return cacheStats()
}

