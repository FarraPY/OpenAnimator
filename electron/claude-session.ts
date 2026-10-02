/**
 * Conversación con Claude Code (el CLI oficial del usuario, con su propia cuenta) por su protocolo
 * stream-json. Sin Node: la usan la PC (electron/claude.ts, que lanza `claude` como proceso hijo) y
 * la tablet (src/android/backend/code.ts, que lo corre en Termux a través de un puente).
 *
 * Un proceso por conversación (stdin abierto = misma sesión). Los permisos llegan como
 * `control_request` (can_use_tool) y se responden desde la interfaz.
 */

export type ChatItem = {
  id: string; kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'permission' | 'result' | 'notice'
  text?: string; name?: string; input?: any; status?: string; result?: string; isError?: boolean
  requestId?: string; images?: number; files?: string[]; cost?: number; durationMs?: number; level?: 'info' | 'warn' | 'error'
  /** Razonamiento: tokens estimados hasta ahora (aunque el texto no se muestre). */
  tokens?: number
  /** Razonamiento: cuándo empezó (así el tiempo sigue bien aunque la interfaz se vuelva a abrir). */
  at?: number
  /** Herramienta: caracteres de la entrada que ya llegaron mientras Claude la escribe (p. ej. un archivo largo). */
  streamed?: number
  /** Pedido escrito mientras Claude trabajaba: espera en la cola y sale solo cuando termina el turno. */
  queued?: boolean
}
/** Consumo de la conversación: contexto ocupado (tokens del último pedido al modelo) y ventana del modelo. */
export type ChatStats = { context: number; window: number; cost: number; turns: number; compactions: number; output: number }
export type ChatEvent = {
  session: string; type: 'item' | 'patch' | 'remove' | 'state'; item?: Partial<ChatItem> & { id: string }
  /** signalAt: la última vez que Claude Code mandó algo (si pasa mucho sin nada mientras piensa, puede estar trabado). */
  state?: { busy: boolean; alive: boolean; sessionId?: string; model?: string; effort?: string; permissionMode?: string; stats?: ChatStats; signalAt?: number }
}
export type ChatOptions = { projectId: string; permissionMode: string; model?: string; effort?: string; extraInstructions?: string; claudePath?: string; resume?: string; saver?: boolean }

let seq = 0
export const nid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`

export abstract class ClaudeStreamSession {
  id = nid('chat')
  items: ChatItem[] = []
  busy = false
  sessionId?: string
  model?: string
  private blocks = new Map<number, string>()       // índice de bloque → id de item (mensaje en curso)
  private toolItems = new Map<string, string>()     // tool_use_id → id de item
  private streamedText = false
  private pendingPerms = new Map<string, any>()
  private usage: ChatStats = { context: 0, window: 200000, cost: 0, turns: 0, compactions: 0, output: 0 }
  private compacting = false

  constructor(public opts: ChatOptions, protected emit: (e: ChatEvent) => void) {}

  /** Hay un Claude Code andando (o arrancando) para esta conversación. */
  protected abstract get alive(): boolean
  /** Arranca Claude Code; false si no se pudo (ya avisó con una nota en el chat). */
  abstract start(): boolean
  /** Un mensaje (una línea JSON) hacia la entrada de Claude Code. */
  protected abstract writeLine(obj: unknown): void
  /** Termina el proceso de Claude Code. */
  protected abstract terminate(): void
  /** Permisos que la plataforma concede sola (además de los "para toda la sesión"). */
  protected autoAllow(_tool: string, _input: any): boolean { return false }

  private push(it: ChatItem) { this.flushPatches(); this.items.push(it); if (this.items.length > 3000) this.items.shift(); this.emit({ session: this.id, type: 'item', item: it }) }
  private patch(id: string, p: Partial<ChatItem>) {
    this.flushPatches()
    const it = this.items.find((x) => x.id === id)
    if (it) Object.assign(it, p)
    this.emit({ session: this.id, type: 'patch', item: { id, ...p } })
  }
  // Lo que llega de a poquito (texto y razonamiento palabra por palabra, tokens estimados, la entrada de
  // una herramienta) se manda agrupado cada 100 ms: un evento por palabra ahogaba a la tablet.
  private pending = new Map<string, Partial<ChatItem>>()
  private pendingTimer: ReturnType<typeof setTimeout> | null = null
  private patchLater(id: string, p: Partial<ChatItem>) {
    const it = this.items.find((x) => x.id === id)
    if (it) Object.assign(it, p)
    this.pending.set(id, { ...(this.pending.get(id) || {}), ...p })
    if (!this.pendingTimer) this.pendingTimer = setTimeout(() => this.flushPatches(), 100)
  }
  private flushPatches() {
    if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null }
    if (!this.pending.size) return
    const all = [...this.pending]
    this.pending.clear()
    for (const [id, p] of all) this.emit({ session: this.id, type: 'patch', item: { id, ...p } })
  }
  private signalAt = 0
  private signalSent = 0
  /** La última vez que Claude Code mandó algo (para la foto de la conversación al volver a abrirla). */
  get lastSignal() { return this.signalAt }
  stats(): ChatStats { return { ...this.usage } }
  protected state() {
    this.signalSent = Date.now()
    this.emit({ session: this.id, type: 'state', state: { busy: this.busy, alive: this.alive, sessionId: this.sessionId, model: this.model, effort: this.opts.effort || '', permissionMode: this.opts.permissionMode, stats: this.stats(), signalAt: this.signalAt || undefined } })
  }
  notice(text: string, level: ChatItem['level'] = 'info') { this.push({ id: nid('n'), kind: 'notice', text, level }) }

  /** Claude Code terminó (código de salida y el final de lo que escribió en stderr). */
  protected closed(code: number | null, errTail: string) {
    if (this.busy) this.busy = false
    if (code && code !== 0) this.notice(`Claude terminó (código ${code}). ${errTail.trim().split('\n').slice(-3).join(' ')}`, 'error')
    // Lo próximo retoma esta conversación (si no, empezaba otra sin decirlo, con la anterior todavía en pantalla).
    if (this.sessionId) this.opts.resume = this.sessionId
    this.state()
    this.next()
  }

  /** Lo que se escribió mientras Claude trabajaba, en orden: sale cuando termina el turno (como en Claude Code). */
  private waiting: Array<{ id: string; content: any[] }> = []

  send(text: string, images: Array<{ mediaType: string; data: string }> = [], files: string[] = []) {
    if (!this.alive && !this.start()) return
    const content: any[] = []
    for (const im of images) content.push({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })
    content.push({ type: 'text', text })
    const it: ChatItem = { id: nid('u'), kind: 'user', text, images: images.length, files: files.length ? files : undefined }
    if (this.busy) { this.waiting.push({ id: it.id, content }); this.push({ ...it, queued: true }); return }
    this.push(it)
    this.deliver(content)
  }
  private deliver(content: any[]) {
    this.streamedText = false
    this.busy = true
    this.signalAt = Date.now()
    this.state()
    this.writeLine({ type: 'user', message: { role: 'user', content } })
  }
  /** El próximo de la cola, si Claude quedó libre. */
  private next() {
    if (this.busy || !this.waiting.length) return
    if (!this.alive && !this.start()) return
    const q = this.waiting.shift()!
    this.patch(q.id, { queued: false })
    this.deliver(q.content)
  }
  /** Saca de la cola uno (o todos, sin `itemId`) sin mandarlo; devuelve sus textos para volver a editarlos. */
  unqueue(itemId?: string) {
    const texts: string[] = []
    this.waiting = this.waiting.filter((q) => {
      if (itemId && q.id !== itemId) return true
      const i = this.items.findIndex((x) => x.id === q.id)
      if (i >= 0) { texts.push(this.items[i].text || ''); this.items.splice(i, 1) }
      this.emit({ session: this.id, type: 'remove', item: { id: q.id } })
      return false
    })
    return texts
  }

  /** Resume la conversación para liberar contexto (el /compact de Claude Code). */
  compact(instructions?: string) {
    if (this.busy) return
    if (!this.alive && !this.start()) return
    this.compacting = true
    this.busy = true
    this.signalAt = Date.now()
    this.notice('Compactando la conversación: Claude la resume para liberar contexto…')
    this.state()
    this.writeLine({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '/compact' + (instructions?.trim() ? ' ' + instructions.trim() : '') }] } })
  }

  interrupt() {
    if (!this.alive) return
    this.writeLine({ type: 'control_request', request_id: nid('int'), request: { subtype: 'interrupt' } })
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
    this.writeLine({ type: 'control_response', response: { subtype: 'success', request_id: it.requestId, response } })
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
    if (this.alive) {
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
    this.writeLine({ type: 'control_request', request_id: id, request })
  }
  private restartPending = false
  private restartWhenIdle() {
    if (!this.alive) return
    if (this.busy) { this.restartPending = true; return }
    this.restartPending = false
    const resume = this.sessionId
    this.kill()
    this.opts.resume = resume
  }

  kill() { this.terminate(); this.busy = false; this.state() }

  /**
   * Rearma la conversación con lo que guardó quien la transporta (el puente de Termux, al retomarla
   * después de que Android reinició la página): los pedidos del usuario llegan como `oa_user` y el resto
   * tal como lo mandó Claude Code. Los permisos pendientes van aparte (acá no se vuelven a pedir).
   */
  protected replay(history: any[]) {
    for (const m of history) {
      if (m?.type === 'oa_user') { this.push({ id: nid('u'), kind: 'user', text: String(m.text || ''), images: m.images || 0 }); this.streamedText = false; continue }
      if (m?.type === 'control_request') continue
      this.onMessage(m)
    }
  }

  /** Una línea de la salida de Claude Code. */
  protected onLine(line: string) {
    let m: any
    try { m = JSON.parse(line) } catch { return }
    this.received(m)
  }

  /**
   * Un mensaje que Claude Code acaba de mandar (en la PC llega como línea; el puente de Termux ya lo manda
   * leído). Además de procesarlo es una señal de vida: mientras trabaja, la interfaz se entera cada tanto
   * y, si dejan de llegar, avisa que puede estar trabado.
   */
  protected received(m: any) {
    this.signalAt = Date.now()
    this.onMessage(m)
    if (this.busy && Date.now() - this.signalSent > 5000) this.state()
  }

  /** Un mensaje de la salida de Claude Code (ya leído). */
  protected onMessage(m: any) {
    switch (m?.type) {
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
        if (this.restartPending) setTimeout(() => { this.restartWhenIdle(); this.next() }, 50)
        else this.next()
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
          if (this.alwaysAllow.has(m.request.tool_name) || this.autoAllow(m.request.tool_name, m.request.input)) {
            this.writeLine({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { behavior: 'allow', updatedInput: m.request.input ?? {} } } })
            break
          }
          this.pendingPerms.set(m.request_id, m.request)
          this.push({ id: nid('perm'), kind: 'permission', requestId: m.request_id, name: m.request.tool_name, input: m.request.input, status: 'pendiente' })
        } else {
          this.writeLine({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'no soportado' } })
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
        const it: ChatItem = { id: nid(think ? 'th' : 'a'), kind: think ? 'thinking' : 'assistant', text: b.text || b.thinking || '', status: 'streaming', ...(think ? { at: Date.now() } : {}) }
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
      if (d.type === 'text_delta') { this.streamedText = true; this.patchLater(id, { text: (it.text || '') + d.text }) }
      else if (d.type === 'thinking_delta') {
        // Con el razonamiento oculto llega sólo la cantidad estimada de tokens; con texto, se estima por su largo.
        const text = typeof d.thinking === 'string' ? d.thinking : ''
        const tokens = (it.tokens || 0) + (typeof d.estimated_tokens === 'number' ? d.estimated_tokens : Math.ceil(text.length / 4))
        this.patchLater(id, text ? { text: (it.text || '') + text, tokens } : { tokens })
      } else if (d.type === 'input_json_delta' && it.kind === 'tool') this.patchLater(id, { streamed: (it.streamed || 0) + String(d.partial_json || '').length })
    } else if (ev.type === 'content_block_stop') {
      const id = this.blocks.get(ev.index)
      const it = id && this.items.find((x) => x.id === id)
      // La entrada de la herramienta ya llegó entera: ahora se ejecuta (streamed 0 = ya no se está escribiendo).
      if (it && it.kind === 'tool' && it.streamed) this.patch(it.id, { streamed: 0 })
      if (it && it.kind !== 'tool') this.patch(it.id, { status: 'ok', ...(it.at ? { durationMs: Date.now() - it.at } : {}) })
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
