import { memo, useEffect, useRef, useState } from 'react'
import { Asset, call, fileUrl, fmtSize } from '../api'
import { useApp } from '../App'
import { Icon, IconName } from '../ui/icons'
import { Button, Empty, Menu, MenuItem, Segmented, Spinner, TextInput } from '../ui/kit'
import { useDialogs } from './Dialogs'
import Modal from './Modal'
import { Markdown } from './ChatPanel'

const KINDS: Array<{ kind: Asset['kind']; label: string; icon: IconName; color: string }> = [
  { kind: 'scene', label: 'Escenas', icon: 'code', color: 'var(--scene)' },
  { kind: 'video', label: 'Video', icon: 'video', color: 'var(--video)' },
  { kind: 'image', label: 'Imágenes', icon: 'image', color: 'var(--image)' },
  { kind: 'audio', label: 'Audio', icon: 'music', color: 'var(--audio)' },
  { kind: 'doc', label: 'Documentos', icon: 'story', color: 'var(--doc)' },
]
const K = Object.fromEntries(KINDS.map((k) => [k.kind, k]))
const canAdd = (a: Asset) => a.kind !== 'doc' && a.kind !== 'other'
const isText = (a: Asset) => a.kind === 'doc' && !/\.(pdf|docx)$/i.test(a.path)
const recent = (a: Asset) => a.mtime && Date.now() - a.mtime < 10 * 60 * 1000

const thumbs = new Map<string, Promise<string | null>>()
const Thumb = memo(function Thumb({ projectId, a, hover }: { projectId: string; a: Asset; hover: boolean }) {
  const [url, setUrl] = useState<string | null>(a.kind === 'image' ? fileUrl(projectId, a.path) : null)
  useEffect(() => {
    if (a.kind !== 'video') return
    const k = projectId + '|' + a.path
    if (!thumbs.has(k)) thumbs.set(k, call('media:thumb', projectId, a.path).catch(() => null))
    let on = true; thumbs.get(k)!.then((u) => on && setUrl(u)); return () => { on = false }
  }, [projectId, a.path])
  const meta = K[a.kind]
  return (
    <div className="mtile-img" style={url ? { backgroundImage: `url("${url}")` } : { background: `linear-gradient(135deg, color-mix(in srgb, ${meta?.color} 26%, var(--bg-2)), var(--bg-2))` }}>
      {/* Al pasar el mouse, los videos se reproducen sin sonido dentro de la miniatura. */}
      {a.kind === 'video' && hover && <video className="mtile-video" src={fileUrl(projectId, a.path)} muted autoPlay loop playsInline />}
      {!url && <Icon name={meta?.icon || 'file'} size={22} stroke={1.5} style={{ color: meta?.color, opacity: .9 }} />}
      {url && <span className="mtile-kind" style={{ background: meta?.color }}><Icon name={meta?.icon || 'file'} size={11} stroke={2.2} /></span>}
    </div>
  )
})

/** Botón de reproducir/pausar para audio, compartido por todo el panel (suena uno por vez). */
let player: HTMLAudioElement | null = null
function useAudio() {
  const [playing, setPlaying] = useState<string | null>(null)
  useEffect(() => () => { player?.pause() }, [])
  const toggle = (url: string) => {
    if (playing === url) { player?.pause(); setPlaying(null); return }
    player?.pause()
    player = new Audio(url)
    player.onended = () => setPlaying(null)
    player.play().catch(() => setPlaying(null))
    setPlaying(url)
  }
  return { playing, toggle, stop: () => { player?.pause(); setPlaying(null) } }
}

export default function MediaPanel({ projectId, assets, onRefresh, onAdd }: { projectId: string; assets: Asset[]; onRefresh: () => void; onAdd: (a: Asset) => void }) {
  const { toast } = useApp()
  const dlg = useDialogs()
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<Asset['kind'] | 'all'>('all')
  const [view, setView] = useState<'grid' | 'list'>(() => { try { return (localStorage.getItem('oa.mediaView') as any) || 'grid' } catch { return 'grid' } })
  const [drop, setDrop] = useState(false)
  const [sel, setSel] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; a: Asset } | null>(null)
  const [full, setFull] = useState<Asset | null>(null)
  const audio = useAudio()
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => { try { localStorage.setItem('oa.mediaView', view) } catch { /* ignore */ } }, [view])
  useEffect(() => { if (sel && !assets.some((a) => a.path === sel)) setSel(null) }, [assets, sel])

  const importFiles = async (paths?: string[]) => {
    try { const added: string[] = await call('assets:import', projectId, paths); if (added.length) { toast(`${added.length} archivo(s) agregado(s)`); onRefresh() } } catch (e: any) { toast(e.message, true) }
  }
  const remove = async (a: Asset) => {
    let uses: Array<{ timeline: string; count: number }> = []
    try { uses = await call('assets:usage', projectId, a.path) } catch { /* ignore */ }
    const ok = await dlg.confirm({
      title: `¿Eliminar «${a.name}»?`, danger: true, ok: 'Mandar a la papelera', icon: 'trash',
      message: <>El archivo va a la <b>Papelera de reciclaje</b> de Windows (se puede recuperar desde ahí).{uses.length ? <><br /><br /><span style={{ color: 'var(--warn)' }}>Está usado en {uses.map((u) => `«${u.timeline}» (${u.count} clip${u.count > 1 ? 's' : ''})`).join(', ')}: esos clips van a quedar sin archivo.</span></> : null}</>,
    })
    if (!ok) return
    try {
      if (audio.playing?.endsWith(encodeURIComponent(a.name))) audio.stop()
      await call('assets:trash', projectId, [a.path]); toast(`«${a.name}» enviado a la papelera`); setSel(null); onRefresh()
    } catch (e: any) { toast(e.message, true) }
  }
  const menuItems = (a: Asset): MenuItem[] => [
    { header: a.path },
    ...(canAdd(a) ? [{ label: 'Agregar al timeline', icon: 'plus' as IconName, hint: 'doble clic', onSelect: () => onAdd(a) }] : []),
    ...(a.kind === 'audio' ? [{ label: audio.playing === fileUrl(projectId, a.path) ? 'Detener' : 'Escuchar', icon: 'play' as IconName, onSelect: () => audio.toggle(fileUrl(projectId, a.path)) }] : []),
    { label: 'Vista previa', icon: 'eye', onSelect: () => (a.kind === 'doc' || a.kind === 'video' || a.kind === 'image') ? setFull(a) : setSel(a.path) },
    { label: 'Abrir con la app predeterminada', icon: 'external', onSelect: () => call('assets:open', projectId, a.path) },
    { label: 'Mostrar en la carpeta', icon: 'folder-open', onSelect: () => call('project:reveal', projectId, a.path) },
    { sep: true },
    { label: 'Eliminar…', icon: 'trash', danger: true, kbd: 'Supr', onSelect: () => remove(a) },
  ]

  const list = assets.filter((a) => a.path.toLowerCase().includes(q.toLowerCase()) && (kind === 'all' || a.kind === kind))
  const counts = Object.fromEntries(KINDS.map((k) => [k.kind, assets.filter((a) => a.kind === k.kind).length]))
  const selAsset = assets.find((a) => a.path === sel) || null
  const item = (a: Asset) => ({
    draggable: canAdd(a),
    tabIndex: 0,
    'data-tip': `${a.path} · ${fmtSize(a.size)} — ${canAdd(a) ? 'arrastrá al timeline o doble clic' : 'doble clic para leerlo'}`,
    onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData('application/x-oa-asset', JSON.stringify(a)); e.dataTransfer.effectAllowed = 'copy' },
    onClick: () => setSel(a.path),
    onDoubleClick: () => (canAdd(a) ? onAdd(a) : setFull(a)),
    onMouseEnter: () => setHover(a.path), onMouseLeave: () => setHover((h) => (h === a.path ? null : h)),
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Delete') { e.preventDefault(); e.stopPropagation(); remove(a) } else if (e.key === ' ' && a.kind === 'audio') { e.preventDefault(); e.stopPropagation(); audio.toggle(fileUrl(projectId, a.path)) } },
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); setSel(a.path); setMenu({ x: e.clientX, y: e.clientY, a }) },
  })
  const playBtn = (a: Asset) => {
    if (a.kind !== 'audio') return null
    const url = fileUrl(projectId, a.path), on = audio.playing === url
    return <button className={`mplay ${on ? 'on' : ''}`} data-tip={on ? 'Detener' : 'Escuchar'} onClick={(e) => { e.stopPropagation(); audio.toggle(url) }} onDoubleClick={(e) => e.stopPropagation()}><Icon name={on ? 'pause' : 'play'} size={12} stroke={2.4} /></button>
  }

  return (
    <div className={`pane pane-left ${drop ? 'drop' : ''}`} style={{ height: '100%' }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrop(true) } }}
      onDragLeave={() => setDrop(false)}
      onDrop={(e) => { setDrop(false); if (!e.dataTransfer.files.length) return; e.preventDefault(); importFiles([...e.dataTransfer.files].map((f) => window.oa.pathForFile(f))) }}>
      <div className="pane-head">
        <span className="pane-title">Medios</span><span className="t3 tabnum" style={{ fontSize: 11.5 }}>{assets.length}</span>
        <div className="grow" />
        <Segmented size="sm" value={view} onChange={setView} options={[{ value: 'grid', icon: 'grid', tip: 'Miniaturas' }, { value: 'list', icon: 'list', tip: 'Lista' }]} />
        <Button size="sm" variant="ghost" icon="plus" tip="Agregar archivos" onClick={() => importFiles()} />
      </div>
      <div className="media-tools"><TextInput icon="search" size="sm" placeholder="Buscar medios…" value={q} onChange={setQ} clearable width="100%" /></div>
      <div className="media-filters">
        <button className={`chip-f ${kind === 'all' ? 'on' : ''}`} onClick={() => setKind('all')}>Todo</button>
        {KINDS.filter((k) => counts[k.kind]).map((k) => (
          <button key={k.kind} className={`chip-f ${kind === k.kind ? 'on' : ''}`} onClick={() => setKind(kind === k.kind ? 'all' : k.kind)}>
            <Icon name={k.icon} size={11} stroke={2} style={{ color: kind === k.kind ? undefined : k.color }} />{k.label}<span className="t3">{counts[k.kind]}</span>
          </button>
        ))}
      </div>
      <div className="pane-body" ref={body} onClick={(e) => { if (e.target === e.currentTarget) setSel(null) }}>
        {KINDS.map((k) => {
          const items = list.filter((a) => a.kind === k.kind)
          if (!items.length) return null
          return (
            <div key={k.kind}>
              {kind === 'all' && <div className="media-group-h caps"><Icon name={k.icon} size={12} style={{ color: k.color }} />{k.label}<span className="t4">{items.length}</span></div>}
              {view === 'grid' ? (
                <div className="mgrid">
                  {items.map((a) => (
                    <div key={a.path} className={`mtile ${sel === a.path ? 'sel' : ''}`} {...item(a)}>
                      <Thumb projectId={projectId} a={a} hover={hover === a.path} />
                      {playBtn(a)}
                      {recent(a) && <span className="mnew">nuevo</span>}
                      <div className="mtile-name">{a.name}</div>
                    </div>
                  ))}
                </div>
              ) : items.map((a) => (
                <div key={a.path} className={`mlist-item ${sel === a.path ? 'sel' : ''}`} {...item(a)}>
                  <span className="mlist-icon" style={{ background: `color-mix(in srgb, ${k.color} 70%, #000)` }}><Icon name={k.icon} size={12} stroke={2} /></span>
                  <span className="grow ellipsis">{a.path}</span>{recent(a) && <span className="mnew inline">nuevo</span>}{playBtn(a)}<span className="t3" style={{ fontSize: 11 }}>{fmtSize(a.size)}</span>
                </div>
              ))}
            </div>
          )
        })}
        {!list.length && (assets.length
          ? <Empty compact icon="search" title="Sin resultados" />
          : <Empty compact icon="import" title="Sin medios" desc="Arrastrá video, audio, imágenes, escenas .html o guiones, o usá el botón +.">
            <Button size="sm" icon="plus" onClick={() => importFiles()}>Agregar archivos</Button>
          </Empty>)}
      </div>
      {selAsset && <Preview projectId={projectId} a={selAsset} audio={audio} onAdd={() => onAdd(selAsset)} onFull={() => setFull(selAsset)} onDelete={() => remove(selAsset)} onClose={() => setSel(null)} />}
      {menu && <Menu anchor={{ x: menu.x, y: menu.y }} items={menuItems(menu.a)} onClose={() => setMenu(null)} width={250} />}
      {full && <FullPreview projectId={projectId} a={full} onClose={() => setFull(null)} onAdd={canAdd(full) ? () => { onAdd(full); setFull(null) } : undefined} />}
      {dlg.element}
    </div>
  )
}

/** Vista previa del medio seleccionado, abajo del panel. */
function Preview({ projectId, a, audio, onAdd, onFull, onDelete, onClose }: { projectId: string; a: Asset; audio: ReturnType<typeof useAudio>; onAdd: () => void; onFull: () => void; onDelete: () => void; onClose: () => void }) {
  const url = fileUrl(projectId, a.path)
  const [text, setText] = useState<string | null>(null)
  const [dur, setDur] = useState<number | null>(null)
  useEffect(() => {
    setText(null); setDur(null)
    if (isText(a)) call('assets:readText', projectId, a.path).then((r) => setText(r.text.slice(0, 1400))).catch(() => setText(''))
  }, [projectId, a.path])
  useEffect(() => { if (a.kind === 'audio') audio.stop() }, [a.path])
  const meta = K[a.kind]
  return (
    <div className="mprev">
      <div className="mprev-head">
        <Icon name={meta?.icon || 'file'} size={13} style={{ color: meta?.color }} />
        <span className="ellipsis grow" data-tip={a.path}><b>{a.name}</b></span>
        <span className="t3 tabnum" style={{ fontSize: 11 }}>{dur ? `${dur.toFixed(1)} s · ` : ''}{fmtSize(a.size)}</span>
        <Button size="xs" variant="ghost" icon="x" tip="Cerrar vista previa" onClick={onClose} />
      </div>
      <div className="mprev-body">
        {a.kind === 'video' && <video key={url} src={url} controls preload="metadata" onLoadedMetadata={(e) => setDur(e.currentTarget.duration)} />}
        {a.kind === 'audio' && <audio key={url} src={url} controls preload="metadata" onLoadedMetadata={(e) => setDur(e.currentTarget.duration)} onPlay={() => audio.stop()} />}
        {a.kind === 'image' && <img src={url} alt="" onClick={onFull} />}
        {a.kind === 'scene' && <div className="mprev-note"><Icon name="code" size={16} />Escena animada (HTML). Agregala al timeline para verla en el visor.</div>}
        {a.kind === 'doc' && (isText(a)
          ? text == null ? <div className="row t3" style={{ gap: 8, padding: 8 }}><Spinner size={12} />Cargando…</div> : <pre className="mprev-text" onClick={onFull}>{text || '(vacío)'}</pre>
          : <div className="mprev-note"><Icon name="story" size={16} />Documento {a.path.split('.').pop()?.toUpperCase()}. Abrilo con la app predeterminada.</div>)}
      </div>
      <div className="mprev-actions">
        {canAdd(a) && <Button size="xs" icon="plus" onClick={onAdd}>Al timeline</Button>}
        {(a.kind === 'doc' && isText(a)) || a.kind === 'image' || a.kind === 'video' ? <Button size="xs" variant="ghost" icon="maximize" onClick={onFull}>Ampliar</Button> : null}
        {a.kind === 'doc' && !isText(a) && <Button size="xs" variant="ghost" icon="external" onClick={() => call('assets:open', projectId, a.path)}>Abrir</Button>}
        <div className="grow" />
        <Button size="xs" variant="ghost" icon="folder-open" tip="Mostrar en la carpeta" onClick={() => call('project:reveal', projectId, a.path)} />
        <Button size="xs" variant="ghost" icon="trash" tip="Eliminar (Supr)" onClick={onDelete} />
      </div>
    </div>
  )
}

/** Vista ampliada: documentos (markdown legible), imágenes y videos. */
function FullPreview({ projectId, a, onClose, onAdd }: { projectId: string; a: Asset; onClose: () => void; onAdd?: () => void }) {
  const url = fileUrl(projectId, a.path)
  const [doc, setDoc] = useState<{ text: string; truncated: boolean } | null>(null)
  useEffect(() => { if (isText(a)) call('assets:readText', projectId, a.path).then(setDoc).catch((e) => setDoc({ text: String(e.message), truncated: false })) }, [a.path])
  return (
    <Modal size="xl" title={a.name} subtitle={<span className="mono">{a.path} · {fmtSize(a.size)}</span>} icon={K[a.kind]?.icon || 'file'} onClose={onClose}
      footer={<><Button variant="ghost" icon="folder-open" onClick={() => call('project:reveal', projectId, a.path)}>Mostrar en la carpeta</Button><Button variant="ghost" icon="external" onClick={() => call('assets:open', projectId, a.path)}>Abrir con…</Button><div className="grow" />{onAdd && <Button icon="plus" onClick={onAdd}>Agregar al timeline</Button>}<Button variant="primary" onClick={onClose}>Cerrar</Button></>}>
      {a.kind === 'video' && <video src={url} controls autoPlay style={{ width: '100%', maxHeight: '64vh', background: '#000', borderRadius: 8 }} />}
      {a.kind === 'image' && <img src={url} alt="" style={{ maxWidth: '100%', maxHeight: '64vh', display: 'block', margin: '0 auto', borderRadius: 8 }} />}
      {a.kind === 'doc' && (doc == null ? <div className="row t3" style={{ gap: 8 }}><Spinner size={12} />Cargando…</div>
        : <div className="doc-view">
          {/\.md$/i.test(a.path) ? <Markdown text={doc.text} /> : <pre>{/\.json$/i.test(a.path) ? (() => { try { return JSON.stringify(JSON.parse(doc.text), null, 2) } catch { return doc.text } })() : doc.text}</pre>}
          {doc.truncated && <div className="notice warn" style={{ marginTop: 10 }}><Icon name="alert" size={14} />El archivo es muy largo: se muestran los primeros 200 KB. Abrilo con la app predeterminada para verlo completo.</div>}
        </div>)}
    </Modal>
  )
}
