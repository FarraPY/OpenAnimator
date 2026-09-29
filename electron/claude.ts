/**
 * Chat con Claude Code (el CLI oficial del usuario, con su propia cuenta).
 *
 *   claude -p --input-format stream-json --output-format stream-json --verbose
 *          --include-partial-messages --permission-prompt-tool stdio
 *          --permission-mode <modo> --mcp-config <openanimator MCP>
 *
 * Un proceso por conversación (stdin abierto = misma sesión). Los permisos llegan
 * como `control_request` (can_use_tool) y se responden desde la interfaz.
 */
import { spawn, ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { app } from 'electron'
import { APP_DIR, CACHE_DIR, DATA_DIR, claudePath, ffmpegPaths } from './paths'
import { projectDir } from './projects'

export type ChatItem = {
  id: string; kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'permission' | 'result' | 'notice'
  text?: string; name?: string; input?: any; status?: string; result?: string; isError?: boolean
  requestId?: string; images?: number; files?: string[]; cost?: number; durationMs?: number; level?: 'info' | 'warn' | 'error'
}
/** Consumo de la conversación: contexto ocupado (tokens del último pedido al modelo) y ventana del modelo. */
export type ChatStats = { context: number; window: number; cost: number; turns: number; compactions: number; output: number }
export type ChatEvent = { session: string; type: 'item' | 'patch' | 'state'; item?: Partial<ChatItem> & { id: string }; state?: { busy: boolean; alive: boolean; sessionId?: string; model?: string; effort?: string; permissionMode?: string; stats?: ChatStats } }
export type ChatOptions = { projectId: string; permissionMode: string; model?: string; effort?: string; extraInstructions?: string; claudePath?: string; resume?: string; saver?: boolean }

const READONLY_TOOLS = ['oa_proyecto', 'oa_ver_fotogramas', 'oa_hoja_contactos', 'oa_auditar_layout', 'oa_medios', 'oa_info_medio', 'oa_resolver_nota', 'oa_plugins', 'oa_voces']
const SYSTEM_APPEND = [
  'Estás trabajando dentro de OpenAnimator, un estudio de video donde las escenas son HTML/SVG/JS en función del tiempo.',
  'Antes de crear o cambiar escenas leé CLAUDE.md y las skills de OpenAnimator (dirección artística, escenas, voz y tiempos).',
  'VERIFICÁ SIEMPRE tu trabajo visualmente con las herramientas mcp__openanimator__* (oa_ver_fotogramas, oa_hoja_contactos, oa_auditar_layout) antes de decir que terminaste.',
  'Si hacen falta imágenes, voz, efectos de sonido o la opinión de otro modelo, usá los plugins del usuario (oa_plugins, oa_generar_imagen, oa_generar_voz, oa_generar_sfx, oa_transcribir, oa_consultar_ia): pueden tener costo, así que usalos con criterio.',
  'Los archivos que el usuario adjunta al chat quedan en la carpeta adjuntos/ del proyecto: leelos con Read cuando los mencione.',
  'El editor recarga solo cuando guardás archivos. Respondé en el idioma del usuario.',
].join(' ')

/** Modo ahorro: el usuario tiene un límite de uso por sesión; estas reglas bajan mucho el consumo de contexto. */
const SAVER = [
  'MODO AHORRO ACTIVADO (el usuario tiene un límite de uso cada 5 horas; cuidalo):',
  '1) Las imágenes son lo más caro: para revisar usá oa_hoja_contactos (una sola imagen con muchos instantes) antes que varios oa_ver_fotogramas; pedí width 640-960 salvo que necesites ver un detalle fino, y como máximo 4 fotogramas por verificación. No mires de nuevo lo que no cambió.',
  '2) No leas archivos grandes enteros: usá Grep o Read con offset/limit. Si un adjunto es largo (más de ~500 líneas), leelo una sola vez, guardá un resumen con lo esencial en scripts/ y después trabajá con ese resumen.',
  '3) No vuelvas a leer un archivo que ya leíste y no cambió. Para cambios chicos usá Edit, no reescribas archivos completos.',
  '4) Respuestas cortas: no repitas el plan, no pegues código ni el contenido de archivos en el chat; contá en 1-3 líneas qué hiciste.',
  '5) Trabajá por tandas: terminá una escena o sección completa, verificala una vez y seguí; no hagas muchas verificaciones intermedias.',
].join(' ')

/** Entorno limpio para lanzar Claude Code desde la app (sin variables de una sesión de Claude que la haya abierto). */
export function claudeEnv(projectId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|AI_AGENT)/.test(k)) delete env[k]
  delete env.ELECTRON_RUN_AS_NODE
  const ffdir = path.dirname(ffmpegPaths().ffmpeg)
  env.PATH = `${ffdir}${path.delimiter}${env.PATH || env.Path || ''}`
  env.OA_DATA_DIR = DATA_DIR
  env.OA_PROJECT = projectId
  env.OA_EXE = app.isPackaged ? process.execPath : `${process.execPath} "${app.getAppPath()}"`
  return env
}

/** Configuración MCP con las herramientas de OpenAnimator para un proyecto. */
export function writeMcpConfig(projectId: string) {
  const mcpFile = path.join(CACHE_DIR, `mcp-${projectId}.json`)
  fs.writeFileSync(mcpFile, JSON.stringify({
    mcpServers: {
      openanimator: {
        command: process.execPath,
        args: [path.join(APP_DIR, 'mcp', 'server.js')],
        env: { ELECTRON_RUN_AS_NODE: '1', OA_DATA_DIR: DATA_DIR, OA_PROJECT: projectId },
      },
    },
  }, null, 1))
  return mcpFile
}

let seq = 0
const nid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`

export class ChatSession {
  id = nid('chat')
  items: ChatItem[] = []
  proc: ChildProcess | null = null
  busy = false
  sessionId?: string
  model?: string
  private blocks = new Map<number, string>()       // índice de bloque → id de item (mensaje en curso)
  private toolItems = new Map<string, string>()     // tool_use_id → id de item
  private streamedText = false
  private pendingPerms = new Map<string, any>()
  private thinkStart = new Map<string, number>()
  private usage: ChatStats = { context: 0, window: 200000, cost: 0, turns: 0, compactions: 0, output: 0 }
  private compacting = false

  constructor(public opts: ChatOptions, private emit: (e: ChatEvent) => void) {}

  private push(it: ChatItem) { this.items.push(it); if (this.items.length > 3000) this.items.shift(); this.emit({ session: this.id, type: 'item', item: it }) }
  private patch(id: string, p: Partial<ChatItem>) {
    const it = this.items.find((x) => x.id === id)
    if (it) Object.assign(it, p)
    this.emit({ session: this.id, type: 'patch', item: { id, ...p } })
  }
  stats(): ChatStats { return { ...this.usage } }
  private state() { this.emit({ session: this.id, type: 'state', state: { busy: this.busy, alive: !!this.proc, sessionId: this.sessionId, model: this.model, effort: this.opts.effort || '', permissionMode: this.opts.permissionMode, stats: this.stats() } }) }
  notice(text: string, level: ChatItem['level'] = 'info') { this.push({ id: nid('n'), kind: 'notice', text, level }) }

  start() {
    const bin = this.opts.claudePath || claudePath()
    if (!bin) { this.notice('No se encontró Claude Code. Instalalo desde claude.com/code y volvé a abrir el chat.', 'error'); return false }
    const dir = projectDir(this.opts.projectId)
    if (!dir) { this.notice('Proyecto no encontrado', 'error'); return false }
    const mcpFile = writeMcpConfig(this.opts.projectId)
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--permission-prompt-tool', 'stdio', '--permission-mode', this.opts.permissionMode || 'acceptEdits',
      '--mcp-config', mcpFile, '--append-system-prompt', SYSTEM_APPEND + (this.opts.saver !== false ? String.fromCharCode(10, 10) + SAVER : '') + (this.opts.extraInstructions?.trim() ? String.fromCharCode(10, 10) + 'Instrucciones del usuario (ajustes de OpenAnimator): ' + this.opts.extraInstructions.trim() : ''),
      // Herramientas propias que sólo leen o renderizan: no hace falta pedir permiso cada vez.
      '--allowedTools', READONLY_TOOLS.map((n) => `mcp__openanimator__${n}`).join(',')]
    if (this.opts.model) args.push('--model', this.opts.model)
    if (this.opts.effort) args.push('--effort', this.opts.effort)
    if (this.opts.resume) args.push('--resume', this.opts.resume)
    const env = claudeEnv(this.opts.projectId)
    const p = spawn(bin, args, { cwd: dir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = p
    let errTail = ''
    p.stderr!.on('data', (d) => { errTail = (errTail + d).slice(-3000) })
    readline.createInterface({ input: p.stdout! }).on('line', (line) => this.onLine(line))
    p.on('close', (code) => {
      if (this.proc !== p) return // un proceso viejo que se cerró después de relanzar
      this.proc = null
      if (this.busy) this.busy = false
      if (code && code !== 0) this.notice(`Claude terminó (código ${code}). ${errTail.trim().split('\n').slice(-3).join(' ')}`, 'error')
      this.state()
    })
    p.on('error', (e) => { this.notice('No se pudo iniciar Claude: ' + e.message, 'error'); this.proc = null; this.state() })
    this.state()
    return true
  }

  private write(obj: unknown) { try { this.proc?.stdin?.write(JSON.stringify(obj) + '\n') } catch { /* ignore */ } }

  send(text: string, images: Array<{ mediaType: string; data: string }> = [], files: string[] = []) {
    if (!this.proc && !this.start()) return
    const content: any[] = []
    for (const im of images) content.push({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })
    content.push({ type: 'text', text })
    this.push({ id: nid('u'), kind: 'user', text, images: images.length, files: files.length ? files : undefined })
    this.streamedText = false
    this.busy = true
    this.state()
    this.write({ type: 'user', message: { role: 'user', content } })
  }

  /** Resume la conversación para liberar contexto (el /compact de Claude Code). */
  compact(instructions?: string) {
    if (this.busy) return
    if (!this.proc && !this.start()) return
    this.compacting = true
    this.busy = true
    this.notice('Compactando la conversación: Claude la resume para liberar contexto…')
    this.state()
    this.write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '/compact' + (instructions?.trim() ? ' ' + instructions.trim() : '') }] } })
  }

  interrupt() {
    if (!this.proc) return
    this.write({ type: 'control_request', request_id: nid('int'), request: { subtype: 'interrupt' } })
  }

  /** Herramientas que el usuario aprobó "para toda la sesión" en este chat. */
  private alwaysAllow = new Set<string>()

  respondPermission(itemId: string, allow: boolean, always = false) {
    const it = this.items.find((x) => x.id === itemId)
    if (!it || !it.requestId) return
    if (allow && always && it.name) this.alwaysAllow.add(it.name)
    const req = this.pendingPerms.get(it.requestId)
    this.pendingPerms.delete(it.requestId)
    const response = allow ? { behavior: 'allow', updatedInput: req?.input ?? it.input ?? {} } : { behavior: 'deny', message: 'El usuario rechazó esta acción.' }
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: it.requestId, response } })
    this.patch(itemId, { status: allow ? (always ? 'permitido (toda la sesión)' : 'permitido') : 'rechazado' })
  }

  /**
   * Cambia opciones SIN cortar lo que Claude está haciendo:
   *  - permisos y modelo se aplican en caliente con control_request (set_permission_mode / set_model);
   *  - esfuerzo y modo ahorro necesitan relanzar el proceso: se hace cuando termina el turno
   *    (o ya, si está libre), retomando la misma conversación con --resume.
   */
  setOptions(patch: Partial<ChatOptions>, label: string) {
    const prev = { ...this.opts }
    Object.assign(this.opts, patch)
    if (this.proc) {
      const changed = (k: keyof ChatOptions) => k in patch && (patch as any)[k] !== (prev as any)[k]
      if (changed('permissionMode')) this.control({ subtype: 'set_permission_mode', mode: this.opts.permissionMode || 'default' })
      if (changed('model')) this.control(this.opts.model ? { subtype: 'set_model', model: this.opts.model } : { subtype: 'set_model' })
      if (changed('effort') || changed('saver') || changed('extraInstructions')) this.restartWhenIdle()
    }
    this.notice(label)
    this.state()
  }

  private ctlSeq = 0
  private pendingCtl = new Map<string, () => void>()
  /** Pedido de control a Claude Code; si no lo soporta, se cae al reinicio diferido. */
  private control(request: any) {
    const id = `oa-ctl-${++this.ctlSeq}`
    this.pendingCtl.set(id, () => this.restartWhenIdle())
    this.write({ type: 'control_request', request_id: id, request })
  }
  private restartPending = false
  private restartWhenIdle() {
    if (!this.proc) return
    if (this.busy) { this.restartPending = true; return }
    this.restartPending = false
    const resume = this.sessionId
    this.kill()
    this.opts.resume = resume
  }

  kill() { try { this.proc?.kill() } catch { /* ignore */ } this.proc = null; this.busy = false; this.state() }

  private onLine(line: string) {
    let m: any
    try { m = JSON.parse(line) } catch { return }
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          this.sessionId = m.session_id; this.model = m.model
          const oa = (m.mcp_servers || []).find((s: any) => s.name === 'openanimator')
          if (oa && oa.status !== 'connected') this.notice(`Herramientas de OpenAnimator: ${oa.status}`, 'warn')
          this.state()
        } else if (m.subtype === 'compact_boundary') {
          const pre = m.compact_metadata?.pre_tokens
          this.usage.compactions++
          this.usage.context = 0
          this.notice(`Conversación compactada${pre ? ` (tenía ${Math.round(pre / 1000)} mil tokens)` : ''}. Claude sigue con un resumen de lo hecho.`)
          this.state()
        }
        break
      case 'stream_event': this.onStream(m.event); break
      case 'assistant': this.onAssistant(m.message); break
      case 'user': this.onUser(m.message); break
      case 'result':
        this.busy = false
        this.blocks.clear()
        for (const u of Object.values<any>(m.modelUsage || {})) if (u?.contextWindow) this.usage.window = u.contextWindow
        if (typeof m.total_cost_usd === 'number') this.usage.cost = m.total_cost_usd
        if (this.compacting) {
          this.compacting = false
          if (m.is_error) this.notice('No se pudo compactar: ' + String(m.result || m.subtype || 'error'), 'error')
        } else {
          this.usage.turns++
          this.push({ id: nid('r'), kind: 'result', isError: !!m.is_error, cost: m.total_cost_usd, durationMs: m.duration_ms, text: m.is_error ? String(m.result || m.subtype || 'error') : '' })
        }
        this.state()
        if (this.restartPending) setTimeout(() => this.restartWhenIdle(), 50)
        break
      case 'control_response': {
        const r = m.response || {}
        const fb = this.pendingCtl.get(r.request_id)
        this.pendingCtl.delete(r.request_id)
        if (fb && r.subtype === 'error') fb()
        break
      }
      case 'control_request':
        if (m.request?.subtype === 'can_use_tool') {
          if (this.alwaysAllow.has(m.request.tool_name)) {
            this.write({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { behavior: 'allow', updatedInput: m.request.input ?? {} } } })
            break
          }
          this.pendingPerms.set(m.request_id, m.request)
          this.push({ id: nid('perm'), kind: 'permission', requestId: m.request_id, name: m.request.tool_name, input: m.request.input, status: 'pendiente' })
        } else {
          this.write({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'no soportado' } })
        }
        break
    }
  }

  private onStream(ev: any) {
    if (!ev) return
    if (ev.type === 'message_start') {
      this.blocks.clear()
      // Contexto ocupado = todo lo que se le mandó al modelo en este pedido.
      const u = ev.message?.usage
      if (u) { this.usage.context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); this.state() }
    } else if (ev.type === 'message_delta') {
      if (ev.usage?.output_tokens) this.usage.output += ev.usage.output_tokens
    } else if (ev.type === 'content_block_start') {
      const b = ev.content_block || {}
      if (b.type === 'text' || b.type === 'thinking' || b.type === 'redacted_thinking') {
        const think = b.type !== 'text'
        const it: ChatItem = { id: nid(think ? 'th' : 'a'), kind: think ? 'thinking' : 'assistant', text: b.text || b.thinking || '', status: 'streaming' }
        if (think) this.thinkStart.set(it.id, Date.now())
        this.blocks.set(ev.index, it.id)
        this.push(it)
      } else if (b.type === 'tool_use') {
        const it: ChatItem = { id: nid('tool'), kind: 'tool', name: b.name, input: {}, status: 'ejecutando' }
        this.toolItems.set(b.id, it.id)
        this.blocks.set(ev.index, it.id)
        this.push(it)
      }
    } else if (ev.type === 'content_block_delta') {
      const id = this.blocks.get(ev.index)
      if (!id) return
      const it = this.items.find((x) => x.id === id)
      if (!it) return
      const d = ev.delta || {}
      if (d.type === 'text_delta') { this.streamedText = true; this.patch(id, { text: (it.text || '') + d.text }) }
      else if (d.type === 'thinking_delta') this.patch(id, { text: (it.text || '') + d.thinking })
    } else if (ev.type === 'content_block_stop') {
      const id = this.blocks.get(ev.index)
      const it = id && this.items.find((x) => x.id === id)
      if (it && it.kind !== 'tool') {
        const t0 = this.thinkStart.get(it.id)
        this.thinkStart.delete(it.id)
        this.patch(it.id, { status: 'ok', ...(t0 ? { durationMs: Date.now() - t0 } : {}) })
      }
    }
  }

  private onAssistant(msg: any) {
    for (const b of msg?.content || []) {
      if (b.type === 'tool_use') {
        let id = this.toolItems.get(b.id)
        if (!id) { id = nid('tool'); this.toolItems.set(b.id, id); this.push({ id, kind: 'tool', name: b.name, input: b.input, status: 'ejecutando' }) }
        else this.patch(id, { input: b.input, name: b.name })
      } else if (b.type === 'text' && !this.streamedText && b.text) {
        this.push({ id: nid('a'), kind: 'assistant', text: b.text, status: 'ok' })
      }
    }
  }

  private onUser(msg: any) {
    for (const b of msg?.content || []) {
      if (b.type !== 'tool_result') continue
      const id = this.toolItems.get(b.tool_use_id)
      if (!id) continue
      let text = ''
      if (typeof b.content === 'string') text = b.content
      else if (Array.isArray(b.content)) text = b.content.map((c: any) => (c.type === 'text' ? c.text : c.type === 'image' ? '[imagen]' : '')).join('\n')
      this.patch(id, { status: b.is_error ? 'error' : 'ok', isError: !!b.is_error, result: text.slice(0, 4000) })
    }
  }
}

// ── historial: las conversaciones que Claude Code guarda para la carpeta del proyecto ──────────
export type SessionInfo = { id: string; title: string; first: string; updated: number; size: number }
const CTX_SUFFIX = /\n\n\(Contexto del editor:[\s\S]*$/

function sessionsDir(projectId: string): string | null {
  const dir = projectDir(projectId)
  if (!dir) return null
  const base = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects')
  const enc = dir.replace(/[^a-zA-Z0-9]/g, '-')
  if (fs.existsSync(path.join(base, enc))) return path.join(base, enc)
  // Rutas muy largas: Claude Code recorta el nombre y le agrega un hash.
  try { const d = fs.readdirSync(base).find((x) => x.startsWith(enc.slice(0, 180))); return d ? path.join(base, d) : null } catch { return null }
}
function readSlice(f: string, start: number, len: number) {
  const fd = fs.openSync(f, 'r')
  try { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, start); return b.subarray(0, n).toString('utf8') } finally { fs.closeSync(fd) }
}
const userText = (m: any): string => {
  const c = m?.message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
  return ''
}
const isRealPrompt = (m: any) => m.type === 'user' && !m.isMeta && !m.isSidechain && !!userText(m).trim() && !/^\s*<|^\[Request interrupted/.test(userText(m))

export function listSessions(projectId: string): SessionInfo[] {
  const dir = sessionsDir(projectId)
  if (!dir) return []
  const out: SessionInfo[] = []
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

/** Reconstruye lo que se ve en el chat a partir del archivo de la conversación. */
export function loadTranscript(projectId: string, sessionId: string): ChatItem[] {
  const dir = sessionsDir(projectId)
  const file = dir && path.join(dir, `${sessionId}.jsonl`)
  if (!file || !/^[\w-]+$/.test(sessionId) || !fs.existsSync(file)) return []
  const items: ChatItem[] = []
  const tools = new Map<string, ChatItem>()
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let m: any
    try { m = JSON.parse(line) } catch { continue }
    if (m.isSidechain) continue
    if (m.type === 'system' && m.subtype === 'compact_boundary') { items.push({ id: nid('n'), kind: 'notice', text: 'Conversación compactada.', level: 'info' }); continue }
    const c = m.message?.content
    if (m.type === 'user') {
      if (m.isMeta || m.isCompactSummary) continue
      if (Array.isArray(c)) for (const b of c) if (b.type === 'tool_result') {
        const it = tools.get(b.tool_use_id)
        if (!it) continue
        const txt = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x: any) => (x.type === 'text' ? x.text : x.type === 'image' ? '[imagen]' : '')).join('\n') : ''
        it.status = b.is_error ? 'error' : 'ok'; it.isError = !!b.is_error; it.result = txt.slice(0, 4000)
      }
      if (isRealPrompt(m)) {
        const imgs = Array.isArray(c) ? c.filter((b: any) => b.type === 'image').length : 0
        items.push({ id: nid('u'), kind: 'user', text: userText(m), images: imgs || undefined })
      } else if (/^\[Request interrupted/.test(userText(m))) items.push({ id: nid('n'), kind: 'notice', text: 'Interrumpido.', level: 'info' })
    } else if (m.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text' && b.text?.trim()) items.push({ id: nid('a'), kind: 'assistant', text: b.text, status: 'ok' })
        else if (b.type === 'tool_use') { const it: ChatItem = { id: nid('tool'), kind: 'tool', name: b.name, input: b.input, status: 'ok' }; tools.set(b.id, it); items.push(it) }
      }
    }
  }
  return items.slice(-400)
}
