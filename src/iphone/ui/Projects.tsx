/**
 * Inicio en el iPhone (el diseño del usuario): los proyectos con buscador, en cuadrícula o en lista, ordenados por fecha,
 * nombre o duración; cada uno con su menú de iOS (⋯) y abajo el botón para crear uno nuevo (formato vertical por
 * defecto: es un teléfono).
 */
import { useEffect, useMemo, useState } from 'react'
import { call, fmtTime, on, ProjectSummary, Template } from '../../api'
import { useApp } from '../../App'
import { useDialogs } from '../../components/Dialogs'
import { Icon, Logo } from '../../ui/icons'
import { Button, Empty, Spinner, TextInput } from '../../ui/kit'
import { Chips, MenuButton, Sheet, Tap, TopBar } from './PhoneApp'
import PhoneSaveTemplate from './PhoneSaveTemplate'

export const FORMATS = [
  { id: 'v', name: 'Vertical', sub: '9:16', w: 1080, h: 1920 },
  { id: 'h', name: 'Horizontal', sub: '16:9', w: 1920, h: 1080 },
  { id: 's', name: 'Cuadrado', sub: '1:1', w: 1080, h: 1080 },
  { id: 'p', name: 'Retrato', sub: '4:5', w: 1080, h: 1350 },
]

function ago(iso?: string) {
  if (!iso) return ''
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'recién'
  if (s < 3600) return `hace ${Math.round(s / 60)} min`
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`
  if (s < 86400 * 30) return `hace ${Math.round(s / 86400)} d`
  return new Date(iso).toLocaleDateString()
}
const ratio = (w: number, h: number) => FORMATS.find((f) => f.w * h === f.h * w)?.sub || `${w}×${h}`

let lastList: ProjectSummary[] | null = null
const SORTS = { recent: 'Recientes', old: 'Más antiguos', name: 'Nombre', long: 'Más largos' } as const
type Sort = keyof typeof SORTS
const pref = (k: string, d: string) => { try { return localStorage.getItem(k) || d } catch { return d } }
const time = (p: ProjectSummary) => new Date(p.updatedAt || 0).getTime()

export default function Projects() {
  const { go, toast, info, settings } = useApp()
  const dlg = useDialogs()
  const [list, setList] = useState<ProjectSummary[] | null>(lastList)
  const [templates, setTemplates] = useState<Template[]>([])
  // «Plantilla desde un video» (sólo en la app: la mide AVFoundation).
  const [canAnalyze, setCanAnalyze] = useState(false)
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)
  const [saveTpl, setSaveTpl] = useState<ProjectSummary | null>(null)
  const [q, setQ] = useState('')
  const [view, setView] = useState(() => pref('oa.homeView', 'grid'))
  const [sort, setSort] = useState<Sort>(() => pref('oa.homeSort', 'recent') as Sort)
  useEffect(() => { try { localStorage.setItem('oa.homeView', view); localStorage.setItem('oa.homeSort', sort) } catch { /* sin almacenamiento */ } }, [view, sort])
  const shown = useMemo(() => {
    const k = q.trim().toLowerCase()
    const xs = (list || []).filter((p) => !k || p.name.toLowerCase().includes(k))
    return xs.sort(sort === 'name' ? (a, b) => a.name.localeCompare(b.name) : sort === 'old' ? (a, b) => time(a) - time(b)
      : sort === 'long' ? (a, b) => (b.duration || 0) - (a.duration || 0) : (a, b) => time(b) - time(a))
  }, [list, q, sort])

  const refresh = () => call<ProjectSummary[]>('projects:list').then((l) => { lastList = l; setList(l) }).catch((e) => toast(e.message, true))
  useEffect(() => {
    refresh()
    call<Template[]>('projects:templates').then(setTemplates).catch(() => {})
    call<unknown[]>('analyze:phases').then((p) => setCanAnalyze(!!p?.length)).catch(() => {})
    return on('projects:changed', refresh)
  }, [])

  const open = (id: string) => go({ page: 'editor', id })
  const rename = async (p: ProjectSummary) => {
    const name = await dlg.prompt({ title: 'Renombrar proyecto', value: p.name, ok: 'Renombrar' })
    if (name) { await call('projects:rename', p.id, name).catch((e) => toast(e.message, true)); refresh() }
  }
  const remove = async (p: ProjectSummary) => {
    if (settings?.ui.confirmDelete !== false && !(await dlg.confirm({ title: `¿Borrar «${p.name}»?`, message: 'Va a la papelera: lo podés recuperar durante 30 días desde Ajustes › Almacenamiento.', ok: 'Borrar', danger: true }))) return
    try { await call('projects:delete', p.id); refresh(); toast('Proyecto en la papelera') } catch (e: any) { toast(e.message, true) }
  }
  const zip = async (p: ProjectSummary, action: 'share' | 'save') => {
    toast('Preparando el .zip…', 'info')
    try { await call('projects:exportZip', p.id, { action }) } catch (e: any) { if (e?.name !== 'AbortError') toast(e.message, true) }
  }
  const importZip = async () => {
    setImporting(true)
    try { const p = await call('projects:importZip'); if (p) { refresh(); toast(`«${p.name}» importado`) } } catch (e: any) { toast(e.message, true) } finally { setImporting(false) }
  }

  const more = (p: ProjectSummary) => (
    <MenuButton className="pcard2-more" label="Opciones" title={p.name} items={[
      { label: 'Abrir', icon: 'folder-open', onSelect: () => open(p.id) },
      { label: 'Renombrar…', icon: 'edit', onSelect: () => rename(p) },
      { label: 'Duplicar', icon: 'copy', onSelect: async () => { await call('projects:duplicate', p.id).catch((e) => toast(e.message, true)); refresh() } },
      { label: 'Compartir proyecto (.zip)', icon: 'share', onSelect: () => zip(p, 'share') },
      { label: 'Guardar como plantilla…', icon: 'bookmark', onSelect: () => setSaveTpl(p) },
      { sep: true },
      { label: 'Borrar', icon: 'trash', danger: true, onSelect: () => remove(p) },
    ]}><Icon name="more" size={20} /></MenuButton>
  )

  return (
    <>
      <TopBar left={<div className="ph-brand"><Logo size={26} /><b>OpenAnimator</b></div>}
        right={<>
          <MenuButton className="tap" label="Más" items={[
            { label: importing ? 'Importando…' : 'Importar proyecto (.zip)', icon: 'import', disabled: importing, onSelect: importZip },
            ...(canAnalyze ? [{ label: 'Plantilla desde un video', icon: 'wand' as const, onSelect: () => go({ page: 'analyze' }) }] : []),
            { label: 'Ajustes', icon: 'settings', onSelect: () => go({ page: 'settings' }) },
          ]}><Icon name="more" size={22} /></MenuButton>
          <Tap icon="settings" label="Ajustes" onClick={() => go({ page: 'settings' })} />
        </>} />
      <div className="ph-scroll">
        <h1 className="ph-title">Proyectos</h1>
        {!!list?.length && <div className="ph-sub">{list.length === 1 ? '1 proyecto' : `${list.length} proyectos`}</div>}
        {info && !info.claude && (
          <button className="banner" onClick={() => go({ page: 'settings', section: 'ia' })}>
            <span className="banner-ic"><Icon name="sparkles" size={22} /></span>
            <span className="grow"><b>Conectá Claude</b><small>Claude Code corre dentro del iPhone, con tu plan. Se configura una vez.</small></span>
            <Icon name="chevron-right" size={18} />
          </button>
        )}
        {!list ? <div className="ph-center"><Spinner size={22} /></div>
          : !list.length ? (
            <Empty icon="film" title="Tu primer video" desc="Creá un proyecto y pedile a Claude las escenas: las arma, las mira y las corrige solo.">
              <Button variant="primary" size="lg" icon="plus" onClick={() => setCreating(true)}>Nuevo proyecto</Button>
            </Empty>
          ) : <>
            <div className="pj-tools">
              <label className="pj-search"><Icon name="search" size={18} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar proyectos" enterKeyHint="search" /></label>
              <div className="pj-view" role="radiogroup">
                <button className={view === 'grid' ? 'on' : ''} aria-label="Cuadrícula" onClick={() => setView('grid')}><Icon name="grid" size={19} /></button>
                <button className={view === 'list' ? 'on' : ''} aria-label="Lista" onClick={() => setView('list')}><Icon name="list" size={19} /></button>
              </div>
            </div>
            <MenuButton className="pj-sort" align="start" label="Ordenar" title="Ordenar por" items={(Object.keys(SORTS) as Sort[]).map((k) => ({ label: SORTS[k], checked: sort === k, onSelect: () => setSort(k) }))}>
              {SORTS[sort]}<Icon name="chevron-down" size={15} />
            </MenuButton>
            {!shown.length && <div className="t3 pj-none">Ningún proyecto con «{q.trim()}».</div>}
            {view === 'list'
              ? <div className="plist">{shown.map((p) => (
                <div key={p.id} className="prow3" role="button" tabIndex={0} onClick={() => open(p.id)}>
                  <div className="prow3-thumb" style={p.thumb ? { backgroundImage: `url("${p.thumb}?${p.updatedAt}")` } : undefined}>{!p.thumb && <Icon name="film" size={20} stroke={1.4} />}</div>
                  <div className="grow">
                    <div className="pcard2-name ellipsis">{p.name}</div>
                    <div className="pcard2-meta ellipsis">{[ratio(p.width, p.height), fmtTime(p.duration), ago(p.updatedAt)].filter(Boolean).join(' · ')}</div>
                  </div>
                  {more(p)}
                </div>
              ))}</div>
              : <div className="pgrid">{shown.map((p) => (
                <div key={p.id} className="pcard2" role="button" tabIndex={0} onClick={() => open(p.id)}>
                  <div className="pcard2-thumb" style={p.thumb ? { backgroundImage: `url("${p.thumb}?${p.updatedAt}")` } : undefined}>
                    {!p.thumb && <Icon name="film" size={30} stroke={1.3} />}
                    <span className="pcard2-dur">{fmtTime(p.duration)}</span>
                  </div>
                  <div className="pcard2-info">
                    <div className="grow">
                      <div className="pcard2-name ellipsis">{p.name}</div>
                      <div className="pcard2-meta ellipsis">{[ratio(p.width, p.height), ago(p.updatedAt)].filter(Boolean).join(' · ')}</div>
                    </div>
                    {more(p)}
                  </div>
                </div>
              ))}</div>}
          </>}
      </div>
      {!!list?.length && <button className="fab" data-glass="accent" onClick={() => setCreating(true)}><Icon name="plus" size={22} />Nuevo proyecto</button>}

      {creating && <NewProject templates={templates} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); open(id) }}
        onTemplatesChanged={() => call<Template[]>('projects:templates').then(setTemplates).catch(() => {})}
        onAnalyze={canAnalyze ? () => { setCreating(false); go({ page: 'analyze' }) } : undefined} />}
      {saveTpl && <PhoneSaveTemplate projectId={saveTpl.id} projectName={saveTpl.name} onClose={() => { setSaveTpl(null); call<Template[]>('projects:templates').then(setTemplates).catch(() => {}) }} />}
      {dlg.element}
    </>
  )
}

function NewProject({ templates, onClose, onCreated, onAnalyze, onTemplatesChanged }: { templates: Template[]; onClose: () => void; onCreated: (id: string) => void; onAnalyze?: () => void; onTemplatesChanged: () => void }) {
  const { toast } = useApp()
  const dlg = useDialogs() // adentro de la hoja: un diálogo de afuera quedaría tapado por ella
  const [name, setName] = useState('Mi video')
  const [fmt, setFmt] = useState('v')
  const [fps, setFps] = useState(30)
  const [tpl, setTpl] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (!tpl && templates.length) setTpl(templates[0].id) }, [templates])
  const removeTpl = async (t: Template) => {
    if (!(await dlg.confirm({ title: `¿Borrar la plantilla «${t.name}»?`, message: 'Va a la papelera: la podés recuperar durante 30 días desde Ajustes › Almacenamiento.', ok: 'Borrar', danger: true }))) return
    try { await call('templates:delete', t.id); if (tpl === t.id) setTpl(''); onTemplatesChanged(); toast('Plantilla en la papelera') } catch (e: any) { toast(e.message, true) }
  }
  const create = async () => {
    const f = FORMATS.find((x) => x.id === fmt)!
    setBusy(true)
    try { onCreated((await call('projects:create', { name: name.trim() || 'Mi video', template: tpl, width: f.w, height: f.h, fps })).id) } catch (e: any) { toast(e.message, true); setBusy(false) }
  }
  return (
    <Sheet title="Nuevo proyecto" onClose={onClose} tall
      footer={<Button variant="primary" size="lg" icon="check" onClick={create} loading={busy} disabled={!tpl}>Crear proyecto</Button>}>
      <label className="ph-label">Nombre</label>
      <TextInput value={name} onChange={setName} onEnter={create} clearable />
      <label className="ph-label">Formato</label>
      <div className="fmts">
        {FORMATS.map((f) => {
          const s = 34 / Math.max(f.w, f.h)
          return (
            <button key={f.id} className={`fmt2 ${fmt === f.id ? 'on' : ''}`} onClick={() => setFmt(f.id)}>
              <span className="fmt2-shape"><span style={{ width: f.w * s, height: f.h * s }} /></span>
              <b>{f.name}</b><small>{f.sub}</small>
            </button>
          )
        })}
      </div>
      <label className="ph-label">Cuadros por segundo</label>
      <Chips value={fps} onChange={setFps} options={[{ value: 24, label: '24' }, { value: 30, label: '30' }, { value: 60, label: '60' }]} />
      <label className="ph-label">Plantilla</label>
      {onAnalyze && <button className="banner tpl-video" onClick={onAnalyze}>
        <span className="banner-ic"><Icon name="wand" size={22} /></span>
        <span className="grow"><b>Desde un video</b><small>Un enlace de YouTube o un video del teléfono: Claude arma una plantilla con su estilo.</small></span>
        <Icon name="chevron-right" size={18} />
      </button>}
      <div className="tpls">
        {templates.map((t) => (
          <div key={t.id} className="tpl-cell">
            <button className={`tpl ${tpl === t.id ? 'on' : ''}`} onClick={() => { setTpl(t.id); const f = t.user && t.width && t.height ? FORMATS.find((x) => x.w * t.height! === x.h * t.width!) : null; if (f) setFmt(f.id) }}>
              <span className="tpl-img" style={t.preview ? { backgroundImage: `url("${t.preview}")` } : undefined}>{!t.preview && <Icon name="template" size={26} stroke={1.3} />}</span>
              <b className="ellipsis">{t.name}</b>
              <small>{t.description}</small>
            </button>
            {t.user && <MenuButton native={false} className="tpl-more" label="Opciones de la plantilla" title={t.name}
              items={[{ label: 'Borrar plantilla', icon: 'trash', danger: true, onSelect: () => removeTpl(t) }]}><Icon name="more" size={16} /></MenuButton>}
          </div>
        ))}
      </div>
      {dlg.element}
    </Sheet>
  )
}
