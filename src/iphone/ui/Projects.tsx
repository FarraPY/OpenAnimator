/**
 * Inicio en el iPhone: los proyectos en una grilla de dos columnas, el botón para crear uno nuevo (formato vertical
 * por defecto: es un teléfono) y las acciones de cada proyecto en una hoja de acciones.
 */
import { useEffect, useState } from 'react'
import { call, fmtTime, on, ProjectSummary, Template } from '../../api'
import { useApp } from '../../App'
import { useDialogs } from '../../components/Dialogs'
import { Icon, Logo } from '../../ui/icons'
import { Button, Empty, Spinner, TextInput } from '../../ui/kit'
import { Actions, Chips, Sheet, Tap, TopBar } from './PhoneApp'

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

export default function Projects() {
  const { go, toast, info, settings } = useApp()
  const dlg = useDialogs()
  const [list, setList] = useState<ProjectSummary[] | null>(lastList)
  const [templates, setTemplates] = useState<Template[]>([])
  const [creating, setCreating] = useState(false)
  const [acting, setActing] = useState<ProjectSummary | null>(null)
  const [menu, setMenu] = useState(false)
  const [importing, setImporting] = useState(false)

  const refresh = () => call<ProjectSummary[]>('projects:list').then((l) => { lastList = l; setList(l) }).catch((e) => toast(e.message, true))
  useEffect(() => {
    refresh()
    call<Template[]>('projects:templates').then(setTemplates).catch(() => {})
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

  return (
    <>
      <TopBar left={<div className="ph-brand"><Logo size={26} /><b>OpenAnimator</b></div>}
        right={<><Tap icon="more" label="Más" onClick={() => setMenu(true)} /><Tap icon="settings" label="Ajustes" onClick={() => go({ page: 'settings' })} /></>} />
      <div className="ph-scroll">
        <h1 className="ph-title">Proyectos</h1>
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
          ) : (
            <div className="pgrid">
              {list.map((p) => (
                <div key={p.id} className="pcard2" role="button" tabIndex={0} onClick={() => open(p.id)}>
                  <div className="pcard2-thumb" style={p.thumb ? { backgroundImage: `url("${p.thumb}?${p.updatedAt}")` } : undefined}>
                    {!p.thumb && <Icon name="film" size={30} stroke={1.3} />}
                    <span className="pcard2-dur">{fmtTime(p.duration)}</span>
                  </div>
                  <div className="pcard2-info">
                    <div className="grow">
                      <div className="pcard2-name ellipsis">{p.name}</div>
                      <div className="pcard2-meta ellipsis">{ratio(p.width, p.height)} · {ago(p.updatedAt)}</div>
                    </div>
                    <button className="pcard2-more" aria-label="Opciones" onClick={(e) => { e.stopPropagation(); setActing(p) }}><Icon name="more" size={20} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
      </div>
      {!!list?.length && <button className="fab" onClick={() => setCreating(true)}><Icon name="plus" size={22} />Nuevo</button>}

      {creating && <NewProject templates={templates} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); open(id) }} />}
      {acting && <Actions title={acting.name} onClose={() => setActing(null)} items={[
        { label: 'Abrir', icon: 'folder-open', onSelect: () => open(acting.id) },
        { label: 'Renombrar…', icon: 'edit', onSelect: () => rename(acting) },
        { label: 'Duplicar', icon: 'copy', onSelect: async () => { await call('projects:duplicate', acting.id).catch((e) => toast(e.message, true)); refresh() } },
        { label: 'Compartir proyecto (.zip)', icon: 'share', onSelect: () => zip(acting, 'share') },
        { sep: true },
        { label: 'Borrar', icon: 'trash', danger: true, onSelect: () => remove(acting) },
      ]} />}
      {menu && <Actions onClose={() => setMenu(false)} items={[
        { label: importing ? 'Importando…' : 'Importar proyecto (.zip)', icon: 'import', disabled: importing, onSelect: importZip },
        { label: 'Ajustes', icon: 'settings', onSelect: () => go({ page: 'settings' }) },
      ]} />}
      {dlg.element}
    </>
  )
}

function NewProject({ templates, onClose, onCreated }: { templates: Template[]; onClose: () => void; onCreated: (id: string) => void }) {
  const { toast } = useApp()
  const [name, setName] = useState('Mi video')
  const [fmt, setFmt] = useState('v')
  const [fps, setFps] = useState(30)
  const [tpl, setTpl] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (!tpl && templates.length) setTpl(templates[0].id) }, [templates])
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
      <div className="tpls">
        {templates.map((t) => (
          <button key={t.id} className={`tpl ${tpl === t.id ? 'on' : ''}`} onClick={() => setTpl(t.id)}>
            <span className="tpl-img" style={t.preview ? { backgroundImage: `url("${t.preview}")` } : undefined}>{!t.preview && <Icon name="template" size={26} stroke={1.3} />}</span>
            <b className="ellipsis">{t.name}</b>
            <small>{t.description}</small>
          </button>
        ))}
      </div>
    </Sheet>
  )
}
