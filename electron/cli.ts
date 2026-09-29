/**
 * Modo línea de comandos (sin interfaz):
 *
 *   OpenAnimator.exe --cli render <proyecto|carpeta> [--timeline id|all] [--join] [--out archivo]
 *        [--width 1920 --height 1080 | --res 720p|1080p|1440p|4k] [--fps 30]
 *        [--codec h264_nvenc|hevc_nvenc|av1_nvenc|libx264] [--cq 20] [--preset p5]
 *        [--workers 4] [--start s] [--end s]
 *   OpenAnimator.exe --cli list
 *   OpenAnimator.exe --cli frame <proyecto> <segundos> <salida.jpg> [--width 1280] [--timeline id]
 *   OpenAnimator.exe --cli new <nombre> [--template documental|cinetico|en-blanco]
 *   OpenAnimator.exe --cli import-coanimator <carpeta>
 */
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, ExportSettings } from './ffmpeg'
import { Exporter, safeName } from './exporter'
import { listProjects, readProject, importCoAnimator, projectDir, createProject } from './projects'
import { PROJECTS_DIR } from './paths'
import { nativeImage } from 'electron'
import { renderFrames, closeFramePool } from './frames'

function arg(argv: string[], name: string) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const RES: Record<string, [number, number]> = { '720p': [1280, 720], '1080p': [1920, 1080], '1440p': [2560, 1440], '4k': [3840, 2160] }

function fmt(sec?: number) { if (sec == null || !isFinite(sec)) return '--:--'; sec = Math.max(0, Math.round(sec)); return `${Math.floor(sec / 3600)}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}` }

export async function runCli(argv: string[]): Promise<number> {
  const i = argv.indexOf('--cli')
  const rest = argv.slice(i + 1)
  const cmd = rest[0]
  const log = (s: string) => process.stdout.write(s + '\n')
  if (cmd === 'list') {
    for (const p of listProjects()) log(`${p.id}\t${p.name}\t${p.timelines} timeline(s)\t${fmt(p.duration)}`)
    return 0
  }
  if (cmd === 'new') {
    const p = createProject({ name: rest[1] || 'Mi video', template: arg(rest, '--template') || 'documental' })
    log(`Creado: ${p.id}`)
    return 0
  }
  if (cmd === 'import-coanimator') {
    const p = importCoAnimator(path.resolve(rest[1]))
    log(`Importado: ${p.id} (${p.timelines.length} timelines)`)
    return 0
  }
  if (cmd === 'frame') {
    // --cli frame <proyecto> <segundos> <salida.jpg|png> [--width 1280] [--timeline id]
    const [id, tt, out] = [rest[1], +rest[2], rest[3]]
    const [f] = await renderFrames(id, arg(rest, '--timeline'), [tt], +(arg(rest, '--width') || 1280))
    const img = nativeImage.createFromBuffer(f.png)
    fs.writeFileSync(path.resolve(out), /\.jpe?g$/i.test(out) ? img.toJPEG(88) : f.png)
    closeFramePool()
    log(`listo: ${path.resolve(out)}`)
    return 0
  }
  if (cmd !== 'render') { log('Uso: --cli render <proyecto> [opciones] | --cli list | --cli import-coanimator <carpeta>'); return 1 }
  let id = rest[1]
  if (!id) { log('Falta el proyecto'); return 1 }
  if (!projectDir(id) && fs.existsSync(path.join(id, 'project.json'))) {
    const abs = path.resolve(id)
    if (path.dirname(abs) === path.resolve(PROJECTS_DIR)) id = path.basename(abs)
    else { log('El proyecto debe estar en data/projects (o importalo primero).'); return 1 }
  }
  const project = readProject(id)
  const tlArg = arg(rest, '--timeline')
  const timelines = !tlArg ? [project.activeTimeline] : tlArg === 'all' ? project.timelines.map((t) => t.id) : tlArg.split(',')
  const s: ExportSettings = { ...DEFAULT_SETTINGS, fps: project.fps || 30, width: project.width, height: project.height }
  const res = arg(rest, '--res'); if (res && RES[res]) [s.width, s.height] = RES[res]
  if (arg(rest, '--width')) s.width = +arg(rest, '--width')!
  if (arg(rest, '--height')) s.height = +arg(rest, '--height')!
  if (arg(rest, '--fps')) s.fps = +arg(rest, '--fps')!
  if (arg(rest, '--codec')) s.vcodec = arg(rest, '--codec') as any
  if (arg(rest, '--cq')) s.cq = +arg(rest, '--cq')!
  if (arg(rest, '--preset')) s.preset = arg(rest, '--preset')!
  if (arg(rest, '--workers')) s.workers = +arg(rest, '--workers')!
  if (arg(rest, '--container')) s.container = arg(rest, '--container') as any
  const join = rest.includes('--join') || timelines.length === 1
  const start = arg(rest, '--start'), end = arg(rest, '--end')
  const range = start || end ? { start: +(start || 0), end: +(end || 1e9) } : null
  const out = path.resolve(arg(rest, '--out') || path.join(projectDir(id)!, 'renders',
    join ? `${safeName(project.name)}${timelines.length === 1 && project.timelines.length > 1 ? ' - ' + safeName(project.timelines.find((t) => t.id === timelines[0])?.name || '') : ''}.${s.container}` : ''))
  let last = ''
  const ex = new Exporter({ projectId: id, timelines, join, chapters: true, range, settings: s, output: out }, (p) => {
    const line = p.phase === 'render'
      ? `[render] ${((p.done / p.total) * 100).toFixed(1)}%  ${p.done}/${p.total} frames  ${p.fps ? p.fps.toFixed(1) : '-'} fps  restante ${fmt(p.eta)}`
      : `[${p.phase}] ${p.message}`
    if (line !== last) { log(line); last = line }
  })
  process.on('SIGINT', () => ex.cancel())
  try {
    const files = await ex.run()
    files.forEach((f) => log(`listo: ${f}`))
    return 0
  } catch (e: any) {
    log(`error: ${e?.message || e}`)
    return 1
  }
}
