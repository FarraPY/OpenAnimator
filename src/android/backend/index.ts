/**
 * El "proceso principal" de OpenAnimator en Android: implementa los mismos canales que
 * electron/main.ts (call('projects:list'), on('project:changed'…)), así la interfaz React es la misma
 * en la PC y en la tablet. Lo que en Windows hace Node/FFmpeg acá lo hacen Java (host) y el WebView.
 */
import type { AppInfo, Project, ProjectSummary, Timeline } from '../../api'
import { recoveredBoot } from '../../platform'
import { host } from '../host'
import * as P from './projects'
import * as S from './settings'
import * as M from './media'
import * as F from './frames'
import * as PL from './plugins'
import { basename, dirname, fs, join, normalizeRel, uniqueName } from './fsx'
import { copy, on as onEvent, projectChanged, send, touched } from './events'
import { holdAwake, holdWhileEditing } from './wake'

/** Trabajo largo con la pantalla encendida (si se apaga, Android pausa la página y el trabajo se frena). */
async function awake<T>(work: () => Promise<T>): Promise<T> {
  const release = holdAwake()
  try { return await work() } finally { release() }
}

type Handler = (...args: any[]) => any
const handlers: Record<string, Handler> = {}
const h = (ch: string, fn: Handler) => { handlers[ch] = fn }

const notAvailable = (what: string) => () => { throw new Error(`${what} no está disponible en la versión para Android.`) }

// ── información del equipo ────────────────────────────────────────────────────
let caps: { avc: boolean; hevc: boolean; aac: boolean; encoders: any[] } | null = null
export function codecCaps() {
  if (!caps) { try { caps = host().call('codec.caps') } catch { caps = { avc: true, hevc: false, aac: true, encoders: [] } } }
  return caps!
}
function keyReady() { try { return !!host().call<string>('secrets.masked', { name: 'claude' }) } catch { return false } }
/**
 * Cómo llega el chat a Claude: con el plan del usuario (Claude Code en Termux, o en el iPhone dentro de la misma app)
 * o con una clave de la API (sólo en Android).
 */
const isWeb = () => host().kind === 'web'
const claudeMode = (): ChatMode => (isWeb() ? 'web' : S.getSettings().claude.backend === 'api' ? 'api' : 'termux')
type ChatMode = 'api' | 'termux' | 'web'
/** iPhone: ¿Claude Code instalado y con cuenta? Se averigua al arrancar y con cada cambio (appInfo es sincrónico). */
let webReady = false
let webChecked: Promise<unknown> = Promise.resolve()
function claudeReady() {
  if (claudeMode() === 'api') return keyReady()
  if (claudeMode() === 'web') return webReady
  try { const t = host().call<{ installed: boolean; permission: boolean }>('termux.status'); return t.installed && t.permission } catch { return false }
}

function appInfo(): AppInfo & Record<string, any> {
  const d = host().info
  const c = codecCaps()
  const hw = (type: string) => c.encoders.some((e: any) => e.type === type && e.hardware !== false)
  return {
    version: d.versionName, dataDir: 'Almacenamiento interno de la app', projectsDir: 'Proyectos', portable: true,
    claude: claudeReady() ? claudeMode() : null, ffmpeg: '', gpu: [d.manufacturer, d.model].filter(Boolean).join(' '),
    encoders: { h264_nvenc: false, hevc_nvenc: false, av1_nvenc: false, libx264: false, libx265: false },
    platform: isWeb() ? 'iphone' : 'android', device: d, soc: d.soc, codecs: { avc: c.avc, hevc: c.hevc, aac: c.aac, avcHw: hw('video/avc'), hevcHw: hw('video/hevc') },
  }
}

// ── app ───────────────────────────────────────────────────────────────────────
h('app:info', async () => { await webChecked; return appInfo() })
h('app:versions', () => {
  const d = host().info
  const chrome = /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] || ''
  return { app: d.versionName, electron: '', chrome, node: '', ffmpeg: '', android: d.release, sdk: d.sdk, webview: d.webview || chrome, device: `${d.manufacturer} ${d.model}`, soc: d.soc }
})
h('settings:get', () => S.getSettings())
h('settings:set', (patch) => {
  const s = S.setSettings(patch)
  if (patch?.android) applyAndroidPrefs(s)
  return s
})
h('settings:reset', () => { const s = S.resetSettings(); applyAndroidPrefs(s); return s })
h('settings:pickFile', () => null)
h('settings:pickDir', () => null)
h('cache:stats', () => M.cacheStats())
h('cache:clear', (kind) => M.clearCache(kind))
h('ai:notes:get', () => { S.ensureNotes(); return fs.readText(S.NOTES_FILE) })
h('ai:notes:set', (text: string) => { fs.writeText(S.NOTES_FILE, String(text)); return true })
h('ai:openNotes', () => { S.ensureNotes(); return true })
h('export:defaults', () => exportDefaults())

function applyAndroidPrefs(s = S.getSettings()) {
  const a = s.android
  if (!a) return
  try { host().call('app.immersive', { on: a.immersive }) } catch { /* sin puente */ }
  try { host().call('app.debug', { on: !!a.debug }) } catch { /* sin puente */ }
  document.documentElement.style.setProperty('--ui-scale', String(a.uiScale || 1))
  ;(document.documentElement.style as any).zoom = String(a.uiScale || 1)
}

// ── proyectos ─────────────────────────────────────────────────────────────────
const thumbTried = new Set<string>()
let thumbing = false
/** Miniaturas en curso: se escriben dentro del proyecto, así que mover proyectos las espera. */
let thumbJobs = 0
async function makeThumb(id: string) {
  thumbJobs++
  try { await F.makeThumb(id) } finally { thumbJobs-- }
}
async function thumbsInBackground(ids: string[]) {
  if (thumbing) return
  thumbing = true
  try {
    for (const id of ids) {
      if (moving) break // se están moviendo proyectos: las que faltan se hacen la próxima vez
      thumbTried.add(id); await makeThumb(id); F.closeFramePool(id)
    }
  } finally { thumbing = false }
  send('projects:changed', null)
}
h('projects:list', () => {
  const list = P.listProjects()
  const missing = list.filter((x) => !x.thumb && !thumbTried.has(x.id)).map((x) => x.id)
  if (missing.length) setTimeout(() => thumbsInBackground(missing), 400)
  return list
})
h('projects:templates', () => P.listTemplates())
h('projects:create', (o) => P.createProject(o))
h('projects:delete', (id) => { F.closeFramePool(id); P.deleteProject(id) })
h('projects:duplicate', (id) => P.duplicateProject(id))
h('projects:rename', (id, name) => P.renameProject(id, name))
h('projects:importCoAnimator', notAvailable('Importar de CoAnimator'))
h('projects:openFolder', () => true)
/** Importar un proyecto .zip (elegido con el selector o abierto desde otra app). */
h('projects:importZip', async (path?: string) => {
  let zip = path
  if (!zip) {
    const picked = await host().callAsync<Array<{ path: string; name: string }>>('pick.files', { accept: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'], multiple: false })
    if (!picked.length) return null
    zip = picked[0].path
  }
  const p = await awake(() => P.importZip(zip!, (x) => send('projects:progress', { kind: 'import', p: x })))
  if (zip.startsWith('.incoming/')) fs.deleteAsync(dirname(zip)).catch(() => {})
  send('projects:changed', null)
  return p
})
h('projects:exportZip', async (id: string, o: { includeRenders?: boolean; action?: 'share' | 'save' } = {}) => {
  const r = await awake(() => P.exportZip(id, o, (x) => send('projects:progress', { kind: 'export', id, p: x })))
  if (o.action === 'save') return { ...r, ...(await host().callAsync('file.save', { path: r.path, name: r.name, mime: 'application/zip' })) }
  await host().callAsync('file.share', { path: r.path, name: r.name, mime: 'application/zip', title: 'Compartir proyecto' })
  return r
})
h('app:takePendingOpen', () => host().call('app.takePendingOpen'))
h('app:exits', () => host().call('app.exits'))

// ── papelera ──────────────────────────────────────────────────────────────────
h('trash:list', () => P.listTrashSizes())
h('trash:restore', (id) => { const to = P.restoreTrash(id); send('projects:changed', null); return to })
h('trash:empty', () => P.emptyTrash())
h('trash:delete', (id: string) => fs.deleteAsync(P.trashDir(String(id))))

// ── almacenamiento: la tablet y la tarjeta SD ─────────────────────────────────
type RawStorage = { internal: { free: number; total: number }; sd?: { label: string; uuid: string; free: number; total: number }; newProjects: 'internal' | 'sd'; missing: number; cardLabel: string }
h('storage:info', () => {
  const r = host().call<RawStorage>('storage.info')
  const count = { internal: 0, sd: 0 }
  for (const e of fs.list(P.PROJECTS)) if (e.dir && !e.name.startsWith('.')) count[e.vol === 'sd' ? 'sd' : 'internal']++
  return {
    newProjects: r.newProjects, missing: r.missing, cardLabel: r.cardLabel,
    internal: { ...r.internal, projects: count.internal },
    sd: r.sd ? { ...r.sd, projects: count.sd } : null,
  }
})
/**
 * Qué ocupa OpenAnimator en cada lado. Va aparte de storage:info porque recorre carpetas enteras (en la
 * tarjeta, lento): Java lo mide en segundo plano y sólo lo pide Ajustes › Almacenamiento.
 */
h('storage:usage', async () => {
  const hasSd = !!host().call<RawStorage>('storage.info').sd
  const [all, sdProjects, exports, templates, cache, trash, sdExports, sdTrash] = await Promise.all([
    fs.duAsync(P.PROJECTS), hasSd ? fs.duAsync('@sd/projects') : 0, fs.duAsync('exports'), fs.duAsync(P.USER_TEMPLATES), fs.duAsync('cache'), fs.duAsync('.trash'),
    hasSd ? fs.duAsync('@sd/exports') : 0, hasSd ? fs.duAsync('@sd/.trash') : 0,
  ])
  return { internal: { projects: all - sdProjects, exports, templates, cache, trash }, sd: hasSd ? { projects: sdProjects, exports: sdExports, trash: sdTrash } : null }
})
h('storage:setNew', (volume: 'internal' | 'sd') => { host().call('storage.setNew', { volume }); send('storage:changed', null); return true })
/** Proyectos abiertos en el editor: no se mueven mientras tanto. */
const openProjects = new Map<string, number>()
let moving: { cancel: boolean } | null = null
/**
 * Mueve proyectos entre la tablet y la tarjeta, de a uno (Java copia, verifica y recién ahí borra el
 * original). El progreso de todos juntos llega por storage:progress.
 */
h('storage:move', async (ids: string[], to: 'internal' | 'sd') => {
  if (moving) throw new Error('Ya se están moviendo proyectos: esperá a que termine.')
  const cur = { cancel: false }
  moving = cur
  const release = holdAwake()
  let moved = 0, todo: ProjectSummary[] = []
  try {
    if ((await import('./exporter')).exporting()) throw new Error('Hay una exportación en curso: esperá a que termine para mover proyectos.')
    todo = P.listProjects().filter((p) => ids.includes(p.id) && p.volume !== to)
    for (const p of todo) {
      if (openProjects.get(p.id)) throw new Error(`«${p.name}» está abierto: cerralo para moverlo.`)
      if (await chatBusy(p.id)) throw new Error(`Claude está trabajando en «${p.name}»: esperá a que termine para moverlo.`)
    }
    host().call('storage.cancel', { on: false })
    // Las miniaturas se escriben dentro de los proyectos: se espera la que esté en curso (las demás paran).
    for (let i = 0; thumbJobs > 0 && i < 300; i++) await new Promise((r) => setTimeout(r, 100))
    const sizes = await Promise.all(todo.map((p) => fs.duAsync(join(P.PROJECTS, p.id))))
    const total = sizes.reduce((a, b) => a + b, 0)
    let base = 0
    for (let i = 0; i < todo.length && !cur.cancel; i++) {
      const p = todo[i]
      const tell = (done: number) => send('storage:progress', { to, id: p.id, name: p.name, index: i, count: todo.length, done: base + done, total })
      tell(0)
      F.closeFramePool(p.id)
      await host().callAsync('storage.move', { id: p.id, to }, (e) => { if (e.event === 'progress') tell(Math.min(e.done, sizes[i])) })
      base += sizes[i]
      moved++
    }
  } catch (e: any) {
    if (e?.message === 'Cancelado') return { moved, count: todo.length, cancelled: true }
    throw new Error(moved ? `${e?.message || e} (ya se habían movido ${moved} de ${todo.length})` : String(e?.message || e))
  } finally {
    moving = null
    release()
    send('projects:changed', null)
    send('storage:changed', null)
  }
  return { moved, count: todo.length, cancelled: cur.cancel }
})
h('storage:cancel', () => {
  if (moving) moving.cancel = true
  try { host().call('storage.cancel', { on: true }) } catch { /* sin puente */ }
  return true
})
h('app:toast', (text: string) => { try { host().call('app.toast', { text: String(text) }) } catch { /* sin puente */ } })

// ── proyecto abierto ──────────────────────────────────────────────────────────
/** La pantalla encendida de cada proyecto abierto en el editor (ver holdWhileEditing). */
const editorAwake: Array<() => void> = []
h('project:open', (id) => { const p = P.readProject(id); openProjects.set(id, (openProjects.get(id) || 0) + 1); editorAwake.push(holdWhileEditing()); return p })
/**
 * ¿La miniatura quedó vieja? Si nada cambió desde que se hizo (abrir y cerrar sin tocar), no se rehace: hacerla
 * dibuja el proyecto en el compositor y en la tablet frena ~0,5 s la pantalla de inicio justo al volver.
 */
function thumbStale(id: string) {
  const dir = P.projectDir(id)
  if (!dir || touched.has(id)) return true
  const th = fs.stat(join(dir, 'thumbnail.jpg'))
  if (!th) return true
  const newest = Math.max(fs.stat(join(dir, 'project.json'))?.mtime || 0, ...P.listMaybe(join(dir, 'timelines')).map((e) => e.mtime || 0))
  return newest > th.mtime
}
h('project:close', async (id) => {
  editorAwake.pop()?.()
  const n = (openProjects.get(id) || 1) - 1
  if (n > 0) openProjects.set(id, n)
  else openProjects.delete(id)
  // Si Claude sigue trabajando en el proyecto, el compositor no se cierra (se cierra solo cuando deja de usarse).
  const busy = await chatBusy(id)
  if (!busy) F.closeFramePool(id)
  if (!thumbStale(id)) return
  touched.delete(id)
  await makeThumb(id)
  if (!busy) F.closeFramePool(id)
  send('projects:changed', null)
})
h('project:get', (id) => P.readProject(id))
h('project:save', (p: Project) => { P.writeProject(p); return p })
h('timeline:get', (id, tl) => P.readTimeline(id, tl))
h('timeline:save', (id, tlId, tl: Timeline) => { P.writeTimeline(id, tlId, tl); return tl.rev })
h('timelines:create', (id, name, copyFrom) => P.createTimeline(id, name, copyFrom))
h('timelines:rename', (id, tl, name) => P.renameTimeline(id, tl, name))
h('timelines:delete', (id, tl) => P.deleteTimeline(id, tl))
h('timelines:setActive', (id, tl) => P.setActiveTimeline(id, tl))
h('timelines:move', (id, tl, d) => P.moveTimeline(id, tl, d))
h('assets:list', (id) => P.listAssets(id))
h('assets:import', async (id: string, files?: Array<{ path: string; name: string }>) => {
  if (!files || !files.length || typeof files[0] === 'string') {
    files = await host().callAsync('pick.files', { accept: ['video/*', 'audio/*', 'image/*', 'text/html', 'text/plain', 'text/markdown', 'application/json', 'application/pdf'], multiple: true })
    if (!files || !files.length) return []
  }
  const added = P.addAssets(id, files)
  cleanIncoming(files)
  return added
})
function cleanIncoming(files: Array<{ path: string }>) {
  for (const d of new Set(files.map((f) => dirname(f.path)))) if (d.startsWith('.incoming/')) try { fs.delete(d) } catch { /* ignore */ }
}
const rel = (id: string, r: string) => P.projectFile(id, r)
h('media:probe', (id, r) => M.probe(rel(id, r)))
h('media:peaks', (id, r) => M.audioPeaks(rel(id, r)))
h('media:thumb', (id, r) => M.videoThumb(rel(id, r)))
h('project:reveal', (id, r) => host().callAsync('file.share', { path: rel(id, r || 'project.json') }))
h('project:files', (id) => P.listProjectFiles(id))
h('assets:readText', (id, r) => P.readProjectText(id, r))
h('assets:usage', (id, r) => P.assetUsage(id, r))
h('assets:open', (id, r) => host().callAsync('file.open', { path: rel(id, r) }))
h('assets:share', (id, r) => host().callAsync('file.share', { path: rel(id, r) }))
h('assets:trash', (id, rels: string[]) => {
  for (const r of rels) P.moveToTrash(rel(id, r), `${basename(r)} (${P.readProject(id).name})`)
  return rels.length
})
h('assets:rename', (id: string, r: string, name: string) => {
  const src = rel(id, r)
  const clean = name.replace(/[\\/:*?"<>|]+/g, '-').trim()
  if (!clean) throw new Error('Nombre inválido')
  const dst = join(dirname(src), uniqueName(dirname(src), clean))
  fs.rename(src, dst)
  return dst.slice(P.projectDir(id)!.length + 1)
})

// ── visión / fotogramas ───────────────────────────────────────────────────────
h('frames:png', async (id, tl, t, width) => (await F.renderFrames(id, tl, [t], width || 1280))[0].data)
h('frames:copy', async (id, tl, t) => {
  const [f] = await F.renderFrames(id, tl, [t], 1600)
  const path = join('cache', 'frames', `fotograma-${Date.now()}.png`)
  await fs.writeBytes(path, Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0)))
  await host().callAsync('clipboard.image', { path })
  return true
})
h('frames:share', async (id, tl, t) => {
  const [f] = await F.renderFrames(id, tl, [t], 1920)
  const path = join('cache', 'frames', `fotograma-${Date.now()}.png`)
  await fs.writeBytes(path, Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0)))
  await host().callAsync('file.share', { path, mime: 'image/png', title: 'Compartir fotograma' })
  return true
})
h('frames:contactSheet', async (id, tl, opts) => (await F.contactSheet(id, tl, opts)).jpeg)
h('frames:audit', (id, tl, opts) => F.auditLayout(id, tl, opts))

// ── exportación (se completa en exporter.ts) ──────────────────────────────────
function exportDefaults() {
  const s = S.getSettings()
  return { ...S.DEFAULTS.androidExport, ...(s.androidExport || {}) }
}
h('export:pickOutput', () => null)
h('export:defaultOutput', () => '')
h('export:exists', (file: string) => !!file && fs.exists(file))
h('export:start', async (job) => (await import('./exporter')).startExport(job, (p: unknown) => send('export:progress', p)))
h('export:cancel', async (id) => (await import('./exporter')).cancelExport(id))
h('export:lastDetails', async () => (await import('./exporter')).lastExportDetails())
h('export:list', async () => (await import('./exporter')).listExports())
h('export:delete', (path: string) => { if (/^(@sd\/)?exports\/[^/]+$/.test(path)) fs.delete(path); return true })
h('export:clearCache', (id) => { const d = P.projectDir(id); if (d && fs.exists(join(d, '.oa-cache'))) return fs.deleteAsync(join(d, '.oa-cache')) })
h('export:gallery', (path: string) => host().callAsync('gallery.save', { path }))
h('export:share', (path: string) => host().callAsync('file.share', { path, title: 'Compartir video' }))
h('export:open', (path: string) => host().callAsync('file.open', { path }))
h('export:save', (path: string) => host().callAsync('file.save', { path, name: basename(path) }))

// ── shell ─────────────────────────────────────────────────────────────────────
h('shell:openPath', (p: string) => (p && fs.exists(p) ? host().callAsync('file.open', { path: p }) : null))
h('shell:showItem', (p: string) => (p && fs.exists(p) ? host().callAsync('file.share', { path: p }) : null))
h('shell:openExternal', (u: string) => { if (/^https?:\/\//.test(u)) host().call('app.openUrl', { url: u }) })
h('shell:terminal', notAvailable('La terminal de Claude Code'))

// ── plugins ───────────────────────────────────────────────────────────────────
h('plugins:status', () => PL.pluginStatus())
h('plugins:setKey', (id, key) => PL.setKey(id, key))
h('plugins:test', (id) => PL.testPlugin(id))
h('plugins:voices', (provider, q) => PL.listVoices(provider, q))
h('plugins:whisperModels', () => [])
// Whisper en la tablet: whisper.cpp en Termux (Ajustes › Plugins › Whisper)
h('whisper:status', () => PL.whisperInfo())
h('whisper:install', (model: string) => PL.whisperInstall(String(model || '')))
h('whisper:remove', (model: string) => PL.whisperRemove(String(model || '')))
h('whisper:test', (model?: string) => PL.whisperTest(model ? String(model) : undefined))
h('plugins:installYtdlp', notAvailable('yt-dlp'))
h('plugins:loginCodex', notAvailable('ChatGPT con Codex CLI'))
h('plugins:image', async (projectId, req) => { const r = await PL.generateImage(projectId, req); projectChanged(projectId, r.path); return r })
h('plugins:tts', async (projectId, req) => { const r = await PL.tts(projectId, req); projectChanged(projectId, r.path); return r })
h('plugins:sfx', async (projectId, req) => { const r = await PL.sfx(projectId, req); projectChanged(projectId, r.path); return r })
h('plugins:ask', (req) => PL.ask(req))

// ── Claude (clave de API) ─────────────────────────────────────────────────────
h('claude:status', () => ({ ready: keyReady(), masked: host().call<string>('secrets.masked', { name: 'claude' }) }))
h('claude:setKey', (key: string) => { host().call('secrets.set', { name: 'claude', value: key || '' }); return { ready: keyReady(), masked: host().call<string>('secrets.masked', { name: 'claude' }) } })
h('claude:test', async () => (await engine()).testClaude())
// Claude Code dentro del iPhone (webclaude.ts): instalarlo, la cuenta (token de `claude setup-token`) y la última versión
const webclaude = () => import('./webclaude')
h('claude:webStatus', async () => { const st = await (await webclaude()).status(); webReady = st.ready; return st })
h('claude:install', async (version?: string) => { const W = await webclaude(); const m = await W.install(version || undefined); webReady = (await W.status()).ready; return m })
h('claude:setToken', async (token: string) => { const st = await (await webclaude()).setToken(token); webReady = st.ready; return st })
h('claude:login', async () => { const W = await webclaude(); const st = await W.setToken(await W.login()); webReady = st.ready; return st })
h('claude:latest', async () => (await webclaude()).latest())
// Claude Code en Termux (el plan del usuario)
const termux = () => import('./termux')
h('termux:status', async () => { const T = await termux(); return { ...T.termuxStatus(), command: T.SETUP_COMMAND } })
h('termux:permission', async () => (await termux()).requestPermission())
h('termux:open', async () => (await termux()).openTermux())
h('termux:login', async () => (await termux()).login())
h('termux:check', async () => (await termux()).bridgeStatus())
h('app:openSettings', () => host().call('app.openSettings'))
h('clipboard:text', (text: string) => host().call('clipboard.text', { text: String(text || '') }))

// ── plantillas del usuario ────────────────────────────────────────────────────
h('templates:saveProject', async (projectId, o) => {
  if (!fs.exists(join(P.projectDir(projectId)!, 'thumbnail.jpg'))) await makeThumb(projectId)
  return P.saveProjectAsTemplate(projectId, o)
})
h('templates:get', (id) => P.getTemplate(id))
h('templates:delete', (id) => P.deleteTemplate(id))
h('templates:update', (id, patch) => P.updateTemplate(id, patch))
h('templates:openFolder', () => true)

// ── analizador de video (PC) ──────────────────────────────────────────────────
h('analyze:phases', () => [])
for (const ch of ['analyze:pickFile', 'analyze:start', 'analyze:cancel', 'analyze:discard', 'analyze:save']) h(ch, notAvailable('Crear plantillas analizando un video'))

// ── chat con Claude: por la API (agent.ts) o con Claude Code en Termux (code.ts) ─
const agent = () => import('./agent')
const code = () => import('./code')
const chatMode = new Map<string, ChatMode>() // cada chat sigue con el camino con el que se abrió
const chatProject = new Map<string, string>()
const engine = async (id?: string) => {
  const mode = (id && chatMode.get(id)) || claudeMode()
  return mode === 'api' ? agent() : mode === 'web' ? webclaude() : code()
}
/**
 * Conversaciones sin editor abierto (el usuario fue a Ajustes o al inicio): siguen trabajando y el
 * editor las retoma al volver al proyecto. Se cierran solas tras media hora sin actividad.
 */
const parked = new Map<string, { id: string; since: number }>() // proyecto → conversación
/**
 * Android reinició la página (el motor web se cerró por falta de memoria): con Claude en Termux, las
 * conversaciones siguieron corriendo en el puente y se retoman antes de que el editor pida la suya.
 */
let adopting: Promise<void> | null = null
function adoptAfterRestart() {
  if (!recoveredBoot || claudeMode() !== 'termux') return
  adopting = (async () => {
    const T = await import('./termux')
    const st = T.termuxStatus()
    if (!st.installed || !st.permission) return
    const C = await code()
    C.enableAdoption((id, projectId) => { chatMode.set(id, 'termux'); chatProject.set(id, projectId); parked.set(projectId, { id, since: Date.now() }) })
    await T.bridge()
  })().catch((e) => console.error('No se pudieron retomar las conversaciones:', e)).finally(() => { adopting = null })
}
const PARK_MS = 30 * 60e3
async function chatBusy(projectId: string) {
  for (const [id, pid] of chatProject) if (pid === projectId && (await (await engine(id)).getChat(id))?.busy) return true
  return false
}
async function killChat(id: string) {
  try { (await engine(id)).killChat(id) } finally {
    chatMode.delete(id); chatProject.delete(id)
    for (const [projectId, p] of parked) if (p.id === id) parked.delete(projectId)
  }
}
setInterval(async () => {
  for (const [projectId, p] of [...parked]) {
    const s = await (await engine(p.id)).getChat(p.id)
    if (!s) { parked.delete(projectId); continue }
    if (s.busy) { p.since = Date.now(); continue }
    if (Date.now() - p.since > PARK_MS) await killChat(p.id)
  }
}, 60e3)
h('chat:pickFiles', async () => host().callAsync('pick.files', { accept: [], multiple: true }))
h('chat:attach', async (projectId, files) => (await agent()).attachFiles(projectId, files))
h('chat:attachData', async (projectId, name, b64) => (await agent()).attachData(projectId, name, b64))
h('chat:create', async (projectId, opts) => {
  const mode = claudeMode()
  const snap = await (await engine()).createChat(projectId, opts)
  chatMode.set(snap.id, mode)
  chatProject.set(snap.id, projectId)
  return snap
})
h('chat:get', async (id) => (await engine(id)).getChat(id))
// El editor se cierra: la conversación sigue (si está trabajando, termina el turno) y queda para retomarla.
h('chat:leave', async (id) => {
  const projectId = chatProject.get(id)
  if (!projectId) return
  const old = parked.get(projectId)
  if (old && old.id !== id) await killChat(old.id)
  parked.set(projectId, { id, since: Date.now() })
})
// El editor vuelve a abrir el proyecto: retoma la conversación que dejó (o null para empezar una nueva).
h('chat:forProject', async (projectId) => {
  if (adopting) await Promise.race([adopting, new Promise((r) => setTimeout(r, 20000))])
  const p = parked.get(projectId)
  parked.delete(projectId)
  return p ? (await engine(p.id)).getChat(p.id) : null
})
h('chat:sessions', async (projectId) => (await engine()).listSessions(projectId))
h('chat:compact', async (id, instr) => (await engine(id)).compactChat(id, instr))
const editorCtx = new Map<string, { timeline: string; t: number }>()
h('chat:setCtx', (projectId, ctx) => { editorCtx.set(projectId, ctx) })
h('chat:getCtx', (projectId) => editorCtx.get(projectId) || null)
h('chat:popout', () => true)
h('chat:popin', () => true)
h('chat:isPopped', () => false)
h('chat:send', async (id, text, images, files) => (await engine(id)).sendChat(id, text, images || [], files || []))
h('chat:interrupt', async (id) => (await engine(id)).interruptChat(id))
h('chat:permission', async (id, itemId, allow, always) => (await engine(id)).respondPermission(id, itemId, allow, !!always))
h('chat:kill', (id) => killChat(id))
h('chat:setOptions', async (id, patch, label) => {
  const cur = S.getSettings().claude
  S.setSettings({ claude: { ...cur, ...patch } })
  return (await engine(id)).setChatOptions(id, patch, label)
})

// ── instalación: window.oa ────────────────────────────────────────────────────
export function installBackend(platform: 'android' | 'iphone' = 'android') {
  const hst = host()
  const oa = {
    platform,
    appOrigin: hst.appOrigin,
    projectOrigin: hst.projectOrigin,
    async call(ch: string, ...args: unknown[]) {
      const fn = handlers[ch]
      if (!fn) throw new Error(`No disponible en ${platform === 'iphone' ? 'el iPhone' : 'Android'}: ${ch}`)
      // Copias en los dos sentidos, como el IPC de la PC (ver events.ts).
      return copy(await fn(...args.map(copy)))
    },
    on: onEvent,
    pathForFile: () => '',
  }
  ;(window as any).oa = oa
  // Primer arranque: carpetas, notas para la IA, papelera vieja, preferencias de pantalla.
  try {
    fs.mkdir(P.PROJECTS)
    S.ensureNotes()
    applyAndroidPrefs()
    setTimeout(() => { P.emptyTrash(30).catch(() => {}); for (const e of fs.list('.incoming')) if (Date.now() - e.mtime > 86400000) fs.deleteAsync(join('.incoming', e.name)).catch(() => {}) }, 5000)
  } catch (e) { console.error(e) }
  hst.onEvent('open', () => send('app:open', null))
  hst.onEvent('pause', () => send('app:pause', null))
  hst.onEvent('resume', () => send('app:resume', null))
  hst.onEvent('memory', () => F.trimFramePool())
  // Pusieron o sacaron la tarjeta SD: cambia la lista de proyectos.
  hst.onEvent('storage', () => { send('storage:changed', null); send('projects:changed', null) })
  adoptAfterRestart()
  if (isWeb()) webChecked = import('./webclaude').then((W) => W.status()).then((st) => { webReady = st.ready }).catch(() => {})
  return oa
}

export { normalizeRel }
