/**
 * Chat con Claude Code en el iPhone, con el plan del usuario y sin PC: el Claude Code oficial (bajado de npm por el
 * propio teléfono, src/iphone/claude/installer.worker.ts) corre en un Worker con un "Node" hecho con APIs del navegador
 * (src/iphone/claude/node). Es el mismo chat que en la PC y en la tablet (electron/claude-session.ts); las herramientas
 * de la app le llegan por MCP (http://oa.mcp/mcp, atendido acá) y lo que guarda en su carpeta personal (configuración y
 * conversaciones) queda en claude/home/ de la carpeta de datos. Mismas funciones que code.ts, así index.ts elige.
 *
 * La cuenta: un token de larga duración como el de `claude setup-token`. En la app se saca ahí mismo (login(): el
 * inicio de sesión del propio Claude Code, con la página de Claude que abre iOS); si no, se pega el de setup-token.
 * Va cifrado (secrets.ts) y sólo al Worker, como CLAUDE_CODE_OAUTH_TOKEN.
 */
import { ClaudeStreamSession, type ChatItem, type ChatOptions } from '../../../electron/claude-session'
import { parseTranscript, sessionInfo, sessionsSlug } from '../../../electron/claude-transcript'
import type { WebHost } from '../../iphone/host/webhost'
import { b64encode, nativeCall } from '../../iphone/host/native'
import { host } from '../host'
import { projectChanged, send } from './events'
import { projectDir } from './projects'
import { buildSystem } from './prompt'
import { getSettings } from './settings'
import { TOOL_DEFS, runTool, toolKind, validateInput, type ToolContent } from './tools'
import { holdAwake } from './wake'

const MCP = 'mcp__openanimator__'
const READONLY = TOOL_DEFS.filter((t) => t.kind === 'read').map((t) => MCP + t.name)
const HOME = '/home/user'
const SAVED = 'claude/home' // lo de HOME que se guarda, en la carpeta de datos
export const TOKEN = 'claude-code'
const web = () => host() as WebHost
const wfs = () => web().fs
const cwd = (projectId: string) => `${HOME}/proyectos/${projectId}`

// ── Claude Code instalado ──────────────────────────────────────────────────────
export type Manifest = { version: string; base: string; loaders: Record<string, string>; assets: string[]; preload: string[]; installedAt: number; size: number }

/**
 * El Claude Code instalado, o null: en la app nativa, en el disco del iPhone (Application Support/claude-code/<versión>);
 * en Safari, en Cache Storage ("oa-claude-<versión>"). Ver installer.worker.ts.
 */
export async function manifest(): Promise<Manifest | null> {
  if (web().native) {
    const versions = await nativeCall<string[]>('cc.list').catch(() => [] as string[])
    for (const v of versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      const r = await fetch(`${web().base}cc/${v}/manifest.json`, { cache: 'no-store' }).catch(() => null)
      if (r?.ok) return r.json()
    }
    return null
  }
  for (const k of await caches.keys()) {
    if (!k.startsWith('oa-claude-')) continue
    const r = await caches.match(`${web().base}cc/${k.slice(10)}/manifest.json`)
    if (r) return r.json()
  }
  return null
}

/** Pruebas en la PC (sólo en localhost): la API de mentira y un paquete local en vez de npm. */
function dev(): { env?: Record<string, string>; tarball?: string } {
  if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return {}
  try { return JSON.parse(localStorage.getItem('oa.claudeDev') || '{}') } catch { return {} }
}

let installing: Promise<Manifest> | null = null
/** Instala (o actualiza) Claude Code en el teléfono; el avance llega por el evento claude:installProgress. */
export function install(version?: string): Promise<Manifest> {
  if (!installing) {
    installing = new Promise<Manifest>((resolve, reject) => {
      const w = new Worker(`${web().base}claude/installer.js`, { type: 'module' })
      w.onmessage = async ({ data: m }) => {
        if (m.type === 'progress') { send('claude:installProgress', m); return }
        if (m.type === 'files') {
          // App nativa: el Worker manda los archivos por tandas y la página los guarda en el disco del iPhone.
          try {
            await nativeCall('cc.write', { version: m.version, files: (m.files as Array<[string, ArrayBuffer]>).map(([p, b]) => [p, b64encode(new Uint8Array(b))]) })
            w.postMessage({ type: 'ack' })
          } catch (e: any) { w.postMessage({ type: 'ack', error: String(e?.message || e) }) }
          return
        }
        w.terminate()
        if (m.type === 'done') {
          if (web().native) await nativeCall('cc.delete', { keep: m.manifest.version }).catch(() => {})
          resolve(m.manifest)
        } else reject(new Error(m.message))
      }
      w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'El instalador de Claude Code se cerró')) }
      w.postMessage({ type: 'install', appBase: web().base, version, tarball: dev().tarball, native: web().native })
    }).finally(() => { installing = null; assets = null })
  }
  return installing
}

export async function status() {
  const m = await manifest()
  return {
    installed: m ? { version: m.version, installedAt: m.installedAt, size: m.size } : null, token: web().secrets.masked(TOKEN), installing: !!installing,
    /** Se puede chatear: instalado y con cuenta (o, en pruebas, con la API de mentira). */
    ready: !!m && (!!web().secrets.get(TOKEN) || !!dev().env),
  }
}

/** La última versión publicada en npm (para ofrecer actualizar). */
export async function latest(): Promise<string> {
  const r = await fetch('https://registry.npmjs.org/@anthropic-ai%2fclaude-code-linux-arm64/latest', { cache: 'no-store' })
  if (!r.ok) throw new Error(`npm respondió ${r.status}`)
  return (await r.json()).version
}

/** El token de `claude setup-token` (empieza con sk-ant-oat). Una clave de la API no: el usuario usa su plan. */
export function setToken(token: string) {
  const t = String(token || '').trim()
  if (t && /^sk-ant-api/.test(t)) throw new Error('Eso es una clave de la API. Pegá el token que da «claude setup-token» (empieza con sk-ant-oat): usa tu plan de Claude.')
  if (t && (!/^sk-ant-/.test(t) || /\s/.test(t))) throw new Error('No parece un token de Claude: tiene que empezar con sk-ant-oat y no tener espacios.')
  web().secrets.set(TOKEN, t)
  return status()
}

/**
 * Iniciar sesión sin otra computadora (sólo en la app): el Claude Code instalado hace lo mismo que `claude setup-token`
 * (su propio inicio de sesión, en un Worker; ver login en claude/node/worker.js). iOS muestra la página de Claude
 * (ASWebAuthenticationSession), la app recibe la vuelta en http://localhost:<puerto>/callback y se la pasa a Claude
 * Code, y el canje del código por el token va por la red de iOS (Anthropic no admite CORS desde la app). Devuelve un
 * token de un año que sólo sirve para usar Claude.
 */
let loggingIn: Promise<string> | null = null
export function login(): Promise<string> {
  if (!loggingIn) loggingIn = loginOnce().finally(() => { loggingIn = null })
  return loggingIn
}
async function loginOnce(): Promise<string> {
  if (!web().native) throw new Error('Iniciar sesión desde acá sólo se puede en la app del iPhone: pegá el token de «claude setup-token».')
  const m = await manifest()
  if (!m) throw new Error('Primero instalá Claude Code (paso 1).')
  // Dónde está el inicio de sesión de esta versión de Claude Code (el nombre del archivo cambia con cada una).
  const [chunk] = await nativeCall<string[]>('cc.find', { version: m.version, text: 'async startOAuthFlow(' })
  if (!chunk) throw new Error(`Claude Code ${m.version} no trae el inicio de sesión que usa la app: pegá el token de «claude setup-token».`)
  const files = await bunAssets(m)
  const release = holdAwake()
  return new Promise<string>((resolve, reject) => {
    const w = new Worker(`${web().base}claude/worker.js`, { type: 'module' })
    let over = false
    const finish = (error: Error | null, token = '') => {
      if (over) return
      over = true
      netDrop(w)
      w.terminate()
      release()
      if (error) reject(error); else resolve(token)
    }
    w.onmessage = async ({ data: x }) => {
      if (x.type === 'login-url') {
        try {
          const port = +new URL(new URL(x.automatic).searchParams.get('redirect_uri') || '').port
          const back = new URL(await nativeCall<string>('login.open', { url: x.automatic, port }))
          w.postMessage({ type: 'http-request', port, url: back.pathname + back.search })
        } catch (e: any) { finish(new Error(e?.message || String(e))) }
      } else if (x.type === 'net') netStart(w, x)
      else if (x.type === 'net-cancel') netCancel(x.id)
      else if (x.type === 'login-token') finish(null, x.token)
      else if (x.type === 'login-error' || x.type === 'crash') finish(new Error(x.error))
      else if (x.type === 'stderr' && (window as any).__oaTest) console.warn('[claude login]', x.data)
    }
    w.onerror = (e) => finish(new Error(e.message || 'El Worker de Claude Code se cerró'))
    const env: Record<string, string> = {
      HOME, USER: 'user', LOGNAME: 'user', SHELL: '/bin/sh', PATH: '/usr/bin:/bin', TERM: 'dumb', LANG: 'es_AR.UTF-8', TMPDIR: '/tmp',
      DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    }
    w.postMessage({ type: 'start', opts: { argv: ['node', '/$bunfs/root/cli'], env, cwd: HOME, home: HOME, files, dirs: [`${HOME}/.claude`], assets: m.loaders, preload: m.preload, base: m.base, native: true, login: { chunk } } })
  })
}

// ── la red de iOS para Claude Code ─────────────────────────────────────────────
/**
 * Lo que un Worker manda a Anthropic va por la red de iOS (appFetch en claude/node/worker.js → Bridge.swift
 * http.stream): con una cuenta del plan, la API rechaza los pedidos que salen de un navegador. Las partes de la
 * respuesta vuelven como eventos "net" de la app y se le pasan al Worker que las pidió.
 */
const nets = new Map<string, Worker>()
let netEvents = false
function netStart(w: Worker, m: { id: string; url: string; method: string; headers: Record<string, string>; body: string }) {
  if (!netEvents) {
    netEvents = true
    web().onEvent('net', (ev: any) => {
      const to = nets.get(ev?.id)
      if (!to) return
      if (ev.type === 'end' || ev.type === 'error') nets.delete(ev.id)
      to.postMessage({ type: 'net-event', ev })
    })
  }
  nets.set(m.id, w)
  nativeCall('http.stream', { id: m.id, url: m.url, method: m.method, headers: m.headers, body: m.body })
    .catch((e) => { nets.delete(m.id); w.postMessage({ type: 'net-event', ev: { id: m.id, type: 'error', message: String(e?.message || e) } }) })
}
function netCancel(id: string) { if (nets.delete(id)) void nativeCall('http.cancel', { id }).catch(() => {}) }
/** Un Worker que se cierra: lo suyo que sigue en camino se corta. */
function netDrop(w: Worker) { for (const [id, x] of [...nets]) if (x === w) netCancel(id) }

// ── un "proceso" de Claude Code: un Worker ─────────────────────────────────────
/** Recursos que Claude Code lee con fs (textos, skills…): se leen una vez y se le pasan a cada Worker. */
let assets: Promise<Array<[string, Uint8Array]>> | null = null
function bunAssets(m: Manifest) {
  if (!assets) {
    assets = Promise.all(m.assets.filter((n) => m.loaders[n] !== 'napi').map(async (n): Promise<[string, Uint8Array]> => {
      // Por URL: en la app la sirve SchemeHandler (del disco); en Safari, el Service Worker (de Cache Storage).
      const r = await fetch(`${m.base}$bunfs/root/${n}`).catch(() => null)
      if (!r?.ok) throw new Error('Claude Code quedó incompleto: volvé a instalarlo en Ajustes › Claude.')
      return [`/$bunfs/root/${n}`, new Uint8Array(await r.arrayBuffer())]
    }))
    assets.catch(() => { assets = null })
  }
  return assets
}

function sessionsDir(projectId: string) {
  const base = `${SAVED}/.claude/projects`
  const enc = sessionsSlug(cwd(projectId))
  if (wfs().exists(`${base}/${enc}`)) return `${base}/${enc}`
  // Rutas muy largas: Claude Code recorta el nombre y le agrega un hash.
  const d = wfs().list(base).find((e) => e.dir && e.name.startsWith(enc.slice(0, 180)))
  return d ? `${base}/${d.name}` : null
}

/** Lo guardado de la carpeta personal: la configuración y, de las conversaciones, sólo la que se retoma. */
async function homeFiles(projectId: string, resume?: string) {
  const fs = wfs()
  const dir = resume && sessionsDir(projectId)
  const keep = dir ? `${dir.slice(SAVED.length + 1)}/${resume}` : null
  const out: Array<[string, Uint8Array]> = []
  for (const e of fs.walk(SAVED, { depth: 12, max: 20000, skipHidden: false })) {
    if (e.dir || !e.path) continue
    if (e.path.startsWith('.claude/projects/') && !(keep && (e.path === `${keep}.jsonl` || e.path.startsWith(`${keep}/`)))) continue
    out.push([`${HOME}/${e.path}`, new Uint8Array(await (await fs.fileBlob(`${SAVED}/${e.path}`)).arrayBuffer())])
  }
  return out
}

/** Lo que Claude Code escribió en su carpeta personal, a la carpeta de datos. */
function save(files: Array<[string, Uint8Array | null]>) {
  for (const [p, data] of files) {
    if (!p.startsWith(HOME + '/')) continue
    const to = `${SAVED}/${p.slice(HOME.length + 1)}`
    try { if (data) wfs().writeBytes(to, data); else wfs().delete(to) } catch (e) { console.error('No se pudo guardar', to, e) }
  }
}

/** El MCP de OpenAnimator (HTTP "streamable" con respuestas JSON): las herramientas corren acá, sobre el proyecto. */
const toMcp = (c: ToolContent) => c.map((b) => (b.type === 'image' ? { type: 'image', data: b.source.data, mimeType: b.source.media_type } : { type: 'text', text: b.text }))
const phone = (s: string) => s.replace(/a la tablet/g, 'al teléfono').replace(/la tablet/g, 'el teléfono')
async function mcp(m: { method: string; body: string }, projectId: string) {
  const json = (obj: unknown, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) })
  if (m.method !== 'POST') return { status: 405, headers: {}, body: '' } // sin flujo de eventos: todo va en la respuesta
  let req: any
  try { req = JSON.parse(m.body || '{}') } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } }, 400) }
  if (req.id === undefined || req.id === null) return { status: 202, headers: {}, body: '' } // notificación
  const ok = (result: unknown) => json({ jsonrpc: '2.0', id: req.id, result })
  switch (req.method) {
    case 'initialize': return ok({ protocolVersion: req.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'openanimator', version: '1' } })
    case 'ping': return ok({})
    case 'tools/list': return ok({ tools: TOOL_DEFS.map((t) => ({ name: t.name, description: phone(t.description), inputSchema: t.input_schema })) })
    case 'tools/call': {
      const name = String(req.params?.name || ''), input = req.params?.arguments || {}
      const bad = validateInput(name, input)
      if (bad) return ok({ content: [{ type: 'text', text: bad }], isError: true })
      try { return ok({ content: toMcp(await runTool(name, input, { projectId, changed: (f) => projectChanged(projectId, f) })) }) } catch (e: any) { return ok({ content: [{ type: 'text', text: String(e?.message || e) }], isError: true }) }
    }
    default: return json({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Método no soportado: ' + req.method } })
  }
}

/**
 * Arranca Claude Code con `args` en un Worker nuevo. `onMessage` recibe lo que manda (stdout, stderr, exit, crash);
 * lo que escribe en su carpeta se guarda siempre, aunque la conversación ya se haya cerrado.
 */
function launch(args: string[], o: { projectId: string; resume?: string; onMessage: (w: Worker, m: any) => void }) {
  const w = new Worker(`${web().base}claude/worker.js`, { type: 'module' })
  w.onmessage = ({ data: m }) => {
    if (m.type === 'fs') save(m.files)
    else if (m.type === 'mcp') void mcp(m, o.projectId).then((r) => w.postMessage({ type: 'mcp-reply', id: m.id, ...r }))
    else if (m.type === 'net') netStart(w, m)
    else if (m.type === 'net-cancel') netCancel(m.id)
    else o.onMessage(w, m)
  }
  w.onerror = (e) => o.onMessage(w, { type: 'crash', error: e.message || 'El Worker de Claude Code se cerró' })
  const started = (async () => {
    const m = await manifest()
    if (!m) throw new Error('Claude Code todavía no está instalado en el teléfono: instalalo en Ajustes › Claude.')
    const token = web().secrets.get(TOKEN), d = dev()
    if (!token && !d.env) throw new Error('Falta conectar tu cuenta de Claude: pegá el token de «claude setup-token» en Ajustes › Claude.')
    const files = [...(await bunAssets(m)), ...(await homeFiles(o.projectId, o.resume))]
    const env: Record<string, string> = {
      HOME, USER: 'user', LOGNAME: 'user', SHELL: '/bin/sh', PATH: '/usr/bin:/bin', TERM: 'dumb', LANG: 'es_AR.UTF-8', TMPDIR: '/tmp',
      DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
      ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}), ...d.env,
    }
    w.postMessage({ type: 'start', opts: { argv: ['node', '/$bunfs/root/cli', ...args], env, cwd: cwd(o.projectId), home: HOME, files, dirs: [`${HOME}/.claude`], assets: m.loaders, preload: m.preload, base: m.base, native: web().native } })
    return m
  })()
  return { w, started }
}

// ── conversación ───────────────────────────────────────────────────────────────
class WebChat extends ClaudeStreamSession {
  private w: Worker | null = null
  private ready = false
  private queue: unknown[] = []
  private out = ''
  private errTail = ''
  protected get alive() { return !!this.w }

  start() {
    const o = this.opts
    this.ready = false
    this.queue = []
    this.out = ''
    this.errTail = ''
    const p = { w: null as Worker | null }
    const mine = (w: Worker) => this.w === w
    ;(async () => {
      const system = await buildSystem(o.projectId, 'web', o.saver !== false, o.extraInstructions || '')
      const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--permission-prompt-tool', 'stdio', '--permission-mode', o.permissionMode || 'acceptEdits',
        '--mcp-config', JSON.stringify({ mcpServers: { openanimator: { type: 'http', url: 'http://oa.mcp/mcp' } } }), '--strict-mcp-config',
        // Como en la tablet: sin la configuración del usuario ni las herramientas propias de Claude Code (no hay
        // terminal ni disco): todo pasa por las de OpenAnimator.
        '--setting-sources', '', '--tools', '', '--append-system-prompt', system, '--allowedTools', READONLY.join(',')]
      if (o.model) args.push('--model', o.model)
      if (o.effort) args.push('--effort', o.effort)
      if (o.resume) args.push('--resume', o.resume)
      if (p.w !== this.w) return // se cerró mientras arrancaba
      const { w, started } = launch(args, { projectId: o.projectId, resume: o.resume, onMessage: (w, m) => { if (mine(w)) this.fromWorker(w, m) } })
      this.w = p.w = w
      await started
      if (!mine(w)) return
      this.ready = true
      for (const m of this.queue.splice(0)) this.post(m)
    })().catch((e) => {
      if (p.w !== this.w) return
      this.notice(String(e?.message || e), 'error')
      this.stop(this.w, null)
    })
    // Mientras se arma el sistema, un "Worker" de mentira mantiene viva la conversación (lo que se escribe espera).
    this.w = p.w = PENDING
    this.state()
    return true
  }

  private fromWorker(w: Worker, m: any) {
    if (m.type === 'stdout') {
      this.out += m.data
      for (let i; (i = this.out.indexOf('\n')) >= 0;) {
        const line = this.out.slice(0, i)
        this.out = this.out.slice(i + 1)
        if (line.trim()) this.onLine(line)
      }
    } else if (m.type === 'stderr') {
      this.errTail = (this.errTail + m.data).slice(-3000)
      console.warn('[claude]', String(m.data).trim().slice(0, 3000)) // al registro de la app
    }
    else if (m.type === 'exit') this.stop(w, m.code)
    else if (m.type === 'crash') { this.errTail += '\n' + m.error; console.error('[claude] se cerró:', m.error); this.stop(w, 1) }
  }

  private stop(w: Worker | null, code: number | null) {
    if (!w || this.w !== w) return
    this.w = null
    this.ready = false
    this.queue = []
    if (w !== PENDING) { netDrop(w); w.terminate() }
    this.closed(code, this.errTail)
  }

  private post(obj: unknown) { this.w?.postMessage({ type: 'stdin', data: JSON.stringify(obj) + '\n' }) }
  protected writeLine(obj: unknown) {
    if (!this.w) return
    if (this.ready) this.post(obj); else this.queue.push(obj)
  }

  /** Cerrar la entrada: Claude Code termina solo y guarda lo último; si no, se corta a los 3 s. */
  protected terminate() {
    const w = this.w
    this.w = null
    this.ready = false
    this.queue = []
    if (!w || w === PENDING) return
    w.postMessage({ type: 'stdin-end' })
    setTimeout(() => w.terminate(), 3000)
  }

  /** Pantalla encendida mientras Claude trabaja: con la pantalla bloqueada Safari congela la página y el turno. */
  private awake: (() => void) | null = null
  protected state() {
    super.state()
    if (this.busy && !this.awake) this.awake = holdAwake()
    else if (!this.busy && this.awake) { this.awake(); this.awake = null }
  }

  /** "Aceptar ediciones": como en la PC, escribir archivos del proyecto no pide permiso. */
  protected autoAllow(tool: string) {
    return this.opts.permissionMode === 'acceptEdits' && tool.startsWith(MCP) && toolKind(tool.slice(MCP.length)) === 'edit'
  }

  protected onMessage(m: any) {
    if (dev().env && m?.type === 'result' && m.is_error) console.warn('[claude result]', JSON.stringify(m).slice(0, 3000))
    super.onMessage(m)
    if (m?.type === 'result' && m.is_error && /oauth|token|log ?in|auth|credential|401/i.test(String(m.result || ''))) {
      this.notice('Claude no aceptó tu token (¿venció o lo revocaste?). Generá otro con «claude setup-token» y pegalo en Ajustes › Claude.', 'warn')
    }
  }
}
/** Marcador de "arrancando" (start es sincrónico; el Worker se crea cuando está listo lo que necesita). */
const PENDING = {} as Worker

// ── API para index.ts (las mismas funciones que code.ts) ──────────────────────
const chats = new Map<string, WebChat>()

function options(projectId: string, resume?: string): ChatOptions {
  const c = getSettings().claude
  return { projectId, permissionMode: c.permissionMode || 'acceptEdits', model: c.model || undefined, effort: c.effort || undefined, extraInstructions: c.extraInstructions, resume, saver: c.saver !== false }
}

function snapshot(chat: WebChat) {
  const o = chat.opts
  return { id: chat.id, items: chat.items, busy: chat.busy, sessionId: chat.sessionId, options: { model: o.model || '', effort: o.effort || '', permissionMode: o.permissionMode }, stats: chat.stats(), model: chat.model, signalAt: chat.lastSignal || undefined }
}

export async function listSessions(projectId: string) {
  const dir = sessionsDir(projectId)
  if (!dir) return []
  const out: Array<{ id: string; title: string; first: string; updated: number; size: number }> = []
  for (const e of wfs().list(dir)) {
    if (e.dir || !e.name.endsWith('.jsonl') || e.size < 400) continue
    const b = await wfs().fileBlob(`${dir}/${e.name}`)
    const info = sessionInfo(await b.slice(0, 256 * 1024).text(), await b.slice(Math.max(0, b.size - 128 * 1024)).text())
    if (info) out.push({ id: e.name.slice(0, -6), ...info, updated: e.mtime, size: e.size })
  }
  return out.sort((a, b) => b.updated - a.updated)
}

async function loadTranscript(projectId: string, sessionId: string): Promise<ChatItem[]> {
  const dir = sessionsDir(projectId)
  if (!dir || !/^[\w-]+$/.test(sessionId) || !wfs().exists(`${dir}/${sessionId}.jsonl`)) return []
  return parseTranscript(await (await wfs().fileBlob(`${dir}/${sessionId}.jsonl`)).text())
}

export async function createChat(projectId: string, o?: { resume?: string }) {
  if (!projectDir(projectId)) throw new Error('Proyecto no encontrado')
  const chat = new WebChat(options(projectId, o?.resume), (e) => send('chat:event', e))
  if (o?.resume) { chat.items = await loadTranscript(projectId, o.resume); chat.sessionId = o.resume }
  chats.set(chat.id, chat)
  return snapshot(chat)
}
export function getChat(id: string) { const c = chats.get(id); return c ? snapshot(c) : null }
export function sendChat(id: string, text: string, images: Array<{ mediaType: string; data: string }>, files: string[]) { chats.get(id)?.send(String(text || ''), images || [], files || []) }
export function interruptChat(id: string) { chats.get(id)?.interrupt() }
export function respondPermission(id: string, itemId: string, allow: boolean, always: boolean) { chats.get(id)?.respondPermission(itemId, allow, always) }
export function killChat(id: string) { const c = chats.get(id); if (c) { c.kill(); chats.delete(id) } }
export function compactChat(id: string, instructions?: string) { chats.get(id)?.compact(instructions) }
export function setChatOptions(id: string, patch: any, label: string) {
  const o: Partial<ChatOptions> = {}
  for (const k of ['model', 'effort', 'permissionMode'] as const) if (k in (patch || {})) (o as any)[k] = patch[k] || undefined
  if ('saver' in (patch || {})) o.saver = !!patch.saver
  if ('extraInstructions' in (patch || {})) o.extraInstructions = String(patch.extraInstructions || '')
  chats.get(id)?.setOptions(o, String(label || 'Opciones actualizadas.'))
}

/** Prueba de conexión (Ajustes): arranca Claude Code y le pide una respuesta mínima con Haiku (casi no gasta el plan). */
export function testClaude(): Promise<string> {
  const t0 = Date.now()
  let out = '', err = '', version = '', timer: ReturnType<typeof setTimeout>
  return new Promise<string>((resolve, reject) => {
    const { w, started } = launch(['-p', 'Respondé solamente: ok', '--output-format', 'json', '--model', 'haiku', '--tools', '', '--setting-sources', '', '--strict-mcp-config'], {
      projectId: '.prueba',
      onMessage: (_w, m) => {
        if (m.type === 'stdout') out += m.data
        else if (m.type === 'stderr') err = (err + m.data).slice(-2000)
        else if (m.type === 'exit' || m.type === 'crash') {
          clearTimeout(timer)
          netDrop(w); w.terminate()
          let r: any = null
          try { r = JSON.parse(out.trim().split('\n').pop() || '') } catch { /* no respondió JSON */ }
          if (r && !r.is_error) resolve(`Conectado · Claude Code ${version} · respondió en ${((Date.now() - t0) / 1000).toFixed(1)} s`)
          else reject(new Error(String(r?.result || m.error || err.trim().split('\n').slice(-3).join(' ') || `Claude Code terminó con el código ${m.code}`)))
        }
      },
    })
    timer = setTimeout(() => { netDrop(w); w.terminate(); reject(new Error('Claude Code no respondió en 90 s.')) }, 90000)
    started.then((m) => { version = m.version; w.postMessage({ type: 'stdin-end' }) }, (e) => { clearTimeout(timer); netDrop(w); w.terminate(); reject(e) })
  })
}
