/**
 * Exportación en Android: el mismo compositor que la vista previa dibuja cada fotograma a la
 * resolución de salida (las escenas son vectoriales: 4K nítido), y el codificador de hardware de la
 * tablet (MediaCodec, ver Encoder.java) lo convierte en H.264/HEVC + AAC dentro de un MP4.
 *
 *  1. Mezcla del audio del timeline con Web Audio (por ventanas de 30 s; Java decodifica sólo el
 *     tramo de cada archivo que suena en la ventana) → PCM → Java.
 *  2. Fotograma a fotograma: compositor → JPEG → Java decodifica, dibuja en la superficie del
 *     codificador y lo muxea. Mientras Java codifica uno, acá ya se dibuja el siguiente.
 *  3. El archivo queda en data/exports/ y, si está activado, se copia a la galería.
 */
import type { Clip, Timeline } from '../../api'
import { autoBitrate, type ExportQuality } from '../bitrate'
import { host } from '../host'
import { Renderer } from './frames'
import { decodeRange } from './media'
import { basename, blobToBase64, fs, join, normalizeRel, uniqueName } from './fsx'
import { projectDir, readProject, readTimeline } from './projects'
import { getSettings } from './settings'
import { holdAwake } from './wake'

export type AndroidExportJob = {
  projectId: string
  timeline: string
  range?: { start: number; end: number } | null
  width: number
  height: number
  fps: number
  codec: 'avc' | 'hevc'
  quality: ExportQuality
  /** kbps; 0 = automático según la calidad. */
  bitrate?: number
  audio: boolean
  /** kbps */
  audioBitrate: number
  /** Nombre del archivo (sin extensión). */
  name?: string
}
export type AndroidExportProgress = {
  id: string
  phase: 'preparando' | 'audio' | 'render' | 'final' | 'listo' | 'error' | 'cancelado'
  message: string; done: number; total: number; fps?: number; eta?: number; elapsed?: number
  file?: string; gallery?: string; size?: number; encoder?: string; preview?: string
}

class Cancelled extends Error {}
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
const IMG = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i
const SR = 48000


function fadeGain(c: Clip, lt: number) {
  let g = 1
  if (c.fadeIn && lt < c.fadeIn) g = Math.min(g, Math.max(0, lt / c.fadeIn))
  if (c.fadeOut && lt > c.duration - c.fadeOut) g = Math.min(g, Math.max(0, (c.duration - lt) / c.fadeOut))
  return g
}

type Part = { file: string; clip: Clip; vol: number }

/** Los audios que suenan en [t0, t1] (pistas de audio y el sonido de los videos) y se pueden leer. */
async function audioParts(projectId: string, tl: Timeline, t0: number, t1: number): Promise<Part[]> {
  const root = projectDir(projectId)!
  const solo = tl.tracks.some((t) => t.type === 'audio' && t.solo)
  const readable = new Map<string, Promise<boolean>>()
  const parts: Part[] = []
  for (const tr of tl.tracks) {
    if (tr.type !== 'audio' && tr.type !== 'video') continue
    if (tr.muted || (solo && !tr.solo && tr.type === 'audio')) continue
    for (const c of tr.clips) {
      if (c.muted || IMG.test(c.src)) continue
      const a = Math.max(c.start, t0), b = Math.min(c.start + c.duration, t1)
      if (b - a < 0.001) continue
      const vol = (c.volume ?? 1) * (tr.volume ?? 1)
      if (vol <= 0) continue
      let file: string
      try { file = join(root, normalizeRel(c.src)) } catch { continue }
      if (!fs.exists(file)) continue
      // Un video sin pista de audio (o un formato que la tablet no lee) simplemente no suma nada.
      if (!readable.has(file)) readable.set(file, decodeRange(file, 0, 0.1, SR).then(() => true, () => false))
      if (await readable.get(file)) parts.push({ file, clip: c, vol })
    }
  }
  return parts
}

/** PCM 16 bits estéreo intercalado (lo que espera el codificador AAC). */
function pcm16(buf: AudioBuffer) {
  const n = buf.length
  const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L
  const out = new Int16Array(n * 2)
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, L[i])), r = Math.max(-1, Math.min(1, R[i]))
    out[i * 2] = l < 0 ? l * 0x8000 : l * 0x7fff
    out[i * 2 + 1] = r < 0 ? r * 0x8000 : r * 0x7fff
  }
  return out
}

/** Mezcla por ventanas de 30 s (poca memoria aunque el video sea largo) y la manda a Java. */
async function mixAudio(parts: Part[], t0: number, t1: number, check: () => void, onProgress: (p: number) => void) {
  const total = Math.max(1, Math.round((t1 - t0) * SR))
  const WIN = SR * 30
  for (let w0 = 0; w0 < total; w0 += WIN) {
    check()
    const n = Math.min(WIN, total - w0)
    const ctx = new OfflineAudioContext(2, n, SR)
    const ws = t0 + w0 / SR, we = ws + n / SR
    for (const p of parts) {
      const c = p.clip
      const a = Math.max(c.start, ws), b = Math.min(c.start + c.duration, we)
      if (b - a < 0.0005) continue
      const la = a - c.start, lb = b - c.start
      let buf: AudioBuffer | null = null
      try { buf = await decodeRange(p.file, (c.in || 0) + la, b - a, SR) } catch (e) { console.warn('No se pudo leer el audio', p.file, e) }
      check()
      if (!buf) continue
      const src = ctx.createBufferSource()
      src.buffer = buf
      const g = ctx.createGain()
      const fading = (c.fadeIn && la < c.fadeIn) || (c.fadeOut && lb > c.duration - c.fadeOut)
      if (fading) {
        // Curva de volumen cada 10 ms (fundidos lineales, como afade de FFmpeg en la PC).
        const steps = Math.max(2, Math.ceil((lb - la) * 100) + 1)
        const curve = new Float32Array(steps)
        for (let i = 0; i < steps; i++) curve[i] = p.vol * fadeGain(c, la + ((lb - la) * i) / (steps - 1))
        g.gain.setValueCurveAtTime(curve, a - ws, b - a)
      } else g.gain.value = p.vol
      src.connect(g).connect(ctx.destination)
      src.start(a - ws, 0, b - a)
    }
    const mixed = await ctx.startRendering()
    const bytes = new Uint8Array(pcm16(mixed).buffer)
    const CHUNK = 3 * 512 * 1024
    for (let off = 0; off < bytes.length; off += CHUNK) {
      check()
      host().call('enc.audio', { data: await blobToBase64(new Blob([bytes.subarray(off, off + CHUNK)])) })
    }
    onProgress(Math.min(1, (w0 + n) / total))
  }
}

function safeName(s: string) {
  return s.replace(/[\\/:*?"<>|\n\r\t]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video'
}

class Export {
  private cancelled = false
  private renderer: Renderer | null = null
  private t0 = performance.now()

  constructor(readonly id: string, private job: AndroidExportJob, private onProgress: (p: AndroidExportProgress) => void) {}

  cancel() {
    this.cancelled = true
    try { host().call('enc.cancel') } catch { /* ignore */ }
    this.renderer?.destroy()
  }
  private check() { if (this.cancelled) throw new Cancelled('cancelado') }
  private emit(p: Omit<AndroidExportProgress, 'id' | 'elapsed'>) {
    this.onProgress({ id: this.id, elapsed: (performance.now() - this.t0) / 1000, ...p })
  }

  async run() {
    const release = holdAwake()
    let started = false
    try {
      const r = await this.inner(() => { started = true })
      this.emit({ phase: 'listo', message: r.gallery ? `Guardado en la galería (${r.gallery})` : 'Exportación terminada', done: 1, total: 1, file: r.file, gallery: r.gallery, size: r.size, encoder: r.encoder })
    } catch (e: any) {
      if (started) try { host().call('enc.cancel') } catch { /* ignore */ }
      if (e instanceof Cancelled || this.cancelled) this.emit({ phase: 'cancelado', message: 'Exportación cancelada.', done: 0, total: 1 })
      else this.emit({ phase: 'error', message: String(e?.message || e), done: 0, total: 1 })
    } finally {
      this.renderer?.destroy()
      this.renderer = null
      release()
    }
  }

  private async inner(markStarted: () => void) {
    const job = this.job
    this.emit({ phase: 'preparando', message: 'Preparando…', done: 0, total: 1 })
    const p = readProject(job.projectId)
    const tlId = job.timeline || p.activeTimeline
    const tl = readTimeline(job.projectId, tlId)
    const fps = Math.max(1, Math.min(120, job.fps || p.fps || 30))
    const start = job.range ? Math.max(0, Math.min(tl.duration, job.range.start)) : 0
    const end = job.range ? Math.max(start, Math.min(tl.duration, job.range.end)) : tl.duration
    if (end - start < 1 / fps) throw new Error('No hay nada para exportar: el timeline (o el rango elegido) está vacío.')
    const frames = Math.max(1, Math.round((end - start) * fps))
    const W = even(job.width || p.width), H = even(job.height || p.height)
    const codec = job.codec === 'hevc' ? 'hevc' : 'avc'
    const caps = host().call<{ avc: boolean; hevc: boolean; aac: boolean }>('codec.caps')
    if (codec === 'hevc' && !caps.hevc) throw new Error('Esta tablet no tiene codificador HEVC: elegí H.264.')
    const bitrate = job.bitrate && job.bitrate > 0 ? Math.round(job.bitrate * 1000) : autoBitrate(W, H, fps, job.quality, codec)

    // Nombre del archivo final
    fs.mkdir('exports')
    const tlName = p.timelines.length > 1 ? ` - ${p.timelines.find((t) => t.id === tlId)?.name || tlId}` : ''
    const out = join('exports', uniqueName('exports', `${safeName(job.name || p.name + tlName)}.mp4`))

    // Compositor dedicado (no el de la vista previa)
    this.renderer = new Renderer(job.projectId, tlId, p.width, p.height)
    const ready = this.renderer.ready
    this.check()

    // Audio: primero se ve qué suena y se puede leer, para saber si el MP4 lleva pista de audio
    const parts = job.audio ? await audioParts(job.projectId, tl, start, end) : []
    this.check()
    await ready
    this.check()

    const info = host().call<{ codec: string; profile: string }>('enc.start', {
      out, width: W, height: H, fps, bitrate, keyframeSec: 2, codec,
      audio: parts.length ? { sampleRate: SR, channels: 2, bitrate: Math.max(64, Math.min(320, job.audioBitrate || 192)) * 1000 } : undefined,
    })
    markStarted()
    const encoder = `${info.codec}${info.profile ? ` · ${info.profile}` : ''}`

    if (parts.length) {
      this.emit({ phase: 'audio', message: 'Mezclando el audio…', done: 0, total: 1 })
      await mixAudio(parts, start, end, () => this.check(), (x) => this.emit({ phase: 'audio', message: 'Mezclando el audio…', done: x, total: 1 }))
    }

    // Video
    const quality = job.quality === 'max' ? 0.95 : job.quality === 'low' ? 0.86 : 0.92
    const tr0 = performance.now()
    let inflight: Promise<unknown> | null = null
    let lastEmit = 0, lastPreview = 0
    for (let i = 0; i < frames; i++) {
      this.check()
      const t = start + i / fps
      const f = await this.renderer.frame(t, W, H, 'jpeg', quality)
      this.check()
      if (inflight) await inflight
      inflight = host().callAsync('enc.frame', { data: f.data })
      inflight.catch(() => {})
      const now = performance.now()
      if (now - lastEmit > 250 || i === frames - 1) {
        lastEmit = now
        const rate = (i + 1) / Math.max(0.001, (now - tr0) / 1000)
        // Cada tanto, el fotograma que se está codificando (vista previa del diálogo).
        const preview = now - lastPreview > 1200 ? `data:image/jpeg;base64,${f.data}` : undefined
        if (preview) lastPreview = now
        this.emit({ phase: 'render', message: `Fotograma ${i + 1} de ${frames}`, done: i + 1, total: frames, fps: rate, eta: (frames - i - 1) / Math.max(0.01, rate), preview })
      }
    }
    if (inflight) await inflight
    this.check()

    this.emit({ phase: 'final', message: 'Escribiendo el archivo…', done: 1, total: 1 })
    const res = await host().callAsync<{ path: string; size: number; frames: number; duration: number }>('enc.finish')
    this.renderer.destroy()
    this.renderer = null

    let gallery: string | undefined
    if (getSettings().android?.saveToGallery !== false) {
      try { gallery = (await host().callAsync<{ folder: string }>('gallery.save', { path: out, name: basename(out), mime: 'video/mp4' })).folder } catch (e) { console.warn('No se pudo copiar a la galería', e) }
    }
    return { file: out, gallery, size: res?.size || fs.stat(out)?.size || 0, encoder }
  }
}

const jobs = new Map<string, Export>()

/** Empieza una exportación y devuelve su id; el progreso llega por onProgress (export:progress). */
export async function startExport(job: AndroidExportJob, onProgress: (p: AndroidExportProgress) => void) {
  if (jobs.size) throw new Error('Ya hay una exportación en curso: esperá a que termine o cancelala.')
  const id = `exp-${Date.now().toString(36)}`
  const ex = new Export(id, job, onProgress)
  jobs.set(id, ex)
  ex.run().finally(() => jobs.delete(id))
  return id
}

export function cancelExport(id: string) { jobs.get(id)?.cancel() }

/** Exportaciones guardadas en data/exports (para la lista de la pantalla de exportar). */
export function listExports() {
  return fs.list('exports').filter((e) => !e.dir && /\.mp4$/i.test(e.name) && !e.name.startsWith('.'))
    .map((e) => ({ path: join('exports', e.name), name: e.name, size: e.size, mtime: e.mtime }))
    .sort((a, b) => b.mtime - a.mtime)
}
