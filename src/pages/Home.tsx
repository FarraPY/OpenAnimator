import { useEffect, useMemo, useState } from 'react'
import { call, on, fmtTime, ProjectSummary, Template } from '../api'
import { isAndroid, isTouch, userTemplateUrl } from '../platform'
import { useApp } from '../App'
import Modal from '../components/Modal'
import { useDialogs } from '../components/Dialogs'
import SaveTemplate from '../components/SaveTemplate'
import Analyzer, { AnalysisReport } from '../components/Analyzer'
import { Icon, IconName, Logo } from '../ui/icons'
import { Badge, Button, Empty, Segmented, Select, TextInput, useMenu } from '../ui/kit'

const FORMATS = [
  { name: 'Horizontal', sub: '16:9', w: 1920, h: 1080 },
  { name: '4K', sub: '16:9', w: 3840, h: 2160 },
  { name: 'Vertical', sub: '9:16', w: 1080, h: 1920 },
  { name: 'Cuadrado', sub: '1:1', w: 1080, h: 1080 },
  { name: 'Retrato', sub: '4:5', w: 1080, h: 1350 },
  { name: 'HD', sub: '16:9', w: 1280, h: 720 },
]
const TEMPLATE_ICON: Record<string, IconName> = { documental: 'film', cinetico: 'zap', 'en-blanco': 'code' }

function ago(iso?: string) {
  if (!iso) return ''
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'hace un momento'
  if (s < 3600) return `hace ${Math.round(s / 60)} min`
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`
  if (s < 86400 * 30) return `hace ${Math.round(s / 86400)} d`
  return new Date(iso).toLocaleDateString()
}

export default function Home({ onOpen }: { onOpen: (id: string) => void }) {
  const { toast, info, settings, updateSettings, go } = useApp()
  const android = isAndroid(), touch = isTouch()
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  const [section, setSection] = useState<'projects' | 'templates'>('projects')
  const [newTpl, setNewTpl] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [importing, setImporting] = useState(false)
  const [analyzer, setAnalyzer] = useState(false)
  const [saveTpl, setSaveTpl] = useState<ProjectSummary | null>(null)
  const [detail, setDetail] = useState<Template | null>(null)
  const dlg = useDialogs()
  const view = settings?.ui.homeView || 'grid'
  const sort = settings?.ui.homeSort || 'recent'

  const refresh = () => call<ProjectSummary[]>('projects:list').then(setProjects).catch((e) => toast(e.message, true))
  const loadTemplates = () => call<Template[]>('projects:templates').then(setTemplates).catch(() => {})
  const delTpl = async (t: Template) => {
    if (!(await dlg.confirm({ title: `¿Borrar la plantilla «${t.name}»?`, message: android ? 'Se borra de la tablet. Los proyectos creados con ella no se tocan.' : 'Va a la papelera de Windows. Los proyectos creados con ella no se tocan.', ok: 'Borrar', danger: true }))) return
    try { await call('templates:delete', t.id); loadTemplates(); toast('Plantilla borrada') } catch (e: any) { toast(e.message, true) }
  }
  const renTpl = async (t: Template) => {
    const name = await dlg.prompt({ title: 'Renombrar plantilla', label: 'Nombre', value: t.name, ok: 'Renombrar' })
    if (name) { await call('templates:update', t.id, { name }); loadTemplates() }
  }
  useEffect(() => {
    refresh()
    loadTemplates()
    const k = (e: KeyboardEvent) => { if (e.ctrlKey && e.key === ',') { e.preventDefault(); go({ page: 'settings', from: { page: 'home' } }) } else if (e.ctrlKey && (e.key === 'n' || e.key === 'N') && !document.querySelector('.modal')) { e.preventDefault(); setNewTpl('') } }
    window.addEventListener('keydown', k)
    const off = on('projects:changed', () => call<ProjectSummary[]>('projects:list').then(setProjects).catch(() => {}))
    return () => { off(); window.removeEventListener('keydown', k) }
  }, [])

  const importCoa = async () => {
    setImporting(true)
    try {
      const p = await call('projects:importCoAnimator')
      if (p) { toast(`Importado «${p.name}» · ${p.timelines.length} timeline(s)`); refresh() }
    } catch (e: any) { toast(e.message, true) } finally { setImporting(false) }
  }
  const importZip = async () => {
    setImporting(true)
    try {
      const p = await call('projects:importZip')
      if (p) { toast(`Importado «${p.name}»`); refresh(); onOpen(p.id) }
    } catch (e: any) { toast(e.message, true) } finally { setImporting(false) }
  }
  const shareZip = async (p: ProjectSummary, action: 'share' | 'save') => {
    toast('Preparando el proyecto…', 'info')
    try { const r = await call('projects:exportZip', p.id, { action }); if (action === 'save' && r?.saved) toast('Proyecto guardado') } catch (e: any) { toast(e.message, true) }
  }
  const del = async (p: ProjectSummary) => {
    if (settings?.ui.confirmDelete !== false && !(await dlg.confirm({ title: `¿Mover «${p.name}» a la papelera?`, message: android ? 'Podés recuperarlo durante 30 días desde Ajustes › Almacenamiento.' : 'Podés recuperarlo desde la papelera de Windows.', ok: 'Mover a la papelera', danger: true }))) return
    try { await call('projects:delete', p.id); refresh(); toast('Proyecto movido a la papelera') } catch (e: any) { toast(e.message, true) }
  }
  const dup = async (p: ProjectSummary) => { try { await call('projects:duplicate', p.id); refresh(); toast('Proyecto duplicado') } catch (e: any) { toast(e.message, true) } }
  const ren = async (p: ProjectSummary) => {
    const name = await dlg.prompt({ title: 'Renombrar proyecto', label: 'Nombre', value: p.name, ok: 'Renombrar' })
    if (name) { await call('projects:rename', p.id, name); refresh() }
  }

  const list = useMemo(() => {
    const xs = (projects || []).filter((p) => p.name.toLowerCase().includes(q.toLowerCase()))
    if (sort === 'name') xs.sort((a, b) => a.name.localeCompare(b.name))
    else if (sort === 'duration') xs.sort((a, b) => b.duration - a.duration)
    else xs.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    return xs
  }, [projects, q, sort])
  const totalDur = (projects || []).reduce((n, p) => n + p.duration, 0)
  const nvencList = info ? ['h264', 'hevc', 'av1'].filter((c) => info.encoders[`${c}_nvenc`]).map((c) => c.toUpperCase()) : []

  return (
    <>
      <div className="titlebar">
        <div className="brand"><Logo size={22} />OpenAnimator</div>
        {info && <Badge tone="neutral">{android ? 'Android' : info.portable ? 'Portable' : 'Desarrollo'} · v{info.version}</Badge>}
        <div className="grow" />
        <Button variant="ghost" size="sm" icon="settings" tip="Ajustes" kbd="Ctrl+," onClick={() => go({ page: 'settings', from: { page: 'home' } })} />
      </div>
      <div className="home">
        <aside className="side">
          <div className="side-cta"><Button variant="primary" icon="plus" onClick={() => setNewTpl('')}>Nuevo proyecto</Button></div>
          <button className={`side-item ${section === 'projects' ? 'on' : ''}`} onClick={() => setSection('projects')}><Icon name="grid" />Proyectos<span className="count">{projects?.length ?? ''}</span></button>
          <button className={`side-item ${section === 'templates' ? 'on' : ''}`} onClick={() => setSection('templates')}><Icon name="template" />Plantillas<span className="count">{templates.length || ''}</span></button>
          <div className="side-label caps">Acciones</div>
          {android ? <>
            <button className="side-item" onClick={importZip} disabled={importing}><Icon name="import" />{importing ? 'Importando…' : 'Importar proyecto (.zip)'}</button>
            <button className="side-item" onClick={() => go({ page: 'settings', section: 'almacenamiento', from: { page: 'home' } })}><Icon name="trash" />Papelera</button>
          </> : <>
            <button className="side-item" onClick={() => setAnalyzer(true)}><Icon name="wand" />Plantilla desde un video</button>
            <button className="side-item" onClick={importCoa} disabled={importing}><Icon name="import" />{importing ? 'Importando…' : 'Importar de CoAnimator'}</button>
            <button className="side-item" onClick={() => call('projects:openFolder')}><Icon name="folder-open" />Carpeta de proyectos</button>
          </>}
          <button className="side-item" onClick={() => go({ page: 'settings', from: { page: 'home' } })}><Icon name="settings" />Ajustes</button>
          <div className="side-foot">
            <div className="sys">
              <div className="caps" style={{ marginBottom: 2 }}>Sistema</div>
              {android ? <>
                <SysRow icon="tablet" label={info?.gpu || 'Tablet'} state={info ? 'ok' : undefined} tip={(info as any)?.soc || 'Equipo'} />
                <SysRow icon="zap" label={info ? `${(info as any).codecs?.hevc ? 'H.264 · HEVC' : 'H.264'} por hardware` : 'Codificadores…'} state={info ? ((info as any).codecs?.avc !== false ? 'ok' : 'warn') : undefined} tip="Codificación de video" />
                <button className="sys-row sys-btn" onClick={() => go({ page: 'settings', section: 'ia', from: { page: 'home' } })}>
                  <Icon name="sparkles" size={14} /><span className="ellipsis">{info ? (info.claude ? 'Claude conectado (API)' : 'Falta la clave de Claude') : 'Claude…'}</span>{info && <span className={`sys-dot ${info.claude ? 'ok' : 'err'}`} />}
                </button>
              </> : <>
              <SysRow icon="gpu" label={info?.gpu || 'Detectando GPU…'} state={info ? (info.gpu ? 'ok' : 'warn') : undefined} tip="Tarjeta gráfica" />
              <SysRow icon="zap" label={info ? (nvencList.length ? `NVENC ${nvencList.join(' · ')}` : 'Sin NVENC (se usa CPU)') : 'Codificadores…'} state={info ? (nvencList.length ? 'ok' : 'warn') : undefined} tip="Codificación por hardware" />
              <SysRow icon="sparkles" label={info ? (info.claude ? 'Claude Code conectado' : 'Claude Code no instalado') : 'Claude Code…'} state={info ? (info.claude ? 'ok' : 'err') : undefined} tip={info?.claude || 'Instalalo desde claude.com/code'} />
              </>}
            </div>
          </div>
        </aside>

        <main className="main">
          {touch && <div className="portrait-nav">
            <Button variant="primary" icon="plus" onClick={() => setNewTpl('')}>Nuevo proyecto</Button>
            <button className={`side-item ${section === 'projects' ? 'on' : ''}`} onClick={() => setSection('projects')}><Icon name="grid" />Proyectos</button>
            <button className={`side-item ${section === 'templates' ? 'on' : ''}`} onClick={() => setSection('templates')}><Icon name="template" />Plantillas</button>
            {android && <button className="side-item" onClick={importZip}><Icon name="import" />Importar .zip</button>}
            <button className="side-item" onClick={() => go({ page: 'settings', from: { page: 'home' } })}><Icon name="settings" />Ajustes</button>
          </div>}
          {section === 'projects' ? (
            <div className="page">
              {projects && projects.length > 0 && (
                <div className="hero">
                  <h2>Hacé videos animados con Claude</h2>
                  <p>{android ? 'Escenas HTML/SVG deterministas, dirigidas por IA, verificadas fotograma a fotograma y exportadas con el codificador de hardware de tu tablet.' : <>Escenas HTML/SVG deterministas, dirigidas por IA, verificadas fotograma a fotograma y exportadas con la GPU{info?.gpu ? ` (${info.gpu.replace(/^NVIDIA /, '')})` : ''}.</>}</p>
                  <div className="hero-actions">
                    <Button variant="primary" icon="plus" onClick={() => setNewTpl('')}>Nuevo proyecto</Button>
                    <Button icon="template" onClick={() => setSection('templates')}>Ver plantillas</Button>
                  </div>
                  <div className="hero-stats">
                    <div><div className="stat-v tabnum">{projects.length}</div><div className="stat-l">proyectos</div></div>
                    <div><div className="stat-v tabnum">{projects.reduce((n, p) => n + p.timelines, 0)}</div><div className="stat-l">timelines</div></div>
                    <div><div className="stat-v tabnum">{fmtTime(totalDur)}</div><div className="stat-l">de video</div></div>
                  </div>
                </div>
              )}
              <div className="section-h">
                <h3>Proyectos</h3>
                <div className="grow" />
                <TextInput icon="search" size="sm" width={touch ? 260 : 230} placeholder="Buscar proyectos…" value={q} onChange={setQ} clearable />
                <Select size="sm" value={sort} icon="sort" width={touch ? 190 : 150} onChange={(v) => updateSettings({ ui: { homeSort: v } })}
                  options={[{ value: 'recent', label: 'Más recientes' }, { value: 'name', label: 'Nombre' }, { value: 'duration', label: 'Duración' }]} />
                <Segmented size="sm" value={view} onChange={(v) => updateSettings({ ui: { homeView: v } })}
                  options={[{ value: 'grid', icon: 'grid', tip: 'Cuadrícula' }, { value: 'list', icon: 'list', tip: 'Lista' }]} />
              </div>

              {projects && !list.length && (q
                ? <Empty icon="search" title="Sin resultados" desc={`Ningún proyecto coincide con «${q}».`} />
                : android
                  ? <Empty icon="film" title="Todavía no hay proyectos" desc="Empezá desde una plantilla o importá un proyecto (.zip) que hayas exportado desde OpenAnimator en la PC. Claude puede armar el video a partir de un guion.">
                    <Button variant="primary" icon="plus" onClick={() => setNewTpl('')}>Crear proyecto</Button>
                    <Button icon="import" onClick={importZip} loading={importing}>Importar proyecto (.zip)</Button>
                  </Empty>
                  : <Empty icon="film" title="Todavía no hay proyectos" desc="Empezá desde una plantilla o traé tus proyectos de CoAnimator. Claude puede armar el video a partir de un guion.">
                  <Button variant="primary" icon="plus" onClick={() => setNewTpl('')}>Crear proyecto</Button>
                  <Button icon="import" onClick={importCoa} loading={importing}>Importar de CoAnimator</Button>
                </Empty>)}

              {view === 'grid' ? (
                <div className="pgrid">
                  {list.map((p) => <ProjectCard key={p.id} p={p} onOpen={() => onOpen(p.id)} onRename={() => ren(p)} onDup={() => dup(p)} onDel={() => del(p)} onTemplate={() => setSaveTpl(p)} onShare={(a) => shareZip(p, a)} />)}
                </div>
              ) : list.length > 0 && (
                <div className="ptable">
                  <div className="prow head caps"><span /><span>Nombre</span><span>Formato</span><span>Timelines</span><span>Duración</span><span>Modificado</span><span /></div>
                  {list.map((p) => <ProjectRow key={p.id} p={p} onOpen={() => onOpen(p.id)} onRename={() => ren(p)} onDup={() => dup(p)} onDel={() => del(p)} onTemplate={() => setSaveTpl(p)} onShare={(a) => shareZip(p, a)} />)}
                </div>
              )}
            </div>
          ) : (
            <div className="page">
              <div className="page-head">
                <div className="grow">
                  <h1 className="page-title">Plantillas</h1>
                  <div className="page-desc">{android ? 'Empezá un proyecto con un estilo ya resuelto: las incluidas o las que guardaste de tus proyectos.' : 'Empezá un proyecto con un estilo ya resuelto: las incluidas, las que guardaste de tus proyectos o las que creaste analizando un video.'}</div>
                </div>
                {!android && <Button icon="folder-open" onClick={() => call('templates:openFolder')}>Carpeta</Button>}
                {!android && <Button variant="primary" icon="wand" onClick={() => setAnalyzer(true)}>Crear desde un video</Button>}
              </div>
              {!android && <div className="tpl-banner">
                <div className="tpl-banner-ico"><Icon name="youtube" size={26} /></div>
                <div className="grow">
                  <h3>Copiá el estilo de cualquier video</h3>
                  <p>Pegá un enlace de YouTube o elegí un archivo: Claude analiza colores, tipografía, animaciones, transiciones, formas, objetos, ritmo y narración, arma una escena de muestra y lo guarda como plantilla para tus próximos videos.</p>
                </div>
                <Button variant="primary" icon="sparkles" onClick={() => setAnalyzer(true)}>Analizar un video</Button>
              </div>}
              {templates.some((t) => t.user) && <>
                <div className="section-h"><h3>Mis plantillas</h3><span className="count-pill">{templates.filter((t) => t.user).length}</span></div>
                <div className="tgrid" style={{ marginBottom: 30 }}>
                  {templates.filter((t) => t.user).map((t) => <TemplateCard key={t.id} t={t} onUse={() => setNewTpl(t.id)} onDetail={() => setDetail(t)} onRename={() => renTpl(t)} onDelete={() => delTpl(t)} />)}
                </div>
              </>}
              <div className="section-h"><h3>Incluidas</h3></div>
              <div className="tgrid">
                {templates.filter((t) => !t.user).map((t) => (
                  <div key={t.id} className="tcard" onClick={() => setNewTpl(t.id)}>
                    <div className="tcard-img" style={t.preview ? { backgroundImage: `url("${t.preview}")` } : undefined}>{!t.preview && <Icon name={TEMPLATE_ICON[t.id] || 'template'} size={30} stroke={1.3} />}</div>
                    <div className="tcard-body">
                      <div className="tcard-name"><Icon name={TEMPLATE_ICON[t.id] || 'template'} size={15} />{t.name}<div className="grow" /><Button size="xs" variant="subtle" iconRight="arrow-right">Usar</Button></div>
                      <div className="tcard-desc">{t.description}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </main>
      </div>
      {analyzer && <Analyzer onClose={() => setAnalyzer(false)} onSaved={() => { setAnalyzer(false); loadTemplates(); setSection('templates') }} />}
      {saveTpl && <SaveTemplate projectId={saveTpl.id} projectName={saveTpl.name} onClose={() => setSaveTpl(null)} onSaved={() => loadTemplates()} />}
      {detail && <TemplateDetail t={detail} onClose={() => setDetail(null)} onUse={() => { setDetail(null); setNewTpl(detail.id) }} />}
      {newTpl !== null && <NewProject templates={templates} initial={newTpl} onClose={() => setNewTpl(null)} onCreated={(id) => { setNewTpl(null); onOpen(id) }} />}
      {dlg.element}
    </>
  )
}

function SysRow({ icon, label, state, tip }: { icon: IconName; label: string; state?: 'ok' | 'warn' | 'err'; tip?: string }) {
  return <div className="sys-row" data-tip={tip}><Icon name={icon} size={14} /><span className="ellipsis">{label}</span>{state && <span className={`sys-dot ${state}`} />}</div>
}

type CardProps = { p: ProjectSummary; onOpen: () => void; onRename: () => void; onDup: () => void; onDel: () => void; onTemplate: () => void; onShare: (action: 'share' | 'save') => void }
function useProjectMenu({ p, onOpen, onRename, onDup, onDel, onTemplate, onShare }: CardProps) {
  const m = useMenu()
  const items = [
    { label: 'Abrir', icon: 'arrow-right' as IconName, onSelect: onOpen },
    { label: 'Renombrar…', icon: 'edit' as IconName, onSelect: onRename },
    { label: 'Duplicar', icon: 'copy' as IconName, onSelect: onDup },
    { label: 'Guardar como plantilla…', icon: 'bookmark' as IconName, onSelect: onTemplate },
    ...(isAndroid() ? [
      { sep: true as const },
      { label: 'Compartir (.zip)', icon: 'share' as IconName, desc: 'Para abrirlo en la PC o en otra tablet', onSelect: () => onShare('share') },
      { label: 'Guardar en Archivos (.zip)', icon: 'download' as IconName, onSelect: () => onShare('save') },
    ] : [{ label: 'Mostrar en carpeta', icon: 'folder-open' as IconName, onSelect: () => call('projects:openFolder', p.id) }]),
    { sep: true as const },
    { label: 'Mover a la papelera', icon: 'trash' as IconName, danger: true, onSelect: onDel },
  ]
  return { m, items }
}

function ProjectCard(props: CardProps) {
  const { p, onOpen } = props
  const { m, items } = useProjectMenu(props)
  return (
    <div className="pcard" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === 'Enter' && onOpen()} onContextMenu={(e) => { e.preventDefault(); m.openAt(e.clientX, e.clientY) }}>
      <div className="pcard-thumb" style={p.thumb ? { backgroundImage: `url("${p.thumb}?${p.updatedAt}")` } : undefined}>
        {!p.thumb && <div className="pcard-empty"><Icon name="film" size={28} stroke={1.3} /></div>}
        <div className="pcard-play"><span><Icon name="play" size={18} /></span></div>
        <span className="pcard-res">{p.width}×{p.height}</span>
        <span className="pcard-dur">{fmtTime(p.duration)}</span>
      </div>
      <div className={`pcard-more ${m.isOpen ? 'open' : ''}`} onClick={(e) => e.stopPropagation()}><Button size="sm" variant="ghost" icon="more" tip="Más acciones" onClick={m.open} /></div>
      <div className="pcard-body">
        <div className="pcard-name ellipsis">{p.name}</div>
        <div className="pcard-meta">{p.timelines} timeline{p.timelines !== 1 ? 's' : ''}<span className="dot-sep" />{p.fps} fps{p.updatedAt && <><span className="dot-sep" />{ago(p.updatedAt)}</>}</div>
      </div>
      {m.render(items, { align: 'end' })}
    </div>
  )
}

function ProjectRow(props: CardProps) {
  const { p, onOpen } = props
  const { m, items } = useProjectMenu(props)
  return (
    <div className="prow" onClick={onOpen} onContextMenu={(e) => { e.preventDefault(); m.openAt(e.clientX, e.clientY) }}>
      <div className="prow-thumb" style={p.thumb ? { backgroundImage: `url("${p.thumb}?${p.updatedAt}")` } : undefined} />
      <span className="ellipsis" style={{ fontWeight: 600 }}>{p.name}</span>
      <span className="t2">{p.width}×{p.height} · {p.fps} fps</span>
      <span className="t2 tabnum">{p.timelines}</span>
      <span className="t2 mono">{fmtTime(p.duration)}</span>
      <span className="t3">{ago(p.updatedAt)}</span>
      <span onClick={(e) => e.stopPropagation()}><Button size="sm" variant="ghost" icon="more" onClick={m.open} /></span>
      {m.render(items, { align: 'end' })}
    </div>
  )
}

function NewProject({ templates, initial, onClose, onCreated }: { templates: Template[]; initial: string; onClose: () => void; onCreated: (id: string) => void }) {
  const { toast } = useApp()
  const [tpl, setTpl] = useState(initial || templates[0]?.id || '')
  const [name, setName] = useState('Mi video')
  const [fmt, setFmt] = useState(0)
  const [fps, setFps] = useState(30)
  const [busy, setBusy] = useState(false)
  // Las plantillas propias recuerdan su formato: se preselecciona.
  useEffect(() => {
    const t = templates.find((x) => x.id === tpl)
    if (!t?.user || !t.width || !t.height) return
    const i = FORMATS.findIndex((f) => f.w === t.width && f.h === t.height)
    if (i >= 0) setFmt(i)
    if (t.fps) setFps(t.fps)
  }, [tpl])
  const create = async () => {
    setBusy(true)
    try {
      const f = FORMATS[fmt]
      const p = await call('projects:create', { name: name.trim() || 'Mi video', template: tpl, width: f.w, height: f.h, fps })
      onCreated(p.id)
    } catch (e: any) { toast(e.message, true); setBusy(false) }
  }
  return (
    <Modal size="wide" icon="plus" title="Nuevo proyecto" subtitle="Elegí una plantilla y un formato. Podés cambiar todo después." onClose={onClose}
      footer={<><span className="t3" style={{ fontSize: 12 }}>{FORMATS[fmt].w}×{FORMATS[fmt].h} · {fps} fps</span><div className="grow" /><Button onClick={onClose}>Cancelar</Button><Button variant="primary" icon="check" onClick={create} disabled={!tpl} loading={busy}>Crear proyecto</Button></>}>
      <div className="fields" style={{ gridTemplateColumns: '1fr auto', marginBottom: 18 }}>
        <div className="field"><label className="field-label">Nombre</label><TextInput autoFocus value={name} onChange={setName} onEnter={create} /></div>
        <div className="field"><label className="field-label">Cuadros por segundo</label>
          <Segmented value={fps} onChange={setFps} options={[24, 25, 30, 50, 60].map((f) => ({ value: f, label: String(f) }))} /></div>
      </div>
      <div className="field-label" style={{ marginBottom: 8 }}>Formato</div>
      <div className="fmt-grid" style={{ marginBottom: 20 }}>
        {FORMATS.map((f, i) => {
          const s = 30 / Math.max(f.w, f.h)
          return (
            <div key={i} className={`fmt ${fmt === i ? 'on' : ''}`} onClick={() => setFmt(i)}>
              <div className="fmt-shape"><div style={{ width: f.w * s, height: f.h * s }} /></div>
              <div className="fmt-name">{f.name}</div><div className="fmt-sub">{f.sub} · {f.h >= 2160 ? '2160p' : f.w === 1280 ? '720p' : `${f.w}×${f.h}`}</div>
            </div>
          )
        })}
      </div>
      <div className="field-label" style={{ marginBottom: 8 }}>Plantilla</div>
      <div className="tgrid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
        {templates.map((t) => (
          <div key={t.id} className={`tcard ${tpl === t.id ? 'sel' : ''}`} onClick={() => setTpl(t.id)} onDoubleClick={create}>
            <div className="tcard-img" style={t.preview ? { backgroundImage: `url("${t.preview}")` } : undefined}>{!t.preview && <Icon name={TEMPLATE_ICON[t.id] || 'template'} size={26} stroke={1.3} />}</div>
            <div className="tcard-body" style={{ padding: '10px 12px 12px' }}>
              <div className="tcard-name"><span className="ellipsis">{t.name}</span>{t.user && <Badge tone={t.hasAnalysis ? 'accent' : 'neutral'}>{t.hasAnalysis ? 'video' : 'tuya'}</Badge>}{tpl === t.id && <><div className="grow" /><Icon name="check-circle" size={16} style={{ color: 'var(--accent-t)', flex: 'none' }} /></>}</div>
              <div className="tcard-desc">{t.description}</div>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  )
}

function TemplateCard({ t, onUse, onDetail, onRename, onDelete }: { t: Template; onUse: () => void; onDetail: () => void; onRename: () => void; onDelete: () => void }) {
  const m = useMenu()
  const items = [
    { label: 'Nuevo proyecto con esta plantilla', icon: 'plus' as IconName, onSelect: onUse },
    ...(t.hasAnalysis ? [{ label: 'Ver análisis del video', icon: 'scan' as IconName, onSelect: onDetail }] : []),
    { label: 'Renombrar…', icon: 'edit' as IconName, onSelect: onRename },
    { sep: true as const },
    { label: 'Borrar plantilla', icon: 'trash' as IconName, danger: true, onSelect: onDelete },
  ]
  return (
    <div className="tcard" onClick={onUse} onContextMenu={(e) => { e.preventDefault(); m.openAt(e.clientX, e.clientY) }}>
      <span className="tcard-badge"><Badge tone={t.hasAnalysis ? 'accent' : 'neutral'} icon={t.hasAnalysis ? 'youtube' : 'bookmark'}>{t.hasAnalysis ? 'Desde video' : 'Desde proyecto'}</Badge></span>
      <div className={`tcard-more ${m.isOpen ? 'open' : ''}`} onClick={(e) => e.stopPropagation()}><Button size="sm" variant="ghost" icon="more" tip="Más acciones" onClick={m.open} /></div>
      <div className="tcard-img" style={t.preview ? { backgroundImage: `url("${t.preview}")` } : undefined}>{!t.preview && <Icon name="template" size={30} stroke={1.3} />}</div>
      <div className="tcard-body">
        <div className="tcard-name"><span className="ellipsis">{t.name}</span><div className="grow" />{t.hasAnalysis && <Button size="xs" variant="ghost" icon="scan" tip="Ver análisis" onClick={(e) => { e.stopPropagation(); onDetail() }} />}<Button size="xs" variant="subtle" iconRight="arrow-right">Usar</Button></div>
        <div className="tcard-desc">{t.description || (t.fromProject ? `Guardada desde «${t.fromProject}»` : '')}</div>
      </div>
      {m.render(items, { align: 'end' })}
    </div>
  )
}

function TemplateDetail({ t, onClose, onUse }: { t: Template; onClose: () => void; onUse: () => void }) {
  const [full, setFull] = useState<any>(null)
  useEffect(() => { call('templates:get', t.id).then(setFull).catch(() => setFull({})) }, [t.id])
  const a = full?.analysis
  const pal: Array<{ hex: string; share: number }> = a?.medido?.palette || []
  return (
    <Modal size="xl" icon="scan" title={t.name} subtitle={a?.fuente?.origen ? `Analizado de ${a.fuente.titulo || a.fuente.origen}` : t.description} onClose={onClose}
      footer={<>{a?.fuente?.origen && /^https?:/.test(a.fuente.origen) && <Button variant="ghost" icon="external" onClick={() => call('shell:openExternal', a.fuente.origen)}>Ver el video original</Button>}<div className="grow" /><Button onClick={onClose}>Cerrar</Button><Button variant="primary" icon="plus" onClick={onUse}>Nuevo proyecto con esta plantilla</Button></>}>
      {!full ? <div className="row t3"><Icon name="clock" />Cargando…</div> : (
        <div className="an-result">
          <div className="an-left">
            {t.preview && <img className="an-sheet" src={t.preview} alt="" />}
            <div className="caps" style={{ margin: '14px 0 6px' }}>Fotogramas del video analizado</div>
            <img className="an-sheet" src={userTemplateUrl(t.id, 'referencia.jpg')} alt="" onError={(e) => { e.currentTarget.style.display = 'none' }} />
            {pal.length > 0 && <><div className="caps" style={{ margin: '14px 0 6px' }}>Paleta medida</div><div className="an-palbar">{pal.map((p) => <div key={p.hex} style={{ background: p.hex, flex: p.share }} data-tip={`${p.hex} · ${Math.round(p.share * 100)} %`} />)}</div></>}
          </div>
          <div className="an-right"><AnalysisReport a={a} /></div>
        </div>
      )}
    </Modal>
  )
}
