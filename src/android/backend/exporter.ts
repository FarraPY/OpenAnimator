/**
 * Exportación en Android: el mismo compositor que la vista previa dibuja cada fotograma a la
 * resolución de salida (las escenas son vectoriales: 4K nítido), y el codificador de hardware de la
 * tablet (MediaCodec, ver Encoder.java) lo convierte en H.264/HEVC + AAC dentro de un MP4.
 *
 *  1. Mezcla del audio del timeline en Java (AudioMix.java, por ventanas de 30 s: decodifica sólo el
 *     tramo de cada archivo que suena), directo al codificador.
 *  2. Fotograma a fotograma, con el primer método que ande en el equipo (Capture.java):
 *     - captura GPU: el compositor abre en una pantalla virtual cuyas imágenes van a una textura del
 *       codificador (nunca pasan por la memoria); Java pide los próximos fotogramas por adelantado.
 *     - captura directa: un WebView del tamaño del video, escondido detrás de la app, se dibuja en un
 *       bitmap que va derecho al codificador.
 *     - compatible: el compositor oculto redibuja el DOM (modern-screenshot, ~10 veces más lento) → JPEG.
 *     Si uno falla a mitad de camino se sigue con el siguiente, desde el primer fotograma que todavía no
 *     está en el video (lo sabe el codificador).
 *  3. El archivo queda en exports/ (o @sd/exports/ si el proyecto está en la tarjeta SD) y, si está activado, se copia a la galería.
 */
import type { Clip, Timeline } from '../../api'
import { autoBitrate, type ExportQuality } from '../bitrate'
import { host } from '../host'
import { compositorUrl } from '../../platform'
import { Renderer } from './frames'
import { basename, fs, join, normalizeRel, uniqueName } from './fsx'
import { exportsDir, listMaybe, projectDir, readProject, readTimeline } from './projects'
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
  /** Al terminar: por qué no se usó la captura GPU (si no anduvo en el equipo). */
  note?: string
  /** Al terminar (o al fallar): tiempos y métodos, en texto para copiar y mandar. */
  details?: string
}

/** Lo que se mide de una exportación (ver details). */
type Diag = {
  marks: Record<string, number>
  why: Partial<Record<Method, string>>
  used: Method[]
  video?: string; fps?: number
  cap?: {
    mode?: string; frames?: number; msPerFrame?: number; lost?: number; ahead?: number; page?: { n: number; ms: number; max: number }
    framesAt?: number[]; dropsAt?: number[]; screenHz?: number; displayHz?: number; view?: string
    encoder?: {
      images?: number; msPerImage?: number; msMax?: number; encodeMsMax?: number; writesPendingMax?: number
      texMs?: number; markMs?: number; drawMs?: number; swapMs?: number; swapMsMax?: number; drainMs?: number
      ring?: boolean; es3?: boolean; ringError?: string; copyMs?: number; waits?: number; waitMs?: number; ringMax?: number; gaps?: number[]
      lostBusy?: number; lostIdle?: number; imageMs?: number; copyParts?: number[]
      reorder?: boolean; slots?: number; storedMax?: number; evicted?: number; noSlot?: number
      matched?: number; busy?: number; old?: number; newer?: number; idle?: number; queueMs?: number; queueMsMax?: number
    }
    timeline?: Record<string, number[]>; timelineN?: number; frameIntervalMs?: number; sample?: number[][]; timelineError?: string
    stateStart?: DeviceState; stateEnd?: DeviceState
  }
  calls?: { n: number; ms: number; max: number; gap: number; gapMax: number; first?: number }
  compat?: { n: number; ms: number }
  encoderStalls?: number
  /** encodeMs: el codificador AAC mientras llegaba la mezcla; closeMs: al cerrarlo, antes del primer fotograma. */
  audio?: { parts: number; failed: string[]; encodeMs?: number; closeMs?: number }
}
type DeviceState = { thermal?: number; powerSave?: boolean; availMB?: number; lowMemory?: boolean; screenHz?: number }
const THERMAL = ['normal', 'leve', 'moderada', 'alta', 'crítica', 'emergencia', 'apagado']
const secs = (ms?: number) => (ms == null ? '—' : `${(ms / 1000).toFixed(1).replace('.', ',')} s`)
const msf = (ms?: number) => (ms == null || !isFinite(ms) ? '—' : `${Math.round(ms)} ms`)

class Cancelled extends Error {}
type Method = 'gpu' | 'draw' | 'compat'
const LABEL: Record<Method, string> = { gpu: 'captura GPU', draw: 'captura directa', compat: 'captura compatible' }
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
const IMG = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i
const SR = 48000

export type Part = { file: string; clip: Clip; vol: number }

/**
 * Los audios que suenan en [t0, t1] (pistas de audio y el sonido de los videos). Si un archivo no se
 * puede leer (o un video no tiene audio), la mezcla lo saltea y sigue con los demás.
 */
export function audioParts(projectId: string, tl: Timeline, t0: number, t1: number): Part[] {
  const root = projectDir(projectId)!
  const solo = tl.tracks.some((t) => t.type === 'audio' && t.solo)
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
      if (fs.exists(file)) parts.push({ file, clip: c, vol })
    }
  }
  return parts
}

/**
 * La mezcla la hace Java (AudioMix.java) y va directo al codificador: decodifica cada clip, lo lleva a
 * 48 kHz y le aplica volumen y fundidos (lineales, como afade en la PC). Antes se hacía acá y cada tramo
 * iba y volvía por el puente: ~30 s para un minuto de video en la tablet. El codificador la pasa a AAC a
 * medida que llega, y todo eso corre en paralelo con la captura de los fotogramas.
 */
async function mixAudio(parts: Part[], t0: number, t1: number, onProgress: (p: number) => void) {
  const r = await host().callAsync<{ parts: number; failed: string[]; encodeMs?: number }>('enc.mix', {
    start: t0, end: t1, sampleRate: SR,
    parts: parts.map((p) => ({ path: p.file, start: p.clip.start, duration: p.clip.duration, in: p.clip.in || 0, volume: p.vol, fadeIn: p.clip.fadeIn || 0, fadeOut: p.clip.fadeOut || 0 })),
  }, { onEvent: (e: any) => { if (e?.event === 'progress' && e.total) onProgress(Math.min(1, e.done / e.total)) } })
  for (const f of r?.failed || []) console.warn('No se pudo leer el audio', f)
  return r
}

/** Vista previa chica del fotograma que se está exportando (base64 JPEG), para el diálogo. */
function previewJpeg(b: ImageBitmap) {
  const c = document.createElement('canvas')
  c.width = 320
  c.height = Math.max(1, Math.round(320 * b.height / b.width))
  c.getContext('2d')!.drawImage(b, 0, 0, c.width, c.height)
  const u = c.toDataURL('image/jpeg', 0.7)
  return u.slice(u.indexOf(',') + 1)
}

function safeName(s: string) {
  return s.replace(/[\\/:*?"<>|\n\r\t]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video'
}

class Export {
  private cancelled = false
  /** Terminó (bien o mal): una captura que se estaba abriendo en paralelo ya no sigue probando métodos. */
  private over = false
  private opening: Promise<unknown> | null = null
  private renderer: Renderer | null = null
  private t0 = performance.now()
  private diag: Diag = { marks: {}, why: {}, used: [] }

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
    document.documentElement.classList.add('exporting') // las animaciones de la app, en pausa (tablet.css)
    let started = false
    try {
      const r = await this.inner(() => { started = true })
      const details = this.details()
      saveDetails(details)
      this.emit({ phase: 'listo', message: r.gallery ? `Guardado en la galería (${r.gallery})` : 'Exportación terminada', done: 1, total: 1, file: r.file, gallery: r.gallery, size: r.size, encoder: r.encoder, fps: r.fps, note: r.note, details })
    } catch (e: any) {
      if (started) try { host().call('enc.cancel') } catch { /* ignore */ }
      if (e instanceof Cancelled || this.cancelled) this.emit({ phase: 'cancelado', message: 'Exportación cancelada.', done: 0, total: 1 })
      else {
        const details = this.details(String(e?.message || e))
        saveDetails(details)
        this.emit({ phase: 'error', message: String(e?.message || e), done: 0, total: 1, details })
      }
    } finally {
      this.over = true
      // La captura se abre mientras se mezcla el audio: si eso falló o se canceló, se espera a que termine
      // de abrirse para cerrarla (si no, quedaría una página del compositor abierta detrás de la app).
      await this.opening?.catch(() => {})
      this.renderer?.destroy()
      this.renderer = null
      try { host().call('cap.close') } catch { /* ignore */ }
      document.documentElement.classList.remove('exporting')
      release()
    }
  }

  /** Tiempos, métodos y motivos, en texto: para ver dónde se va el tiempo en un equipo que no está acá. */
  private details(error?: string) {
    const d = this.diag, m = d.marks, lines: string[] = []
    try {
      const a = host().call<Record<string, any>>('app.info')
      lines.push(`OpenAnimator ${a.versionName} (${a.versionCode}) · ${a.manufacturer || ''} ${a.model || ''} · Android ${a.release || '?'} · ${a.webview || 'WebView ?'}`.replace(/\s+/g, ' '))
    } catch { /* ignore */ }
    if (d.video) lines.push(`Video: ${d.video}`)
    if (d.used.length) lines.push(`Captura: ${d.used.map((x) => LABEL[x]).join(' → ')}${d.fps ? ` · ${d.fps.toFixed(1).replace('.', ',')} fps` : ''}`)
    lines.push(`Tiempos: preparar ${secs(m.preparar)} · abrir la captura ${secs(m.abrir)} (se esperó ${secs(m.espera)}) · fotogramas ${secs(m.fotogramas)} · audio en paralelo ${secs(m.audio)}${m.esperaAudio != null && m.esperaAudio >= 50 ? ` (al final se esperó ${secs(m.esperaAudio)})` : ''} · terminar ${secs(m.terminar)}`)
    const c = d.cap, pg = c?.page
    // Reordenando, lo que se ajusta es cuántos pedidos van en camino a la vez; en orden, cuántos por adelantado.
    const inFlight = !!c?.encoder?.reorder
    if (c) lines.push(`Por fotograma (${c.frames}): ${msf(c.msPerFrame)}; el JavaScript de la página lo prepara en ${pg && pg.n ? `${msf(pg.ms / pg.n)} (máx ${msf(pg.max)})` : '—'}${c.mode === 'gpu' ? ` · perdidos ${c.lost ?? 0} · ${inFlight ? 'en camino a la vez' : 'por adelantado'} ${c.ahead ?? '—'}` : ''}`)
    if (c?.mode === 'gpu') {
      const hz = (x?: number) => (x ? `${Math.round(x)} Hz` : '—')
      lines.push(`Pantalla: ${hz(c.screenHz)} · pantalla virtual ${hz(c.displayHz)}`)
      if (c.framesAt) lines.push(`${inFlight ? 'En camino a la vez' : 'Por adelantado'} (fotogramas/perdidos): ${c.framesAt.map((n, i) => [i, n, c.dropsAt?.[i] ?? 0]).filter(([, n, l]) => n || l).map(([i, n, l]) => `${i}: ${n}/${l}`).join(' · ') || '—'}`)
      const e = c.encoder
      if (e && e.images) {
        lines.push(`Hilo de la GPU: ${e.images} imágenes, ${msf(e.msPerImage)} cada una (máx ${msf(e.msMax)}) · codificar máx ${msf(e.encodeMsMax)} · escrituras pendientes máx ${e.writesPendingMax ?? 0}`)
        const ms1 = (x?: number) => (x == null ? '—' : `${x.toFixed(1).replace('.', ',')} ms`)
        const parts = e.copyParts && e.copyParts.length === 4 ? ` (la imagen ${ms1(e.copyParts[0])} · su marca ${ms1(e.copyParts[1])} · leerla ${ms1(e.copyParts[2])} · fence ${ms1(e.copyParts[3])})` : ''
        if (e.texMs != null) lines.push(`  por imagen: tomarla ${ms1(e.texMs)}${e.copyMs ? ` · copiarla al anillo ${ms1(e.copyMs)}${parts}` : ''} · leer su marca ${ms1(e.markMs)}; por fotograma: dibujarlo ${ms1(e.drawMs)} · entregarlo al codificador ${ms1(e.swapMs)} (máx ${ms1(e.swapMsMax)}) · sacar lo codificado ${ms1(e.drainMs)}`)
        if (e.ring != null || e.ringError) {
          const keep = e.reorder ? ` · reordenar: sí, ${e.slots ?? 0} lugares (hasta ${e.storedMax ?? 0} imágenes guardadas esperando una anterior${e.evicted ? `; ${e.evicted} descartadas por falta de lugar` : ''}${e.noSlot ? `; ${e.noSlot} sin copiar` : ''})` : ''
          const how = e.ring ? `sí · hasta ${e.ringMax ?? 0} imágenes esperando a la GPU · hubo que esperarla ${e.waits ?? 0} veces${e.waits ? ` (${ms1(e.waitMs)})` : ''}${keep}`
            : e.ringError ? `se apagó (${e.ringError})` : e.es3 === false ? 'no (sin OpenGL ES 3)' : 'no'
          lines.push(`Anillo (tomar cada imagen sin esperar a la GPU): ${how}`)
        }
        if ((e.lostBusy ?? 0) + (e.lostIdle ?? 0) > 0) {
          // Por qué se perdió cada fotograma: el hilo que toma las imágenes estaba ocupado (la esperada se reemplazó
          // mientras esperaba) o estaba libre (la pantalla virtual nunca la mostró).
          const g = e.gaps ?? []
          lines.push(`Pérdidas${e.imageMs ? ` (una imagen cada ${ms1(e.imageMs)} como mucho)` : ''}: con el hilo de la GPU ocupado (se reemplazó) ${e.lostBusy ?? 0} · con el hilo libre (la pantalla no la mostró) ${e.lostIdle ?? 0} · la que llegó en su lugar, a cuánto de la anterior buena: hasta 10 ms ${g[0] ?? 0} · hasta 18 ms ${g[1] ?? 0} · hasta 26 ms ${g[2] ?? 0} · más ${g[3] ?? 0}`)
        }
        lines.push(`Imágenes: la esperada ${e.matched ?? '—'} · la página cambiando ${e.busy ?? '—'} · viejas ${e.old ?? '—'} · posteriores (pérdida) ${e.newer ?? '—'} · sin pedido ${e.idle ?? '—'} · esperaron para tomarse ${msf(e.queueMs)} (máx ${msf(e.queueMsMax)})`)
      }
      if (c.view || c.frameIntervalMs) lines.push(`Página de captura: vista ${c.view || '—'} · un cuadro cada ${c.frameIntervalMs ? `${c.frameIntervalMs.toFixed(1).replace('.', ',')} ms` : '—'}`)
      const tl = c.timeline
      if (tl && c.timelineN) {
        const f = (k: string) => (tl[k] ? tl[k].map((x) => String(Math.round(x))).join('/') : '—')
        lines.push(`Línea de tiempo por fotograma (mediana/p90/máx en ms, ${c.timelineN} fotogramas):`)
        lines.push(`  hasta la página ${f('toPage')} · en la cola de la página ${f('queue')} · JavaScript ${f('js')} · hasta entregarlo para dibujar ${f('commit')}`)
        lines.push(`  motor web + pantalla virtual hasta el codificador ${f('display')} · codificar ${f('encode')} · total ${f('total')}`)
        lines.push(`  un fotograma codificado cada ${f('cadence')}`)
      }
      if (c.sample?.length) {
        lines.push('Muestra (nivel por adelantado: ms desde el pedido hasta que la página empieza / lo tiene listo / lo entrega / llega la imagen / queda codificado):')
        for (const r of c.sample) lines.push(`  ${r[0]}: ${r.slice(1).map((x) => String(x).replace('.', ',')).join(' / ')}`)
      }
      if (c.timelineError) lines.push(`Sin línea de tiempo: ${c.timelineError}`)
    }
    const st = (x?: DeviceState) => (x ? `temperatura ${x.thermal != null ? THERMAL[x.thermal] || x.thermal : '—'} · ahorro de energía ${x.powerSave ? 'sí' : 'no'} · memoria libre ${x.availMB ?? '—'} MB${x.lowMemory ? ' (poca)' : ''} · pantalla ${x.screenHz ? Math.round(x.screenHz) : '—'} Hz` : '—')
    if (c?.stateStart || c?.stateEnd) lines.push(`Equipo al empezar: ${st(c.stateStart)}; al terminar: ${st(c.stateEnd)}`)
    if (d.calls && d.calls.n) lines.push(`Desde la interfaz: ${d.calls.n} llamadas, ${msf(d.calls.ms / d.calls.n)} cada una (máx ${msf(d.calls.max)}; la primera ${msf(d.calls.first)}) · entre llamadas ${msf(d.calls.gap / d.calls.n)} (máx ${msf(d.calls.gapMax)})`)
    if (d.compat && d.compat.n) lines.push(`Método compatible: ${msf(d.compat.ms / d.compat.n)} por fotograma (${d.compat.n})`)
    if (d.encoderStalls) lines.push(`El codificador de video se trabó ${d.encoderStalls} veces (se vació y siguió)`)
    if (d.audio) {
      const aac = d.audio.encodeMs != null ? ` · codificar a AAC ${secs(d.audio.encodeMs)} (dentro de la mezcla) + ${msf(d.audio.closeMs)} al cerrar` : ''
      lines.push(`Audio: ${d.audio.parts} clip${d.audio.parts === 1 ? '' : 's'}${aac}${d.audio.failed.length ? ` · no se pudieron leer: ${d.audio.failed.join('; ')}` : ''}`)
    }
    for (const [k, v] of Object.entries(d.why)) lines.push(`Sin ${LABEL[k as Method]}: ${v}`)
    if (error) lines.push(`Error: ${error}`)
    return lines.join('\n')
  }

  /** El compositor oculto que redibuja el DOM (cuando la captura directa no anda en el equipo). */
  private async compatible(projectId: string, tlId: string, width: number, height: number) {
    if (this.renderer) return
    this.renderer = new Renderer(projectId, tlId, width, height)
    await this.renderer.ready
  }

  private async inner(markStarted: () => void) {
    const job = this.job, d = this.diag, T = performance.now()
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
    if (codec === 'hevc' && !caps.hevc) throw new Error(`${host().kind === 'web' ? 'Este equipo' : 'Esta tablet'} no tiene codificador HEVC: elegí H.264.`)
    const bitrate = job.bitrate && job.bitrate > 0 ? Math.round(job.bitrate * 1000) : autoBitrate(W, H, fps, job.quality, codec)

    // Nombre del archivo final
    const ex = exportsDir(job.projectId) // del lado del proyecto: tablet o tarjeta SD
    fs.mkdir(ex)
    const tlName = p.timelines.length > 1 ? ` - ${p.timelines.find((t) => t.id === tlId)?.name || tlId}` : ''
    const out = join(ex, uniqueName(ex, `${safeName(job.name || p.name + tlName)}.mp4`))

    // Audio: primero se ve qué suena y se puede leer, para saber si el MP4 lleva pista de audio
    const parts = job.audio ? audioParts(job.projectId, tl, start, end) : []
    this.check()

    const info = host().call<{ codec: string; profile: string; operatingRate?: number; maxFps?: number }>('enc.start', {
      out, width: W, height: H, fps, bitrate, keyframeSec: 2, codec,
      audio: parts.length ? { sampleRate: SR, channels: 2, bitrate: Math.max(64, Math.min(320, job.audioBitrate || 192)) * 1000 } : undefined,
    })
    markStarted()
    const speed = info.operatingRate ? ` · trabajando a ${info.operatingRate} fps` : info.maxFps ? ' · sin aviso de velocidad' : ''
    d.video = `${W}×${H} · ${fps} fps · ${frames} fotogramas · ${info.codec}${info.profile ? ` ${info.profile}` : ''}${speed}${info.maxFps ? ` (admite hasta ${Math.round(info.maxFps)} fps)` : ''}`
    d.marks.preparar = performance.now() - T

    // La captura (ver arriba) se abre mientras se mezcla el audio: la de GPU dibuja en el codificador,
    // así que va después de enc.start.
    const capUrl = compositorUrl(job.projectId, { p: job.projectId, tl: tlId, mode: 'export', capture: '1' })
    let method: Method = 'compat'
    const why = d.why // por qué no anduvo cada método (se muestra al terminar)
    const openCapture = async (modes: Array<'gpu' | 'draw'>) => {
      for (const m of modes) {
        if (this.cancelled || this.over) break
        try { await host().callAsync('cap.start', { url: capUrl, width: W, height: H, mode: m }); return m } catch (e: any) { why[m] = String(e?.message || e); console.warn(`Sin ${LABEL[m]} en este equipo:`, e) }
      }
      return 'compat' as const
    }
    const tOpen = performance.now()
    // El iPhone no tiene las capturas de Android (Capture.java): va directo al compositor (con ImageBitmap).
    const opening = this.opening = openCapture(host().kind === 'web' ? [] : ['gpu', 'draw']).then((m) => { method = m; d.marks.abrir = performance.now() - tOpen })

    // El audio se mezcla (en Java, en otro núcleo) mientras se capturan los fotogramas: el MP4 espera su formato
    // en el hilo que escribe, nunca la captura. Si falla, la exportación se corta enseguida.
    let mixing: Promise<void> | null = null
    let mixError: unknown = null
    if (parts.length) {
      const tA = performance.now()
      mixing = mixAudio(parts, start, end, () => {}).then(
        (r) => { d.marks.audio = performance.now() - tA; d.audio = { parts: r?.parts ?? parts.length, failed: r?.failed || [], encodeMs: r?.encodeMs } },
        (e) => { mixError = e },
      )
    }
    const tWait = performance.now()
    await opening
    this.check()
    if (method === 'compat') await this.compatible(job.projectId, tlId, p.width, p.height)
    d.marks.espera = performance.now() - tWait
    this.check()
    const used = new Set<Method>([method])

    // Video
    const quality = job.quality === 'max' ? 0.95 : job.quality === 'low' ? 0.86 : 0.92
    // iPhone: el compositor entrega una ImageBitmap y va directo al codificador (sin JPEG en el medio).
    const bitmaps = host().kind === 'web'
    const tr0 = performance.now()
    let inflight: Promise<unknown> | null = null
    let lastEmit = 0, lastPreview = 0, rate = 0, lastCall = 0
    this.emit({ phase: 'render', message: `Fotograma 1 de ${frames} · ${LABEL[method]}`, done: 0, total: frames })
    for (let i = 0; i < frames; i++) {
      this.check()
      if (mixError) throw mixError
      const t = start + i / fps
      let shot: string | undefined
      if (method !== 'compat') {
        try {
          // Con la GPU, los que siguen se piden ya (la página los prepara mientras éste se codifica).
          const next = method === 'gpu' ? Array.from({ length: 12 }, (_, k) => i + 1 + k).filter((k) => k < frames).map((k) => start + k / fps) : undefined
          const c0 = performance.now()
          const calls = d.calls || (d.calls = { n: 0, ms: 0, max: 0, gap: 0, gapMax: 0 })
          if (lastCall) { const g = c0 - lastCall; calls.gap += g; if (g > calls.gapMax) calls.gapMax = g }
          const r = await host().callAsync<{ preview?: string }>('cap.frame', { t, next, preview: performance.now() - lastPreview > 1200 })
          lastCall = performance.now()
          if (!calls.n) calls.first = lastCall - c0
          calls.n++; calls.ms += lastCall - c0; if (lastCall - c0 > calls.max) calls.max = lastCall - c0
          shot = r?.preview
        } catch (e: any) {
          this.check()
          // No anduvo en este equipo (o dejó de andar): se sigue con el método siguiente, desde el primer
          // fotograma que todavía no está en el video.
          console.warn(`La ${LABEL[method]} falló en el fotograma`, i, e)
          why[method] = `falló en el fotograma ${i + 1}: ${String(e?.message || e)}`
          try { host().call('cap.close') } catch { /* ignore */ }
          this.emit({ phase: 'render', message: 'Cambiando de método de captura…', done: i, total: frames })
          method = method === 'gpu' ? await openCapture(['draw']) : 'compat'
          this.check()
          if (method === 'compat') await this.compatible(job.projectId, tlId, p.width, p.height)
          used.add(method)
          i = (await host().callAsync<number>('enc.frames')) - 1
          continue
        }
      } else if (bitmaps) {
        const tf = performance.now()
        const bmp = await this.renderer!.bitmap(t, W, H)
        d.compat = { n: (d.compat?.n || 0) + 1, ms: (d.compat?.ms || 0) + performance.now() - tf }
        this.check()
        if (performance.now() - lastPreview > 1200) shot = previewJpeg(bmp)
        if (inflight) await inflight
        inflight = host().callAsync('enc.frame', { bitmap: bmp })
        inflight.catch(() => {})
      } else {
        const tf = performance.now()
        const f = await this.renderer!.frame(t, W, H, 'jpeg', quality)
        d.compat = { n: (d.compat?.n || 0) + 1, ms: (d.compat?.ms || 0) + performance.now() - tf }
        this.check()
        if (inflight) await inflight
        inflight = host().callAsync('enc.frame', { data: f.data })
        inflight.catch(() => {})
        shot = f.data
      }
      this.check()
      const now = performance.now()
      if (now - lastEmit > 250 || i === frames - 1) {
        lastEmit = now
        rate = (i + 1) / Math.max(0.001, (now - tr0) / 1000)
        // Cada tanto, el fotograma que se está codificando (vista previa del diálogo).
        const preview = shot && now - lastPreview > 1200 ? `data:image/jpeg;base64,${shot}` : undefined
        if (preview) lastPreview = now
        this.emit({ phase: 'render', message: `Fotograma ${i + 1} de ${frames} · ${LABEL[method]}`, done: i + 1, total: frames, fps: rate, eta: (frames - i - 1) / Math.max(0.01, rate), preview })
      }
    }
    if (inflight) await inflight
    d.marks.fotogramas = performance.now() - tr0
    d.used = [...used]
    d.fps = rate
    if (mixing) {
      const tM = performance.now()
      if (!d.marks.audio) this.emit({ phase: 'render', message: 'Terminando el audio…', done: frames, total: frames, fps: rate })
      await mixing
      if (mixError) throw mixError
      d.marks.esperaAudio = performance.now() - tM
      this.check()
    }
    const tEnd = performance.now()
    // Los últimos fotogramas capturados terminan de codificarse y se cierra la vista de captura.
    if (method !== 'compat') d.cap = await host().callAsync('cap.stop')
    this.check()
    const encoder = `${info.codec}${info.profile ? ` · ${info.profile}` : ''} · ${[...used].map((m) => LABEL[m]).join(' + ')}`

    this.emit({ phase: 'final', message: 'Escribiendo el archivo…', done: 1, total: 1 })
    const res = await host().callAsync<{ path: string; size: number; frames: number; duration: number; audioCloseMs?: number; stalls?: number }>('enc.finish')
    if (d.audio && res?.audioCloseMs != null) d.audio.closeMs = res.audioCloseMs
    if (res?.stalls) d.encoderStalls = res.stalls // iPhone: veces que el codificador se trabó y se vació
    this.renderer?.destroy()
    this.renderer = null

    let gallery: string | undefined
    // En el iPhone guardar en Fotos es la hoja de Compartir, que sólo se abre con un toque: lo ofrece el diálogo.
    if (host().kind !== 'web' && getSettings().android?.saveToGallery !== false) {
      try { gallery = (await host().callAsync<{ folder: string }>('gallery.save', { path: out, name: basename(out), mime: 'video/mp4' })).folder } catch (e) { console.warn('No se pudo copiar a la galería', e) }
    }
    d.marks.terminar = performance.now() - tEnd
    const note = why.gpu ? `La captura GPU no anduvo en este equipo (${why.gpu.slice(0, 300)}).` : undefined
    return { file: out, gallery, size: res?.size || fs.stat(out)?.size || 0, encoder, fps: rate, note }
  }
}

const jobs = new Map<string, Export>()

/** El informe de la última exportación queda guardado (se ve también desde el diálogo de exportar). */
const DETAILS_FILE = 'logs/ultima-exportacion.txt'
function saveDetails(text: string) {
  try { fs.mkdir('logs'); fs.writeText(DETAILS_FILE, `${new Date().toLocaleString('es')}\n${text}\n`) } catch (e) { console.warn('No se pudo guardar el informe', e) }
}
export function lastExportDetails() { return fs.exists(DETAILS_FILE) ? fs.readText(DETAILS_FILE) : '' }

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
export const exporting = () => jobs.size > 0

/** Exportaciones guardadas en la app (tablet y tarjeta SD), para la lista de la pantalla de exportar. */
export function listExports() {
  return ['exports', '@sd/exports'].flatMap((dir) => listMaybe(dir)
    .filter((e) => !e.dir && /\.mp4$/i.test(e.name) && !e.name.startsWith('.'))
    .map((e) => ({ path: join(dir, e.name), name: e.name, size: e.size, mtime: e.mtime, ...(dir === 'exports' ? {} : { sd: true }) })))
    .sort((a, b) => b.mtime - a.mtime)
}
