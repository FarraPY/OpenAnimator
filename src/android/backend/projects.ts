/**
 * Proyectos de OpenAnimator en Android: el mismo formato abierto que en la PC (docs/formato-proyecto.md),
 * así un proyecto se puede pasar de un equipo al otro como .zip.
 *
 *   projects/<id>/project.json · timelines/*.json · scenes/ · assets/ · renders/
 *                                      en la tablet o en la tarjeta SD (Fs.java los junta)
 *   templates/u-<id>/                  plantillas del usuario
 *   .trash/ y @sd/.trash/              papelera de cada lugar (se vacía sola a los 30 días)
 *   exports/ y @sd/exports/            videos y .zip exportados, del lado del proyecto
 */
import type { Asset, Clip, Project, ProjectSummary, Template, Timeline, TimelineRef, Track } from '../../api'
import { basename, dirname, Entry, extname, fs, join, normalizeRel, slugify, stem, uid, uniqueName, Volume } from './fsx'

export const PROJECTS = 'projects'
export const USER_TEMPLATES = 'templates'
/** Lo borrado de la tarjeta SD queda en la tarjeta: pasarlo a la tablet la llenaría (y tardaría). */
const TRASH = '.trash', SD_TRASH = '@sd/.trash', SD_ITEM = 'sd~'

// ── recursos incluidos en la app (plantillas, guías para la IA) ────────────────
type Manifest = { templates: Record<string, string[]>; ai: string[]; version?: string }
let manifest: Promise<Manifest> | null = null
export function appManifest() {
  if (!manifest) manifest = fetch('/app/manifest.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ templates: {}, ai: [] }))
  return manifest
}
const TEXT_EXT = /\.(html?|js|mjs|css|json|md|txt|svg|csv|srt|vtt)$/i
async function copyAppFile(url: string, dest: string) {
  const r = await fetch(url, { cache: 'no-store' })
  if (!r.ok) throw new Error(`Falta un archivo de la app: ${url}`)
  if (TEXT_EXT.test(dest)) fs.writeText(dest, await r.text())
  else await fs.writeBytes(dest, await r.arrayBuffer())
}

// ── registro ──────────────────────────────────────────────────────────────────
export function projectDir(id: string): string | null {
  if (!id || id.includes('..') || /[\\/]/.test(id)) return null
  const d = join(PROJECTS, id)
  return fs.exists(join(d, 'project.json')) ? d : null
}
function mustDir(id: string) {
  const d = projectDir(id)
  if (!d) throw new Error(`Proyecto no encontrado: ${id}`)
  return d
}
function uniqueDir(parent: string, base: string) {
  let id = base, n = 2
  while (fs.exists(join(parent, id))) id = `${base}-${n++}`
  return id
}

export function readProject(id: string): Project { return fs.readJSON<Project>(join(mustDir(id), 'project.json')) }
export function writeProject(p: Project) {
  p.updatedAt = new Date().toISOString()
  fs.writeJSON(join(mustDir(p.id), 'project.json'), p)
}

export function timelineFile(p: Project, tlId?: string) {
  const ref = p.timelines.find((t) => t.id === (tlId || p.activeTimeline)) || p.timelines[0]
  if (!ref) throw new Error('El proyecto no tiene timelines')
  return { ref, file: join(mustDir(p.id), normalizeRel(ref.file)) }
}
export function readTimeline(id: string, tlId?: string): Timeline {
  const p = readProject(id)
  const tl = fs.readJSON<Timeline>(timelineFile(p, tlId).file)
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
  fs.writeJSON(file, tl)
  try { writeProject(p) } catch { /* ignore */ }
}

export function thumbUrl(id: string) {
  const st = fs.stat(join(PROJECTS, id, 'thumbnail.jpg'))
  return st ? `${fs.url(join(PROJECTS, id, 'thumbnail.jpg'))}?v=${Math.round(st.mtime)}` : undefined
}

export function listProjects(): ProjectSummary[] {
  const out: ProjectSummary[] = []
  for (const e of fs.list(PROJECTS)) {
    if (!e.dir || e.name.startsWith('.')) continue
    try {
      // Sin preguntar antes si existe: cada consulta cruza el puente con Java (una carpeta sin proyecto se ignora igual).
      const p = fs.readJSON<Project>(join(PROJECTS, e.name, 'project.json'))
      let duration = 0
      for (const ref of p.timelines || []) {
        try { duration += fs.readJSON<Timeline>(join(PROJECTS, e.name, normalizeRel(ref.file))).duration || 0 } catch { /* ignore */ }
      }
      out.push({ id: e.name, name: p.name, width: p.width, height: p.height, fps: p.fps, timelines: (p.timelines || []).length, duration, updatedAt: p.updatedAt, thumb: thumbUrl(e.name), volume: e.vol === 'sd' ? 'sd' : 'internal' })
    } catch { /* proyecto roto: se ignora en la lista */ }
  }
  return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
}

// ── papelera ──────────────────────────────────────────────────────────────────
/** Mueve a la papelera de su lugar (se puede recuperar desde Ajustes durante 30 días). */
export function moveToTrash(rel: string, label?: string) {
  if (!fs.exists(rel)) return
  const id = `${Date.now().toString(36)}-${slugify(basename(rel)).slice(0, 30)}`
  const dir = join(fs.volume(rel) === 'sd' ? SD_TRASH : TRASH, id)
  fs.mkdir(dir)
  fs.writeJSON(join(dir, 'trash.json'), { from: rel, name: basename(rel), label: label || basename(rel), at: new Date().toISOString() })
  fs.rename(rel, join(dir, 'item'))
}
/** Carpeta de un elemento de la papelera (los de la tarjeta SD tienen id «sd~…»). */
export function trashDir(id: string) {
  const sd = id.startsWith(SD_ITEM), name = sd ? id.slice(SD_ITEM.length) : id
  if (!/^[\w-][\w.-]*$/.test(name)) throw new Error('Elemento inválido')
  return join(sd ? SD_TRASH : TRASH, name)
}
/** Lista una carpeta que puede no estar (la de la tarjeta SD, si la sacaron). */
export function listMaybe(dir: string): Entry[] {
  try { return fs.list(dir) } catch { return [] }
}
export type TrashItem = { id: string; from: string; name: string; label: string; at: string; size: number; sd?: boolean }
export function listTrash(): TrashItem[] {
  const out: TrashItem[] = []
  for (const [root, prefix] of [[TRASH, ''], [SD_TRASH, SD_ITEM]]) {
    for (const e of listMaybe(root)) {
      try { out.push({ ...fs.readJSON<Omit<TrashItem, 'id' | 'size'>>(join(root, e.name, 'trash.json')), id: prefix + e.name, size: 0, ...(prefix ? { sd: true } : {}) }) } catch { /* ignore */ }
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at))
}
/** La papelera con el tamaño de cada elemento (Java lo mide en segundo plano). */
export async function listTrashSizes(): Promise<TrashItem[]> {
  const items = listTrash()
  const sizes = await Promise.all(items.map((t) => fs.duAsync(trashDir(t.id))))
  return items.map((t, i) => ({ ...t, size: sizes[i] }))
}
export function restoreTrash(id: string) {
  const dir = trashDir(id)
  const meta = fs.readJSON<{ from: string }>(join(dir, 'trash.json'))
  let to = meta.from
  if (fs.exists(to)) to = join(dirname(to), uniqueName(dirname(to), basename(to)))
  fs.rename(join(dir, 'item'), to)
  fs.delete(dir)
  return to
}
export async function emptyTrash(olderThanDays = 0) {
  const limit = Date.now() - olderThanDays * 86400000
  for (const t of listTrash()) if (!olderThanDays || new Date(t.at).getTime() < limit) await fs.deleteAsync(trashDir(t.id))
}

// ── dónde está cada proyecto ──────────────────────────────────────────────────
/** 'sd' si el proyecto está en la tarjeta SD. */
export function projectVolume(id: string): Volume { return fs.volume(mustDir(id)) }
/** Exportaciones del lado del proyecto: un video de un proyecto de la tarjeta no llena la tablet. */
export function exportsDir(id: string) { return projectVolume(id) === 'sd' ? '@sd/exports' : 'exports' }

// ── plantillas ────────────────────────────────────────────────────────────────
const templateCache = new Map<string, any>()
async function builtinTemplate(id: string) {
  if (!templateCache.has(id)) templateCache.set(id, await fetch(`/app/templates/${encodeURIComponent(id)}/template.json`, { cache: 'no-store' }).then((r) => r.json()))
  return templateCache.get(id)
}
function userTemplateDir(id: string) {
  if (!id || id.includes('..') || /[\\/]/.test(id) || !id.startsWith('u-')) return null
  const d = join(USER_TEMPLATES, id)
  return fs.exists(join(d, 'template.json')) ? d : null
}

export async function listTemplates(): Promise<Template[]> {
  const m = await appManifest()
  const app: Template[] = []
  for (const id of Object.keys(m.templates)) {
    try {
      const j = await builtinTemplate(id)
      const { timeline: _t, analysis, ...rest } = j
      app.push({ id, ...rest, defaults: j.defaults || { duration: j.timeline?.duration || 10 }, preview: m.templates[id].includes('preview.jpg') ? `/app/templates/${encodeURIComponent(id)}/preview.jpg` : undefined, user: false, hasAnalysis: !!analysis })
    } catch { /* ignore */ }
  }
  app.sort((a: any, b: any) => (a.order ?? 99) - (b.order ?? 99))
  const user: Template[] = []
  for (const e of fs.list(USER_TEMPLATES)) {
    const d = join(USER_TEMPLATES, e.name)
    if (!e.dir || !fs.exists(join(d, 'template.json'))) continue
    try {
      const j = fs.readJSON(join(d, 'template.json'))
      const st = fs.stat(join(d, 'preview.jpg'))
      const { timeline: _t, analysis, ...rest } = j
      user.push({ id: e.name, ...rest, defaults: j.defaults || { duration: j.timeline?.duration || 10 }, preview: st ? `${fs.url(join(d, 'preview.jpg'))}?v=${Math.round(st.mtime)}` : undefined, user: true, hasAnalysis: !!analysis })
    } catch { /* ignore */ }
  }
  user.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  return [...app, ...user]
}

export async function getTemplate(id: string) {
  const d = userTemplateDir(id)
  if (d) return { id, ...fs.readJSON(join(d, 'template.json')) }
  const m = await appManifest()
  if (!m.templates[id]) throw new Error('Plantilla no encontrada: ' + id)
  return { id, ...(await builtinTemplate(id)) }
}
export function deleteTemplate(id: string) {
  const d = userTemplateDir(id)
  if (!d) throw new Error('Las plantillas incluidas no se pueden borrar')
  moveToTrash(d, `Plantilla «${fs.readJSON(join(d, 'template.json')).name || id}»`)
}
export function updateTemplate(id: string, patch: { name?: string; description?: string }) {
  const d = userTemplateDir(id)
  if (!d) throw new Error('Las plantillas incluidas no se pueden editar')
  const f = join(d, 'template.json')
  const j = fs.readJSON(f)
  if (patch.name?.trim()) j.name = patch.name.trim()
  if (patch.description != null) j.description = patch.description
  fs.writeJSON(f, j)
}

const TEMPLATE_SKIP = /^(renders|timelines|\.oa-cache|\.claude|\.oa-chat|\.trash|node_modules|\.git|seg|\.migration-backup|_analisis)(\/|$)|^(project\.json|coanimator-project\.json|thumbnail\.jpg)$/

/** Copia una carpeta de datos a otra, archivo por archivo, salteando lo que `skip` indique. */
function copyFiltered(src: string, dst: string, skip: (rel: string) => boolean, volume?: Volume) {
  fs.mkdir(dst, volume)
  for (const e of fs.walk(src, { skipHidden: false, depth: 12, max: 20000 })) {
    const rel = e.path!
    if (skip(rel) || rel.split('/').some((_, i, a) => skip(a.slice(0, i + 1).join('/')))) continue
    if (e.dir) fs.mkdir(join(dst, rel))
    else fs.copy(join(src, rel), join(dst, rel))
  }
}

export function saveProjectAsTemplate(projectId: string, o: { name: string; description?: string; includeAssets?: boolean; guide?: string; analysis?: any; tags?: string[] }) {
  const src = mustDir(projectId)
  const p = readProject(projectId)
  const id = uniqueDir(USER_TEMPLATES, 'u-' + slugify(o.name || p.name))
  const dir = join(USER_TEMPLATES, id)
  const files = join(dir, 'files')
  const skipAssets = o.includeAssets === false
  const isMedia = (rel: string) => /\.(mp4|webm|mov|mkv|m4v|mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(rel)
  copyFiltered(src, files, (rel) => TEMPLATE_SKIP.test(rel) || (skipAssets && (rel === 'assets' || rel.startsWith('assets/') || rel.startsWith('adjuntos/') || isMedia(rel))))
  const tl = readTimeline(projectId)
  const exists = (rel: string) => fs.exists(join(files, normalizeRel(rel)))
  const timeline: Timeline = { format: 'oa-timeline/1', duration: tl.duration, notes: [], tracks: tl.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => exists(c.src)) })) }
  if (o.guide || !fs.exists(join(files, 'PLANTILLA.md'))) {
    fs.writeText(join(files, 'PLANTILLA.md'), o.guide || `# Plantilla «${o.name}»\n\n${o.description || ''}\n\nCreada a partir del proyecto «${p.name}». Mantené el mismo estilo visual (paleta, tipografía, animaciones y ritmo) de las escenas incluidas y cambiá el contenido según el brief.\n`)
  }
  fs.writeJSON(join(dir, 'template.json'), {
    name: o.name || p.name, description: o.description || '', user: true, createdAt: new Date().toISOString(), fromProject: p.name,
    width: p.width, height: p.height, fps: p.fps, background: p.background || '#000000', tags: o.tags || [],
    substitute: fs.exists(join(files, 'brief.md')) ? ['brief.md'] : [], timeline, ...(o.analysis ? { analysis: o.analysis } : {}),
  })
  if (fs.exists(join(src, 'thumbnail.jpg'))) fs.copy(join(src, 'thumbnail.jpg'), join(dir, 'preview.jpg'))
  return { id, dir }
}

// ── crear / duplicar / borrar ─────────────────────────────────────────────────
export async function createProject(opts: { name: string; template: string; width?: number; height?: number; fps?: number; volume?: Volume }): Promise<Project> {
  const tpl = await getTemplate(opts.template)
  const id = uniqueDir(PROJECTS, slugify(opts.name))
  const dir = join(PROJECTS, id)
  const udir = userTemplateDir(opts.template)
  fs.mkdir(dir, opts.volume === 'sd' || opts.volume === 'internal' ? opts.volume : undefined)
  if (udir) {
    if (fs.exists(join(udir, 'files'))) copyFiltered(join(udir, 'files'), dir, () => false)
  } else {
    const m = await appManifest()
    for (const f of (m.templates[opts.template] || []).filter((x) => x.startsWith('files/'))) {
      await copyAppFile(`/app/templates/${encodeURIComponent(opts.template)}/${f.split('/').map(encodeURIComponent).join('/')}`, join(dir, f.slice(6)))
    }
  }
  const tokens: Record<string, string> = { PROJECT_NAME: opts.name, PROJECT_ID: id, DATE: new Date().toISOString() }
  for (const rel of tpl.substitute || []) {
    const f = join(dir, normalizeRel(rel))
    if (!fs.exists(f)) continue
    fs.writeText(f, fs.readText(f).replace(/\{\{(\w+)\}\}/g, (m: string, k: string) => tokens[k] ?? m))
  }
  for (const d of ['assets', 'renders', 'timelines', 'scripts']) fs.mkdir(join(dir, d))
  const p: Project = {
    format: 'openanimator/1', id, name: opts.name,
    width: opts.width || tpl.width || 1920, height: opts.height || tpl.height || 1080, fps: opts.fps || tpl.fps || 30,
    background: tpl.background || '#000000',
    timelines: [{ id: 'main', name: 'Principal', file: 'timelines/main.json' }], activeTimeline: 'main',
    template: opts.template,
  }
  ;(p as any).createdAt = new Date().toISOString()
  fs.writeJSON(join(dir, 'project.json'), p)
  if (!fs.exists(join(dir, 'timelines', 'main.json'))) {
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
    fs.writeJSON(join(dir, 'timelines', 'main.json'), tl)
  }
  return p
}

export function deleteProject(id: string) {
  const d = mustDir(id)
  moveToTrash(d, `Proyecto «${readProject(id).name}»`)
}

export function duplicateProject(id: string): Project {
  const src = mustDir(id)
  const p = readProject(id)
  const nid = uniqueDir(PROJECTS, `${id}-copia`)
  // La copia queda al lado del original (en la tablet o en la tarjeta SD).
  copyFiltered(src, join(PROJECTS, nid), (rel) => rel.startsWith('renders/') || rel === 'renders' || rel.startsWith('.oa-cache') || rel.startsWith('.oa-chat'), fs.volume(src))
  const np: any = { ...p, id: nid, name: `${p.name} (copia)`, createdAt: new Date().toISOString() }
  fs.writeJSON(join(PROJECTS, nid, 'project.json'), np)
  return np
}

export function renameProject(id: string, name: string) { const p = readProject(id); p.name = name; writeProject(p) }

// ── timelines ─────────────────────────────────────────────────────────────────
export function createTimeline(id: string, name: string, copyFrom?: string): Project {
  const p = readProject(id)
  const tid = (() => { const b = slugify(name); let s = b, n = 2; while (p.timelines.some((t) => t.id === s)) s = `${b}-${n++}`; return s })()
  const base: Timeline = copyFrom ? readTimeline(id, copyFrom) : {
    format: 'oa-timeline/1', duration: 10, notes: [],
    tracks: [{ id: 'escenas', name: 'Escenas', type: 'scene', clips: [] }, { id: 'voz', name: 'Voz', type: 'audio', clips: [] }],
  }
  const ref: TimelineRef = { id: tid, name, file: `timelines/${tid}.json` }
  fs.writeJSON(join(mustDir(id), ref.file), { ...base, rev: 0 })
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
  try { fs.rename(join(mustDir(id), normalizeRel(r.file)), join(mustDir(id), normalizeRel(r.file) + '.deleted')) } catch { /* ignore */ }
  writeProject(p)
  return p
}
export function setActiveTimeline(id: string, tlId: string) { const p = readProject(id); p.activeTimeline = tlId; writeProject(p); return p }
export function moveTimeline(id: string, tlId: string, delta: number) {
  const p = readProject(id); const i = p.timelines.findIndex((t) => t.id === tlId); const j = i + delta
  if (i >= 0 && j >= 0 && j < p.timelines.length) { const [x] = p.timelines.splice(i, 1); p.timelines.splice(j, 0, x) }
  writeProject(p); return p
}

// ── medios ────────────────────────────────────────────────────────────────────
export const KIND: Record<string, Asset['kind']> = {
  '.html': 'scene', '.htm': 'scene', '.mp4': 'video', '.webm': 'video', '.mov': 'video', '.mkv': 'video', '.m4v': 'video',
  '.mp3': 'audio', '.wav': 'audio', '.ogg': 'audio', '.m4a': 'audio', '.aac': 'audio', '.flac': 'audio', '.opus': 'audio',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.svg': 'image', '.avif': 'image',
  '.md': 'doc', '.txt': 'doc', '.pdf': 'doc', '.srt': 'doc', '.vtt': 'doc', '.csv': 'doc', '.docx': 'doc', '.json': 'doc',
}
const HIDDEN_FILES = /^(project\.json|thumbnail\.jpg|CLAUDE\.md|AGENTS\.md|PLANTILLA\.md)$|(^|\/)(package(-lock)?\.json|tsconfig\.json)$|^assets\/voz\/.*\/tiempos\.json$/
const SKIP_DIRS = ['timelines', 'renders', 'node_modules', '.git', '.oa-cache', '.migration-backup', '.claude', 'research', 'seg']

export function listAssets(id: string): Asset[] {
  const dir = mustDir(id)
  const out: Asset[] = []
  for (const e of fs.walk(dir, { depth: 6, max: 6000, skipHidden: true, skipDirs: SKIP_DIRS })) {
    const r = e.path!
    if (e.dir || HIDDEN_FILES.test(r) || r.split('/').slice(0, -1).some((d) => SKIP_DIRS.includes(d))) continue
    const kind = KIND[extname(r)]
    if (!kind) continue
    out.push({ path: r, name: e.name, kind, size: e.size, mtime: e.mtime })
    if (out.length > 5000) break
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/** Ruta de datos de un archivo del proyecto, sin permitir salir de su carpeta. */
export function projectFile(id: string, rel: string) { return join(mustDir(id), normalizeRel(rel)) }

export function listProjectFiles(id: string): Array<{ path: string; size: number; dir: boolean }> {
  const skip = ['node_modules', 'renders', 'seg']
  return fs.walk(mustDir(id), { depth: 6, max: 4000, skipHidden: true, skipDirs: skip })
    .filter((e) => !skip.includes(e.name))
    .map((e) => ({ path: e.path!, size: e.size, dir: e.dir }))
}

export function readProjectText(id: string, rel: string, max = 200000) { return fs.readTextLimited(projectFile(id, rel), max) }

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

/** Mueve archivos recién elegidos (data/.incoming/…) a scenes/ o assets/ del proyecto. */
export function addAssets(id: string, files: Array<{ path: string; name: string }>): string[] {
  const dir = mustDir(id)
  const added: string[] = []
  for (const f of files) {
    const sub = KIND[extname(f.name)] === 'scene' ? 'scenes' : 'assets'
    fs.mkdir(join(dir, sub))
    const name = uniqueName(join(dir, sub), f.name)
    fs.rename(f.path, join(dir, sub, name))
    added.push(`${sub}/${name}`)
  }
  return added
}

// ── importar / exportar proyectos (.zip) ──────────────────────────────────────
/** Importa un .zip (de la PC o de otra tablet) como proyecto nuevo. */
export async function importZip(zipPath: string, onProgress?: (p: number) => void): Promise<Project> {
  const tmpId = `.import-${Date.now().toString(36)}`
  const tmp = join(PROJECTS, tmpId)
  try {
    const { host } = await import('../host')
    const ok = await host().callAsync<boolean>('zip.import', { zip: zipPath, dest: tmp }, (e) => { if (e.event === 'progress' && e.total) onProgress?.(e.done / e.total) })
    if (!ok) throw new Error('El .zip no tiene un proyecto de OpenAnimator (falta project.json).')
    const p = fs.readJSON<Project>(join(tmp, 'project.json'))
    if (p.format !== 'openanimator/1' && !(p as any).timelines) throw new Error('El project.json no es de OpenAnimator.')
    const id = uniqueDir(PROJECTS, slugify(p.id || p.name || stem(zipPath)))
    fs.rename(tmp, join(PROJECTS, id))
    const np: Project = { ...p, id, updatedAt: new Date().toISOString() }
    fs.writeJSON(join(PROJECTS, id, 'project.json'), np)
    return np
  } finally {
    if (fs.exists(tmp)) await fs.deleteAsync(tmp)
    if (zipPath.startsWith('.incoming/')) try { fs.delete(dirname(zipPath)) } catch { /* ignore */ }
  }
}

/** Arma exports/<nombre>.zip (o @sd/exports/, si el proyecto está en la tarjeta) sin cachés; las exportaciones, opcionales. */
export async function exportZip(id: string, o: { includeRenders?: boolean } = {}, onProgress?: (p: number) => void) {
  const dir = mustDir(id)
  const p = readProject(id)
  const name = `${(p.name || id).replace(/[<>:"/\\|?*]+/g, '-').trim() || id}.zip`
  const ex = exportsDir(id)
  fs.mkdir(ex)
  const out = join(ex, name)
  const { host } = await import('../host')
  const skip = `^(\\.oa-cache|\\.oa-chat|\\.trash|node_modules|\\.git${o.includeRenders ? '' : '|renders'})(/|$)|(^|/)\\.[^/]*\\.tmp$`
  await host().callAsync('zip.export', { dir, out, prefix: id, skip }, (e) => { if (e.event === 'progress' && e.total) onProgress?.(e.done / e.total) })
  return { path: out, name }
}

export type { Clip, Track }
