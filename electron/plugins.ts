/**
 * Plugins de IA: otros modelos y servicios que OpenAnimator (y Claude, vía MCP) pueden usar.
 *
 *   ChatGPT (Codex CLI)  cuenta de ChatGPT del usuario: generar imágenes y consultar a GPT, sin clave de API
 *   OpenAI (API)         imágenes (gpt-image), consultas, transcripción con tiempos por palabra
 *   Google Gemini        consultas e imágenes
 *   OpenRouter           consultas a cientos de modelos con una sola clave
 *   ElevenLabs           voz (con tiempos por palabra), efectos de sonido, transcripción
 *   Fish Audio           voz (clonada o de la biblioteca)
 *   Whisper (local)      transcripción con tiempos por palabra en este equipo (GPU), gratis y sin internet
 *   yt-dlp               descargar videos de YouTube para analizarlos
 *
 * Las claves viven cifradas en secrets.ts; acá sólo se usan para llamar a cada API.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { APP_DIR, CACHE_DIR, DATA_DIR, ffmpegPaths, which } from './paths'
import { getSettings } from './settings'
import { getSecret, maskedSecret } from './secrets'
import { projectDir, slugify } from './projects'
import { probeDuration, run } from './ffmpeg'

export type PluginId = 'codex' | 'openai' | 'gemini' | 'openrouter' | 'elevenlabs' | 'fish' | 'whisper' | 'ytdlp'
export type Cap = 'image' | 'voice' | 'sfx' | 'ask' | 'transcribe' | 'download'
export type PluginStatus = { id: PluginId; name: string; ready: boolean; enabled: boolean; detail: string; masked?: string; caps: Cap[]; needsKey: boolean }
export type Voice = { id: string; name: string; desc?: string; preview?: string; lang?: string }
export type Word = { w: string; start: number; end: number }

export const PLUGINS: Array<{ id: PluginId; name: string; caps: Cap[]; needsKey: boolean }> = [
  { id: 'codex', name: 'ChatGPT (cuenta vinculada)', caps: ['image', 'ask'], needsKey: false },
  { id: 'openai', name: 'OpenAI API', caps: ['image', 'ask', 'transcribe'], needsKey: true },
  { id: 'gemini', name: 'Google Gemini', caps: ['image', 'ask'], needsKey: true },
  { id: 'openrouter', name: 'OpenRouter', caps: ['ask'], needsKey: true },
  { id: 'elevenlabs', name: 'ElevenLabs', caps: ['voice', 'sfx', 'transcribe'], needsKey: true },
  { id: 'fish', name: 'Fish Audio', caps: ['voice', 'transcribe'], needsKey: true },
  { id: 'whisper', name: 'Whisper (local)', caps: ['transcribe'], needsKey: false },
  { id: 'ytdlp', name: 'yt-dlp (YouTube)', caps: ['download'], needsKey: false },
]
const ORDER: Record<string, PluginId[]> = {
  image: ['codex', 'openai', 'gemini'], voice: ['elevenlabs', 'fish'], sfx: ['elevenlabs'],
  ask: ['codex', 'openai', 'gemini', 'openrouter'], transcribe: ['whisper', 'elevenlabs', 'openai', 'fish'], download: ['ytdlp'],
}
const pname = (id: string) => PLUGINS.find((p) => p.id === id)?.name || id

// ── utilidades HTTP ─────────────────────────────────────────────────────────
async function http(url: string, init: RequestInit & { timeout?: number } = {}) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), init.timeout || 180000)
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal })
    if (!r.ok) {
      let msg = ''
      try { const t = await r.text(); try { const j = JSON.parse(t); msg = j.error?.message || j.detail?.message || j.detail || j.message || j.error || t } catch { msg = t } } catch { /* ignore */ }
      if (typeof msg !== 'string') msg = JSON.stringify(msg)
      const hint = r.status === 401 || r.status === 403 ? ' (¿la clave es correcta y tiene permisos?)' : r.status === 429 ? ' (límite de uso o créditos agotados)' : r.status === 402 ? ' (sin créditos)' : ''
      throw new Error(`HTTP ${r.status}${hint}: ${String(msg).slice(0, 400)}`)
    }
    return r
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('La solicitud tardó demasiado y se canceló')
    throw e
  } finally { clearTimeout(timer) }
}
const json = async (url: string, init: RequestInit & { timeout?: number } = {}) => (await http(url, init)).json() as Promise<any>

function key(id: PluginId) {
  const k = getSecret(`plugin.${id}`)
  if (!k) throw new Error(`Falta la clave de ${pname(id)}. Cargala en Ajustes → Plugins.`)
  return k
}

/** Carpeta del proyecto + archivo de salida sin pisar nada: assets/<sub>/<nombre>-N.ext */
function outFile(projectId: string, sub: string, name: string, ext: string) {
  const dir = projectDir(projectId)
  if (!dir) throw new Error('Proyecto no encontrado: ' + projectId)
  const d = path.join(dir, 'assets', sub)
  fs.mkdirSync(d, { recursive: true })
  const base = slugify(name || sub).slice(0, 40) || sub
  let f = `${base}${ext}`, n = 2
  while (fs.existsSync(path.join(d, f))) f = `${base}-${n++}${ext}`
  return { abs: path.join(d, f), rel: `assets/${sub}/${f}` }
}

// ── Codex CLI (cuenta de ChatGPT) ───────────────────────────────────────────
export function codexPath(): string | null {
  const s = getSettings().plugins.codex.path
  if (s && fs.existsSync(s)) return s
  const known = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')
  if (fs.existsSync(known)) return known
  return which('codex')
}
let codexLogin: { at: number; text: string; ok: boolean } | null = null
async function codexStatus(force = false) {
  if (!force && codexLogin && Date.now() - codexLogin.at < 120000) return codexLogin
  const bin = codexPath()
  if (!bin) return (codexLogin = { at: Date.now(), ok: false, text: 'Codex CLI no está instalado' })
  const r = await run(bin, ['login', 'status'], { timeout: 20000 })
  const out = (r.stdout + '\n' + r.stderr).trim()
  const ok = r.code === 0 && /logged in/i.test(out)
  const text = ok ? (/chatgpt/i.test(out) ? 'Sesión iniciada con tu cuenta de ChatGPT' : 'Sesión iniciada con clave de API') : 'Sin sesión: ejecutá «codex login» en una terminal'
  return (codexLogin = { at: Date.now(), ok, text })
}

function codexHome() { return process.env.CODEX_HOME || path.join(os.homedir(), '.codex') }

/** Ejecuta `codex exec` sin interacción. Devuelve el último mensaje y el id del hilo. */
function runCodex(prompt: string, o: { images?: string[]; model?: string; timeout?: number; onEvent?: (m: string) => void } = {}): Promise<{ text: string; thread: string }> {
  const bin = codexPath()
  if (!bin) throw new Error('No se encontró Codex CLI (el puente con tu cuenta de ChatGPT).')
  const work = path.join(CACHE_DIR, 'codex')
  fs.mkdirSync(work, { recursive: true })
  const last = path.join(work, `last-${Date.now()}.txt`)
  const args = ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-C', work, '-o', last, '--color', 'never']
  const model = o.model || getSettings().plugins.codex.model
  if (model) args.push('-m', model)
  for (const im of o.images || []) args.push('-i', im)
  args.push('-')
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd: work, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let thread = '', buf = '', err = '', lastMsg = ''
    const timer = setTimeout(() => { try { p.kill() } catch { /* ignore */ } reject(new Error('Codex tardó demasiado y se canceló')) }, o.timeout || 300000)
    p.stdout.on('data', (d) => {
      buf += d
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        try {
          const m = JSON.parse(line)
          if (m.type === 'thread.started') thread = m.thread_id
          else if (m.item?.type === 'agent_message') { lastMsg = m.item.text; o.onEvent?.(m.item.text) }
          else if (m.type === 'turn.failed' || m.type === 'error') err += (m.error?.message || m.message || '') + '\n'
        } catch { /* ignore */ }
      }
    })
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000) })
    p.on('error', (e) => { clearTimeout(timer); reject(e) })
    p.on('close', (code) => {
      clearTimeout(timer)
      let text = lastMsg
      try { text = fs.readFileSync(last, 'utf8').trim() || lastMsg; fs.rmSync(last, { force: true }) } catch { /* ignore */ }
      if (code !== 0 && !text) return reject(new Error(`Codex terminó con error (${code}). ${err.trim().split('\n').slice(-3).join(' ')}`))
      resolve({ text, thread })
    })
    p.stdin.end(prompt)
  })
}

// ── Whisper local (Python + transformers, modelos de la caché de Hugging Face) ──
/** Python del usuario: el de Ajustes, o el primero encontrado que no sea el atajo de la Microsoft Store. */
export function pythonPath(): string | null {
  const s = getSettings().plugins.whisper.python
  if (s && fs.existsSync(s)) return s
  const la = process.env.LOCALAPPDATA || ''
  const cands: string[] = []
  for (const base of [path.join(la, 'Python'), path.join(la, 'Programs', 'Python')]) {
    try { for (const d of fs.readdirSync(base).sort().reverse()) cands.push(path.join(base, d, 'python.exe')) } catch { /* ignore */ }
  }
  const found = cands.find((f) => fs.existsSync(f))
  if (found) return found
  const w = which('python')
  return w && !/WindowsApps/i.test(w) ? w : null
}
function hfHub() {
  if (process.env.HF_HUB_CACHE) return process.env.HF_HUB_CACHE
  return path.join(process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface'), 'hub')
}
/** Modelos Whisper ya descargados (no se descarga nada desde la app). */
export function whisperModels(): Array<{ id: string; size: number }> {
  const out: Array<{ id: string; size: number }> = []
  let dirs: string[] = []
  try { dirs = fs.readdirSync(hfHub()).filter((d) => /^models--.+whisper/i.test(d)) } catch { return out }
  for (const d of dirs) {
    const snaps = path.join(hfHub(), d, 'snapshots')
    let size = 0
    try {
      for (const s of fs.readdirSync(snaps)) for (const f of ['model.safetensors', 'pytorch_model.bin']) {
        const p = path.join(snaps, s, f)
        if (fs.existsSync(p)) size = Math.max(size, fs.statSync(p).size)
      }
    } catch { /* ignore */ }
    if (size) out.push({ id: d.slice(8).replace('--', '/'), size })
  }
  // los más grandes (más precisos) primero
  return out.sort((a, b) => b.size - a.size)
}
let whisperCache: { at: number; ok: boolean; text: string; gpu: boolean } | null = null
async function whisperStatus(force = false) {
  if (!force && whisperCache && Date.now() - whisperCache.at < 300000) return whisperCache
  const done = (ok: boolean, text: string, gpu = false) => (whisperCache = { at: Date.now(), ok, text, gpu })
  const py = pythonPath()
  if (!py) return done(false, 'No se encontró Python')
  const r = await run(py, ['-c', "import importlib.util as u, importlib.metadata as m, json; mods=['torch','transformers','numpy']; miss=[x for x in mods if not u.find_spec(x)]; print(json.dumps({'miss': miss, 'torch': (m.version('torch') if 'torch' not in miss else '')}))"], { timeout: 30000 })
  let info: any = null
  try { info = JSON.parse(r.stdout.trim().split('\n').pop() || '') } catch { /* ignore */ }
  if (!info) return done(false, 'Python no respondió: ' + (r.stderr || '').trim().slice(-200))
  if (info.miss.length) return done(false, `Faltan paquetes de Python: ${info.miss.join(', ')} (pip install torch transformers)`)
  const models = whisperModels()
  if (!models.length) return done(false, 'No hay modelos Whisper descargados en la caché de Hugging Face')
  const want = getSettings().plugins.whisper.model
  const model = models.find((m) => m.id === want) ? want : models[0].id
  const gpu = /\+cu\d/.test(info.torch)
  return done(true, `${model.replace(/^openai\//, '')} · ${gpu ? 'GPU (CUDA)' : 'CPU'} · ${models.length} modelo${models.length > 1 ? 's' : ''} local${models.length > 1 ? 'es' : ''}`, gpu)
}

async function whisperLocal(file: string, o: { maxSec?: number; lang?: string }): Promise<{ text: string; words: Word[]; provider: string; lang?: string }> {
  const py = pythonPath()
  if (!py) throw new Error('No se encontró Python para Whisper (Ajustes → Plugins → Whisper).')
  const models = whisperModels()
  if (!models.length) throw new Error('No hay modelos Whisper descargados en este equipo.')
  const s = getSettings().plugins.whisper
  const model = models.find((m) => m.id === s.model)?.id || models[0].id
  const raw = path.join(CACHE_DIR, `whisper-${Date.now()}.f32`)
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const args = ['-v', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000']
  if (o.maxSec) args.push('-t', String(o.maxSec))
  args.push('-f', 'f32le', raw)
  const fr = await run(ffmpegPaths().ffmpeg, args, { timeout: 600000 })
  if (fr.code !== 0 || !fs.existsSync(raw)) throw new Error('No se pudo extraer el audio: ' + fr.stderr.slice(-300))
  try {
    const script = path.join(APP_DIR, 'whisper', 'transcribe.py')
    const r = await run(py, [script, raw, model, o.lang || 'auto', s.device || 'auto'], { timeout: 3600000, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } })
    let j: any = null
    try { j = JSON.parse(r.stdout.trim().split('\n').pop() || '') } catch { /* ignore */ }
    if (!j) throw new Error(`Whisper falló (${r.code}): ${(r.stderr || '').replace(/Loading weights[^\n]*\n?/g, '').trim().slice(-400)}`)
    if (j.error) throw new Error('Whisper: ' + j.error)
    return { text: j.text || '', words: j.words || [], provider: `Whisper local (${String(j.model).replace(/^openai\//, '')}, ${j.device})`, lang: j.lang || undefined }
  } finally { fs.rmSync(raw, { force: true }) }
}

// ── estado ──────────────────────────────────────────────────────────────────
export function ytdlpPath(): string | null {
  const s = getSettings().plugins.ytdlp.path
  if (s && fs.existsSync(s)) return s
  const local = path.join(DATA_DIR, 'tools', 'yt-dlp.exe')
  if (fs.existsSync(local)) return local
  return which('yt-dlp')
}

export async function pluginStatus(force = false): Promise<PluginStatus[]> {
  const s = getSettings().plugins
  const out: PluginStatus[] = []
  for (const p of PLUGINS) {
    const enabled = p.id === 'ytdlp' ? true : (s as any)[p.id]?.enabled !== false
    if (p.id === 'codex') {
      const st = await codexStatus(force)
      out.push({ ...p, enabled, ready: enabled && st.ok, detail: st.text })
    } else if (p.id === 'whisper') {
      const st = await whisperStatus(force)
      out.push({ ...p, enabled, ready: enabled && st.ok, detail: st.text })
    } else if (p.id === 'ytdlp') {
      const bin = ytdlpPath()
      out.push({ ...p, enabled, ready: !!bin, detail: bin ? bin : 'No instalado' })
    } else {
      const m = maskedSecret(`plugin.${p.id}`)
      out.push({ ...p, enabled, ready: enabled && !!m, masked: m, detail: m ? `Clave cargada (${m})` : 'Sin clave' })
    }
  }
  return out
}

async function pick(cap: Cap, want?: string): Promise<PluginId> {
  const st = await pluginStatus()
  const ready = (id: string) => st.find((x) => x.id === id)?.ready
  const pref = want || ((getSettings().plugins as any)[cap] as string | undefined)
  if (pref && pref !== 'auto') {
    if (!ORDER[cap].includes(pref as PluginId)) throw new Error(`${pname(pref)} no sirve para esto. Opciones: ${ORDER[cap].map(pname).join(', ')}`)
    if (!ready(pref)) throw new Error(`${pname(pref)} no está configurado. Configuralo en Ajustes → Plugins.`)
    return pref as PluginId
  }
  const id = ORDER[cap].find(ready)
  if (!id) throw new Error(`No hay ningún plugin configurado para ${({ image: 'generar imágenes', voice: 'generar voz', sfx: 'efectos de sonido', ask: 'consultar otros modelos', transcribe: 'transcribir', download: 'descargar videos' } as any)[cap]}. Opciones: ${ORDER[cap].map(pname).join(', ')} (Ajustes → Plugins).`)
  return id
}

export async function testPlugin(id: PluginId): Promise<string> {
  switch (id) {
    case 'codex': { const s = await codexStatus(true); if (!s.ok) throw new Error(s.text); return s.text }
    case 'openai': { const j = await json('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key('openai')}` }, timeout: 20000 }); return `Conectado · ${j.data?.length || 0} modelos disponibles` }
    case 'gemini': { const j = await json('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key('gemini') }, timeout: 20000 }); return `Conectado · ${j.models?.length || 0} modelos` }
    case 'openrouter': { const j = await json('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key('openrouter')}` }, timeout: 20000 }); const d = j.data || {}; return `Conectado${d.limit != null ? ` · límite US$ ${d.limit}` : ''}${d.usage != null ? ` · usado US$ ${(+d.usage).toFixed(2)}` : ''}` }
    case 'elevenlabs': {
      const k = key('elevenlabs')
      try { const j = await json('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': k }, timeout: 20000 }); return `Conectado · plan ${j.tier || '?'} · ${j.character_count ?? '?'} / ${j.character_limit ?? '?'} caracteres usados` }
      catch { const v = await listVoices('elevenlabs'); return `Conectado · ${v.length} voces` }
    }
    case 'fish': {
      const k = key('fish')
      try { const j = await json('https://api.fish.audio/wallet/self/api-credit', { headers: { Authorization: `Bearer ${k}` }, timeout: 20000 }); return `Conectado · crédito ${j.credit ?? '?'}` }
      catch { const v = await listVoices('fish'); return `Conectado · ${v.length} voces propias` }
    }
    case 'whisper': { const s = await whisperStatus(true); if (!s.ok) throw new Error(s.text); return s.text }
    case 'ytdlp': { const b = ytdlpPath(); if (!b) throw new Error('yt-dlp no está instalado'); const r = await run(b, ['--version'], { timeout: 20000 }); return `yt-dlp ${r.stdout.trim()}` }
  }
}

// ── voces ───────────────────────────────────────────────────────────────────
export async function listVoices(provider: 'elevenlabs' | 'fish', query = ''): Promise<Voice[]> {
  if (provider === 'elevenlabs') {
    const j = await json('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key('elevenlabs') }, timeout: 30000 })
    return (j.voices || []).map((v: any) => ({ id: v.voice_id, name: v.name, preview: v.preview_url, desc: [v.category, ...Object.values(v.labels || {})].filter(Boolean).join(' · ') }))
  }
  const k = key('fish')
  const mine = await json(`https://api.fish.audio/model?self=true&page_size=50`, { headers: { Authorization: `Bearer ${k}` }, timeout: 30000 }).catch(() => ({ items: [] }))
  // "es: narrador" → idioma es + título "narrador"; un código de 2 letras solo filtra por idioma.
  const m = /^([a-z]{2})(?::\s*(.*))?$/i.exec(query.trim())
  const lang = m ? m[1].toLowerCase() : ''
  const title = m ? (m[2] || '') : query.trim()
  const q = `${title ? `&title=${encodeURIComponent(title)}` : ''}${lang ? `&language=${lang}` : ''}`
  const pub = await json(`https://api.fish.audio/model?page_size=50&sort_by=task_count${q}`, { headers: { Authorization: `Bearer ${k}` }, timeout: 30000 }).catch(() => ({ items: [] }))
  const map = (v: any, own: boolean): Voice => ({ id: v._id, name: v.title, desc: [own ? 'propia' : 'biblioteca', ...(v.languages || []), ...(v.tags || []).slice(0, 3)].join(' · '), lang: (v.languages || [])[0], preview: v.samples?.[0]?.audio })
  return [...(mine.items || []).map((v: any) => map(v, true)), ...(pub.items || []).map((v: any) => map(v, false))]
}

// ── imágenes ────────────────────────────────────────────────────────────────
export type ImageReq = { prompt: string; name?: string; aspect?: 'square' | 'landscape' | 'portrait'; transparent?: boolean; provider?: string; reference?: string }
export async function generateImage(projectId: string, req: ImageReq, onStatus?: (m: string) => void) {
  if (!req.prompt?.trim()) throw new Error('Falta la descripción de la imagen')
  const provider = await pick('image', req.provider)
  const s = getSettings().plugins
  const aspect = req.aspect || 'landscape'
  const out = outFile(projectId, 'ia', req.name || req.prompt.split(/\s+/).slice(0, 6).join(' '), '.png')
  const dir = projectDir(projectId)!
  const ref = req.reference ? (path.isAbsolute(req.reference) ? req.reference : path.join(dir, req.reference)) : ''
  if (ref && !fs.existsSync(ref)) throw new Error('No existe la imagen de referencia: ' + req.reference)
  onStatus?.(`Generando con ${pname(provider)}…`)
  if (provider === 'codex') {
    const shape = aspect === 'square' ? 'square (1:1)' : aspect === 'portrait' ? 'vertical portrait (2:3)' : 'horizontal landscape (3:2 or 16:9)'
    const prompt = [
      'Use your built-in image generation tool to create exactly ONE image. Do not run shell commands and do not write files: just generate the image and reply with one short sentence.',
      `Format: ${shape}.${req.transparent ? ' Transparent background (PNG with alpha), isolated subject, no shadow on the background.' : ''}`,
      ref ? 'Use the attached image as the visual reference (style/subject) for the new image.' : '',
      `Image request: ${req.prompt}`,
    ].filter(Boolean).join('\n')
    const started = Date.now()
    const r = await runCodex(prompt, { images: ref ? [ref] : [], timeout: 420000, onEvent: (m) => onStatus?.(m.slice(0, 160)) })
    const gen = path.join(codexHome(), 'generated_images', r.thread)
    let files: string[] = []
    if (r.thread && fs.existsSync(gen)) files = fs.readdirSync(gen).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).map((f) => path.join(gen, f))
    if (!files.length) {
      // Por si cambia la estructura de carpetas: la imagen más nueva creada durante esta ejecución.
      const root = path.join(codexHome(), 'generated_images')
      const all: string[] = []
      if (fs.existsSync(root)) for (const d of fs.readdirSync(root)) { const dd = path.join(root, d); try { for (const f of fs.readdirSync(dd)) all.push(path.join(dd, f)) } catch { /* archivo suelto */ } }
      files = all.filter((f) => /\.(png|jpe?g|webp)$/i.test(f) && fs.statSync(f).mtimeMs >= started - 2000)
    }
    if (!files.length) throw new Error('ChatGPT no generó ninguna imagen. Respuesta: ' + (r.text || '(vacía)').slice(0, 300))
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    fs.copyFileSync(files[0], out.abs)
  } else if (provider === 'openai') {
    const size = aspect === 'square' ? '1024x1024' : aspect === 'portrait' ? '1024x1536' : '1536x1024'
    const k = key('openai')
    let j: any
    if (ref) {
      const fd = new FormData()
      fd.append('model', s.openai.imageModel || 'gpt-image-1'); fd.append('prompt', req.prompt); fd.append('size', size); fd.append('quality', s.openai.imageQuality || 'high')
      if (req.transparent) fd.append('background', 'transparent')
      fd.append('image', new Blob([fs.readFileSync(ref)], { type: 'image/png' }), path.basename(ref))
      j = await json('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${k}` }, body: fd, timeout: 300000 })
    } else {
      j = await json('https://api.openai.com/v1/images/generations', {
        method: 'POST', headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }, timeout: 300000,
        body: JSON.stringify({ model: s.openai.imageModel || 'gpt-image-1', prompt: req.prompt, size, quality: s.openai.imageQuality || 'high', n: 1, ...(req.transparent ? { background: 'transparent', output_format: 'png' } : {}) }),
      })
    }
    const b64 = j.data?.[0]?.b64_json
    if (!b64) throw new Error('OpenAI no devolvió ninguna imagen')
    fs.writeFileSync(out.abs, Buffer.from(b64, 'base64'))
  } else {
    const ar = aspect === 'square' ? '1:1' : aspect === 'portrait' ? '2:3' : '16:9'
    const parts: any[] = [{ text: `${req.prompt}\n\nAspect ratio ${ar}.${req.transparent ? ' Plain solid white background, isolated subject.' : ''}` }]
    if (ref) parts.push({ inlineData: { mimeType: /\.jpe?g$/i.test(ref) ? 'image/jpeg' : 'image/png', data: fs.readFileSync(ref).toString('base64') } })
    const j = await json(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(s.gemini.imageModel || 'gemini-2.5-flash-image')}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': key('gemini'), 'Content-Type': 'application/json' }, timeout: 300000,
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'] } }),
    })
    const img = (j.candidates?.[0]?.content?.parts || []).find((p: any) => p.inlineData?.data)
    if (!img) throw new Error('Gemini no devolvió ninguna imagen')
    fs.writeFileSync(out.abs, Buffer.from(img.inlineData.data, 'base64'))
  }
  return { path: out.rel, abs: out.abs, provider: pname(provider) }
}

// ── voz ─────────────────────────────────────────────────────────────────────
export type VoiceReq = { text: string; provider?: string; voice?: string | string[]; name?: string; speed?: number; model?: string; temperature?: number; topP?: number }
function wordsFromChars(chars: string[], starts: number[], ends: number[]): Word[] {
  const out: Word[] = []
  let cur: Word | null = null
  chars.forEach((c, i) => {
    if (/\s/.test(c)) { if (cur) { out.push(cur); cur = null } return }
    if (!cur) cur = { w: '', start: starts[i], end: ends[i] }
    cur.w += c; cur.end = ends[i]
  })
  if (cur) out.push(cur)
  return out.map((w) => ({ w: w.w, start: +w.start.toFixed(3), end: +w.end.toFixed(3) }))
}

export async function tts(projectId: string, req: VoiceReq) {
  if (!req.text?.trim()) throw new Error('Falta el texto a narrar')
  const provider = await pick('voice', req.provider)
  const s = getSettings().plugins
  const out = outFile(projectId, 'voz', req.name || req.text.split(/\s+/).slice(0, 5).join(' '), '.mp3')
  let words: Word[] | undefined
  if (provider === 'elevenlabs') {
    let voice = (Array.isArray(req.voice) ? req.voice[0] : req.voice) || s.elevenlabs.voiceId
    if (!voice) voice = (await listVoices('elevenlabs'))[0]?.id
    if (!voice) throw new Error('Elegí una voz de ElevenLabs en Ajustes → Plugins')
    const e = s.elevenlabs
    const j = await json(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=mp3_44100_128`, {
      method: 'POST', headers: { 'xi-api-key': key('elevenlabs'), 'Content-Type': 'application/json' }, timeout: 300000,
      body: JSON.stringify({ text: req.text, model_id: e.modelId || 'eleven_multilingual_v2', voice_settings: { stability: e.stability, similarity_boost: e.similarity, style: e.style, speed: req.speed || e.speed || 1, use_speaker_boost: true } }),
    })
    if (!j.audio_base64) throw new Error('ElevenLabs no devolvió audio')
    fs.writeFileSync(out.abs, Buffer.from(j.audio_base64, 'base64'))
    const a = j.alignment || j.normalized_alignment
    if (a?.characters) words = wordsFromChars(a.characters, a.character_start_times_seconds, a.character_end_times_seconds)
  } else {
    const f = s.fish
    const model = req.model || f.model || 's2.1-pro-free'
    const voices = (Array.isArray(req.voice) ? req.voice : req.voice ? [req.voice] : f.voiceId ? [f.voiceId] : []).filter(Boolean)
    const multi = /<\|speaker:\d+\|>/.test(req.text)
    if (multi && model === 's1') throw new Error('Los diálogos con varias voces (<|speaker:N|>) necesitan un modelo S2/S2.1, no s1.')
    if (multi && voices.length < 2) throw new Error('Para un diálogo pasá una voz por hablante (voces: [id0, id1, …]) en el mismo orden que <|speaker:0|>, <|speaker:1|>…')
    const body: any = {
      text: req.text, format: 'mp3', mp3_bitrate: 192, normalize: true, latency: f.latency || 'normal',
      temperature: req.temperature ?? f.temperature ?? 0.7, top_p: req.topP ?? f.topP ?? 0.7,
      prosody: { speed: req.speed || f.speed || 1, volume: f.volume || 0, normalize_loudness: true },
    }
    if (voices.length) body.reference_id = multi ? voices : voices[0]
    let r: Response
    try { r = await http('https://api.fish.audio/v1/tts', { method: 'POST', headers: { Authorization: `Bearer ${key('fish')}`, 'Content-Type': 'application/json', model }, body: JSON.stringify(body), timeout: 600000 }) }
    catch (e: any) {
      if (/HTTP 402/.test(e.message) && model !== 's2.1-pro-free') throw new Error(`${e.message}. Sin saldo para ${model}: usá el modelo gratuito s2.1-pro-free (Ajustes → Plugins → Fish Audio).`)
      throw e
    }
    fs.writeFileSync(out.abs, Buffer.from(await r.arrayBuffer()))
  }
  const duration = await probeDuration(out.abs)
  if (!duration) throw new Error('El audio generado está vacío o dañado')
  return { path: out.rel, abs: out.abs, duration: +duration.toFixed(3), provider: pname(provider), words }
}

export async function sfx(projectId: string, req: { text: string; seconds?: number; name?: string }) {
  if (!req.text?.trim()) throw new Error('Falta la descripción del sonido')
  await pick('sfx')
  const out = outFile(projectId, 'sfx', req.name || req.text.split(/\s+/).slice(0, 5).join(' '), '.mp3')
  const body: any = { text: req.text }
  if (req.seconds) body.duration_seconds = Math.max(0.5, Math.min(22, req.seconds))
  const r = await http('https://api.elevenlabs.io/v1/sound-generation', { method: 'POST', headers: { 'xi-api-key': key('elevenlabs'), 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeout: 180000 })
  fs.writeFileSync(out.abs, Buffer.from(await r.arrayBuffer()))
  return { path: out.rel, abs: out.abs, duration: +(await probeDuration(out.abs)).toFixed(3), provider: 'ElevenLabs' }
}

// ── transcripción (tiempos por palabra) ─────────────────────────────────────
/** Comprime el audio a MP3 mono liviano (las APIs tienen límite de tamaño). */
async function lightAudio(file: string, maxSec?: number) {
  const out = path.join(CACHE_DIR, `stt-${Date.now()}.mp3`)
  const args = ['-v', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '40k']
  if (maxSec) args.push('-t', String(maxSec))
  args.push(out)
  const r = await run(ffmpegPaths().ffmpeg, args, { timeout: 600000 })
  if (r.code !== 0 || !fs.existsSync(out)) throw new Error('No se pudo extraer el audio: ' + r.stderr.slice(-300))
  return out
}

export async function transcribe(file: string, o: { provider?: string; maxSec?: number; lang?: string } = {}): Promise<{ text: string; words: Word[]; provider: string; lang?: string }> {
  if (!fs.existsSync(file)) throw new Error('No existe el archivo: ' + file)
  const provider = await pick('transcribe', o.provider)
  if (provider === 'whisper') return whisperLocal(file, o)
  const light = await lightAudio(file, o.maxSec)
  try {
    const blob = new Blob([fs.readFileSync(light)], { type: 'audio/mpeg' })
    if (provider === 'elevenlabs') {
      const fd = new FormData()
      fd.append('model_id', 'scribe_v1'); fd.append('file', blob, 'audio.mp3')
      if (o.lang) fd.append('language_code', o.lang)
      const j = await json('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': key('elevenlabs') }, body: fd, timeout: 900000 })
      const words = (j.words || []).filter((w: any) => w.type === 'word').map((w: any) => ({ w: w.text, start: w.start, end: w.end }))
      return { text: j.text || '', words, provider: 'ElevenLabs', lang: j.language_code }
    }
    if (provider === 'fish') {
      const fd = new FormData()
      fd.append('audio', blob, 'audio.mp3'); fd.append('ignore_timestamps', 'false')
      if (o.lang) fd.append('language', o.lang)
      const j = await json('https://api.fish.audio/v1/asr', { method: 'POST', headers: { Authorization: `Bearer ${key('fish')}`, model: 'transcribe-1' }, body: fd, timeout: 900000 })
      // Fish da tiempos por frase: se reparten entre las palabras según su largo (aproximado).
      const words: Word[] = []
      for (const sg of j.segments || []) {
        const ws = String(sg.text || '').trim().split(/\s+/).filter(Boolean)
        const total = ws.reduce((n, w) => n + w.length + 1, 0) || 1
        let t = sg.start
        for (const w of ws) { const d = ((sg.end - sg.start) * (w.length + 1)) / total; words.push({ w, start: +t.toFixed(3), end: +(t + d).toFixed(3) }); t += d }
      }
      return { text: j.text || '', words, provider: 'Fish Audio (tiempos aproximados por frase)', lang: j.language_code || j.language }
    }
    const fd = new FormData()
    fd.append('model', 'whisper-1'); fd.append('response_format', 'verbose_json'); fd.append('timestamp_granularities[]', 'word'); fd.append('file', blob, 'audio.mp3')
    if (o.lang) fd.append('language', o.lang)
    const j = await json('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key('openai')}` }, body: fd, timeout: 900000 })
    return { text: j.text || '', words: (j.words || []).map((w: any) => ({ w: w.word, start: w.start, end: w.end })), provider: 'OpenAI', lang: j.language }
  } finally { fs.rmSync(light, { force: true }) }
}

// ── consultar otros modelos ─────────────────────────────────────────────────
export async function ask(req: { prompt: string; provider?: string; model?: string; images?: string[]; system?: string }) {
  if (!req.prompt?.trim()) throw new Error('Falta la consulta')
  const provider = await pick('ask', req.provider)
  const s = getSettings().plugins
  const imgs = (req.images || []).filter((f) => fs.existsSync(f))
  const mime = (f: string) => (/\.jpe?g$/i.test(f) ? 'image/jpeg' : /\.webp$/i.test(f) ? 'image/webp' : 'image/png')
  if (provider === 'codex') {
    const r = await runCodex(`${req.system ? req.system + '\n\n' : ''}Answer the following request directly in the same language it is written in. Do not run commands, do not read or modify files.\n\n${req.prompt}`, { images: imgs, model: req.model, timeout: 300000 })
    return { provider: pname(provider), model: req.model || s.codex.model || 'predeterminado de ChatGPT', text: r.text }
  }
  if (provider === 'gemini') {
    const model = req.model || s.gemini.chatModel
    const parts: any[] = [{ text: req.prompt }, ...imgs.map((f) => ({ inlineData: { mimeType: mime(f), data: fs.readFileSync(f).toString('base64') } }))]
    const j = await json(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': key('gemini'), 'Content-Type': 'application/json' }, timeout: 300000,
      body: JSON.stringify({ contents: [{ role: 'user', parts }], ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}) }),
    })
    return { provider: pname(provider), model, text: (j.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || '').join('') }
  }
  const model = req.model || (provider === 'openai' ? s.openai.chatModel : s.openrouter.chatModel)
  const url = provider === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions'
  const content: any = imgs.length ? [{ type: 'text', text: req.prompt }, ...imgs.map((f) => ({ type: 'image_url', image_url: { url: `data:${mime(f)};base64,${fs.readFileSync(f).toString('base64')}` } }))] : req.prompt
  const j = await json(url, {
    method: 'POST', timeout: 300000,
    headers: { Authorization: `Bearer ${key(provider)}`, 'Content-Type': 'application/json', ...(provider === 'openrouter' ? { 'X-Title': 'OpenAnimator' } : {}) },
    body: JSON.stringify({ model, messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), { role: 'user', content }] }),
  })
  return { provider: pname(provider), model: j.model || model, text: j.choices?.[0]?.message?.content || '' }
}

// ── yt-dlp ──────────────────────────────────────────────────────────────────
/** Descarga el ejecutable oficial de yt-dlp (GitHub releases) a data/tools. Sólo a pedido del usuario. */
export async function installYtdlp(onProgress?: (p: number) => void) {
  const dir = path.join(DATA_DIR, 'tools')
  fs.mkdirSync(dir, { recursive: true })
  const r = await http('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', { timeout: 600000, redirect: 'follow' })
  const total = +(r.headers.get('content-length') || 0)
  const chunks: Buffer[] = []
  let got = 0
  const reader = r.body!.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(Buffer.from(value)); got += value.length
    if (total) onProgress?.(got / total)
  }
  const tmp = path.join(dir, 'yt-dlp.exe.part')
  fs.writeFileSync(tmp, Buffer.concat(chunks))
  fs.renameSync(tmp, path.join(dir, 'yt-dlp.exe'))
  return path.join(dir, 'yt-dlp.exe')
}
