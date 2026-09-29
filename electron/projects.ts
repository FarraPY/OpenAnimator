/**
 * Modelo de proyectos de OpenAnimator (formato abierto, ver docs/formato-proyecto.md).
 *
 *   <proyecto>/project.json          metadatos + lista de timelines
 *   <proyecto>/timelines/<id>.json   pistas y clips
 *   <proyecto>/scenes/*.html         escenas (HTML/SVG/JS en función del tiempo)
 *   <proyecto>/assets/               medios
 *   <proyecto>/renders/              exportaciones
 */
import fs from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'
import { APP_DIR, DATA_DIR, PROJECTS_DIR } from './paths'

export type Clip = {
  id: string; src: string; start: number; duration: number; in?: number
  volume?: number; muted?: boolean; fadeIn?: number; fadeOut?: number; fit?: string; name?: string
}
export type Track = {
  id: string; name: string; type: 'scene' | 'video' | 'audio'
  clips: Clip[]; muted?: boolean; solo?: boolean; hidden?: boolean; volume?: number; locked?: boolean
}
export type Note = { id: string; t: number; text: string }
export type Timeline = { format: 'oa-timeline/1'; duration: number; tracks: Track[]; notes?: Note[]; rev?: number }
export type TimelineRef = { id: string; name: string; file: string }
export type Project = {
  format: 'openanimator/1'; id: string; name: string; width: number; height: number; fps: number
  background?: string; timelines: TimelineRef[]; activeTimeline: string; template?: string
  createdAt?: string; updatedAt?: string; importedFrom?: string
}

// ── utilidades ──────────────────────────────────────────────────────────────
export function atomicWrite(file: string, data: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}
export const writeJSON = (file: string, obj: unknown) => atomicWrite(file, JSON.stringify(obj, null, 2) + '\n')
export const readJSON = <T = any>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))

export function slugify(s: string) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'proyecto'
}
export function uid(prefix = 'c') { return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` }

function uniqueDir(parent: string, base: string) {
  let id = base, n = 2
  while (fs.existsSync(path.join(parent, id))) id = `${base}-${n++}`
  return id
}

// ── registro ────────────────────────────────────────────────────────────────
export function projectDir(id: string): string | null {
  if (!id || id.includes('..') || /[\\/]/.test(id)) return null
  const d = path.join(PROJECTS_DIR, id)
  return fs.existsSync(path.join(d, 'project.json')) ? d : null
}

function mustDir(id: string) {
  const d = projectDir(id)
  if (!d) throw new Error(`Proyecto no encontrado: ${id}`)
  return d
}

export function readProject(id: string): Project { return readJSON<Project>(path.join(mustDir(id), 'project.json')) }
export function writeProject(p: Project) {
  p.updatedAt = new Date().toISOString()
  writeJSON(path.join(mustDir(p.id), 'project.json'), p)
}

export function timelineFile(p: Project, tlId?: string) {
  const ref = p.timelines.find((t) => t.id === (tlId || p.activeTimeline)) || p.timelines[0]
  if (!ref) throw new Error('El proyecto no tiene timelines')
  return { ref, file: path.join(mustDir(p.id), ref.file) }
}
export function readTimeline(id: string, tlId?: string): Timeline {
  const p = readProject(id)
  const { file } = timelineFile(p, tlId)
  const tl = readJSON<Timeline>(file)
  tl.tracks ||= []
  tl.notes ||= []
  return tl
}
export function writeTimeline(id: string, tlId: string, tl: Timeline) {
  const p = readProject(id)
  const { file } = timelineFile(p, tlId)
  tl.rev = (tl.rev || 0) + 1
  // La duración nunca puede quedar más corta que el último clip.
  const end = Math.max(0, ...tl.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)))
  if (!(tl.duration >= end)) tl.duration = Math.ceil(end * 1000) / 1000
  writeJSON(file, tl)
  touch(p)
}
function touch(p: Project) { try { writeProject(p) } catch { /* ignore */ } }

export type ProjectSummary = { id: string; name: string; width: number; height: number; fps: number; timelines: number; duration: number; updatedAt?: string; thumb?: string }
export function listProjects(): ProjectSummary[] {
  if (!fs.existsSync(PROJECTS_DIR)) return []
  const out: ProjectSummary[] = []
  for (const id of fs.readdirSync(PROJECTS_DIR)) {
    if (id.startsWith('.')) continue // espacios de trabajo internos (p. ej. análisis de video)
    const f = path.join(PROJECTS_DIR, id, 'project.json')
    if (!fs.existsSync(f)) continue
    try {
      const p = readJSON<Project>(f)
      let duration = 0
      for (const ref of p.timelines || []) {
        try { duration += readJSON<Timeline>(path.join(PROJECTS_DIR, id, ref.file)).duration || 0 } catch { /* ignore */ }
      }
      const thumb = fs.existsSync(path.join(PROJECTS_DIR, id, 'thumbnail.jpg')) ? `oa://p/${encodeURIComponent(id)}/thumbnail.jpg` : undefined
      out.push({ id, name: p.name, width: p.width, height: p.height, fps: p.fps, timelines: (p.timelines || []).length, duration, updatedAt: p.updatedAt, thumb })
    } catch { /* proyecto roto: se ignora en la lista */ }
  }
  return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
}

// ── plantillas ──────────────────────────────────────────────────────────────
export type TemplateInfo = { id: string; name: string; description: string; defaults: { duration: number }; preview?: string; user?: boolean; createdAt?: string; width?: number; height?: number; fps?: number; tags?: string[]; analysis?: any }
const TEMPLATES_DIR = () => path.join(APP_DIR, 'templates')
/** Plantillas del usuario (guardadas desde un proyecto o creadas analizando un video). */
export const USER_TEMPLATES_DIR = () => path.join(DATA_DIR, 'templates')
const tplDirOf = (id: string) => {
  if (!id || id.includes('..') || /[\\/]/.test(id)) throw new Error('Plantilla inválida')
  const u = path.join(USER_TEMPLATES_DIR(), id)
  if (id.startsWith('u-') && fs.existsSync(path.join(u, 'template.json'))) return u
  const a = path.join(TEMPLATES_DIR(), id)
  if (fs.existsSync(path.join(a, 'template.json'))) return a
  throw new Error('Plantilla no encontrada: ' + id)
}

export function listTemplates(): TemplateInfo[] {
  const read = (root: string, host: string, user: boolean) => !fs.existsSync(root) ? [] : fs.readdirSync(root)
    .filter((d) => fs.existsSync(path.join(root, d, 'template.json')))
    .map((d) => {
      try {
        const j = readJSON(path.join(root, d, 'template.json'))
        const prev = fs.existsSync(path.join(root, d, 'preview.jpg')) ? `${host}/${encodeURIComponent(d)}/preview.jpg?v=${Math.round(fs.statSync(path.join(root, d, 'preview.jpg')).mtimeMs)}` : undefined
        const { timeline: _t, analysis, ...rest } = j
        return { id: d, ...rest, defaults: j.defaults || { duration: j.timeline?.duration || 10 }, preview: prev, user, hasAnalysis: !!analysis } as TemplateInfo
      } catch { return null }
    }).filter(Boolean) as TemplateInfo[]
  const app = read(TEMPLATES_DIR(), 'oa://app/templates', false).sort((a: any, b: any) => (a.order ?? 99) - (b.order ?? 99))
  const user = read(USER_TEMPLATES_DIR(), 'oa://ut', true).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  return [...app, ...user]
}
export function getTemplate(id: string) { return { id, ...readJSON(path.join(tplDirOf(id), 'template.json')) } }

export function deleteTemplate(id: string) {
  if (!id.startsWith('u-')) throw new Error('Las plantillas incluidas no se pueden borrar')
  return shell.trashItem(tplDirOf(id))
}
export function updateTemplate(id: string, patch: { name?: string; description?: string }) {
  if (!id.startsWith('u-')) throw new Error('Las plantillas incluidas no se pueden editar')
  const f = path.join(tplDirOf(id), 'template.json')
  const j = readJSON(f)
  if (patch.name?.trim()) j.name = patch.name.trim()
  if (patch.description != null) j.description = patch.description
  writeJSON(f, j)
}

const TEMPLATE_SKIP = /^(renders|timelines|\.oa-cache|\.claude|node_modules|\.git|seg|\.migration-backup|_analisis)(\/|$)|^(project\.json|coanimator-project\.json|thumbnail\.jpg)$/

/**
 * Guarda un proyecto como plantilla del usuario: escenas, motores, guías y (opcional) medios,
 * más el timeline activo. Así se puede reutilizar todo lo que funcionó en otro proyecto.
 */
export function saveProjectAsTemplate(projectId: string, o: { name: string; description?: string; includeAssets?: boolean; guide?: string; analysis?: any; tags?: string[] }) {
  const src = mustDir(projectId)
  const p = readProject(projectId)
  const id = uniqueDir(USER_TEMPLATES_DIR(), 'u-' + slugify(o.name || p.name))
  const dir = path.join(USER_TEMPLATES_DIR(), id)
  const files = path.join(dir, 'files')
  const skipAssets = o.includeAssets === false
  const isMedia = (rel: string) => /\.(mp4|webm|mov|mkv|m4v|mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(rel)
  copyDir(src, files, (rel) => !TEMPLATE_SKIP.test(rel) && !(skipAssets && (rel === 'assets' || rel.startsWith('assets/') || rel.startsWith('adjuntos/'))) && !(skipAssets && isMedia(rel)))
  const tl = readTimeline(projectId)
  // Sin medios, los clips que apuntan a archivos que no se copiaron se quitan (las pistas quedan).
  const exists = (rel: string) => fs.existsSync(path.join(files, rel))
  const timeline: Timeline = { format: 'oa-timeline/1', duration: tl.duration, notes: [], tracks: tl.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => exists(c.src)) })) }
  if (o.guide || !fs.existsSync(path.join(files, 'PLANTILLA.md'))) {
    const guide = o.guide || `# Plantilla «${o.name}»

${o.description || ''}

Creada a partir del proyecto «${p.name}». Mantené el mismo estilo visual (paleta, tipografía, animaciones y ritmo) de las escenas incluidas y cambiá el contenido según el brief.
`
    fs.writeFileSync(path.join(files, 'PLANTILLA.md'), guide)
  }
  const tpl = {
    name: o.name || p.name, description: o.description || '', user: true, createdAt: new Date().toISOString(), fromProject: p.name,
    width: p.width, height: p.height, fps: p.fps, background: p.background || '#000000', tags: o.tags || [],
    substitute: fs.existsSync(path.join(files, 'brief.md')) ? ['brief.md'] : [], timeline, ...(o.analysis ? { analysis: o.analysis } : {}),
  }
  writeJSON(path.join(dir, 'template.json'), tpl)
  const thumb = path.join(src, 'thumbnail.jpg')
  if (fs.existsSync(thumb)) fs.copyFileSync(thumb, path.join(dir, 'preview.jpg'))
  return { id, dir }
}

function copyDir(src: string, dst: string, filter?: (rel: string) => boolean, rel = '') {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (filter && !filter(r)) continue
    const s = path.join(src, e.name), d = path.join(dst, e.name)
    if (e.isDirectory()) copyDir(s, d, filter, r)
    else fs.copyFileSync(s, d)
  }
}

export function createProject(opts: { name: string; template: string; width?: number; height?: number; fps?: number }): Project {
  const tplDir = tplDirOf(opts.template)
  const tpl = readJSON(path.join(tplDir, 'template.json'))
  const id = uniqueDir(PROJECTS_DIR, slugify(opts.name))
  const dir = path.join(PROJECTS_DIR, id)
  if (fs.existsSync(path.join(tplDir, 'files'))) copyDir(path.join(tplDir, 'files'), dir)
  else fs.mkdirSync(dir, { recursive: true })
  const tokens: Record<string, string> = { PROJECT_NAME: opts.name, PROJECT_ID: id, DATE: new Date().toISOString() }
  for (const rel of tpl.substitute || []) {
    const f = path.join(dir, rel)
    if (!fs.existsSync(f)) continue
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/\{\{(\w+)\}\}/g, (m: string, k: string) => tokens[k] ?? m))
  }
  for (const d of ['assets', 'renders', 'timelines', 'scripts']) fs.mkdirSync(path.join(dir, d), { recursive: true })
  const p: Project = {
    format: 'openanimator/1', id, name: opts.name,
    width: opts.width || tpl.width || 1920, height: opts.height || tpl.height || 1080, fps: opts.fps || tpl.fps || 30,
    background: tpl.background || '#000000',
    timelines: [{ id: 'main', name: 'Principal', file: 'timelines/main.json' }], activeTimeline: 'main',
    template: opts.template, createdAt: new Date().toISOString(),
  }
  writeJSON(path.join(dir, 'project.json'), p)
  if (!fs.existsSync(path.join(dir, 'timelines', 'main.json'))) {
    const tl: Timeline = tpl.timeline || {
      format: 'oa-timeline/1', duration: tpl.defaults?.duration || 10,
      tracks: [
        { id: 'escenas', name: 'Escenas', type: 'scene', clips: [] },
        { id: 'voz', name: 'Voz', type: 'audio', clips: [] },
        { id: 'musica', name: 'Música', type: 'audio', clips: [], volume: 0.35 },
        { id: 'sfx', name: 'SFX', type: 'audio', clips: [] },
      ],
      notes: [],
    }
    writeJSON(path.join(dir, 'timelines', 'main.json'), tl)
  }
  return p
}

export async function deleteProject(id: string) { await shell.trashItem(mustDir(id)) }

export function duplicateProject(id: string): Project {
  const src = mustDir(id)
  const p = readProject(id)
  const nid = uniqueDir(PROJECTS_DIR, `${id}-copia`)
  copyDir(src, path.join(PROJECTS_DIR, nid), (rel) => !rel.startsWith('renders/') && !rel.startsWith('.oa-cache'))
  const np = { ...p, id: nid, name: `${p.name} (copia)`, createdAt: new Date().toISOString() }
  writeJSON(path.join(PROJECTS_DIR, nid, 'project.json'), np)
  return np
}

export function renameProject(id: string, name: string) { const p = readProject(id); p.name = name; writeProject(p) }

// ── timelines ───────────────────────────────────────────────────────────────
export function createTimeline(id: string, name: string, copyFrom?: string): Project {
  const p = readProject(id)
  const tid = (() => { let b = slugify(name), s = b, n = 2; while (p.timelines.some((t) => t.id === s)) s = `${b}-${n++}`; return s })()
  const base: Timeline = copyFrom ? readTimeline(id, copyFrom) : {
    format: 'oa-timeline/1', duration: 10, notes: [],
    tracks: [{ id: 'escenas', name: 'Escenas', type: 'scene', clips: [] }, { id: 'voz', name: 'Voz', type: 'audio', clips: [] }],
  }
  const ref = { id: tid, name, file: `timelines/${tid}.json` }
  writeJSON(path.join(mustDir(id), ref.file), { ...base, rev: 0 })
  p.timelines.push(ref)
  p.activeTimeline = tid
  writeProject(p)
  return p
}
export function renameTimeline(id: string, tlId: string, name: string) {
  const p = readProject(id); const r = p.timelines.find((t) => t.id === tlId); if (r) r.name = name; writeProject(p); return p
}
export function deleteTimeline(id: string, tlId: string) {
  const p = readProject(id)
  if (p.timelines.length <= 1) throw new Error('No se puede borrar el único timeline')
  const r = p.timelines.find((t) => t.id === tlId)
  if (!r) return p
  p.timelines = p.timelines.filter((t) => t.id !== tlId)
  if (p.activeTimeline === tlId) p.activeTimeline = p.timelines[0].id
  try { fs.renameSync(path.join(mustDir(id), r.file), path.join(mustDir(id), r.file + '.deleted')) } catch { /* ignore */ }
  writeProject(p)
  return p
}
export function setActiveTimeline(id: string, tlId: string) { const p = readProject(id); p.activeTimeline = tlId; writeProject(p); return p }
export function moveTimeline(id: string, tlId: string, delta: number) {
  const p = readProject(id); const i = p.timelines.findIndex((t) => t.id === tlId); const j = i + delta
  if (i >= 0 && j >= 0 && j < p.timelines.length) { const [x] = p.timelines.splice(i, 1); p.timelines.splice(j, 0, x) }
  writeProject(p); return p
}

// ── medios ──────────────────────────────────────────────────────────────────
export type Asset = { path: string; name: string; kind: 'scene' | 'video' | 'audio' | 'image' | 'doc' | 'other'; size: number; mtime?: number }
const KIND: Record<string, Asset['kind']> = {
  '.html': 'scene', '.htm': 'scene', '.mp4': 'video', '.webm': 'video', '.mov': 'video', '.mkv': 'video', '.m4v': 'video',
  '.mp3': 'audio', '.wav': 'audio', '.ogg': 'audio', '.m4a': 'audio', '.aac': 'audio', '.flac': 'audio', '.opus': 'audio',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.svg': 'image', '.avif': 'image',
  // Guiones, planes, subtítulos y documentos (los que crea la IA o adjunta el usuario).
  '.md': 'doc', '.txt': 'doc', '.pdf': 'doc', '.srt': 'doc', '.vtt': 'doc', '.csv': 'doc', '.docx': 'doc', '.json': 'doc',
}
/** Archivos que son de la app, no del usuario: no se listan como medios. */
const HIDDEN_FILES = /^(project\.json|thumbnail\.jpg|CLAUDE\.md|AGENTS\.md|PLANTILLA\.md)$|(^|\/)(package(-lock)?\.json|tsconfig\.json)$|^assets\/voz\/.*\/tiempos\.json$/
const SKIP_DIRS = new Set(['timelines', 'renders', 'node_modules', '.git', '.oa-cache', '.migration-backup', '.claude', 'research', 'seg'])

export function listAssets(id: string): Asset[] {
  const dir = mustDir(id)
  const out: Asset[] = []
  const walk = (d: string, rel: string, depth: number) => {
    if (depth > 6 || out.length > 5000) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (HIDDEN_FILES.test(r)) continue // archivos de la app (miniatura, project.json, guías), no son medios
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(d, e.name), r, depth + 1); continue }
      const kind = KIND[path.extname(e.name).toLowerCase()]
      if (!kind) continue
      const st = fs.statSync(path.join(d, e.name))
      out.push({ path: r, name: e.name, kind, size: st.size, mtime: st.mtimeMs })
    }
  }
  walk(dir, '', 0)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/** Ruta absoluta de un archivo del proyecto, sin permitir salir de su carpeta. */
export function projectFile(id: string, rel: string) {
  const dir = mustDir(id)
  const abs = path.resolve(dir, rel)
  if (abs !== dir && !abs.startsWith(dir + path.sep)) throw new Error('Ruta fuera del proyecto: ' + rel)
  return abs
}

/** Todos los archivos del proyecto (para mencionarlos con @ en el chat). */
export function listProjectFiles(id: string): Array<{ path: string; size: number; dir: boolean }> {
  const dir = mustDir(id)
  const out: Array<{ path: string; size: number; dir: boolean }> = []
  const walk = (d: string, rel: string, depth: number) => {
    if (depth > 6 || out.length > 4000) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'renders' || e.name === 'seg') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { out.push({ path: r, size: 0, dir: true }); walk(path.join(d, e.name), r, depth + 1) }
      else out.push({ path: r, size: fs.statSync(path.join(d, e.name)).size, dir: false })
    }
  }
  walk(dir, '', 0)
  return out
}

/** Texto de un archivo del proyecto para previsualizarlo (recortado). */
export function readProjectText(id: string, rel: string, max = 200000) {
  const f = projectFile(id, rel)
  const size = fs.statSync(f).size
  const fd = fs.openSync(f, 'r')
  try {
    const buf = Buffer.alloc(Math.min(size, max))
    fs.readSync(fd, buf, 0, buf.length, 0)
    return { text: buf.toString('utf8'), size, truncated: size > max }
  } finally { fs.closeSync(fd) }
}

/** Clips de los timelines que usan un archivo (para avisar antes de borrarlo). */
export function assetUsage(id: string, rel: string) {
  const p = readProject(id)
  const uses: Array<{ timeline: string; count: number }> = []
  for (const t of p.timelines) {
    try {
      const tl = readTimeline(id, t.id)
      const n = tl.tracks.reduce((s, tr) => s + tr.clips.filter((c) => c.src === rel).length, 0)
      if (n) uses.push({ timeline: t.name, count: n })
    } catch { /* timeline dañado */ }
  }
  return uses
}

export function addAssets(id: string, files: string[]): string[] {
  const dir = mustDir(id)
  const added: string[] = []
  for (const f of files) {
    const ext = path.extname(f).toLowerCase()
    const sub = KIND[ext] === 'scene' ? 'scenes' : 'assets'
    fs.mkdirSync(path.join(dir, sub), { recursive: true })
    let name = path.basename(f), n = 2
    while (fs.existsSync(path.join(dir, sub, name))) name = `${path.basename(f, ext)}-${n++}${ext}`
    fs.copyFileSync(f, path.join(dir, sub, name))
    added.push(`${sub}/${name}`)
  }
  return added
}

// ── importar proyectos de CoAnimator ────────────────────────────────────────
/** Convierte una carpeta de proyecto de CoAnimator (project.json + timelines) a un proyecto de OpenAnimator (copia). */
export function importCoAnimator(srcDir: string): Project {
  const coa = readJSON(path.join(srcDir, 'project.json'))
  const name = coa.name || path.basename(srcDir)
  const id = uniqueDir(PROJECTS_DIR, slugify(name))
  const dir = path.join(PROJECTS_DIR, id)
  const skip = (rel: string) => !/^(renders|\.migration-backup|node_modules|\.git)(\/|$)/.test(rel) && !/(^|\/)\.coa-state\.json$/.test(rel)
  copyDir(srcDir, dir, skip)
  fs.renameSync(path.join(dir, 'project.json'), path.join(dir, 'coanimator-project.json'))
  const refs: Array<{ id: string; name: string; file: string; animation: string }> = coa.timelines?.length
    ? coa.timelines
    : [{ id: 'main', name: name, file: 'timeline.json', animation: coa.videoFile || 'index.html' }]
  const rel = (s: string) => {
    if (!s) return s
    const abs = path.isAbsolute(s) ? s : null
    if (abs && abs.toLowerCase().startsWith(srcDir.toLowerCase())) return path.relative(srcDir, abs).split(path.sep).join('/')
    return s.replace(/\\/g, '/')
  }
  let fps = 30
  const timelines: TimelineRef[] = []
  for (const r of refs) {
    let ct: any
    try { ct = readJSON(path.join(srcDir, r.file)) } catch { continue }
    fps = ct.fps || fps
    const aStart = ct.animationStart || 0
    const aDur = ct.animationDuration || ct.duration || 10
    const tracks: Track[] = []
    for (const t of ct.tracks || []) {
      if (t.type === 'video') {
        const segs = (t.clips || []).filter((c: any) => !c.src)
        const clips: Clip[] = segs.length
          ? segs.map((c: any) => ({ id: uid('c'), src: r.animation, start: c.startTime, duration: c.duration, in: c.trimIn || 0, name: 'Animación' }))
          : [{ id: uid('c'), src: r.animation, start: aStart, duration: aDur, in: 0, name: 'Animación' }]
        tracks.push({ id: 'animacion', name: 'Animación', type: 'scene', clips })
      } else if (t.type === 'videoclip' || t.type === 'audio') {
        tracks.push({
          id: slugify(t.id || t.name), name: t.name || t.id, type: t.type === 'audio' ? 'audio' : 'video',
          muted: !!t.muted, solo: !!t.solo, volume: t.volume ?? 1,
          clips: (t.clips || []).filter((c: any) => c.src).map((c: any) => ({
            id: c.id || uid('c'), src: rel(c.src), start: c.startTime ?? c.start ?? 0, duration: c.duration, in: c.trimIn || 0,
            volume: c.volume ?? 1, muted: !!c.muted, name: c.name,
          })),
        })
      }
    }
    // Visuales primero (la primera pista visual queda adelante), audio al final.
    tracks.sort((a, b) => (a.type === 'audio' ? 1 : 0) - (b.type === 'audio' ? 1 : 0))
    const tl: Timeline = {
      format: 'oa-timeline/1', duration: ct.duration || aDur, tracks,
      notes: (ct.annotations || []).map((n: any) => ({ id: n.id || uid('n'), t: n.time, text: n.text })),
    }
    const tid = slugify(r.id)
    writeJSON(path.join(dir, 'timelines', `oa-${tid}.json`), tl)
    timelines.push({ id: tid, name: r.name || r.id, file: `timelines/oa-${tid}.json` })
  }
  const p: Project = {
    format: 'openanimator/1', id, name, width: 1920, height: 1080, fps,
    background: '#000000', timelines, activeTimeline: timelines[0]?.id || 'main',
    createdAt: new Date().toISOString(), importedFrom: srcDir,
  }
  writeJSON(path.join(dir, 'project.json'), p)
  return p
}

// ── vigilancia de cambios (hot reload) ──────────────────────────────────────
export function watchProject(id: string, onChange: (kind: 'timeline' | 'project' | 'files', file: string) => void) {
  const dir = mustDir(id)
  const timers = new Map<string, NodeJS.Timeout>()
  let w: fs.FSWatcher | null = null
  try {
    w = fs.watch(dir, { recursive: true }, (_ev, name) => {
      if (!name) return
      const f = name.toString().replace(/\\/g, '/')
      if (f.endsWith('.tmp') || f === 'thumbnail.jpg' || /(^|\/)(renders|\.oa-cache|node_modules|\.git)(\/|$)/.test(f)) return
      const kind = f === 'project.json' ? 'project' : f.startsWith('timelines/') ? 'timeline' : 'files'
      const key = kind === 'files' ? 'files' : f
      clearTimeout(timers.get(key))
      timers.set(key, setTimeout(() => onChange(kind, f), kind === 'files' ? 400 : 200))
    })
  } catch { /* sin watcher */ }
  return () => { w?.close(); timers.forEach(clearTimeout) }
}
