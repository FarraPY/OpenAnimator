#!/usr/bin/env node
/**
 * Servidor de desarrollo de OpenAnimator para Android: sirve la interfaz compilada
 * (android/build/www) e imita el puente nativo (Bridge.java) por HTTP, así la app completa se
 * puede probar en un navegador de escritorio (y con Playwright) sin la tablet.
 *
 *   http://localhost:PORT      → la interfaz (como https://appassets.androidplatform.net)
 *   http://127.0.0.1:PORT      → los proyectos (como https://oaproject.androidplatform.net)
 *
 *   node android/dev/server.mjs [--port 5190] [--data carpeta] [--mock-claude] [--host 127.0.0.1]
 *                               [--termux-claude fake|real] [--termux-permission]
 *
 * Termux (Claude Code con el plan) también se imita: RUN_COMMAND corre con el bash de la PC y un HOME
 * propio (data/.dev-termux/home), así el puente de verdad (android/termux/bridge.mjs) arranca y lanza
 * fake-claude.mjs (guion fijo, sin gastar) o, con --termux-claude real, el Claude Code instalado.
 * Instalar Whisper deja fake-whisper.mjs en lugar de whisper.cpp (el puente lo usa como el de verdad).
 *
 * El puente no tiene token: por defecto sólo escucha en 127.0.0.1 (con --host 0.0.0.0 cualquiera en
 * la red podría leer y escribir la carpeta de datos).
 *
 * El codificador de video (MediaCodec) se imita con ffmpeg y los selectores de archivos con
 * POST /__dev/pick (la próxima selección devuelve esos archivos). Con --mock-claude, los pedidos a
 * api.anthropic.com los responde un Claude de mentira con un guion fijo (prueba del chat sin costo).
 */
import http from 'node:http'
import net from 'node:net'
import readline from 'node:readline'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def }
const PORT = +arg('port', process.env.PORT || 5190)
const HOST = arg('host', '127.0.0.1')
const DATA = path.resolve(arg('data', path.join(os.tmpdir(), 'oa-android-dev')))
const WWW = path.resolve(arg('www', path.join(ROOT, 'android', 'build', 'www')))
const MOCK = process.argv.includes('--mock-claude') || process.env.OA_MOCK_CLAUDE === '1'
const APP_ORIGIN = `http://localhost:${PORT}`
const PROJECT_ORIGIN = `http://127.0.0.1:${PORT}`
fs.mkdirSync(DATA, { recursive: true })

const MIME = {
  html: 'text/html', htm: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json', md: 'text/markdown', txt: 'text/plain',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4', mkv: 'video/x-matroska', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', glb: 'model/gltf-binary', gltf: 'model/gltf+json', zip: 'application/zip', pdf: 'application/pdf', b64: 'text/plain',
}
const mimeOf = (f) => MIME[path.extname(f).slice(1).toLowerCase()] || 'application/octet-stream'

// ── carpeta de datos (como Fs.java: todo confinado a DATA) ────────────────────
function resolve(rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '')
  const p = path.resolve(DATA, clean)
  if (p !== DATA && !p.startsWith(DATA + path.sep)) throw new Error('Ruta fuera de la carpeta de datos: ' + rel)
  return p
}
const relOf = (abs) => path.relative(DATA, abs).split(path.sep).join('/')
const entry = (name, p, st = fs.statSync(p)) => ({ name, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: Math.round(st.mtimeMs) })
function walk(d, prefix, depth, maxDepth, max, skipHidden, skip, out) {
  if (depth > maxDepth || out.length >= max) return
  let kids
  try { kids = fs.readdirSync(d).sort() } catch { return }
  for (const name of kids) {
    if (out.length >= max) return
    if (skipHidden && name.startsWith('.')) continue
    const p = path.join(d, name)
    const rel = prefix ? `${prefix}/${name}` : name
    const e = { ...entry(name, p), path: rel }
    out.push(e)
    if (e.dir && !skip.has(name)) walk(p, rel, depth + 1, maxDepth, max, skipHidden, skip, out)
  }
}
const writeAtomic = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); const tmp = `${p}.${process.pid}.tmp`; fs.writeFileSync(tmp, data); fs.renameSync(tmp, p) }
const du = (p) => { try { const st = fs.statSync(p); if (!st.isDirectory()) return st.size; return fs.readdirSync(p).reduce((n, k) => n + du(path.join(p, k)), 0) } catch { return 0 } }

// ── claves (en la tablet: Keystore; acá, un JSON en la carpeta de datos) ───────
const SECRET_HOSTS = { claude: ['api.anthropic.com'], 'plugin.openai': ['api.openai.com'], 'plugin.gemini': ['generativelanguage.googleapis.com'], 'plugin.openrouter': ['openrouter.ai'], 'plugin.elevenlabs': ['api.elevenlabs.io'], 'plugin.fish': ['api.fish.audio'] }
const SECRETS_FILE = path.join(DATA, '.dev-secrets.json')
const secrets = () => { try { return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')) } catch { return {} } }
const masked = (name) => { const v = secrets()[name] || ''; return v ? (v.length > 10 ? `${v.slice(0, 3)}…${v.slice(-4)}` : '•••') : '' }
function fillSecrets(s, url) {
  if (!s.includes('{{secret:')) return s
  const u = new URL(url)
  return s.replace(/\{\{secret:([\w.-]+)\}\}/g, (_, name) => {
    const hosts = SECRET_HOSTS[name]
    if (!hosts || u.protocol !== 'https:' || !hosts.includes(u.hostname)) throw new Error(`La clave ${name} no se puede usar con ${u.hostname}`)
    const v = secrets()[name] || (MOCK && name === 'claude' ? 'sk-ant-mock' : '')
    if (!v) throw new Error('Falta la clave ' + name)
    return v
  })
}

// ── codificador (MediaCodec en la tablet; ffmpeg acá) ─────────────────────────
let enc = null
function encStart(a) {
  encCancel()
  const out = resolve(a.out)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-enc-'))
  enc = { a, out, tmp, frames: 0, pcm: a.audio ? path.join(tmp, 'audio.pcm') : null }
  return { codec: `ffmpeg libx264 (${a.codec === 'hevc' ? 'hevc pedido' : 'avc'})`, mime: a.codec === 'hevc' ? 'video/hevc' : 'video/avc', profile: 'high', width: a.width, height: a.height }
}
function encAudio(b64) { if (!enc?.pcm) throw new Error('Esta exportación no tiene audio'); fs.appendFileSync(enc.pcm, Buffer.from(b64, 'base64')) }
function encFrame(b64) {
  if (!enc) throw new Error('No hay una exportación en curso')
  fs.writeFileSync(path.join(enc.tmp, `f${String(enc.frames++).padStart(6, '0')}.jpg`), Buffer.from(b64, 'base64'))
  return true
}
function encFinish() {
  const e = enc
  if (!e) throw new Error('No hay una exportación en curso')
  enc = null
  return new Promise((res, rej) => {
    const args = ['-y', '-v', 'error', '-framerate', String(e.a.fps || 30), '-i', path.join(e.tmp, 'f%06d.jpg')]
    if (e.pcm && fs.existsSync(e.pcm)) args.push('-f', 's16le', '-ar', String(e.a.audio.sampleRate || 48000), '-ac', String(e.a.audio.channels || 2), '-i', e.pcm)
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-b:v', String(e.a.bitrate || 8000000), '-movflags', '+faststart')
    if (e.pcm) args.push('-c:a', 'aac', '-b:a', String(e.a.audio.bitrate || 192000), '-shortest')
    fs.mkdirSync(path.dirname(e.out), { recursive: true })
    args.push(e.out)
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code) => {
      fs.rmSync(e.tmp, { recursive: true, force: true })
      if (code !== 0) return rej(new Error('ffmpeg: ' + err.trim().split('\n').slice(-2).join(' ')))
      res({ path: relOf(e.out), size: fs.statSync(e.out).size, frames: e.frames, duration: e.frames / (e.a.fps || 30) })
    })
  })
}
function encCancel() { if (enc) { fs.rmSync(enc.tmp, { recursive: true, force: true }); enc = null } }

// ── Termux (RUN_COMMAND y la conexión con el puente) ─────────────────────────────
const TERMUX_CLAUDE = arg('termux-claude', 'fake')
const TERMUX_HOME = path.join(DATA, '.dev-termux', 'home')
let termuxPerm = process.argv.includes('--termux-permission')
const termuxLinks = new Map()
function termuxEnv() {
  const env = { ...process.env, HOME: TERMUX_HOME, PREFIX: path.join(DATA, '.dev-termux', 'usr') }
  if (TERMUX_CLAUDE === 'fake') env.OA_CLAUDE_BIN = path.join(ROOT, 'android', 'dev', 'fake-claude.mjs')
  return env
}
// Las rutas de Termux se traducen a la carpeta de prueba (y su bash/node a los de la PC).
const inTermux = (p) => String(p).replace('/data/data/com.termux/files/home', TERMUX_HOME).replace('/data/data/com.termux/files/usr', path.join(DATA, '.dev-termux', 'usr'))
/**
 * La instalación de Whisper (compilar whisper.cpp y bajar el modelo) no se hace en la PC: se deja
 * fake-whisper.mjs como whisper-cli, un modelo de mentira y una muestra de voz sintética (22 tonos).
 */
function fakeWhisperInstall(model) {
  const W = path.join(TERMUX_HOME, '.openanimator', 'whisper')
  fs.mkdirSync(path.join(W, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(W, 'models'), { recursive: true })
  fs.writeFileSync(path.join(W, 'bin', 'whisper-cli'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, 'android', 'dev', 'fake-whisper.mjs')}" "$@"\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(W, 'VERSION'), 'v1.9.4\n')
  fs.writeFileSync(path.join(W, 'models', `ggml-${model}.bin`), 'modelo de prueba')
  const jfk = path.join(W, 'jfk.wav')
  if (!fs.existsSync(jfk)) {
    const n = 16000 * 11, pcm = Buffer.alloc(n * 2)
    for (let i = 0; i < n; i++) { const t = i / 16000; if (t % 0.5 < 0.3) pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * t) * 12000), i * 2) }
    const h = Buffer.alloc(44)
    h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
    h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
    fs.writeFileSync(jfk, Buffer.concat([h, pcm]))
  }
}
function termuxRun(a) {
  if (!termuxPerm) throw new Error('OpenAnimator todavía no tiene permiso para usar Termux')
  fs.mkdirSync(TERMUX_HOME, { recursive: true })
  const args = (a.args || []).map(inTermux)
  if (a.background === false) {
    const w = /whisper-install\.sh"? ([\w.-]+)/.exec(args.join(' '))
    if (w) { fakeWhisperInstall(w[1]); console.log('[termux] Whisper instalado (simulado):', w[1]); return true }
    console.log('[termux] sesión visible:', args.join(' '))
    return true
  }
  const exe = /\/bin\/node$/.test(a.path) ? process.execPath : /\/bin\/bash$/.test(a.path) ? 'bash' : inTermux(a.path)
  const p = spawn(exe, args, { env: termuxEnv(), cwd: TERMUX_HOME, stdio: ['pipe', a.result ? 'pipe' : 'ignore', a.result ? 'pipe' : 'inherit'] })
  p.stdin.end(a.stdin || '')
  if (!a.result) return true
  return new Promise((resolve) => {
    let stdout = '', stderr = ''
    p.stdout.on('data', (d) => { stdout += d })
    p.stderr.on('data', (d) => { stderr += d })
    p.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1, err: -1, errmsg: '' }))
  })
}
function termuxLink(a, id, emit) {
  return new Promise((resolve, reject) => {
    const s = net.connect(+a.port, '127.0.0.1')
    s.on('connect', () => {
      termuxLinks.set(id, s)
      s.write(a.hello + '\n')
      readline.createInterface({ input: s, crlfDelay: Infinity }).on('line', (line) => emit({ event: 'line', line }))
    })
    s.on('error', () => { if (!termuxLinks.has(id)) reject(new Error('sin puente')) })
    s.on('close', () => { termuxLinks.delete(id); resolve(true) })
  })
}

// ── audio (MediaExtractor + MediaCodec en la tablet; ffprobe/ffmpeg acá) ──────
const run = (cmd, args, opts = {}) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 1 << 30, encoding: 'buffer', ...opts }, (e, out, err) => (e ? rej(new Error(`${cmd}: ${String(err || e.message).trim().split('\n').pop()}`)) : res(out))))
async function audioFormat(file) {
  const j = JSON.parse((await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,channels', '-of', 'json', file])).toString())
  const st = j.streams?.[0]
  if (!st) throw new Error('El archivo no tiene audio')
  return { sampleRate: +st.sample_rate, channels: +st.channels }
}
async function audioDecode(a) {
  const file = resolve(a.path), out = resolve(a.out)
  if (!fs.statSync(file).isFile()) throw new Error('No existe el archivo: ' + a.path)
  if (!(a.duration > 0 && a.duration <= 600)) throw new Error('Duración inválida')
  const f = await audioFormat(file)
  const pcm = await run('ffmpeg', ['-v', 'error', '-ss', String(Math.max(0, a.start || 0)), '-t', String(a.duration), '-i', file, '-vn', '-f', 's16le', '-acodec', 'pcm_s16le', '-'])
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, pcm)
  return { ...f, frames: Math.floor(pcm.length / (2 * f.channels)) }
}
async function audioPeaks(a) {
  const file = resolve(a.path), perSec = a.perSec || 100
  const f = await audioFormat(file)
  const pcm = await run('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-f', 's16le', '-acodec', 'pcm_s16le', '-'])
  const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1), ch = f.channels, win = Math.max(1, Math.floor(f.sampleRate / perSec))
  const frames = Math.floor(s.length / ch), out = []
  for (let i = 0; i + win <= frames; i += win) {
    let max = 0
    for (let j = i * ch; j < (i + win) * ch; j++) { const v = Math.abs(s[j]) / 32768; if (v > max) max = v }
    out.push(Math.min(255, Math.round(Math.sqrt(Math.min(1, max)) * 255)))
  }
  return { rate: perSec, data: Buffer.from(out).toString('base64') }
}

// ── selector de archivos de prueba ────────────────────────────────────────────
let nextPick = []
function pickFiles() {
  const files = nextPick
  nextPick = []
  const id = crypto.randomUUID().slice(0, 8)
  return files.map((src) => {
    const name = path.basename(src)
    const dest = resolve(`.incoming/${id}/${name}`)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
    return { path: relOf(dest), name, size: fs.statSync(dest).size, mime: mimeOf(name) }
  })
}

// ── zip (Python: el mismo formato que Zip.java) ───────────────────────────────
function py(code, ...args) { return execFileSync('python3', ['-c', code, ...args], { encoding: 'utf8' }) }
const ZIP_EXPORT = `
import os, re, sys, zipfile
src, out, prefix, skip = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
rx = re.compile(skip) if skip else None
os.makedirs(os.path.dirname(out), exist_ok=True)
with zipfile.ZipFile(out + '.part', 'w') as z:
    for d, dirs, files in os.walk(src):
        for f in sorted(files):
            p = os.path.join(d, f); rel = os.path.relpath(p, src).replace(os.sep, '/')
            if rx and rx.search(rel): continue
            comp = zipfile.ZIP_STORED if re.search(r'\\.(mp4|mp3|jpg|jpeg|png|webp|gif|zip|m4a|webm|mov|woff2?)$', f, re.I) else zipfile.ZIP_DEFLATED
            z.write(p, prefix + '/' + rel if prefix else rel, compress_type=comp)
os.replace(out + '.part', out)
`
const ZIP_IMPORT = `
import os, sys, zipfile
src, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(src) as z:
    names = [n for n in z.namelist() if not n.endswith('/')]
    tops = set(n.split('/')[0] for n in names)
    strip = len(tops) == 1 and all('/' in n for n in names) and not any(n.split('/')[-1] == 'project.json' and n.count('/') == 0 for n in names)
    for n in names:
        rel = n.split('/', 1)[1] if strip else n
        p = os.path.realpath(os.path.join(dest, rel))
        if not p.startswith(os.path.realpath(dest) + os.sep): raise SystemExit('Ruta inválida en el zip: ' + n)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with z.open(n) as a, open(p, 'wb') as b: b.write(a.read())
print(len(names))
`

// ── Claude de mentira (--mock-claude) ─────────────────────────────────────────
const SCENE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;background:#101426;overflow:hidden;font-family:system-ui,sans-serif}
#t{position:absolute;left:0;right:0;top:40%;text-align:center;color:#fff;font-size:120px;font-weight:800;letter-spacing:-2px}
#b{position:absolute;left:10%;bottom:20%;height:18px;background:linear-gradient(90deg,#7c5cff,#22d3ee);border-radius:9px}
</style></head><body><div id="t">Hola tablet</div><div id="b"></div>
<script>
window.__oa = { duration: 4, render(t) {
  const k = Math.min(1, t / 1.2), e = 1 - Math.pow(1 - k, 3)
  document.getElementById('t').style.transform = 'translateY(' + (60 * (1 - e)) + 'px)'
  document.getElementById('t').style.opacity = e
  document.getElementById('b').style.width = (80 * Math.min(1, t / 4)) + '%'
} }
</script></body></html>`

/** Guion del Claude simulado según la última herramienta usada en la conversación. */
function mockScript(body) {
  const msgs = body.messages || []
  const last = msgs[msgs.length - 1]
  const texts = Array.isArray(last?.content) ? last.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : String(last?.content || '')
  if (/Escribí un resumen completo/.test(texts)) return [{ type: 'text', text: 'Resumen: el usuario pidió una escena de saludo; creé scenes/hola.html, la puse en el timeline y la verifiqué.' }]
  // Para probar cómo se recupera el chat: "[rechazo]" → Claude declina; "[error400]" → la API rechaza el pedido.
  if (/\[rechazo\]/.test(texts)) return 'refusal'
  if (/\[error400\]/.test(texts)) return 'error400'
  const endsWithResults = Array.isArray(last?.content) && last.content.some((b) => b.type === 'tool_result')
  let lastUse = null
  if (endsWithResults) for (let i = msgs.length - 1; i >= 0 && !lastUse; i--) if (msgs[i].role === 'assistant') lastUse = msgs[i].content.filter((b) => b.type === 'tool_use').pop() || null
  const tl = { format: 'oa-timeline/1', duration: 4, tracks: [{ id: 'escenas', name: 'Escenas', type: 'scene', clips: [{ id: 'c-hola', src: 'scenes/hola.html', start: 0, duration: 4, in: 0 }] }, { id: 'voz', name: 'Voz', type: 'audio', clips: [] }], notes: [] }
  switch (lastUse ? `${lastUse.name}:${lastUse.input?.file_path || ''}` : '') {
    case '': return [
      { type: 'thinking', thinking: 'El usuario quiere una escena nueva. Primero miro el proyecto para ver las pistas y la duración.' },
      { type: 'text', text: 'Miro primero cómo está armado el proyecto.' },
      { type: 'tool_use', name: 'oa_proyecto', input: {} },
    ]
    case 'oa_proyecto:': return [
      { type: 'thinking', thinking: 'Hay una pista de escenas. Escribo una escena simple y determinista, y después la agrego al timeline.' },
      { type: 'tool_use', name: 'Write', input: { file_path: 'scenes/hola.html', content: SCENE } },
    ]
    case 'Write:scenes/hola.html': return [{ type: 'tool_use', name: 'Read', input: { file_path: 'timelines/main.json' } }]
    case 'Read:timelines/main.json': return [{ type: 'tool_use', name: 'Write', input: { file_path: 'timelines/main.json', content: JSON.stringify(tl, null, 2) } }]
    case 'Write:timelines/main.json': return [{ type: 'tool_use', name: 'oa_ver_fotogramas', input: { times: [0.4, 2], width: 640 } }]
    default: return [{ type: 'text', text: 'Listo: creé **scenes/hola.html** (un título que entra desde abajo y una barra de progreso) y la puse en el timeline de 0 a 4 s. Revisé los fotogramas en 0,4 s y 2 s: se ve bien.' }]
  }
}
function mockClaude(req, res, body) {
  const url = new URL(req.url, 'https://api.anthropic.com')
  if (req.method === 'GET' && url.pathname.startsWith('/v1/models/')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'model', id: url.pathname.split('/').pop(), display_name: 'Claude Opus 5.5 (simulado)', created_at: '2026-01-01T00:00:00Z' }))
    return
  }
  const blocks = mockScript(body)
  if (blocks === 'error400') {
    res.writeHead(400, { 'content-type': 'application/json', 'request-id': 'req_mock' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Pedido inválido (simulado)' } }))
    return
  }
  const id = 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20)
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': 'req_mock' })
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  const inTok = JSON.stringify(body).length >> 2
  ev('message_start', { message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, cache_read_input_tokens: Math.max(0, inTok - 2000), cache_creation_input_tokens: Math.min(2000, inTok), output_tokens: 1 } } })
  const chunks = (s, n) => { const out = []; for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n)); return out }
  let i = 0
  const steps = []
  const refusal = blocks === 'refusal'
  for (const b of refusal ? [] : blocks) {
    const index = i++
    if (b.type === 'thinking') {
      steps.push(() => ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } }))
      for (const c of chunks(b.thinking, 24)) steps.push(() => ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: c } }))
      steps.push(() => ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: 'mock-' + crypto.randomUUID() } }))
    } else if (b.type === 'text') {
      steps.push(() => ev('content_block_start', { index, content_block: { type: 'text', text: '' } }))
      for (const c of chunks(b.text, 12)) steps.push(() => ev('content_block_delta', { index, delta: { type: 'text_delta', text: c } }))
    } else if (b.type === 'tool_use') {
      steps.push(() => ev('content_block_start', { index, content_block: { type: 'tool_use', id: 'toolu_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20), name: b.name, input: {} } }))
      for (const c of chunks(JSON.stringify(b.input), 200)) steps.push(() => ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: c } }))
    }
    steps.push(() => ev('content_block_stop', { index }))
  }
  const stop = refusal ? 'refusal' : blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  steps.push(() => ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null, ...(refusal ? { stop_details: { type: 'refusal', category: 'simulado', explanation: null } } : {}) }, usage: { output_tokens: refusal ? 2 : 180 } }))
  steps.push(() => { ev('message_stop', {}); res.end() })
  const tick = () => { const s = steps.shift(); if (!s) return; s(); if (steps.length) setTimeout(tick, 15) }
  setTimeout(tick, 120)
}

// ── http.request (Http.java) ──────────────────────────────────────────────────
const requests = new Map()
async function httpRequest(a, id, emit) {
  const url = String(a.url)
  if (!/^https?:\/\//.test(url)) throw new Error('URL inválida')
  const headers = {}
  for (const [k, v] of Object.entries(a.headers || {})) headers[k] = fillSecrets(String(v), url)
  let body
  if (a.body) body = a.body.type === 'base64' ? Buffer.from(a.body.data, 'base64') : a.body.type === 'file' ? fs.readFileSync(resolve(a.body.path)) : Buffer.from(String(a.body.data), 'utf8')
  const u = new URL(url)
  if (MOCK && u.hostname === 'api.anthropic.com') {
    // Se responde en proceso con el mismo formato que la API real.
    let parsed = {}
    try { parsed = body ? JSON.parse(body.toString('utf8')) : {} } catch { /* ignore */ }
    return await new Promise((resolveP) => {
      const chunks = []
      let status = 200, hs = {}
      const fake = {
        writeHead(s, h) { status = s; hs = h; if (a.stream) emit({ event: 'head', status, headers: hs }) },
        write(s) { if (a.stream) emit({ event: 'chunk', text: s }); else chunks.push(s) },
        end(s) { if (s) fake.write(s); resolveP({ status, headers: hs, ...(a.stream ? {} : { text: chunks.join('') }) }) },
      }
      mockClaude({ method: a.method || 'GET', url: u.pathname + u.search }, fake, parsed)
    })
  }
  const ac = new AbortController()
  requests.set(id, ac)
  try {
    const r = await fetch(url, { method: a.method || 'GET', headers, body, signal: ac.signal })
    const hs = {}
    r.headers.forEach((v, k) => { hs[k] = v })
    if (a.saveTo && r.ok) {
      const dest = resolve(a.saveTo)
      writeAtomic(dest, Buffer.from(await r.arrayBuffer()))
      return { status: r.status, headers: hs, size: fs.statSync(dest).size }
    }
    if (a.stream) {
      emit({ event: 'head', status: r.status, headers: hs })
      const dec = new TextDecoder()
      for await (const c of r.body) emit({ event: 'chunk', text: dec.decode(c, { stream: true }) })
      return { status: r.status, headers: hs }
    }
    const text = await r.text()
    return { status: r.status, headers: hs, text, size: text.length }
  } finally { requests.delete(id) }
}

// ── puente ────────────────────────────────────────────────────────────────────
const info = () => ({
  platform: 'android', sdk: 34, release: '14', manufacturer: 'samsung', brand: 'samsung', model: 'SM-X806B (dev)', device: 'gts8p', soc: 'Qualcomm SM8450',
  versionName: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version + '-dev', versionCode: 1, abi: 'arm64-v8a', webview: 'Navegador de escritorio (dev)',
  density: 2.125, screenWidth: 2800, screenHeight: 1752, memory: 8e9, dataDir: DATA,
})
function sync(method, a) {
  switch (method) {
    case 'fs.stat': { const p = resolve(a.path); return fs.existsSync(p) ? entry(path.basename(p), p) : null }
    case 'fs.list': { const p = resolve(a.path); return fs.existsSync(p) ? fs.readdirSync(p).map((n) => entry(n, path.join(p, n))) : [] }
    case 'fs.walk': { const out = []; walk(resolve(a.path), '', 0, a.depth ?? 8, a.max ?? 10000, a.skipHidden ?? true, new Set(a.skipDirs || []), out); return out }
    case 'fs.exists': return fs.existsSync(resolve(a.path))
    case 'fs.readText': return fs.readFileSync(resolve(a.path), 'utf8')
    case 'fs.readTextLimited': {
      const p = resolve(a.path), size = fs.statSync(p).size, max = a.max ?? 200000
      const fd = fs.openSync(p, 'r'); const b = Buffer.alloc(Math.min(size, max)); fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd)
      return { text: b.toString('utf8'), size, truncated: size > max }
    }
    case 'fs.writeText': writeAtomic(resolve(a.path), String(a.text)); return true
    case 'fs.writeBase64': { const p = resolve(a.path); fs.mkdirSync(path.dirname(p), { recursive: true }); (a.append ? fs.appendFileSync : fs.writeFileSync)(p, Buffer.from(a.data || '', 'base64')); return true }
    case 'fs.mkdir': fs.mkdirSync(resolve(a.path), { recursive: true }); return true
    case 'fs.delete': { const p = resolve(a.path); if (p === DATA) throw new Error('No se puede borrar la raíz'); const ex = fs.existsSync(p); fs.rmSync(p, { recursive: true, force: true }); return ex }
    case 'fs.rename': { const to = resolve(a.to); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(resolve(a.from), to); return true }
    case 'fs.copy': { const to = resolve(a.to); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(resolve(a.from), to, { recursive: true }); return true }
    case 'fs.du': return du(resolve(a.path))
    case 'secrets.set': {
      if (!SECRET_HOSTS[a.name]) throw new Error('Clave desconocida')
      const s = secrets(); if (a.value) s[a.name] = String(a.value).trim(); else delete s[a.name]
      writeAtomic(SECRETS_FILE, JSON.stringify(s)); return masked(a.name)
    }
    case 'secrets.masked': return masked(a.name) || (MOCK && a.name === 'claude' ? 'sk-…mock' : '')
    case 'secrets.list': return Object.fromEntries((a.names || []).map((n) => [n, masked(n)]))
    case 'http.cancel': requests.get(a.id)?.abort(); return true
    case 'app.info': return info()
    case 'app.takePendingOpen': return null
    case 'app.toast': console.log('[toast]', a.text); return true
    case 'app.keepScreenOn': case 'app.immersive': case 'app.debug': return true
    case 'app.openUrl': console.log('[abrir]', a.url); return true
    case 'app.exit': return true
    case 'app.openSettings': console.log('[ajustes de la app]'); return true
    case 'termux.status': return { installed: true, version: '0.118.3 (dev)', store: '', permission: termuxPerm }
    case 'termux.send': { const s = termuxLinks.get(a.link); if (!s) throw new Error('El puente con Termux no está conectado'); s.write(String(a.line) + '\n'); return true }
    case 'termux.close': termuxLinks.get(a.link)?.destroy(); return true
    case 'termux.open': console.log('[abrir Termux]'); return true
    case 'clipboard.text': console.log('[copiado]', String(a.text).slice(0, 80)); return true
    case 'codec.caps': return { avc: true, hevc: true, aac: true, encoders: [{ name: 'c2.qti.avc.encoder (dev)', type: 'video/avc', hardware: true }, { name: 'c2.qti.hevc.encoder (dev)', type: 'video/hevc', hardware: true }] }
    case 'enc.start': return encStart(a)
    case 'enc.audio': encAudio(a.data); return true
    case 'enc.cancel': encCancel(); return true
  }
  throw new Error('Método desconocido: ' + method)
}
async function async(method, a, id, emit) {
  switch (method) {
    case 'http.request': return await httpRequest(a, id, emit)
    case 'fs.copy': return sync('fs.copy', a)
    case 'fs.delete': return sync('fs.delete', a)
    case 'zip.export': { py(ZIP_EXPORT, resolve(a.dir), resolve(a.out), a.prefix || '', a.skip || ''); emit({ event: 'progress', done: 1, total: 1 }); return { path: a.out, size: fs.statSync(resolve(a.out)).size } }
    case 'zip.import': { const n = +py(ZIP_IMPORT, resolve(a.zip), resolve(a.dest)); emit({ event: 'progress', done: n, total: n }); return { files: n } }
    case 'pick.files': return pickFiles()
    case 'file.save': console.log('[guardar como]', a.path); return { saved: true, uri: 'content://dev/' + path.basename(a.path) }
    case 'file.share': console.log('[compartir]', a.path); return true
    case 'file.open': console.log('[abrir archivo]', a.path); return true
    case 'gallery.save': { const src = resolve(a.path); const dir = path.join(DATA, '.dev-gallery'); fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(src, path.join(dir, a.name || path.basename(src))); return { uri: 'content://dev/gallery/' + (a.name || path.basename(src)), folder: 'Movies/OpenAnimator' } }
    case 'clipboard.image': return true
    case 'termux.permission': termuxPerm = true; return true
    case 'termux.run': return await termuxRun(a)
    case 'termux.link': return await termuxLink(a, id, emit)
    case 'audio.decode': return await audioDecode(a)
    case 'audio.peaks': return await audioPeaks(a)
    case 'enc.frame': return encFrame(a.data)
    case 'enc.finish': return await encFinish()
  }
  throw new Error('Método desconocido: ' + method)
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
const readBody = (req) => new Promise((res, rej) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => res(Buffer.concat(c))); req.on('error', rej) })
function injectRuntime(html, id) {
  if (html.includes('oa-runtime.js')) return html
  const tag = `<script src="/p/${id}/__oa/oa-runtime.js"></script>`
  const m = /<head[^>]*>/i.exec(html) || /<!doctype[^>]*>/i.exec(html)
  return m ? html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length) : tag + html
}
function sendFile(req, res, file, extra = {}, inject = null) {
  let st
  try { st = fs.statSync(file) } catch { res.writeHead(404, extra); res.end(); return }
  if (!st.isFile()) { res.writeHead(404, extra); res.end(); return }
  const type = mimeOf(file)
  const h = { 'Content-Type': type + (/^text\/|json|javascript|svg/.test(type) ? '; charset=utf-8' : ''), 'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes', ...extra }
  if (inject && type === 'text/html') { const b = Buffer.from(injectRuntime(fs.readFileSync(file, 'utf8'), inject)); res.writeHead(200, { ...h, 'Content-Length': b.length }); res.end(req.method === 'HEAD' ? undefined : b); return }
  if (file === path.join(WWW, 'index.html')) {
    const b = Buffer.from(fs.readFileSync(file, 'utf8').replaceAll('https://oaproject.androidplatform.net', PROJECT_ORIGIN))
    res.writeHead(200, { ...h, 'Content-Length': b.length }); res.end(b); return
  }
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '')
  if (m) {
    let start = m[1] ? +m[1] : Math.max(0, st.size - +m[2]), end = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1
    if (!m[1] && m[2]) end = st.size - 1
    if (start > end || start >= st.size) { res.writeHead(416, { ...h, 'Content-Range': `bytes */${st.size}` }); res.end(); return }
    res.writeHead(206, { ...h, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 })
    if (req.method === 'HEAD') { res.end(); return }
    fs.createReadStream(file, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, { ...h, 'Content-Length': st.size })
  if (req.method === 'HEAD') { res.end(); return }
  fs.createReadStream(file).pipe(res)
}
const inside = (base, rel) => { const p = path.resolve(base, rel); return p === base || p.startsWith(base + path.sep) ? p : null }

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`)
    const p = decodeURIComponent(u.pathname)
    const isProject = u.hostname === '127.0.0.1'
    if (!isProject) {
      // Una escena (otro origen) no puede usar el puente con un POST "simple".
      if (p.startsWith('/__') && req.headers.origin && req.headers.origin !== APP_ORIGIN) { res.writeHead(403); res.end(); return }
      if (req.method === 'POST' && p === '/__bridge') {
        const { method, args } = JSON.parse((await readBody(req)).toString('utf8'))
        let out
        try { out = { ok: true, value: sync(method, args || {}) ?? null } } catch (e) { out = { ok: false, error: String(e?.message || e) } }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out)); return
      }
      if (req.method === 'POST' && p === '/__bridge/async') {
        const { method, args, id: askedId } = JSON.parse((await readBody(req)).toString('utf8'))
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' })
        const id = typeof askedId === 'string' && askedId ? askedId : crypto.randomUUID()
        req.on('close', () => { if (!res.writableEnded) { requests.get(id)?.abort(); termuxLinks.get(id)?.destroy() } })
        const emit = (e) => { if (!res.writableEnded) res.write(JSON.stringify(e) + '\n') }
        try { emit({ ok: true, value: (await async(method, args || {}, id, emit)) ?? null }) } catch (e) { emit({ ok: false, error: String(e?.message || e) }) }
        res.end(); return
      }
      if (req.method === 'POST' && p === '/__dev/pick') { nextPick = JSON.parse((await readBody(req)).toString('utf8')).files || []; res.writeHead(200); res.end('ok'); return }
      if (p.startsWith('/fs/')) { const f = resolve(p.slice(4)); sendFile(req, res, f); return }
      const f = inside(WWW, '.' + (p === '/' ? '/index.html' : p))
      if (f) { sendFile(req, res, f); return }
      res.writeHead(404); res.end(); return
    }
    // origen de los proyectos
    const cors = { 'Access-Control-Allow-Origin': APP_ORIGIN }
    if (p.startsWith('/app/')) { const f = inside(WWW, '.' + p); if (f) return sendFile(req, res, f, cors) }
    // Como AppServer.safeRel: una escena no puede leer fuera de su proyecto.
    if (p.split('/').includes('..') || p.includes('\\')) { res.writeHead(400, cors); res.end(); return }
    if (p.startsWith('/ut/')) { const f = resolve('templates/' + p.slice(4)); return sendFile(req, res, f, cors) }
    const m = /^\/p\/([^/]+)\/(.*)$/.exec(p)
    if (m) {
      const [, id, rel] = m
      if (rel.startsWith('__oa/')) { const f = inside(path.join(WWW, 'app', 'runtime'), rel.slice(5)); if (f) return sendFile(req, res, f, cors) }
      const f = resolve(`projects/${id}/${rel}`)
      return sendFile(req, res, f, cors, id)
    }
    res.writeHead(404, cors); res.end()
  } catch (e) {
    console.error(e)
    if (!res.headersSent) res.writeHead(500)
    res.end(String(e?.message || e))
  }
})
server.listen(PORT, HOST, () => {
  console.log(`OpenAnimator (Android, dev) en ${APP_ORIGIN}  ·  proyectos: ${PROJECT_ORIGIN}`)
  console.log(`datos: ${DATA}${MOCK ? '  ·  Claude simulado' : ''}`)
})
