import { ClipboardEvent as RClipboardEvent, DragEvent as RDragEvent, Fragment, KeyboardEvent as RKeyboardEvent, memo, ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { afterPaint, Attachment, call, ChatEvent, ChatItem, ChatStats, EFFORTS, fileUrl, fmtSize, MODELS, modelName, on } from '../api'
import { isAndroid } from '../platform'
import { useApp } from '../App'
import { Icon, IconName } from '../ui/icons'
import { Button, Empty, Select, Spinner, TextInput, useMenu } from '../ui/kit'
import { useDialogs } from './Dialogs'
import Modal from './Modal'

const QUICK: Array<{ icon: IconName; text: string }> = [
  { icon: 'grid', text: 'Revisá todo el video con la hoja de contactos y mejorá lo que se vea flojo o repetitivo.' },
  { icon: 'scan', text: 'Hacé una auditoría de layout y corregí todo lo que se superponga o salga de cuadro.' },
  { icon: 'message', text: 'Resolvé las notas que dejé en el timeline.' },
  { icon: 'wand', text: 'Creá un video a partir de este guion: ' },
]
const PERMS = [
  { value: 'default', label: 'Preguntar todo', desc: 'Pide permiso para cada edición y comando', icon: 'shield' as IconName },
  { value: 'acceptEdits', label: 'Aceptar ediciones', desc: 'Edita archivos del proyecto sin preguntar', icon: 'edit' as IconName },
  { value: 'plan', label: 'Planificar', desc: 'Propone un plan sin tocar nada', icon: 'list' as IconName },
  { value: 'bypassPermissions', label: 'Sin preguntar', desc: 'Hace todo sin pedir permiso', icon: 'zap' as IconName },
]
type Ctx = { timeline: string; t: number }
type ProjFile = { path: string; size: number; dir: boolean }

function toolMeta(it: ChatItem): { icon: IconName; name: string; arg: string } {
  const raw = it.name || ''
  const i = it.input || {}
  const oa = raw.replace(/^mcp__openanimator__/, '')
  const OA: Record<string, [IconName, string]> = {
    oa_ver_fotogramas: ['camera', 'Ver fotogramas'], oa_hoja_contactos: ['grid', 'Hoja de contactos'], oa_auditar_layout: ['scan', 'Auditar layout'],
    oa_proyecto: ['layers', 'Leer proyecto'], oa_medios: ['film', 'Listar medios'], oa_info_medio: ['info', 'Info de medio'], oa_resolver_nota: ['check', 'Resolver nota'],
    oa_plugins: ['plug', 'Ver plugins'], oa_generar_imagen: ['image', 'Generar imagen'], oa_generar_voz: ['mic', 'Generar voz'], oa_voces: ['mic', 'Ver voces'],
    oa_generar_sfx: ['wave', 'Generar efecto'], oa_transcribir: ['story', 'Transcribir'], oa_consultar_ia: ['message', 'Consultar a otra IA'],
  }
  const STD: Record<string, [IconName, string]> = {
    Read: ['file', 'Leer'], Write: ['edit', 'Escribir'], Edit: ['edit', 'Editar'], MultiEdit: ['edit', 'Editar'], Bash: ['terminal', 'Terminal'], PowerShell: ['terminal', 'PowerShell'],
    Glob: ['search', 'Buscar archivos'], Grep: ['search', 'Buscar texto'], WebFetch: ['external', 'Leer web'], WebSearch: ['search', 'Buscar en la web'],
    TodoWrite: ['list', 'Tareas'], Task: ['bot', 'Subagente'], Agent: ['bot', 'Subagente'], ToolSearch: ['search', 'Cargar herramientas'], Skill: ['wand', 'Skill'],
  }
  // En la tablet con Termux, los archivos del proyecto también llegan por el MCP de OpenAnimator.
  const m = OA[oa] || STD[raw] || STD[oa] || ['wand', raw.replace(/^mcp__/, '').replace(/__/g, ' · ')]
  const arg = i.file_path || i.path || i.command || i.pattern || i.skill || i.description || i.query || i.prompt || i.texto || i.descripcion || i.consulta || (i.times ? `t = ${i.times.join(', ')} s` : '') || (i.count ? `${i.count} cuadros` : '') || ''
  return { icon: m[0], name: m[1], arg: String(arg).replace(/\\/g, '/').split('/').slice(-3).join('/').slice(0, 120) }
}

// ── Markdown mínimo y seguro (sin HTML) ────────────────────────────────────────
function inline(s: string, k = 0): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:[^)\s]+)\))/g
  let last = 0, m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index))
    const x = m[0]
    if (m[1]) out.push(<code key={k++}>{x.slice(1, -1)}</code>)
    else if (m[2]) out.push(<strong key={k++}>{x.slice(2, -2)}</strong>)
    else if (m[3]) out.push(<em key={k++}>{x.slice(1, -1)}</em>)
    else if (m[4]) { const url = m[5]; out.push(<a key={k++} href="#" onClick={(e) => { e.preventDefault(); call('shell:openExternal', url) }}>{x.slice(1, x.indexOf(']'))}</a>) }
    last = m.index + x.length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n')
  const blocks: ReactNode[] = []
  let i = 0, k = 0
  while (i < lines.length) {
    const l = lines[i]
    if (/^```/.test(l)) {
      const buf: string[] = []; i++
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++])
      i++; blocks.push(<pre key={k++}><code>{buf.join('\n')}</code></pre>); continue
    }
    const h = /^(#{1,4})\s+(.*)/.exec(l)
    if (h) { const T = (`h${Math.min(4, h[1].length + 1)}`) as any; blocks.push(<T key={k++}>{inline(h[2])}</T>); i++; continue }
    if (/^\s*[-*•]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l)) {
      const ordered = /^\s*\d+[.)]\s+/.test(l)
      const items: string[] = []
      while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*•]\s+/).test(lines[i])) items.push(lines[i++].replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''))
      const L = ordered ? 'ol' : 'ul'
      blocks.push(<L key={k++}>{items.map((x, j) => <li key={j}>{inline(x)}</li>)}</L>); continue
    }
    if (/^>\s?/.test(l)) {
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''))
      blocks.push(<blockquote key={k++}>{inline(buf.join(' '))}</blockquote>); continue
    }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i++].trim().slice(1, -1).split('|').map((c) => c.trim())
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells)
      }
      blocks.push(<div key={k++} className="md-table"><table><tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, ci) => ri === 0 ? <th key={ci}>{inline(c)}</th> : <td key={ci}>{inline(c)}</td>)}</tr>)}</tbody></table></div>); continue
    }
    if (!l.trim()) { i++; continue }
    const buf: string[] = []
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|>\s?|\s*[-*•]\s+|\s*\d+[.)]\s+|\s*\|)/.test(lines[i])) buf.push(lines[i++])
    blocks.push(<p key={k++}>{buf.map((x, j) => <Fragment key={j}>{j > 0 && <br />}{inline(x)}</Fragment>)}</p>)
  }
  return <div className="md">{blocks}</div>
}

function EffortBars({ n }: { n: number }) {
  return <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true" style={{ flex: 'none' }}>{[0, 1, 2, 3, 4].map((i) => <rect key={i} x={i * 3} y={10 - i * 2.2} width="2" height={2 + i * 2.2} rx=".6" fill="currentColor" opacity={n === 0 ? .35 : i < n ? 1 : .22} />)}</svg>
}

/** Segundos transcurridos desde `since`, actualizados cada segundo. */
const dur = (s: number) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`)
function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0)
  useEffect(() => { const i = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(i) }, [])
  return <span className="tabnum">{dur(Math.max(0, Math.round((Date.now() - since) / 1000)))}</span>
}

/** Aviso si Claude Code deja de mandar señales mientras el modelo trabaja (no mientras corre una herramienta). */
function Stall({ at }: { at: number }) {
  const [, tick] = useState(0)
  useEffect(() => { const i = setInterval(() => tick((x) => x + 1), 5000); return () => clearInterval(i) }, [])
  const s = Math.round((Date.now() - at) / 1000)
  if (s < 150) return null
  return <div className="notice warn"><Icon name="alert" size={14} />Claude no manda señales hace {dur(s)}: puede haberse trabado. Si no avanza, tocá Detener y pedile que siga.</div>
}

const kShort = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`)
/** Nivel de alerta: lo que importa para el límite de uso es cuántos tokens se reenvían en cada mensaje. */
const ctxLevel = (tokens: number, pct: number) => (tokens >= 250000 || pct >= 80 ? 2 : tokens >= 140000 || pct >= 60 ? 1 : 0)
const kTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} M` : n >= 1000 ? `${Math.round(n / 1000)} mil` : String(n))
const kSize = (chars: number) => (chars >= 1024 ? `${(chars / 1024).toFixed(chars >= 10240 ? 0 : 1).replace('.', ',')} KB` : `${chars} B`)

/** Anillo con el porcentaje de la ventana de contexto que ocupa la conversación. */
function ContextRing({ pct, level }: { pct: number; level: number }) {
  const r = 6.5, c = 2 * Math.PI * r
  const tone = level === 2 ? 'var(--err)' : level === 1 ? 'var(--warn)' : 'var(--ok)'
  return (
    <svg width="17" height="17" viewBox="0 0 17 17" style={{ flex: 'none' }}>
      <circle cx="8.5" cy="8.5" r={r} fill="none" stroke="var(--line-2)" strokeWidth="2.2" />
      <circle cx="8.5" cy="8.5" r={r} fill="none" stroke={tone} strokeWidth="2.2" strokeDasharray={`${(c * Math.max(4, Math.min(100, pct))) / 100} ${c}`} strokeLinecap="round" transform="rotate(-90 8.5 8.5)" />
    </svg>
  )
}

/**
 * Un mensaje del chat. Memoizado: mientras Claude escribe sólo cambia el último, y re-dibujar (y volver a
 * leer el markdown de) toda la conversación con cada palabra trababa la tablet en conversaciones largas.
 */
const ChatRow = memo(function ChatRow({ it, session, projectId, showThinking, showCost, since }: {
  it: ChatItem; session: string | null; projectId: string; showThinking: boolean; showCost: boolean; since?: number
}) {
  if (it.kind === 'user') return (
    <div key={it.id} className="msg-user">{it.text?.replace(/\n\n\(Contexto del editor:[\s\S]*$/, '').split(/((?:^|\s)@[^\s@]+)/).map((part, i) => /^\s?@/.test(part) ? <Fragment key={i}>{part.startsWith(' ') ? ' ' : ''}<span className="mention">{part.trim()}</span></Fragment> : part)}
      {it.files?.length || it.images ? <div className="att-row">
        {it.files?.map((f) => <span key={f} className="att"><Icon name={/\.(png|jpe?g|webp|gif)$/i.test(f) ? 'image' : 'file'} size={12} />{f.split('/').pop()}</span>)}
        {(it.images || 0) > (it.files?.filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f)).length || 0) && <span className="att"><Icon name="camera" size={12} />fotograma</span>}
      </div> : null}</div>
  )
  if (it.kind === 'assistant') return it.text ? (
    <div key={it.id} className="msg-ai"><span className="msg-ai-avatar"><Icon name="sparkles" size={13} stroke={2} /></span><div className="msg-ai-body"><Markdown text={it.text} /></div></div>
  ) : null
  if (it.kind === 'thinking') {
    // Los tokens estimados muestran que sigue razonando aunque el texto del razonamiento no llegue.
    const tok = it.tokens ? <span className="t3 tabnum" data-tip="Tokens de razonamiento estimados">· {kTok(it.tokens)} tokens</span> : null
    if (it.status === 'streaming') return (
      <div key={it.id} className="think live"><span className="think-dot" /><span>Pensando…</span><Elapsed since={it.at || since || Date.now()} />{tok}
        {showThinking && it.text ? <div className="think-text">{it.text.slice(-500)}</div> : null}</div>
    )
    const secs = it.durationMs ? Math.max(1, Math.round(it.durationMs / 1000)) : null
    if (showThinking && it.text) return <details key={it.id} className="think"><summary><Icon name="brain" size={12} />Razonamiento{secs ? ` · ${dur(secs)}` : ''}{it.tokens ? ` · ${kTok(it.tokens)} tokens` : ''}<Icon name="chevron-down" size={11} /></summary><div className="think-text full">{it.text}</div></details>
    return secs && secs >= 2 ? <div key={it.id} className="think done"><Icon name="brain" size={12} />Pensó {dur(secs)}{it.tokens ? ` · ${kTok(it.tokens)} tokens` : ''}</div> : null
  }
  if (it.kind === 'notice') return <div key={it.id} className={`notice ${it.level || ''}`}><Icon name={it.level === 'error' ? 'x-circle' : it.level === 'warn' ? 'alert' : 'info'} size={14} />{it.text}</div>
  if (it.kind === 'result') return it.isError
    ? <div key={it.id} className="notice error"><Icon name="x-circle" size={14} />{it.text}</div>
    : showCost ? <div key={it.id} className="turn-meta"><span className="row" style={{ gap: 4 }}><Icon name="check" size={11} />listo</span>{it.durationMs ? <span>{(it.durationMs / 1000).toFixed(0)} s</span> : null}{it.cost ? <span>US$ {it.cost.toFixed(3)}</span> : null}</div> : null
  if (it.kind === 'tool') {
    const m = toolMeta(it)
    const media = !it.isError && it.result ? /guardad[oa] en (assets\/\S+?\.(png|jpe?g|webp|mp3|wav))/i.exec(it.result) : null
    return (
      <Fragment key={it.id}>
        <details className="tool-card">
          <summary>
            <span className="tool-state">{it.status === 'ejecutando' ? <Spinner size={12} /> : <Icon name={it.isError ? 'x-circle' : 'check-circle'} size={13} style={{ color: it.isError ? 'var(--err)' : 'var(--ok)' }} />}</span>
            <Icon name={m.icon} size={13} /><b>{m.name}</b>
            <span className="t3 ellipsis grow mono" style={{ fontSize: 11 }}>{m.arg || (it.status === 'ejecutando' && it.streamed ? `escribiendo… ${kSize(it.streamed)}` : '')}</span><Icon name="chevron-down" size={12} />
          </summary>
          <pre>{JSON.stringify(it.input, null, 1)?.slice(0, 3000)}{it.result ? '\n\n→ ' + String(it.result).slice(0, 4000) : ''}</pre>
        </details>
        {media && (/\.(mp3|wav)$/i.test(media[1])
          ? <div className="gen-media"><Icon name={/sfx/.test(media[1]) ? 'wave' : 'mic'} size={14} /><span className="mono ellipsis">{media[1].split('/').pop()}</span><audio controls src={fileUrl(projectId, media[1])} /></div>
          : <div className="gen-media img"><img src={fileUrl(projectId, media[1])} alt="" onClick={() => call('project:reveal', projectId, media[1])} data-tip="Mostrar en la carpeta" /><span className="mono ellipsis">{media[1]}</span></div>)}
      </Fragment>
    )
  }
  if (it.kind === 'permission') {
    const m = toolMeta(it)
    return (
      <div key={it.id} className="perm-card">
        <div className="t"><Icon name="shield" size={15} /><div className="grow">Claude quiere usar <b>{m.name}</b>{it.input?.description ? <div className="t3" style={{ fontSize: 12 }}>{it.input.description}</div> : null}</div></div>
        {m.arg && <div className="perm-cmd">{it.input?.command || m.arg}</div>}
        {it.status === 'pendiente'
          ? <div className="row" style={{ gap: 6 }}>
            <Button size="sm" variant="primary" icon="check" onClick={() => call('chat:permission', session, it.id, true)}>Permitir</Button>
            <Button size="sm" tip="No volver a preguntar por esta herramienta en este chat" onClick={() => call('chat:permission', session, it.id, true, true)}>Permitir siempre</Button>
            <div className="grow" />
            <Button size="sm" variant="ghost" onClick={() => call('chat:permission', session, it.id, false)}>Rechazar</Button>
          </div>
          : <span className="t3 row" style={{ gap: 5, fontSize: 12 }}><Icon name={it.status === 'rechazado' ? 'x' : 'check'} size={12} />{it.status}</span>}
      </div>
    )
  }
  return null
        
})

/** assistant: respuestas terminadas de la conversación `session` (el editor cuenta las que no se vieron). */
export type ChatStatus = { busy: boolean; waiting: boolean; assistant: number; session: string | null }
export default function ChatPanel({ projectId, context, visible, windowMode, attachTo, onStatus, inject }: {
  projectId: string; context: () => Ctx | Promise<Ctx>; visible: boolean
  /** Ventana separada: se conecta a la conversación `attachTo` y no la cierra al salir. */
  windowMode?: boolean; attachTo?: string
  /** Estado para mostrar afuera (pestaña de Claude en la tablet): trabajando, esperando permiso, respuestas. */
  onStatus?: (s: ChatStatus) => void
  /** Texto para poner en el cuadro de mensaje desde afuera (acciones rápidas). */
  inject?: { text: string; n: number } | null
}) {
  const android = isAndroid()
  const { toast, info, settings, go, updateSettings } = useApp()
  const dlg = useDialogs()
  const [session, setSession] = useState<string | null>(null)
  const [items, setItems] = useState<ChatItem[]>([])
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [attach, setAttach] = useState<{ t: number; data: string } | null>(null)
  const [files, setFiles] = useState<Attachment[]>([])
  const [drag, setDrag] = useState(false)
  const [stats, setStats] = useState<ChatStats | null>(null)
  const [claudeSession, setClaudeSession] = useState<string | undefined>()
  const [popped, setPopped] = useState(false)
  const [gone, setGone] = useState(false)
  const [history, setHistory] = useState(false)
  const attMenu = useMenu()
  const ctxMenu = useMenu()
  const [opts, setOpts] = useState({ model: '', effort: '', permissionMode: 'acceptEdits' })
  const [liveModel, setLiveModel] = useState<string | undefined>()
  const [busySince, setBusySince] = useState(0)
  const [signalAt, setSignalAt] = useState(0) // última señal de Claude Code (sólo con Claude Code)
  const seen = useRef(new Map<string, number>())
  const list = useRef<HTMLDivElement>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  const sid = useRef<string | null>(null)
  const showThinking = settings?.claude.showThinking !== false
  const showCost = settings?.claude.showCost !== false
  const saver = settings?.claude.saver !== false

  const load = (r: any) => {
    sid.current = r.id; setSession(r.id); setItems(r.items); setBusy(!!r.busy); setOpts(r.options); setStats(r.stats || null)
    setLiveModel(r.model); setGone(false); setClaudeSession(r.sessionId); setSignalAt(r.signalAt || 0)
    for (const it of r.items as ChatItem[]) seen.current.set(it.id, Date.now())
  }
  const start = async (resume?: string) => load(await call('chat:create', projectId, resume ? { resume } : undefined))
  const reattach = async (id: string) => { const r = await call('chat:get', id); if (r) load(r); else setGone(true) }
  // Al volver al proyecto (desde Ajustes o el inicio) se retoma la conversación que quedó abierta; si no
  // hay (se cerró la app o pasó mucho), la última del historial del proyecto, salvo que se pida empezar de cero.
  const resumeOrStart = async () => {
    const open = await call('chat:forProject', projectId).catch(() => null)
    if (open) { load(open); return }
    const s = settings || await call<any>('settings:get').catch(() => null)
    if (s?.claude?.continueChat !== false) {
      const last = (await call<Array<{ id: string }>>('chat:sessions', projectId).catch(() => []))[0]
      if (last?.id) { try { await start(last.id); return } catch { /* no se pudo retomar: una nueva */ } }
    }
    await start()
  }
  const busyRef = useRef(false)
  busyRef.current = busy

  useEffect(() => {
    // Después de pintar: retomar la conversación y dibujarla (puede ser larga) no demora la apertura del proyecto.
    const cancel = afterPaint(() => { if (windowMode && attachTo) reattach(attachTo); else resumeOrStart() })
    const off = on('chat:event', (e: ChatEvent) => {
      if (e.session !== sid.current) return
      if (e.type === 'item') { seen.current.set(e.item!.id, Date.now()); setItems((xs) => [...xs, e.item as ChatItem]) }
      else if (e.type === 'patch') setItems((xs) => xs.map((x) => (x.id === e.item!.id ? { ...x, ...e.item } : x)))
      else if (e.type === 'state') {
        setBusy(!!e.state?.busy)
        if (e.state?.model) setLiveModel(e.state.model)
        if (e.state?.stats) setStats(e.state.stats)
        if (e.state?.sessionId) setClaudeSession(e.state.sessionId)
        if (e.state?.signalAt) setSignalAt(e.state.signalAt)
      }
    })
    const offPop = on('chat:popout', (e: { projectId: string; open: boolean }) => {
      if (e.projectId !== projectId || windowMode) return
      setPopped(e.open)
      if (!e.open && sid.current) reattach(sid.current)
    })
    if (!windowMode) call<boolean>('chat:isPopped', projectId).then(setPopped).catch(() => {})
    return () => {
      cancel(); off(); offPop()
      if (windowMode || !sid.current) return
      // Salir del editor no corta a Claude: la conversación sigue y se retoma al volver al proyecto.
      call('chat:leave', sid.current); call('chat:popin', projectId)
      if (busyRef.current) toast('Claude sigue trabajando en este proyecto: al volver lo ves donde va')
    }
  }, [projectId])

  // Mientras el chat está en otra ventana, el editor le informa dónde está el cursor.
  useEffect(() => {
    if (windowMode || !popped) return
    const push = async () => { try { call('chat:setCtx', projectId, await context()) } catch { /* ignore */ } }
    push(); const i = setInterval(push, 800); return () => clearInterval(i)
  }, [popped, windowMode, projectId])

  useEffect(() => { if (busy) setBusySince(Date.now()) }, [busy])
  const lastStatus = useRef('')
  useEffect(() => {
    if (!onStatus) return
    const st: ChatStatus = { busy, waiting: items.some((x) => x.kind === 'permission' && x.status === 'pendiente'), assistant: items.filter((x) => x.kind === 'assistant' && !!x.text && x.status !== 'streaming').length, session }
    const k = JSON.stringify(st)
    if (k !== lastStatus.current) { lastStatus.current = k; onStatus(st) }
  }, [busy, items, session])
  useEffect(() => { if (inject?.text) { setText(inject.text); setTimeout(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) } }, 60) } }, [inject?.n])
  // ── ir al último mensaje ──
  // La lista sigue al último mensaje (stick) salvo que el usuario haya subido. Oculta (la otra pestaña en la tablet,
  // otro panel en la PC) el navegador ignora el scroll: se aplica al mostrarla. Si no, una conversación que se
  // cargó con el chat oculto (al volver al proyecto) aparecía desde el principio.
  const [away, setAway] = useState(false)
  const [unread, setUnread] = useState(0)
  const seenCount = useRef(0)
  const stick = useRef(true)
  const onListScroll = () => {
    const el = list.current
    if (!el || !el.clientHeight) return
    const far = el.scrollHeight - el.scrollTop - el.clientHeight > 260
    stick.current = !far
    setAway(far)
    if (!far) setUnread(0)
  }
  const toBottom = (smooth = true) => {
    stick.current = true
    const el = list.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    setUnread(0); setAway(false)
  }
  useEffect(() => {
    const el = list.current
    const fresh = items.slice(seenCount.current).filter((x) => x.kind === 'assistant' || x.kind === 'permission').length
    seenCount.current = items.length
    if (!el) return
    if (stick.current) el.scrollTop = el.scrollHeight
    else if (fresh) setUnread((n) => n + fresh)
  }, [items, busy])
  useEffect(() => { seenCount.current = 0; setUnread(0); stick.current = true; requestAnimationFrame(() => toBottom(false)) }, [session])
  const listShown = !(info && !info.claude) && !(popped && !windowMode) && !gone // si no, en su lugar va un aviso
  useLayoutEffect(() => { const el = list.current; if (visible && el && stick.current) el.scrollTop = el.scrollHeight }, [visible, listShown])
  // Las imágenes que cargan después agrandan la lista: si iba abajo, sigue abajo ('load' no burbujea: se toma al bajar).
  useEffect(() => {
    const el = list.current
    if (!el) return
    const f = () => { if (stick.current && el.clientHeight) el.scrollTop = el.scrollHeight }
    el.addEventListener('load', f, true)
    return () => el.removeEventListener('load', f, true)
  }, [listShown])
  useEffect(() => { const el = ta.current; if (el) { el.style.height = 'auto'; el.style.height = Math.min(220, el.scrollHeight) + 'px' } }, [text])
  useEffect(() => { if (visible && !popped && !android) setTimeout(() => ta.current?.focus(), 50) }, [visible, popped])

  // ── @ menciones de archivos del proyecto ─────────────────────────────────────
  const [projFiles, setProjFiles] = useState<ProjFile[] | null>(null)
  const [mention, setMention] = useState<{ q: string; at: number } | null>(null)
  const [mIdx, setMIdx] = useState(0)
  const loadFiles = () => call<ProjFile[]>('project:files', projectId).then(setProjFiles).catch(() => setProjFiles([]))
  const matches = useMemo(() => {
    if (!mention || !projFiles) return []
    const q = mention.q.toLowerCase()
    const score = (f: ProjFile) => { const p = f.path.toLowerCase(), n = p.split('/').pop()!; return n.startsWith(q) ? 0 : n.includes(q) ? 1 : p.includes(q) ? 2 : 9 }
    return projFiles.filter((f) => score(f) < 9).sort((a, b) => score(a) - score(b) || a.path.length - b.path.length).slice(0, 9)
  }, [mention, projFiles])
  const onTextChange = (v: string, caret: number) => {
    setText(v)
    const m = /(^|\s)@([^\s@]*)$/.exec(v.slice(0, caret))
    if (m) { if (!projFiles) loadFiles(); setMention({ q: m[2], at: caret - m[2].length - 1 }); setMIdx(0) } else setMention(null)
  }
  const pickMention = (f: ProjFile) => {
    if (!mention) return
    const end = mention.at + 1 + mention.q.length
    const ins = `@${f.path}${f.dir ? '/' : ''} `
    const v = text.slice(0, mention.at) + ins + text.slice(end)
    setText(v); setMention(null)
    requestAnimationFrame(() => { const el = ta.current; if (el) { el.focus(); const c = mention.at + ins.length; el.setSelectionRange(c, c) } })
  }
  const mentioned = (msg: string) => {
    const known = new Set((projFiles || []).map((f) => f.path))
    return [...new Set([...msg.matchAll(/(?:^|\s)@([^\s@]+)/g)].map((m) => m[1].replace(/\/$/, '')).filter((p) => known.has(p)))]
  }

  const setOption = (patch: Partial<typeof opts> & { saver?: boolean }, label: string) => {
    // Permisos y modelo se aplican en caliente; esfuerzo y modo ahorro esperan a que Claude termine lo que está haciendo.
    const live = 'permissionMode' in patch || (!android && 'model' in patch)
    label = label.replace(/ \(se aplica al próximo mensaje\)\.?$/, '') + (live ? (busy ? ' (desde el próximo paso, sin interrumpir).' : '.') : busy ? ' (se aplica cuando Claude termine lo que está haciendo).' : ' (se aplica al próximo mensaje).')
    const { saver: sv, ...rest } = patch
    setOpts((o) => ({ ...o, ...rest }))
    if (sv !== undefined) updateSettings({ claude: { saver: sv } })
    if (session) call('chat:setOptions', session, patch, label)
  }
  const send = async () => {
    const msg = text.trim() || (files.length ? 'Mirá los archivos adjuntos.' : '')
    if (!msg || !session) return
    let ctx: Ctx = { timeline: 'main', t: 0 }
    try { ctx = (await context()) || ctx } catch { /* sin contexto */ }
    let att = attach
    if (!att && settings?.claude.autoAttachFrame) { try { att = { t: ctx.t, data: await call('frames:png', projectId, ctx.timeline, ctx.t, 1280) } } catch { /* sin imagen */ } }
    const ment = mentioned(msg)
    const fl = files.length ? ` Archivos adjuntos (copiados en la carpeta del proyecto; leelos con Read): ${files.map((f) => f.rel).join(', ')}.${files.some((f) => f.image) ? ' Las imágenes adjuntas también van en este mensaje.' : ''}` : ''
    const ml = ment.length ? ` Archivos del proyecto que menciona el usuario con @ (rutas relativas a la carpeta del proyecto): ${ment.join(', ')}.` : ''
    const full = `${msg}\n\n(Contexto del editor: timeline activo "${ctx.timeline}", cursor en ${ctx.t.toFixed(2)} s.${att ? ` La primera imagen adjunta es el fotograma en t=${att.t.toFixed(2)} s.` : ''}${fl}${ml})`
    const images = [...(att ? [{ mediaType: 'image/png', data: att.data }] : []), ...files.filter((f) => f.image).slice(0, 8).map((f) => ({ mediaType: 'image/jpeg', data: f.image! }))]
    setText(''); setAttach(null); setFiles([]); setMention(null)
    toBottom()
    await call('chat:send', session, full, images, files.map((f) => f.rel))
  }
  const addFiles = async (paths: string[]) => {
    if (!paths.length) return
    try { const r = await call<Attachment[]>('chat:attach', projectId, paths); setFiles((xs) => [...xs, ...r.filter((a) => !xs.some((x) => x.rel === a.rel))]) } catch (e: any) { toast(e.message, true) }
  }
  const pickFiles = async () => addFiles(await call<string[]>('chat:pickFiles'))
  const onDrop = (e: RDragEvent) => {
    e.preventDefault(); setDrag(false)
    addFiles(Array.from(e.dataTransfer.files).map((f) => window.oa.pathForFile(f)).filter(Boolean))
  }
  const onPaste = async (e: RClipboardEvent) => {
    const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'))
    if (!imgs.length) return
    e.preventDefault()
    for (const f of imgs) {
      const b64 = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.readAsDataURL(f) })
      try { const r = await call<Attachment[]>('chat:attachData', projectId, f.name && f.name !== 'image.png' ? f.name : `pegado-${Date.now().toString(36)}.png`, b64); setFiles((xs) => [...xs, ...r]) } catch (er: any) { toast(er.message, true) }
    }
  }
  const attachFrame = async () => {
    try { const ctx = await context(); setAttach({ t: ctx.t, data: await call('frames:png', projectId, ctx.timeline, ctx.t, 1280) }) } catch (e: any) { toast(e.message, true) }
  }
  const newChat = async () => { if (session) await call('chat:kill', session); await start() }
  const openOld = async (id: string) => {
    setHistory(false)
    if (id === claudeSession) return
    if (busy && !(await dlg.confirm({ title: '¿Cambiar de conversación?', message: 'Claude está trabajando en esta: se va a detener.', ok: 'Cambiar' }))) return
    if (session) await call('chat:kill', session)
    await start(id)
  }
  const compact = async (ask = false) => {
    if (!session || busy) return
    let instr: string | null = ''
    if (ask) { instr = await dlg.prompt({ title: 'Compactar con instrucciones', icon: 'compress', label: 'Qué tiene que conservar el resumen', placeholder: 'p. ej.: el plan de escenas, los tiempos de la voz y las decisiones de estilo', ok: 'Compactar' }); if (instr == null) return }
    call('chat:compact', session, instr || undefined)
  }
  const onKey = (e: RKeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && matches.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMIdx((i) => (i + 1) % matches.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMIdx((i) => (i - 1 + matches.length) % matches.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(matches[mIdx]); return }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMention(null); return }
    }
    // En la tablet, Enter del teclado en pantalla hace un salto de línea (se envía con el botón);
    // con teclado físico y mouse/trackpad (DeX, funda con teclado) Enter envía, como en la PC.
    const enterSends = !android || e.ctrlKey || matchMedia('(any-pointer: fine)').matches
    if (e.key === 'Enter' && !e.shiftKey && enterSends) { e.preventDefault(); if (!busy) send() }
    e.stopPropagation()
  }

  if (info && !info.claude && android) {
    return (
      <div className="pane-body" style={{ display: visible ? 'flex' : 'none', flexDirection: 'column', justifyContent: 'center' }}>
        <Empty icon="sparkles" title="Conectá Claude" desc="En la tablet, Claude puede trabajar con tu plan de Claude (Claude Code corre en la app Termux; se configura una vez) o con una clave de la API, que se paga por uso.">
          <Button variant="primary" icon="settings" onClick={() => go({ page: 'settings', section: 'ia', from: { page: 'editor', id: projectId } })}>Configurar Claude</Button>
        </Empty>
      </div>
    )
  }
  if (info && !info.claude) {
    return (
      <div className="pane-body" style={{ display: visible ? 'flex' : 'none', flexDirection: 'column', justifyContent: 'center' }}>
        <Empty icon="sparkles" title="Conectá Claude Code" desc="OpenAnimator usa Claude Code con tu propia cuenta. Instalalo, iniciá sesión una vez con «claude» en una terminal y volvé a abrir el proyecto.">
          <Button variant="primary" icon="external" onClick={() => call('shell:openExternal', 'https://claude.com/code')}>Descargar Claude Code</Button>
          <Button icon="settings" onClick={() => go({ page: 'settings', section: 'ia', from: { page: 'editor', id: projectId } })}>Elegir ruta</Button>
        </Empty>
      </div>
    )
  }
  if (popped && !windowMode) {
    return (
      <div className="pane-body" style={{ display: visible ? 'flex' : 'none', flexDirection: 'column', justifyContent: 'center' }}>
        <Empty icon="popout" title="El chat está en otra ventana" desc="Seguí la conversación ahí; el editor le avisa dónde está el cursor.">
          <Button icon="popin" onClick={() => call('chat:popin', projectId)}>Traer el chat acá</Button>
          <Button variant="ghost" icon="popout" onClick={() => call('chat:popout', projectId, session)}>Ir a la ventana</Button>
        </Empty>
      </div>
    )
  }
  if (gone) return <Empty icon="message" title="La conversación terminó" desc="El proyecto se cerró en el editor. Cerrá esta ventana y volvé a abrir el chat desde el proyecto." />

  const effort = EFFORTS.find((e) => e.id === opts.effort) || EFFORTS[0]
  const perm = PERMS.find((p) => p.value === opts.permissionMode) || PERMS[1]
  const pct = stats && stats.context && stats.window ? Math.round((stats.context / stats.window) * 100) : 0
  const level = stats?.context ? ctxLevel(stats.context, pct) : 0
  const last = items[items.length - 1]
  const activeNow = last && ((last.kind === 'thinking' || last.kind === 'assistant') && last.status === 'streaming' || last.kind === 'tool' && last.status === 'ejecutando' || last.kind === 'permission' && last.status === 'pendiente')
  return (
    <div style={{ display: visible ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0, position: 'relative' }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true) } }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false) }} onDrop={onDrop}>
      {drag && <div className="chat-drop"><Icon name="paperclip" size={26} /><b>Soltá para adjuntar</b><span>Imágenes, PDF, guiones, audio, video…</span></div>}
      <div className={`pane-head ${windowMode ? 'drag-region' : ''}`} style={{ gap: 4, height: windowMode ? 38 : 38, paddingLeft: 12, paddingRight: windowMode ? 140 : undefined }}>
        {busy ? <span className="row t2" style={{ gap: 6, fontSize: 12 }}><Spinner size={12} />Trabajando…</span>
          : <span className="row t3" style={{ gap: 6, fontSize: 12 }} data-tip="Modelo de la sesión"><span className="sys-dot ok" style={{ marginLeft: 0, width: 6, height: 6 }} />{liveModel ? modelName(liveModel) : 'Listo'}</span>}
        <div className="grow" />
        <button className={`ctx-meter no-drag ${level === 2 ? 'err' : level === 1 ? 'warn' : ''}`} onClick={ctxMenu.open}
          data-tip={stats?.context ? `Contexto: ${kTok(stats.context)} de ${kTok(stats.window)} tokens (${pct}%). Cada mensaje vuelve a enviar todo esto: cuanto más grande, ${android ? 'más cuesta cada mensaje' : 'más consume de tu límite de uso'}.` : stats?.compactions ? 'Conversación compactada: se mide de nuevo en el próximo mensaje' : 'Contexto de la conversación (se mide al primer mensaje)'}>
          <ContextRing pct={pct} level={level} /><span className="tabnum">{stats?.context ? kShort(stats.context) : '—'}</span>
        </button>
        {ctxMenu.render([
          { header: stats?.context ? `Contexto: ${kTok(stats.context)} / ${kTok(stats.window)} tokens · ${stats.turns} turno${stats.turns === 1 ? '' : 's'}${stats.compactions ? ` · compactado ${stats.compactions}×` : ''}` : 'Contexto todavía sin medir' },
          { label: 'Compactar ahora', icon: 'compress', desc: 'Claude resume la conversación y sigue con menos contexto', disabled: busy || !stats?.turns, onSelect: () => compact() },
          { label: 'Compactar con instrucciones…', icon: 'edit', desc: 'Decile qué conservar del resumen', disabled: busy || !stats?.turns, onSelect: () => compact(true) },
          { label: 'Nueva conversación', icon: 'plus', desc: 'Empieza de cero (el proyecto no cambia)', onSelect: newChat },
          { sep: true },
          { label: 'Modo ahorro', icon: 'leaf', checked: saver, desc: 'Imágenes más chicas, sin relecturas, respuestas cortas', onSelect: () => setOption({ saver: !saver }, saver ? 'Modo ahorro desactivado (se aplica al próximo mensaje).' : 'Modo ahorro activado (se aplica al próximo mensaje).') },
        ], { align: 'end', width: 330 })}
        <Select size="sm" variant="ghost" value={opts.permissionMode} tip="Permisos" menuWidth={290}
          renderValue={() => perm.label}
          onChange={(v) => setOption({ permissionMode: v as string }, `Permisos: ${PERMS.find((p) => p.value === v)?.label}`)}
          options={PERMS.map((p) => ({ value: p.value, label: p.label, desc: p.desc, icon: p.icon }))} />
        {!android && <Button size="sm" variant="ghost" icon="terminal" tip={claudeSession ? 'Seguir esta conversación en una terminal (Claude Code)' : 'Abrir Claude Code en una terminal'} onClick={() => call('shell:terminal', projectId, claudeSession)} />}
        {android ? null : windowMode
          ? <Button size="sm" variant="ghost" icon="popin" tip="Volver a poner el chat en el editor" onClick={() => call('chat:popin', projectId)} />
          : <Button size="sm" variant="ghost" icon="popout" tip="Abrir el chat en otra ventana" onClick={() => session && call('chat:popout', projectId, session)} />}
        <Button size="sm" variant="ghost" icon="history" tip="Conversaciones anteriores" active={history} onClick={() => setHistory(true)} />
        <Button size="sm" variant="ghost" icon="plus" tip="Nueva conversación" onClick={newChat} />
      </div>
      <div className="chat-list-wrap" onKeyDown={(e) => { if (e.ctrlKey && e.key === 'End') { e.preventDefault(); toBottom() } }}>
      <div className="chat-list" ref={list} onScroll={onListScroll} tabIndex={-1}>
        {!items.length && (
          <div className="chat-hello">
            <span className="claude-mark" style={{ width: 34, height: 34, borderRadius: 10 }}><Icon name="sparkles" size={18} /></span>
            <div className="chat-hello-title">¿Qué hacemos con este video?</div>
            <div className="t3" style={{ lineHeight: 1.55 }}>Claude puede crear y editar escenas, <b className="t2">ver fotogramas</b>, armar <b className="t2">hojas de contactos</b> y <b className="t2">auditar el layout</b> por sí mismo. Escribí <b className="t2">@</b> para mencionar archivos del proyecto.</div>
            <div className="suggest" style={{ marginTop: 14 }}>
              {QUICK.map((q) => <button key={q.text} onClick={() => { setText(q.text); ta.current?.focus() }}><Icon name={q.icon} size={15} /><span>{q.text}</span></button>)}
            </div>
          </div>
        )}
        {items.map((it) => <ChatRow key={it.id} it={it} session={session} projectId={projectId} showThinking={showThinking} showCost={showCost} since={seen.current.get(it.id)} />)}
        {busy && !activeNow && <div className="think live"><span className="think-dot" /><span>{last?.kind === 'tool' ? 'Procesando el resultado…' : 'Pensando…'}</span><Elapsed since={busySince || Date.now()} /></div>}
        {busy && !!signalAt && !(last?.kind === 'tool' && last.status === 'ejecutando' && !last.streamed) && !(last?.kind === 'permission' && last.status === 'pendiente') && <Stall key={signalAt} at={signalAt} />}
      </div>
      {away && (
        <button className={`to-bottom ${unread ? 'has-new' : ''}`} onClick={() => toBottom()} data-tip="Ir al último mensaje (Ctrl+Fin)">
          <Icon name="chevron-down" size={15} stroke={2.2} />
          {unread ? <span>{unread} nuevo{unread === 1 ? '' : 's'}</span> : busy ? <span className="think-dot" /> : null}
        </button>
      )}
      </div>
      <div className="composer-wrap">
        {level > 0 && !busy && (
          <div className={`ctx-warn ${level === 2 ? 'err' : ''}`}>
            <Icon name="gauge" size={14} /><span className="grow">La conversación ya ocupa <b>{kTok(stats!.context)} tokens</b> y cada mensaje los reenvía: compactala para gastar menos{android ? '' : ' de tu límite'}.</span>
            <Button size="xs" icon="compress" onClick={() => compact()}>Compactar</Button>
          </div>
        )}
        <div className="composer">
          {mention && (
            <div className="mention-pop">
              {!projFiles ? <div className="row t3" style={{ padding: 10, gap: 8 }}><Spinner size={12} />Buscando archivos…</div>
                : !matches.length ? <div className="t3" style={{ padding: 10, fontSize: 12 }}>Ningún archivo coincide con «{mention.q}»</div>
                  : matches.map((f, i) => (
                    <button key={f.path} className={`mention-row ${i === mIdx ? 'on' : ''}`} onMouseDown={(e) => { e.preventDefault(); pickMention(f) }} onMouseEnter={() => setMIdx(i)}>
                      <Icon name={f.dir ? 'folder' : /\.html?$/i.test(f.path) ? 'code' : /\.(png|jpe?g|webp|gif|svg)$/i.test(f.path) ? 'image' : /\.(mp3|wav|m4a|ogg)$/i.test(f.path) ? 'music' : /\.(mp4|mov|webm|mkv)$/i.test(f.path) ? 'video' : 'file'} size={13} />
                      <span className="ellipsis"><b>{f.path.split('/').pop()}</b>{f.path.includes('/') && <span className="t3"> · {f.path.split('/').slice(0, -1).join('/')}</span>}</span>
                      <span className="grow" />{!f.dir && <span className="t4" style={{ fontSize: 10.5 }}>{fmtSize(f.size)}</span>}
                    </button>
                  ))}
            </div>
          )}
          {(attach || files.length > 0) && <div className="att-chips">
            {attach && <div className="att-chip"><img src={`data:image/png;base64,${attach.data}`} alt="" />Fotograma · {attach.t.toFixed(2)} s<Button size="xs" variant="ghost" icon="x" tip="Quitar" onClick={() => setAttach(null)} /></div>}
            {files.map((f) => <div key={f.rel} className="att-chip" data-tip={f.rel}>{f.image ? <img src={`data:image/jpeg;base64,${f.image}`} alt="" /> : <span className="att-ico"><Icon name={/\.pdf$/i.test(f.name) ? 'story' : /\.(mp3|wav|m4a|ogg|flac)$/i.test(f.name) ? 'music' : /\.(mp4|mov|webm|mkv)$/i.test(f.name) ? 'video' : 'file'} size={14} /></span>}
              <span className="ellipsis" style={{ maxWidth: 150 }}>{f.name}</span><span className="t4" style={{ fontSize: 11 }}>{fmtSize(f.size)}</span>
              <Button size="xs" variant="ghost" icon="x" tip="Quitar" onClick={() => setFiles((xs) => xs.filter((x) => x.rel !== f.rel))} /></div>)}
          </div>}
          <textarea ref={ta} rows={1} onPaste={onPaste} placeholder={busy ? 'Claude está trabajando… podés escribir el próximo pedido' : android ? 'Pedile algo a Claude… (@ menciona archivos del proyecto)' : 'Pedile algo a Claude… (@ para mencionar archivos)'} value={text}
            onChange={(e) => onTextChange(e.target.value, e.target.selectionStart)} onBlur={() => setTimeout(() => setMention(null), 150)}
            onKeyDown={onKey} />
          <div className="composer-bar">
            <Button size="sm" variant="ghost" icon="paperclip" tip="Adjuntar" active={attMenu.isOpen} onClick={attMenu.open} />
            {attMenu.render([
              { label: 'Fotograma actual', icon: 'camera', onSelect: attachFrame },
              { label: android ? 'Archivos de la tablet…' : 'Archivos…', icon: 'file', onSelect: pickFiles },
              { label: 'Mencionar un archivo del proyecto', icon: 'at', hint: '@', onSelect: () => { const v = text + (text && !/\s$/.test(text) ? ' @' : '@'); setText(v); onTextChange(v, v.length); ta.current?.focus() } },
            ], { placement: 'top' })}
            <Select size="sm" variant="ghost" value={opts.model} tip="Modelo" menuWidth={300} placement="top"
              renderValue={() => modelName(opts.model)}
              onChange={(v) => setOption({ model: v as string }, `Modelo: ${modelName(v as string)} (se aplica al próximo mensaje).`)}
              options={[{ header: 'Modelo' }, ...MODELS.map((m) => ({ value: m.id, label: m.name, desc: m.desc, hint: m.note }))]} />
            <Select size="sm" variant="ghost" value={opts.effort} tip="Nivel de esfuerzo (razonamiento)" menuWidth={280} placement="top"
              renderValue={() => <span className="row" style={{ gap: 6 }}><EffortBars n={effort.bars} />{effort.name}</span>}
              onChange={(v) => setOption({ effort: v as string }, `Esfuerzo: ${EFFORTS.find((e) => e.id === v)?.name} (se aplica al próximo mensaje).`)}
              options={[{ header: 'Nivel de esfuerzo' }, ...EFFORTS.map((e) => ({ value: e.id, label: e.name, desc: e.desc }))]} />
            <Button size="sm" variant="ghost" icon="leaf" active={saver} className={saver ? 'saver-on' : ''} tip={saver ? 'Modo ahorro activado: Claude gasta menos contexto (clic para desactivar)' : 'Modo ahorro desactivado (clic para activarlo)'}
              onClick={() => setOption({ saver: !saver }, saver ? 'Modo ahorro desactivado (se aplica al próximo mensaje).' : 'Modo ahorro activado (se aplica al próximo mensaje).')} />
            <div className="grow" />
            {busy
              ? <Button variant="danger" className="send-btn" icon="stop" tip="Detener" onClick={() => session && call('chat:interrupt', session)} />
              : <Button variant="primary" className="send-btn" icon="send" tip="Enviar" kbd="Enter" onClick={send} disabled={!text.trim() && !files.length} />}
          </div>
        </div>
      </div>
      {history && <HistoryModal projectId={projectId} current={claudeSession} onPick={openOld} onNew={() => { setHistory(false); newChat() }} onClose={() => setHistory(false)} />}
      {dlg.element}
    </div>
  )
}

type SessionInfo = { id: string; title: string; first: string; updated: number; size: number }
const ago = (t: number) => {
  const s = (Date.now() - t) / 1000
  if (s < 60) return 'recién'
  if (s < 3600) return `hace ${Math.round(s / 60)} min`
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`
  if (s < 86400 * 7) return `hace ${Math.round(s / 86400)} d`
  return new Date(t).toLocaleDateString()
}
/** Lista de conversaciones anteriores del proyecto (las guarda Claude Code) para retomarlas. */
function HistoryModal({ projectId, current, onPick, onNew, onClose }: { projectId: string; current?: string; onPick: (id: string) => void; onNew: () => void; onClose: () => void }) {
  const [list, setList] = useState<SessionInfo[] | null>(null)
  const [q, setQ] = useState('')
  useEffect(() => { call<SessionInfo[]>('chat:sessions', projectId).then(setList).catch(() => setList([])) }, [projectId])
  const shown = (list || []).filter((s) => !q || (s.title + ' ' + s.first).toLowerCase().includes(q.toLowerCase()))
  return (
    <Modal title="Conversaciones anteriores" subtitle="Retomá una conversación: Claude recuerda todo lo que se habló ahí." icon="history" onClose={onClose}
      footer={<><span className="t3" style={{ fontSize: 12 }}>{list ? `${list.length} conversación${list.length === 1 ? '' : 'es'}` : ''}</span><div className="grow" /><Button icon="plus" onClick={onNew}>Nueva conversación</Button></>}>
      <TextInput icon="search" placeholder="Buscar por título o mensaje…" value={q} onChange={setQ} autoFocus clearable width="100%" />
      <div className="hist-list">
        {!list ? <div className="row t3" style={{ gap: 8, padding: 14 }}><Spinner size={12} />Buscando conversaciones…</div>
          : !shown.length ? <div className="t3" style={{ padding: 14, fontSize: 12.5 }}>{list.length ? 'Ninguna coincide.' : 'Todavía no hay conversaciones guardadas en este proyecto.'}</div>
            : shown.map((s) => (
              <button key={s.id} className={`hist-row ${s.id === current ? 'on' : ''}`} onClick={() => onPick(s.id)}>
                <Icon name="message" size={14} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="hist-title ellipsis">{s.title}{s.id === current && <span className="hist-cur">actual</span>}</div>
                  <div className="hist-first ellipsis">{s.first}</div>
                </div>
                <span className="t3 tabnum" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{ago(s.updated)}</span>
              </button>
            ))}
      </div>
    </Modal>
  )
}
