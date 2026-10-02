/**
 * «Crear plantilla desde un video» en el iPhone (en la PC: electron/analyzer.ts, con FFmpeg y yt-dlp). Lo mismo, paso a
 * paso y con las mismas cuentas e instrucciones (electron/analyzer-core.ts): la app mide el video con AVFoundation
 * (ios/OpenAnimator/VideoAnalysis.swift: cortes, fotogramas, hoja de contactos, tiras de movimiento, paleta, silencios
 * y sonoridad), baja los de YouTube (src/iphone/host/youtube.ts), transcribe con Whisper en el teléfono si no hay
 * subtítulos, y Claude Code (en el teléfono, runAgent) mira todo y escribe el análisis, el brief y una escena de muestra
 * en un proyecto oculto (projects/.analisis-<id>). Guardado, queda como plantilla del usuario.
 */
import { analysisPrompt, describeTool, guideFromAnalysis, isUrl, keyframeTimes, kmeansPalette, parseVtt, shotsFromScores, stripSeconds, transcriptLines, workspaceProject } from '../../../electron/analyzer-core'
import type { AnalyzeEvent, AnalyzeOpts, AnalyzeResult, AnalyzeStats, Phase } from '../../../electron/analyzer-core'
import { host } from '../host'
import { send } from './events'
import { base64ToBytes, dirname, fs, join } from './fsx'
import * as F from './frames'
import * as PL from './plugins'
import { PROJECTS, readTimeline, saveProjectAsTemplate } from './projects'
import { getSettings } from './settings'
import { runAgent } from './webclaude'

/** En la app del iPhone (en Safari y en la tablet no hay cómo medir el video). */
export const available = () => host().kind === 'web' && !!host().call<boolean>('vana.available')

const TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill', 'oa_ver_fotogramas', 'oa_hoja_contactos', 'oa_auditar_layout', 'oa_proyecto'].map((n) => 'mcp__openanimator__' + n)
const SYSTEM = 'Corrés dentro de la app OpenAnimator del iPhone. Los archivos viven en la app, NO en tu disco: usá SIEMPRE mcp__openanimator__Read, Write, Edit, Glob y Grep con rutas relativas a la carpeta de trabajo (p. ej. _analisis/datos.json, scenes/estilo.html) y mcp__openanimator__Skill para las guías. No hay terminal.'
const FONTS = "una lista que funcione en iPhone y en PC, p. ej. 'Avenir Next', 'Helvetica Neue', 'Segoe UI', system-ui, Georgia, Menlo…"

const jobs = new Map<string, Analyzer>()

class Analyzer {
  id = `an-${Date.now().toString(36)}`
  workspace = `.analisis-${this.id}`
  dir = join(PROJECTS, this.workspace)
  work = join(this.dir, '_analisis')
  private cancelled = false
  private phase: Phase = 'descarga'
  private agent: { cancel: () => void } | null = null

  constructor(private o: AnalyzeOpts & { name?: string }) {}

  private emit(e: Omit<AnalyzeEvent, 'id'>) { send('analyze:event', { id: this.id, ...e }) }
  private step(phase: Phase, status: AnalyzeEvent['status'], message?: string, progress?: number) { this.phase = phase; this.emit({ phase, status, message, progress }) }
  private log(text: string) { this.emit({ phase: this.phase, log: text }) }
  private check() { if (this.cancelled) throw new Error('Análisis cancelado') }
  /** Una medición en Swift, con su avance en la fase. */
  private vana<T = any>(op: string, args: Record<string, unknown>, phase?: Phase): Promise<T> {
    return host().callAsync<T>(op, { ...args, job: this.id }, { onEvent: (e: any) => { if (phase && typeof e?.p === 'number') this.step(phase, 'run', undefined, e.p) } })
  }

  cancel() {
    this.cancelled = true
    void host().callAsync('vana.cancel', { job: this.id }).catch(() => {})
    this.agent?.cancel()
  }
  discard() {
    this.cancel()
    F.closeFramePool(this.workspace)
    try { fs.delete(this.dir) } catch { /* ya no está */ }
  }

  async run() {
    try {
      const r = await this.pipeline()
      this.emit({ done: true, result: r })
    } catch (e: any) {
      const msg = this.cancelled ? 'Análisis cancelado' : String(e?.message || e)
      this.step(this.phase, 'error', msg)
      this.emit({ done: true, error: msg })
    }
  }

  private async pipeline(): Promise<AnalyzeResult> {
    fs.mkdir(join(this.work, 'fotogramas'))
    const src0 = this.o.source.trim()
    const url = isUrl(src0)
    let file = '', audioFile = '', title = '', subsFile = ''

    // 1 · obtener el video
    this.step('descarga', 'run', url ? 'Pidiendo el video a YouTube…' : 'Video del teléfono')
    if (url) {
      const r = await host().callAsync<any>('yt.download', { url: src0, dir: this.work, job: this.id }, {
        onEvent: (e: any) => { if (e?.phase === 'video' || e?.phase === 'audio') this.step('descarga', 'run', `Descargando ${e.phase === 'audio' ? 'el audio' : 'el video'}… ${Math.round(e.p * 100)} %`, e.p) },
      })
      file = r.video
      audioFile = r.audio || r.video
      subsFile = r.subs || ''
      title = r.title || 'Video de YouTube'
      fs.writeJSON(join(this.work, 'fuente.json'), { titulo: r.title, canal: r.channel, duracion: r.duration, url: src0, descripcion: String(r.description || '').slice(0, 1500) })
    } else {
      // El elegido (en .incoming/): pasa al espacio de trabajo, así se borra con él.
      if (!fs.exists(src0)) throw new Error('No existe el archivo: ' + src0)
      title = (this.o.name || src0.split('/').pop() || 'Video').replace(/\.[^.]+$/, '')
      file = join(this.work, 'source' + ((/\.[a-z0-9]{2,4}$/i.exec(src0)?.[0] || '.mp4').toLowerCase()))
      fs.rename(src0, file)
      if (dirname(src0).startsWith('.incoming/')) try { fs.delete(dirname(src0)) } catch { /* ignore */ }
      audioFile = file
    }
    this.check()
    this.step('descarga', 'ok', title)

    // 2 · formato
    this.step('video', 'run')
    const info = await this.vana<{ duration: number; w: number; h: number; fps: number; audio: boolean }>('vana.info', { path: file })
    const duration = info.duration, W = info.w, H = info.h, fps = Math.round(info.fps * 100) / 100 || 30
    if (!(duration > 0) || !W || !H) throw new Error('No se pudo leer el video')
    const maxSec = Math.min(duration, (this.o.maxMinutes || 20) * 60)
    const hasAudio = url ? !!audioFile : info.audio
    this.step('video', 'ok', `${W}×${H} · ${fps} fps · ${Math.floor(duration / 60)}:${String(Math.round(duration % 60)).padStart(2, '0')}${maxSec < duration ? ` (se analizan los primeros ${Math.round(maxSec / 60)} min)` : ''}`)
    const { PW, PH, project, timeline } = workspaceProject(this.workspace, title, W, H)
    fs.writeJSON(join(this.dir, 'project.json'), project)
    fs.writeJSON(join(this.dir, 'timelines', 'main.json'), timeline)
    for (const d of ['scenes', 'assets']) fs.mkdir(join(this.dir, d))

    // 3 · cortes y movimiento (y los píxeles para la paleta, en la misma pasada)
    this.check(); this.step('escenas', 'run', 'Detectando cortes…')
    const scan = await this.vana<{ scores: Array<[number, number]>; pix: string }>('vana.scan', { path: file, maxSec }, 'escenas')
    const { cuts, shots, avgShot, motion, perSec } = shotsFromScores(scan.scores, maxSec)
    this.step('escenas', 'ok', `${shots.length} planos · ${avgShot.toFixed(1)} s promedio · ${(cuts.length / (maxSec / 60)).toFixed(1)} cortes/min`)

    // 4 · fotogramas, hoja de contactos y tiras de movimiento
    this.check(); this.step('fotogramas', 'run')
    const times = keyframeTimes(shots, maxSec)
    const moving = await stripSeconds(perSec, cuts, maxSec)
    const rel = (p: string) => p.slice(this.dir.length + 1)
    const fr = await this.vana<{ frames: Array<{ file: string; t: number }>; strips: Array<{ file: string; t: number }> }>('vana.frames', {
      path: file, width: 960, cols: times.length > 20 ? 6 : 5, sheet: join(this.work, 'hoja.jpg'),
      frames: times.map((t, i) => ({ t, file: join(this.work, 'fotogramas', `f${String(i + 1).padStart(3, '0')}.jpg`) })),
      strips: moving.map((t, i) => ({ t, file: join(this.work, `mov${i + 1}.jpg`) })),
    }, 'fotogramas')
    const frames = fr.frames.map((f) => ({ file: rel(f.file), t: f.t })).sort((a, b) => a.t - b.t)
    const strips = fr.strips.map((s) => ({ file: rel(s.file), t: s.t }))
    if (!frames.length) throw new Error('No se pudo sacar ningún fotograma del video')
    this.step('fotogramas', 'ok', `${frames.length} fotogramas · ${strips.length} tiras de movimiento`)

    // 5 · paleta
    this.check(); this.step('colores', 'run')
    const palette = kmeansPalette(base64ToBytes(scan.pix))
    this.step('colores', 'ok', palette.slice(0, 6).map((p) => p.hex).join('  '))

    // 6 · audio
    this.check()
    let speechRatio: number | null = null, pauses = 0, lufs: number | null = null
    if (hasAudio) {
      this.step('audio', 'run')
      const a = await this.vana<{ audio: boolean; silent: number; pauses: number; lufs: number | null }>('vana.audio', { path: audioFile, maxSec }, 'audio')
      if (a.audio) {
        pauses = a.pauses
        lufs = a.lufs
        speechRatio = Math.max(0, Math.min(1, 1 - a.silent / maxSec))
        if (speechRatio < 0.02 || (lufs != null && lufs <= -60)) { speechRatio = 0; this.step('audio', 'ok', 'La pista de audio está en silencio') }
        else this.step('audio', 'ok', `sonido el ${Math.round(speechRatio * 100)} % del tiempo · ${pauses} pausas${lufs != null ? ` · ${lufs} LUFS` : ''}`)
      } else this.step('audio', 'skip', 'El video no tiene audio')
    } else this.step('audio', 'skip', 'El video no tiene audio')

    // 7 · narración: los subtítulos de YouTube o Whisper en el teléfono
    this.check()
    let transcript: AnalyzeStats['transcript'] = 'no'
    let wpm: number | null = null
    const tfile = join(this.work, 'transcripcion.txt')
    if (subsFile) {
      this.step('narracion', 'run', 'Leyendo subtítulos…')
      const segs = parseVtt(fs.readText(subsFile)).filter((s) => s.start < maxSec)
      fs.writeText(tfile, segs.map((s) => `[${s.start.toFixed(1)}] ${s.text}`).join('\n'))
      const words = segs.reduce((n, s) => n + s.text.split(/\s+/).length, 0)
      wpm = speechRatio ? Math.round(words / ((maxSec * speechRatio) / 60)) : Math.round(words / (maxSec / 60))
      transcript = 'subtitulos'
      this.step('narracion', 'ok', `Subtítulos: ${words} palabras · ~${wpm} palabras/min`)
      try { fs.delete(subsFile) } catch { /* ignore */ }
    } else if (hasAudio && this.o.transcribe !== false && (speechRatio ?? 0) > 0.15) {
      this.step('narracion', 'run', 'Transcribiendo la narración…')
      try {
        const span = Math.min(maxSec, 900)
        const tr = await PL.transcribe(audioFile, { maxSec: span })
        fs.writeText(tfile, transcriptLines(tr.words).join('\n') || tr.text)
        wpm = speechRatio ? Math.round(tr.words.length / ((span * speechRatio) / 60)) : null
        transcript = 'plugin'
        this.step('narracion', 'ok', `${tr.provider}: ${tr.words.length} palabras${wpm ? ` · ~${wpm} palabras/min` : ''}`)
      } catch (e: any) { this.step('narracion', 'skip', 'No se pudo transcribir: ' + (e?.message || e)) }
    } else this.step('narracion', 'skip', hasAudio ? 'Sin narración detectada' : 'Sin audio')

    const stats: AnalyzeStats = {
      duration: +duration.toFixed(2), analyzed: +maxSec.toFixed(2), width: W, height: H, fps, shots: shots.length, avgShot: +avgShot.toFixed(2),
      cutsPerMin: +(cuts.length / (maxSec / 60)).toFixed(2), motion: +motion.toFixed(4), speechRatio: speechRatio == null ? null : +speechRatio.toFixed(3),
      pauses, lufs, wpm, palette, transcript,
    }
    fs.writeJSON(join(this.work, 'datos.json'), {
      fuente: { titulo: title, url: url ? src0 : undefined, archivo: url ? undefined : this.o.name },
      ...stats, cortes: cuts.map((c) => +c.toFixed(2)), planos: shots.slice(0, 400).map((s) => [+s.start.toFixed(2), +s.end.toFixed(2)]),
      fotogramas: frames, tiras_movimiento: strips, hoja_contactos: '_analisis/hoja.jpg', transcripcion: fs.exists(tfile) ? '_analisis/transcripcion.txt' : null,
      notas_del_usuario: this.o.notes || undefined,
    })
    // Guías de referencia al alcance de Claude (dentro del espacio de trabajo).
    for (const sk of ['escenas-html', 'direccion-artistica']) {
      const r = await fetch(`app/ai/skills/${sk}/SKILL.md`, { cache: 'no-store' }).catch(() => null)
      if (r?.ok) fs.writeText(join(this.work, `guia-${sk}.md`), await r.text())
    }

    // 8 · Claude
    this.check(); this.step('ia', 'run', 'Claude está mirando el video…')
    await this.runClaude(PW, PH)
    const aFile = join(this.work, 'analisis.json')
    if (!fs.exists(aFile)) throw new Error('Claude no escribió el análisis (_analisis/analisis.json).')
    let analysis: any
    try { analysis = fs.readJSON(aFile) } catch (e: any) { throw new Error('El análisis de Claude no es JSON válido: ' + e.message) }
    const sceneOk = fs.exists(join(this.dir, 'scenes', 'estilo.html'))
    this.step('ia', 'ok', analysis.titulo || 'Análisis listo')

    // 9 · vista previa
    this.check(); this.step('vista', 'run')
    let preview: string | undefined
    if (sceneOk) {
      try {
        const tl = readTimeline(this.workspace)
        const [f] = await F.renderFrames(this.workspace, undefined, [Math.min(Math.max(1, (tl.duration || 10) * 0.45), 8)], 960, false, 'jpeg')
        await fs.writeBytes(join(this.dir, 'thumbnail.jpg'), base64ToBytes(f.data))
        preview = fs.url(join(this.dir, 'thumbnail.jpg'))
      } catch (e: any) { this.log('No se pudo generar la vista previa: ' + (e?.message || e)) }
      finally { F.closeFramePool(this.workspace) }
    }
    if (!preview) fs.copy(join(this.work, frames[0].file.replace(/^_analisis\//, '')), join(this.dir, 'thumbnail.jpg'))
    this.step('vista', sceneOk ? 'ok' : 'skip', sceneOk ? 'Escena de muestra lista' : 'Sin escena de muestra')
    return { id: this.id, workspace: this.workspace, title, source: url ? src0 : this.o.name || title, isUrl: url, stats, analysis, sheet: fs.url(join(this.work, 'hoja.jpg')), preview, sceneOk }
  }

  private async runClaude(PW: number, PH: number) {
    const s = getSettings().claude
    let reads = 0
    const job = runAgent({
      projectId: this.workspace, system: SYSTEM, tools: TOOLS,
      prompt: analysisPrompt(PW, PH, { notes: this.o.notes, measured: 'en el iPhone', fonts: FONTS }),
      model: this.o.model ?? s.model ?? undefined, effort: this.o.effort ?? s.effort ?? undefined,
      onTool: (name, input) => {
        const d = describeTool(name, input)
        if (d.image) reads++
        this.log(d.label)
        this.step('ia', 'run', d.image ? `Mirando fotogramas (${reads})…` : d.write ? `Escribiendo ${d.file}…` : d.check ? 'Verificando la escena de muestra…' : undefined)
      },
      onText: (t) => this.log(t.slice(0, 400)),
    })
    this.agent = job
    try { await job.done } finally { this.agent = null }
    this.check()
  }
}

// ── canales (index.ts) ─────────────────────────────────────────────────────────

/** El video a analizar: iOS pregunta si de Fotos o de Archivos (y lo deja en .incoming/). */
export async function pickFile() {
  const files = await host().callAsync<Array<{ path: string; name: string }>>('pick.files', { accept: ['video/*', 'public.movie'], multiple: false })
  return files?.[0] ? { path: files[0].path, name: files[0].name } : null
}

export function start(o: AnalyzeOpts & { name?: string }) {
  if (!available()) throw new Error('Analizar videos sólo se puede en la app del iPhone.')
  for (const j of jobs.values()) j.discard() // uno a la vez: es pesado
  jobs.clear()
  const a = new Analyzer(o)
  jobs.set(a.id, a)
  void a.run()
  return a.id
}
export function cancel(id: string) { jobs.get(id)?.cancel() }
export function discard(id: string) { const a = jobs.get(id); if (a) { a.discard(); jobs.delete(id) } }

export function save(id: string, o: { name: string; description?: string; tags?: string[]; analysis?: any; stats?: any; source?: string; title?: string }) {
  const a = jobs.get(id)
  if (!a) throw new Error('El análisis ya no está (¿se cerró la app?): hacelo de nuevo.')
  const analysis = { ...(o.analysis || fs.readJSON(join(a.work, 'analisis.json'))), medido: o.stats, fuente: { titulo: o.title, origen: o.source } }
  const t = saveProjectAsTemplate(a.workspace, { name: o.name, description: o.description, tags: o.tags, includeAssets: true, analysis, guide: guideFromAnalysis(o.name, analysis) })
  if (fs.exists(join(a.work, 'hoja.jpg'))) fs.copy(join(a.work, 'hoja.jpg'), join(t.dir, 'referencia.jpg'))
  discard(id)
  return { id: t.id }
}

/** Al arrancar: los espacios de trabajo que quedaron de otra vez (la app se cerró a mitad). */
export function cleanup() {
  try { for (const e of fs.list(PROJECTS)) if (e.dir && e.name.startsWith('.analisis-')) fs.delete(join(PROJECTS, e.name)) } catch { /* ignore */ }
}
