/**
 * Motor de exportación.
 *
 *  1. N "workers" = ventanas Chromium fuera de pantalla con el compositor del timeline,
 *     renderizando DIRECTO a la resolución de salida (las escenas son vectoriales: 4K nítido).
 *  2. Cada worker toma segmentos de la cola: frame → renderAt(t) → capturePage → BGRA →
 *     pipe a FFmpeg con el encoder final (NVENC). Un solo encode por fotograma.
 *  3. Los segmentos terminados quedan en caché: si se cancela o se corta la luz, se retoma.
 *  4. Al final: concat de segmentos (copia) + mezcla de audio del timeline → archivo final.
 */
import { BrowserWindow } from 'electron'
const PROF = process.env.OA_PROFILE ? { n: 0, r: 0, c: 0, b: 0, w: 0 } : null
import { openCompositor, captureExact, renderAt } from './capture'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { readProject, readTimeline, projectDir, Timeline } from './projects'
import { ExportSettings, videoArgs, audioCodecArgs, buildAudioMix, spawnFFmpeg, validateContainer, probeDuration, detectEncoders } from './ffmpeg'

export type ExportJob = {
  projectId: string
  timelines: string[]           // uno o varios timelines
  join: boolean                 // varios timelines → un solo archivo (con capítulos)
  chapters: boolean
  range?: { start: number; end: number } | null   // sólo con un timeline
  settings: ExportSettings
  output: string                // archivo (join/uno) o carpeta (varios separados)
}
export type ExportProgress = {
  phase: 'preparando' | 'render' | 'audio' | 'final' | 'listo' | 'error' | 'cancelado'
  message: string; done: number; total: number; fps?: number; eta?: number; elapsed?: number; file?: string
}

class Cancelled extends Error {}

function hashOf(...parts: unknown[]) { return crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16) }

function projectMtime(dir: string): number {
  let max = 0
  const walk = (d: string, depth: number) => {
    if (depth > 6) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || ['renders', 'node_modules', 'timelines', 'research'].includes(e.name)) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (/\.(html?|js|mjs|css|json|svg|png|jpe?g|webp|gif|mp4|webm|mov|glb|woff2?|ttf|otf)$/i.test(e.name)) max = Math.max(max, fs.statSync(p).mtimeMs)
    }
  }
  walk(dir, 0)
  return Math.floor(max)
}

type Seg = { index: number; f0: number; f1: number; file: string; done: boolean }
type TlPlan = { tlId: string; name: string; tl: Timeline; start: number; end: number; frames: number; segs: Seg[]; cache: string; audio: string }

export class Exporter {
  private cancelled = false
  private procs = new Set<ChildProcess>()
  private wins = new Set<BrowserWindow>()
  constructor(private job: ExportJob, private onProgress: (p: ExportProgress) => void) {}

  cancel() {
    this.cancelled = true
    this.procs.forEach((p) => { try { p.kill('SIGKILL') } catch { /* ignore */ } })
    this.wins.forEach((w) => { try { w.destroy() } catch { /* ignore */ } })
  }
  private check() { if (this.cancelled) throw new Cancelled('cancelado') }

  async run(): Promise<string[]> {
    try {
      const out = await this.runInner()
      this.onProgress({ phase: 'listo', message: 'Exportación terminada', done: 1, total: 1, file: out.join('\n') })
      return out
    } catch (e: any) {
      if (e instanceof Cancelled || this.cancelled) {
        this.onProgress({ phase: 'cancelado', message: 'Cancelado. Los segmentos ya renderizados se reutilizan al volver a exportar.', done: 0, total: 1 })
      } else {
        this.onProgress({ phase: 'error', message: String(e?.message || e), done: 0, total: 1 })
      }
      throw e
    } finally {
      this.wins.forEach((w) => { try { w.destroy() } catch { /* ignore */ } })
    }
  }

  private async runInner(): Promise<string[]> {
    const { job } = this
    const s = job.settings
    validateContainer(s)
    const enc = await detectEncoders()
    if (s.vcodec.endsWith('_nvenc') && !enc[s.vcodec]) throw new Error(`El encoder ${s.vcodec} no está disponible en esta PC (¿GPU NVIDIA/driver?). Elegí H.264 CPU (libx264).`)
    const dir = projectDir(job.projectId)!
    const project = readProject(job.projectId)
    const mtime = projectMtime(dir)
    const vsig = { w: s.width, h: s.height, fps: s.fps, v: videoArgs({ ...s, rc: s.rc === 'size' ? 'vbr' : s.rc }, 60) }

    // ── plan ──
    this.onProgress({ phase: 'preparando', message: 'Preparando…', done: 0, total: 1 })
    const plans: TlPlan[] = []
    for (const tlId of job.timelines) {
      const tl = readTimeline(job.projectId, tlId)
      const ref = project.timelines.find((t) => t.id === tlId)!
      const start = job.range && job.timelines.length === 1 ? Math.max(0, job.range.start) : 0
      const end = job.range && job.timelines.length === 1 ? Math.min(tl.duration, job.range.end) : tl.duration
      const frames = Math.max(1, Math.round((end - start) * s.fps))
      // Segmentos de hasta segmentSec, pero lo bastante cortos como para repartir un video corto entre todos los workers.
      const segFrames = Math.max(s.fps * 2, Math.min(Math.round(s.segmentSec * s.fps), Math.ceil(frames / Math.max(1, s.workers))))
      const key = hashOf(vsig, tl.tracks.filter((t) => t.type !== 'audio'), project.width, project.height, start, end, mtime, segFrames)
      const cache = path.join(dir, '.oa-cache', 'export', `${tlId}-${key}`)
      fs.mkdirSync(cache, { recursive: true })
      const segs: Seg[] = []
      for (let f0 = 0, i = 0; f0 < frames; f0 += segFrames, i++) {
        const file = path.join(cache, `seg_${String(i).padStart(4, '0')}.mp4`)
        segs.push({ index: i, f0, f1: Math.min(frames, f0 + segFrames), file, done: fs.existsSync(file + '.done') && fs.existsSync(file) })
      }
      plans.push({ tlId, name: ref?.name || tlId, tl, start, end, frames, segs, cache, audio: path.join(cache, `audio-${hashOf(tl.tracks.filter((t) => t.type !== 'scene'), start, end, s.volumeDb, s.loudnorm, s.lufs)}.wav`) })
    }

    // ── render de video ──
    const totalFrames = plans.reduce((n, p) => n + p.frames, 0)
    let doneFrames = plans.reduce((n, p) => n + p.segs.filter((x) => x.done).reduce((m, x) => m + x.f1 - x.f0, 0), 0)
    const t0 = Date.now(); const reusedFrames = doneFrames
    const report = (msg: string) => {
      const el = (Date.now() - t0) / 1000
      const rendered = doneFrames - reusedFrames
      const fps = rendered / Math.max(0.001, el)
      const eta = fps > 0 ? (totalFrames - doneFrames) / fps : undefined
      this.onProgress({ phase: 'render', message: msg, done: doneFrames, total: totalFrames, fps, eta, elapsed: el })
    }
    const queue: Array<{ plan: TlPlan; seg: Seg }> = []
    plans.forEach((plan) => plan.segs.filter((x) => !x.done).forEach((seg) => queue.push({ plan, seg })))
    const nWorkers = Math.max(1, Math.min(s.workers, queue.length, s.vcodec.endsWith('_nvenc') ? 8 : 32))
    report(queue.length ? `Renderizando con ${nWorkers} worker(s)…` : 'Todos los segmentos ya estaban renderizados')

    const worker = async (wi: number) => {
      let win: BrowserWindow | null = null
      let loadedTl = ''
      try {
        while (queue.length) {
          this.check()
          const item = queue.shift()!
          if (!win || loadedTl !== item.plan.tlId) {
            if (win) { this.wins.delete(win); win.destroy() }
            win = await openCompositor(job.projectId, item.plan.tlId, project.width, project.height, s.width, s.height)
            this.wins.add(win)
            loadedTl = item.plan.tlId
          }
          await this.renderSegment(win, item.plan, item.seg, s, () => { doneFrames++; if (doneFrames % 10 === 0) report(`Renderizando «${item.plan.name}» (worker ${wi + 1}/${nWorkers})`) })
        }
      } finally { if (win) { this.wins.delete(win); win.destroy() } }
    }
    await Promise.all(Array.from({ length: nWorkers }, (_, i) => worker(i)))
    this.check()

    // ── audio (una mezcla WAV por timeline, cacheada) ──
    for (const plan of plans) {
      this.check()
      if (s.acodec === 'none' || fs.existsSync(plan.audio)) continue
      this.onProgress({ phase: 'audio', message: `Mezclando audio de «${plan.name}»…`, done: 0, total: 1 })
      await this.mixAudio(plan, dir, s)
    }

    // ── archivo(s) final(es) ──
    const outputs: string[] = []
    if (plans.length === 1 || job.join) {
      const out = job.output
      await this.finalize(plans, out, s, job.chapters && plans.length > 1)
      outputs.push(out)
    } else {
      fs.mkdirSync(job.output, { recursive: true })
      for (const plan of plans) {
        const out = path.join(job.output, `${safeName(project.name)} - ${safeName(plan.name)}.${s.container}`)
        await this.finalize([plan], out, s, false)
        outputs.push(out)
      }
    }
    return outputs
  }

  private async renderSegment(win: BrowserWindow, plan: TlPlan, seg: Seg, s: ExportSettings, onFrame: () => void) {
    const tmp = seg.file.replace(/\.mp4$/, '.part.mp4')
    const args = ['-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${s.width}x${s.height}`, '-framerate', String(s.fps), '-i', 'pipe:0',
      ...videoArgs(s, plan.end - plan.start), '-an', '-f', 'mp4', tmp]
    const ff = spawnFFmpeg(args)
    this.procs.add(ff)
    let err = ''
    ff.stderr!.on('data', (d) => { err = (err + d).slice(-4000) })
    const exited = new Promise<number>((res) => ff.on('close', (code) => res(code ?? 1)))
    ff.stdin!.on('error', () => { /* se reporta por el código de salida */ })
    try {
      for (let f = seg.f0; f < seg.f1; f++) {
        this.check()
        const t = plan.start + f / s.fps
        const p0 = performance.now()
        await renderAt(win, t)
        const p1 = performance.now()
        const img = await captureExact(win, s.width, s.height)
        const p2 = performance.now()
        const buf = img.toBitmap()
        const p3 = performance.now()
        if (!ff.stdin!.write(buf)) await new Promise<void>((r) => ff.stdin!.once('drain', () => r()))
        const p4 = performance.now()
        if (PROF) { PROF.r += p1 - p0; PROF.c += p2 - p1; PROF.b += p3 - p2; PROF.w += p4 - p3; if (++PROF.n % 100 === 0) process.stdout.write(`[prof] n=${PROF.n} render=${(PROF.r / PROF.n).toFixed(1)} capture=${(PROF.c / PROF.n).toFixed(1)} bitmap=${(PROF.b / PROF.n).toFixed(1)} write=${(PROF.w / PROF.n).toFixed(1)} ms
`) }
        onFrame()
      }
      ff.stdin!.end()
      const code = await exited
      this.procs.delete(ff)
      if (code !== 0) throw new Error(`FFmpeg falló codificando un segmento (${code}): ${err.trim().split('\n').slice(-3).join(' ')}`)
      fs.renameSync(tmp, seg.file)
      fs.writeFileSync(seg.file + '.done', new Date().toISOString())
      seg.done = true
    } catch (e) {
      try { ff.kill('SIGKILL') } catch { /* ignore */ }
      this.procs.delete(ff)
      try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
      throw e
    }
  }

  private async mixAudio(plan: TlPlan, dir: string, s: ExportSettings) {
    const D = plan.end - plan.start
    const mix = buildAudioMix(plan.tl, dir, plan.start, plan.end, s)
    const tmp = plan.audio.replace(/\.wav$/, '.part.wav')
    let args: string[]
    if (!mix) args = ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo`, '-t', D.toFixed(4), '-c:a', 'pcm_s16le', tmp]
    else {
      const fscript = path.join(plan.cache, 'audio-filter.txt')
      fs.writeFileSync(fscript, mix.filter)
      args = ['-hide_banner', '-y', '-loglevel', 'error', ...mix.inputs, '-/filter_complex', fscript, '-map', '[aout]', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', tmp]
    }
    await this.ffmpeg(args, 'mezclando audio')
    fs.renameSync(tmp, plan.audio)
  }

  private async finalize(plans: TlPlan[], out: string, s: ExportSettings, chapters: boolean) {
    this.check()
    this.onProgress({ phase: 'final', message: `Uniendo y escribiendo ${path.basename(out)}…`, done: 0, total: 1 })
    fs.mkdirSync(path.dirname(out), { recursive: true })
    const work = plans[0].cache
    const vlist = path.join(work, `concat-video-${Date.now()}.txt`)
    const q = (f: string) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`
    fs.writeFileSync(vlist, plans.flatMap((p) => p.segs.map((x) => q(x.file))).join('\n') + '\n')
    const args = ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', vlist]
    let n = 1
    if (s.acodec !== 'none') {
      if (plans.length === 1) args.push('-i', plans[0].audio)
      else {
        const alist = path.join(work, `concat-audio-${Date.now()}.txt`)
        fs.writeFileSync(alist, plans.map((p) => q(p.audio)).join('\n') + '\n')
        args.push('-f', 'concat', '-safe', '0', '-i', alist)
      }
      n++
    }
    let metaIdx = -1
    if (chapters && ['mp4', 'mkv', 'mov'].includes(s.container)) {
      const meta = path.join(work, `chapters-${Date.now()}.txt`)
      let pos = 0
      const lines = [';FFMETADATA1']
      for (const p of plans) {
        const d = p.frames / s.fps
        const esc = (x: string) => x.replace(/([=;#\\\n])/g, '\\$1')
        lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(pos * 1000)}`, `END=${Math.round((pos + d) * 1000)}`, `title=${esc(p.name)}`)
        pos += d
      }
      fs.writeFileSync(meta, lines.join('\n') + '\n')
      args.push('-i', meta); metaIdx = n; n++
    }
    args.push('-map', '0:v:0')
    if (s.acodec !== 'none') args.push('-map', '1:a:0')
    if (metaIdx >= 0) args.push('-map_metadata', String(metaIdx), '-map_chapters', String(metaIdx))
    args.push('-c:v', 'copy', ...audioCodecArgs(s), '-shortest')
    if (s.title) args.push('-metadata', `title=${s.title}`)
    if ((s.container === 'mp4' || s.container === 'mov') && s.faststart) args.push('-movflags', '+faststart')
    const tmp = path.join(path.dirname(out), `.${path.basename(out)}.part.${s.container}`)
    args.push(tmp)
    await this.ffmpeg(args, 'escribiendo el archivo final')
    const expected = plans.reduce((a, p) => a + p.frames / s.fps, 0)
    const got = await probeDuration(tmp)
    if (!(got > 0) || Math.abs(got - expected) > Math.max(1, expected * 0.01)) {
      throw new Error(`Validación falló: se esperaban ${expected.toFixed(2)} s y el archivo dura ${got.toFixed(2)} s`)
    }
    fs.rmSync(out, { force: true })
    fs.renameSync(tmp, out)
  }

  private ffmpeg(args: string[], what: string) {
    return new Promise<void>((resolve, reject) => {
      const p = spawnFFmpeg(args)
      this.procs.add(p)
      let err = ''
      p.stderr!.on('data', (d) => { err = (err + d).slice(-4000) })
      p.stdin!.end()
      p.on('close', (code) => {
        this.procs.delete(p)
        if (this.cancelled) return reject(new Cancelled('cancelado'))
        if (code === 0) resolve()
        else reject(new Error(`FFmpeg falló ${what}: ${err.trim().split('\n').slice(-4).join(' ')}`))
      })
    })
  }
}

export function safeName(s: string) { return s.replace(/[<>:"/\\|?*]+/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '') || 'video' }

/** Borra la caché de exportación de un proyecto. */
export function clearExportCache(projectId: string) {
  const dir = projectDir(projectId)
  if (dir) fs.rmSync(path.join(dir, '.oa-cache', 'export'), { recursive: true, force: true })
}
