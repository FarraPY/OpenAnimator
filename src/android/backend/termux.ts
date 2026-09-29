/**
 * Claude Code en Termux, con el plan del usuario. La app no puede ejecutar programas; Termux sí:
 * con su permiso RUN_COMMAND la app instala y arranca ahí un puente (android/termux/bridge.mjs) y
 * habla con él por 127.0.0.1 (Java hace la conexión: TermuxLink). El puente lanza el Claude Code
 * oficial y le presta por MCP las herramientas de la app (tools.ts), que se ejecutan acá, sobre los
 * proyectos. La sesión de Claude (el inicio de sesión del plan) queda en Termux.
 */
import bridgeSrc from '../../../android/termux/bridge.mjs?raw'
import mcpSrc from '../../../android/termux/oa-mcp.mjs?raw'
import { host } from '../host'
import { projectChanged } from './events'
import { fs } from './fsx'
import { runTool, validateInput, type ToolContent } from './tools'

export const PORT = 47821
const VERSION = +(/const VERSION = (\d+)/.exec(bridgeSrc)?.[1] || 0)
const PREFIX = '/data/data/com.termux/files/usr'
const HOME = '/data/data/com.termux/files/home'
const BASH = `${PREFIX}/bin/bash`
const TOKEN_FILE = '.termux-token'

/**
 * Lo que el usuario pega una vez en Termux: Node.js (para el puente), Claude Code con el instalador
 * de la comunidad (el oficial no soporta Android) y el permiso para que otras apps le manden comandos.
 */
export const SETUP_COMMAND = [
  // Termux no admite actualizaciones a medias: un Node.js nuevo con OpenSSL viejo no arranca.
  'yes | pkg upgrade',
  'pkg install -y nodejs',
  'curl -fsSL https://raw.githubusercontent.com/gtbuchanan/claude-code-termux/main/install.sh | bash',
  "mkdir -p ~/.termux && touch ~/.termux/termux.properties && sed -i '/^[[:space:]]*allow-external-apps/d' ~/.termux/termux.properties && echo 'allow-external-apps = true' >> ~/.termux/termux.properties && termux-reload-settings",
  'echo && echo "Listo. Volvé a OpenAnimator."',
].join(' && ')

export type TermuxStatus = { installed: boolean; version?: string; store?: string; permission: boolean }
export type BridgeStatus = {
  version: number; node: string
  claude: { path: string; version: string | null; error?: string } | null
  auth: { loggedIn: boolean; method: string; provider: string } | null
}

export const termuxStatus = (): TermuxStatus => host().call('termux.status')
export const requestPermission = () => host().callAsync<boolean>('termux.permission')
export const openTermux = () => host().call<boolean>('termux.open')

function token() {
  try { const t = fs.readText(TOKEN_FILE).trim(); if (t.length >= 32) return t } catch { /* no hay */ }
  const b = crypto.getRandomValues(new Uint8Array(30))
  const t = btoa(String.fromCharCode(...b)).replace(/[^A-Za-z0-9]/g, '')
  fs.writeText(TOKEN_FILE, t)
  return t
}

// ── conexión con el puente ──────────────────────────────────────────────────────
type Proc = { project: string; out: (msg: any) => void; exit: (code: number, err: string) => void }
const procs = new Map<string, Proc>()
const replies = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>()
let current: string | null = null // id de la conexión abierta
let connecting: Promise<string> | null = null
let fresh = true // la primera conexión de esta apertura de la app cierra las conversaciones viejas del puente
let seq = 0

const sendRaw = (link: string, obj: unknown) => host().call('termux.send', { link, line: JSON.stringify(obj) })
function sendNow(obj: unknown) {
  if (!current) throw new Error('Se cortó la conexión con Termux.')
  sendRaw(current, obj)
}

/** Abre una conexión y se presenta; resuelve con su id (o falla: "sin puente", "token", …). */
function open(): Promise<{ link: string; version: number }> {
  const link = `tl${++seq}-${Date.now().toString(36)}`
  return new Promise((resolve, reject) => {
    let greeted = false
    const hello = JSON.stringify({ t: 'hello', token: token(), version: VERSION, fresh })
    host().callAsync<boolean>('termux.link', { port: PORT, hello }, {
      id: link,
      onEvent: (e) => {
        if (e?.event !== 'line') return
        let m: any
        try { m = JSON.parse(e.line) } catch { return }
        if (!greeted) {
          greeted = true
          if (m.t === 'hello' && m.ok) { fresh = false; resolve({ link, version: m.version }) } else reject(new Error('token'))
          return
        }
        onMessage(m)
      },
    }).then(() => { if (!greeted) reject(new Error('sin puente')); else closed(link) }, (e) => { if (!greeted) reject(e); else closed(link) })
  })
}

function closed(link: string) {
  if (current !== link) return
  current = null
  for (const [id, p] of procs) { procs.delete(id); p.exit(1, 'Se cortó la conexión con Termux (¿Android cerró Termux?).') }
  for (const [id, w] of replies) { replies.delete(id); w.reject(new Error('Se cortó la conexión con Termux.')) }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Conexión con el puente: lo instala (o actualiza) y lo arranca si hace falta. */
export function bridge(): Promise<string> {
  if (current) return Promise.resolve(current)
  if (!connecting) connecting = connectOrStart().finally(() => { connecting = null })
  return connecting
}

async function connectOrStart(): Promise<string> {
  const st = termuxStatus()
  if (!st.installed) throw new Error('Termux no está instalado. Configuralo en Ajustes › Claude.')
  if (!st.permission) throw new Error('OpenAnimator todavía no tiene permiso para usar Termux. Dáselo en Ajustes › Claude.')
  try {
    const c = await open()
    if (c.version === VERSION) { current = c.link; return c.link }
    // Un puente de otra versión de la app: se reemplaza.
    host().call('termux.close', { link: c.link })
  } catch (e: any) {
    if (!/sin puente|token/.test(String(e?.message))) throw e
  }
  await install()
  const exited = start()
  let last: any
  for (let i = 0; i < 40; i++) {
    await sleep(i < 10 ? 250 : 500)
    const r = exited.result
    if (r) {
      const detail = tail(r.stderr || r.stdout || r.errmsg) || 'sin detalles'
      throw new Error(hint(detail) ? `${hint(detail)} (Detalle: ${detail})` : `El puente de Termux se cerró al arrancar (código ${r.exitCode}): ${detail}`)
    }
    try { const c = await open(); current = c.link; return c.link } catch (e) { last = e }
  }
  throw new Error(`El puente de Termux no arrancó (${last?.message || 'sin respuesta'}). ${await diagnose()}`)
}

const tail = (t: string, n = 4) => (t || '').trim().split('\n').slice(-n).join(' · ').slice(0, 600)

/** Lo último del registro del puente en Termux, para que el error diga qué pasó. */
async function diagnose() {
  try {
    const r = await host().callAsync<RunResult>('termux.run', {
      path: BASH, args: ['-c', 'tail -n 6 "$HOME/.openanimator/bridge.log" 2>&1; node --version 2>&1'], background: true, result: true, timeoutMs: 15000, label: 'OpenAnimator: diagnóstico',
    })
    return `Termux dice: ${tail(r.stdout || r.stderr, 7) || 'nada'}`
  } catch (e: any) { return `No se pudo leer el registro del puente: ${e.message}` }
}

/** Resultado de un comando en Termux (err -1 = sin error de Termux). */
type RunResult = { stdout: string; stderr: string; exitCode: number; err: number; errmsg: string }

/** Errores conocidos de Termux, con lo que hay que hacer. */
function hint(text: string) {
  if (/CANNOT LINK EXECUTABLE|cannot locate symbol/i.test(text)) return 'A Termux le faltan actualizaciones y Node.js no arranca: abrí Termux, ejecutá «yes | pkg upgrade» y volvé a probar.'
  if (/node: (command )?not found|Falta Node\.js/i.test(text)) return 'Falta Node.js en Termux: corré el comando de preparación (paso 2) y volvé a probar.'
  return ''
}

function checkRun(r: RunResult, what: string) {
  if (/allow-external-apps/i.test(r.errmsg || '')) throw new Error('Falta preparar Termux: pegá en Termux el comando de preparación (Ajustes › Claude) y volvé a intentar.')
  if (r.err !== undefined && r.err !== -1 && r.errmsg) throw new Error(`Termux no ejecutó ${what}: ${r.errmsg.split('\n')[0]}`)
  const detail = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ')
  if (r.exitCode !== 0) throw new Error(hint(detail) || `${what} falló: ${detail || `código ${r.exitCode}`}`)
}

/** Copia los archivos del puente a ~/.openanimator (van dentro del APK: siempre de esta versión). */
async function install() {
  const file = (name: string, src: string, eof: string) => [`cat > "$HOME/.openanimator/${name}" <<'${eof}'`, src.replace(/\n$/, ''), eof]
  const script = [
    'set -e',
    'mkdir -p "$HOME/.openanimator"',
    // El token queda en la carpeta privada de Termux (otras apps no la ven); el puente lo lee al arrancar.
    `(umask 077 && printf '%s\\n' '${token()}' > "$HOME/.openanimator/token")`,
    ...file('bridge.mjs', bridgeSrc, 'OA_BRIDGE_EOF'),
    ...file('oa-mcp.mjs', mcpSrc, 'OA_MCP_EOF'),
    'command -v node >/dev/null 2>&1 || { echo "Falta Node.js en Termux: corré el comando de preparación (pkg install nodejs)." >&2; exit 3; }',
    // Que exista no alcanza: tiene que poder arrancar (con paquetes viejos no enlaza).
    'v=$(node --version 2>&1) || { echo "$v" >&2; exit 4; }',
    'echo listo',
  ].join('\n') + '\n'
  const r = await host().callAsync<RunResult>('termux.run', { path: BASH, args: ['-s'], stdin: script, background: true, result: true, timeoutMs: 60000, label: 'OpenAnimator: instalar el puente' })
  checkRun(r, 'la instalación del puente')
}

/**
 * Arranca el puente (node directo, sin shell). Termux avisa cuando el proceso termina: si pasa enseguida,
 * `result` trae su salida para mostrar el motivo.
 */
function start() {
  const state: { result: RunResult | null } = { result: null }
  host().callAsync<RunResult>('termux.run', {
    path: `${PREFIX}/bin/node`, background: true, result: true, timeoutMs: 7 * 24 * 3600e3, label: 'OpenAnimator: Claude Code',
    args: [`${HOME}/.openanimator/bridge.mjs`, '--port', String(PORT), '--token-file', `${HOME}/.openanimator/token`],
  }).then((r) => { state.result = r || { stdout: '', stderr: '', exitCode: -1, err: 0, errmsg: '' } }, (e) => { state.result = { stdout: '', stderr: String(e?.message || e), exitCode: -1, err: 0, errmsg: '' } })
  return state
}

// ── mensajes del puente ─────────────────────────────────────────────────────────
function onMessage(m: any) {
  switch (m.t) {
    case 'out': procs.get(m.proc)?.out(m.msg); break
    case 'exit': {
      const p = procs.get(m.proc)
      if (p) { procs.delete(m.proc); p.exit(m.code ?? 1, m.err || '') }
      break
    }
    case 'tool': void runBridgeTool(m); break
    case 'reply': {
      const w = replies.get(m.id)
      if (w) { replies.delete(m.id); if (m.ok) w.resolve(m.value); else w.reject(new Error(m.error || 'Error del puente')) }
      break
    }
  }
}

/** Formato MCP de un resultado de herramienta. */
const toMcp = (c: ToolContent) => c.map((b) => (b.type === 'image' ? { type: 'image', data: b.source.data, mimeType: b.source.media_type } : { type: 'text', text: b.text }))

/** Una herramienta que Claude Code pidió por MCP: se ejecuta acá, sobre el proyecto de la conversación. */
async function runBridgeTool(m: { call: string; proc: string; name: string; input: any }) {
  const reply = (content: any[], isError = false) => { try { sendNow({ t: 'toolResult', call: m.call, content, isError }) } catch { /* se cortó */ } }
  const p = procs.get(m.proc)
  if (!p) { reply([{ type: 'text', text: 'Esta conversación ya no está abierta en OpenAnimator.' }], true); return }
  const bad = validateInput(m.name, m.input)
  if (bad) { reply([{ type: 'text', text: bad }], true); return }
  try {
    const content = await runTool(m.name, m.input, { projectId: p.project, changed: (f: string) => projectChanged(p.project, f) })
    reply(toMcp(content))
  } catch (e: any) {
    reply([{ type: 'text', text: String(e?.message || e) }], true)
  }
}

// ── API para code.ts y los ajustes ──────────────────────────────────────────────
export async function request<T = any>(op: string, extra: Record<string, unknown> = {}): Promise<T> {
  await bridge()
  const id = `q${++seq}`
  return new Promise<T>((resolve, reject) => {
    replies.set(id, { resolve, reject })
    try { sendNow({ t: 'req', id, op, ...extra }) } catch (e) { replies.delete(id); reject(e as Error); return }
    setTimeout(() => { if (replies.delete(id)) reject(new Error('El puente de Termux no respondió.')) }, 60000)
  })
}

export const bridgeStatus = () => request<BridgeStatus>('status')

/** Arranca Claude Code para una conversación (proc) del proyecto. */
export async function startProc(proc: string, project: string, opts: Record<string, unknown>, h: Omit<Proc, 'project'>) {
  await bridge()
  procs.set(proc, { ...h, project })
  sendNow({ t: 'start', proc, opts: { ...opts, project } })
}
export function sendProc(proc: string, msg: unknown) { sendNow({ t: 'in', proc, msg }) }
export function killProc(proc: string) {
  procs.delete(proc)
  try { if (current) sendRaw(current, { t: 'kill', proc }) } catch { /* ya estaba cortado */ }
}

/** Abre Termux con `claude auth login` en una sesión visible (el inicio de sesión del plan). */
export async function login() {
  await host().callAsync('termux.run', {
    path: BASH, background: false, result: false, label: 'Claude: iniciar sesión',
    args: ['-lc', 'claude auth login; echo; echo "Cuando termines, volvé a OpenAnimator."; read -r -p "Enter para cerrar " _'],
  })
  openTermux()
}
