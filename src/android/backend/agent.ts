/**
 * Chat con Claude en Android.
 *
 * En la PC el chat es Claude Code (el CLI del usuario). En la tablet no hay CLI: se usa la API de
 * Claude con el SDK oficial y la clave del usuario, con las mismas herramientas que Claude Code usa
 * allá (Read, Write, Edit, Glob, Grep, Skill y las oa_* de OpenAnimator, ver tools.ts).
 * Emite los mismos eventos que electron/claude.ts (chat:event), así el panel de chat es el mismo.
 *
 * Las peticiones salen por Java (puente nativo): sin CORS y sin que la clave llegue a JavaScript
 * (el SDK manda "{{secret:claude}}" y Java pone la clave guardada en el Keystore).
 *
 * El historial es sólo de agregar (nunca se edita lo ya enviado): así la caché de prompts rinde y
 * los bloques de razonamiento siguen siendo válidos. El prompt de sistema y las herramientas se
 * congelan al empezar cada conversación y se guardan con ella para retomarla igual.
 */
import Anthropic from '@anthropic-ai/sdk'
import type { Attachment, ChatEvent, ChatItem, ChatStats } from '../../api'
import { host } from '../host'
import { projectChanged, send } from './events'
import { basename, blobToBase64, canvasBase64, dirname, fs, hash, join, uniqueName } from './fsx'
import { projectDir } from './projects'
import { buildSystem, PLAN_NOTE, SAVER_API as SAVER } from './prompt'
import { getSettings } from './settings'
import { runTool, toolDefs, toolKind, type ToolContent, validateInput } from './tools'
import { holdAwake } from './wake'

type Msg = { role: 'user' | 'assistant'; content: any[] }
type Opts = { model: string; effort: string; permissionMode: string }

// ── modelos ───────────────────────────────────────────────────────────────────
type ModelInfo = { window: number; price: [number, number, number, number]; adaptive: boolean; fallbacks: boolean; maxTokens: number }
/** Precios en US$ por millón de tokens: entrada, salida, lectura de caché, escritura de caché (5 min). */
const MODEL_INFO: Record<string, ModelInfo> = {
  'claude-opus-5-5': { window: 1_000_000, price: [4, 20, 0.2, 5], adaptive: true, fallbacks: true, maxTokens: 64000 },
  'claude-sonnet-5-5': { window: 1_000_000, price: [2, 10, 0.2, 2.5], adaptive: true, fallbacks: true, maxTokens: 64000 },
  'claude-haiku-4-5': { window: 200_000, price: [1, 5, 0.1, 1.25], adaptive: false, fallbacks: false, maxTokens: 32000 },
  'claude-fable-5-1': { window: 1_000_000, price: [10, 50, 0.25, 12.5], adaptive: true, fallbacks: true, maxTokens: 64000 },
}
/** Modelos que pueden responder cuando el elegido declina un pedido (fallbacks del servidor). */
const FALLBACK_PRICES: Record<string, [number, number, number, number]> = {
  'claude-opus-5': [5, 25, 0.5, 6.25], 'claude-opus-4-8': [5, 25, 0.5, 6.25], 'claude-sonnet-5': [2, 10, 0.2, 2.5],
}
const DEFAULT_MODEL = 'claude-opus-5-5'
const modelInfo = (m: string) => MODEL_INFO[m] || MODEL_INFO[DEFAULT_MODEL]
const validModel = (m?: string) => (m && MODEL_INFO[m] ? m : DEFAULT_MODEL)
const MODEL_NAMES: Record<string, string> = {
  'claude-opus-5-5': 'Opus 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-4-5': 'Haiku 4.5', 'claude-fable-5-1': 'Fable 5.1',
  'claude-opus-5': 'Opus 5', 'claude-opus-4-8': 'Opus 4.8', 'claude-sonnet-5': 'Sonnet 5',
}
const modelLabel = (m?: string) => (m && (MODEL_NAMES[m] || MODEL_NAMES[m.replace(/-\d{8}$/, '')])) || m || 'Claude'

function priceOf(model: string, u: any) {
  const p = MODEL_INFO[model]?.price || FALLBACK_PRICES[model] || modelInfo(model).price
  const w = u?.cache_creation_input_tokens || 0
  return ((u?.input_tokens || 0) * p[0] + (u?.output_tokens || 0) * p[1] + (u?.cache_read_input_tokens || 0) * p[2] + w * p[3]) / 1e6
}

// ── fetch por el puente nativo ────────────────────────────────────────────────
const NULL_BODY = new Set([101, 103, 204, 205, 304])
function makeResponse(status: number, hs: Record<string, string> | undefined, body: ReadableStream<Uint8Array> | string) {
  const h = new Headers()
  // Java ya descomprimió el cuerpo: el largo y la codificación originales no valen.
  for (const [k, v] of Object.entries(hs || {})) if (!/^(content-encoding|content-length|transfer-encoding|connection|keep-alive)$/i.test(k)) try { h.set(k, v) } catch { /* cabecera inválida */ }
  const st = status >= 200 && status <= 599 ? status : 502
  return new Response(NULL_BODY.has(st) ? null : body, { status: st, headers: h })
}
async function bodyOf(b: BodyInit | null | undefined): Promise<{ type: 'text' | 'base64'; data: string } | undefined> {
  if (b == null) return undefined
  if (typeof b === 'string') return { type: 'text', data: b }
  return { type: 'base64', data: await blobToBase64(await new Response(b).blob()) }
}
/** `fetch` para el SDK: la petición la hace Java y el cuerpo llega en partes (eventos head + chunk). */
export function nativeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const req = typeof input === 'object' && 'url' in input && !(input instanceof URL) ? input as Request : null
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : req!.url
  const method = (init.method || req?.method || 'GET').toUpperCase()
  const headers: Record<string, string> = {}
  new Headers(init.headers || req?.headers).forEach((v, k) => { if (!/^(accept-encoding|content-length|host|connection)$/i.test(k)) headers[k] = v })
  return (async () => {
    const body = await bodyOf(init.body)
    if (init.signal?.aborted) throw new DOMException('Cancelado', 'AbortError')
    const ac = new AbortController()
    const onAbort = () => ac.abort()
    init.signal?.addEventListener('abort', onAbort, { once: true })
    const enc = new TextEncoder()
    let ctl!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c }, cancel() { ac.abort() } })
    return await new Promise<Response>((resolve, reject) => {
      let headed = false
      host().callAsync<{ status: number; headers: Record<string, string>; text?: string }>('http.request', { method, url, headers, body, stream: true, timeoutMs: 15 * 60_000 }, {
        signal: ac.signal,
        onEvent: (e) => {
          if (e.event === 'head') { headed = true; resolve(makeResponse(e.status, e.headers, stream)) }
          else if (e.event === 'chunk' && e.text) { try { ctl.enqueue(enc.encode(e.text)) } catch { /* ya cerrado */ } }
        },
      }).then((r) => {
        if (!headed) resolve(makeResponse(r.status, r.headers, r.text || ''))
        try { ctl.close() } catch { /* ya cerrado */ }
      }, (err) => {
        // Como fetch: las fallas de red son TypeError (el SDK las reintenta).
        const e = err?.name === 'AbortError' ? err : new TypeError(String(err?.message || err || 'Error de red'))
        if (!headed) reject(e)
        else try { ctl.error(e) } catch { /* ya cerrado */ }
      }).finally(() => init.signal?.removeEventListener('abort', onAbort))
    })
  })()
}

let _client: Anthropic | null = null
function client() {
  if (!_client) _client = new Anthropic({ apiKey: '{{secret:claude}}', dangerouslyAllowBrowser: true, fetch: nativeFetch as any, maxRetries: 3, timeout: 15 * 60_000 })
  return _client
}

/** Mensajes de error entendibles para el usuario. */
function explain(e: any): string {
  const msg = String(e?.error?.error?.message || e?.message || e || 'Error desconocido')
  if (e instanceof Anthropic.APIUserAbortError || e?.name === 'AbortError') return 'Interrumpido.'
  if (/Falta la clave claude/.test(msg)) return 'Falta la clave de la API de Claude: cargala en Ajustes › Claude.'
  if (e instanceof Anthropic.AuthenticationError) return 'La clave de la API de Claude no es válida (revisala en Ajustes › Claude).'
  if (e instanceof Anthropic.PermissionDeniedError) return 'Tu clave de la API no tiene permiso para esto: ' + msg
  if (e instanceof Anthropic.RateLimitError) return 'Se alcanzó el límite de uso de tu cuenta de la API. Esperá un momento y volvé a intentar.'
  if (e instanceof Anthropic.APIConnectionError) return 'Sin conexión con Claude. Revisá internet y volvé a intentar.'
  if (/credit balance is too low|credit balance/i.test(msg)) return 'Tu cuenta de la API de Claude no tiene saldo. Cargá crédito en platform.claude.com y volvé a intentar.'
  if (e?.status === 529 || /overloaded/i.test(msg)) return 'Claude está saturado en este momento. Probá de nuevo en unos segundos.'
  if (e?.status === 404 && /model/i.test(msg)) return 'Ese modelo no está disponible para tu clave de la API. Elegí otro modelo.'
  if (e?.status === 413 || /prompt is too long|too many tokens/i.test(msg)) return 'La conversación es demasiado larga para el modelo. Compactala o empezá una nueva.'
  return msg
}

/** Herramientas tal como se mandan a la API (con streaming ansioso de la entrada). */
function apiTools() {
  return toolDefs().map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, eager_input_streaming: true }))
}

// ── guardado de conversaciones: <proyecto>/.oa-chat/ ──────────────────────────
export type SessionInfo = { id: string; title: string; first: string; updated: number; size: number }
type Stored = {
  format: 'oa-chat/1'; id: string; projectId: string; created: number; updated: number; title: string; first: string
  system: string; tools: any[]; messages: Msg[]; items: ChatItem[]; stats: ChatStats; alwaysAllow: string[]; summary?: string
}
const CHAT_DIR = '.oa-chat'
const CTX_SUFFIX = /\n\n\(Contexto del editor:[\s\S]*$/
const chatDir = (projectId: string) => { const d = projectDir(projectId); if (!d) throw new Error('Proyecto no encontrado'); return join(d, CHAT_DIR) }

/** Las imágenes (base64) van a archivos aparte: el JSON de la conversación queda liviano. */
const imageFiles = new WeakMap<object, string>()
function externalize(dir: string, x: any): any {
  if (Array.isArray(x)) return x.map((v) => externalize(dir, v))
  if (!x || typeof x !== 'object') return x
  if (x.type === 'image' && x.source?.type === 'base64' && typeof x.source.data === 'string') {
    let name = imageFiles.get(x.source)
    if (!name) {
      name = `${hash(x.source.data)}.b64`
      const file = join(dir, 'img', name)
      if (!fs.exists(file)) fs.writeText(file, x.source.data)
      imageFiles.set(x.source, name)
    }
    return { ...x, source: { type: 'oa_file', media_type: x.source.media_type, file: name } }
  }
  const out: any = {}
  for (const k of Object.keys(x)) out[k] = externalize(dir, x[k])
  return out
}
function internalize(dir: string, x: any): any {
  if (Array.isArray(x)) return x.map((v) => internalize(dir, v))
  if (!x || typeof x !== 'object') return x
  if (x.type === 'image' && x.source?.type === 'oa_file') {
    let data = ''
    try { data = fs.readText(join(dir, 'img', basename(x.source.file))) } catch { /* imagen perdida */ }
    if (!data) return { type: 'text', text: '[imagen no disponible]' }
    const out = { ...x, source: { type: 'base64', media_type: x.source.media_type, data } }
    imageFiles.set(out.source, basename(x.source.file))
    return out
  }
  const out: any = {}
  for (const k of Object.keys(x)) out[k] = internalize(dir, x[k])
  return out
}
/** Versión liviana de un item para guardar (las entradas de Write pueden ser archivos enteros). */
function slimItem(it: ChatItem): ChatItem {
  if (!it.input || typeof it.input !== 'object') return it
  const input: any = {}
  for (const [k, v] of Object.entries(it.input)) input[k] = typeof v === 'string' && v.length > 1500 ? v.slice(0, 1500) + '…' : v
  return { ...it, input }
}

function readIndex(projectId: string): SessionInfo[] {
  try { return fs.readJSON<SessionInfo[]>(join(chatDir(projectId), 'index.json')) } catch { return [] }
}
function writeIndex(projectId: string, list: SessionInfo[]) {
  fs.writeText(join(chatDir(projectId), 'index.json'), JSON.stringify(list.sort((a, b) => b.updated - a.updated).slice(0, 200)))
}

export function listSessions(projectId: string): SessionInfo[] {
  const dir = chatDir(projectId)
  const known = readIndex(projectId).filter((s) => fs.exists(join(dir, `${s.id}.json`)))
  return known.sort((a, b) => b.updated - a.updated)
}

function loadStored(projectId: string, sid: string): Stored | null {
  if (!/^[\w-]+$/.test(sid)) return null
  const dir = chatDir(projectId)
  const f = join(dir, `${sid}.json`)
  if (!fs.exists(f)) return null
  const s = fs.readJSON<Stored>(f)
  s.messages = internalize(dir, s.messages)
  return s
}

/** Tamaño aproximado del historial en bytes (la API acepta pedidos de hasta 32 MB). */
function approxBytes(x: any): number {
  if (typeof x === 'string') return x.length
  if (Array.isArray(x)) { let n = 0; for (const v of x) n += approxBytes(v); return n }
  if (x && typeof x === 'object') { let n = 0; for (const k of Object.keys(x)) n += k.length + approxBytes(x[k]); return n }
  return 8
}
const MAX_BYTES = 22_000_000
/** La API acepta hasta 100 imágenes por pedido. */
const MAX_IMAGES = 90
const KEEP_IMAGES = 8
const isImage = (b: any) => b && typeof b === 'object' && b.type === 'image'
function countImages(msgs: Msg[]) {
  let n = 0
  for (const m of msgs) for (const b of m.content) {
    if (isImage(b)) n++
    else if (b?.type === 'tool_result' && Array.isArray(b.content)) for (const c of b.content) if (isImage(c)) n++
  }
  return n
}

// ── la conversación ───────────────────────────────────────────────────────────
let seq = 0
const nid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`
const errResult = (id: string, text: string) => ({ type: 'tool_result', tool_use_id: id, is_error: true, content: text })
const resultText = (c: ToolContent | string) => (typeof c === 'string' ? c : c.map((b) => (b.type === 'text' ? b.text : '[imagen]')).join('\n'))

class Interrupted extends Error { constructor() { super('Interrumpido por el usuario') } }

class AgentChat {
  id = nid('chat')
  sessionId: string
  items: ChatItem[] = []
  busy = false
  liveModel?: string
  private index = new Map<string, ChatItem>()
  private messages: Msg[] = []
  private system = ''
  private tools: any[] = []
  private created = Date.now()
  private title = ''
  private first = ''
  private summary?: string
  private stats: ChatStats
  private alwaysAllow = new Set<string>()
  private notes: string[] = []
  /** Lo que se escribió mientras Claude trabajaba (el item ya está en la conversación, «En cola»). */
  private queue: Array<{ id: string; text: string; images: Array<{ mediaType: string; data: string }> }> = []
  private pendingPerms = new Map<string, (ok: boolean) => void>()
  private abort: AbortController | null = null
  private interrupted = false
  private onInterrupt: (() => void) | null = null
  private toolItems = new Map<string, string>()
  private dirty = new Map<string, Partial<ChatItem>>()
  private flushTimer = 0
  private saved = false
  private saveTimer = 0
  private killed = false

  constructor(public projectId: string, public opts: Opts & { saver: boolean; extra: string }, stored?: Stored | null) {
    const win = modelInfo(opts.model).window
    this.stats = { context: 0, window: win, cost: 0, turns: 0, compactions: 0, output: 0 }
    if (stored) {
      this.sessionId = stored.id
      this.messages = stored.messages
      this.system = stored.system
      this.tools = stored.tools
      this.created = stored.created
      this.title = stored.title
      this.first = stored.first
      this.summary = stored.summary
      this.items = (stored.items || []).filter((it: ChatItem) => !it.queued) // la cola no sobrevive a un cierre
      this.stats = { ...stored.stats, window: win }
      this.alwaysAllow = new Set(stored.alwaysAllow || [])
      this.saved = true
      for (const it of this.items) { if (it.status === 'streaming') it.status = 'ok'; if (it.status === 'ejecutando' || it.status === 'pendiente') it.status = 'interrumpido'; this.index.set(it.id, it) }
    } else {
      this.sessionId = nid('s')
    }
  }

  // ── eventos hacia la interfaz ──
  private emit(e: Omit<ChatEvent, 'session'>) { if (!this.killed) send('chat:event', { session: this.id, ...e }) }
  private push(it: ChatItem) {
    this.flush()
    this.items.push(it); this.index.set(it.id, it)
    if (this.items.length > 3000) this.index.delete(this.items.shift()!.id)
    this.emit({ type: 'item', item: it })
  }
  private patch(id: string | undefined, p: Partial<ChatItem>) {
    if (!id) return
    this.flush()
    const it = this.index.get(id)
    if (it) Object.assign(it, p)
    this.emit({ type: 'patch', item: { id, ...p } })
  }
  /** Parche agrupado (texto que llega de a poco): como mucho uno cada 50 ms por item. */
  private patchSoon(id: string, p: Partial<ChatItem>) {
    const it = this.index.get(id)
    if (it) Object.assign(it, p)
    this.dirty.set(id, { ...(this.dirty.get(id) || {}), ...p })
    if (!this.flushTimer) this.flushTimer = window.setTimeout(() => this.flush(), 50)
  }
  private flush() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = 0 }
    if (!this.dirty.size) return
    const d = [...this.dirty]
    this.dirty.clear()
    for (const [id, p] of d) this.emit({ type: 'patch', item: { id, ...p } })
  }
  notice(text: string, level: ChatItem['level'] = 'info') { this.push({ id: nid('n'), kind: 'notice', text, level }) }
  getStats(): ChatStats { return { ...this.stats } }
  state() {
    this.flush()
    this.emit({ type: 'state', state: { busy: this.busy, alive: !this.killed, sessionId: this.saved ? this.sessionId : undefined, model: this.liveModel || this.opts.model, effort: this.opts.effort, permissionMode: this.opts.permissionMode, stats: this.getStats() } })
  }
  snapshot() {
    this.flush()
    return { id: this.id, items: this.items, busy: this.busy, sessionId: this.saved ? this.sessionId : undefined, options: { model: this.opts.model, effort: this.opts.effort, permissionMode: this.opts.permissionMode }, stats: this.getStats(), model: this.liveModel }
  }

  // ── guardado ──
  /** Guardado agrupado durante el turno (el JSON de una conversación larga pesa varios MB). */
  private saveSoon() {
    if (!this.saveTimer) this.saveTimer = window.setTimeout(() => { this.saveTimer = 0; this.save() }, 2000)
  }
  save() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = 0 }
    if (!this.messages.length && !this.summary) return
    try {
      const dir = chatDir(this.projectId)
      const data: Stored = {
        format: 'oa-chat/1', id: this.sessionId, projectId: this.projectId, created: this.created, updated: Date.now(), title: this.title, first: this.first,
        system: this.system, tools: this.tools, messages: externalize(dir, this.messages), items: this.items.slice(-400).map(slimItem),
        stats: this.stats, alwaysAllow: [...this.alwaysAllow], summary: this.summary,
      }
      const text = JSON.stringify(data)
      fs.writeText(join(dir, `${this.sessionId}.json`), text)
      const list = readIndex(this.projectId).filter((s) => s.id !== this.sessionId)
      list.push({ id: this.sessionId, title: this.title || 'Conversación', first: this.first, updated: data.updated, size: text.length })
      writeIndex(this.projectId, list)
      if (!this.saved) { this.saved = true; this.state() }
    } catch (e) { console.error('No se pudo guardar la conversación', e) }
  }

  // ── opciones ──
  setOptions(patch: Partial<Opts & { saver: boolean; extraInstructions: string }>, label: string) {
    const prev = { ...this.opts }
    if (patch.model !== undefined) this.opts.model = validModel(patch.model)
    if (patch.effort !== undefined) this.opts.effort = patch.effort || ''
    if (patch.permissionMode !== undefined) this.opts.permissionMode = patch.permissionMode
    if (patch.saver !== undefined) this.opts.saver = patch.saver
    if (patch.extraInstructions !== undefined) this.opts.extra = patch.extraInstructions
    // El prompt de sistema no se toca (romperia la caché y el razonamiento guardado):
    // los cambios se le cuentan a Claude en el próximo mensaje.
    if (this.system) {
      if (prev.permissionMode === 'plan' && this.opts.permissionMode !== 'plan') this.notes.push('El usuario salió del modo planificar: ya podés modificar archivos y generar medios según sus permisos.')
      if (prev.saver !== this.opts.saver) this.notes.push(this.opts.saver ? SAVER : 'El usuario desactivó el modo ahorro: ya no hace falta limitar imágenes ni lecturas.')
      if (prev.extra !== this.opts.extra) this.notes.push(this.opts.extra.trim() ? `El usuario cambió sus instrucciones generales. Ahora son: ${this.opts.extra.trim()}` : 'El usuario borró sus instrucciones generales anteriores.')
    }
    this.stats.window = modelInfo(this.opts.model).window
    if (patch.model !== undefined && this.busy) label = label.replace(/\.$/, '') + ' (desde el próximo mensaje).'
    this.notice(label)
    this.state()
  }

  // ── mensajes del usuario ──
  send(text: string, images: Array<{ mediaType: string; data: string }>, files: string[]) {
    if (this.killed) return
    const it: ChatItem = { id: nid('u'), kind: 'user', text, images: images.length || undefined, files: files.length ? files : undefined }
    if (this.busy) { this.queue.push({ id: it.id, text, images }); this.push({ ...it, queued: true }); return }
    this.push(it)
    this.run(text, images).catch((e) => console.error(e))
  }
  /** Saca de la cola uno (o todos, sin `itemId`) sin mandarlo; devuelve sus textos para volver a editarlos. */
  unqueue(itemId?: string) {
    const texts: string[] = []
    this.queue = this.queue.filter((q) => {
      if (itemId && q.id !== itemId) return true
      texts.push(q.text)
      this.items = this.items.filter((x) => x.id !== q.id); this.index.delete(q.id)
      this.emit({ type: 'remove', item: { id: q.id } })
      return false
    })
    return texts
  }

  private async prepare() {
    if (this.system) return
    this.system = await buildSystem(this.projectId, 'api', this.opts.saver, this.opts.extra)
    this.tools = apiTools()
  }

  /** Agrega contenido del usuario: si lo último ya es del usuario (p. ej. se interrumpió), se suma ahí. */
  private appendUser(blocks: any[]) {
    const last = this.messages[this.messages.length - 1]
    if (last?.role === 'user') last.content = [...last.content, ...blocks]
    else this.messages.push({ role: 'user', content: blocks })
  }

  /**
   * Si un turno largo junta demasiadas capturas (más de 90 imágenes o casi 32 MB), las más viejas
   * se cambian por un texto y quedan las últimas 8. Rompe la caché y la API descarta el razonamiento
   * posterior a ese punto (block_binding), pero el turno sigue en vez de fallar.
   */
  private trimImages() {
    if (countImages(this.messages) <= MAX_IMAGES && approxBytes(this.messages) <= MAX_BYTES) return
    const gone = { type: 'text', text: '[imagen quitada para que la conversación entre en el pedido]' }
    let seen = 0, removed = 0
    const keep = (b: any) => { if (!isImage(b)) return b; if (++seen <= KEEP_IMAGES) return b; removed++; return gone }
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]
      const content = [...m.content].reverse().map((b) => (b?.type === 'tool_result' && Array.isArray(b.content) ? { ...b, content: [...b.content].reverse().map(keep).reverse() } : keep(b))).reverse()
      if (removed) this.messages[i] = { ...m, content }
    }
    if (removed) this.notice(`Quité ${removed} imagen(es) viejas de la conversación para que entre en el pedido (Claude ya no las ve). Si vas a seguir mucho más, compactala.`, 'warn')
  }

  private params(messages: Msg[], model: string, effort: string) {
    const mi = modelInfo(model)
    const p: any = {
      model, max_tokens: mi.maxTokens,
      system: [{ type: 'text', text: this.system, cache_control: { type: 'ephemeral' } }],
      tools: this.tools, messages,
      cache_control: { type: 'ephemeral' },
    }
    const betas: string[] = []
    if (mi.adaptive) {
      // Si algo del historial cambiara (una imagen perdida, imágenes quitadas por tamaño), la API
      // descarta el razonamiento viejo en vez de rechazar el pedido: la conversación sigue.
      p.thinking = { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } }
      betas.push('thinking-binding-controls-2026-08-01')
      if (effort) p.output_config = { effort }
    } else if (effort !== 'low') {
      p.thinking = { type: 'enabled', budget_tokens: effort === 'high' ? 10000 : effort === 'xhigh' || effort === 'max' ? 16000 : 4000 }
    }
    if (mi.fallbacks) { p.fallbacks = 'default'; betas.push('server-side-fallback-2026-07-01') }
    if (betas.length) p.betas = betas
    return p
  }

  private async run(text: string, images: Array<{ mediaType: string; data: string }>) {
    this.busy = true
    this.interrupted = false
    this.state()
    const release = holdAwake()
    const t0 = Date.now()
    const costBefore = this.stats.cost
    let error = ''
    try {
      await this.prepare()
      // Contexto casi lleno (o demasiadas imágenes para un pedido): se compacta antes de seguir.
      if (this.messages.length && (this.stats.context > modelInfo(this.opts.model).window * 0.85 || approxBytes(this.messages) > MAX_BYTES)) {
        this.notice('La conversación está por llenar el contexto del modelo: la compacto antes de seguir…')
        await this.compactNow()
      }
      if (!this.first) {
        const clean = text.replace(CTX_SUFFIX, '').trim()
        this.first = clean.slice(0, 220)
        this.title = clean.split('\n')[0].slice(0, 80) || 'Conversación'
      }
      const blocks: any[] = []
      const summary = this.summary && !this.messages.length ? this.summary : undefined
      if (summary) {
        blocks.push({ type: 'text', text: `Resumen de la conversación anterior (se compactó para liberar contexto):\n\n${summary}` })
        this.summary = undefined
      }
      for (const im of images) { const f = await fitImage(im); blocks.push({ type: 'image', source: { type: 'base64', media_type: f.mediaType, data: f.data } }) }
      blocks.push({ type: 'text', text })
      const notes = this.notes.splice(0)
      for (const n of notes) blocks.push({ type: 'text', text: `(Nota de la app: ${n})` })
      if (this.opts.permissionMode === 'plan') blocks.push({ type: 'text', text: PLAN_NOTE })
      const nMsgs = this.messages.length
      const lastUser = this.messages[nMsgs - 1]?.role === 'user' ? this.messages[nMsgs - 1] : null
      const nBlocks = lastUser?.content.length ?? 0
      this.appendUser(blocks)
      this.saveSoon()
      // Si la API rechaza el mensaje (400) o Claude lo declina antes de responder nada, se deshace
      // (con el resumen y las notas que llevaba): la conversación no queda trabada con él.
      const rollback = () => {
        const last = this.messages[this.messages.length - 1]
        if (this.messages.length !== (lastUser ? nMsgs : nMsgs + 1) || last.role !== 'user') return
        // (por índice: trimImages puede haber reemplazado el mensaje por una copia)
        if (lastUser) this.messages[nMsgs - 1] = { ...last, content: last.content.slice(0, nBlocks) }
        else this.messages.length = nMsgs
        if (summary) this.summary = summary
        this.notes.unshift(...notes)
      }
      let outcome: 'refusal' | void
      try { outcome = await this.loop() } catch (e) {
        if (e instanceof Anthropic.BadRequestError) rollback()
        throw e
      }
      if (outcome === 'refusal') rollback()
    } catch (e: any) {
      if (!(e instanceof Interrupted) && !(e instanceof Anthropic.APIUserAbortError) && e?.name !== 'AbortError') error = explain(e)
    } finally {
      this.flush()
      for (const it of this.items) {
        if (it.status === 'streaming') this.patch(it.id, { status: 'ok' })
        else if ((it.kind === 'tool' && it.status === 'ejecutando') || (it.kind === 'permission' && it.status === 'pendiente')) this.patch(it.id, { status: 'interrumpido', isError: it.kind === 'tool' || undefined })
      }
      if (this.interrupted && !error) this.notice('Interrumpido.')
      this.stats.turns++
      this.push({ id: nid('r'), kind: 'result', isError: !!error, text: error, cost: this.stats.cost - costBefore, durationMs: Date.now() - t0 })
      this.busy = false
      this.abort = null
      this.save()
      release()
      this.state()
      const next = this.queue.shift()
      if (next && !this.killed) setTimeout(() => {
        if (this.killed) return
        if (this.busy) { this.queue.unshift(next); return }
        this.patch(next.id, { queued: false })
        this.run(next.text, next.images).catch((e) => console.error(e))
      }, 30)
    }
  }

  /** Pedidos al modelo y herramientas, hasta que Claude termina su turno. */
  private async loop(): Promise<'refusal' | void> {
    const model = this.opts.model, effort = this.opts.effort
    let jsonRetries = 0
    for (let step = 0; step < 400; step++) {
      if (this.interrupted) throw new Interrupted()
      this.trimImages()
      let msg: any
      try {
        msg = await this.request(this.params(this.messages, model, effort))
      } catch (e: any) {
        // Entrada de herramienta que no se pudo leer (streaming ansioso): se repite el pedido, pocas veces.
        if (e instanceof Anthropic.AnthropicError && !(e instanceof Anthropic.APIError) && /tool parameter JSON/i.test(e.message) && jsonRetries++ < 2) {
          this.notice('La respuesta llegó cortada; vuelvo a pedirla…', 'warn')
          continue
        }
        throw e
      }
      this.account(msg)
      const stop = msg.stop_reason
      if (stop === 'refusal') {
        // No se guarda el intento rechazado: el usuario puede reformular.
        const cat = msg.stop_details?.category
        this.notice(`Claude no puede ayudar con este pedido${cat ? ` (${cat})` : ''}.${msg.stop_details?.explanation ? ' ' + msg.stop_details.explanation : ''} Probá reformularlo.`, 'warn')
        return 'refusal'
      }
      const content = echoContent(msg.content)
      this.messages.push({ role: 'assistant', content })
      this.saveSoon()
      const uses = content.filter((b: any) => b.type === 'tool_use')
      if (stop === 'pause_turn') continue
      if (uses.length) {
        const results = stop === 'max_tokens'
          ? uses.map((b: any) => { this.patch(this.toolItems.get(b.id), { status: 'error', isError: true, result: 'Respuesta cortada por longitud' }); return errResult(b.id, 'Tu respuesta se cortó por longitud (max_tokens) y esta entrada quedó incompleta: no se ejecutó. Dividí el trabajo en partes más chicas (p. ej. Write con menos contenido y después Edit).') })
          : await this.runTools(uses)
        this.messages.push({ role: 'user', content: results })
        this.saveSoon()
        continue
      }
      if (stop === 'max_tokens') this.notice('La respuesta se cortó por largo. Pedile que siga.', 'warn')
      return
    }
    this.notice('Claude hizo demasiados pasos seguidos; lo detuve. Pedile que siga si hace falta.', 'warn')
  }

  private account(msg: any) {
    const u = msg.usage || {}
    this.stats.context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
    this.stats.output += u.output_tokens || 0
    const iters: any[] = Array.isArray(u.iterations) ? u.iterations : []
    if (iters.length > 1) for (const it of iters) this.stats.cost += priceOf(it.model || msg.model, it)
    else this.stats.cost += priceOf(msg.model, u)
    this.liveModel = msg.model
    this.state()
  }

  /** Un pedido en streaming: va mostrando razonamiento, texto y herramientas mientras llegan. */
  private async request(params: any) {
    const ac = new AbortController()
    this.abort = ac
    const stream = client().beta.messages.stream(params, { signal: ac.signal })
    const blockItem = new Map<number, string>()
    const started = new Map<string, number>()
    let lastInput = 0
    for await (const ev of stream as any) {
      switch (ev.type) {
        case 'message_start': {
          const u = ev.message?.usage
          if (ev.message?.model) this.liveModel = ev.message.model
          if (u) { this.stats.context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); this.state() }
          break
        }
        case 'content_block_start': {
          const b = ev.content_block || {}
          if (b.type === 'text' || b.type === 'thinking' || b.type === 'redacted_thinking') {
            const think = b.type !== 'text'
            const it: ChatItem = { id: nid(think ? 'th' : 'a'), kind: think ? 'thinking' : 'assistant', text: b.text || b.thinking || '', status: 'streaming' }
            started.set(it.id, Date.now())
            blockItem.set(ev.index, it.id)
            this.push(it)
          } else if (b.type === 'tool_use') {
            const it: ChatItem = { id: nid('tool'), kind: 'tool', name: b.name, input: {}, status: 'ejecutando' }
            this.toolItems.set(b.id, it.id)
            blockItem.set(ev.index, it.id)
            this.push(it)
          } else if (b.type === 'fallback') {
            this.notice(`${modelLabel(b.from?.model)} no siguió con este pedido; continúa ${modelLabel(b.to?.model)}.`)
          }
          break
        }
        case 'content_block_delta': {
          const id = blockItem.get(ev.index)
          const it = id ? this.index.get(id) : undefined
          const d = ev.delta || {}
          if (!it) break
          if (d.type === 'text_delta') this.patchSoon(it.id, { text: (it.text || '') + d.text })
          else if (d.type === 'thinking_delta') this.patchSoon(it.id, { text: (it.text || '') + (d.thinking || ''), tokens: (it.tokens || 0) + (typeof d.estimated_tokens === 'number' ? d.estimated_tokens : Math.ceil((d.thinking || '').length / 4)) })
          else if (d.type === 'input_json_delta' && Date.now() - lastInput > 500) {
            // Vista previa de la entrada (p. ej. qué archivo está escribiendo) mientras llega.
            lastInput = Date.now()
            const snap: any = (stream as any).currentMessage?.content?.[ev.index]
            try { if (snap?.input && typeof snap.input === 'object') this.patchSoon(it.id, { input: previewInput(snap.input) }) } catch { /* JSON parcial */ }
          }
          break
        }
        case 'content_block_stop': {
          const id = blockItem.get(ev.index)
          const it = id ? this.index.get(id) : undefined
          if (!it) break
          if (it.kind === 'tool') {
            const snap: any = (stream as any).currentMessage?.content?.[ev.index]
            try { if (snap?.input && typeof snap.input === 'object') this.patch(it.id, { input: previewInput(snap.input) }) } catch { /* se valida después */ }
          } else {
            const t = started.get(it.id)
            this.patch(it.id, { status: 'ok', ...(t && it.kind === 'thinking' ? { durationMs: Date.now() - t } : {}) })
          }
          break
        }
      }
    }
    const msg = await stream.finalMessage()
    this.abort = null
    return msg
  }

  /** Ejecuta las herramientas pedidas, en orden, con los permisos del modo elegido. */
  private async runTools(uses: any[]) {
    const results: any[] = []
    const changedFiles = new Set<string>()
    const ctx = { projectId: this.projectId, changed: (f: string) => { changedFiles.add(f); projectChanged(this.projectId, f) } }
    for (const b of uses) {
      const itemId = this.toolItems.get(b.id)
      if (this.interrupted) { results.push(errResult(b.id, 'Interrumpido por el usuario: no se ejecutó.')); this.patch(itemId, { status: 'interrumpido', isError: true }); continue }
      // Con streaming ansioso la API no valida la entrada: se lee estricta y se valida acá.
      let input = b.input
      const raw = (b as any).__json_buf
      if (typeof raw === 'string' && raw.trim()) {
        try { input = JSON.parse(raw) } catch {
          results.push({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: JSON.stringify({ INVALID_JSON: raw.length > 4000 ? raw.slice(0, 4000) + '…' : raw }) })
          this.patch(itemId, { status: 'error', isError: true, result: 'La entrada llegó mal formada; Claude la va a reintentar.' })
          continue
        }
      }
      const bad = validateInput(b.name, input)
      if (bad) { results.push(errResult(b.id, bad)); this.patch(itemId, { status: 'error', isError: true, result: bad, input: previewInput(input) }); continue }
      const ok = await this.permit(b.name, input)
      if (ok !== true) { results.push(errResult(b.id, ok)); this.patch(itemId, { status: 'error', isError: true, result: ok }); continue }
      try {
        const stop = new Promise<never>((_, rej) => { this.onInterrupt = () => rej(new Interrupted()) })
        stop.catch(() => {})
        const content = await Promise.race([runTool(b.name, input, ctx), stop])
        results.push({ type: 'tool_result', tool_use_id: b.id, content })
        this.patch(itemId, { status: 'ok', isError: false, result: resultText(content).slice(0, 4000) })
      } catch (e: any) {
        const m = e instanceof Interrupted ? 'Interrumpido por el usuario (la herramienta puede terminar en segundo plano).' : String(e?.message || e)
        results.push(errResult(b.id, m))
        this.patch(itemId, { status: e instanceof Interrupted ? 'interrumpido' : 'error', isError: true, result: m.slice(0, 4000) })
      } finally { this.onInterrupt = null }
    }
    return results
  }

  /** true = se puede; texto = motivo del rechazo (se le devuelve a Claude). */
  private async permit(name: string, input: any): Promise<true | string> {
    const kind = toolKind(name)
    const mode = this.opts.permissionMode
    if (kind === 'read') return true
    if (mode === 'plan') return 'Estás en modo planificar: todavía no podés modificar archivos ni generar medios. Terminá de investigar y presentá el plan.'
    if (mode === 'bypassPermissions' || this.alwaysAllow.has(name)) return true
    if (kind === 'edit' && mode === 'acceptEdits') return true
    const id = nid('perm')
    this.push({ id, kind: 'permission', requestId: id, name, input: previewInput(input), status: 'pendiente' })
    const ok = await new Promise<boolean>((res) => this.pendingPerms.set(id, res))
    return ok ? true : 'El usuario rechazó esta acción. No la repitas; preguntale qué prefiere.'
  }

  respondPermission(itemId: string, allow: boolean, always: boolean) {
    const res = this.pendingPerms.get(itemId)
    if (!res) return
    this.pendingPerms.delete(itemId)
    const it = this.index.get(itemId)
    if (allow && always && it?.name) this.alwaysAllow.add(it.name)
    this.patch(itemId, { status: allow ? (always ? 'permitido (toda la sesión)' : 'permitido') : 'rechazado' })
    res(allow)
  }

  interrupt() {
    if (!this.busy) return
    this.interrupted = true
    try { this.abort?.abort() } catch { /* ignore */ }
    this.onInterrupt?.()
    for (const [id, res] of [...this.pendingPerms]) { this.pendingPerms.delete(id); this.patch(id, { status: 'rechazado' }); res(false) }
  }

  kill() {
    this.interrupt()
    this.save()
    this.killed = true
  }

  // ── compactar: Claude resume la conversación y se sigue desde el resumen ──
  async compact(instructions?: string) {
    if (this.busy || !this.messages.length) return
    this.busy = true
    this.interrupted = false
    this.state()
    this.notice('Compactando la conversación: Claude la resume para liberar contexto…')
    try { await this.compactNow(instructions) } catch (e: any) {
      if (!(e instanceof Anthropic.APIUserAbortError) && e?.name !== 'AbortError') this.notice('No se pudo compactar: ' + explain(e), 'error')
    } finally { this.busy = false; this.abort = null; this.save(); this.state() }
  }

  private async compactNow(instructions?: string) {
    const before = this.stats.context
    const ask = [
      'La conversación se va a compactar para liberar contexto. Escribí un resumen completo y concreto de todo lo necesario para seguir trabajando sin perder nada:',
      'el pedido del usuario y sus preferencias, las decisiones de estilo, qué archivos creaste o cambiaste y para qué, los tiempos y datos clave (voz, clips, duraciones), qué quedó verificado y qué falta.',
      'No uses herramientas: respondé sólo con el resumen, en el idioma del usuario.',
      instructions?.trim() ? `Instrucciones del usuario para el resumen: ${instructions.trim()}` : '',
    ].filter(Boolean).join(' ')
    // Misma base que la conversación (sistema, herramientas, modelo) para aprovechar la caché.
    const msgs: Msg[] = this.messages.map((m) => ({ ...m }))
    const last = msgs[msgs.length - 1]
    if (last?.role === 'user') msgs[msgs.length - 1] = { role: 'user', content: [...last.content, { type: 'text', text: ask }] }
    else msgs.push({ role: 'user', content: [{ type: 'text', text: ask }] })
    const ac = new AbortController()
    this.abort = ac
    const msg: any = await client().beta.messages.stream(this.params(msgs, this.opts.model, 'low'), { signal: ac.signal }).finalMessage()
    this.abort = null
    const u = msg.usage || {}
    this.stats.cost += priceOf(msg.model, u)
    const text = (msg.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim()
    if (!text || msg.stop_reason === 'refusal') throw new Error('Claude no devolvió un resumen')
    this.summary = text
    this.messages = []
    this.stats.compactions++
    this.stats.context = 0
    this.notice(`Conversación compactada${before ? ` (tenía ${Math.round(before / 1000)} mil tokens)` : ''}. Claude sigue con un resumen de lo hecho.`)
  }
}

/** Lo que se muestra de una entrada: los textos largos (contenido de archivos) recortados. */
function previewInput(input: any) {
  if (!input || typeof input !== 'object') return input
  const out: any = Array.isArray(input) ? [] : {}
  for (const [k, v] of Object.entries(input)) out[k] = typeof v === 'string' && v.length > 3000 ? v.slice(0, 3000) + '…' : v
  return out
}

/**
 * Contenido del asistente tal como vuelve a la API. Si otro modelo tomó el pedido a mitad de la
 * respuesta (bloque "fallback"), lo previo a ese punto que no sea texto se omite, como pide la API.
 */
function echoContent(content: any[]) {
  let cut = -1
  content.forEach((b, i) => { if (b?.type === 'fallback') cut = i })
  if (cut < 0) return content
  return content.filter((b, i) => i > cut || (i < cut && b.type === 'text'))
}

// ── API para index.ts ─────────────────────────────────────────────────────────
const chats = new Map<string, AgentChat>()

function optionsFromSettings() {
  const c = getSettings().claude
  return { model: validModel(c.model), effort: c.effort || '', permissionMode: c.permissionMode || 'acceptEdits', saver: c.saver !== false, extra: c.extraInstructions || '' }
}

export function createChat(projectId: string, o?: { resume?: string }) {
  if (!projectDir(projectId)) throw new Error('Proyecto no encontrado')
  const stored = o?.resume ? loadStored(projectId, o.resume) : null
  const chat = new AgentChat(projectId, optionsFromSettings(), stored)
  if (o?.resume && !stored) chat.notice('No se encontró esa conversación.', 'error')
  chats.set(chat.id, chat)
  return chat.snapshot()
}
export function getChat(id: string) { return chats.get(id)?.snapshot() || null }
export function sendChat(id: string, text: string, images: Array<{ mediaType: string; data: string }>, files: string[]) { chats.get(id)?.send(String(text || ''), images || [], files || []) }
export function interruptChat(id: string) { chats.get(id)?.interrupt() }
export function unqueueChat(id: string, itemId?: string) { return chats.get(id)?.unqueue(itemId) || [] }
/** Volver a un mensaje anterior: sólo con Claude Code (con la API el historial sólo se agrega, ver «Chat» en CLAUDE.md). */
export function rewindChat(_id: string, _itemId: string): string | null { return null }
export function retryChat(_id: string) { return false }
export function respondPermission(id: string, itemId: string, allow: boolean, always: boolean) { chats.get(id)?.respondPermission(itemId, allow, always) }
export function killChat(id: string) { const c = chats.get(id); if (c) { c.kill(); chats.delete(id) } }
export function setChatOptions(id: string, patch: any, label: string) { chats.get(id)?.setOptions(patch || {}, String(label || 'Opciones actualizadas.')) }
export function compactChat(id: string, instructions?: string) { return chats.get(id)?.compact(instructions) }

/**
 * Una imagen del usuario que pase de 1920 px por lado se achica (con muchas imágenes en la
 * conversación la API rechaza las de más de 2000 px; p. ej. el fotograma de un proyecto vertical).
 */
async function fitImage(im: { mediaType: string; data: string }): Promise<{ mediaType: string; data: string }> {
  const MAX = 1920
  try {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(im.data), (c) => c.charCodeAt(0))], { type: im.mediaType }))
    const s = MAX / Math.max(bmp.width, bmp.height)
    if (s >= 1) { bmp.close(); return im }
    const cv = document.createElement('canvas')
    cv.width = Math.max(1, Math.round(bmp.width * s)); cv.height = Math.max(1, Math.round(bmp.height * s))
    cv.getContext('2d')!.drawImage(bmp, 0, 0, cv.width, cv.height)
    bmp.close()
    const png = im.mediaType === 'image/png'
    const e = canvasBase64(cv, png ? 'image/png' : 'image/jpeg', 0.9)
    return { mediaType: e.mime, data: e.data }
  } catch { return im }
}

// ── adjuntos: se copian a <proyecto>/adjuntos/ ────────────────────────────────
const IMG = /\.(png|jpe?g|webp|gif|bmp)$/i
async function imagePreview(path: string): Promise<string | undefined> {
  try {
    const bmp = await createImageBitmap(new Blob([await fs.readBytes(path)]))
    const s = Math.min(1, 1568 / Math.max(bmp.width, bmp.height))
    const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s))
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h
    const g = cv.getContext('2d')!
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h) // JPEG no tiene transparencia
    g.drawImage(bmp, 0, 0, w, h); bmp.close()
    return canvasBase64(cv, 'image/jpeg', 0.88).data
  } catch { return undefined }
}

export async function attachFiles(projectId: string, files: Array<string | { path: string; name?: string }>): Promise<Attachment[]> {
  const root = projectDir(projectId)
  if (!root) throw new Error('Proyecto no encontrado')
  const dir = join(root, 'adjuntos')
  fs.mkdir(dir)
  const out: Attachment[] = []
  const incoming = new Set<string>()
  for (const f of files || []) {
    const src = typeof f === 'string' ? f : f?.path
    if (!src) continue
    const st = fs.stat(src)
    if (!st || st.dir) continue
    let rel: string
    if (src.startsWith(root + '/')) rel = src.slice(root.length + 1)
    else {
      const name = uniqueName(dir, (typeof f === 'object' && f.name) || basename(src))
      if (src.startsWith('.incoming/')) { fs.rename(src, join(dir, name)); incoming.add(dirname(src)) } else fs.copy(src, join(dir, name))
      rel = `adjuntos/${name}`
    }
    const abs = join(root, rel)
    out.push({ rel, name: basename(rel), size: fs.stat(abs)?.size || 0, image: IMG.test(rel) ? await imagePreview(abs) : undefined })
  }
  for (const d of incoming) try { fs.delete(d) } catch { /* ignore */ }
  if (out.length) projectChanged(projectId, 'adjuntos')
  return out
}

export async function attachData(projectId: string, name: string, b64: string): Promise<Attachment[]> {
  const root = projectDir(projectId)
  if (!root) throw new Error('Proyecto no encontrado')
  const dir = join(root, 'adjuntos')
  fs.mkdir(dir)
  const clean = basename(String(name || 'pegado.png')).replace(/[\\/:*?"<>|]+/g, '-') || 'pegado.png'
  const file = join(dir, uniqueName(dir, clean))
  await fs.writeBytes(file, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
  return attachFiles(projectId, [file])
}

/** Prueba la clave: pide la ficha del modelo (no consume tokens). */
export async function testClaude() {
  try {
    const m: any = await client().models.retrieve(DEFAULT_MODEL)
    return `Conectado · ${m?.display_name || modelLabel(DEFAULT_MODEL)} disponible`
  } catch (e) { throw new Error(explain(e)) }
}
