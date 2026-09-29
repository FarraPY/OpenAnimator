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
 *   oa-mcp → puente: mcp {proc, key} · tools {id} · call {id, name, arguments}
 */
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import readline from 'node:readline'
import { spawn, execFile } from 'node:child_process'

const VERSION = 2
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
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-prompt-tool', 'stdio', '--permission-mode', MODES.has(o.permissionMode) ? o.permissionMode : 'acceptEdits',
    '--mcp-config', mcpFile, '--strict-mcp-config']
  if (await supportsToolsFlag()) args.push('--tools', '')
  else args.push('--disallowedTools', BUILTIN.join(','))
  if (typeof o.system === 'string' && o.system) args.push('--append-system-prompt', o.system)
  const allowed = (Array.isArray(o.allowedTools) ? o.allowedTools : []).filter((t) => /^[\w-]+$/.test(t))
  if (allowed.length) args.push('--allowedTools', allowed.join(','))
  if (typeof o.model === 'string' && /^[\w.[\]-]+$/.test(o.model)) args.push('--model', o.model)
  if (EFFORTS.has(o.effort)) args.push('--effort', o.effort)
  if (typeof o.resume === 'string' && /^[\w-]+$/.test(o.resume)) args.push('--resume', o.resume)
  const child = spawn(claudeBin, args, { cwd, env: claudeEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
  const p = { child, key, tools: Array.isArray(o.tools) ? o.tools : [], errTail: '', mcpFile }
  procs.set(procId, p)
  log('start', procId, o.project, o.model || '(modelo por defecto)', o.resume ? `resume ${o.resume}` : '')
  child.stderr.on('data', (d) => { p.errTail = (p.errTail + d).slice(-3000) })
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    send({ t: 'out', proc: procId, msg: slim(msg) })
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

// ── la app (una sola conexión a la vez) ─────────────────────────────────────────
let app = null
let appQueue = Promise.resolve()
let outbox = [] // lo que sale mientras la app no está conectada (p. ej. se cerró la pantalla un momento)
let outboxBytes = 0
let lastApp = Date.now()
function send(obj) {
  const line = JSON.stringify(obj) + '\n'
  if (app && !app.destroyed) { app.write(line); return }
  outbox.push(line)
  outboxBytes += line.length
  while (outboxBytes > 8 << 20 && outbox.length) outboxBytes -= outbox.shift().length
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
      if (p && !p.child.stdin.destroyed) p.child.stdin.write(JSON.stringify(m.msg) + '\n')
      return
    }
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
          // Una app recién abierta no conoce las conversaciones viejas: se cierran.
          if (m.fresh) { for (const id of [...procs.keys()]) killProc(id); outbox = []; outboxBytes = 0 }
          sock.write(JSON.stringify({ t: 'hello', ok: true, version: VERSION, pid: process.pid }) + '\n')
          const pending = outbox
          outbox = []; outboxBytes = 0
          for (const l of pending) sock.write(l)
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
