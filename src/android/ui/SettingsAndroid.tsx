/**
 * Secciones de Ajustes propias de la tablet: cómo se conecta Claude (tu plan con Termux o una clave
 * de la API), la pantalla, la exportación con el codificador de hardware, el almacenamiento (la
 * tablet y la tarjeta SD, papelera, exportaciones) y los datos del equipo.
 */
import { ReactNode, useEffect, useState } from 'react'
import { call, EFFORTS, fmtSize, MODELS, on, ProjectSummary } from '../../api'
import { useApp } from '../../App'
import { useDialogs } from '../../components/Dialogs'
import { Icon, IconName, Logo } from '../../ui/icons'
import { Badge, Button, Segmented, Select, Spinner, Switch, TextArea, TextInput } from '../../ui/kit'
import { TermuxSetup } from './TermuxSetup'
import { PLACE, StorageInfo, useMoveProjects, useStorage, Volume } from './Storage'

export function Row({ label, desc, children, stack }: { label: ReactNode; desc?: ReactNode; children?: ReactNode; stack?: boolean }) {
  return (
    <div className={`set-row ${stack ? 'stack' : ''}`}>
      <div className="set-text"><div className="set-label">{label}</div>{desc && <div className="set-desc">{desc}</div>}</div>
      {children && <div className="set-ctrl">{children}</div>}
    </div>
  )
}
export function Group({ title, desc, icon, children }: { title: string; desc?: string; icon?: IconName; children: ReactNode }) {
  return (
    <section className="set-group">
      <h3 className="set-group-title">{icon && <Icon name={icon} size={16} style={{ color: 'var(--t3)' }} />}{title}</h3>
      {desc && <div className="set-group-desc">{desc}</div>}
      <div className="set-card">{children}</div>
    </section>
  )
}

export const ANDROID_SECTIONS: Array<{ id: string; label: string; icon: IconName }> = [
  { id: 'general', label: 'General', icon: 'sliders' },
  { id: 'tablet', label: 'Tablet', icon: 'tablet' },
  { id: 'apariencia', label: 'Apariencia', icon: 'palette' },
  { id: 'editor', label: 'Editor y timeline', icon: 'film' },
  { id: 'ia', label: 'Claude (IA)', icon: 'sparkles' },
  { id: 'plugins', label: 'Plugins', icon: 'plug' },
  { id: 'export', label: 'Exportación', icon: 'export' },
  { id: 'almacenamiento', label: 'Almacenamiento', icon: 'drive' },
  { id: 'atajos', label: 'Teclado físico', icon: 'keyboard' },
  { id: 'acerca', label: 'Acerca de', icon: 'info' },
]

// ── Claude ────────────────────────────────────────────────────────────────────
export function ClaudeSection() {
  const { settings: s, updateSettings: up, toast, refreshInfo } = useApp()
  const dlg = useDialogs()
  const [st, setSt] = useState<{ ready: boolean; masked: string } | null>(null)
  const [key, setKey] = useState('')
  const [test, setTest] = useState<{ ok: boolean; msg: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [notes, setNotes] = useState<string | null>(null)
  const [notesDirty, setNotesDirty] = useState(false)
  useEffect(() => { call('claude:status').then(setSt).catch(() => {}); call<string>('ai:notes:get').then(setNotes).catch(() => setNotes('')) }, [])
  if (!s) return null

  const runTest = async () => {
    setTesting(true); setTest(null)
    try { setTest({ ok: true, msg: await call<string>('claude:test') }) } catch (e: any) { setTest({ ok: false, msg: e.message }) } finally { setTesting(false) }
  }
  const save = async () => {
    const k = key.trim()
    if (!k) return
    if (!/^sk-ant-/.test(k) && !(await dlg.confirm({ title: '¿Guardar esta clave?', message: 'Las claves de la API de Claude empiezan con «sk-ant-». Revisá que la hayas copiado completa.', ok: 'Guardar igual' }))) return
    try { setSt(await call('claude:setKey', k)); setKey(''); refreshInfo(); toast('Clave guardada'); runTest() } catch (e: any) { toast(e.message, true) }
  }
  const remove = async () => { setSt(await call('claude:setKey', '')); setTest(null); refreshInfo(); toast('Clave borrada') }

  const mode = s.claude.backend === 'api' ? 'api' : 'termux'
  const setMode = (v: 'termux' | 'api') => { up({ claude: { backend: v } }); setTest(null); setTimeout(refreshInfo, 50) }

  return <>
    <Group title="Conexión" icon="key" desc="Claude puede trabajar con tu plan de Claude (Pro o Max), a través de Claude Code en Termux, o con una clave de la API, que se paga por uso.">
      <div className="key-box">
        <Segmented full value={mode} onChange={setMode} options={[{ value: 'termux', label: 'Con tu plan de Claude', icon: 'sparkles' }, { value: 'api', label: 'Con clave de API', icon: 'key' }]} />
        {mode === 'termux' ? <TermuxSetup /> : <>
          <div className="key-status">
            <span className="key-mark"><Icon name="sparkles" size={22} /></span>
            <div className="grow">
              <div style={{ font: '600 16px var(--font-display)' }}>API de Claude</div>
              <div className="t3" style={{ marginTop: 2 }}>{st?.ready ? <>Clave guardada: <span className="mono t2">{st.masked}</span></> : 'Todavía no cargaste una clave.'}</div>
            </div>
            {st?.ready ? <Badge tone="ok" icon="check">Conectado</Badge> : <Badge tone="warn">Sin clave</Badge>}
          </div>
          <div className="key-row">
            <TextInput type="password" mono value={key} onChange={setKey} placeholder={st?.ready ? 'Pegá una clave nueva para reemplazarla' : 'sk-ant-api03-…'} onEnter={save} />
            <Button variant="primary" icon="check" onClick={save} disabled={!key.trim()}>Guardar</Button>
            {st?.ready && <Button icon="refresh" onClick={runTest} loading={testing}>Probar</Button>}
            {st?.ready && <Button variant="ghost" icon="trash" tip="Borrar la clave" onClick={remove} />}
          </div>
          {test && <div className={`plug-test-msg ${test.ok ? 'ok' : 'err'}`} style={{ fontSize: 14 }}><Icon name={test.ok ? 'check-circle' : 'x-circle'} size={16} />{test.msg}</div>}
          <div className="key-note"><Icon name="info" size={16} /><div>
            El chat usa tu clave de la <b>API de Claude</b> (cuenta de desarrollador en platform.claude.com), que se cobra por uso y es aparte de la suscripción de claude.ai. La clave se guarda <b>cifrada con el almacén de claves de Android</b> y sólo viaja a api.anthropic.com.
            <div style={{ marginTop: 8 }}><Button size="sm" icon="external" onClick={() => call('shell:openExternal', 'https://platform.claude.com/settings/keys')}>Conseguir una clave</Button></div>
          </div></div>
        </>}
      </div>
    </Group>
    <Group title="Modelo y razonamiento" icon="gauge" desc="Valores por defecto para chats nuevos. También se cambian desde el propio chat.">
      <Row label="Modelo" desc={mode === 'api' ? 'Precios en US$ por millón de tokens (entrada / salida).' : 'Con tu plan, el uso cuenta para los límites de tu cuenta de Claude.'}>
        <Select value={s.claude.model} width={260} menuWidth={340} onChange={(v) => up({ claude: { model: v } })}
          options={MODELS.map((m) => ({ value: m.id, label: m.name, desc: m.desc, hint: m.note }))} />
      </Row>
      <Row label="Nivel de esfuerzo" desc="Más esfuerzo = piensa más: mejor en escenas complejas, pero más lento y más caro.">
        <Select value={s.claude.effort} width={260} menuWidth={320} onChange={(v) => up({ claude: { effort: v } })}
          options={EFFORTS.map((e) => ({ value: e.id, label: e.name, desc: e.desc }))} />
      </Row>
      <Row label="Permisos" desc="Qué puede hacer Claude sin preguntarte.">
        <Select value={s.claude.permissionMode} width={260} menuWidth={360} onChange={(v) => up({ claude: { permissionMode: v } })} options={[
          { value: 'default', label: 'Preguntar todo', desc: 'Pide permiso para cada edición y cada gasto' },
          { value: 'acceptEdits', label: 'Aceptar ediciones', desc: 'Edita el proyecto sin preguntar; pide permiso para lo que cuesta dinero (recomendado)' },
          { value: 'plan', label: 'Sólo planificar', desc: 'Propone un plan sin tocar nada' },
          { value: 'bypassPermissions', label: 'Sin preguntar', desc: 'Hace todo sin pedir permiso, incluso generar voz o imágenes con tus plugins' },
        ]} />
      </Row>
    </Group>
    <Group title="Instrucciones" icon="message">
      <Row label="Instrucciones adicionales" desc="Se agregan a cada conversación nueva (estilo, idioma, tono, marca…)." stack>
        <TextArea rows={4} value={s.claude.extraInstructions} placeholder="Ej.: Usá siempre la paleta de mi marca (#0E3B5C, #F2A541). Textos en español rioplatense. Nada de emojis." onChange={(v) => up({ claude: { extraInstructions: v } })} />
      </Row>
      <Row label="Notas para la IA (NOTAS-IA.md)" desc="Preferencias largas que Claude lee en todos los proyectos." stack>
        {notes == null ? <div className="row t3"><Spinner />Cargando…</div> : <>
          <textarea className="textarea notes-edit" rows={9} value={notes} onChange={(e) => { setNotes(e.target.value); setNotesDirty(true) }} onKeyDown={(e) => e.stopPropagation()} />
          <div className="row"><div className="grow" /><Button variant={notesDirty ? 'primary' : 'secondary'} icon="save" disabled={!notesDirty} onClick={async () => { await call('ai:notes:set', notes); setNotesDirty(false); toast('Notas guardadas') }}>Guardar notas</Button></div>
        </>}
      </Row>
    </Group>
    <Group title="Chat" icon="message">
      <Row label="Modo ahorro" desc="Claude gasta menos: mira fotogramas más chicos y menos veces, no relee archivos, resume adjuntos largos y responde corto."><Switch checked={s.claude.saver !== false} onChange={(v) => up({ claude: { saver: v } })} /></Row>
      <Row label="Mostrar el razonamiento" desc="Ver un resumen de lo que Claude piensa mientras trabaja."><Switch checked={s.claude.showThinking} onChange={(v) => up({ claude: { showThinking: v } })} /></Row>
      <Row label="Mostrar costo y duración" desc="Al final de cada respuesta (estimado según los precios de la API)."><Switch checked={s.claude.showCost} onChange={(v) => up({ claude: { showCost: v } })} /></Row>
      <Row label="Seguir la última conversación" desc="Al abrir un proyecto, Claude sigue donde quedó (con el botón + empezás una nueva)."><Switch checked={s.claude.continueChat !== false} onChange={(v) => up({ claude: { continueChat: v } })} /></Row>
      <Row label="Adjuntar el fotograma actual" desc="Cada mensaje incluye la imagen del visor en el cursor."><Switch checked={s.claude.autoAttachFrame} onChange={(v) => up({ claude: { autoAttachFrame: v } })} /></Row>
    </Group>
    {dlg.element}
  </>
}

// ── Tablet ────────────────────────────────────────────────────────────────────
export function TabletSection() {
  const { settings: s, updateSettings: up } = useApp()
  if (!s) return null
  const a = s.android || { immersive: true, uiScale: 1, debug: false, saveToGallery: true, keepAwake: true }
  return <>
    <Group title="Pantalla" icon="tablet">
      <Row label="Pantalla completa" desc="Oculta la barra de estado y la de navegación (deslizá desde un borde para verlas)."><Switch checked={a.immersive} onChange={(v) => up({ android: { immersive: v } })} /></Row>
      <Row label="Tamaño de la interfaz" desc="Más grande para usar con el dedo; más chico para ver más timeline.">
        <Segmented value={a.uiScale} onChange={(v) => up({ android: { uiScale: v } })} options={[{ value: 0.9, label: '90 %' }, { value: 1, label: '100 %' }, { value: 1.1, label: '110 %' }, { value: 1.25, label: '125 %' }]} />
      </Row>
      <Row label="Mantener la pantalla encendida" desc="Mientras Claude trabaja o se exporta un video (si la pantalla se apaga, el trabajo se pausa)."><Switch checked={a.keepAwake} onChange={(v) => up({ android: { keepAwake: v } })} /></Row>
    </Group>
    <Group title="Avanzado" icon="terminal">
      <Row label="Depuración remota" desc="Permite inspeccionar la app desde Chrome en una PC (chrome://inspect). Dejalo apagado si no lo necesitás."><Switch checked={a.debug} onChange={(v) => up({ android: { debug: v } })} /></Row>
    </Group>
  </>
}

// ── Exportación ───────────────────────────────────────────────────────────────
export function ExportSection() {
  const { settings: s, updateSettings: up, info } = useApp()
  if (!s) return null
  const e = s.androidExport || { codec: 'avc', quality: 'high', bitrate: 0, height: 0, fps: 0, audio: true, audioBitrate: 192 }
  const codecs = (info as any)?.codecs || {}
  return <>
    <Group title="Codificador" icon="zap" desc="La tablet codifica el video con su propio chip (rápido y sin gastar batería de más).">
      <Row label="H.264 (AVC)" desc="Compatible con todo.">{codecs.avc !== false ? <Badge tone="ok" icon="check">{codecs.avcHw ? 'Por hardware' : 'Disponible'}</Badge> : <Badge tone="err">No disponible</Badge>}</Row>
      <Row label="HEVC (H.265)" desc="Mitad de tamaño con la misma calidad.">{codecs.hevc ? <Badge tone="ok" icon="check">{codecs.hevcHw ? 'Por hardware' : 'Disponible'}</Badge> : <Badge tone="neutral">No disponible</Badge>}</Row>
    </Group>
    <Group title="Valores por defecto" icon="film" desc="Se recuerdan los últimos que usaste al exportar.">
      <Row label="Códec"><Segmented value={e.codec} onChange={(v) => up({ androidExport: { codec: v } })} options={[{ value: 'avc', label: 'H.264' }, ...(codecs.hevc ? [{ value: 'hevc' as const, label: 'HEVC' }] : [])]} /></Row>
      <Row label="Calidad"><Segmented value={e.quality} onChange={(v) => up({ androidExport: { quality: v } })} options={[{ value: 'low', label: 'Baja' }, { value: 'medium', label: 'Media' }, { value: 'high', label: 'Alta' }, { value: 'max', label: 'Máxima' }]} /></Row>
      <Row label="Resolución"><Segmented value={e.height} onChange={(v) => up({ androidExport: { height: v } })} options={[{ value: 0, label: 'Proyecto' }, { value: 720, label: '720p' }, { value: 1080, label: '1080p' }, { value: 2160, label: '4K' }]} /></Row>
      <Row label="Audio" desc="Voz, música y efectos del timeline (AAC)."><Switch checked={e.audio} onChange={(v) => up({ androidExport: { audio: v } })} /></Row>
    </Group>
    <Group title="Destino" icon="gallery">
      <Row label="Guardar en la galería" desc="Copia cada video a Galería › Movies/OpenAnimator al terminar."><Switch checked={s.android?.saveToGallery !== false} onChange={(v) => up({ android: { saveToGallery: v } })} /></Row>
    </Group>
  </>
}

// ── Almacenamiento ────────────────────────────────────────────────────────────
type Trash = { id: string; from: string; name: string; label: string; at: string; size: number; sd?: boolean }
type Saved = { path: string; name: string; size: number; mtime: number; sd?: boolean }
const USE_BAR: Array<[string, string, string]> = [['projects', 'Proyectos', 'var(--accent)'], ['exports', 'Videos exportados', 'var(--video)'], ['templates', 'Plantillas', 'var(--image)'], ['cache', 'Caché', 'var(--audio)'], ['trash', 'Papelera', 'var(--t4)']]

/** Un lugar (la tablet o la tarjeta): cuánto queda libre y qué ocupa OpenAnimator ahí. */
function Place({ icon, title, sub, p, chosen }: { icon: IconName; title: string; sub?: string; p: StorageInfo['internal']; chosen?: boolean }) {
  const mine = Object.values(p.used).reduce((n, x) => n + x, 0)
  const other = Math.max(0, p.total - p.free - mine)
  return (
    <div className={`vol-card ${chosen ? 'on' : ''}`}>
      <div className="row" style={{ gap: 12 }}>
        <span className="vol-ico"><Icon name={icon} size={20} /></span>
        <div className="grow" style={{ minWidth: 0 }}><div style={{ fontWeight: 600 }}>{title}</div>{sub && <div className="t3 ellipsis" style={{ fontSize: 12.5 }}>{sub}</div>}</div>
        {chosen && <Badge tone="accent">proyectos nuevos</Badge>}
      </div>
      <div className="vol-bar">
        {USE_BAR.map(([k, , c]) => <div key={k} style={{ flex: p.used[k] || 0, background: c }} />)}
        <div style={{ flex: other, background: 'var(--line-3)' }} /><div style={{ flex: p.free }} />
      </div>
      <div className="row t2" style={{ fontSize: 13 }}><span className="tabnum">{fmtSize(p.free)} libres de {fmtSize(p.total)}</span><div className="grow" /><span className="t3">{p.projects} {p.projects === 1 ? 'proyecto' : 'proyectos'}</span></div>
      <div className="row t3" style={{ flexWrap: 'wrap', gap: 12, fontSize: 12.5 }}>
        {mine < 1024 ? <span>Todavía no hay nada de OpenAnimator acá.</span>
          : USE_BAR.filter(([k]) => (p.used[k] || 0) >= 1024).map(([k, l, c]) => <span key={k} className="row" style={{ gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: 3, background: c }} />{l} · {fmtSize(p.used[k])}</span>)}
      </div>
    </div>
  )
}

export function StorageSection() {
  const { toast } = useApp()
  const dlg = useDialogs()
  const storage = useStorage()
  const mover = useMoveProjects()
  const st = storage.info
  const [cache, setCache] = useState<{ export: number; peaks: number; thumbs: number } | null>(null)
  const [trash, setTrash] = useState<Trash[] | null>(null)
  const [exp, setExp] = useState<Saved[]>([])
  const lists = () => {
    call('cache:stats').then(setCache).catch(() => {})
    call<Trash[]>('trash:list').then(setTrash).catch(() => setTrash([]))
    call<Saved[]>('export:list').then(setExp).catch(() => {})
  }
  const load = () => { storage.reload(); lists() }
  useEffect(() => { lists(); return on('storage:changed', lists) }, [])
  const clear = async (kind: 'export' | 'peaks' | 'thumbs', label: string) => {
    if (!(await dlg.confirm({ title: `¿Borrar ${label}?`, message: 'Se vuelve a generar cuando haga falta.', ok: 'Borrar', danger: true }))) return
    setCache(await call('cache:clear', kind)); toast('Listo'); load()
  }
  const setNew = (v: Volume) => call('storage:setNew', v).catch((e) => toast(e.message, true))
  const moveAll = async (to: Volume) => {
    if (!st) return
    const ids = (await call<ProjectSummary[]>('projects:list')).filter((p) => p.volume !== to).map((p) => p.id)
    if (!ids.length) return
    const bytes = (to === 'sd' ? st.internal : st.sd!).used.projects
    const free = to === 'sd' ? st.sd!.free : st.internal.free
    if (bytes + (64 << 20) > free) { toast(`No entra: los proyectos ocupan ${fmtSize(bytes)} y en ${PLACE[to]} quedan ${fmtSize(free)} libres. Podés mover algunos desde el menú de cada proyecto.`, true); return }
    const n = ids.length === 1 ? 'el proyecto' : `los ${ids.length} proyectos`
    if (!(await dlg.confirm({ title: `¿Mover ${n} a ${PLACE[to]}?`, message: `Son ${fmtSize(bytes)}. Puede tardar unos minutos: no saques la tarjeta ni cierres la app mientras tanto (si se corta, cada proyecto queda entero de un lado o del otro).`, ok: 'Mover' }))) return
    await mover.move(ids, to)
  }
  return <>
    <Group title="Dónde se guardan los proyectos" icon="drive" desc="Un proyecto en la tarjeta SD se abre, se edita, trabaja con Claude y se exporta ahí mismo, como uno de la tablet; sus videos exportados también quedan en la tarjeta.">
      {!st ? <div className="row t3" style={{ padding: 18 }}><Spinner />Cargando…</div> : <>
        <div className="vol-grid">
          <Place icon="tablet" title="Tablet" sub="Almacenamiento interno" p={st.internal} chosen={!!st.sd && st.newProjects === 'internal'} />
          {st.sd ? <Place icon="sd" title="Tarjeta SD" sub={st.sd.label} p={st.sd} chosen={st.newProjects === 'sd'} />
            : <div className="vol-card empty-vol">
              <span className="vol-ico"><Icon name="sd" size={20} /></span>
              <div style={{ fontWeight: 600 }}>{st.missing ? `La tarjeta SD${st.cardLabel ? ` (${st.cardLabel})` : ''} no está puesta` : 'Sin tarjeta SD'}</div>
              <div className="t3" style={{ fontSize: 12.5 }}>{st.missing ? `Tiene ${st.missing === 1 ? 'un proyecto' : `${st.missing} proyectos`}: aparecen de nuevo cuando la vuelvas a poner.` : 'Poné una tarjeta microSD para guardar proyectos en ella y liberar la memoria de la tablet.'}</div>
            </div>}
        </div>
        {st.sd ? <>
          <Row label="Proyectos nuevos" desc="Dónde se crean (también se puede elegir al crear cada uno).">
            <Segmented value={st.newProjects} onChange={setNew} options={[{ value: 'internal', icon: 'tablet', label: 'Tablet' }, { value: 'sd', icon: 'sd', label: 'Tarjeta SD' }]} />
          </Row>
          {st.internal.projects > 0 && <Row label="Pasar todo a la tarjeta" desc={`${st.internal.projects} ${st.internal.projects === 1 ? 'proyecto' : 'proyectos'} de la tablet · ${fmtSize(st.internal.used.projects)}. Para uno solo: menú del proyecto › Mover a la tarjeta SD.`}>
            <Button icon="sd" onClick={() => moveAll('sd')} disabled={mover.moving}>Mover a la tarjeta</Button>
          </Row>}
          {st.sd.projects > 0 && <Row label="Traer todo a la tablet" desc={`${st.sd.projects} ${st.sd.projects === 1 ? 'proyecto' : 'proyectos'} de la tarjeta · ${fmtSize(st.sd.used.projects)}.`}>
            <Button icon="tablet" onClick={() => moveAll('internal')} disabled={mover.moving}>Mover a la tablet</Button>
          </Row>}
        </> : st.newProjects === 'sd' && <Row label="Proyectos nuevos" desc="Elegiste la tarjeta SD, pero no está: mientras tanto se guardan en la tablet.">
          <Button onClick={() => setNew('internal')}>Usar la tablet</Button>
        </Row>}
        <div className="set-row t3" style={{ fontSize: 12.5, minHeight: 0 }}><Icon name="info" size={15} style={{ flex: 'none' }} /><span>Los proyectos se guardan en la carpeta privada de la app (en la tarjeta, Android/data): igual que los de la tablet, se borran si desinstalás OpenAnimator. Para guardar una copia aparte usá «Guardar en Archivos (.zip)» en el menú de cada proyecto.</span></div>
      </>}
    </Group>
    <section className="set-group">
      <h3 className="set-group-title"><Icon name="trash" size={16} style={{ color: 'var(--t3)' }} />Papelera<div className="grow" />{!!trash?.length && <Button size="sm" variant="danger" icon="trash" onClick={async () => {
        if (!(await dlg.confirm({ title: '¿Vaciar la papelera?', message: 'Se borra todo definitivamente.', ok: 'Vaciar', danger: true }))) return
        await call('trash:empty'); load()
      }}>Vaciar</Button>}</h3>
      <div className="set-group-desc">Proyectos y archivos borrados. Se vacía sola a los 30 días.</div>
      <div className="set-card">
        {!trash ? <div className="row t3" style={{ padding: 18 }}><Spinner />Cargando…</div>
          : !trash.length ? <div className="t3" style={{ padding: 18 }}>La papelera está vacía.</div>
            : trash.map((x) => (
              <div key={x.id} className="trash-row">
                <Icon name={/^projects\/[^/]+$/.test(x.from) ? 'film' : 'file'} size={18} className="t3" />
                <div className="grow" style={{ minWidth: 0 }}><div className="ellipsis" style={{ fontWeight: 500 }}>{x.label}</div><div className="t3" style={{ fontSize: 12.5 }}>{new Date(x.at).toLocaleString()} · {fmtSize(x.size)}{x.sd && ' · en la tarjeta SD'}</div></div>
                <Button size="sm" icon="undo" onClick={async () => { try { await call('trash:restore', x.id); toast('Restaurado'); load() } catch (e: any) { toast(e.message, true) } }}>Restaurar</Button>
                <Button size="sm" variant="ghost" icon="x" tip="Borrar definitivamente" onClick={async () => { await call('trash:delete', x.id); load() }} />
              </div>
            ))}
      </div>
    </section>
    {exp.length > 0 && <Group title="Videos exportados" icon="film" desc="Copias dentro de la app (las de la galería no se tocan).">
      {exp.map((x) => (
        <div key={x.path} className="trash-row">
          <Icon name="video" size={18} className="t3" />
          <div className="grow" style={{ minWidth: 0 }}><div className="ellipsis" style={{ fontWeight: 500 }}>{x.name}</div><div className="t3" style={{ fontSize: 12.5 }}>{new Date(x.mtime).toLocaleString()} · {fmtSize(x.size)}{x.sd && ' · en la tarjeta SD'}</div></div>
          <Button size="sm" variant="ghost" icon="play" tip="Ver" onClick={() => call('export:open', x.path)} />
          <Button size="sm" variant="ghost" icon="share" tip="Compartir" onClick={() => call('export:share', x.path)} />
          <Button size="sm" variant="ghost" icon="trash" tip="Borrar" onClick={async () => { await call('export:delete', x.path); load() }} />
        </div>
      ))}
    </Group>}
    <Group title="Cachés" icon="gauge" desc="Se pueden borrar sin perder trabajo; se regeneran solas.">
      <Row label="Fotogramas temporales" desc="Capturas para compartir o copiar."><span className="t2 tabnum">{cache ? fmtSize(cache.export) : '…'}</span><Button size="sm" icon="trash" onClick={() => clear('export', 'los fotogramas temporales')}>Borrar</Button></Row>
      <Row label="Formas de onda" desc="Picos de audio del timeline."><span className="t2 tabnum">{cache ? fmtSize(cache.peaks) : '…'}</span><Button size="sm" icon="trash" onClick={() => clear('peaks', 'la caché de formas de onda')}>Borrar</Button></Row>
      <Row label="Miniaturas de video" desc="Panel de medios."><span className="t2 tabnum">{cache ? fmtSize(cache.thumbs) : '…'}</span><Button size="sm" icon="trash" onClick={() => clear('thumbs', 'la caché de miniaturas')}>Borrar</Button></Row>
    </Group>
    {dlg.element}
    {mover.element}
  </>
}

// ── Acerca de ─────────────────────────────────────────────────────────────────
export function AboutSection() {
  const { info } = useApp()
  const [ver, setVer] = useState<any>(null)
  useEffect(() => { call('app:versions').then(setVer).catch(() => {}) }, [])
  const d = (info as any)?.device || {}
  const items: Array<[string, ReactNode]> = [
    ['Equipo', `${d.manufacturer || ''} ${d.model || ''}`.trim() || '—'], ['Procesador', d.soc || '—'], ['Android', d.release ? `${d.release} (API ${d.sdk})` : '—'],
    ['WebView', ver?.webview || '—'], ['Pantalla', d.screenWidth ? `${d.screenWidth}×${d.screenHeight} · ${d.density}×` : '—'], ['Memoria', d.memory ? fmtSize(d.memory) : '—'],
  ]
  return <>
    <div className="set-card" style={{ padding: 24, display: 'flex', gap: 20, alignItems: 'center', marginBottom: 26 }}>
      <Logo size={64} />
      <div>
        <div style={{ font: '600 20px var(--font-display)' }}>OpenAnimator para Android</div>
        <div className="t3" style={{ marginTop: 2 }}>Versión {info?.version} · licencia MIT</div>
        <div className="t2" style={{ marginTop: 8 }}>Estudio open source de video animado con HTML/SVG e IA, ahora en tu tablet.</div>
      </div>
    </div>
    <Group title="Este equipo" icon="tablet">
      <div className="dev-grid">{items.map(([k, v]) => <div key={k}><div className="k">{k}</div><div className="v">{v}</div></div>)}</div>
    </Group>
    <Group title="Componentes de terceros" icon="layers" desc="Software libre incluido en la app.">
      <Row label="React" desc="Interfaz."><span className="t3">MIT</span></Row>
      <Row label="SDK de Anthropic para TypeScript" desc="Conexión con la API de Claude."><span className="t3">MIT</span></Row>
      <Row label="modern-screenshot" desc="Rasterizado de escenas para fotogramas y exportación."><span className="t3">MIT</span></Row>
    </Group>
  </>
}
