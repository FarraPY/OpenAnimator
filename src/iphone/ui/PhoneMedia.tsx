/**
 * Medios del proyecto en el teléfono: una grilla con miniaturas, importar desde Fotos o Archivos y, al tocar uno,
 * sus acciones (al timeline en el cursor, verlo, pedirle algo a Claude, renombrar, compartir, borrar).
 */
import { useEffect, useMemo, useState } from 'react'
import { Asset, call, fileUrl, fmtSize } from '../../api'
import { useApp } from '../../App'
import { useDialogs } from '../../components/Dialogs'
import { Icon, IconName } from '../../ui/icons'
import { Button, Empty, Spinner } from '../../ui/kit'
import { Actions, Chips, Sheet } from './PhoneApp'

const KIND: Record<Asset['kind'], { label: string; icon: IconName }> = {
  scene: { label: 'Escena', icon: 'code' }, video: { label: 'Video', icon: 'video' }, image: { label: 'Imagen', icon: 'image' },
  audio: { label: 'Audio', icon: 'music' }, doc: { label: 'Documento', icon: 'file' }, other: { label: 'Archivo', icon: 'file' },
}
type Filter = 'all' | Asset['kind']

export default function PhoneMedia({ projectId, assets, onRefresh, onAdd, onAsk }: { projectId: string; assets: Asset[]; onRefresh: () => void; onAdd: (a: Asset) => void; onAsk: (text: string) => void }) {
  const { toast } = useApp()
  const dlg = useDialogs()
  const [filter, setFilter] = useState<Filter>('all')
  const [importing, setImporting] = useState(false)
  const [acting, setActing] = useState<Asset | null>(null)
  const [viewing, setViewing] = useState<Asset | null>(null)
  const shown = useMemo(() => assets.filter((a) => filter === 'all' || a.kind === filter).sort((a, b) => (b.mtime || 0) - (a.mtime || 0)), [assets, filter])
  const kinds = useMemo(() => new Set(assets.map((a) => a.kind)), [assets])

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
    try { await call('assets:trash', projectId, [a.path]); onRefresh() } catch (e: any) { toast(e.message, true) }
  }

  return (
    <div className="med">
      <div className="med-head">
        <Button variant="primary" icon="import" onClick={importFiles} loading={importing}>Importar</Button>
        <span className="t3 med-hint">Fotos, videos, audio o archivos</span>
      </div>
      {assets.length > 0 && <div className="med-filters">
        <Chips value={filter} onChange={setFilter} options={[{ value: 'all' as Filter, label: 'Todo' }, ...(['scene', 'video', 'image', 'audio', 'doc'] as const).filter((k) => kinds.has(k)).map((k) => ({ value: k as Filter, label: KIND[k].label }))]} />
      </div>}
      <div className="med-scroll">
        {!assets.length ? <Empty icon="folder" title="Sin medios todavía" desc="Importá videos, fotos o audio, o pedile a Claude que genere imágenes, voz o música con tus plugins." compact />
          : <div className="med-grid">{shown.map((a) => <Tile key={a.path} projectId={projectId} a={a} onClick={() => setActing(a)} />)}</div>}
      </div>
      {acting && <Actions title={acting.name} onClose={() => setActing(null)} items={[
        ...(acting.kind === 'doc' || acting.kind === 'other' ? [] : [{ label: 'Agregar en el cursor', icon: 'plus' as IconName, onSelect: () => onAdd(acting) }]),
        { label: 'Ver', icon: 'eye', onSelect: () => setViewing(acting) },
        { label: 'Pedirle a Claude…', icon: 'sparkles', onSelect: () => onAsk(`Usá el archivo @${acting.path} para `) },
        { label: 'Renombrar…', icon: 'edit', onSelect: () => rename(acting) },
        { label: 'Compartir', icon: 'share', onSelect: () => call('assets:share', projectId, acting.path).catch(() => {}) },
        { sep: true },
        { label: 'Borrar', icon: 'trash', danger: true, onSelect: () => remove(acting) },
      ]} />}
      {viewing && <Viewer projectId={projectId} a={viewing} onClose={() => setViewing(null)} />}
      {dlg.element}
    </div>
  )
}

function Tile({ projectId, a, onClick }: { projectId: string; a: Asset; onClick: () => void }) {
  const [thumb, setThumb] = useState<string | null>(a.kind === 'image' ? fileUrl(projectId, a.path) : null)
  useEffect(() => {
    if (a.kind !== 'video') return
    let alive = true
    call<string>('media:thumb', projectId, a.path).then((u) => { if (alive) setThumb(u) }).catch(() => {})
    return () => { alive = false }
  }, [a.path])
  return (
    <button className={`mtile2 k-${a.kind}`} onClick={onClick}>
      <span className="mtile2-img" style={thumb ? { backgroundImage: `url("${thumb}")` } : undefined}>{!thumb && <Icon name={KIND[a.kind].icon} size={26} stroke={1.4} />}</span>
      <span className="mtile2-name ellipsis">{a.name}</span>
      <span className="mtile2-meta">{KIND[a.kind].label} · {fmtSize(a.size)}</span>
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
