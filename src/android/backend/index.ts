/**
 * El "proceso principal" de OpenAnimator en Android: implementa los mismos canales que
 * electron/main.ts (call('projects:list'), on('project:changed'…)), así la interfaz React es la misma
 * en la PC y en la tablet. Lo que en Windows hace Node/FFmpeg acá lo hacen Java (host) y el WebView.
 */
import type { AppInfo, Project, Timeline } from '../../api'
import { host } from '../host'
import * as P from './projects'
import * as S from './settings'
import * as M from './media'
import * as F from './frames'
import * as PL from './plugins'
import { basename, dirname, fs, join, normalizeRel, uniqueName } from './fsx'
import { on as onEvent, projectChanged, send } from './events'

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
function claudeReady() { try { return !!host().call<string>('secrets.masked', { name: 'claude' }) } catch { return false } }

function appInfo(): AppInfo & Record<string, any> {
  const d = host().info
  const c = codecCaps()
  const hw = (type: string) => c.encoders.some((e: any) => e.type === type && e.hardware !== false)
  return {
    version: d.versionName, dataDir: 'Almacenamiento interno de la app', projectsDir: 'Proyectos', portable: true,
    claude: claudeReady() ? 'api' : null, ffmpeg: '', gpu: [d.manufacturer, d.model].filter(Boolean).join(' '),
    encoders: { h264_nvenc: false, hevc_nvenc: false, av1_nvenc: false, libx264: false, libx265: false },
    platform: 'android', device: d, soc: d.soc, codecs: { avc: c.avc, hevc: c.hevc, aac: c.aac, avcHw: hw('video/avc'), hevcHw: hw('video/hevc') },
  }
}

// ── app ───────────────────────────────────────────────────────────────────────
h('app:info', () => appInfo())
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
async function thumbsInBackground(ids: string[]) {
  if (thumbing) return
  thumbing = true
  try {
    for (const id of ids) { thumbTried.add(id); await F.makeThumb(id); F.closeFramePool(id) }
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
  const p = await P.importZip(zip, (x) => send('projects:progress', { kind: 'import', p: x }))
  if (zip.startsWith('.incoming/')) fs.deleteAsync(dirname(zip)).catch(() => {})
  send('projects:changed', null)
  return p
})
h('projects:exportZip', async (id: string, o: { includeRenders?: boolean; action?: 'share' | 'save' } = {}) => {
  const r = await P.exportZip(id, o, (x) => send('projects:progress', { kind: 'export', id, p: x }))
  if (o.action === 'save') return { ...r, ...(await host().callAsync('file.save', { path: r.path, name: r.name, mime: 'application/zip' })) }
  await host().callAsync('file.share', { path: r.path, name: r.name, mime: 'application/zip', title: 'Compartir proyecto' })
  return r
})
h('app:takePendingOpen', () => host().call('app.takePendingOpen'))

// ── papelera ──────────────────────────────────────────────────────────────────
h('trash:list', () => P.listTrash())
h('trash:restore', (id) => { const to = P.restoreTrash(id); send('projects:changed', null); return to })
h('trash:empty', () => P.emptyTrash())
h('trash:delete', (id: string) => { if (!/^[\w.-]+$/.test(id)) throw new Error('Elemento inválido'); return fs.deleteAsync(join('.trash', id)) })
h('storage:usage', () => ({ projects: fs.du(P.PROJECTS), exports: fs.du('exports'), trash: fs.du('.trash'), cache: fs.du('cache'), templates: fs.du(P.USER_TEMPLATES) }))
h('app:toast', (text: string) => { try { host().call('app.toast', { text: String(text) }) } catch { /* sin puente */ } })

// ── proyecto abierto ──────────────────────────────────────────────────────────
h('project:open', (id) => P.readProject(id))
h('project:close', async (id) => { F.closeFramePool(id); await F.makeThumb(id); F.closeFramePool(id); send('projects:changed', null) })
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
h('frames:contactSheet', async (id, tl, opts) => (await F.contactSheet(id, tl, opts)).png)
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
h('export:list', async () => (await import('./exporter')).listExports())
h('export:delete', (path: string) => { if (/^exports\/[^/]+$/.test(path)) fs.delete(path); return true })
h('export:bitrate', async (w: number, hh: number, fps: number, quality: any, codec: any) => (await import('./exporter')).autoBitrate(w, hh, fps, quality, codec))
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
h('plugins:installYtdlp', notAvailable('yt-dlp'))
h('plugins:loginCodex', notAvailable('ChatGPT con Codex CLI'))
h('plugins:image', async (projectId, req) => { const r = await PL.generateImage(projectId, req); projectChanged(projectId, r.path); return r })
h('plugins:tts', async (projectId, req) => { const r = await PL.tts(projectId, req); projectChanged(projectId, r.path); return r })
h('plugins:sfx', async (projectId, req) => { const r = await PL.sfx(projectId, req); projectChanged(projectId, r.path); return r })
h('plugins:ask', (req) => PL.ask(req))

// ── Claude (clave de API) ─────────────────────────────────────────────────────
h('claude:status', () => ({ ready: claudeReady(), masked: host().call<string>('secrets.masked', { name: 'claude' }) }))
h('claude:setKey', (key: string) => { host().call('secrets.set', { name: 'claude', value: key || '' }); return { ready: claudeReady(), masked: host().call<string>('secrets.masked', { name: 'claude' }) } })
h('claude:test', async () => (await import('./agent')).testClaude())

// ── plantillas del usuario ────────────────────────────────────────────────────
h('templates:saveProject', async (projectId, o) => {
  if (!fs.exists(join(P.projectDir(projectId)!, 'thumbnail.jpg'))) await F.makeThumb(projectId)
  return P.saveProjectAsTemplate(projectId, o)
})
h('templates:get', (id) => P.getTemplate(id))
h('templates:delete', (id) => P.deleteTemplate(id))
h('templates:update', (id, patch) => P.updateTemplate(id, patch))
h('templates:openFolder', () => true)

// ── analizador de video (PC) ──────────────────────────────────────────────────
h('analyze:phases', () => [])
for (const ch of ['analyze:pickFile', 'analyze:start', 'analyze:cancel', 'analyze:discard', 'analyze:save']) h(ch, notAvailable('Crear plantillas analizando un video'))

// ── chat con Claude (agent.ts) ────────────────────────────────────────────────
const agent = () => import('./agent')
h('chat:pickFiles', async () => host().callAsync('pick.files', { accept: [], multiple: true }))
h('chat:attach', async (projectId, files) => (await agent()).attachFiles(projectId, files))
h('chat:attachData', async (projectId, name, b64) => (await agent()).attachData(projectId, name, b64))
h('chat:create', async (projectId, opts) => (await agent()).createChat(projectId, opts))
h('chat:get', async (id) => (await agent()).getChat(id))
h('chat:sessions', async (projectId) => (await agent()).listSessions(projectId))
h('chat:compact', async (id, instr) => (await agent()).compactChat(id, instr))
const editorCtx = new Map<string, { timeline: string; t: number }>()
h('chat:setCtx', (projectId, ctx) => { editorCtx.set(projectId, ctx) })
h('chat:getCtx', (projectId) => editorCtx.get(projectId) || null)
h('chat:popout', () => true)
h('chat:popin', () => true)
h('chat:isPopped', () => false)
h('chat:send', async (id, text, images, files) => (await agent()).sendChat(id, text, images || [], files || []))
h('chat:interrupt', async (id) => (await agent()).interruptChat(id))
h('chat:permission', async (id, itemId, allow, always) => (await agent()).respondPermission(id, itemId, allow, !!always))
h('chat:kill', async (id) => (await agent()).killChat(id))
h('chat:setOptions', async (id, patch, label) => {
  const cur = S.getSettings().claude
  S.setSettings({ claude: { ...cur, ...patch } })
  return (await agent()).setChatOptions(id, patch, label)
})

// ── instalación: window.oa ────────────────────────────────────────────────────
export function installBackend() {
  const hst = host()
  const oa = {
    platform: 'android' as const,
    appOrigin: hst.appOrigin,
    projectOrigin: hst.projectOrigin,
    async call(ch: string, ...args: unknown[]) {
      const fn = handlers[ch]
      if (!fn) throw new Error(`No disponible en Android: ${ch}`)
      return await fn(...args)
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
  return oa
}

export { normalizeRel }
