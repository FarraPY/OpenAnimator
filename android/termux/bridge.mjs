#!/usr/bin/env node
/**
 * Puente de OpenAnimator en Termux.
 *
 * La app de Android no puede ejecutar Claude Code; Termux sí. Este programa corre dentro de Termux,
 * escucha sólo en 127.0.0.1 y, cuando la app se lo pide, lanza el Claude Code oficial del usuario
 * (`claude -p` con stream-json, con la sesión de su plan: el puente nunca toca las credenciales) y le
 * presta las herramientas de la app por MCP (oa-mcp.mjs), porque los proyectos viven en la app.
 *
 * Lo instala y lo arranca la app (Termux RUN_COMMAND); el token lo deja la instalación en
 * ~/.openanimator/token (sólo Termux lo puede leer) y el puente lo lee con --token-file.
 * Protocolo: una línea JSON por mensaje; la primera de cada conexión se presenta.
 *   app   → puente: hello {token, version, fresh} · start {proc, opts} · in {proc, msg} · kill {proc}
 *                   toolResult {call, content, isError} · req {id, op, …} · ping
 *   puente → app:   hello {ok, version} · out {proc, msg} · exit {proc, code, err}
 *                   tool {call, proc, name, input} · reply {id, ok, value | error} · pong
 *                   wprog {job, pct} (avance de una transcripción con Whisper)
 *   oa-mcp → puente: mcp {proc, key} · tools {id} · call {id, name, arguments}
 *
 * También transcribe con Whisper (whisper.cpp, compilado en Termux por whisper-install.sh): la app le
 * manda el audio como PCM de 16 kHz (whisper.put) y whisper.run devuelve el texto y cada palabra con
 * su tiempo. Todo queda en la tablet.
 */
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import readline from 'node:readline'
import { spawn, execFile } from 'node:child_process'

const VERSION = 5
const HOME = os.homedir()
const DIR = path.join(HOME, '.openanimator')
const TMP = path.join(DIR, 'tmp')
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def }
const PORT = +arg('port', 47821)
fs.mkdirSync(TMP, { recursive: true })

// ── registro (para diagnosticar desde Termux: cat ~/.openanimator/bridge.log) ─────────
const LOG = path.join(DIR, 'bridge.log')
function log(...a) {
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 512 * 1024) fs.renameSync(LOG, LOG + '.1')
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${a.join(' ')}\n`)
  } catch { /* sin registro */ }
}

// ── Claude Code ─────────────────────────────────────────────────────────────────
const canRun = (f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile() } catch { return false } }
function findClaude() {
  if (process.env.OA_CLAUDE_BIN) return process.env.OA_CLAUDE_BIN // pruebas en la PC
  const prefix = process.env.PREFIX || '/data/data/com.termux/files/usr'
  const dirs = [path.join(prefix, 'bin'), path.join(HOME, '.local', 'bin'), ...(process.env.PATH || '').split(':')]
  for (const d of dirs) if (d && canRun(path.join(d, 'claude'))) return path.join(d, 'claude')
  return null
}
/** Entorno para Claude Code: sin variables de otra sesión de Claude y sin su actualizador (lo actualiza el instalador de Termux). */
function claudeEnv() {
  const env = { ...process.env, DISABLE_AUTOUPDATER: '1' }
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT|OA_TOKEN)$/.test(k)) delete env[k]
  return env
}
const run = (bin, args, timeout = 30000) => new Promise((resolve) => {
  execFile(bin, args, { timeout, env: claudeEnv(), maxBuffer: 4 << 20 }, (e, stdout, stderr) => resolve({ ok: !e, code: e?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || '') }))
})

let claudeBin = findClaude()
let noTools = null // ¿entiende --tools ""? (se averigua una vez)
async function supportsToolsFlag() {
  if (noTools === null && claudeBin) noTools = / --tools </.test((await run(claudeBin, ['--help'])).stdout)
  return !!noTools
}
// Las herramientas propias de Claude Code verían el disco de Termux, no el proyecto: van todas por MCP.
const BUILTIN = ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS', 'NotebookEdit', 'NotebookRead', 'BashOutput', 'KillShell', 'KillBash', 'Task', 'WebFetch', 'WebSearch']

async function status() {
  claudeBin = findClaude()
  const out = { version: VERSION, node: process.version, claude: null, auth: null }
  if (!claudeBin) return out
  const v = await run(claudeBin, ['--version'])
  out.claude = { path: claudeBin, version: v.stdout.trim() || null, error: v.ok ? undefined : (v.stderr || v.stdout).trim().slice(-400) }
  const a = await run(claudeBin, ['auth', 'status', '--json'])
  try { const j = JSON.parse(a.stdout); out.auth = { loggedIn: !!j.loggedIn, method: j.authMethod || '', provider: j.apiProvider || '' } } catch { out.auth = null }
  return out
}

// ── conversaciones: un proceso de Claude Code por cada una ─────────────────────────
const procs = new Map() // proc → { child, key, tools, errTail, mcpFile }
// Llamadas a herramientas en curso (Claude Code → oa-mcp → puente → app): id → { proc, reply }
const calls = new Map()
let callSeq = 0
const safeId = (s) => String(s || '').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'x'
const MODES = new Set(['default', 'manual', 'acceptEdits', 'plan', 'bypassPermissions', 'auto', 'dontAsk'])
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/** Imágenes de los resultados de herramientas: la app sólo muestra el texto (no viajan de vuelta). */
function slim(msg) {
  const c = msg?.message?.content
  if (msg?.type !== 'user' || !Array.isArray(c)) return msg
  const strip = (b) => (b && b.type === 'image' ? { type: 'text', text: '[imagen]' } : b)
  msg.message.content = c.map((b) => (b?.type === 'tool_result' && Array.isArray(b.content) ? { ...b, content: b.content.map(strip) } : strip(b)))
  return msg
}

async function startProc(procId, o) {
  if (!claudeBin) claudeBin = findClaude()
  if (!claudeBin) throw new Error('No encontré Claude Code en Termux. Instalalo con el comando de la app (Ajustes › Claude).')
  killProc(procId)
  const key = crypto.randomBytes(18).toString('hex')
  const cwd = path.join(DIR, 'proyectos', safeId(o.project))
  fs.mkdirSync(cwd, { recursive: true })
  const mcpFile = path.join(TMP, `mcp-${safeId(procId)}.json`)
  const server = { command: process.execPath, args: [path.join(DIR, 'oa-mcp.mjs')], env: { OA_PORT: String(PORT), OA_PROC: procId, OA_KEY: key } }
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { openanimator: server } }), { mode: 0o600 })
  // --setting-sources "": sin la configuración del usuario en Termux (hooks, complementos, permisos propios).
  // Un complemento instalado ahí le agregaba instrucciones a la conversación; la de la app va aislada.
  // Lo único que la instalación de Termux necesita de esa configuración (no actualizarse solo) lo pone
  // DISABLE_AUTOUPDATER en claudeEnv().
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-prompt-tool', 'stdio', '--permission-mode', MODES.has(o.permissionMode) ? o.permissionMode : 'acceptEdits',
    '--mcp-config', mcpFile, '--strict-mcp-config', '--setting-sources', '']
  if (await supportsToolsFlag()) args.push('--tools', '')
  else args.push('--disallowedTools', BUILTIN.join(','))
  if (typeof o.system === 'string' && o.system) args.push('--append-system-prompt', o.system)
  const allowed = (Array.isArray(o.allowedTools) ? o.allowedTools : []).filter((t) => /^[\w-]+$/.test(t))
  if (allowed.length) args.push('--allowedTools', allowed.join(','))
  if (typeof o.model === 'string' && /^[\w.[\]-]+$/.test(o.model)) args.push('--model', o.model)
  if (EFFORTS.has(o.effort)) args.push('--effort', o.effort)
  if (typeof o.resume === 'string' && /^[\w-]+$/.test(o.resume)) args.push('--resume', o.resume)
  const child = spawn(claudeBin, args, { cwd, env: claudeEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
  // project/sessionId/busy/perms/history: para que una app que se reinició (Android cerró la página por
  // memoria) pueda retomar la conversación sin cortarla (ver adopt en el hello).
  const p = { child, key, tools: Array.isArray(o.tools) ? o.tools : [], errTail: '', mcpFile, project: String(o.project || ''), sessionId: null, busy: false, perms: new Map(), history: [], inflight: [] }
  procs.set(procId, p)
  log('start', procId, o.project, o.model || '(modelo por defecto)', o.resume ? `resume ${o.resume}` : '')
  child.stderr.on('data', (d) => { p.errTail = (p.errTail + d).slice(-3000) })
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    msg = slim(msg)
    track(p, msg)
    send({ t: 'out', proc: procId, msg })
  })
  child.on('error', (e) => { p.errTail += `\n${e.message}` })
  child.on('close', (code, signal) => {
    if (procs.get(procId) === p) procs.delete(procId)
    try { fs.rmSync(mcpFile, { force: true }) } catch { /* ignore */ }
    for (const [cid, c] of calls) if (c.proc === procId) { calls.delete(cid); c.reply({ content: [{ type: 'text', text: 'Claude Code terminó.' }], isError: true }) }
    log('exit', procId, code ?? signal)
    send({ t: 'exit', proc: procId, code: code ?? (signal ? 1 : 0), err: p.errTail.trim().slice(-2000) })
  })
}

/** Una versión liviana de un mensaje para la historia (las entradas y resultados largos se recortan). */
function lite(m) {
  const cut = (v) => (typeof v === 'string' && v.length > 4000 ? v.slice(0, 4000) + '…' : v)
  const c = m?.message?.content
  if (!Array.isArray(c)) return m
  const content = c.map((b) => {
    if (b?.type === 'tool_use' && b.input && typeof b.input === 'object') return { ...b, input: Object.fromEntries(Object.entries(b.input).map(([k, v]) => [k, cut(v)])) }
    if (b?.type === 'tool_result') return { ...b, content: typeof b.content === 'string' ? cut(b.content) : Array.isArray(b.content) ? b.content.map((x) => (x?.type === 'text' ? { ...x, text: cut(x.text) } : x)) : b.content }
    return b
  })
  return { ...m, message: { ...m.message, content } }
}

/**
 * Lo que hace falta para retomar la conversación: los mensajes completos (history), lo que está llegando
 * del mensaje en curso (inflight), si está trabajando y los permisos sin responder.
 */
function track(p, m) {
  if (m.type === 'stream_event') { p.inflight.push(m); if (p.inflight.length > 5000) p.inflight.shift(); return }
  if (m.type === 'system' && m.subtype === 'init') p.sessionId = m.session_id || p.sessionId
  if (m.type === 'result') p.busy = false
  if (m.type === 'control_request') { if (m.request?.subtype === 'can_use_tool') p.perms.set(m.request_id, m); return }
  if (m.type === 'control_response' || m.type === 'active_goal' || m.type === 'autocompact_state' || m.type === 'rate_limit_event' || (m.type === 'system' && m.subtype === 'thinking_tokens')) return
  p.inflight = []
  p.history.push(lite(m))
  if (p.history.length > 800) p.history.splice(0, p.history.length - 800)
}

function userEcho(msg) {
  const c = msg?.message?.content
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : ''
  return { type: 'oa_user', text, images: Array.isArray(c) ? c.filter((b) => b?.type === 'image').length : 0 }
}

const procList = () => [...procs].map(([proc, p]) => ({ proc, project: p.project, sessionId: p.sessionId, busy: p.busy, perms: [...p.perms.values()], history: [...p.history, ...p.inflight] }))

function killProc(procId) {
  const p = procs.get(procId)
  if (!p) return
  procs.delete(procId)
  try { p.child.kill('SIGTERM') } catch { /* ignore */ }
  setTimeout(() => { try { p.child.kill('SIGKILL') } catch { /* ignore */ } }, 3000).unref()
}

// ── historial: lo que Claude Code guarda de cada conversación en ~/.claude/projects/ ──
const CTX_SUFFIX = /\n\n\(Contexto del editor:[\s\S]*$/
const userText = (m) => {
  const c = m?.message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  return ''
}
const isRealPrompt = (m) => m.type === 'user' && !m.isMeta && !m.isSidechain && !!userText(m).trim() && !/^\s*<|^\[Request interrupted/.test(userText(m))
function sessionsDir(project) {
  const cwd = path.join(DIR, 'proyectos', safeId(project))
  const base = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), 'projects')
  const enc = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (fs.existsSync(path.join(base, enc))) return path.join(base, enc)
  try { const d = fs.readdirSync(base).find((x) => x.startsWith(enc.slice(0, 180))); return d ? path.join(base, d) : null } catch { return null }
}
function readSlice(f, start, len) {
  const fd = fs.openSync(f, 'r')
  try { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, start); return b.subarray(0, n).toString('utf8') } finally { fs.closeSync(fd) }
}
function listSessions(project) {
  const dir = sessionsDir(project)
  if (!dir) return []
  const out = []
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
    const file = path.join(dir, f)
    const st = fs.statSync(file)
    if (st.size < 400) continue
    let first = '', title = ''
    for (const line of readSlice(file, 0, Math.min(st.size, 256 * 1024)).split('\n')) {
      try { const m = JSON.parse(line); if (!first && isRealPrompt(m)) first = userText(m).replace(CTX_SUFFIX, '').trim() } catch { /* línea cortada */ }
      if (first) break
    }
    if (!first) continue
    const tail = readSlice(file, Math.max(0, st.size - 128 * 1024), Math.min(st.size, 128 * 1024))
    const titles = [...tail.matchAll(/"aiTitle":"((?:[^"\\]|\\.)*)"/g)]
    if (titles.length) try { title = JSON.parse(`"${titles[titles.length - 1][1]}"`) } catch { /* ignore */ }
    out.push({ id: f.slice(0, -6), title: title || first.split('\n')[0].slice(0, 80), first: first.slice(0, 220), updated: st.mtimeMs, size: st.size })
  }
  return out.sort((a, b) => b.updated - a.updated)
}
let seq = 0
const nid = (p) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`
function transcript(project, session) {
  const dir = sessionsDir(project)
  const file = dir && path.join(dir, `${session}.jsonl`)
  if (!file || !/^[\w-]+$/.test(session) || !fs.existsSync(file)) return []
  const items = []
  const tools = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let m
    try { m = JSON.parse(line) } catch { continue }
    if (m.isSidechain) continue
    if (m.type === 'system' && m.subtype === 'compact_boundary') { items.push({ id: nid('n'), kind: 'notice', text: 'Conversación compactada.', level: 'info' }); continue }
    const c = m.message?.content
    if (m.type === 'user') {
      if (m.isMeta || m.isCompactSummary) continue
      if (Array.isArray(c)) for (const b of c) if (b.type === 'tool_result') {
        const it = tools.get(b.tool_use_id)
        if (!it) continue
        const txt = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => (x.type === 'text' ? x.text : x.type === 'image' ? '[imagen]' : '')).join('\n') : ''
        it.status = b.is_error ? 'error' : 'ok'; it.isError = !!b.is_error; it.result = txt.slice(0, 4000)
      }
      if (isRealPrompt(m)) {
        const imgs = Array.isArray(c) ? c.filter((b) => b.type === 'image').length : 0
        items.push({ id: nid('u'), kind: 'user', text: userText(m), images: imgs || undefined })
      } else if (/^\[Request interrupted/.test(userText(m))) items.push({ id: nid('n'), kind: 'notice', text: 'Interrumpido.', level: 'info' })
    } else if (m.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text' && b.text?.trim()) items.push({ id: nid('a'), kind: 'assistant', text: b.text, status: 'ok' })
        else if (b.type === 'tool_use') { const it = { id: nid('tool'), kind: 'tool', name: b.name, input: b.input, status: 'ok' }; tools.set(b.id, it); items.push(it) }
      }
    }
  }
  return items.slice(-400)
}

// ── Whisper (whisper.cpp) ──────────────────────────────────────────────────────────
// whisper-install.sh deja el programa en whisper/bin, los modelos en whisper/models y una muestra de voz
// (whisper/jfk.wav) para medir la velocidad. Las transcripciones van de a una: cada una ocupa los núcleos
// grandes del procesador.
const WDIR = path.join(DIR, 'whisper')
const WBIN = path.join(WDIR, 'bin', 'whisper-cli')
const WMODELS = path.join(WDIR, 'models')
const DTW = new Set(['tiny', 'base', 'small', 'medium', 'large.v3', 'large.v3.turbo'])
const MODEL_FILE = /^ggml-[\w.-]+\.bin$/
const jobs = new Map() // job → { file, bytes, sample, child, cancelled }
let wQueue = Promise.resolve()
const jobId = (s) => (/^[\w-]{1,40}$/.test(String(s || '')) ? String(s) : null)
const cores = () => os.availableParallelism?.() || os.cpus().length || 4
const threads = (n) => Math.max(1, Math.min(+n || 4, cores(), 8))
for (const f of fs.readdirSync(TMP)) if (f.startsWith('whisper-')) fs.rmSync(path.join(TMP, f), { force: true })

function whisperStatus() {
  const models = []
  try { for (const f of fs.readdirSync(WMODELS)) if (MODEL_FILE.test(f)) models.push({ file: f, size: fs.statSync(path.join(WMODELS, f)).size }) } catch { /* sin modelos */ }
  let version = null
  try { version = fs.readFileSync(path.join(WDIR, 'VERSION'), 'utf8').trim() || null } catch { /* sin instalar */ }
  return { bin: canRun(WBIN), version, models, sample: fs.existsSync(path.join(WDIR, 'jfk.wav')), busy: [...jobs.values()].some((j) => j.child), cores: cores() }
}

/** El audio llega en partes: PCM mono de 16 bits a 16 kHz. La cabecera WAV se completa al final. */
function whisperPut(m) {
  const id = jobId(m.job)
  if (!id) throw new Error('Transcripción inválida')
  let j = jobs.get(id)
  if (!j) {
    if (jobs.size >= 4) throw new Error('Hay demasiadas transcripciones pendientes')
    j = { file: path.join(TMP, `whisper-${id}.wav`), bytes: 0, sample: false, child: null, cancelled: false }
    fs.writeFileSync(j.file, Buffer.alloc(44), { mode: 0o600 })
    jobs.set(id, j)
  }
  const data = Buffer.from(String(m.pcm || ''), 'base64')
  if (j.bytes + data.length > 400 << 20) throw new Error('El audio es demasiado largo para transcribirlo en la tablet')
  fs.appendFileSync(j.file, data)
  j.bytes += data.length
  return j.bytes
}

function wavHeader(bytes) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + bytes, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(bytes, 40)
  return h
}

/** whisper-cli no escapa los caracteres de control dentro de los textos ni los NaN: se arreglan antes de leer. */
function lenientJson(s) {
  try { return JSON.parse(s) } catch { /* se arregla abajo */ }
  let out = '', inStr = false, esc = false
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      else if (ch.charCodeAt(0) < 0x20) { out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'); continue }
    } else if (ch === '"') inStr = true
    out += ch
  }
  return JSON.parse(out.replace(/:\s*-?(nan|inf)\b/gi, ': null'))
}

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const r3 = (x) => Math.round(x * 1000) / 1000
const OPENER = /^[¿¡"'“‘«([-]+$/

/**
 * Palabras con su tiempo a partir de los tokens de whisper-cli (-ojf). El comienzo sale de la alineación
 * DTW (t_dtw, en centésimas: el momento en que se dice el token); el fin, del tiempo del último token,
 * sin pasar del comienzo de la palabra siguiente.
 */
function whisperResult(j) {
  const raw = [], texts = []
  for (const s of Array.isArray(j?.transcription) ? j.transcription : []) {
    if (typeof s.text === 'string') texts.push(s.text.trim())
    const segEnd = num(s.offsets?.to) / 1000
    let cur = null
    for (const t of Array.isArray(s.tokens) ? s.tokens : []) {
      const tx = typeof t.text === 'string' ? t.text : ''
      if (!tx || tx.startsWith('[_')) continue // [_BEG_], [_TT_…], [_EOT_]…
      const t1 = num(t.offsets?.to, -1000) / 1000
      const at = num(t.t_dtw, -1) >= 0 ? t.t_dtw / 100 : num(t.offsets?.from, -1000) / 1000
      // Palabra nueva: token con espacio adelante y con letras o números (o un signo que abre: ¿ ¡ « …).
      // La puntuación suelta se queda con la palabra anterior.
      const letters = /[\p{L}\p{N}]/u.test(tx)
      if (!cur || (/^\s/.test(tx) && (letters || OPENER.test(tx.trim())) && !OPENER.test(cur.w))) {
        if (cur) raw.push(cur)
        cur = { w: tx.trim(), start: at, t1, segEnd }
      } else {
        cur.w += letters && !OPENER.test(cur.w) ? tx : tx.trim()
        cur.t1 = Math.max(cur.t1, t1)
      }
    }
    if (cur) raw.push(cur)
  }
  const list = raw.filter((w) => w.w && /[\p{L}\p{N}]/u.test(w.w))
  const words = []
  let prev = 0
  for (let i = 0; i < list.length; i++) {
    const w = list[i], next = list[i + 1]
    const start = Math.max(prev, w.start >= 0 ? w.start : prev)
    const hi = Math.max(start, next ? next.start : w.segEnd)
    let end = w.t1 > start ? Math.min(w.t1, hi) : hi
    if (end - start < 0.02) end = next ? Math.max(hi, start + 0.02) : start + 0.2
    words.push({ w: w.w.replace(/\s+/g, ' ').trim(), start: r3(start), end: r3(end) })
    prev = start
  }
  return { text: texts.join(' ').replace(/\s+/g, ' ').trim(), words, lang: typeof j?.result?.language === 'string' ? j.result.language : null }
}

const lastLines = (t) => t.trim().split('\n').filter((l) => l.trim() && !/progress =/.test(l)).slice(-3).join(' · ').slice(-600)

/**
 * Contexto de audio para el codificador (0: la ventana entera de 30 s). Para menos de 27 s: lo que dura más 3 s,
 * en múltiplos de 64 y no menos de 512 (~10 s: con menos, Whisper empieza a equivocarse).
 */
function audioCtx(secs) {
  if (!(secs > 0) || secs >= 27) return 0
  return Math.min(1500, Math.max(512, Math.ceil(((secs + 3) * 50) / 64) * 64))
}

/** Corre whisper-cli sobre el audio subido (o la muestra) cuando termine la transcripción anterior. */
function whisperRun(m) {
  const id = jobId(m.job)
  if (!id) throw new Error('Transcripción inválida')
  if (!canRun(WBIN)) throw new Error('Whisper no está instalado en Termux: instalalo en Ajustes › Plugins › Whisper.')
  const model = String(m.model || '')
  if (!MODEL_FILE.test(model) || !fs.existsSync(path.join(WMODELS, model))) throw new Error(`Falta el modelo de Whisper ${model || ''}: descargalo en Ajustes › Plugins › Whisper.`)
  let j = jobs.get(id)
  if (m.sample) {
    const file = path.join(WDIR, 'jfk.wav')
    if (!fs.existsSync(file)) throw new Error('Falta la muestra de voz: volvé a instalar Whisper.')
    if (j) throw new Error('Transcripción repetida')
    j = { file, bytes: fs.statSync(file).size - 44, sample: true, child: null, cancelled: false }
    jobs.set(id, j)
  } else {
    if (!j || !j.bytes) throw new Error('No llegó el audio')
    const fd = fs.openSync(j.file, 'r+')
    try { fs.writeSync(fd, wavHeader(j.bytes), 0, 44, 0) } finally { fs.closeSync(fd) }
  }
  const lang = /^[a-z]{2,3}$/.test(String(m.lang || '')) ? String(m.lang) : 'auto'
  const job = j
  const run = () => new Promise((resolve, reject) => {
    if (job.cancelled) { reject(new Error('Transcripción cancelada')); return }
    const out = path.join(TMP, `whisper-${id}`)
    // -bs 1: búsqueda simple (el doble de rápida que la de 5 haces, y alcanza para una voz clara).
    // -sns: sin símbolos de "no habla" (♪…), como el Whisper original. DTW necesita -nfa.
    const args = ['-m', path.join(WMODELS, model), '-f', job.file, '-l', lang, '-t', String(threads(m.threads)), '-bs', '1', '-sns', '-ojf', '-of', out, '-pp']
    if (DTW.has(m.dtw)) args.push('-nfa', '--dtw', m.dtw)
    // -ac: el codificador (lo más caro) trabaja siempre sobre una ventana de 30 s; para un audio corto alcanza con
    // lo que dura más 3 s de silencio (con DTW tiene que cubrirlo entero: 50 posiciones por segundo). Un clip de
    // 10 s costaba como uno de 30 (y sin idioma, el doble: la primera ventana se escucha también para detectarlo).
    const secs = job.bytes / 32000
    const ctx = audioCtx(secs)
    if (ctx) args.push('-ac', String(ctx))
    const t0 = Date.now()
    let err = '', audioSec = 0, last = -1
    const timing = { ctx: ctx || 1500 } // lo que midió whisper.cpp (whisper_print_timings), para los detalles
    log('whisper', id, model, lang, job.sample ? 'muestra' : `${Math.round(job.bytes / 32000)} s`)
    const child = spawn(WBIN, args, { cwd: TMP, stdio: ['ignore', 'ignore', 'pipe'] })
    job.child = child
    readline.createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (l) => {
      err = (err + l + '\n').slice(-8000)
      const p = /progress =\s*(\d+)%/.exec(l)
      if (p && +p[1] !== last) { last = +p[1]; send({ t: 'wprog', job: id, pct: last }) }
      const a = /\((\d+) samples, ([\d.]+) sec\)/.exec(l)
      if (a) audioSec = +a[2]
      const tm = /whisper_print_timings:\s+(\w+) time =\s*([\d.]+) ms(?:\s*\/\s*(\d+) runs)?/.exec(l)
      if (tm) { timing[tm[1]] = Math.round(+tm[2]); if (tm[3]) timing[`${tm[1]}Runs`] = +tm[3] }
      const fb = /fallbacks =\s*(\d+) p \/\s*(\d+) h/.exec(l)
      if (fb) timing.fallbacks = +fb[1] + +fb[2]
    })
    child.on('error', (e) => { err += `\n${e.message}` })
    child.on('close', (code, signal) => {
      job.child = null
      const json = `${out}.json`
      try {
        if (job.cancelled) throw new Error('Transcripción cancelada')
        // Si no pudo leer el audio, whisper-cli 1.9.4 igual termina con 0: manda que exista el resultado.
        if (!fs.existsSync(json)) throw new Error(`Whisper falló (${signal || code}): ${lastLines(err) || 'sin detalles'}`)
        const r = whisperResult(lenientJson(fs.readFileSync(json, 'utf8')))
        log('whisper listo', id, `${r.words.length} palabras`, `${Date.now() - t0} ms`, JSON.stringify(timing))
        resolve({ ...r, ms: Date.now() - t0, audioSec: audioSec || job.bytes / 32000, timing })
      } catch (e) { log('whisper', id, e.message); reject(e) } finally { fs.rmSync(json, { force: true }) }
    })
  })
  job.queued = true
  const done = wQueue.then(run, run).finally(() => { jobs.delete(id); if (!job.sample) fs.rmSync(job.file, { force: true }) })
  wQueue = done.catch(() => {})
  return done
}

function whisperCancel(id) {
  const j = jobs.get(id)
  if (!j) return false
  j.cancelled = true
  if (j.child) { try { j.child.kill('SIGTERM') } catch { /* ya terminó */ } return true }
  // En la fila, whisperRun lo descarta al llegarle el turno; si sólo se estaba subiendo, se borra ya.
  if (!j.queued) { jobs.delete(id); if (!j.sample) fs.rmSync(j.file, { force: true }) }
  return true
}
/** La app se fue: sus transcripciones ya no tienen a quién responder. */
function dropJobs() { for (const id of [...jobs.keys()]) whisperCancel(id) }

function whisperRemove(file) {
  if (!MODEL_FILE.test(file)) throw new Error('Modelo inválido')
  fs.rmSync(path.join(WMODELS, file), { force: true })
  return whisperStatus()
}

// ── la app (una sola conexión a la vez) ─────────────────────────────────────────
let app = null
let appQueue = Promise.resolve()
let outbox = [] // lo que sale mientras la app no está conectada (p. ej. se cerró la pantalla un momento)
let outboxBytes = 0
let lastApp = Date.now()
let holding = false // la app está retomando conversaciones: lo que sale espera a su "flush" (en orden)
function send(obj) {
  const line = JSON.stringify(obj) + '\n'
  if (app && !app.destroyed && (!holding || obj.t === 'reply' || obj.t === 'pong')) { app.write(line); return }
  outbox.push(line)
  outboxBytes += line.length
  while (outboxBytes > 8 << 20 && outbox.length) outboxBytes -= outbox.shift().length
}
function flushOutbox() {
  if (!app || app.destroyed) return
  const pending = outbox
  outbox = []; outboxBytes = 0
  for (const l of pending) app.write(l)
}

async function fromApp(m) {
  switch (m.t) {
    case 'ping': send({ t: 'pong' }); return
    case 'start':
      try { await startProc(String(m.proc), m.opts || {}) } catch (e) {
        send({ t: 'exit', proc: String(m.proc), code: 127, err: String(e?.message || e) })
      }
      return
    case 'in': {
      const p = procs.get(String(m.proc))
      if (!p) return
      if (m.msg?.type === 'user') { p.busy = true; p.inflight = []; p.history.push(userEcho(m.msg)) }
      if (m.msg?.type === 'control_response') p.perms.delete(m.msg.response?.request_id)
      if (!p.child.stdin.destroyed) p.child.stdin.write(JSON.stringify(m.msg) + '\n')
      return
    }
    case 'flush': holding = false; flushOutbox(); return
    case 'kill': killProc(String(m.proc)); return
    case 'toolResult': {
      const c = calls.get(m.call)
      if (!c) return
      calls.delete(m.call)
      c.reply({ content: Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }], isError: !!m.isError })
      return
    }
    case 'req': {
      let value, error
      try {
        if (m.op === 'status') value = await status()
        else if (m.op === 'sessions') value = listSessions(m.project)
        else if (m.op === 'transcript') value = transcript(m.project, String(m.session || ''))
        else if (m.op === 'whisper.status') value = whisperStatus()
        else if (m.op === 'whisper.put') value = whisperPut(m)
        else if (m.op === 'whisper.run') value = await whisperRun(m)
        else if (m.op === 'whisper.cancel') value = whisperCancel(String(m.job || ''))
        else if (m.op === 'whisper.remove') value = whisperRemove(String(m.model || ''))
        else if (m.op === 'shutdown') { send({ t: 'reply', id: m.id, ok: true, value: true }); setTimeout(() => shutdown(0), 100); return }
        else throw new Error('Pedido desconocido: ' + m.op)
      } catch (e) { error = String(e?.message || e) }
      send(error ? { t: 'reply', id: m.id, ok: false, error } : { t: 'reply', id: m.id, ok: true, value })
    }
  }
}

function fromMcp(sock, procId, m) {
  const p = procs.get(procId)
  const reply = (o) => { if (!sock.destroyed) sock.write(JSON.stringify(o) + '\n') }
  if (m.t === 'tools') { reply({ id: m.id, tools: p ? p.tools : [] }); return }
  if (m.t !== 'call') return
  if (!app || app.destroyed) { reply({ id: m.id, content: [{ type: 'text', text: 'OpenAnimator no está conectado: abrí la app y volvé a intentar.' }], isError: true }); return }
  const call = `c${++callSeq}`
  calls.set(call, { proc: procId, reply: (r) => reply({ id: m.id, ...r }) })
  send({ t: 'tool', call, proc: procId, name: String(m.name || ''), input: m.arguments && typeof m.arguments === 'object' ? m.arguments : {} })
}

function sameToken(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''))
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y)
}

function listen(token) {
  const server = net.createServer((sock) => {
    sock.setNoDelay(true)
    sock.setKeepAlive(true, 30000)
    let role = null, procId = null
    const hello = setTimeout(() => { if (!role) sock.destroy() }, 5000)
    readline.createInterface({ input: sock, crlfDelay: Infinity }).on('line', (line) => {
      let m
      try { m = JSON.parse(line) } catch { return }
      if (!role) {
        if (m.t === 'hello' && sameToken(m.token, token)) {
          role = 'app'
          clearTimeout(hello)
          if (app && app !== sock) app.destroy()
          app = sock
          lastApp = Date.now()
          // Una app recién abierta no conoce las conversaciones viejas: se cierran. Una que se reinició
          // (Android cerró la página por falta de memoria) las retoma: recibe su historia y lo que salió
          // mientras tanto ya está en ella, así que lo guardado se descarta y lo nuevo espera su "flush".
          if (m.fresh) { for (const id of [...procs.keys()]) killProc(id); dropJobs(); outbox = []; outboxBytes = 0 }
          const adopt = !m.fresh && !!m.adopt
          if (adopt) { outbox = []; outboxBytes = 0 }
          holding = adopt
          sock.write(JSON.stringify({ t: 'hello', ok: true, version: VERSION, pid: process.pid, ...(adopt ? { procs: procList() } : {}) }) + '\n')
          if (!adopt) flushOutbox()
        } else if (m.t === 'mcp' && procs.get(String(m.proc)) && sameToken(m.key, procs.get(String(m.proc)).key)) {
          role = 'mcp'
          procId = String(m.proc)
          clearTimeout(hello)
        } else {
          log('conexión rechazada', m.t || '?')
          sock.write(JSON.stringify({ t: 'hello', ok: false, error: 'token' }) + '\n')
          sock.end()
        }
        return
      }
      if (role === 'app') {
        // En orden: un "in" no puede adelantarse al "start" de su conversación (que tarda un momento).
        if (m.t === 'req') fromApp(m).catch((e) => log('error', e?.stack || e))
        else appQueue = appQueue.then(() => fromApp(m)).catch((e) => log('error', e?.stack || e))
      } else fromMcp(sock, procId, m)
    })
    sock.on('error', () => {})
    sock.on('close', () => {
      clearTimeout(hello)
      if (role === 'app' && app === sock) {
        app = null
        lastApp = Date.now()
        for (const [cid, c] of calls) { calls.delete(cid); c.reply({ content: [{ type: 'text', text: 'OpenAnimator se desconectó durante la herramienta.' }], isError: true }) }
        dropJobs()
      }
    })
  })
  let tries = 0
  server.on('error', (e) => {
    // El puente anterior todavía está cerrando: se reintenta un momento.
    if (e.code === 'EADDRINUSE' && tries++ < 25) { setTimeout(() => server.listen(PORT, '127.0.0.1'), 200); return }
    log('no se pudo escuchar', e.message)
    console.error(`No se pudo escuchar en 127.0.0.1:${PORT}: ${e.message}`)
    process.exit(2)
  })
  server.listen(PORT, '127.0.0.1', () => log('escuchando', PORT, 'versión', VERSION, 'claude:', claudeBin || '(no encontrado)'))
  return server
}

// ── arranque ────────────────────────────────────────────────────────────────────
const PID = path.join(DIR, 'bridge.pid')
function shutdown(code) {
  for (const id of [...procs.keys()]) killProc(id)
  try { if (+fs.readFileSync(PID, 'utf8') === process.pid) fs.rmSync(PID) } catch { /* ignore */ }
  setTimeout(() => process.exit(code), 200)
}
process.on('SIGTERM', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))

// Un error al arrancar queda en el registro y en stderr (la app lo recibe si el puente se cierra).
process.on('uncaughtException', (e) => { log('fallo', e?.stack || e); console.error(e?.stack || String(e)); process.exit(1) })

function readToken() {
  const file = arg('token-file')
  if (file) { try { return Promise.resolve(fs.readFileSync(file, 'utf8').trim()) } catch (e) { log('sin archivo de token', e.message); return Promise.resolve('') } }
  if (process.env.OA_TOKEN) return Promise.resolve(process.env.OA_TOKEN)
  return new Promise((resolve) => {
    let buf = ''
    const done = () => { clearTimeout(timer); process.stdin.removeAllListeners('data'); process.stdin.pause(); resolve(buf.split('\n')[0].trim()) }
    const timer = setTimeout(done, 5000)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => { buf += d; if (buf.includes('\n')) done() })
    process.stdin.on('end', done)
  })
}

const token = await readToken()
if (!token) { log('sin token: el puente lo arranca la app'); console.error('Sin token: el puente lo arranca OpenAnimator.'); process.exit(1) }
// Un solo puente: el anterior (de otra apertura de la app) se cierra.
try { const old = +fs.readFileSync(PID, 'utf8'); if (old && old !== process.pid) process.kill(old, 'SIGTERM') } catch { /* no había */ }
fs.writeFileSync(PID, String(process.pid))
listen(token)
// Sin la app ni conversaciones durante dos horas, el puente se cierra solo (la app lo vuelve a abrir).
setInterval(() => { if (!app && !procs.size && Date.now() - lastApp > 2 * 3600e3) shutdown(0) }, 60e3).unref()
