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
import { pluginStatus, transcribe, ytdlpPath } from './plugins'
import { renderFrames, closeFramePool } from './frames'
import { analysisPrompt, describeTool, guideFromAnalysis, isUrl, keyframeTimes, kmeansPalette, parseVtt, shotsFromScores, stripSeconds, transcriptLines, workspaceProject } from './analyzer-core'
import type { AnalyzeEvent, AnalyzeOpts, AnalyzeResult, Phase } from './analyzer-core'
export { PHASES } from './analyzer-core'

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
    const { PW, PH, project, timeline } = workspaceProject(this.workspace, title, W, H)
    writeJSON(path.join(this.dir, 'project.json'), project)
    writeJSON(path.join(this.dir, 'timelines', 'main.json'), timeline)
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
    const { cuts, shots, avgShot, motion, perSec } = shotsFromScores(scores, maxSec)
    this.step('escenas', 'ok', `${shots.length} planos · ${avgShot.toFixed(1)} s promedio · ${(cuts.length / (maxSec / 60)).toFixed(1)} cortes/min`)

    // 4 · fotogramas
    this.check(); this.step('fotogramas', 'run')
    const times = keyframeTimes(shots, maxSec)
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
    const strips = (await stripSeconds(perSec, cuts, maxSec, async (s, n) => {
      await this.ff(['-v', 'error', '-y', '-ss', String(s), '-t', '1.5', '-i', file, '-vf', 'fps=4,scale=320:-2,tile=6x1:padding=4:color=0x111111', '-frames:v', '1', '-q:v', '3', path.join(this.work, `mov${n}.jpg`)])
      return fs.existsSync(path.join(this.work, `mov${n}.jpg`))
    })).map((t, i) => ({ file: `_analisis/mov${i + 1}.jpg`, t }))
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
          fs.writeFileSync(tfile, transcriptLines(tr.words).join('\n') || tr.text)
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
    const prompt = analysisPrompt(PW, PH, { notes: this.o.notes })
    const mcpFile = writeMcpConfig(this.workspace)
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--mcp-config', mcpFile,
      '--allowedTools', ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'TodoWrite', ...['oa_ver_fotogramas', 'oa_hoja_contactos', 'oa_auditar_layout', 'oa_proyecto'].map((n) => `mcp__openanimator__${n}`)].join(','),
      '--disallowedTools', 'Bash,PowerShell,WebFetch,WebSearch']
    const model = this.o.model ?? s.model
    const effort = this.o.effort ?? s.effort
    if (model) args.push('--model', model)
    if (effort) args.push('--effort', effort)
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
              const d = describeTool(b.name, b.input)
              if (d.image) reads++
              this.log(d.label)
              this.step('ia', 'run', d.image ? `Mirando fotogramas (${reads})…` : d.write ? `Escribiendo ${d.file}…` : d.check ? 'Verificando la escena de muestra…' : undefined)
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

/** Borra espacios de trabajo de análisis que quedaron de sesiones anteriores. */
export function cleanupAnalyses() {
  try { for (const d of fs.readdirSync(PROJECTS_DIR)) if (d.startsWith('.analisis-')) fs.rmSync(path.join(PROJECTS_DIR, d), { recursive: true, force: true }) } catch { /* ignore */ }
  try { fs.rmSync(path.join(CACHE_DIR, 'codex'), { recursive: true, force: true }) } catch { /* ignore */ }
}
