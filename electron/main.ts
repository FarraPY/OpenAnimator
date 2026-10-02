import { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, clipboard, ClipboardItem, screen, Notification } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { registerSchemes, handleProtocol } from './protocol'
import { ensureDataDirs, DATA_DIR, PROJECTS_DIR, claudePath, ffmpegPaths } from './paths'
import { runCli } from './cli'
import * as P from './projects'
import { Exporter, ExportJob, clearExportCache, safeName } from './exporter'
import { detectEncoders, gpuName, probeMedia } from './ffmpeg'
import { renderFrames, contactSheet, auditLayout, closeFramePool } from './frames'
import { startApi, stopApi, writeApiInfo } from './api'
import { ChatSession, claudeEnv, writeMcpConfig, listSessions, loadTranscript } from './claude'
import { getSettings, setSettings, resetSettings, exportDefaults, seedAiGuides } from './settings'
import { audioPeaks, videoThumb, cacheStats, clearCache, ffmpegVersion } from './media'
import * as PL from './plugins'
import { setSecret } from './secrets'
import { Analyzer, cleanupAnalyses, PHASES } from './analyzer'

const resolvedClaude = () => getSettings().claude.claudePath || claudePath()

const isCli = process.argv.includes('--cli')
registerSchemes()
app.commandLine.appendSwitch('disable-renderer-backgrounding')
// OJO: NO usar disable-frame-rate-limit / disable-gpu-vsync. Acelera ~1,4× pero capturePage a veces devuelve
// el fotograma anterior (probado: 11 de 900 cuadros incorrectos). Con vsync, el doble rAF garantiza el cuadro nuevo.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
// Portable: el perfil de Chromium (cachés, almacenamiento) va dentro de data/, no en %APPDATA%.
// La línea de comandos usa un perfil propio y temporal para poder correr junto a la app abierta.
const USER_DATA = isCli ? path.join(DATA_DIR, 'cache', `cli-${process.pid}`) : path.join(DATA_DIR, 'electron')
app.setPath('userData', USER_DATA)
app.setPath('sessionData', USER_DATA)
// Perfiles temporales de ejecuciones anteriores por línea de comandos (los que están en uso no se pueden borrar).
try {
  const cd = path.join(DATA_DIR, 'cache')
  for (const d of fs.existsSync(cd) ? fs.readdirSync(cd) : []) if (/^cli-\d+$/.test(d) && path.join(cd, d) !== USER_DATA) try { fs.rmSync(path.join(cd, d), { recursive: true, force: true }) } catch { /* en uso */ }
} catch { /* ignore */ }
// Una sola ventana: la segunda copia avisa a la primera y termina YA, sin iniciar nada
// (antes seguía hasta whenReady y pisaba/borraba data/api.json, dejando a la IA sin conexión).
const firstInstance = isCli || app.requestSingleInstanceLock()
if (!firstInstance) { app.exit(0); process.exit(0) }

let mainWin: BrowserWindow | null = null
/** Ventanas de chat separadas (una por proyecto). */
const chatWins = new Map<string, BrowserWindow>()
/** Estado del editor (timeline activo y cursor) para que el chat separado sepa en qué momento está el usuario. */
const editorCtx = new Map<string, { timeline: string; t: number }>()
const send = (ch: string, payload: unknown) => {
  for (const w of [mainWin, ...chatWins.values()]) if (w && !w.isDestroyed()) w.webContents.send(ch, payload)
}

// ── watchers de proyectos ───────────────────────────────────────────────────
const watchers = new Map<string, () => void>()
const selfWrites = new Map<string, number>()
function watch(id: string) {
  if (watchers.has(id)) return
  watchers.set(id, P.watchProject(id, (kind, file) => {
    if (kind === 'timeline' && Date.now() - (selfWrites.get(id + '|' + file) || 0) < 1500) return
    if (kind === 'project' && Date.now() - (selfWrites.get(id + '|project.json') || 0) < 1500) return
    send('project:changed', { id, kind, file })
  }))
}
function unwatch(id: string) { watchers.get(id)?.(); watchers.delete(id) }

// ── exportaciones ───────────────────────────────────────────────────────────
const exports = new Map<string, Exporter>()

// ── chats ───────────────────────────────────────────────────────────────────
const chats = new Map<string, ChatSession>()
/**
 * Conversaciones sin editor abierto (el usuario fue a Ajustes o al inicio): siguen trabajando y el
 * editor las retoma al volver al proyecto. Se cierran solas tras media hora sin actividad.
 */
const parked = new Map<string, { id: string; since: number }>() // proyecto → conversación
const PARK_MS = 30 * 60e3
setInterval(() => {
  for (const [projectId, p] of parked) {
    const chat = chats.get(p.id)
    if (!chat) { parked.delete(projectId); continue }
    if (chat.busy || chat.tasks) { p.since = Date.now(); continue } // con subagentes trabajando tampoco se cierra
    // Terminó el turno y el proyecto no está abierto: sus ventanas de fotogramas ya no hacen falta.
    if (!watchers.has(projectId)) closeFramePool(projectId)
    if (Date.now() - p.since > PARK_MS) { chat.kill(); chats.delete(p.id); parked.delete(projectId) }
  }
}, 60e3).unref()

// ── análisis de video → plantilla ───────────────────────────────────────────
const analyses = new Map<string, Analyzer>()

const IMG_EXT = /\.(png|jpe?g|webp|gif)$/i
/** Copia archivos adjuntos del chat a <proyecto>/adjuntos/ y prepara las imágenes para mandarlas inline. */
function attachFiles(projectId: string, files: string[]) {
  const dir = path.join(P.projectDir(projectId)!, 'adjuntos')
  fs.mkdirSync(dir, { recursive: true })
  return files.filter((f) => fs.existsSync(f) && fs.statSync(f).isFile()).map((f) => {
    const inside = path.resolve(f).toLowerCase().startsWith(path.resolve(P.projectDir(projectId)!).toLowerCase() + path.sep)
    let rel: string
    if (inside) rel = path.relative(P.projectDir(projectId)!, f).split(path.sep).join('/')
    else {
      const ext = path.extname(f), base = path.basename(f, ext)
      let name = path.basename(f), n = 2
      while (fs.existsSync(path.join(dir, name))) name = `${base}-${n++}${ext}`
      fs.copyFileSync(f, path.join(dir, name))
      rel = `adjuntos/${name}`
    }
    const abs = path.join(P.projectDir(projectId)!, rel)
    let image: string | undefined
    if (IMG_EXT.test(f)) {
      const im = nativeImage.createFromPath(abs)
      if (!im.isEmpty()) { const w = im.getSize().width; image = (w > 1568 ? im.resize({ width: 1568 }) : im).toJPEG(88).toString('base64') }
    }
    return { rel, name: path.basename(rel), size: fs.statSync(abs).size, image }
  })
}

function h(ch: string, fn: (...a: any[]) => any) {
  ipcMain.handle(ch, async (_e, ...args) => {
    try { return { ok: true, value: await fn(...args) } } catch (e: any) { return { ok: false, error: String(e?.message || e) } }
  })
}

const thumbTried = new Set<string>()
async function makeThumb(id: string) {
  try {
    const tl = P.readTimeline(id)
    const t = Math.min(tl.duration * 0.25, 3)
    const [f] = await renderFrames(id, undefined, [t], 480)
    fs.writeFileSync(path.join(P.projectDir(id)!, 'thumbnail.jpg'), nativeImage.createFromBuffer(f.png).toJPEG(82))
  } catch { /* sin miniatura */ }
}

function registerIpc() {
  // app
  h('app:info', async () => ({
    version: app.getVersion(), dataDir: DATA_DIR, projectsDir: PROJECTS_DIR, portable: app.isPackaged,
    claude: resolvedClaude(), ffmpeg: ffmpegPaths().ffmpeg, gpu: await gpuName(), encoders: await detectEncoders(),
  }))
  h('app:versions', async () => ({ app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, ffmpeg: await ffmpegVersion() }))
  h('settings:reset', () => resetSettings())
  h('settings:pickFile', async (title: string) => { const r = await dialog.showOpenDialog(mainWin!, { title, properties: ['openFile'] }); return r.canceled ? null : r.filePaths[0] })
  h('settings:pickDir', async (title: string) => { const r = await dialog.showOpenDialog(mainWin!, { title, properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0] })
  h('cache:stats', () => cacheStats())
  h('cache:clear', (kind) => clearCache(kind))
  h('ai:openNotes', () => shell.openPath(path.join(DATA_DIR, 'NOTAS-IA.md')))
  h('settings:get', () => getSettings())
  h('settings:set', (patch) => setSettings(patch))
  h('export:defaults', () => exportDefaults())

  // proyectos
  h('projects:list', () => {
    const list = P.listProjects()
    // Proyectos nuevos/importados sin miniatura: se generan en segundo plano, de a uno.
    const missing = list.filter((x) => !x.thumb && !thumbTried.has(x.id)).map((x) => x.id)
    if (missing.length) (async () => {
      for (const id of missing) { thumbTried.add(id); await makeThumb(id); closeFramePool(id) }
      send('projects:changed', null)
    })()
    return list
  })
  h('projects:templates', () => P.listTemplates())
  h('projects:create', (o) => P.createProject(o))
  h('projects:delete', async (id) => { unwatch(id); closeFramePool(id); await P.deleteProject(id) })
  h('projects:duplicate', (id) => P.duplicateProject(id))
  h('projects:rename', (id, name) => P.renameProject(id, name))
  h('projects:importCoAnimator', async () => {
    const r = await dialog.showOpenDialog(mainWin!, { title: 'Carpeta del proyecto de CoAnimator (con project.json)', properties: ['openDirectory'], defaultPath: path.join(process.env.APPDATA || '', 'CoAnimator', 'projects') })
    if (r.canceled || !r.filePaths[0]) return null
    if (!fs.existsSync(path.join(r.filePaths[0], 'project.json'))) throw new Error('Esa carpeta no tiene project.json')
    return P.importCoAnimator(r.filePaths[0])
  })
  h('projects:openFolder', (id) => shell.openPath(id ? P.projectDir(id)! : PROJECTS_DIR))

  // proyecto abierto
  h('project:open', (id) => { watch(id); return P.readProject(id) })
  h('project:close', async (id) => {
    unwatch(id)
    // Si Claude sigue trabajando en el proyecto, sus ventanas de fotogramas no se cierran (se cierran solas sin uso).
    if (![...chats.values()].some((c) => c.opts.projectId === id && c.busy)) closeFramePool(id)
    await makeThumb(id)
  })
  h('project:get', (id) => P.readProject(id))
  h('project:save', (p) => { selfWrites.set(p.id + '|project.json', Date.now()); P.writeProject(p); return p })
  h('timeline:get', (id, tl) => P.readTimeline(id, tl))
  h('timeline:save', (id, tlId, tl) => {
    const p = P.readProject(id)
    const ref = p.timelines.find((t) => t.id === tlId)
    if (ref) selfWrites.set(id + '|' + ref.file.replace(/\\/g, '/'), Date.now())
    selfWrites.set(id + '|project.json', Date.now())
    P.writeTimeline(id, tlId, tl)
    return tl.rev
  })
  h('timelines:create', (id, name, copyFrom) => P.createTimeline(id, name, copyFrom))
  h('timelines:rename', (id, tl, name) => P.renameTimeline(id, tl, name))
  h('timelines:delete', (id, tl) => P.deleteTimeline(id, tl))
  h('timelines:setActive', (id, tl) => { selfWrites.set(id + '|project.json', Date.now()); return P.setActiveTimeline(id, tl) })
  h('timelines:move', (id, tl, d) => P.moveTimeline(id, tl, d))
  h('assets:list', (id) => P.listAssets(id))
  h('assets:import', async (id, files?: string[]) => {
    if (!files || !files.length) {
      const r = await dialog.showOpenDialog(mainWin!, { title: 'Agregar medios', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Medios y escenas', extensions: ['mp4', 'webm', 'mov', 'mkv', 'mp3', 'wav', 'ogg', 'm4a', 'flac', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'html'] }] })
      if (r.canceled) return []
      files = r.filePaths
    }
    return P.addAssets(id, files)
  })
  h('media:probe', async (id, rel) => probeMedia(path.isAbsolute(rel) ? rel : path.join(P.projectDir(id)!, rel)))
  h('media:peaks', (id, rel) => audioPeaks(path.isAbsolute(rel) ? rel : path.join(P.projectDir(id)!, rel)))
  h('media:thumb', async (id, rel) => 'data:image/jpeg;base64,' + fs.readFileSync(await videoThumb(path.isAbsolute(rel) ? rel : path.join(P.projectDir(id)!, rel))).toString('base64'))
  h('project:reveal', (id, rel) => shell.showItemInFolder(path.join(P.projectDir(id)!, rel || 'project.json')))
  h('project:files', (id) => P.listProjectFiles(id))
  h('assets:readText', (id, rel) => P.readProjectText(id, rel))
  h('assets:usage', (id, rel) => P.assetUsage(id, rel))
  h('assets:open', (id, rel) => shell.openPath(P.projectFile(id, rel)))
  // Se mandan a la papelera de Windows (recuperables), nunca se borran definitivamente.
  h('assets:trash', async (id, rels: string[]) => {
    for (const r of rels) await shell.trashItem(P.projectFile(id, r))
    return rels.length
  })

  // visión / fotogramas
  h('frames:png', async (id, tl, t, width) => {
    const [f] = await renderFrames(id, tl, [t], width || 1280)
    return f.png.toString('base64')
  })
  h('frames:copy', async (id, tl, t) => {
    const [f] = await renderFrames(id, tl, [t], 1600)
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(f.png)], { type: 'image/png' }) })])
    return true
  })
  h('frames:contactSheet', async (id, tl, opts) => (await contactSheet(id, tl, opts)).png.toString('base64'))
  h('frames:audit', (id, tl, opts) => auditLayout(id, tl, opts))

  // exportación
  h('export:pickOutput', async (defName: string, ext: string, folder: boolean) => {
    const s = getSettings()
    const base = s.exportPrefs.defaultDir || s.lastExportDir || app.getPath('videos')
    if (folder) {
      const r = await dialog.showOpenDialog(mainWin!, { title: 'Carpeta de salida', properties: ['openDirectory', 'createDirectory'], defaultPath: base })
      return r.canceled ? null : r.filePaths[0]
    }
    const r = await dialog.showSaveDialog(mainWin!, { title: 'Exportar video', defaultPath: path.join(base, `${safeName(defName)}.${ext}`), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] })
    return r.canceled ? null : r.filePath
  })
  h('export:start', (job: ExportJob) => {
    const id = `exp-${Date.now().toString(36)}`
    setSettings({ export: job.settings, lastExportDir: path.extname(job.output) ? path.dirname(job.output) : job.output })
    const ex = new Exporter(job, (p) => send('export:progress', { id, ...p }))
    exports.set(id, ex)
    ex.run().then((files) => {
      const prefs = getSettings().exportPrefs
      if (prefs.notify && Notification.isSupported() && !mainWin?.isFocused()) new Notification({ title: 'Exportación terminada', body: files.map((f) => path.basename(f)).join(', ') }).show()
      if (prefs.openFolderWhenDone && files[0]) shell.showItemInFolder(files[0])
      return makeThumb(job.projectId)
    }).catch((e) => {
      if (getSettings().exportPrefs.notify && Notification.isSupported() && !mainWin?.isFocused() && !/cancel/i.test(String(e?.message))) new Notification({ title: 'La exportación falló', body: String(e?.message || e).slice(0, 180) }).show()
    }).finally(() => exports.delete(id))
    return id
  })
  h('export:defaultOutput', (defName: string, ext: string, folder: boolean) => {
    const s = getSettings()
    const base = s.exportPrefs.defaultDir || s.lastExportDir || app.getPath('videos')
    return folder ? base : path.join(base, `${safeName(defName)}.${ext}`)
  })
  h('export:exists', (file: string) => fs.existsSync(file) && fs.statSync(file).isFile())
  h('export:cancel', (id) => exports.get(id)?.cancel())
  h('export:clearCache', (id) => clearExportCache(id))

  // shell
  h('shell:openPath', (p) => shell.openPath(p))
  h('shell:showItem', (p) => shell.showItemInFolder(p))
  h('shell:openExternal', (u) => { if (/^https?:\/\//.test(u)) return shell.openExternal(u) })
  // Claude Code interactivo en una terminal, en la carpeta del proyecto y con las herramientas de OpenAnimator.
  // Si hay una conversación del chat, la terminal la retoma (--resume) para seguirla ahí.
  h('shell:terminal', (id, sessionId?: string) => {
    const dir = P.projectDir(id)!
    const bin = resolvedClaude()
    let cmd = ''
    if (bin) {
      const mcp = writeMcpConfig(id)
      cmd = `"${bin}" --mcp-config "${mcp}"${sessionId && /^[\w-]+$/.test(sessionId) ? ` --resume ${sessionId} --fork-session` : ''}`
    }
    // Con windowsVerbatimArguments Node no escapa las comillas: cmd.exe recibe la línea tal cual.
    const line = `/d /s /c start "OpenAnimator · Claude Code" /D "${dir}" cmd.exe /k ${cmd ? `"${cmd}"` : ''}`
    const env = claudeEnv(id)
    spawn('cmd.exe', [line], { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true, cwd: dir, env }).unref()
  })

  // plugins de IA
  h('plugins:status', (force?: boolean) => PL.pluginStatus(!!force))
  h('plugins:setKey', (id: string, key: string) => { setSecret(`plugin.${id}`, key || ''); return PL.pluginStatus() })
  h('plugins:test', (id) => PL.testPlugin(id))
  h('plugins:voices', (provider, q) => PL.listVoices(provider, q))
  h('plugins:whisperModels', () => PL.whisperModels())
  h('plugins:installYtdlp', () => PL.installYtdlp((p) => send('plugins:progress', { id: 'ytdlp', p })))
  h('plugins:image', (projectId, req) => PL.generateImage(projectId, req))
  h('plugins:tts', (projectId, req) => PL.tts(projectId, req))
  h('plugins:sfx', (projectId, req) => PL.sfx(projectId, req))
  h('plugins:ask', (req) => PL.ask(req))
  h('plugins:loginCodex', () => {
    const bin = PL.codexPath()
    if (!bin) return shell.openExternal('https://developers.openai.com/codex/cli')
    spawn('cmd.exe', ['/c', 'start', 'Codex', 'cmd.exe', '/k', `"${bin}" login`], { detached: true, stdio: 'ignore', windowsHide: false })
  })

  // plantillas del usuario
  h('templates:saveProject', async (projectId, o) => { if (!fs.existsSync(path.join(P.projectDir(projectId)!, 'thumbnail.jpg'))) await makeThumb(projectId); return P.saveProjectAsTemplate(projectId, o) })
  h('templates:get', (id) => P.getTemplate(id))
  h('templates:delete', (id) => P.deleteTemplate(id))
  h('templates:update', (id, patch) => P.updateTemplate(id, patch))
  h('templates:openFolder', () => { fs.mkdirSync(P.USER_TEMPLATES_DIR(), { recursive: true }); return shell.openPath(P.USER_TEMPLATES_DIR()) })

  // analizador de video
  h('analyze:phases', () => PHASES)
  h('analyze:pickFile', async () => {
    if (process.env.OA_TEST_PICK) return process.env.OA_TEST_PICK // verificación automática
    const r = await dialog.showOpenDialog(mainWin!, { title: 'Video de referencia', properties: ['openFile'], filters: [{ name: 'Video', extensions: ['mp4', 'webm', 'mov', 'mkv', 'm4v', 'avi', 'gif'] }] })
    return r.canceled ? null : r.filePaths[0]
  })
  h('analyze:start', (opts) => {
    const a = new Analyzer(opts, (e) => send('analyze:event', e))
    analyses.set(a.id, a)
    a.run().catch(() => { /* el error ya se emitió */ })
    return a.id
  })
  h('analyze:cancel', (id) => analyses.get(id)?.cancel())
  h('analyze:discard', (id) => { analyses.get(id)?.discard(); analyses.delete(id) })
  h('analyze:save', (id, o) => { const a = analyses.get(id); if (!a) throw new Error('El análisis ya no está disponible'); const r = a.save(o); analyses.delete(id); return r })

  // chat con Claude
  h('chat:pickFiles', async () => {
    if (process.env.OA_TEST_PICK) return process.env.OA_TEST_PICK.split('|')
    const r = await dialog.showOpenDialog(mainWin!, { title: 'Adjuntar archivos para Claude', properties: ['openFile', 'multiSelections'] })
    return r.canceled ? [] : r.filePaths
  })
  h('chat:attach', (projectId, files: string[]) => attachFiles(projectId, files))
  h('chat:attachData', (projectId, name: string, b64: string) => {
    const f = path.join(app.getPath('temp'), `oa-${Date.now()}-${path.basename(name || 'pegado.png')}`)
    fs.writeFileSync(f, Buffer.from(b64, 'base64'))
    try { return attachFiles(projectId, [f]) } finally { fs.rmSync(f, { force: true }) }
  })
  h('chat:create', (projectId, opts?: { resume?: string }) => {
    const c = getSettings().claude
    const chat = new ChatSession({ projectId, permissionMode: c.permissionMode, model: c.model || undefined, effort: c.effort || undefined, extraInstructions: c.extraInstructions, claudePath: c.claudePath || undefined, resume: opts?.resume, saver: c.saver !== false }, (e) => send('chat:event', e))
    // Retomar una conversación anterior: se muestra lo que ya se habló.
    if (opts?.resume) { chat.items = loadTranscript(projectId, opts.resume); chat.sessionId = opts.resume }
    chats.set(chat.id, chat)
    return { id: chat.id, items: chat.items, sessionId: chat.sessionId, options: { model: c.model, effort: c.effort, permissionMode: c.permissionMode }, stats: chat.stats() }
  })
  const snapshot = (chat: ChatSession) => {
    const o = chat.opts
    return { id: chat.id, items: chat.items, busy: chat.busy, sessionId: chat.sessionId, options: { model: o.model || '', effort: o.effort || '', permissionMode: o.permissionMode }, stats: chat.stats(), model: chat.model, signalAt: chat.lastSignal || undefined, tasks: chat.tasks }
  }
  // Una ventana que se conecta a una conversación ya abierta (el chat separado o el editor al volver).
  h('chat:get', (id) => { const chat = chats.get(id); return chat ? snapshot(chat) : null })
  // El editor se cierra: la conversación sigue (si está trabajando, termina el turno) y queda para retomarla.
  h('chat:leave', (id) => {
    const chat = chats.get(id)
    if (!chat) return
    const old = parked.get(chat.opts.projectId)
    if (old && old.id !== id) { chats.get(old.id)?.kill(); chats.delete(old.id) }
    parked.set(chat.opts.projectId, { id, since: Date.now() })
  })
  // El editor vuelve a abrir el proyecto: retoma la conversación que dejó (o null para empezar una nueva).
  h('chat:forProject', (projectId) => {
    const p = parked.get(projectId)
    parked.delete(projectId)
    const chat = p && chats.get(p.id)
    return chat ? snapshot(chat) : null
  })
  h('chat:sessions', (projectId) => listSessions(projectId))
  h('chat:compact', (id, instructions?: string) => chats.get(id)?.compact(instructions))
  h('chat:setCtx', (projectId, ctx) => { editorCtx.set(projectId, ctx) })
  h('chat:getCtx', (projectId) => editorCtx.get(projectId) || null)
  h('chat:popout', (projectId, sessionId) => {
    const cur = chatWins.get(projectId)
    if (cur && !cur.isDestroyed()) { cur.focus(); return }
    const b = mainWin?.getBounds()
    const w = new BrowserWindow({
      width: 480, height: Math.min(900, b?.height || 860), x: b ? b.x + b.width - 500 : undefined, y: b ? b.y + 40 : undefined,
      minWidth: 360, minHeight: 420, backgroundColor: '#0b0c0f', title: 'Claude · OpenAnimator', show: false,
      titleBarStyle: 'hidden', titleBarOverlay: { color: '#0b0c0f', symbolColor: '#a9adba', height: 38 },
      icon: path.join(__dirname, '..', 'build', 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false, webviewTag: false },
    })
    w.setMenuBarVisibility(false)
    w.once('ready-to-show', () => w.show())
    const q = { chat: projectId, session: sessionId }
    if (process.env.OA_DEV_URL) w.loadURL(`${process.env.OA_DEV_URL}?${new URLSearchParams(q)}`)
    else w.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query: q })
    w.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' } })
    chatWins.set(projectId, w)
    send('chat:popout', { projectId, open: true })
    w.on('closed', () => { chatWins.delete(projectId); send('chat:popout', { projectId, open: false }) })
  })
  h('chat:popin', (projectId) => { const w = chatWins.get(projectId); if (w && !w.isDestroyed()) w.close(); mainWin?.focus() })
  h('chat:isPopped', (projectId) => !!chatWins.get(projectId))
  h('chat:send', (id, text, images, files) => chats.get(id)?.send(text, images || [], files || []))
  h('chat:interrupt', (id) => chats.get(id)?.interrupt())
  h('chat:unqueue', (id, itemId) => chats.get(id)?.unqueue(itemId) || [])
  h('chat:permission', (id, itemId, allow, always) => chats.get(id)?.respondPermission(itemId, allow, !!always))
  h('chat:kill', (id) => {
    chats.get(id)?.kill(); chats.delete(id)
    for (const [projectId, p] of parked) if (p.id === id) parked.delete(projectId)
  })
  h('chat:setOptions', (id, patch: { model?: string; effort?: string; permissionMode?: string }, label: string) => {
    const cur = getSettings().claude
    setSettings({ claude: { ...cur, ...patch } })
    const o: Record<string, string | boolean | undefined> = {}
    for (const k of ['model', 'effort', 'permissionMode'] as const) if (k in patch) o[k] = (patch as any)[k] || undefined
    if ('saver' in patch) o.saver = !!(patch as any).saver
    chats.get(id)?.setOptions(o, label)
  })
}

function createMainWindow() {
  const wa = screen.getPrimaryDisplay().workAreaSize
  const small = wa.width < 1600 || wa.height < 960
  mainWin = new BrowserWindow({
    width: Math.min(1560, wa.width), height: Math.min(940, wa.height), minWidth: Math.min(1100, wa.width), minHeight: Math.min(640, wa.height), show: false, backgroundColor: '#0b0c0f', title: 'OpenAnimator',
    // Barra de título propia (la interfaz dibuja la barra; Windows pone sólo los botones de ventana).
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#0b0c0f', symbolColor: '#a9adba', height: 44 },
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false, webviewTag: false },
  })
  mainWin.setMenuBarVisibility(false)
  mainWin.once('ready-to-show', () => { if (small) mainWin!.maximize(); mainWin!.show() })
  const dev = process.env.OA_DEV_URL
  if (dev) mainWin.loadURL(dev)
  else mainWin.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), process.env.OA_OPEN ? { query: { open: process.env.OA_OPEN } } : undefined)
  // Modo de verificación: captura la ventana y cierra (OA_SCREENSHOT=archivo.png, OA_SCREENSHOT_DELAY=ms).
  if (process.env.OA_SCREENSHOT) {
    mainWin.webContents.once('did-finish-load', () => setTimeout(async () => {
      try { const img = await mainWin!.webContents.capturePage(); fs.writeFileSync(process.env.OA_SCREENSHOT!, img.toPNG()) } catch (e) { console.error(e) }
      app.quit()
    }, +(process.env.OA_SCREENSHOT_DELAY || 6000)))
  }
  mainWin.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' } })
  mainWin.on('closed', () => { mainWin = null; for (const w of chatWins.values()) if (!w.isDestroyed()) w.close() })
}

app.whenReady().then(async () => {
  if (!firstInstance) return
  ensureDataDirs()
  handleProtocol()
  if (isCli) {
    const code = await runCli(process.argv)
    app.exit(code)
    return
  }
  seedAiGuides()
  cleanupAnalyses()
  registerIpc()
  startApi()
  createMainWindow()
})

app.on('second-instance', () => {
  writeApiInfo() // por si algo borró o cambió data/api.json
  if (!mainWin || mainWin.isDestroyed()) return createMainWindow()
  if (mainWin.isMinimized()) mainWin.restore()
  mainWin.show(); mainWin.focus()
})
app.on('window-all-closed', () => { if (!isCli) app.quit() })
app.on('before-quit', () => {
  exports.forEach((e) => e.cancel())
  analyses.forEach((a) => a.discard())
  chats.forEach((c) => c.kill())
  stopApi()
})
