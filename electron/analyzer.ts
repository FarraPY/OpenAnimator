/**
 * Analizador de videos → plantilla.
 *
 * A partir de un archivo de video o un enlace de YouTube:
 *   1. (YouTube) descarga con yt-dlp, con subtítulos si hay
 *   2. mide el video con FFmpeg: cortes y duración de planos, movimiento, paleta de colores (k-means),
 *      silencios/voz y sonoridad
 *   3. extrae fotogramas clave, tiras de movimiento y una hoja de contactos
 *   4. (opcional) transcribe la narración con un plugin (Whisper local / ElevenLabs / OpenAI / Fish)
 *   5. Claude Code mira todo y escribe: el análisis (colores, animaciones, formas, objetos, narración…),
 *      una guía de estilo (brief.md) y una escena de muestra que replica el estilo, verificada con las
 *      herramientas de OpenAnimator
 *   6. el resultado se puede guardar como plantilla del usuario
 *
 * El espacio de trabajo es un proyecto oculto (data/projects/.analisis-<id>) para poder previsualizarlo
 * con el mismo compositor y que Claude use oa_ver_fotogramas.
 */
import { spawn, ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { nativeImage } from 'electron'
import { APP_DIR, CACHE_DIR, PROJECTS_DIR, claudePath, ffmpegPaths } from './paths'
import { getSettings } from './settings'
import { writeJSON, readJSON, saveProjectAsTemplate } from './projects'
import { claudeEnv, writeMcpConfig } from './claude'
import { pluginStatus, transcribe, ytdlpPath, Word } from './plugins'
import { renderFrames, closeFramePool } from './frames'

export type Phase = 'descarga' | 'video' | 'escenas' | 'fotogramas' | 'colores' | 'audio' | 'narracion' | 'ia' | 'vista'
export const PHASES: Array<{ id: Phase; label: string }> = [
  { id: 'descarga', label: 'Obtener el video' }, { id: 'video', label: 'Formato y duración' }, { id: 'escenas', label: 'Cortes, planos y movimiento' },
  { id: 'fotogramas', label: 'Fotogramas clave' }, { id: 'colores', label: 'Paleta de colores' }, { id: 'audio', label: 'Voz, silencios y sonoridad' },
  { id: 'narracion', label: 'Narración' }, { id: 'ia', label: 'Análisis con Claude y escena de muestra' }, { id: 'vista', label: 'Vista previa' },
]
export type AnalyzeOpts = { source: string; transcribe?: boolean; model?: string; effort?: string; maxMinutes?: number; notes?: string }
export type AnalyzeEvent = { id: string; phase?: Phase; status?: 'run' | 'ok' | 'skip' | 'error'; message?: string; progress?: number; log?: string; done?: boolean; error?: string; result?: AnalyzeResult }
export type Swatch = { hex: string; share: number }
export type AnalyzeResult = {
  id: string; workspace: string; title: string; source: string; isUrl: boolean
  stats: { duration: number; analyzed: number; width: number; height: number; fps: number; shots: number; avgShot: number; cutsPerMin: number; motion: number; speechRatio: number | null; pauses: number; lufs: number | null; wpm: number | null; palette: Swatch[]; transcript: 'subtitulos' | 'plugin' | 'no' }
  analysis: any; sheet: string; preview?: string; sceneOk: boolean
}

const isUrl = (s: string) => /^https?:\/\//i.test(s.trim())
const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('')

/** Paleta dominante por k-means (determinista) sobre píxeles muestreados. */
export function kmeansPalette(buf: Buffer, k = 9): Swatch[] {
  const n = Math.floor(buf.length / 3)
  if (!n) return []
  const step = Math.max(1, Math.floor(n / 50000))
  const pts: number[][] = []
  for (let i = 0; i < n; i += step) pts.push([buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2]])
  // Inicialización por el punto más lejano (determinista).
  const cents: number[][] = [pts[Math.floor(pts.length / 2)].slice()]
  const d2 = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
  while (cents.length < k) {
    let best = 0, bi = 0
    for (let i = 0; i < pts.length; i += 7) { const d = Math.min(...cents.map((c) => d2(c, pts[i]))); if (d > best) { best = d; bi = i } }
    if (best < 60) break
    cents.push(pts[bi].slice())
  }
  const asg = new Int32Array(pts.length)
  for (let it = 0; it < 14; it++) {
    const sum = cents.map(() => [0, 0, 0, 0])
    for (let i = 0; i < pts.length; i++) {
      let bj = 0, bd = Infinity
      for (let j = 0; j < cents.length; j++) { const d = d2(cents[j], pts[i]); if (d < bd) { bd = d; bj = j } }
      asg[i] = bj; const s = sum[bj]; s[0] += pts[i][0]; s[1] += pts[i][1]; s[2] += pts[i][2]; s[3]++
    }
    cents.forEach((c, j) => { const s = sum[j]; if (s[3]) { c[0] = s[0] / s[3]; c[1] = s[1] / s[3]; c[2] = s[2] / s[3] } })
  }
  const count = cents.map(() => 0)
  for (let i = 0; i < pts.length; i++) count[asg[i]]++
  let sw = cents.map((c, j) => ({ c, share: count[j] / pts.length }))
  // Unir colores casi iguales.
  sw.sort((a, b) => b.share - a.share)
  const merged: typeof sw = []
  for (const x of sw) { const m = merged.find((y) => d2(y.c, x.c) < 22 ** 2); if (m) m.share += x.share; else merged.push({ ...x }) }
  sw = merged.filter((x) => x.share >= 0.008).sort((a, b) => b.share - a.share)
  return sw.slice(0, 10).map((x) => ({ hex: hex(x.c[0], x.c[1], x.c[2]), share: +x.share.toFixed(3) }))
}

/** Subtítulos VTT (incluidos los automáticos de YouTube, que repiten líneas) → segmentos limpios. */
export function parseVtt(txt: string) {
  const segs: Array<{ start: number; end: number; text: string }> = []
  const ts = (s: string) => { const p = s.trim().split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1] }
  const blocks = txt.replace(/\r/g, '').split(/\n\n+/)
  const seen = new Set<string>()
  for (const b of blocks) {
    const m = /(\d[\d:.]+)\s+-->\s+(\d[\d:.]+)/.exec(b)
    if (!m) continue
    const lines = b.split('\n').slice(b.split('\n').findIndex((l) => l.includes('-->')) + 1)
    for (const l of lines) {
      const clean = l.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim()
      if (!clean || seen.has(clean)) continue
      seen.add(clean)
      segs.push({ start: ts(m[1]), end: ts(m[2]), text: clean })
    }
  }
  return segs
}

export class Analyzer {
  id = `an-${Date.now().toString(36)}`
  workspace = `.analisis-${this.id}`
  dir = path.join(PROJECTS_DIR, this.workspace)
  work = path.join(this.dir, '_analisis')
  private procs = new Set<ChildProcess>()
  private cancelled = false
  private phase: Phase = 'descarga'

  constructor(private o: AnalyzeOpts, private emit: (e: AnalyzeEvent) => void) {}

  cancel() { this.cancelled = true; for (const p of this.procs) try { p.kill() } catch { /* ignore */ } }
  discard() { this.cancel(); closeFramePool(this.workspace); try { fs.rmSync(this.dir, { recursive: true, force: true }) } catch { /* ignore */ } }

  private step(phase: Phase, status: AnalyzeEvent['status'], message?: string, progress?: number) { this.phase = phase; this.emit({ id: this.id, phase, status, message, progress }) }
  private log(text: string) { this.emit({ id: this.id, phase: this.phase, log: text }) }
  private check() { if (this.cancelled) throw new Error('Análisis cancelado') }

  private exec(bin: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; onLine?: (l: string, err: boolean) => void; stdin?: string; timeout?: number } = {}): Promise<{ code: number; out: string; err: string }> {
    return new Promise((resolve, reject) => {
      const p = spawn(bin, args, { cwd: o.cwd, env: o.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      this.procs.add(p)
      let out = '', err = ''
      const timer = o.timeout ? setTimeout(() => { try { p.kill() } catch { /* ignore */ } }, o.timeout) : null
      readline.createInterface({ input: p.stdout! }).on('line', (l) => { if (out.length < 8e6) out += l + '\n'; o.onLine?.(l, false) })
      readline.createInterface({ input: p.stderr! }).on('line', (l) => { err = (err + l + '\n').slice(-200000); o.onLine?.(l, true) })
      p.on('error', (e) => { this.procs.delete(p); if (timer) clearTimeout(timer); reject(e) })
      p.on('close', (code) => { this.procs.delete(p); if (timer) clearTimeout(timer); resolve({ code: code ?? 1, out, err }) })
      if (o.stdin != null) p.stdin!.end(o.stdin); else p.stdin!.end()
    })
  }
  private ff(args: string[], o: Parameters<Analyzer['exec']>[2] = {}) { return this.exec(ffmpegPaths().ffmpeg, ['-hide_banner', '-nostdin', ...args], o) }

  async run(): Promise<AnalyzeResult> {
    try {
      const r = await this.pipeline()
      this.emit({ id: this.id, done: true, result: r })
      return r
    } catch (e: any) {
      const msg = String(e?.message || e)
      this.step(this.phase, 'error', msg)
      this.emit({ id: this.id, done: true, error: msg })
      throw e
    }
  }

  private async pipeline(): Promise<AnalyzeResult> {
    fs.mkdirSync(path.join(this.work, 'fotogramas'), { recursive: true })
    const src0 = this.o.source.trim()
    const url = isUrl(src0)
    let file = src0, title = path.basename(src0).replace(/\.[^.]+$/, ''), subsFile = ''

    // 1 · obtener el video
    this.step('descarga', 'run', url ? 'Descargando desde YouTube…' : 'Archivo local')
    if (url) {
      const bin = ytdlpPath()
      if (!bin) throw new Error('Para analizar enlaces hace falta yt-dlp. Instalalo en Ajustes → Plugins (un clic).')
      const args = ['--no-playlist', '--no-warnings', '--newline', '-i', '-f', 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/bv*[height<=720]+ba/b[height<=720]/b',
        '--merge-output-format', 'mp4', '--ffmpeg-location', path.dirname(ffmpegPaths().ffmpeg), '-o', path.join(this.work, 'source.%(ext)s'),
        '--write-info-json', '--write-subs', '--write-auto-subs', '--sub-langs', 'es.*,en.*', '--sub-format', 'vtt', src0]
      const r = await this.exec(bin, args, { onLine: (l) => { const m = /\[download\]\s+([\d.]+)%/.exec(l); if (m) this.step('descarga', 'run', `Descargando… ${m[1]} %`, +m[1] / 100); else if (/ERROR/.test(l)) this.log(l) } })
      this.check()
      const f = fs.readdirSync(this.work).find((x) => /^source\.(mp4|webm|mkv|mov)$/.test(x))
      if (!f) throw new Error('yt-dlp no pudo descargar el video. ' + r.err.split('\n').filter((l) => /ERROR/.test(l)).slice(-2).join(' '))
      file = path.join(this.work, f)
      try { const info = readJSON(path.join(this.work, 'source.info.json')); title = info.title || title; fs.rmSync(path.join(this.work, 'source.info.json'), { force: true }); fs.writeFileSync(path.join(this.work, 'fuente.json'), JSON.stringify({ titulo: info.title, canal: info.channel || info.uploader, duracion: info.duration, url: src0, descripcion: String(info.description || '').slice(0, 1500) }, null, 1)) } catch { /* sin metadatos */ }
      const subs = fs.readdirSync(this.work).filter((x) => /\.vtt$/.test(x)).sort((a, b) => (/\.es/.test(b) ? 1 : 0) - (/\.es/.test(a) ? 1 : 0))
      if (subs[0]) subsFile = path.join(this.work, subs[0])
    } else if (!fs.existsSync(file)) throw new Error('No existe el archivo: ' + file)
    this.step('descarga', 'ok', url ? title : path.basename(file))

    // 2 · formato
    this.step('video', 'run')
    const pr = await this.exec(ffmpegPaths().ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate', '-of', 'json', file])
    const pj = JSON.parse(pr.out || '{}')
    const vs = (pj.streams || []).find((s: any) => s.codec_type === 'video')
    const hasAudio = (pj.streams || []).some((s: any) => s.codec_type === 'audio')
    if (!vs) throw new Error('El archivo no tiene video')
    const duration = parseFloat(pj.format?.duration) || 0
    const [fn, fd] = String(vs.r_frame_rate || '30/1').split('/').map(Number)
    const fps = fd ? Math.round((fn / fd) * 100) / 100 : 30
    const maxSec = Math.min(duration, (this.o.maxMinutes || 20) * 60)
    const W = vs.width, H = vs.height
    this.step('video', 'ok', `${W}×${H} · ${fps} fps · ${Math.floor(duration / 60)}:${String(Math.round(duration % 60)).padStart(2, '0')}${maxSec < duration ? ` (se analizan los primeros ${Math.round(maxSec / 60)} min)` : ''}`)

    // Espacio de trabajo = proyecto oculto con la misma orientación que el video.
    const vertical = H > W * 1.1, square = !vertical && Math.abs(W - H) < W * 0.1
    const PW = vertical ? 1080 : 1920, PH = vertical ? 1920 : square ? 1920 : 1080
    writeJSON(path.join(this.dir, 'project.json'), { format: 'openanimator/1', id: this.workspace, name: `Análisis · ${title}`, width: PW, height: PH, fps: 30, background: '#000000', timelines: [{ id: 'main', name: 'Muestra', file: 'timelines/main.json' }], activeTimeline: 'main', createdAt: new Date().toISOString() })
    writeJSON(path.join(this.dir, 'timelines', 'main.json'), { format: 'oa-timeline/1', duration: 15, notes: [], tracks: [
      { id: 'escenas', name: 'Escenas', type: 'scene', clips: [{ id: 'c-estilo', src: 'scenes/estilo.html', start: 0, duration: 15, in: 0, name: 'Muestra de estilo' }] },
      { id: 'voz', name: 'Voz', type: 'audio', clips: [] }, { id: 'musica', name: 'Música', type: 'audio', clips: [], volume: 0.3 }, { id: 'sfx', name: 'SFX', type: 'audio', clips: [] },
    ] })
    for (const d of ['scenes', 'assets']) fs.mkdirSync(path.join(this.dir, d), { recursive: true })

    // 3 · cortes y movimiento
    this.check(); this.step('escenas', 'run', 'Detectando cortes…')
    const scores: Array<[number, number]> = []
    let lastT = 0, lastP = 0
    await this.ff(['-v', 'error', '-t', String(maxSec), '-i', file, '-an', '-vf', 'fps=5,scale=192:-2,select=gte(scene\\,0),metadata=print:file=-', '-f', 'null', '-'], {
      onLine: (l) => {
        const t = /pts_time:([\d.]+)/.exec(l); if (t) { lastT = +t[1]; const p = lastT / maxSec; if (p - lastP > 0.03) { lastP = p; this.step('escenas', 'run', 'Detectando cortes…', p) } }
        const s = /scene_score=([\d.]+)/.exec(l); if (s) scores.push([lastT, +s[1]])
      },
    })
    const cuts: number[] = []
    for (const [t, s] of scores) if (s > 0.32 && (!cuts.length || t - cuts[cuts.length - 1] > 0.5)) cuts.push(t)
    const bounds = [0, ...cuts, maxSec]
    const shots = bounds.slice(1).map((b, i) => ({ start: bounds[i], end: b })).filter((s) => s.end - s.start > 0.2)
    const avgShot = shots.length ? maxSec / shots.length : maxSec
    const nonCut = scores.filter(([, s]) => s <= 0.32).map(([, s]) => s)
    const motion = nonCut.length ? nonCut.reduce((a, b) => a + b, 0) / nonCut.length : 0
    // Movimiento por segundo (para elegir momentos "animados").
    const perSec = new Map<number, number>()
    for (const [t, s] of scores) if (s <= 0.32) perSec.set(Math.floor(t), (perSec.get(Math.floor(t)) || 0) + s)
    this.step('escenas', 'ok', `${shots.length} planos · ${avgShot.toFixed(1)} s promedio · ${(cuts.length / (maxSec / 60)).toFixed(1)} cortes/min`)

    // 4 · fotogramas
    this.check(); this.step('fotogramas', 'run')
    let times = shots.map((s) => +(s.start + (s.end - s.start) * 0.5).toFixed(2))
    const MAX = 30
    if (times.length > MAX) times = Array.from({ length: MAX }, (_, i) => times[Math.floor((i * times.length) / MAX)])
    const extra = Math.max(0, 14 - times.length)
    for (let i = 0; i < extra; i++) times.push(+((maxSec * (i + 0.5)) / extra).toFixed(2))
    times = [...new Set(times)].sort((a, b) => a - b)
    const frames: Array<{ file: string; t: number }> = []
    for (let i = 0; i < times.length; i += 4) {
      await Promise.all(times.slice(i, i + 4).map(async (t, j) => {
        const name = `f${String(i + j + 1).padStart(3, '0')}.jpg`
        await this.ff(['-v', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '3', path.join(this.work, 'fotogramas', name)])
        if (fs.existsSync(path.join(this.work, 'fotogramas', name))) frames.push({ file: `_analisis/fotogramas/${name}`, t })
      }))
      this.step('fotogramas', 'run', `${frames.length} / ${times.length}`, frames.length / times.length)
      this.check()
    }
    frames.sort((a, b) => a.t - b.t)
    // Hoja de contactos (todos los fotogramas en una imagen).
    const cols = frames.length > 20 ? 6 : 5
    const rows = Math.ceil(frames.length / cols)
    await this.ff(['-v', 'error', '-y', '-framerate', '1', '-i', path.join(this.work, 'fotogramas', 'f%03d.jpg'), '-vf', `scale=384:-2,tile=${cols}x${rows}:padding=6:margin=6:color=0x111111`, '-frames:v', '1', '-q:v', '3', path.join(this.work, 'hoja.jpg')])
    // Tiras de movimiento: 6 cuadros en 1,5 s en los momentos con más movimiento interno.
    const moving = [...perSec.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s)
    const strips: Array<{ file: string; t: number }> = []
    for (const s of moving) {
      if (strips.length >= 6) break
      if (strips.some((x) => Math.abs(x.t - s) < Math.max(4, maxSec / 12)) || cuts.some((c) => c > s && c < s + 1.6)) continue
      const name = `mov${strips.length + 1}.jpg`
      await this.ff(['-v', 'error', '-y', '-ss', String(s), '-t', '1.5', '-i', file, '-vf', 'fps=4,scale=320:-2,tile=6x1:padding=4:color=0x111111', '-frames:v', '1', '-q:v', '3', path.join(this.work, name)])
      if (fs.existsSync(path.join(this.work, name))) strips.push({ file: `_analisis/${name}`, t: s })
    }
    this.step('fotogramas', 'ok', `${frames.length} fotogramas · ${strips.length} tiras de movimiento`)

    // 5 · paleta
    this.check(); this.step('colores', 'run')
    const raw = path.join(this.work, 'pix.rgb')
    await this.ff(['-v', 'error', '-y', '-t', String(maxSec), '-i', file, '-an', '-vf', `fps=${Math.min(4, 60 / Math.max(1, maxSec)).toFixed(4)},scale=96:-2`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw])
    const palette = fs.existsSync(raw) ? kmeansPalette(fs.readFileSync(raw)) : []
    fs.rmSync(raw, { force: true })
    this.step('colores', 'ok', palette.slice(0, 6).map((p) => p.hex).join('  '))

    // 6 · audio
    this.check()
    let speechRatio: number | null = null, pauses = 0, lufs: number | null = null
    if (hasAudio) {
      this.step('audio', 'run')
      const a = await this.ff(['-t', String(maxSec), '-i', file, '-vn', '-af', 'silencedetect=n=-32dB:d=0.35,ebur128', '-f', 'null', '-'])
      let silent = 0, st = -1
      for (const l of a.err.split('\n')) {
        const s = /silence_start: ([\d.]+)/.exec(l); if (s) st = +s[1]
        const e = /silence_end: ([\d.]+)/.exec(l); if (e && st >= 0) { silent += +e[1] - st; pauses++; st = -1 }
      }
      if (st >= 0) silent += maxSec - st
      speechRatio = Math.max(0, Math.min(1, 1 - silent / maxSec))
      const m = /Integrated loudness:\s*\n?\s*I:\s*(-?[\d.]+)/.exec(a.err)
      lufs = m ? +m[1] : null
      if (speechRatio < 0.02 || (lufs != null && lufs <= -60)) { speechRatio = 0; this.step('audio', 'ok', 'La pista de audio está en silencio') }
      else this.step('audio', 'ok', `sonido el ${Math.round(speechRatio * 100)} % del tiempo · ${pauses} pausas${lufs != null ? ` · ${lufs} LUFS` : ''}`)
    } else this.step('audio', 'skip', 'El video no tiene audio')

    // 7 · narración
    this.check()
    let transcript: AnalyzeResult['stats']['transcript'] = 'no'
    let wpm: number | null = null
    const tfile = path.join(this.work, 'transcripcion.txt')
    if (subsFile) {
      this.step('narracion', 'run', 'Leyendo subtítulos…')
      const segs = parseVtt(fs.readFileSync(subsFile, 'utf8')).filter((s) => s.start < maxSec)
      fs.writeFileSync(tfile, segs.map((s) => `[${s.start.toFixed(1)}] ${s.text}`).join('\n'))
      const words = segs.reduce((n, s) => n + s.text.split(/\s+/).length, 0)
      wpm = speechRatio ? Math.round(words / ((maxSec * speechRatio) / 60)) : Math.round(words / (maxSec / 60))
      transcript = 'subtitulos'
      this.step('narracion', 'ok', `Subtítulos: ${words} palabras · ~${wpm} palabras/min`)
      for (const f of fs.readdirSync(this.work)) if (/\.vtt$/.test(f)) fs.rmSync(path.join(this.work, f), { force: true })
    } else if (hasAudio && this.o.transcribe !== false && (speechRatio ?? 0) > 0.15) {
      const st = await pluginStatus()
      const can = st.some((p) => (p.id === 'whisper' || p.id === 'elevenlabs' || p.id === 'openai' || p.id === 'fish') && p.ready)
      if (can) {
        this.step('narracion', 'run', 'Transcribiendo la narración…')
        try {
          const tr = await transcribe(file, { maxSec: Math.min(maxSec, 900) })
          const lines: string[] = []
          let cur: Word[] = []
          for (const w of tr.words) { cur.push(w); if (/[.?!]$/.test(w.w) || cur.length >= 18) { lines.push(`[${cur[0].start.toFixed(1)}] ${cur.map((x) => x.w).join(' ')}`); cur = [] } }
          if (cur.length) lines.push(`[${cur[0].start.toFixed(1)}] ${cur.map((x) => x.w).join(' ')}`)
          fs.writeFileSync(tfile, lines.join('\n') || tr.text)
          const span = Math.min(maxSec, 900)
          wpm = speechRatio ? Math.round(tr.words.length / ((span * speechRatio) / 60)) : null
          transcript = 'plugin'
          this.step('narracion', 'ok', `${tr.provider}: ${tr.words.length} palabras${wpm ? ` · ~${wpm} palabras/min` : ''}`)
        } catch (e: any) { this.step('narracion', 'skip', 'No se pudo transcribir: ' + e.message) }
      } else this.step('narracion', 'skip', 'Sin subtítulos. Configurá ElevenLabs, OpenAI o Fish Audio en Plugins para transcribir la voz.')
    } else this.step('narracion', 'skip', hasAudio ? 'Sin narración detectada' : 'Sin audio')

    const stats: AnalyzeResult['stats'] = {
      duration: +duration.toFixed(2), analyzed: +maxSec.toFixed(2), width: W, height: H, fps, shots: shots.length, avgShot: +avgShot.toFixed(2),
      cutsPerMin: +(cuts.length / (maxSec / 60)).toFixed(2), motion: +motion.toFixed(4), speechRatio: speechRatio == null ? null : +speechRatio.toFixed(3),
      pauses, lufs, wpm, palette, transcript,
    }
    writeJSON(path.join(this.work, 'datos.json'), {
      fuente: { titulo: title, url: url ? src0 : undefined, archivo: url ? undefined : path.basename(file) },
      ...stats, cortes: cuts.map((c) => +c.toFixed(2)), planos: shots.slice(0, 400).map((s) => [+s.start.toFixed(2), +s.end.toFixed(2)]),
      fotogramas: frames, tiras_movimiento: strips, hoja_contactos: '_analisis/hoja.jpg', transcripcion: fs.existsSync(tfile) ? '_analisis/transcripcion.txt' : null,
      notas_del_usuario: this.o.notes || undefined,
    })
    // Guías de referencia al alcance de Claude (dentro del espacio de trabajo).
    for (const sk of ['escenas-html', 'direccion-artistica']) {
      const f = path.join(APP_DIR, 'ai', 'skills', sk, 'SKILL.md')
      if (fs.existsSync(f)) fs.copyFileSync(f, path.join(this.work, `guia-${sk}.md`))
    }

    // 8 · Claude
    this.check(); this.step('ia', 'run', 'Claude está mirando el video…')
    await this.runClaude(PW, PH)
    const aFile = path.join(this.work, 'analisis.json')
    if (!fs.existsSync(aFile)) throw new Error('Claude no escribió el análisis (_analisis/analisis.json).')
    let analysis: any
    try { analysis = readJSON(aFile) } catch (e: any) { throw new Error('El análisis de Claude no es JSON válido: ' + e.message) }
    const sceneOk = fs.existsSync(path.join(this.dir, 'scenes', 'estilo.html'))
    this.step('ia', 'ok', analysis.titulo || 'Análisis listo')

    // 9 · vista previa
    this.check(); this.step('vista', 'run')
    let preview: string | undefined
    if (sceneOk) {
      try {
        const tl = readJSON(path.join(this.dir, 'timelines', 'main.json'))
        const [f] = await renderFrames(this.workspace, undefined, [Math.min(Math.max(1, (tl.duration || 10) * 0.45), 8)], 960)
        fs.writeFileSync(path.join(this.dir, 'thumbnail.jpg'), nativeImage.createFromBuffer(f.png).toJPEG(84))
        preview = `oa://p/${encodeURIComponent(this.workspace)}/thumbnail.jpg`
      } catch (e: any) { this.log('No se pudo generar la vista previa: ' + e.message) }
      finally { closeFramePool(this.workspace) }
    }
    if (!preview && fs.existsSync(path.join(this.work, 'hoja.jpg'))) fs.copyFileSync(path.join(this.work, 'fotogramas', 'f001.jpg'), path.join(this.dir, 'thumbnail.jpg'))
    this.step('vista', sceneOk ? 'ok' : 'skip', sceneOk ? 'Escena de muestra lista' : 'Sin escena de muestra')
    return { id: this.id, workspace: this.workspace, title, source: src0, isUrl: url, stats, analysis, sheet: `oa://p/${encodeURIComponent(this.workspace)}/_analisis/hoja.jpg`, preview, sceneOk }
  }

  private async runClaude(PW: number, PH: number) {
    const s = getSettings().claude
    const bin = s.claudePath || claudePath()
    if (!bin) throw new Error('Hace falta Claude Code para el análisis (Ajustes → Claude).')
    const prompt = `Sos director/a de arte y motion designer. Analizá un video de referencia para REPLICAR SU ESTILO en OpenAnimator (escenas HTML/SVG/JS en función del tiempo). Trabajá SOLO dentro de esta carpeta.

MATERIAL (en _analisis/):
- datos.json: métricas medidas con FFmpeg (duración, planos y cortes, movimiento, paleta por k-means con proporción, voz/silencios, sonoridad, palabras por minuto) y la lista de fotogramas con su segundo.
- hoja.jpg: hoja de contactos con todos los fotogramas clave en orden.
- fotogramas/f###.jpg: cada fotograma clave en grande. Mirá TODOS (usá Read sobre cada imagen).
- mov#.jpg: tiras de 6 cuadros cada 0,25 s en los momentos con más movimiento: sirven para deducir los TIPOS de animación (entradas, easing, escalas, trazos que se dibujan, parallax, cámara…).
- transcripcion.txt (si existe): narración con tiempos. fuente.json (si existe): título y descripción.
- guia-escenas-html.md y guia-direccion-artistica.md: el contrato de escena de OpenAnimator y criterios de diseño. Leelas antes de escribir la escena.
${this.o.notes ? `\nPEDIDO DEL USUARIO: ${this.o.notes}\n` : ''}
ENTREGABLES:
1) _analisis/analisis.json (JSON válido, en español), con esta forma:
{
  "titulo": "nombre corto y evocador del estilo",
  "resumen": "2-3 frases: qué tipo de video es y qué lo hace reconocible",
  "formato": { "relacion": "16:9", "tipo": "explicativo animado / reel / documental / …", "publico": "…" },
  "paleta": [ { "hex": "#RRGGBB", "nombre": "…", "uso": "fondo | texto | acento | …" } ],
  "tipografia": [ { "rol": "títulos | cuerpo | datos", "descripcion": "familia, peso, caja, tracking…", "sugerencia": "fuente local equivalente (Segoe UI, Georgia, Bahnschrift, Consolas…)" } ],
  "animaciones": [ { "tipo": "…", "descripcion": "cómo se mueve", "duracion_s": 0.5, "easing": "…", "frecuencia": "alta | media | baja" } ],
  "transiciones": [ { "tipo": "…", "descripcion": "…", "frecuencia": "…" } ],
  "formas": [ "…" ], "objetos": [ "íconos, personajes, gráficos, fotos, mapas…" ], "texturas_y_efectos": [ "…" ],
  "composicion": "grilla, márgenes, jerarquía, uso del espacio, cámara",
  "ritmo": { "descripcion": "…", "plano_promedio_s": 0, "cortes_por_minuto": 0 },
  "narracion": { "tipo": "voz en off | sin voz | texto en pantalla | diálogo", "tono": "…", "persona": "…", "estructura": "gancho → … → cierre", "velocidad_ppm": 0, "recursos": [ "…" ] },
  "sonido": { "musica": "…", "efectos": "…" },
  "texto_en_pantalla": "cuánto texto, cómo aparece, qué resalta",
  "claves_para_replicar": [ "reglas concretas y accionables" ],
  "evitar": [ "lo que rompería el estilo" ],
  "plantilla": { "nombre": "…", "descripcion": "1-2 frases para la galería de plantillas", "etiquetas": [ "…" ] }
}
Basate en lo que VES y en las métricas (no inventes lo que no se ve; si algo no se puede saber, decilo).

2) brief.md: guía de estilo completa para que otra IA produzca videos NUEVOS con este estilo (paleta con hex y usos, tipografía, animaciones con duraciones y easing, transiciones, formas y objetos, composición, ritmo, narración con un ejemplo de guion original de 3-4 frases, sonido, checklist). Arriba: "# Brief" + un campo "Tema del video: {{PROJECT_NAME}}".

3) scenes/estilo.html: una escena de MUESTRA de 12 a 20 s, ${PW}×${PH}, que demuestre el estilo con contenido ORIGINAL de ejemplo (sí: paleta, tipografía, formas, tipos de animación, transiciones, ritmo, composición; NO: logos, marcas, personajes reconocibles ni textos copiados del video). Cumplí el contrato (window.__oa = { duration, render(t) }, pura y determinista, todo local, sin CDN). Mostrá 3-4 "momentos" que cubran las animaciones y transiciones típicas. Si cambiás la duración, actualizá timelines/main.json (clip c-estilo y duration).

4) VERIFICÁ la escena con mcp__openanimator__oa_hoja_contactos y oa_ver_fotogramas (y oa_auditar_layout): compará con hoja.jpg y corregí hasta que se parezca en estilo y no haya textos superpuestos ni fuera de cuadro.

No uses la terminal. Terminá con un resumen de 3 líneas.`
    const mcpFile = writeMcpConfig(this.workspace)
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--mcp-config', mcpFile,
      '--allowedTools', ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'TodoWrite', ...['oa_ver_fotogramas', 'oa_hoja_contactos', 'oa_auditar_layout', 'oa_proyecto'].map((n) => `mcp__openanimator__${n}`)].join(','),
      '--disallowedTools', 'Bash,PowerShell,WebFetch,WebSearch']
    const model = this.o.model ?? s.model
    const effort = this.o.effort ?? s.effort
    if (model) args.push('--model', model)
    if (effort) args.push('--effort', effort)
    const TOOL: Record<string, string> = { Read: 'Mira', Write: 'Escribe', Edit: 'Edita', MultiEdit: 'Edita', Glob: 'Busca', Grep: 'Busca', TodoWrite: 'Planifica' }
    let resultErr = '', gotResult = false, reads = 0
    const r = await this.exec(bin, args, {
      cwd: this.dir, env: claudeEnv(this.workspace), stdin: prompt, timeout: 45 * 60 * 1000,
      onLine: (l, isErr) => {
        if (isErr) return
        let m: any
        try { m = JSON.parse(l) } catch { return }
        if (m.type === 'assistant') {
          for (const b of m.message?.content || []) {
            if (b.type === 'tool_use') {
              const n = String(b.name).replace(/^mcp__openanimator__/, '')
              const f = String(b.input?.file_path || b.input?.path || '').replace(/\\/g, '/').split('/').slice(-2).join('/')
              if (b.name === 'Read' && /\.jpg$/i.test(f)) reads++
              const label = n === 'oa_ver_fotogramas' ? 'Verifica fotogramas de su escena' : n === 'oa_hoja_contactos' ? 'Revisa su escena con una hoja de contactos' : n === 'oa_auditar_layout' ? 'Audita el layout' : `${TOOL[b.name] || b.name} ${f}`
              this.log(label.trim())
              this.step('ia', 'run', b.name === 'Read' && /\.jpg$/i.test(f) ? `Mirando fotogramas (${reads})…` : b.name === 'Write' ? `Escribiendo ${f}…` : /oa_/.test(n) ? 'Verificando la escena de muestra…' : undefined)
            } else if (b.type === 'text' && b.text?.trim()) this.log(b.text.trim().slice(0, 400))
          }
        } else if (m.type === 'result') { gotResult = true; if (m.is_error) resultErr = String(m.result || m.subtype || 'error') }
      },
    })
    this.check()
    if (resultErr) throw new Error('Claude: ' + resultErr.slice(0, 400))
    if (!gotResult && r.code !== 0) throw new Error(`Claude terminó con error (${r.code}). ${r.err.trim().split('\n').slice(-2).join(' ')}`)
  }

  /** Guarda el resultado como plantilla del usuario y borra el espacio de trabajo. */
  save(o: { name: string; description?: string; tags?: string[]; analysis?: any; stats?: any; source?: string; title?: string }) {
    const analysis = { ...(o.analysis || readJSON(path.join(this.work, 'analisis.json'))), medido: o.stats, fuente: { titulo: o.title, origen: o.source } }
    const { id, dir } = saveProjectAsTemplate(this.workspace, { name: o.name, description: o.description, tags: o.tags, includeAssets: true, analysis, guide: guideFromAnalysis(o.name, analysis) })
    for (const [from, to] of [['hoja.jpg', 'referencia.jpg']]) { const f = path.join(this.work, from); if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, to)) }
    this.discard()
    return { id }
  }
}

/** PLANTILLA.md legible para la IA a partir del análisis (además de brief.md). */
function guideFromAnalysis(name: string, a: any) {
  const L: string[] = [`# Plantilla «${name}»`, '', a.resumen || '', '', 'Plantilla creada analizando un video de referencia. Seguí `brief.md` (guía de estilo) y usá `scenes/estilo.html` como base visual: mismos colores, tipografía, formas, animaciones y ritmo, con contenido nuevo.', '']
  if (a.paleta?.length) L.push('## Paleta', ...a.paleta.map((p: any) => `- ${p.hex} — ${p.nombre || ''}${p.uso ? ` (${p.uso})` : ''}`), '')
  if (a.animaciones?.length) L.push('## Animaciones', ...a.animaciones.map((x: any) => `- **${x.tipo}**: ${x.descripcion || ''}${x.duracion_s ? ` · ${x.duracion_s} s` : ''}${x.easing ? ` · ${x.easing}` : ''}`), '')
  if (a.claves_para_replicar?.length) L.push('## Claves', ...a.claves_para_replicar.map((x: string) => `- ${x}`), '')
  if (a.evitar?.length) L.push('## Evitar', ...a.evitar.map((x: string) => `- ${x}`), '')
  return L.join('\n')
}

/** Borra espacios de trabajo de análisis que quedaron de sesiones anteriores. */
export function cleanupAnalyses() {
  try { for (const d of fs.readdirSync(PROJECTS_DIR)) if (d.startsWith('.analisis-')) fs.rmSync(path.join(PROJECTS_DIR, d), { recursive: true, force: true }) } catch { /* ignore */ }
  try { fs.rmSync(path.join(CACHE_DIR, 'codex'), { recursive: true, force: true }) } catch { /* ignore */ }
}
