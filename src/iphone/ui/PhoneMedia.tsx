/**
 * Medios del proyecto en el teléfono (la pestaña Medios de la hoja del editor): importar desde Fotos o Archivos, buscar,
 * filtrar por tipo y una grilla con miniaturas y duración. Tocar uno lo elige (se pueden elegir varios) y abajo aparece
 * «Añadir a timeline»; manteniéndolo apretado, sus acciones (ver, pedirle algo a Claude, renombrar, compartir, borrar).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Asset, call, fileUrl } from '../../api'
import { useApp } from '../../App'
import { useDialogs } from '../../components/Dialogs'
import { Icon, IconName } from '../../ui/icons'
import { Empty, Menu, Spinner } from '../../ui/kit'
import { flatMenu, Sheet } from './PhoneApp'

const KIND: Record<Asset['kind'], { label: string; icon: IconName }> = {
  scene: { label: 'Escenas', icon: 'code' }, video: { label: 'Video', icon: 'video' }, image: { label: 'Imágenes', icon: 'image' },
  audio: { label: 'Audio', icon: 'music' }, doc: { label: 'Documentos', icon: 'file' }, other: { label: 'Otros', icon: 'file' },
}
type Filter = 'all' | Asset['kind']
const durations = new Map<string, number>() // lo que dura cada audio o video (media:probe), por proyecto y archivo
const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}`

export default function PhoneMedia({ projectId, assets, onRefresh, onAdd, onAsk, full }: { projectId: string; assets: Asset[]; onRefresh: () => void; onAdd: (a: Asset[]) => void; onAsk: (text: string) => void; full?: boolean }) {
  const { toast } = useApp()
  const dlg = useDialogs()
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [importing, setImporting] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [acting, setActing] = useState<{ a: Asset; at: DOMRect } | null>(null)
  const [viewing, setViewing] = useState<Asset | null>(null)
  const q = query.trim().toLowerCase()
  const shown = useMemo(() => assets.filter((a) => (filter === 'all' || a.kind === filter) && (!q || a.name.toLowerCase().includes(q))).sort((a, b) => (b.mtime || 0) - (a.mtime || 0)), [assets, filter, q])
  const kinds = useMemo(() => new Set(assets.map((a) => a.kind)), [assets])
  const chosen = assets.filter((a) => picked.includes(a.path))

  const importFiles = async () => {
    setImporting(true)
    try { const added = await call<Asset[]>('assets:import', projectId); if (added?.length) { onRefresh(); toast(added.length === 1 ? `«${added[0].name}» importado` : `${added.length} archivos importados`) } } catch (e: any) { toast(e.message, true) } finally { setImporting(false) }
  }
  const rename = async (a: Asset) => {
    const name = await dlg.prompt({ title: 'Renombrar', value: a.name, ok: 'Renombrar' })
    if (name && name !== a.name) { try { await call('assets:rename', projectId, a.path, name); onRefresh() } catch (e: any) { toast(e.message, true) } }
  }
  const remove = async (a: Asset) => {
    const used = await call<number>('assets:usage', projectId, a.path).catch(() => 0)
    if (!(await dlg.confirm({ title: `¿Borrar «${a.name}»?`, message: used ? `Se usa ${used} ${used === 1 ? 'vez' : 'veces'} en el timeline: esos clips van a quedar sin archivo.` : 'Va a la papelera (se puede recuperar desde Ajustes).', ok: 'Borrar', danger: true }))) return
    try { await call('assets:trash', projectId, [a.path]); setPicked((xs) => xs.filter((x) => x !== a.path)); onRefresh() } catch (e: any) { toast(e.message, true) }
  }
  const toggle = (a: Asset) => {
    if (a.kind === 'doc' || a.kind === 'other') { setViewing(a); return } // no van al timeline: se abren
    setPicked((xs) => (xs.includes(a.path) ? xs.filter((x) => x !== a.path) : [...xs, a.path]))
  }

  return (
    <div className="med">
      <div className="med-head">
        <h2>Medios</h2>
        <button className="med-import" data-glass="accent" onClick={importFiles} disabled={importing}>{importing ? <Spinner size={15} /> : <Icon name="import" size={17} />}Importar</button>
      </div>
      {full && assets.length > 0 && <label className="med-search"><Icon name="search" size={17} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar medios" enterKeyHint="search" /></label>}
      {assets.length > 0 && <div className="med-filters">
        {([['all', 'Todo'], ...(['video', 'audio', 'image', 'scene', 'doc'] as const).filter((k) => kinds.has(k)).map((k) => [k, KIND[k].label])] as Array<[Filter, string]>).map(([k, label]) => (
          <button key={k} className={`med-chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{label}</button>
        ))}
      </div>}
      <div className="med-scroll">
        {!assets.length ? <Empty icon="folder" title="Sin medios todavía" desc="Importá videos, fotos o audio, o pedile a Claude que genere imágenes, voz o música con tus plugins." compact />
          : <>
            <div className="med-grid">{shown.map((a) => <Tile key={a.path} projectId={projectId} a={a} on={picked.includes(a.path)} onTap={() => toggle(a)} onHold={(at) => setActing({ a, at })} />)}</div>
            {!shown.length && <div className="t3 med-none">Nada con ese nombre.</div>}
          </>}
      </div>
      {chosen.length > 0 && <div className="med-pick">
        <span className="med-pick-th"><Icon name={KIND[chosen[0].kind].icon} size={20} /></span>
        <span className="med-pick-txt"><b>{chosen.length === 1 ? '1 seleccionado' : `${chosen.length} seleccionados`}</b><small className="ellipsis">{chosen.map((a) => a.name).join(', ')}</small></span>
        <button className="g-btn sm" aria-label="Quitar la selección" onClick={() => setPicked([])}><Icon name="x" size={18} /></button>
        <button className="med-add" data-glass="accent" onClick={() => { onAdd(chosen); setPicked([]) }}>Añadir a timeline</button>
      </div>}
      {acting && <Menu anchor={acting.at} align="start" onClose={() => setActing(null)} items={flatMenu([
        ...(acting.a.kind === 'doc' || acting.a.kind === 'other' ? [] : [{ label: 'Añadir en el cursor', icon: 'plus', onSelect: () => onAdd([acting.a]) }]),
        { label: 'Ver', icon: 'eye', onSelect: () => setViewing(acting.a) },
        { label: 'Pedirle a Claude…', icon: 'sparkles', onSelect: () => onAsk(`Usá el archivo @${acting.a.path} para `) },
        { label: 'Renombrar…', icon: 'edit', onSelect: () => rename(acting.a) },
        { label: 'Compartir', icon: 'share', onSelect: () => call('assets:share', projectId, acting.a.path).catch(() => {}) },
        { sep: true },
        { label: 'Borrar', icon: 'trash', danger: true, onSelect: () => remove(acting.a) },
      ])} />}
      {viewing && <Viewer projectId={projectId} a={viewing} onClose={() => setViewing(null)} />}
      {dlg.element}
    </div>
  )
}

/** Una miniatura: tocar la elige; mantener apretado, sus acciones. */
function Tile({ projectId, a, on, onTap, onHold }: { projectId: string; a: Asset; on: boolean; onTap: () => void; onHold: (at: DOMRect) => void }) {
  const [thumb, setThumb] = useState<string | null>(a.kind === 'image' ? fileUrl(projectId, a.path) : null)
  const key = projectId + '|' + a.path
  const [dur, setDur] = useState(durations.get(key))
  useEffect(() => {
    let alive = true
    if (a.kind === 'video') call<string>('media:thumb', projectId, a.path).then((u) => { if (alive) setThumb(u) }).catch(() => {})
    if ((a.kind === 'video' || a.kind === 'audio') && dur == null) call<{ duration?: number }>('media:probe', projectId, a.path).then((r) => { if (r?.duration) { durations.set(key, r.duration); if (alive) setDur(r.duration) } }).catch(() => {})
    return () => { alive = false }
  }, [a.path])
  const hold = useRef<{ timer: number; fired: boolean } | null>(null)
  const start = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement
    hold.current = { fired: false, timer: window.setTimeout(() => { if (hold.current) hold.current.fired = true; navigator.vibrate?.(10); onHold(el.getBoundingClientRect()) }, 480) }
  }
  const stop = () => { if (hold.current) clearTimeout(hold.current.timer) }
  return (
    <button className={`mtile2 k-${a.kind} ${on ? 'on' : ''}`} onPointerDown={start} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop} onContextMenu={(e) => e.preventDefault()}
      onClick={() => { if (hold.current?.fired) return; onTap() }}>
      <span className="mtile2-img" style={thumb ? { backgroundImage: `url("${thumb}")` } : undefined}>
        {!thumb && <Icon name={KIND[a.kind].icon} size={28} stroke={1.4} />}
        {dur != null && <span className="mtile2-dur tabnum">{clock(dur)}</span>}
        {on && <span className="mtile2-check"><Icon name="check" size={14} /></span>}
      </span>
      <span className="mtile2-name ellipsis">{a.name}</span>
    </button>
  )
}

function Viewer({ projectId, a, onClose }: { projectId: string; a: Asset; onClose: () => void }) {
  const url = fileUrl(projectId, a.path)
  const [text, setText] = useState<string | null>(null)
  useEffect(() => { if (a.kind === 'doc' || a.kind === 'scene') call<string>('assets:readText', projectId, a.path).then((x: any) => setText(typeof x === 'string' ? x : x?.text || '')).catch(() => setText('')) }, [a.path])
  return (
    <Sheet title={a.name} onClose={onClose} tall>
      <div className="viewer">
        {a.kind === 'image' && <img src={url} alt="" />}
        {a.kind === 'video' && <video src={url} controls playsInline />}
        {a.kind === 'audio' && <audio src={url} controls />}
        {(a.kind === 'doc' || a.kind === 'scene') && (text == null ? <Spinner /> : <pre className="viewer-text">{text.slice(0, 60000)}</pre>)}
      </div>
    </Sheet>
  )
}
