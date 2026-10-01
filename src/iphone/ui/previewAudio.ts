/**
 * El sonido de la vista previa en el iPhone. Safari no deja sonar un <audio> que no arrancó con un toque (el
 * compositor es un iframe y le llega el pedido después) y no respeta su volumen: acá suena con Web Audio, en la
 * página. El contexto se activa con el toque de ▶ (unlock) y después puede sonar cualquier cosa. Cada clip lleva su
 * volumen y sus fundidos; se decodifica de a tramos de 8 s por delante del cursor (Mediabunny lee el archivo por
 * partes): una música larga o el audio de un video pesado nunca se cargan enteros.
 */
import { ALL_FORMATS, AudioSampleSink, Input } from 'mediabunny'
import type { Timeline } from '../../api'
import { host } from '../../android/host'
import { audioParts, type Part } from '../../android/backend/exporter'
import type { WebHost } from '../host/webhost'
import { mediaSource } from '../host/audio'

const CHUNK = 8 // segundos por tramo
const AHEAD = 3 // el tramo siguiente se prepara con esta anticipación

type Source = { sink: AudioSampleSink; sr: number; ch: number } | null
const sources = new Map<string, Promise<Source>>()
function open(file: string): Promise<Source> {
  let s = sources.get(file)
  if (!s) {
    s = (async () => {
      const input = new Input({ source: await mediaSource((host() as WebHost).fs, file), formats: ALL_FORMATS })
      const track = await input.getPrimaryAudioTrack()
      if (!track || !(await track.canDecode())) return null
      return { sink: new AudioSampleSink(track), sr: track.sampleRate, ch: track.numberOfChannels }
    })().catch(() => null)
    sources.set(file, s)
  }
  return s
}

/** [from, to) segundos del archivo como AudioBuffer. */
async function decode(ctx: BaseAudioContext, file: string, from: number, to: number) {
  const src = await open(file)
  if (!src || to - from < 0.01) return null
  const frames = Math.round((to - from) * src.sr)
  const buf = ctx.createBuffer(src.ch, frames, src.sr)
  const tmp: Array<Float32Array<ArrayBuffer>> = []
  for await (const s of src.sink.samples(from, to)) {
    try {
      const at = Math.round((s.timestamp - from) * src.sr)
      for (let c = 0; c < src.ch; c++) {
        if (!tmp[c] || tmp[c].length < s.numberOfFrames) tmp[c] = new Float32Array(s.numberOfFrames)
        s.copyTo(tmp[c], { planeIndex: c, format: 'f32-planar' })
        const a = Math.max(0, -at), b = Math.min(s.numberOfFrames, frames - at)
        if (b > a) buf.copyToChannel(tmp[c].subarray(a, b), c, at + a)
      }
    } finally { s.close() }
  }
  return buf
}

/** Volumen de un clip en el instante x del timeline (volumen × fundidos lineales, como en la exportación). */
function gainAt(p: Part, x: number) {
  const c = p.clip, lt = x - c.start
  let g = p.vol
  if (c.fadeIn && lt < c.fadeIn) g *= Math.max(0, lt / c.fadeIn)
  if (c.fadeOut && c.duration - lt < c.fadeOut) g *= Math.max(0, (c.duration - lt) / c.fadeOut)
  return g
}

export class PreviewAudio {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private muted = false
  /** Silenciar la vista previa (sin cortar la reproducción). */
  setMuted(m: boolean) { this.muted = m; if (this.master) this.master.gain.value = m ? 0 : 1 }
  private nodes = new Set<AudioBufferSourceNode>()
  private gen = 0
  private timer = 0

  /** Hay que llamarlo dentro del toque: Safari sólo activa el audio así. */
  unlock() {
    try {
      // Que suene aunque el iPhone esté en silencio (la app además pone la categoría «playback»: AppDelegate).
      const nav = navigator as any
      if (nav.audioSession && nav.audioSession.type !== 'playback') nav.audioSession.type = 'playback'
      if (!this.ctx || this.ctx.state === 'closed') {
        this.ctx = new AudioContext()
        this.master = null
        const ctx = this.ctx
        ctx.onstatechange = () => { if (ctx.state !== 'running' && ctx.state !== 'closed') console.warn(`Audio de la vista previa: ${ctx.state}`) }
      }
      if (this.ctx.state !== 'running') void this.ctx.resume()
    } catch (e) { console.warn('Sin audio en la vista previa:', e) } // sin Web Audio: se ve igual, sin sonido
  }

  /** Empieza a sonar desde t (segundos del timeline) a la velocidad rate. */
  play(projectId: string, tl: Timeline, t: number, rate: number) {
    this.stop()
    const ctx = this.ctx
    if (!ctx) return
    if (ctx.state !== 'running') void ctx.resume().catch(() => {}) // iOS lo pausa con una interrupción
    const gen = ++this.gen
    const parts = audioParts(projectId, tl, t, tl.duration)
    if (!parts.length) return
    const t0 = ctx.currentTime + 0.1 // el instante t del timeline suena en t0 del contexto
    const when = (x: number) => t0 + (x - t) / rate
    let next = t
    const pump = async () => {
      this.timer = 0
      while (gen === this.gen && next < tl.duration && when(next) - ctx.currentTime < AHEAD) {
        const from = next, to = Math.min(tl.duration, next + CHUNK)
        next = to
        await Promise.all(parts.filter((p) => p.clip.start < to && p.clip.start + p.clip.duration > from).map(async (p) => {
          const c = p.clip
          const a = Math.max(from, c.start), b = Math.min(to, c.start + c.duration)
          const buf = await decode(ctx, p.file, (c.in || 0) + a - c.start, (c.in || 0) + b - c.start).catch(() => null)
          if (!buf || gen !== this.gen) return
          const node = ctx.createBufferSource()
          node.buffer = buf
          node.playbackRate.value = rate
          const g = ctx.createGain()
          // Volumen y fundidos: rampas entre los puntos donde cambian dentro del tramo.
          const pts = [a, c.start + (c.fadeIn || 0), c.start + c.duration - (c.fadeOut || 0), b].filter((x) => x >= a && x <= b).sort((x, y) => x - y)
          g.gain.setValueAtTime(gainAt(p, a), Math.max(ctx.currentTime, when(a)))
          for (const x of pts.slice(1)) if (when(x) > ctx.currentTime) g.gain.linearRampToValueAtTime(gainAt(p, x), when(x))
          if (!this.master) { this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : 1; this.master.connect(ctx.destination) }
          node.connect(g).connect(this.master)
          // Si el tramo llegó tarde (decodificar tardó), arranca por donde va.
          const late = Math.max(0, ctx.currentTime - when(a))
          if (late * rate >= buf.duration) return
          node.start(when(a) + late, late * rate)
          this.nodes.add(node)
          node.onended = () => this.nodes.delete(node)
        }))
      }
      if (gen === this.gen && next < tl.duration) this.timer = window.setTimeout(pump, 400)
    }
    void pump()
  }

  stop() {
    this.gen++
    window.clearTimeout(this.timer)
    for (const n of this.nodes) { try { n.stop() } catch { /* ya terminó */ } }
    this.nodes.clear()
  }

  /** Otro proyecto o archivos que cambiaron: se vuelven a abrir. */
  forget() { sources.clear() }

  close() { this.stop(); void this.ctx?.close(); this.ctx = null; this.master = null }
}
