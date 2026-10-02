/**
 * Chat con el Claude Code del usuario corriendo en Termux (con su plan de Claude). Es el mismo chat
 * que en la PC (el protocolo está en electron/claude-session.ts); cambia el transporte: en vez de un
 * proceso hijo, el puente de Termux (termux.ts). Mismas funciones que agent.ts, así index.ts elige.
 */
import { ClaudeStreamSession, sceneAgent, type ChatItem, type ChatOptions } from '../../../electron/claude-session'
import { send } from './events'
import { projectDir } from './projects'
import { buildSystem } from './prompt'
import { getSettings } from './settings'
import * as T from './termux'
import { TOOL_DEFS, toolDefs, toolKind } from './tools'
import { holdAwake } from './wake'

const MCP = 'mcp__openanimator__'
// Lo que sólo lee o renderiza no pide permiso (como en la PC).
const READONLY = TOOL_DEFS.filter((t) => t.kind === 'read').map((t) => MCP + t.name)
const mcpTools = () => toolDefs().map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }))

class TermuxChat extends ClaudeStreamSession {
  private running = false
  private ready = false
  private queue: unknown[] = []
  private proc = ''
  private gen = 0
  protected get alive() { return this.running }

  start() {
    const proc = `${this.id}-${++this.gen}`
    this.proc = proc
    this.running = true
    this.ready = false
    this.queue = []
    this.state()
    const o = this.opts
    ;(async () => {
      const system = await buildSystem(o.projectId, 'code', o.saver !== false, o.extraInstructions || '')
      await T.startProc(proc, o.projectId, { permissionMode: o.permissionMode, model: o.model, effort: o.effort, resume: o.resume, resumeAt: o.resumeAt, system, agents: sceneAgent(system), allowedTools: READONLY, tools: mcpTools() }, {
        out: (m) => { if (this.proc === proc) this.received(m) },
        exit: (code, err) => { if (this.proc === proc) { this.reset(); this.closed(code, err) } },
      })
      if (this.proc !== proc) return // se cerró mientras arrancaba
      this.ready = true
      for (const m of this.queue.splice(0)) T.sendProc(proc, m)
    })().catch((e) => {
      if (this.proc !== proc) return
      this.reset()
      this.busy = false
      this.notice(String(e?.message || e), 'error')
      this.state()
    })
    return true
  }

  private reset() { this.running = false; this.ready = false; this.queue = []; this.proc = '' }

  /** Retoma una conversación que siguió corriendo en Termux mientras Android reiniciaba la página. */
  adopt(r: T.Adoptable) {
    const proc = r.proc
    this.proc = proc
    this.running = true
    this.ready = true
    this.queue = []
    T.attachProc(proc, this.opts.projectId, {
      out: (m) => { if (this.proc === proc) this.received(m) },
      exit: (code, err) => { if (this.proc === proc) { this.reset(); this.closed(code, err) } },
    })
    this.replay(r.history || [])
    this.notice(r.busy
      ? 'Android reinició la app (seguramente por falta de memoria), pero Claude siguió trabajando en Termux: la conversación sigue acá.'
      : 'Android reinició la app (seguramente por falta de memoria): la conversación sigue acá.', 'info')
    this.busy = !!r.busy
    // Permisos que quedaron sin responder: se vuelven a mostrar (o se conceden solos, como siempre).
    for (const p of r.perms || []) this.onMessage(p)
    this.state()
  }

  protected writeLine(obj: unknown) {
    if (!this.running) return
    if (this.ready) { try { T.sendProc(this.proc, obj) } catch (e: any) { this.notice(e.message, 'error') } } else this.queue.push(obj)
  }

  protected terminate() {
    if (this.proc) T.killProc(this.proc)
    this.reset()
  }

  /** Pantalla encendida mientras Claude trabaja: si se apaga, Android pausa la página y el turno se frena. */
  private awake: (() => void) | null = null
  protected state() {
    super.state()
    const working = this.busy || this.tasks > 0 // también con subagentes en segundo plano
    if (working && !this.awake) this.awake = holdAwake()
    else if (!working && this.awake) { this.awake(); this.awake = null }
  }

  /** "Aceptar ediciones": como en la PC, escribir archivos del proyecto no pide permiso. */
  protected autoAllow(tool: string) {
    return this.opts.permissionMode === 'acceptEdits' && tool.startsWith(MCP) && toolKind(tool.slice(MCP.length)) === 'edit'
  }

  protected onMessage(m: any) {
    super.onMessage(m)
    if (m?.type === 'result' && m.is_error && /log ?in|\/login|auth|credential|api key/i.test(String(m.result || ''))) {
      this.notice('Claude Code no tiene la sesión iniciada en Termux. Andá a Ajustes › Claude › «Iniciar sesión en Claude».', 'warn')
    }
  }
}

// ── API para index.ts (las mismas funciones que agent.ts) ─────────────────────
const chats = new Map<string, TermuxChat>()

function options(projectId: string, resume?: string): ChatOptions {
  const c = getSettings().claude
  return { projectId, permissionMode: c.permissionMode || 'acceptEdits', model: c.model || undefined, effort: c.effort || undefined, extraInstructions: c.extraInstructions, resume, saver: c.saver !== false }
}

function snapshot(chat: TermuxChat) {
  const o = chat.opts
  return { id: chat.id, items: chat.items, busy: chat.busy, sessionId: chat.sessionId, options: { model: o.model || '', effort: o.effort || '', permissionMode: o.permissionMode }, stats: chat.stats(), model: chat.model, signalAt: chat.lastSignal || undefined, tasks: chat.tasks }
}

export async function createChat(projectId: string, o?: { resume?: string }) {
  if (!projectDir(projectId)) throw new Error('Proyecto no encontrado')
  const chat = new TermuxChat(options(projectId, o?.resume), (e) => send('chat:event', e))
  if (o?.resume) {
    // Retomar: se muestra lo que ya se habló (lo guarda Claude Code en Termux).
    try { chat.items = await T.request<ChatItem[]>('transcript', { project: projectId, session: o.resume }) } catch (e: any) { chat.notice(e.message, 'error') }
    chat.sessionId = o.resume
  }
  chats.set(chat.id, chat)
  return snapshot(chat)
}
export function getChat(id: string) { const c = chats.get(id); return c ? snapshot(c) : null }

/**
 * Tras un reinicio de la página: las conversaciones que siguen vivas en el puente se retoman (una por
 * proyecto: si hubiera más, queda la que está trabajando) y se avisan a index.ts para que el editor
 * las encuentre al volver al proyecto.
 */
export function enableAdoption(onAdopted: (id: string, projectId: string) => void) {
  T.setAdopter((list) => {
    const keep = new Map<string, T.Adoptable>()
    for (const r of list) {
      if (!r.project || !projectDir(r.project)) { T.killProc(r.proc); continue }
      const cur = keep.get(r.project)
      if (!cur || (r.busy && !cur.busy)) { if (cur) T.killProc(cur.proc); keep.set(r.project, r) } else T.killProc(r.proc)
    }
    for (const r of keep.values()) {
      const chat = new TermuxChat(options(r.project, r.sessionId || undefined), (e) => send('chat:event', e))
      if (r.sessionId) chat.sessionId = r.sessionId
      chat.adopt(r)
      chats.set(chat.id, chat)
      onAdopted(chat.id, r.project)
    }
  })
}
export async function listSessions(projectId: string) {
  try { return await T.request('sessions', { project: projectId }) } catch { return [] }
}
export function sendChat(id: string, text: string, images: Array<{ mediaType: string; data: string }>, files: string[]) { chats.get(id)?.send(String(text || ''), images || [], files || []) }
export function interruptChat(id: string) { chats.get(id)?.interrupt() }
export function unqueueChat(id: string, itemId?: string) { return chats.get(id)?.unqueue(itemId) || [] }
export function rewindChat(id: string, itemId: string) { return chats.get(id)?.rewind(itemId) ?? null }
export function retryChat(id: string) { return !!chats.get(id)?.retry() }
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

/** Prueba de conexión (Ajustes): puente, Claude Code y sesión del plan. */
export async function testClaude() {
  const st = await T.bridgeStatus()
  if (!st.claude) throw new Error('El puente anda, pero no encontré Claude Code en Termux: corré el comando de preparación.')
  if (st.claude.error && !st.claude.version) throw new Error('Claude Code no arranca en Termux: ' + st.claude.error)
  if (st.auth && !st.auth.loggedIn) throw new Error(`Claude Code ${st.claude.version || ''} está instalado pero sin sesión: tocá «Iniciar sesión en Claude».`)
  return `Conectado · ${st.claude.version || 'Claude Code'}${st.auth?.method ? ' · sesión iniciada' : ''}`
}
