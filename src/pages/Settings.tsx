import { ReactNode, useEffect, useState } from 'react'
import { call, EFFORTS, fmtSize, MODELS, Settings } from '../api'
import { useApp } from '../App'
import { useDialogs } from '../components/Dialogs'
import PluginsSettings from '../components/PluginsSettings'
import { Icon, IconName, Logo } from '../ui/icons'
import { Badge, Button, NumberInput, Segmented, Select, Slider, Switch, TextArea, TextInput } from '../ui/kit'
import { isAndroid } from '../platform'
import { useBack } from '../android/ui/back'
import { ANDROID_SECTIONS, AboutSection, ClaudeSection, ExportSection, StorageSection, TabletSection } from '../android/ui/SettingsAndroid'

const SECTIONS: Array<{ id: string; label: string; icon: IconName }> = [
  { id: 'general', label: 'General', icon: 'sliders' },
  { id: 'apariencia', label: 'Apariencia', icon: 'palette' },
  { id: 'editor', label: 'Editor y timeline', icon: 'film' },
  { id: 'ia', label: 'Claude (IA)', icon: 'sparkles' },
  { id: 'plugins', label: 'Plugins', icon: 'plug' },
  { id: 'export', label: 'Exportación', icon: 'export' },
  { id: 'rendimiento', label: 'Rendimiento y caché', icon: 'gauge' },
  { id: 'atajos', label: 'Atajos de teclado', icon: 'keyboard' },
  { id: 'acerca', label: 'Acerca de', icon: 'info' },
]
const ACCENTS: Array<{ id: Settings['ui']['accent']; c: string; name: string }> = [
  { id: 'violet', c: '#7b6cff', name: 'Violeta' }, { id: 'blue', c: '#3d8bff', name: 'Azul' }, { id: 'teal', c: '#14b3a7', name: 'Turquesa' },
  { id: 'green', c: '#3bb46e', name: 'Verde' }, { id: 'amber', c: '#e3902b', name: 'Ámbar' }, { id: 'rose', c: '#e5537a', name: 'Rosa' },
]
const SHORTCUTS: Array<[string, string[]]> = [
  ['Reproducir / pausar', ['Espacio']], ['Fotograma anterior / siguiente', ['←', '→']], ['Saltar 1 segundo', ['Shift', '← / →']],
  ['Ir al inicio / al final', ['Inicio', 'Fin']], ['Cortar clips en el cursor', ['S']], ['Borrar selección', ['Supr']], ['Borrar y cerrar el hueco', ['Shift', 'Supr']],
  ['Duplicar selección', ['Ctrl', 'D']], ['Deshacer', ['Ctrl', 'Z']], ['Rehacer', ['Ctrl', 'Y']], ['Nota para la IA en el cursor', ['N']],
  ['Repetir en bucle', ['L']], ['Imán (snap)', ['M']], ['Acercar / alejar el timeline', ['Ctrl', 'Rueda']], ['Ajustar el timeline a la ventana', ['Shift', 'Z']],
  ['Exportar', ['Ctrl', 'E']], ['Mostrar / ocultar el chat de IA', ['Ctrl', 'J']], ['Ajustes', ['Ctrl', ',']], ['Enviar mensaje a Claude', ['Enter']], ['Nueva línea en el chat', ['Shift', 'Enter']],
  ['Visor en pantalla completa', ['F']], ['Salir de pantalla completa', ['Esc']], ['Pegar una imagen en el chat', ['Ctrl', 'V']],
]

function Row({ label, desc, children, stack }: { label: ReactNode; desc?: ReactNode; children?: ReactNode; stack?: boolean }) {
  return (
    <div className={`set-row ${stack ? 'stack' : ''}`}>
      <div className="set-text"><div className="set-label">{label}</div>{desc && <div className="set-desc">{desc}</div>}</div>
      {children && <div className="set-ctrl">{children}</div>}
    </div>
  )
}
function Group({ title, desc, icon, children }: { title: string; desc?: string; icon?: IconName; children: ReactNode }) {
  return (
    <section className="set-group">
      <h3 className="set-group-title">{icon && <Icon name={icon} size={15} style={{ color: 'var(--t3)' }} />}{title}</h3>
      {desc && <div className="set-group-desc">{desc}</div>}
      <div className="set-card">{children}</div>
    </section>
  )
}

export default function SettingsPage({ section: initial, onBack }: { section?: string; onBack: () => void }) {
  const { settings: s, updateSettings: up, info, toast } = useApp()
  const [sec, setSec] = useState(initial || 'general')
  const android = isAndroid()
  const sections = android ? ANDROID_SECTIONS : SECTIONS
  useBack(() => { onBack(); return true }, android)
  const [cache, setCache] = useState<{ export: number; peaks: number; thumbs: number } | null>(null)
  const [ver, setVer] = useState<any>(null)
  const dlg = useDialogs()
  useEffect(() => { call('cache:stats').then(setCache); call('app:versions').then(setVer) }, [])
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.modal')) onBack() }
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k)
  }, [onBack])
  if (!s) return null
  const ex = s.export

  const clear = async (kind: 'export' | 'peaks' | 'thumbs', label: string) => {
    if (!(await dlg.confirm({ title: `¿Borrar ${label}?`, message: 'Se vuelve a generar cuando haga falta.', ok: 'Borrar', danger: true }))) return
    setCache(await call('cache:clear', kind)); toast(`${label[0].toUpperCase() + label.slice(1)} borrada`)
  }

  return (
    <>
      <div className="titlebar">
        <Button variant="ghost" size="sm" icon="arrow-left" tip="Volver" kbd="Esc" onClick={onBack} />
        <div className="brand"><Logo size={20} />Ajustes</div>
      </div>
      <div className="settings">
        <aside className="side">
          {sections.map((x) => <button key={x.id} className={`side-item ${sec === x.id ? 'on' : ''}`} onClick={() => setSec(x.id)}><Icon name={x.icon} />{x.label}</button>)}
          <div className="side-foot">
            <Button variant="ghost" size="sm" icon="refresh" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={async () => {
              if (await dlg.confirm({ title: '¿Restablecer todos los ajustes?', message: 'Tus proyectos no se tocan; sólo vuelven los valores por defecto.', ok: 'Restablecer', danger: true })) { await call('settings:reset'); location.reload() }
            }}>Restablecer ajustes</Button>
          </div>
        </aside>
        <main className="main">
          {android && <div className="portrait-nav">{sections.map((x) => <button key={x.id} className={`side-item ${sec === x.id ? 'on' : ''}`} onClick={() => setSec(x.id)}><Icon name={x.icon} />{x.label}</button>)}</div>}
          <div className="set-page">
            <h1 className="page-title" style={{ marginBottom: 22 }}>{sections.find((x) => x.id === sec)?.label}</h1>

            {sec === 'general' && <>
              <Group title="Inicio" icon="home">
                <Row label="Abrir el último proyecto al iniciar" desc="Vuelve directo al editor donde lo dejaste."><Switch checked={s.ui.openLastProject} onChange={(v) => up({ ui: { openLastProject: v } })} /></Row>
                <Row label="Confirmar antes de borrar proyectos" desc={android ? 'Los proyectos borrados van a la papelera (Ajustes › Almacenamiento).' : 'Los proyectos borrados van a la papelera de Windows.'}><Switch checked={s.ui.confirmDelete} onChange={(v) => up({ ui: { confirmDelete: v } })} /></Row>
              </Group>
              {!android && <Group title="Datos" icon="drive" desc="OpenAnimator es portable: todo se guarda junto al programa.">
                <Row label="Carpeta de datos" desc="Proyectos, ajustes, guías para la IA y cachés."><span className="path" data-tip={info?.dataDir}>{info?.dataDir}</span><Button size="sm" icon="folder-open" onClick={() => call('shell:openPath', info?.dataDir)}>Abrir</Button></Row>
                <Row label="Carpeta de proyectos"><span className="path" data-tip={info?.projectsDir}>{info?.projectsDir}</span><Button size="sm" icon="folder-open" onClick={() => call('projects:openFolder')}>Abrir</Button></Row>
              </Group>}
              {android && <Group title="Datos" icon="drive" desc="Tus proyectos se guardan dentro de la app. Para pasarlos a la PC (o de la PC a la tablet), compartilos como .zip desde el menú de cada proyecto.">
                <Row label="Almacenamiento" desc="Espacio usado, papelera y videos exportados."><Button size="sm" icon="drive" onClick={() => setSec('almacenamiento')}>Ver</Button></Row>
              </Group>}
            </>}

            {sec === 'apariencia' && <>
              <Group title="Tema" icon="palette">
                <Row label="Color de acento" desc="Botones principales, selección y resaltados.">
                  <div className="swatches">{ACCENTS.map((a) => <button key={a.id} className={`swatch ${s.ui.accent === a.id ? 'on' : ''}`} style={{ background: a.c }} data-tip={a.name} onClick={() => up({ ui: { accent: a.id } })} />)}</div>
                </Row>
                <Row label="Densidad" desc="Compacta muestra más en pantallas chicas.">
                  <Segmented value={s.ui.density} onChange={(v) => up({ ui: { density: v } })} options={[{ value: 'comfortable', label: 'Cómoda' }, { value: 'compact', label: 'Compacta' }]} />
                </Row>
                <Row label="Reducir animaciones" desc="Desactiva transiciones de la interfaz (no afecta a tus videos)."><Switch checked={s.ui.reduceMotion} onChange={(v) => up({ ui: { reduceMotion: v } })} /></Row>
              </Group>
            </>}

            {sec === 'editor' && <>
              <Group title="Timeline" icon="layers">
                <Row label="Imán (snap)" desc="Los clips se pegan a bordes, cursor, notas y otros clips."><Switch checked={s.editor.snap} onChange={(v) => up({ editor: { snap: v } })} /></Row>
                <Row label="Ajustar a fotogramas" desc="Mover y recortar siempre en fotogramas enteros."><Switch checked={s.editor.snapFrames} onChange={(v) => up({ editor: { snapFrames: v } })} /></Row>
                <Row label="Seguir el cursor al reproducir" desc="El timeline se desplaza para mantener visible el cursor."><Switch checked={s.editor.followPlayhead} onChange={(v) => up({ editor: { followPlayhead: v } })} /></Row>
                <Row label="Formas de onda de audio" desc="Se calculan una vez y quedan en caché."><Switch checked={s.editor.waveforms} onChange={(v) => up({ editor: { waveforms: v } })} /></Row>
                <Row label="Zoom inicial" desc={`${s.editor.defaultZoom} píxeles por segundo al abrir un proyecto.`}><Slider value={s.editor.defaultZoom} min={4} max={300} onChange={(v) => up({ editor: { defaultZoom: v } })} width={180} /></Row>
                <Row label="Duración de imágenes" desc="Duración al agregar una imagen al timeline."><NumberInput value={s.editor.imageDuration} min={0.5} max={600} step={0.5} suffix="s" width={100} onChange={(v) => up({ editor: { imageDuration: v } })} /></Row>
              </Group>
              <Group title="Visor" icon="monitor">
                <Row label="Fondo del visor" desc="Lo que se ve alrededor del cuadro.">
                  <Segmented value={s.editor.stageBg} onChange={(v) => up({ editor: { stageBg: v } })} options={[{ value: 'dark', label: 'Oscuro' }, { value: 'black', label: 'Negro' }, { value: 'gray', label: 'Gris' }, { value: 'checker', label: 'Damero' }]} />
                </Row>
                <Row label="Zonas seguras" desc="Márgenes de acción (93 %) y de títulos (80 %)."><Switch checked={s.editor.safeAreas} onChange={(v) => up({ editor: { safeAreas: v } })} /></Row>
                <Row label="Guía de tercios"><Switch checked={s.editor.thirds} onChange={(v) => up({ editor: { thirds: v } })} /></Row>
                {!android && <Row label="Mostrar el chat de IA al abrir"><Switch checked={s.editor.showChat} onChange={(v) => up({ editor: { showChat: v } })} /></Row>}
              </Group>
            </>}

            {sec === 'ia' && android && <ClaudeSection />}
            {sec === 'tablet' && android && <TabletSection />}
            {sec === 'almacenamiento' && android && <StorageSection />}
            {sec === 'ia' && !android && <>
              <Group title="Conexión" icon="sparkles" desc="OpenAnimator usa tu Claude Code instalado, con tu propia cuenta.">
                <Row label="Claude Code" desc={info?.claude ? 'Detectado y listo.' : 'No se encontró. Instalalo desde claude.com/code.'}>
                  {info?.claude ? <Badge tone="ok" icon="check">Conectado</Badge> : <Button size="sm" icon="external" onClick={() => call('shell:openExternal', 'https://claude.com/code')}>Descargar</Button>}
                </Row>
                <Row label="Ruta de Claude Code" desc="Dejalo vacío para detectarlo automáticamente." stack>
                  <div className="row">
                    <div className="grow"><TextInput mono value={s.claude.claudePath} placeholder={info?.claude || 'claude.exe'} onChange={(v) => up({ claude: { claudePath: v } })} clearable /></div>
                    <Button icon="folder" onClick={async () => { const f = await call('settings:pickFile', 'Elegí claude.exe'); if (f) up({ claude: { claudePath: f } }) }}>Buscar…</Button>
                  </div>
                </Row>
              </Group>
              <Group title="Modelo y razonamiento" icon="gauge" desc="Valores por defecto para chats nuevos. También se cambian desde el propio chat.">
                <Row label="Modelo">
                  <Select value={s.claude.model} width={240} menuWidth={320} onChange={(v) => up({ claude: { model: v } })}
                    options={MODELS.map((m) => ({ value: m.id, label: m.name, desc: m.desc, hint: m.note }))} />
                </Row>
                <Row label="Nivel de esfuerzo" desc="Más esfuerzo = piensa más: mejor en escenas complejas, pero más lento.">
                  <Select value={s.claude.effort} width={240} menuWidth={300} onChange={(v) => up({ claude: { effort: v } })}
                    options={EFFORTS.map((e) => ({ value: e.id, label: e.name, desc: e.desc }))} />
                </Row>
                <Row label="Permisos" desc="Qué puede hacer Claude sin preguntarte.">
                  <Select value={s.claude.permissionMode} width={240} menuWidth={340} onChange={(v) => up({ claude: { permissionMode: v } })} options={[
                    { value: 'default', label: 'Preguntar todo', desc: 'Pide permiso para cada edición y comando' },
                    { value: 'acceptEdits', label: 'Aceptar ediciones', desc: 'Edita archivos del proyecto sin preguntar (recomendado)' },
                    { value: 'plan', label: 'Sólo planificar', desc: 'Propone un plan sin tocar nada' },
                    { value: 'bypassPermissions', label: 'Sin preguntar', desc: 'Hace todo sin pedir permiso. Bajo tu responsabilidad' },
                  ]} />
                </Row>
              </Group>
              <Group title="Instrucciones" icon="message">
                <Row label="Instrucciones adicionales" desc="Se agregan a cada conversación (estilo, idioma, tono, marca…)." stack>
                  <TextArea rows={4} value={s.claude.extraInstructions} placeholder="Ej.: Usá siempre la paleta de mi marca (#0E3B5C, #F2A541). Textos en español rioplatense. Nada de emojis." onChange={(v) => up({ claude: { extraInstructions: v } })} />
                </Row>
                <Row label="Notas para la IA (NOTAS-IA.md)" desc="Un archivo que Claude lee en todos los proyectos. Ideal para preferencias largas."><Button size="sm" icon="external" onClick={() => call('ai:openNotes')}>Abrir archivo</Button></Row>
              </Group>
              <Group title="Chat" icon="message">
                <Row label="Modo ahorro" desc="Claude gasta menos de tu límite de uso: mira fotogramas más chicos y menos veces, no relee archivos, resume adjuntos largos y responde corto. También se activa con la hoja del chat."><Switch checked={s.claude.saver !== false} onChange={(v) => up({ claude: { saver: v } })} /></Row>
                <Row label="Mostrar el razonamiento" desc="Ver lo que Claude piensa mientras trabaja."><Switch checked={s.claude.showThinking} onChange={(v) => up({ claude: { showThinking: v } })} /></Row>
                <Row label="Mostrar costo y duración" desc="Al final de cada respuesta."><Switch checked={s.claude.showCost} onChange={(v) => up({ claude: { showCost: v } })} /></Row>
                <Row label="Seguir la última conversación" desc="Al abrir un proyecto, Claude sigue donde quedó (con el botón + empezás una nueva)."><Switch checked={s.claude.continueChat !== false} onChange={(v) => up({ claude: { continueChat: v } })} /></Row>
                <Row label="Adjuntar el fotograma actual" desc="Cada mensaje incluye la imagen del visor en el cursor."><Switch checked={s.claude.autoAttachFrame} onChange={(v) => up({ claude: { autoAttachFrame: v } })} /></Row>
              </Group>
            </>}

            {sec === 'plugins' && <PluginsSettings />}

            {sec === 'export' && android && <ExportSection />}
            {sec === 'export' && !android && <>
              <Group title="Destino" icon="folder">
                <Row label="Carpeta por defecto" desc={s.exportPrefs.defaultDir ? undefined : 'Si está vacía, se usa la última carpeta usada.'}>
                  {s.exportPrefs.defaultDir && <span className="path" data-tip={s.exportPrefs.defaultDir}>{s.exportPrefs.defaultDir}</span>}
                  <Button size="sm" icon="folder" onClick={async () => { const d = await call('settings:pickDir', 'Carpeta de exportación'); if (d) up({ exportPrefs: { defaultDir: d } }) }}>Elegir…</Button>
                  {s.exportPrefs.defaultDir && <Button size="sm" variant="ghost" icon="x" tip="Quitar" onClick={() => up({ exportPrefs: { defaultDir: '' } })} />}
                </Row>
                <Row label="Mostrar el archivo al terminar" desc="Abre el Explorador con el video seleccionado."><Switch checked={s.exportPrefs.openFolderWhenDone} onChange={(v) => up({ exportPrefs: { openFolderWhenDone: v } })} /></Row>
                <Row label="Notificación del sistema" desc="Avisa cuando termina una exportación si estás en otra ventana."><Switch checked={s.exportPrefs.notify} onChange={(v) => up({ exportPrefs: { notify: v } })} /></Row>
              </Group>
              <Group title="Valores por defecto" icon="film" desc="Se recuerdan los últimos que usaste en el diálogo de exportación.">
                <Row label="Códec de video">
                  <Select value={(ex.vcodec as string) || 'h264_nvenc'} width={220} onChange={(v) => up({ export: { ...ex, vcodec: v as any } })} options={[
                    { value: 'h264_nvenc', label: 'H.264 · NVENC', disabled: !info?.encoders.h264_nvenc }, { value: 'hevc_nvenc', label: 'HEVC · NVENC', disabled: !info?.encoders.hevc_nvenc },
                    { value: 'av1_nvenc', label: 'AV1 · NVENC', disabled: !info?.encoders.av1_nvenc }, { value: 'libx264', label: 'H.264 · x264 (CPU)' }, { value: 'libx265', label: 'HEVC · x265 (CPU)' }]} />
                </Row>
                <Row label="Calidad (CQ)" desc={`${ex.cq ?? 19} · menor es mejor (18–22 recomendado).`}><Slider value={ex.cq ?? 19} min={12} max={36} onChange={(v) => up({ export: { ...ex, cq: v } })} width={180} /></Row>
                <Row label="Workers en paralelo" desc="Ventanas de captura simultáneas. 4 suele ser el punto óptimo.">
                  <Segmented value={ex.workers ?? 4} onChange={(v) => up({ export: { ...ex, workers: v } })} options={[1, 2, 4, 6, 8].map((n) => ({ value: n, label: String(n) }))} />
                </Row>
              </Group>
            </>}

            {sec === 'rendimiento' && <>
              <Group title="Aceleración" icon="zap">
                <Row label="Tarjeta gráfica" desc={info?.gpu || '—'}>{info?.gpu ? <Badge tone="ok" icon="check">Detectada</Badge> : <Badge tone="warn">No detectada</Badge>}</Row>
                <Row label="Codificadores por hardware" desc="Probados al iniciar con una codificación real.">
                  <div className="row" style={{ gap: 5 }}>{['h264', 'hevc', 'av1'].map((c) => <Badge key={c} tone={info?.encoders[`${c}_nvenc`] ? 'ok' : 'neutral'}>{c.toUpperCase()}</Badge>)}</div>
                </Row>
              </Group>
              <Group title="Cachés" icon="drive" desc="Se pueden borrar sin perder trabajo; se regeneran solas.">
                <Row label="Segmentos de exportación" desc="Permiten reanudar exportaciones cortadas."><span className="t2 tabnum">{cache ? fmtSize(cache.export) : '…'}</span><Button size="sm" icon="trash" onClick={() => clear('export', 'la caché de exportación')}>Borrar</Button></Row>
                <Row label="Formas de onda" desc="Picos de audio del timeline."><span className="t2 tabnum">{cache ? fmtSize(cache.peaks) : '…'}</span><Button size="sm" icon="trash" onClick={() => clear('peaks', 'la caché de formas de onda')}>Borrar</Button></Row>
                <Row label="Miniaturas de video" desc="Panel de medios."><span className="t2 tabnum">{cache ? fmtSize(cache.thumbs) : '…'}</span><Button size="sm" icon="trash" onClick={() => clear('thumbs', 'la caché de miniaturas')}>Borrar</Button></Row>
              </Group>
            </>}

            {sec === 'atajos' && (
              <div className="set-card shortcuts">
                {SHORTCUTS.map(([label, keys]) => [
                  <div key={label}>{label}</div>,
                  <div key={label + 'k'}>{keys.map((k, i) => <span key={i} className="row" style={{ gap: 4 }}>{i > 0 && <span className="t4">+</span>}<kbd className="kbd">{k}</kbd></span>)}</div>,
                ])}
              </div>
            )}

            {sec === 'acerca' && android && <AboutSection />}
            {sec === 'acerca' && !android && <>
              <div className="set-card" style={{ padding: 22, display: 'flex', gap: 18, alignItems: 'center', marginBottom: 26 }}>
                <Logo size={56} />
                <div>
                  <div style={{ font: '600 18px var(--font-display)' }}>OpenAnimator</div>
                  <div className="t3">Versión {ver?.app || info?.version} · {info?.portable ? 'portable' : 'desarrollo'} · licencia MIT</div>
                  <div className="t2" style={{ marginTop: 6 }}>Estudio open source de video animado con HTML/SVG, IA y exportación por GPU.</div>
                </div>
              </div>
              <Group title="Componentes" icon="layers">
                <Row label="Electron"><span className="mono t2">{ver?.electron}</span></Row>
                <Row label="Chromium"><span className="mono t2">{ver?.chrome}</span></Row>
                <Row label="Node.js"><span className="mono t2">{ver?.node}</span></Row>
                <Row label="FFmpeg" desc={info?.ffmpeg}><span className="mono t2">{ver?.ffmpeg}</span></Row>
              </Group>
            </>}
          </div>
        </main>
      </div>
      {dlg.element}
    </>
  )
}
