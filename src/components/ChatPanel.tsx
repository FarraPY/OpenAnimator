import { ClipboardEvent as RClipboardEvent, DragEvent as RDragEvent, Fragment, KeyboardEvent as RKeyboardEvent, memo, ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { afterPaint, Attachment, call, ChatEvent, ChatItem, ChatStats, EFFORTS, fileUrl, fmtSize, on } from '../api'
import { useModels } from '../claudeModels'
import { isAndroid, isIphone } from '../platform'
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
type Ctx = { timeline: string; t: number; scene?: string }
/** Lo que necesita una cabecera propia del chat (la del iPhone): el estado y las opciones de la conversación. */
export type ChatHeadApi = {
  busy: boolean; model: string; modelValue: string; effort: string; permissionMode: string; saver: boolean
  modelName: (v: string) => string; models: Array<{ value: string; label: ReactNode; desc?: ReactNode }>
  perms: typeof PERMS
  setOption: (patch: { model?: string; effort?: string; permissionMode?: string; saver?: boolean }, label: string) => void
  history: () => void; newChat: () => void; compact: () => void
  context: { used: number; window: number; pct: number; turns: number } | null
}
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
    oa_buscar_iconos: ['shapes', 'Buscar íconos'], oa_guardar_iconos: ['shapes', 'Guardar íconos'], oa_buscar_fuentes: ['type', 'Buscar tipografías'],
    oa_usar_fuente: ['type', 'Usar tipografía'], oa_quitar_fondo: ['scissors', 'Quitar el fondo'], oa_ejecutar_js: ['code', 'Ejecutar código'], oa_borrar: ['trash', 'Borrar'], oa_registro_app: ['history', 'Registro de la app'],
  }
  const STD: Record<string, [IconName, string]> = {
    Read: ['file', 'Leer'], Write: ['edit', 'Escribir'], Edit: ['edit', 'Editar'], MultiEdit: ['edit', 'Editar'], Bash: ['terminal', 'Terminal'], PowerShell: ['terminal', 'PowerShell'],
    Glob: ['search', 'Buscar archivos'], Grep: ['search', 'Buscar texto'], WebFetch: ['external', 'Leer web'], WebSearch: ['search', 'Buscar en la web'],
    TodoWrite: ['list', 'Tareas'], Task: ['bot', 'Subagente'], Agent: ['bot', 'Subagente'], ToolSearch: ['search', 'Cargar herramientas'], Skill: ['wand', 'Skill'],
  }
  // En la tablet con Termux, los archivos del proyecto también llegan por el MCP de OpenAnimator.
  const m = OA[oa] || STD[raw] || STD[oa] || ['wand', raw.replace(/^mcp__/, '').replace(/__/g, ' · ')]
  const arg = i.file_path || i.path || i.command || i.pattern || i.skill || i.description || i.query || i.prompt || i.texto || i.descripcion || i.consulta || i.buscar || i.familia || i.imagen || (i.iconos ? i.iconos.join(', ') : '') || (i.rutas ? i.rutas.join(', ') : '') || (i.times ? `t = ${i.times.join(', ')} s` : '') || (i.count ? `${i.count} cuadros` : '') || ''
  return { icon: m[0], name: m[1], arg: String(arg).replace(/\\/g, '/').split('/').slice(-3).join('/').slice(0, 120) }
}

// ── Markdown mínimo y seguro (sin HTML) ────────────────────────────────────────
const openUrl = (url: string) => (e: { preventDefault: () => void }) => { e.preventDefault(); call('shell:openExternal', url) }
function inline(s: string, k = 0): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(~~[^~]+~~)|(\[[^\]]+\]\((https?:[^)\s]+)\))|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"»])/g
  let last = 0, m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index))
    const x = m[0]
    if (m[1]) out.push(<code key={k++}>{x.slice(1, -1)}</code>)
    else if (m[2]) out.push(<strong key={k++}>{x.slice(2, -2)}</strong>)
    else if (m[3]) out.push(<em key={k++}>{x.slice(1, -1)}</em>)
    else if (m[4]) out.push(<del key={k++}>{x.slice(2, -2)}</del>)
    else if (m[5]) out.push(<a key={k++} href="#" onClick={openUrl(m[6])}>{x.slice(1, x.indexOf(']'))}</a>)
    else if (m[7]) out.push(<a key={k++} href="#" onClick={openUrl(x)}>{x.replace(/^https?:\/\/(www\.)?/, '')}</a>)
    last = m.index + x.length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}

// Resaltado de código, liviano y propio: lo que más escribe Claude acá es HTML, CSS y JS (las escenas).
const KW = new Set('const let var function return if else for while do switch case break continue new class extends import from export default async await try catch finally throw typeof instanceof in of this null undefined true false yield static get set delete void def elif lambda None True False'.split(' '))
type Lang = 'js' | 'html' | 'css' | 'sh'
const LANG: Record<string, Lang> = { js: 'js', javascript: 'js', mjs: 'js', ts: 'js', typescript: 'js', jsx: 'js', tsx: 'js', json: 'js', py: 'js', python: 'js', html: 'html', xml: 'html', svg: 'html', css: 'css', scss: 'css', sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', powershell: 'sh', ps1: 'sh', console: 'sh' }
// Cada grupo de la expresión es una clase: comentario, cadena o etiqueta, número, palabra…
const HL: Record<Lang, [RegExp, string[]]> = {
  js: [/(\/\/.*$|\/\*[\s\S]*?\*\/|#.*$)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/gm, ['hl-c', 'hl-s', 'hl-n', 'hl-k']],
  html: [/(<!--[\s\S]*?-->)|(<\/?[\w:-]+|\/?>)|("[^"]*"|'[^']*')|([\w:-]+)(?==)/g, ['hl-c', 'hl-t', 'hl-s', 'hl-a']],
  css: [/(\/\*[\s\S]*?\*\/)|("[^"]*"|'[^']*')|(#[0-9a-fA-F]{3,8}\b|-?\d*\.?\d+(?:px|%|em|rem|s|ms|deg|vh|vw|fr)?\b)|([\w-]+)(?=\s*:[^:])/g, ['hl-c', 'hl-s', 'hl-n', 'hl-p']],
  sh: [/(^\s*#.*$|\s#.*$)|("(?:[^"\\]|\\.)*"|'[^']*')|(\s--?[\w-]+)|(^\s*[\w./-]+)/gm, ['hl-c', 'hl-s', 'hl-a', 'hl-k']],
}
function highlight(code: string, lang: string): ReactNode[] {
  const kind: Lang | null = LANG[lang.toLowerCase()] || (/^\s*</.test(code) ? 'html' : lang ? 'js' : null)
  if (!kind || code.length > 30000) return [code]
  const [src, cls] = HL[kind]
  const re = new RegExp(src.source, src.flags)
  const out: ReactNode[] = []
  let last = 0, k = 0, m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    if (!m[0]) { re.lastIndex++; continue }
    if (m.index > last) out.push(code.slice(last, m.index))
    const g = m.findIndex((x, i) => i > 0 && x !== undefined)
    let c = cls[g - 1] || ''
    if (kind === 'js' && g === 4) c = KW.has(m[0]) ? 'hl-k' : code[m.index + m[0].length] === '(' ? 'hl-f' : /^[A-Z]/.test(m[0]) ? 'hl-ty' : ''
    out.push(c ? <span key={k++} className={c}>{m[0]}</span> : m[0])
    last = m.index + m[0].length
  }
  if (last < code.length) out.push(code.slice(last))
  return out
}
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false)
  const body = useMemo(() => highlight(code, lang), [code, lang])
  const copy = () => call('clipboard:text', code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }, () => {})
  return (
    <div className="code-block">
      <div className="code-head"><span>{lang || 'código'}</span><button className="code-copy" onClick={copy}><Icon name={copied ? 'check' : 'copy'} size={13} />{copied ? 'Copiado' : 'Copiar'}</button></div>
      <pre><code>{body}</code></pre>
    </div>
  )
}

const LI = /^(\s*)([-*•+]|\d+[.)])\s+(.*)$/
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/
/** Una lista desde la línea `start`, con las sublistas (más sangría) adentro de su ítem. Devuelve dónde sigue. */
function list(lines: string[], start: number, key: number): [ReactNode, number] {
  const first = LI.exec(lines[start])!
  const base = first[1].length, ordered = /\d/.test(first[2])
  const items: ReactNode[][] = []
  let i = start
  while (i < lines.length) {
    const l = lines[i], m = HR.test(l) ? null : LI.exec(l)
    if (m && m[1].length <= base + 1 && /\d/.test(m[2]) === ordered) {
      const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3])
      items.push(task ? [<span key="t" className={`md-task ${task[1] === ' ' ? '' : 'done'}`}>{task[1] !== ' ' && <Icon name="check" size={10} stroke={3} />}</span>, ...inline(task[2], 1)] : inline(m[3]))
      i++
    } else if (m && m[1].length > base + 1 && items.length) {
      const [sub, j] = list(lines, i, i)
      items[items.length - 1].push(sub); i = j
    } else if (!m && l.trim() && items.length && l.search(/\S/) > base) {
      items[items.length - 1].push(<br key={`b${i}`} />, ...inline(l.trim(), 1000 + i)); i++ // continuación del ítem
    } else break
  }
  const L = ordered ? 'ol' : 'ul'
  const n = ordered ? parseInt(first[2]) : 1
  return [<L key={key} start={n !== 1 ? n : undefined}>{items.map((c, j) => <li key={j}>{c}</li>)}</L>, i]
}
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n')
  const blocks: ReactNode[] = []
  let i = 0, k = 0
  while (i < lines.length) {
    const l = lines[i]
    const fence = /^\s*```\s*([\w+#.-]*)/.exec(l)
    if (fence) {
      const buf: string[] = []; i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++])
      i++; blocks.push(<CodeBlock key={k++} code={buf.join('\n')} lang={fence[1]} />); continue
    }
    const h = /^(#{1,4})\s+(.*)/.exec(l)
    if (h) { const T = (`h${Math.min(4, h[1].length + 1)}`) as any; blocks.push(<T key={k++}>{inline(h[2])}</T>); i++; continue }
    if (HR.test(l)) { blocks.push(<hr key={k++} />); i++; continue }
    if (LI.test(l)) { const [node, j] = list(lines, i, k++); blocks.push(node); i = j; continue }
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
    while (i < lines.length && lines[i].trim() && !/^(\s*```|#{1,4}\s|>\s?|\s*\|)/.test(lines[i]) && !LI.test(lines[i]) && !HR.test(lines[i])) buf.push(lines[i++])
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

/** Lo que escribió el usuario, sin el contexto del editor que se le agrega al mandarlo. */
const userText = (t?: string) => (t || '').replace(/\n\n\(Contexto del editor:[\s\S]*$/, '')

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

/** Lo que se puede hacer con un mensaje (estable: no hace volver a dibujar las filas memorizadas). */
type RowActions = { copy: (text: string) => void; edit: (it: ChatItem) => void; retry: () => void }
const IMG = /\.(png|jpe?g|webp|gif)$/i

/** Un pedido del usuario: tocarlo muestra Copiar y Editar (como en la app de Claude); las fotos adjuntas se ven. */
function UserMsg({ it, projectId, idle, act, onUnqueue }: { it: ChatItem; projectId: string; idle: boolean; act: RowActions; onUnqueue: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<string | null>(null)
  const text = userText(it.text)
  const imgs = (it.files || []).filter((f) => IMG.test(f))
  const others = (it.files || []).filter((f) => !IMG.test(f))
  const frame = (it.images || 0) > imgs.length
  // Editar vuelve la conversación a ese punto: no con Claude trabajando ni en uno que leyó a mitad de un turno.
  const canEdit = idle && !it.queued && it.after !== undefined
  const toggle = (e: { target: EventTarget }) => {
    if ((e.target as HTMLElement).closest('button, img, a') || window.getSelection()?.toString()) return
    if (!it.queued) setOpen((o) => !o)
  }
  return (
    <div className={`msg-user-wrap ${open ? 'open' : ''}`}>
      <div className={`msg-user ${it.queued ? 'queued' : ''}`} onClick={toggle}>{text.split(/((?:^|\s)@[^\s@]+)/).map((part, i) => /^\s?@/.test(part) ? <Fragment key={i}>{part.startsWith(' ') ? ' ' : ''}<span className="mention">{part.trim()}</span></Fragment> : part)}
        {imgs.length > 0 && <div className="att-thumbs">{imgs.map((f) => <img key={f} src={fileUrl(projectId, f)} alt="" onClick={() => setView(f)} />)}</div>}
        {others.length || frame ? <div className="att-row">
          {others.map((f) => <span key={f} className="att"><Icon name="file" size={12} />{f.split('/').pop()}</span>)}
          {frame && <span className="att"><Icon name="camera" size={12} />fotograma</span>}
        </div> : null}
        {it.queued && <div className="msg-queued"><Icon name="clock" size={12} /><span className="grow">{it.midTurn ? 'Claude lo lee en la próxima pausa, sin cortar lo que hace' : 'En cola: sale cuando Claude termine'}</span>
          <button className="msg-unqueue" data-tip={it.midTurn ? 'Retirarlo antes de que Claude lo lea (vuelve al cuadro de texto)' : 'Sacarlo de la cola (vuelve al cuadro de texto)'} onClick={() => onUnqueue(it.id)}><Icon name="x" size={13} /></button></div>}
      </div>
      {open && <div className="msg-actions">
        <button onClick={() => { act.copy(text); setOpen(false) }}><Icon name="copy" size={14} />Copiar</button>
        {canEdit && <button onClick={() => { act.edit(it); setOpen(false) }}><Icon name="edit" size={14} />Editar</button>}
      </div>}
      {view && <Modal title={view.split('/').pop() || 'Imagen'} icon="image" onClose={() => setView(null)}><img className="att-view" src={fileUrl(projectId, view)} alt="" /></Modal>}
    </div>
  )
}

/**
 * Un mensaje del chat. Memoizado: mientras Claude escribe sólo cambia el último, y re-dibujar (y volver a
 * leer el markdown de) toda la conversación con cada palabra trababa la tablet en conversaciones largas.
 * `turn`: el texto de las respuestas del turno que termina en esta fila (resultado), para copiarlo; `retry`: es el último
 * turno y se puede reintentar.
 */
const ChatRow = memo(function ChatRow({ it, session, projectId, showThinking, showCost, since, onUnqueue, idle, act, turn, retry }: {
  it: ChatItem; session: string | null; projectId: string; showThinking: boolean; showCost: boolean; since?: number; onUnqueue: (id: string) => void
  idle: boolean; act: RowActions; turn?: string; retry?: boolean
}) {
  if (it.kind === 'user') return <UserMsg it={it} projectId={projectId} idle={idle} act={act} onUnqueue={onUnqueue} />
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
  if (it.kind === 'result') {
    const acts = turn || retry ? <span className="turn-acts">
      {turn && <button className="turn-act" data-tip="Copiar la respuesta" aria-label="Copiar la respuesta" onClick={() => act.copy(turn)}><Icon name="copy" size={14} /></button>}
      {retry && <button className="turn-act" data-tip="Reintentar: Claude vuelve a responder tu último mensaje" aria-label="Reintentar" onClick={act.retry}><Icon name="refresh" size={14} /></button>}
    </span> : null
    if (it.isError) return <><div className="notice error"><Icon name="x-circle" size={14} />{it.text}</div>{acts && <div className="turn-meta">{acts}</div>}</>
    if (!acts && !showCost) return null
    return <div className="turn-meta">{acts}{showCost && <><span className="row" style={{ gap: 4 }}><Icon name="check" size={11} />listo</span>{it.durationMs ? <span>{(it.durationMs / 1000).toFixed(0)} s</span> : null}{it.cost ? <span>US$ {it.cost.toFixed(3)}</span> : null}</>}</div>
  }
  if (it.kind === 'tool') {
    const m = toolMeta(it)
    const media = !it.isError && it.result ? /guardad[oa] en (assets\/\S+?\.(png|jpe?g|webp|mp3|wav))/i.exec(it.result) : null
    return (
      <Fragment key={it.id}>
        <details className={`tool-card ${it.parent ? 'sub' : ''}`}>
          <summary>
            <span className="tool-state">{it.status === 'ejecutando' || it.status === 'trabajando' ? <Spinner size={12} /> : <Icon name={it.isError ? 'x-circle' : 'check-circle'} size={13} style={{ color: it.isError ? 'var(--err)' : 'var(--ok)' }} />}</span>
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
    if (/^(Write|Edit|MultiEdit)$/.test((it.name || '').replace(/^mcp__openanimator__/, ''))) return <ChangeCard it={it} session={session} file={m.arg} />
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

/** Las líneas que cambia una edición (Edit/MultiEdit: quitadas y agregadas, sin las iguales de las puntas; Write: el archivo). */
const NL = /\r?\n/
function changeLines(name: string, input: any): Array<{ k: '+' | '-' | ' '; s: string }> {
  const out: Array<{ k: '+' | '-' | ' '; s: string }> = []
  const pair = (a: string, b: string) => {
    const x = String(a ?? '').split(NL), y = String(b ?? '').split(NL)
    let i = 0, j = 0
    while (i < x.length && i < y.length && x[i] === y[i]) i++
    while (j < x.length - i && j < y.length - i && x[x.length - 1 - j] === y[y.length - 1 - j]) j++
    if (out.length) out.push({ k: ' ', s: '⋯' })
    for (const s of x.slice(i, x.length - j)) out.push({ k: '-', s })
    for (const s of y.slice(i, y.length - j)) out.push({ k: '+', s })
  }
  if (/Write$/.test(name)) for (const s of String(input?.content ?? '').split(NL)) out.push({ k: '+', s })
  else if (Array.isArray(input?.edits)) for (const e of input.edits) pair(e.old_string, e.new_string)
  else pair(input?.old_string, input?.new_string)
  return out
}

/** Un cambio de archivo que Claude pide permiso para hacer: «Ver» muestra qué cambia; «Aplicar» o «Descartar». */
function ChangeCard({ it, session, file }: { it: ChatItem; session: string | null; file: string }) {
  const [open, setOpen] = useState(false)
  const lines = useMemo(() => open ? changeLines(it.name || '', it.input) : [], [open, it])
  const MAX = 160
  const write = /Write$/.test(it.name || '')
  return (
    <div className="perm-card change">
      <div className="t"><Icon name="edit" size={15} /><div className="grow">Cambio propuesto<div className="t3 mono ellipsis" style={{ fontSize: 12 }}>{write ? 'Archivo completo: ' : ''}{file}</div></div></div>
      {open && <pre className="chg">{lines.slice(0, MAX).map((l, i) => <div key={i} className={l.k === '+' ? 'add' : l.k === '-' ? 'del' : 'gap'}>{l.k === ' ' ? l.s : `${l.k} ${l.s}`}</div>)}
        {lines.length > MAX && <div className="gap">… {lines.length - MAX} líneas más</div>}</pre>}
      {it.status === 'pendiente'
        ? <div className="row" style={{ gap: 6 }}>
          <Button size="sm" variant="ghost" icon={open ? 'chevron-up' : 'eye'} onClick={() => setOpen(!open)}>{open ? 'Ocultar' : 'Ver'}</Button>
          <div className="grow" />
          <Button size="sm" variant="ghost" onClick={() => call('chat:permission', session, it.id, false)}>Descartar</Button>
          <Button size="sm" tip="No volver a preguntar por cambios de archivos en este chat" onClick={() => call('chat:permission', session, it.id, true, true)}>Siempre</Button>
          <Button size="sm" variant="primary" icon="check" onClick={() => call('chat:permission', session, it.id, true)}>Aplicar</Button>
        </div>
        : <span className="t3 row" style={{ gap: 5, fontSize: 12 }}><Icon name={it.status === 'rechazado' ? 'x' : 'check'} size={12} />{it.status === 'rechazado' ? 'descartado' : 'aplicado'}
          <Button size="sm" variant="ghost" icon={open ? 'chevron-up' : 'eye'} onClick={() => setOpen(!open)}>{open ? 'Ocultar' : 'Ver'}</Button></span>}
    </div>
  )
}

/** assistant: respuestas terminadas de la conversación `session` (el editor cuenta las que no se vieron). */
export type ChatStatus = { busy: boolean; waiting: boolean; assistant: number; session: string | null }
export default function ChatPanel({ projectId, context, visible, windowMode, attachTo, onStatus, inject, head, compactBar }: {
  projectId: string; context: () => Ctx | Promise<Ctx>; visible: boolean
  /** Cabecera propia en vez de la de siempre (el iPhone: «Claude», la escena y un menú con las opciones). */
  head?: (api: ChatHeadApi) => ReactNode
  /** Sin modelo, esfuerzo ni modo ahorro en la barra del cuadro de mensaje (están en la cabecera propia). */
  compactBar?: boolean
  /** Ventana separada: se conecta a la conversación `attachTo` y no la cierra al salir. */
  windowMode?: boolean; attachTo?: string
  /** Estado para mostrar afuera (pestaña de Claude en la tablet): trabajando, esperando permiso, respuestas. */
  onStatus?: (s: ChatStatus) => void
  /** Texto para poner en el cuadro de mensaje desde afuera (acciones rápidas). */
  inject?: { text: string; n: number } | null
}) {
  const models = useModels()
  const android = isAndroid()
  // Teléfono o tablet: sin terminal ni ventana aparte, y Enter no envía con el teclado en pantalla.
  const phone = isIphone(), touchUi = android || phone
  const { toast, info, settings, go, updateSettings } = useApp()
  const dlg = useDialogs()
  const [session, setSession] = useState<string | null>(null)
  const [items, setItems] = useState<ChatItem[]>([])
  const [busy, setBusy] = useState(false)
  const [tasks, setTasks] = useState(0) // subagentes trabajando en segundo plano
  const [text, setText] = useState('')
  const [attach, setAttach] = useState<{ t: number; data: string } | null>(null)
  const [files, setFiles] = useState<Attachment[]>([])
  const [drag, setDrag] = useState(false)
  const [stats, setStats] = useState<ChatStats | null>(null)
  const [claudeSession, setClaudeSession] = useState<string | undefined>()
  const [popped, setPopped] = useState(false)
  const [gone, setGone] = useState(false)
  const [history, setHistory] = useState(false)
  const [editing, setEditing] = useState<ChatItem | null>(null) // un pedido que se va a reenviar cambiado
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
    setLiveModel(r.model); setGone(false); setClaudeSession(r.sessionId); setSignalAt(r.signalAt || 0); setTasks(r.tasks || 0)
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
      else if (e.type === 'remove') setItems((xs) => xs.filter((x) => x.id !== e.item!.id))
      else if (e.type === 'state') {
        setBusy(!!e.state?.busy)
        if (e.state?.model) setLiveModel(e.state.model)
        if (e.state?.stats) setStats(e.state.stats)
        if (e.state?.sessionId) setClaudeSession(e.state.sessionId)
        if (e.state?.signalAt) setSignalAt(e.state.signalAt)
        setTasks(e.state?.tasks || 0)
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
    const st: ChatStatus = { busy: busy || tasks > 0, waiting: items.some((x) => x.kind === 'permission' && x.status === 'pendiente'), assistant: items.filter((x) => x.kind === 'assistant' && !!x.text && x.status !== 'streaming').length, session }
    const k = JSON.stringify(st)
    if (k !== lastStatus.current) { lastStatus.current = k; onStatus(st) }
  }, [busy, tasks, items, session])
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
  useEffect(() => { if (visible && !popped && !touchUi) setTimeout(() => ta.current?.focus(), 50) }, [visible, popped])

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
    if (editing) {
      // La conversación vuelve a antes de ese pedido (una copia: la original queda en el historial) y éste sale en su lugar.
      if ((await call<string | null>('chat:rewind', session, editing.id).catch(() => null)) == null) { toast('No se puede editar ahora: esperá a que Claude termine', true); return }
      setEditing(null)
    }
    let ctx: Ctx = { timeline: 'main', t: 0 }
    try { ctx = (await context()) || ctx } catch { /* sin contexto */ }
    let att = attach
    if (!att && settings?.claude.autoAttachFrame) { try { att = { t: ctx.t, data: await call('frames:png', projectId, ctx.timeline, ctx.t, 1280) } } catch { /* sin imagen */ } }
    const ment = mentioned(msg)
    const fl = files.length ? ` Archivos adjuntos (copiados en la carpeta del proyecto; leelos con Read): ${files.map((f) => f.rel).join(', ')}.${files.some((f) => f.image) ? ' Las imágenes adjuntas también van en este mensaje.' : ''}` : ''
    const ml = ment.length ? ` Archivos del proyecto que menciona el usuario con @ (rutas relativas a la carpeta del proyecto): ${ment.join(', ')}.` : ''
    const sc = ctx.scene ? ` El usuario habla de la escena ${ctx.scene}.` : ''
    const full = `${msg}\n\n(Contexto del editor: timeline activo "${ctx.timeline}", cursor en ${ctx.t.toFixed(2)} s.${sc}${att ? ` La primera imagen adjunta es el fotograma en t=${att.t.toFixed(2)} s.` : ''}${fl}${ml})`
    const images = [...(att ? [{ mediaType: 'image/png', data: att.data }] : []), ...files.filter((f) => f.image).slice(0, 8).map((f) => ({ mediaType: 'image/jpeg', data: f.image! }))]
    setText(''); setAttach(null); setFiles([]); setMention(null)
    toBottom()
    await call('chat:send', session, full, images, files.map((f) => f.rel))
  }
  // Lo que sale de la cola vuelve al cuadro de texto, para editarlo (como en Claude Code).
  const restore = (texts: string[]) => { if (texts.length) setText((t) => [...texts.map(userText), t].filter((x) => x.trim()).join('\n\n')) }
  const unqueue = useCallback(async (itemId: string) => {
    if (!sid.current) return
    const texts = await call<string[]>('chat:unqueue', sid.current, itemId).catch(() => [])
    if (texts.length) restore(texts); else toast('Claude ya lo leyó')
  }, [])
  const stop = async () => {
    if (!session) return
    restore(await call<string[]>('chat:unqueue', session).catch(() => []))
    call('chat:interrupt', session)
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
  // Acciones de los mensajes: un objeto fijo que llama a la versión del último dibujo (las filas están memorizadas).
  const actNow = useRef<RowActions>(null!)
  actNow.current = {
    copy: (t) => { call('clipboard:text', t).then(() => toast('Copiado'), (e: any) => toast(e.message, true)) },
    edit: (it) => {
      setEditing(it); setText(userText(it.text)); setAttach(null); setFiles([])
      setTimeout(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) } }, 60)
    },
    retry: async () => {
      if (!session) return
      setEditing(null); toBottom()
      if (!(await call<boolean>('chat:retry', session).catch(() => false))) toast('No se puede reintentar ahora', true)
    },
  }
  const act = useMemo<RowActions>(() => ({ copy: (t) => actNow.current.copy(t), edit: (it) => actNow.current.edit(it), retry: () => actNow.current.retry() }), [])
  useEffect(() => setEditing(null), [session])
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
    const enterSends = !touchUi || e.ctrlKey || matchMedia('(any-pointer: fine)').matches
    if (e.key === 'Enter' && !e.shiftKey && enterSends) { e.preventDefault(); send() }
    e.stopPropagation()
  }

  if (info && !info.claude && phone) {
    return (
      <div className="pane-body" style={{ display: visible ? 'flex' : 'none', flexDirection: 'column', justifyContent: 'center' }}>
        <Empty icon="sparkles" title="Conectá Claude" desc="Claude Code corre dentro del iPhone con tu plan de Claude. Se instala y se conecta una vez, en Ajustes › Claude.">
          <Button variant="primary" icon="settings" onClick={() => go({ page: 'settings', section: 'ia', from: { page: 'editor', id: projectId } })}>Configurar Claude</Button>
        </Empty>
      </div>
    )
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
  // Lo que Claude todavía no leyó va siempre abajo (como en Claude Code); al leerlo, el backend lo pone donde lo leyó.
  const queuedN = items.reduce((n, x) => n + (x.queued ? 1 : 0), 0)
  const shown = queuedN ? [...items.filter((x) => !x.queued), ...items.filter((x) => x.queued)] : items
  const last = shown[shown.length - 1 - queuedN]
  const idle = !busy && !tasks
  // Lo que respondió Claude en cada turno (para copiarlo desde la fila del resultado) y si el último se puede reintentar.
  const turns = new Map<string, string>()
  let lastResult: string | null = null, lastUser: ChatItem | undefined, buf: string[] = []
  for (const x of shown) {
    if (x.queued) continue
    if (x.kind === 'user') { buf = []; lastUser = x; lastResult = null } else if (x.kind === 'assistant' && x.text) buf.push(x.text)
    else if (x.kind === 'result') { if (buf.length) turns.set(x.id, buf.join('\n\n')); buf = []; lastResult = x.id }
  }
  const canRetry = idle && !!lastUser && lastUser.after !== undefined
  const activeNow = last && ((last.kind === 'thinking' || last.kind === 'assistant') && last.status === 'streaming' || last.kind === 'tool' && last.status === 'ejecutando' || last.kind === 'permission' && last.status === 'pendiente')
  return (
    <div style={{ display: visible ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0, position: 'relative' }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true) } }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false) }} onDrop={onDrop}>
      {drag && <div className="chat-drop"><Icon name="paperclip" size={26} /><b>Soltá para adjuntar</b><span>Imágenes, PDF, guiones, audio, video…</span></div>}
      {head ? head({
        busy: busy || tasks > 0, model: opts.model, modelValue: models.value(opts.model), effort: opts.effort, permissionMode: opts.permissionMode, saver,
        modelName: (v) => models.name(v), models: models.options as ChatHeadApi['models'], perms: PERMS, setOption,
        history: () => setHistory(true), newChat, compact: () => compact(),
        context: stats?.context ? { used: stats.context, window: stats.window, pct, turns: stats.turns } : null,
      }) : <div className={`pane-head ${windowMode ? 'drag-region' : ''}`} style={{ gap: 4, height: windowMode ? 38 : 38, paddingLeft: 12, paddingRight: windowMode ? 140 : undefined }}>
        {busy || tasks ? <span className="row t2" style={{ gap: 6, fontSize: 12 }}><Spinner size={12} />{busy ? 'Trabajando…' : `${tasks} subagente${tasks === 1 ? '' : 's'} trabajando…`}</span>
          : <span className="row t3" style={{ gap: 6, fontSize: 12 }} data-tip="Modelo de la sesión"><span className="sys-dot ok" style={{ marginLeft: 0, width: 6, height: 6 }} />{liveModel ? models.name(liveModel) : 'Listo'}</span>}
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
        {!touchUi && <Button size="sm" variant="ghost" icon="terminal" tip={claudeSession ? 'Seguir esta conversación en una terminal (Claude Code)' : 'Abrir Claude Code en una terminal'} onClick={() => call('shell:terminal', projectId, claudeSession)} />}
        {touchUi ? null : windowMode
          ? <Button size="sm" variant="ghost" icon="popin" tip="Volver a poner el chat en el editor" onClick={() => call('chat:popin', projectId)} />
          : <Button size="sm" variant="ghost" icon="popout" tip="Abrir el chat en otra ventana" onClick={() => session && call('chat:popout', projectId, session)} />}
        <Button size="sm" variant="ghost" icon="history" tip="Conversaciones anteriores" active={history} onClick={() => setHistory(true)} />
        <Button size="sm" variant="ghost" icon="plus" tip="Nueva conversación" onClick={newChat} />
      </div>}
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
        {shown.slice(0, shown.length - queuedN).map((it) => <ChatRow key={it.id} it={it} session={session} projectId={projectId} showThinking={showThinking} showCost={showCost} since={seen.current.get(it.id)} onUnqueue={unqueue}
          idle={idle} act={act} turn={turns.get(it.id)} retry={canRetry && it.id === lastResult} />)}
        {busy && !activeNow && <div className="think live"><span className="think-dot" /><span>{last?.kind === 'tool' ? 'Procesando el resultado…' : 'Pensando…'}</span><Elapsed since={busySince || Date.now()} /></div>}
        {busy && !!signalAt && !(last?.kind === 'tool' && last.status === 'ejecutando' && !last.streamed) && !(last?.kind === 'permission' && last.status === 'pendiente') && <Stall key={signalAt} at={signalAt} />}
        {shown.slice(shown.length - queuedN).map((it) => <ChatRow key={it.id} it={it} session={session} projectId={projectId} showThinking={showThinking} showCost={showCost} since={seen.current.get(it.id)} onUnqueue={unqueue} idle={idle} act={act} />)}
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
        {editing && (
          <div className="edit-banner">
            <Icon name="edit" size={14} /><span className="grow"><b>Editando tu mensaje.</b> Claude responde de nuevo desde ahí: lo que vino después se descarta (la conversación original queda en el historial; los cambios en el proyecto no se deshacen).</span>
            <Button size="xs" variant="ghost" icon="x" tip="Cancelar la edición" onClick={() => { setEditing(null); setText('') }} />
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
          <textarea ref={ta} rows={1} onPaste={onPaste} placeholder={busy ? (phone ? 'Escribile mientras trabaja…' : 'Escribile mientras trabaja: no lo interrumpe') : phone ? 'Pedile algo a Claude…' : touchUi ? 'Pedile algo a Claude… (@ menciona archivos del proyecto)' : 'Pedile algo a Claude… (@ para mencionar archivos)'} value={text}
            onChange={(e) => onTextChange(e.target.value, e.target.selectionStart)} onBlur={() => setTimeout(() => setMention(null), 150)}
            onKeyDown={onKey} />
          <div className="composer-bar">
            <Button size="sm" variant="ghost" icon="paperclip" tip="Adjuntar" active={attMenu.isOpen} onClick={attMenu.open} />
            {attMenu.render([
              { label: 'Fotograma actual', icon: 'camera', onSelect: attachFrame },
              { label: android ? 'Archivos de la tablet…' : phone ? 'Archivos del iPhone…' : 'Archivos…', icon: 'file', onSelect: pickFiles },
              { label: 'Mencionar un archivo del proyecto', icon: 'at', hint: '@', onSelect: () => { const v = text + (text && !/\s$/.test(text) ? ' @' : '@'); setText(v); onTextChange(v, v.length); ta.current?.focus() } },
            ], { placement: 'top' })}
            {!compactBar && <>
            <Select size="sm" variant="ghost" value={models.value(opts.model)} tip="Modelo" menuWidth={300} placement="top"
              renderValue={() => models.name(opts.model)}
              onChange={(v) => setOption({ model: v as string }, `Modelo: ${models.name(v as string)} (se aplica al próximo mensaje).`)}
              options={[{ header: 'Modelo' }, ...models.options]} />
            <Select size="sm" variant="ghost" value={opts.effort} tip="Nivel de esfuerzo (razonamiento)" menuWidth={280} placement="top"
              renderValue={() => <span className="row" style={{ gap: 6 }}><EffortBars n={effort.bars} />{effort.name}</span>}
              onChange={(v) => setOption({ effort: v as string }, `Esfuerzo: ${EFFORTS.find((e) => e.id === v)?.name} (se aplica al próximo mensaje).`)}
              options={[{ header: 'Nivel de esfuerzo' }, ...EFFORTS.map((e) => ({ value: e.id, label: e.name, desc: e.desc }))]} />
            <Button size="sm" variant="ghost" icon="leaf" active={saver} className={saver ? 'saver-on' : ''} tip={saver ? 'Modo ahorro activado: Claude gasta menos contexto (clic para desactivar)' : 'Modo ahorro desactivado (clic para activarlo)'}
              onClick={() => setOption({ saver: !saver }, saver ? 'Modo ahorro desactivado (se aplica al próximo mensaje).' : 'Modo ahorro activado (se aplica al próximo mensaje).')} />
            </>}
            <div className="grow" />
            {/* Trabajando: con algo escrito, el botón lo pone en cola; vacío, detiene a Claude. */}
            {busy && !text.trim() && !files.length
              ? <Button variant="danger" className="send-btn" icon="stop" tip="Detener" onClick={stop} />
              : <Button variant="primary" className="send-btn" icon="send" tip={busy ? 'Enviar sin interrumpir: Claude lo lee mientras trabaja' : 'Enviar'} kbd="Enter" onClick={send} disabled={!text.trim() && !files.length} />}
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
      <TextInput icon="search" placeholder="Buscar por título o mensaje…" value={q} onChange={setQ} autoFocus={!matchMedia('(pointer: coarse)').matches} clearable width="100%" />
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
