/**
 * API HTTP local (127.0.0.1 + token) que usa el servidor MCP para darle a la IA
 * herramientas que necesitan la app abierta: ver fotogramas, hoja de contactos, auditar layout.
 * El puerto y el token se escriben en data/api.json.
 */
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './paths'
import { renderFrames, contactSheet, auditLayout } from './frames'
import { readProject, readTimeline, writeTimeline, listAssets, projectDir } from './projects'
import { probeMedia } from './ffmpeg'
import { nativeImage } from 'electron'
import * as PL from './plugins'
import * as WA from './web-assets'

/** Íconos y tipografías (web-assets.ts): por la red de la PC, guardados en la carpeta del proyecto. */
function webNet(project: string): WA.Net {
  const dir = projectDir(project)
  if (!dir) throw new Error('Proyecto no encontrado')
  const put = (rel: string, data: string | Uint8Array) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data) }
  const get = async (u: string) => { const r = await fetch(u); if (!r.ok) throw new Error(`${new URL(u).host} respondió ${r.status}`); return r }
  return {
    text: async (u) => (await get(u)).text(),
    download: async (u, rel) => { const b = new Uint8Array(await (await get(u)).arrayBuffer()); put(rel, b); return b.length },
    save: put,
  }
}

/** Miniatura JPEG (base64) para que la IA vea lo que se generó sin mandarle el PNG entero. */
function preview(abs: string, w = 640) {
  try {
    const im = nativeImage.createFromPath(abs); if (im.isEmpty()) return null
    const small = im.resize({ width: Math.min(w, im.getSize().width) })
    // PNG para conservar la transparencia y porcentaje de píxeles transparentes (BGRA).
    const bm = small.toBitmap(); let clear = 0
    for (let i = 3; i < bm.length; i += 4) if (bm[i] < 16) clear++
    return { png: small.toPNG().toString('base64'), transparent: Math.round((clear / (bm.length / 4)) * 100) }
  } catch { return null }
}
const abs = (project: string, p: string) => (path.isAbsolute(p) ? p : path.join(projectDir(project)!, p))

let server: http.Server | null = null

function summary(projectId: string, tlId?: string) {
  const p = readProject(projectId)
  const tid = tlId || p.activeTimeline
  const tl = readTimeline(projectId, tid)
  return {
    proyecto: { id: p.id, nombre: p.name, ancho: p.width, alto: p.height, fps: p.fps, carpeta: projectDir(projectId) },
    timelines: p.timelines.map((t) => ({ id: t.id, nombre: t.name, archivo: t.file, activo: t.id === tid })),
    timeline: {
      id: tid, duracion: tl.duration,
      pistas: tl.tracks.map((t) => ({ id: t.id, nombre: t.name, tipo: t.type, silenciada: !!t.muted, clips: t.clips.map((c) => ({ id: c.id, src: c.src, start: c.start, duration: c.duration, in: c.in || 0 })) })),
      notas: tl.notes || [],
    },
  }
}

const handlers: Record<string, (b: any) => Promise<any>> = {
  async info(b) { return summary(b.project, b.timeline) },
  async assets(b) { return listAssets(b.project) },
  async frames(b) {
    const times: number[] = (b.times || [0]).slice(0, 8)
    // 960 px alcanza para revisar composición y texto y cuesta ~45 % menos contexto que 1280.
    const r = await renderFrames(b.project, b.timeline, times, Math.min(1920, b.width || 960), true)
    return r.map((f) => ({ t: f.t, png: f.png.toString('base64') }))
  },
  async contactSheet(b) {
    const r = await contactSheet(b.project, b.timeline, b)
    return { times: r.times, png: r.png.toString('base64') }
  },
  async audit(b) { return auditLayout(b.project, b.timeline, b) },
  async probe(b) {
    const dir = projectDir(b.project)!
    const f = path.isAbsolute(b.path) ? b.path : path.join(dir, b.path)
    return probeMedia(f)
  },
  async plugins() {
    const st = await PL.pluginStatus()
    const s = (await import('./settings')).getSettings().plugins
    return {
      plugins: st.map((p) => ({ id: p.id, nombre: p.name, listo: p.ready, capacidades: p.caps, detalle: p.detail })),
      preferidos: { imagen: s.image, voz: s.voice, consulta: s.ask, transcripcion: s.transcribe },
      voz_por_defecto: { elevenlabs: s.elevenlabs.voiceName || s.elevenlabs.voiceId || null, fish: s.fish.voiceName || s.fish.voiceId || null },
      fish: { modelo: s.fish.model, gratis: s.fish.model === 's2.1-pro-free', sintaxis: s.fish.model === 's1' ? '(parentesis) con etiquetas fijas' : '[corchetes] con lenguaje natural', guia: 'skill voz-fish-audio' },
    }
  },
  async voices(b) { return (await PL.listVoices(b.provider === 'fish' ? 'fish' : 'elevenlabs', b.query)).slice(0, 80).map((v) => ({ id: v.id, nombre: v.name, info: v.desc })) },
  async genImage(b) {
    const r = await PL.generateImage(b.project, { prompt: b.prompt, name: b.name, aspect: b.aspect, transparent: !!b.transparent, provider: b.provider, reference: b.reference })
    const pv = preview(r.abs)
    return { path: r.path, provider: r.provider, preview: pv?.png, transparent: pv?.transparent }
  },
  async tts(b) { const r = await PL.tts(b.project, { text: b.text, provider: b.provider, voice: b.voices?.length ? b.voices : b.voice, name: b.name, speed: b.speed, model: b.model, temperature: b.temperature }); return { path: r.path, duration: r.duration, provider: r.provider, words: r.words } },
  async sfx(b) { const r = await PL.sfx(b.project, { text: b.text, seconds: b.seconds, name: b.name }); return { path: r.path, duration: r.duration, provider: r.provider } },
  async transcribe(b) { return PL.transcribe(abs(b.project, b.path), { provider: b.provider, lang: b.lang }) },
  async ask(b) { return PL.ask({ prompt: b.prompt, provider: b.provider, model: b.model, images: (b.images || []).map((f: string) => abs(b.project, f)), system: b.system }) },
  async iconSearch(b) { return WA.searchIcons(webNet(b.project), String(b.query || ''), { limite: b.limit, coleccion: b.collection }) },
  async iconSave(b) { return WA.saveIcons(webNet(b.project), b.icons || [], { color: b.color }) },
  async fontSearch(b) { return WA.searchFonts(webNet(b.project), b.query, b.category) },
  async fontSave(b) { return WA.saveFont(webNet(b.project), String(b.family || ''), { pesos: b.weights, cursiva: b.italic }) },
  async resolveNote(b) {
    const p = readProject(b.project)
    const tid = b.timeline || p.activeTimeline
    const tl = readTimeline(b.project, tid)
    const before = (tl.notes || []).length
    tl.notes = (tl.notes || []).filter((n) => n.id !== b.id)
    writeTimeline(b.project, tid, tl)
    return { removed: before - tl.notes.length }
  },
}

export function startApi() {
  const token = crypto.randomBytes(18).toString('hex')
  server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.headers['x-oa-token'] !== token) { res.writeHead(403); return res.end() }
    const name = (req.url || '').replace(/^\/+/, '')
    const h = handlers[name]
    if (!h) { res.writeHead(404); return res.end() }
    let body = ''
    req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy() })
    req.on('end', async () => {
      try {
        const out = await h(JSON.parse(body || '{}'))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, result: out }))
      } catch (e: any) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }))
      }
    })
  })
  // Generar imágenes o voz puede tardar varios minutos: sin el límite de 5 min por pedido de Node.
  server.requestTimeout = 0
  server.timeout = 0
  server.listen(0, '127.0.0.1', () => {
    apiInfo = { port: (server!.address() as any).port, token, pid: process.pid }
    writeApiInfo()
    // Autorreparación: si otro proceso pisa o borra el archivo, se restaura en segundos.
    setInterval(writeApiInfo, 4000).unref()
  })
}

let apiInfo: { port: number; token: string; pid: number } | null = null
const API_FILE = () => path.join(DATA_DIR, 'api.json')
/** (Re)escribe data/api.json con el puerto y el token de esta instancia. */
export function writeApiInfo() {
  if (!apiInfo) return
  try {
    const cur = fs.existsSync(API_FILE()) ? fs.readFileSync(API_FILE(), 'utf8') : ''
    const want = JSON.stringify(apiInfo)
    if (cur !== want) fs.writeFileSync(API_FILE(), want)
  } catch { /* ignore */ }
}

export function stopApi() {
  try { server?.close() } catch { /* ignore */ }
  // Sólo borra el archivo si es de esta instancia.
  try { if (apiInfo && JSON.parse(fs.readFileSync(API_FILE(), 'utf8')).pid === apiInfo.pid) fs.rmSync(API_FILE(), { force: true }) } catch { /* ignore */ }
}
