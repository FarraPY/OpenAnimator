/**
 * Plugins de IA en Android: los mismos servicios que en la PC (electron/plugins.ts) salvo los que
 * necesitan programas de escritorio (Codex CLI, yt-dlp). Whisper corre en Termux (whisper.cpp).
 *
 * Las peticiones salen por Java (sin límites de CORS) y las claves nunca pasan por JavaScript:
 * se escribe {{secret:plugin.<id>}} y Java pone la clave guardada en el Keystore.
 */
import type { PluginId, PluginStatus, Voice } from '../../api'
import { host } from '../host'
import { blobToBase64, fs, join, slugify } from './fsx'
import { decodeRange, probeDuration } from './media'
import { projectDir } from './projects'
import { getSettings } from './settings'
import type { WhisperBridgeStatus, WhisperModel } from './termux'
import { holdAwake } from './wake'

export type Cap = 'image' | 'voice' | 'sfx' | 'ask' | 'transcribe' | 'download'
export type Word = { w: string; start: number; end: number }

/** En Android: los que funcionan por internet con una clave, y Whisper en Termux. */
export const PLUGINS: Array<{ id: PluginId; name: string; caps: Cap[]; needsKey: boolean }> = [
  { id: 'openai', name: 'OpenAI API', caps: ['image', 'ask', 'transcribe'], needsKey: true },
  { id: 'gemini', name: 'Google Gemini', caps: ['image', 'ask'], needsKey: true },
  { id: 'openrouter', name: 'OpenRouter', caps: ['ask'], needsKey: true },
  { id: 'elevenlabs', name: 'ElevenLabs', caps: ['voice', 'sfx', 'transcribe'], needsKey: true },
  { id: 'fish', name: 'Fish Audio', caps: ['voice', 'transcribe'], needsKey: true },
  { id: 'whisper', name: 'Whisper (en la tablet)', caps: ['transcribe'], needsKey: false },
]
const ORDER: Record<string, PluginId[]> = {
  image: ['openai', 'gemini'], voice: ['elevenlabs', 'fish'], sfx: ['elevenlabs'],
  ask: ['openai', 'gemini', 'openrouter'], transcribe: ['whisper', 'elevenlabs', 'openai', 'fish'], download: [],
}
const pname = (id: string) => PLUGINS.find((p) => p.id === id)?.name || id
const KEY = (id: string) => `{{secret:plugin.${id}}}`

// ── HTTP por Java ─────────────────────────────────────────────────────────────
type Body = { type: 'text'; data: string } | { type: 'base64'; data: string } | { type: 'file'; path: string }
type Res = { status: number; headers: Record<string, string>; text?: string; size?: number }

async function http(url: string, o: { method?: string; headers?: Record<string, string>; body?: Body; saveTo?: string; timeout?: number } = {}): Promise<Res> {
  const r = await host().callAsync<Res>('http.request', { method: o.method || 'GET', url, headers: o.headers || {}, body: o.body || null, saveTo: o.saveTo || null, timeoutMs: o.timeout || 180000 })
  if (r.status < 200 || r.status >= 300) {
    let msg: any = r.text || ''
    try { const j = JSON.parse(msg); msg = j.error?.message || j.detail?.message || j.detail || j.message || j.error || msg } catch { /* texto */ }
    if (typeof msg !== 'string') msg = JSON.stringify(msg)
    const hint = r.status === 401 || r.status === 403 ? ' (¿la clave es correcta y tiene permisos?)' : r.status === 429 ? ' (límite de uso o créditos agotados)' : r.status === 402 ? ' (sin créditos)' : ''
    throw new Error(`HTTP ${r.status}${hint}: ${String(msg).slice(0, 400)}`)
  }
  return r
}
const json = async (url: string, o: Parameters<typeof http>[1] = {}) => JSON.parse((await http(url, o)).text || 'null')
const jsonBody = (obj: unknown): Body => ({ type: 'text', data: JSON.stringify(obj) })

/** multipart/form-data armado en el navegador y enviado como bytes. */
async function formBody(fd: FormData): Promise<{ body: Body; contentType: string }> {
  const r = new Response(fd)
  const contentType = r.headers.get('content-type') || 'multipart/form-data'
  return { body: { type: 'base64', data: await blobToBase64(await r.blob()) }, contentType }
}

function hasKey(id: string) { return !!host().call<string>('secrets.masked', { name: `plugin.${id}` }) }
function needKey(id: PluginId) { if (!hasKey(id)) throw new Error(`Falta la clave de ${pname(id)}. Cargala en Ajustes → Plugins.`) }

/** Carpeta del proyecto + archivo nuevo: assets/<sub>/<nombre>-N.ext */
function outFile(projectId: string, sub: string, name: string, ext: string) {
  const dir = projectDir(projectId)
  if (!dir) throw new Error('Proyecto no encontrado: ' + projectId)
  const d = join(dir, 'assets', sub)
  fs.mkdir(d)
  const base = slugify(name || sub).slice(0, 40) || sub
  let f = `${base}${ext}`, n = 2
  while (fs.exists(join(d, f))) f = `${base}-${n++}${ext}`
  return { abs: join(d, f), rel: `assets/${sub}/${f}` }
}

// ── estado ────────────────────────────────────────────────────────────────────
/** Whisper se revisa preguntándole al puente de Termux (whisperState); acá va lo último que se supo. */
export function pluginStatus(): PluginStatus[] {
  const s = getSettings().plugins as any
  const masked = host().call<Record<string, string>>('secrets.list', { names: PLUGINS.filter((p) => p.needsKey).map((p) => `plugin.${p.id}`) })
  return PLUGINS.map((p) => {
    const enabled = s[p.id]?.enabled !== false
    if (p.id === 'whisper') { const w = whisperQuick(); return { ...p, enabled, ready: enabled && w.ready, detail: w.detail } }
    const m = masked[`plugin.${p.id}`] || ''
    return { ...p, enabled, ready: enabled && !!m, masked: m, detail: m ? `Clave cargada (${m})` : 'Sin clave' }
  })
}

export function setKey(id: string, key: string) {
  host().call('secrets.set', { name: `plugin.${id}`, value: key || '' })
  return pluginStatus()
}

async function pick(cap: Cap, want?: string): Promise<PluginId> {
  if (cap === 'transcribe' && (!want || want === 'whisper') && getSettings().plugins.whisper?.enabled !== false) await whisperState()
  const st = pluginStatus()
  const ready = (id: string) => st.find((x) => x.id === id)?.ready
  const pref = want || ((getSettings().plugins as any)[cap] as string | undefined)
  if (pref && pref !== 'auto') {
    if (!ORDER[cap].includes(pref as PluginId)) throw new Error(`${pname(pref)} no está disponible en Android para esto. Opciones: ${ORDER[cap].map(pname).join(', ')}`)
    if (!ready(pref)) throw new Error(`${pname(pref)} no está configurado. Configuralo en Ajustes → Plugins.`)
    return pref as PluginId
  }
  const id = ORDER[cap].find(ready)
  if (!id) throw new Error(`No hay ningún plugin configurado para ${({ image: 'generar imágenes', voice: 'generar voz', sfx: 'efectos de sonido', ask: 'consultar otros modelos', transcribe: 'transcribir', download: 'descargar videos' } as any)[cap]}. Opciones: ${ORDER[cap].map(pname).join(', ') || 'ninguna'} (Ajustes → Plugins).`)
  return id
}

export async function testPlugin(id: PluginId): Promise<string> {
  if (id === 'whisper') return whisperTest()
  needKey(id)
  switch (id) {
    case 'openai': { const j = await json('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${KEY('openai')}` }, timeout: 20000 }); return `Conectado · ${j.data?.length || 0} modelos disponibles` }
    case 'gemini': { const j = await json('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': KEY('gemini') }, timeout: 20000 }); return `Conectado · ${j.models?.length || 0} modelos` }
    case 'openrouter': { const j = await json('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${KEY('openrouter')}` }, timeout: 20000 }); const d = j.data || {}; return `Conectado${d.limit != null ? ` · límite US$ ${d.limit}` : ''}${d.usage != null ? ` · usado US$ ${(+d.usage).toFixed(2)}` : ''}` }
    case 'elevenlabs': {
      try { const j = await json('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': KEY('elevenlabs') }, timeout: 20000 }); return `Conectado · plan ${j.tier || '?'} · ${j.character_count ?? '?'} / ${j.character_limit ?? '?'} caracteres usados` }
      catch { const v = await listVoices('elevenlabs'); return `Conectado · ${v.length} voces` }
    }
    case 'fish': {
      try { const j = await json('https://api.fish.audio/wallet/self/api-credit', { headers: { Authorization: `Bearer ${KEY('fish')}` }, timeout: 20000 }); return `Conectado · crédito ${j.credit ?? '?'}` }
      catch { const v = await listVoices('fish'); return `Conectado · ${v.length} voces propias` }
    }
  }
  throw new Error(`${pname(id)} no está disponible en Android`)
}

// ── voces ─────────────────────────────────────────────────────────────────────
export async function listVoices(provider: 'elevenlabs' | 'fish', query = ''): Promise<Voice[]> {
  if (provider === 'elevenlabs') {
    needKey('elevenlabs')
    const j = await json('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': KEY('elevenlabs') }, timeout: 30000 })
    return (j.voices || []).map((v: any) => ({ id: v.voice_id, name: v.name, preview: v.preview_url, desc: [v.category, ...Object.values(v.labels || {})].filter(Boolean).join(' · ') }))
  }
  needKey('fish')
  const h = { Authorization: `Bearer ${KEY('fish')}` }
  const mine = await json(`https://api.fish.audio/model?self=true&page_size=50`, { headers: h, timeout: 30000 }).catch(() => ({ items: [] }))
  const m = /^([a-z]{2})(?::\s*(.*))?$/i.exec(query.trim())
  const lang = m ? m[1].toLowerCase() : ''
  const title = m ? (m[2] || '') : query.trim()
  const q = `${title ? `&title=${encodeURIComponent(title)}` : ''}${lang ? `&language=${lang}` : ''}`
  const pub = await json(`https://api.fish.audio/model?page_size=50&sort_by=task_count${q}`, { headers: h, timeout: 30000 }).catch(() => ({ items: [] }))
  const map = (v: any, own: boolean): Voice => ({ id: v._id, name: v.title, desc: [own ? 'propia' : 'biblioteca', ...(v.languages || []), ...(v.tags || []).slice(0, 3)].join(' · '), lang: (v.languages || [])[0], preview: v.samples?.[0]?.audio })
  return [...(mine.items || []).map((v: any) => map(v, true)), ...(pub.items || []).map((v: any) => map(v, false))]
}

// ── imágenes ──────────────────────────────────────────────────────────────────
export type ImageReq = { prompt: string; name?: string; aspect?: 'square' | 'landscape' | 'portrait'; transparent?: boolean; provider?: string; reference?: string }
export async function generateImage(projectId: string, req: ImageReq) {
  if (!req.prompt?.trim()) throw new Error('Falta la descripción de la imagen')
  const provider = await pick('image', req.provider)
  const s = getSettings().plugins
  const aspect = req.aspect || 'landscape'
  const out = outFile(projectId, 'ia', req.name || req.prompt.split(/\s+/).slice(0, 6).join(' '), '.png')
  const dir = projectDir(projectId)!
  const ref = req.reference ? join(dir, req.reference.replace(/^\/+/, '')) : ''
  if (ref && !fs.exists(ref)) throw new Error('No existe la imagen de referencia: ' + req.reference)
  if (provider === 'openai') {
    const size = aspect === 'square' ? '1024x1024' : aspect === 'portrait' ? '1024x1536' : '1536x1024'
    let j: any
    if (ref) {
      const fd = new FormData()
      fd.append('model', s.openai.imageModel || 'gpt-image-1'); fd.append('prompt', req.prompt); fd.append('size', size); fd.append('quality', s.openai.imageQuality || 'high')
      if (req.transparent) fd.append('background', 'transparent')
      fd.append('image', new Blob([await fs.readBytes(ref)], { type: /\.jpe?g$/i.test(ref) ? 'image/jpeg' : 'image/png' }), ref.split('/').pop())
      const { body, contentType } = await formBody(fd)
      j = await json('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${KEY('openai')}`, 'Content-Type': contentType }, body, timeout: 300000 })
    } else {
      j = await json('https://api.openai.com/v1/images/generations', {
        method: 'POST', headers: { Authorization: `Bearer ${KEY('openai')}`, 'Content-Type': 'application/json' }, timeout: 300000,
        body: jsonBody({ model: s.openai.imageModel || 'gpt-image-1', prompt: req.prompt, size, quality: s.openai.imageQuality || 'high', n: 1, ...(req.transparent ? { background: 'transparent', output_format: 'png' } : {}) }),
      })
    }
    const b64 = j.data?.[0]?.b64_json
    if (!b64) throw new Error('OpenAI no devolvió ninguna imagen')
    host().call('fs.writeBase64', { path: out.abs, data: b64, append: false })
  } else {
    const ar = aspect === 'square' ? '1:1' : aspect === 'portrait' ? '2:3' : '16:9'
    const parts: any[] = [{ text: `${req.prompt}\n\nAspect ratio ${ar}.${req.transparent ? ' Plain solid white background, isolated subject.' : ''}` }]
    if (ref) parts.push({ inlineData: { mimeType: /\.jpe?g$/i.test(ref) ? 'image/jpeg' : 'image/png', data: await blobToBase64(new Blob([await fs.readBytes(ref)])) } })
    const j = await json(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(s.gemini.imageModel || 'gemini-2.5-flash-image')}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': KEY('gemini'), 'Content-Type': 'application/json' }, timeout: 300000,
      body: jsonBody({ contents: [{ parts }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'] } }),
    })
    const img = (j.candidates?.[0]?.content?.parts || []).find((p: any) => p.inlineData?.data)
    if (!img) throw new Error('Gemini no devolvió ninguna imagen')
    host().call('fs.writeBase64', { path: out.abs, data: img.inlineData.data, append: false })
  }
  return { path: out.rel, abs: out.abs, provider: pname(provider) }
}

// ── voz ───────────────────────────────────────────────────────────────────────
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
      method: 'POST', headers: { 'xi-api-key': KEY('elevenlabs'), 'Content-Type': 'application/json' }, timeout: 300000,
      body: jsonBody({ text: req.text, model_id: e.modelId || 'eleven_multilingual_v2', voice_settings: { stability: e.stability, similarity_boost: e.similarity, style: e.style, speed: req.speed || e.speed || 1, use_speaker_boost: true } }),
    })
    if (!j.audio_base64) throw new Error('ElevenLabs no devolvió audio')
    host().call('fs.writeBase64', { path: out.abs, data: j.audio_base64, append: false })
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
    try {
      await http('https://api.fish.audio/v1/tts', { method: 'POST', headers: { Authorization: `Bearer ${KEY('fish')}`, 'Content-Type': 'application/json', model }, body: jsonBody(body), saveTo: out.abs, timeout: 600000 })
    } catch (e: any) {
      if (/HTTP 402/.test(e.message) && model !== 's2.1-pro-free') throw new Error(`${e.message}. Sin saldo para ${model}: usá el modelo gratuito s2.1-pro-free (Ajustes → Plugins → Fish Audio).`)
      throw e
    }
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
  await http('https://api.elevenlabs.io/v1/sound-generation', { method: 'POST', headers: { 'xi-api-key': KEY('elevenlabs'), 'Content-Type': 'application/json' }, body: jsonBody(body), saveTo: out.abs, timeout: 180000 })
  return { path: out.rel, abs: out.abs, duration: +(await probeDuration(out.abs)).toFixed(3), provider: 'ElevenLabs' }
}

// ── transcripción ─────────────────────────────────────────────────────────────
/**
 * El audio de un archivo, mono de 16 bits a 16 kHz, de a un minuto: un video largo no entra entero en
 * la memoria del WebView.
 */
async function* pcm16k(rel: string, maxSec?: number): AsyncGenerator<Int16Array<ArrayBuffer>> {
  const SR = 16000, WIN = 60
  let any = false
  for (let t = 0; !maxSec || t < maxSec; t += WIN) {
    const dur = maxSec ? Math.min(WIN, maxSec - t) : WIN
    let buf: AudioBuffer | null
    try { buf = await decodeRange(rel, t, dur, SR) } catch (e: any) {
      if (t === 0) throw new Error(`No se pudo leer el audio: ${e?.message || e}`)
      break
    }
    if (!buf) break
    const pcm = new Int16Array(buf.length)
    const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf!.getChannelData(c))
    for (let i = 0; i < buf.length; i++) {
      let v = 0
      for (const d of chans) v += d[i]
      v /= chans.length
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)))
    }
    if (pcm.length) { any = true; yield pcm }
    if (buf.duration < dur - 0.05) break
  }
  if (!any) throw new Error('El archivo no tiene audio')
}

/** Audio en WAV para las APIs de transcripción (tienen límite de tamaño: mono a 16 kHz alcanza). */
async function lightAudio(rel: string, maxSec?: number): Promise<Blob> {
  const SR = 16000
  const parts: Int16Array<ArrayBuffer>[] = []
  let len = 0
  for await (const pcm of pcm16k(rel, maxSec)) { parts.push(pcm); len += pcm.length }
  const h = new DataView(new ArrayBuffer(44))
  const wr = (o: number, s: string) => { for (let i = 0; i < s.length; i++) h.setUint8(o + i, s.charCodeAt(i)) }
  wr(0, 'RIFF'); h.setUint32(4, 36 + len * 2, true); wr(8, 'WAVE'); wr(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true)
  h.setUint32(24, SR, true); h.setUint32(28, SR * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true); wr(36, 'data'); h.setUint32(40, len * 2, true)
  return new Blob([h.buffer, ...parts], { type: 'audio/wav' })
}

export async function transcribe(rel: string, o: { provider?: string; maxSec?: number; lang?: string } = {}): Promise<{ text: string; words: Word[]; provider: string; lang?: string }> {
  if (!fs.exists(rel)) throw new Error('No existe el archivo: ' + rel)
  const provider = await pick('transcribe', o.provider)
  if (provider === 'whisper') return whisperFile(rel, o)
  const blob = await lightAudio(rel, o.maxSec)
  if (provider === 'elevenlabs') {
    const fd = new FormData()
    fd.append('model_id', 'scribe_v1'); fd.append('file', blob, 'audio.wav')
    if (o.lang) fd.append('language_code', o.lang)
    const { body, contentType } = await formBody(fd)
    const j = await json('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': KEY('elevenlabs'), 'Content-Type': contentType }, body, timeout: 900000 })
    const words = (j.words || []).filter((w: any) => w.type === 'word').map((w: any) => ({ w: w.text, start: w.start, end: w.end }))
    return { text: j.text || '', words, provider: 'ElevenLabs', lang: j.language_code }
  }
  if (provider === 'fish') {
    const fd = new FormData()
    fd.append('audio', blob, 'audio.wav'); fd.append('ignore_timestamps', 'false')
    if (o.lang) fd.append('language', o.lang)
    const { body, contentType } = await formBody(fd)
    const j = await json('https://api.fish.audio/v1/asr', { method: 'POST', headers: { Authorization: `Bearer ${KEY('fish')}`, model: 'transcribe-1', 'Content-Type': contentType }, body, timeout: 900000 })
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
  fd.append('model', 'whisper-1'); fd.append('response_format', 'verbose_json'); fd.append('timestamp_granularities[]', 'word'); fd.append('file', blob, 'audio.wav')
  if (o.lang) fd.append('language', o.lang)
  const { body, contentType } = await formBody(fd)
  const j = await json('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${KEY('openai')}`, 'Content-Type': contentType }, body, timeout: 900000 })
  return { text: j.text || '', words: (j.words || []).map((w: any) => ({ w: w.word, start: w.start, end: w.end })), provider: 'OpenAI', lang: j.language }
}

// ── Whisper en la tablet (whisper.cpp en Termux) ──────────────────────────────
type WState = { ready: boolean; detail: string; model?: WhisperModel; installed: string[]; status?: WhisperBridgeStatus }
let wCache: { at: number; st: WState } | null = null
const NEED_TERMUX = 'Necesita Termux preparado (Ajustes › Claude › Con tu plan de Claude, pasos 1 a 3)'

/** Lo último que se supo de Whisper, sin preguntarle al puente (para listar los plugins al instante). */
function whisperQuick(): { ready: boolean; detail: string } {
  if (wCache) return wCache.st
  try {
    const t = host().call<{ installed: boolean; permission: boolean }>('termux.status')
    if (!t.installed || !t.permission) return { ready: false, detail: NEED_TERMUX }
  } catch { /* sin Termux */ }
  return { ready: false, detail: 'Sin revisar' }
}

/** Qué hay instalado de verdad: se lo pregunta al puente de Termux (y lo arranca si hace falta). */
export async function whisperState(force = false): Promise<WState> {
  if (!force && wCache && Date.now() - wCache.at < 5 * 60e3) return wCache.st
  const done = (st: WState) => { wCache = { at: Date.now(), st }; return st }
  const T = await import('./termux')
  const t = T.termuxStatus()
  if (!t.installed || !t.permission) return done({ ready: false, detail: NEED_TERMUX, installed: [] })
  let st: WhisperBridgeStatus
  try { st = await T.whisperBridgeStatus() } catch (e: any) { return done({ ready: false, detail: `Termux no respondió: ${e?.message || e}`, installed: [] }) }
  const installed: string[] = T.WHISPER_MODELS.filter((m) => st.models.some((x) => x.file === m.file)).map((m) => m.id)
  if (!st.bin) return done({ ready: false, detail: 'No instalado', installed, status: st })
  if (!installed.length) return done({ ready: false, detail: `whisper.cpp ${st.version || ''} sin modelos: descargá uno`, installed, status: st })
  // El elegido si está descargado; si no, el más preciso de los que hay.
  const want = getSettings().plugins.whisper?.model || ''
  const model = T.whisperModel(installed.includes(want) ? want : installed[installed.length - 1])!
  return done({ ready: true, detail: `${model.label} · whisper.cpp ${st.version || ''} · ${installed.length} modelo${installed.length > 1 ? 's' : ''} descargado${installed.length > 1 ? 's' : ''}`, model, installed, status: st })
}
export function resetWhisper() { wCache = null }

/** Para los ajustes: los modelos con su estado, la versión instalada y si Termux está listo. */
export async function whisperInfo() {
  const T = await import('./termux')
  const st = await whisperState(true)
  return {
    ready: st.ready, detail: st.detail, termux: T.termuxStatus(), bin: !!st.status?.bin, version: st.status?.version || null,
    cores: st.status?.cores || 0, busy: !!st.status?.busy, active: st.model?.id || null,
    models: T.WHISPER_MODELS.map((m) => ({ id: m.id, label: m.label, mb: m.mb, desc: m.desc, installed: st.installed.includes(m.id) })),
  }
}

export async function whisperInstall(model: string) {
  const T = await import('./termux')
  const m = T.whisperModel(model)
  if (!m) throw new Error('Modelo de Whisper desconocido: ' + model)
  resetWhisper()
  await T.whisperInstall(m)
}

export async function whisperRemove(model: string) {
  const T = await import('./termux')
  const m = T.whisperModel(model)
  if (!m) throw new Error('Modelo de Whisper desconocido: ' + model)
  await T.whisperRemove(m)
  resetWhisper()
  return whisperInfo()
}

const dec1 = (n: number) => n.toFixed(1).replace('.', ',')
function speedText(audioSec: number, ms: number) {
  if (!(audioSec > 0 && ms > 0)) return ''
  const f = audioSec / (ms / 1000)
  return f >= 1 ? `${dec1(f)}× más rápido que el audio` : `tarda ${dec1(1 / f)} veces lo que dura el audio`
}

/** Errores conocidos de whisper.cpp, con lo que hay que hacer. */
function whisperHint(msg: string) {
  if (/failed to (initialize|load)|invalid model|bad magic/i.test(msg)) return `El modelo de Whisper parece dañado: borralo y descargalo de nuevo en Ajustes › Plugins › Whisper. (${msg})`
  if (/SIGKILL|out of memory|bad_alloc/i.test(msg)) return `Android cortó Whisper, seguramente por falta de memoria: cerrá otras apps o usá un modelo más chico. (${msg})`
  if (/SIGILL|Illegal instruction/i.test(msg)) return `whisper.cpp usó una instrucción que este procesador no tiene. (${msg})`
  return msg
}

async function whisperFile(rel: string, o: { maxSec?: number; lang?: string }) {
  const w = await whisperState()
  if (!w.ready || !w.model) throw new Error(`Whisper no está listo (${w.detail}): configuralo en Ajustes › Plugins › Whisper.`)
  const T = await import('./termux')
  const release = holdAwake()
  try {
    const r = await T.whisperTranscribe({ model: w.model, lang: o.lang, pcm: pcm16k(rel, o.maxSec) })
    const speed = speedText(r.audioSec, r.ms)
    return { text: r.text, words: r.words, provider: `Whisper en la tablet (${w.model.label}${speed ? `, ${speed}` : ''})`, lang: r.lang || undefined }
  } catch (e: any) { throw new Error(whisperHint(String(e?.message || e))) } finally { release() }
}

/** Prueba con la muestra de voz que dejó la instalación: si anda y a qué velocidad va en esta tablet. */
export async function whisperTest(model?: string): Promise<string> {
  const w = await whisperState(true)
  const T = await import('./termux')
  if (!w.status?.bin) throw new Error(w.detail || 'Whisper no está instalado')
  const m = model ? T.whisperModel(model) : w.model
  if (!m || !w.installed.includes(m.id)) throw new Error(`Falta descargar el modelo ${m?.label || model || ''}`.trim())
  if (!w.status.sample) throw new Error('Falta la muestra de voz: volvé a instalar Whisper.')
  const release = holdAwake()
  try {
    const r = await T.whisperTranscribe({ model: m, sample: true, lang: 'en' })
    const said = r.text.length > 90 ? r.text.slice(0, 88) + '…' : r.text
    return `${m.label}: transcribió ${dec1(r.audioSec)} s de voz en ${dec1(r.ms / 1000)} s (${speedText(r.audioSec, r.ms)}), ${r.words.length} palabras con su tiempo: «${said}»`
  } catch (e: any) { throw new Error(whisperHint(String(e?.message || e))) } finally { release() }
}

// ── consultar otros modelos ───────────────────────────────────────────────────
export async function ask(req: { prompt: string; provider?: string; model?: string; images?: string[]; system?: string }) {
  if (!req.prompt?.trim()) throw new Error('Falta la consulta')
  const provider = await pick('ask', req.provider === 'codex' ? undefined : req.provider)
  const s = getSettings().plugins
  const imgs = (req.images || []).filter((f) => fs.exists(f))
  const mime = (f: string) => (/\.jpe?g$/i.test(f) ? 'image/jpeg' : /\.webp$/i.test(f) ? 'image/webp' : 'image/png')
  const b64 = async (f: string) => blobToBase64(new Blob([await fs.readBytes(f)]))
  if (provider === 'gemini') {
    const model = req.model || s.gemini.chatModel
    const parts: any[] = [{ text: req.prompt }]
    for (const f of imgs) parts.push({ inlineData: { mimeType: mime(f), data: await b64(f) } })
    const j = await json(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': KEY('gemini'), 'Content-Type': 'application/json' }, timeout: 300000,
      body: jsonBody({ contents: [{ role: 'user', parts }], ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}) }),
    })
    return { provider: pname(provider), model, text: (j.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || '').join('') }
  }
  const model = req.model || (provider === 'openai' ? s.openai.chatModel : s.openrouter.chatModel)
  const url = provider === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions'
  let content: any = req.prompt
  if (imgs.length) { content = [{ type: 'text', text: req.prompt }]; for (const f of imgs) content.push({ type: 'image_url', image_url: { url: `data:${mime(f)};base64,${await b64(f)}` } }) }
  const j = await json(url, {
    method: 'POST', timeout: 300000,
    headers: { Authorization: `Bearer ${KEY(provider)}`, 'Content-Type': 'application/json', ...(provider === 'openrouter' ? { 'X-Title': 'OpenAnimator' } : {}) },
    body: jsonBody({ model, messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), { role: 'user', content }] }),
  })
  return { provider: pname(provider), model: j.model || model, text: j.choices?.[0]?.message?.content || '' }
}
