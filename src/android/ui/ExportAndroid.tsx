/**
 * Exportar en la tablet: el codificador de hardware (H.264 / HEVC) con presets claros, progreso con
 * vista previa del fotograma que se está codificando y, al terminar, galería / compartir / abrir.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { call, fmtSize, fmtTime, on, Project, Timeline } from '../../api'
import { useApp } from '../../App'
import Modal from '../../components/Modal'
import { useDialogs } from '../../components/Dialogs'
import { Icon, IconName } from '../../ui/icons'
import { Badge, Button, Field, NumberInput, Progress, Segmented, Select, Switch, TextInput } from '../../ui/kit'
import { autoBitrate, type ExportQuality as Quality } from '../bitrate'

type Codec = 'avc' | 'hevc'
type Prog = { id: string; phase: string; message: string; done: number; total: number; fps?: number; eta?: number; elapsed?: number; file?: string; gallery?: string; size?: number; encoder?: string; preview?: string; note?: string; details?: string }
type Saved = { path: string; name: string; size: number; mtime: number }

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
const QUALITY: Array<{ value: Quality; label: string }> = [{ value: 'low', label: 'Baja' }, { value: 'medium', label: 'Media' }, { value: 'high', label: 'Alta' }, { value: 'max', label: 'Máxima' }]
const PHASE: Record<string, string> = { preparando: 'Preparando', audio: 'Mezclando el audio', render: 'Renderizando', final: 'Escribiendo el archivo', listo: 'Listo', error: 'Error', cancelado: 'Cancelado' }
const PRESETS: Array<{ id: string; name: string; sub: string; icon: IconName; res: number; codec: Codec; quality: Quality }> = [
  { id: 'rec', name: 'Recomendado', sub: '1080p · H.264 · alta', icon: 'star', res: 1080, codec: 'avc', quality: 'high' },
  { id: '4k', name: '4K', sub: '2160p · HEVC · máxima', icon: 'sparkles', res: 2160, codec: 'hevc', quality: 'max' },
  { id: 'light', name: 'Liviano', sub: '720p · H.264 · media', icon: 'zap', res: 720, codec: 'avc', quality: 'medium' },
  { id: 'master', name: 'Para editar', sub: '1080p · H.264 · máxima', icon: 'scissors', res: 1080, codec: 'avc', quality: 'max' },
]

const secs = (s?: number) => {
  if (s == null || !isFinite(s)) return '—'
  const r = Math.max(1, Math.round(s)) // redondeado antes de partirlo: nunca «1 min 60 s»
  return r < 60 ? `${r} s` : `${Math.floor(r / 60)} min ${r % 60} s`
}

export default function ExportAndroid({ project, currentTl, onClose }: { project: Project; currentTl: string; onClose: () => void }) {
  const { toast, settings, updateSettings, info } = useApp()
  const dlg = useDialogs()
  const def = settings?.androidExport
  const aspect = project.width / project.height
  const short = Math.min(project.width, project.height)
  const sizeFor = (h: number) => (aspect >= 1 ? { w: even(h * aspect), h: even(h) } : { w: even(h), h: even(h / aspect) })
  const hevcOk = (info as any)?.codecs?.hevc !== false

  const [tlId, setTlId] = useState(currentTl)
  const [tl, setTl] = useState<Timeline | null>(null)
  const [res, setRes] = useState<number>(def?.height || (short >= 2160 ? 2160 : short >= 1440 ? 1440 : short >= 1080 ? 1080 : 720))
  const [fps, setFps] = useState<number>(def?.fps || project.fps)
  const [codec, setCodec] = useState<Codec>(def?.codec === 'hevc' && hevcOk ? 'hevc' : 'avc')
  const [quality, setQuality] = useState<Quality>((def?.quality as Quality) || 'high')
  const [audio, setAudio] = useState(def?.audio !== false)
  const [name, setName] = useState(project.name)
  const [useRange, setUseRange] = useState(false)
  const [range, setRange] = useState({ start: 0, end: 10 })
  const [job, setJob] = useState<string | null>(null)
  const [prog, setProg] = useState<Prog | null>(null)
  const [saved, setSaved] = useState<Saved[]>([])

  useEffect(() => { call<Timeline>('timeline:get', project.id, tlId).then((x) => { setTl(x); setRange({ start: 0, end: +x.duration.toFixed(2) }) }).catch(() => setTl(null)) }, [tlId])
  useEffect(() => { call<Saved[]>('export:list').then(setSaved).catch(() => {}) }, [job, prog?.phase])
  const [lastDetails, setLastDetails] = useState('')
  useEffect(() => { call<string>('export:lastDetails').then((t) => setLastDetails(t || '')).catch(() => {}) }, [job, prog?.phase])
  // Escucha desde el principio: una exportación que falla enseguida puede avisar antes de que
  // export:start devuelva su id. La vista previa llega cada tanto: se conserva la última.
  const latest = useRef(new Map<string, Prog>())
  const jobRef = useRef<string | null>(null)
  // El tiempo transcurrido sigue corriendo entre avisos (un paso largo no parece la app trabada).
  const got = useRef(0)
  const [, tick] = useState(0)
  useEffect(() => on('export:progress', (p: Prog) => {
    const next = { ...p, preview: p.preview || latest.current.get(p.id)?.preview }
    latest.current.set(p.id, next)
    if (p.id === jobRef.current) { got.current = performance.now(); setProg(next) }
  }), [])
  const running = !!job && !!prog && !['listo', 'error', 'cancelado'].includes(prog.phase)
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [running])

  const { w, h } = sizeFor(res)
  const dur = tl ? (useRange ? Math.max(0, range.end - range.start) : tl.duration) : 0
  const vbps = autoBitrate(w, h, fps, quality, codec)
  const estimate = (vbps + (audio ? 192000 : 0)) * dur / 8
  const preset = PRESETS.find((p) => p.res === res && p.codec === codec && p.quality === quality)?.id || 'custom'
  const resOptions = useMemo(() => [720, 1080, 1440, 2160].map((x) => ({ value: x, label: `${x}p`, hint: `${sizeFor(x).w}×${sizeFor(x).h}` })), [aspect])

  const start = async () => {
    if (!tl || dur < 1 / fps) { toast('No hay nada para exportar en ese timeline (o en el rango elegido)', true); return }
    updateSettings({ androidExport: { codec, quality, height: res, fps: fps === project.fps ? 0 : fps, audio, bitrate: 0, audioBitrate: 192 } })
    try {
      const id = await call<string>('export:start', {
        projectId: project.id, timeline: tlId, range: useRange ? range : null, width: w, height: h, fps, codec, quality, audio, audioBitrate: 192,
        name: name.trim() || project.name,
      })
      jobRef.current = id
      got.current = performance.now()
      setJob(id); setProg(latest.current.get(id) || { id, phase: 'preparando', message: 'Preparando…', done: 0, total: 1, elapsed: 0 })
    } catch (e: any) { toast(e.message, true) }
  }
  const cancel = async () => {
    if (!job) return
    if (await dlg.confirm({ title: '¿Cancelar la exportación?', message: 'Se descarta el video a medio hacer.', ok: 'Cancelar exportación', cancel: 'Seguir', danger: true })) call('export:cancel', job)
  }
  const close = async () => {
    if (job && prog && !['listo', 'error', 'cancelado'].includes(prog.phase)) {
      if (!(await dlg.confirm({ title: '¿Seguir en segundo plano?', message: 'La exportación continúa mientras la app esté abierta. No la cierres ni apagues la pantalla.', ok: 'Ocultar' }))) return
      const id = job
      const off = on('export:progress', (p: Prog) => {
        if (p.id !== id || !['listo', 'error', 'cancelado'].includes(p.phase)) return
        off()
        if (p.phase === 'listo') toast(`Video listo${p.gallery ? ` · guardado en ${p.gallery}` : ''}`)
        else if (p.phase === 'error') toast('La exportación falló: ' + p.message, true)
      })
    }
    onClose()
  }

  // ── progreso ──
  if (job && prog) {
    const done = prog.phase === 'listo', failed = prog.phase === 'error' || prog.phase === 'cancelado'
    const pct = done ? 100 : prog.phase === 'render' && prog.total ? (prog.done / prog.total) * 100 : prog.phase === 'final' ? 99 : 0
    const elapsed = running && prog.elapsed != null ? prog.elapsed + (performance.now() - got.current) / 1000 : prog.elapsed
    const step = prog.phase === 'render' ? ` · ${prog.message}` : prog.phase === 'audio' && prog.total ? ` · ${Math.floor((prog.done / prog.total) * 100)} %` : ''
    const file = prog.file || ''
    return (
      <Modal size="wide" icon={done ? 'check-circle' : failed ? 'x-circle' : 'export'} title={done ? 'Video listo' : failed ? PHASE[prog.phase] : 'Exportando'} subtitle={`${name}.mp4 · ${w}×${h} · ${fps} fps · ${codec === 'hevc' ? 'HEVC' : 'H.264'}`}
        onClose={close} persistent={!done && !failed}
        footer={done ? <>
          <Button variant="ghost" icon="download" onClick={() => call('export:save', file).catch((e) => toast(e.message, true))}>Guardar en…</Button>
          <div className="grow" />
          <Button icon="share" onClick={() => call('export:share', file).catch((e) => toast(e.message, true))}>Compartir</Button>
          <Button variant="primary" icon="play" onClick={() => call('export:open', file).catch((e) => toast(e.message, true))}>Ver el video</Button>
        </> : failed ? <><div className="grow" /><Button onClick={() => { jobRef.current = null; setJob(null); setProg(null) }}>Volver a los ajustes</Button><Button variant="primary" onClick={onClose}>Cerrar</Button></>
          : <><span className="t3" style={{ fontSize: 13 }}>No cierres la app ni bloquees la pantalla mientras exporta.</span><div className="grow" /><Button onClick={close}>Ocultar</Button><Button variant="danger" icon="stop" onClick={cancel}>Cancelar</Button></>}>
        {done ? (
          <div className="xp-done">
            <div className="xp-done-ico"><Icon name="check" size={32} stroke={2.4} /></div>
            <div style={{ font: '600 20px var(--font-display)' }}>{file.split('/').pop()}</div>
            <div className="t2">{fmtSize(prog.size || 0)} · {fmtTime(dur)} · en {secs(prog.elapsed)}</div>
            {prog.gallery ? <Badge tone="ok" icon="gallery">Guardado en la galería · {prog.gallery}</Badge> : <Badge tone="neutral" icon="drive">Guardado en la app (Ajustes › Almacenamiento)</Badge>}
            {prog.encoder && <div className="t3" style={{ fontSize: 12.5 }}>Codificador: {prog.encoder}{prog.fps ? ` · ${prog.fps.toFixed(1).replace('.', ',')} fps` : ''}</div>}
            {prog.note && <div className="t3" style={{ fontSize: 12.5, maxWidth: 560, textAlign: 'center' }}>{prog.note}</div>}
            {prog.details && <Details text={prog.details} />}
          </div>
        ) : (
          <div className="xp-run">
            <div className="xp-preview">{prog.preview ? <img src={prog.preview} alt="" /> : <Icon name="film" size={34} className="t4" />}</div>
            <div>
              <div className="xp-big tabnum">{Math.floor(pct)}<span className="t3" style={{ fontSize: 24 }}> %</span></div>
              <div className="xp-phase">{failed ? prog.message : `${PHASE[prog.phase] || prog.phase}${step}`}</div>
              {failed && prog.details && <Details text={prog.details} />}
              <div style={{ marginTop: 16 }}><Progress value={pct} indeterminate={prog.phase === 'preparando' || prog.phase === 'audio' || prog.phase === 'final' || (prog.phase === 'render' && !prog.done)} tone={failed ? 'err' : undefined} /></div>
              {!failed && <div className="xp-meta">
                <div><div className="k">Velocidad</div><div className="v tabnum">{prog.fps ? `${prog.fps.toFixed(1)} fps` : '—'}</div></div>
                <div><div className="k">Falta</div><div className="v tabnum">{prog.phase === 'render' ? secs(prog.eta) : '—'}</div></div>
                <div><div className="k">Transcurrido</div><div className="v tabnum">{secs(elapsed)}</div></div>
                <div><div className="k">Tamaño estimado</div><div className="v tabnum">~{fmtSize(estimate)}</div></div>
              </div>}
            </div>
          </div>
        )}
        {dlg.element}
      </Modal>
    )
  }

  // ── ajustes ──
  return (
    <Modal size="wide" icon="export" title="Exportar video" subtitle="Se codifica con el hardware de la tablet y se guarda en la galería." onClose={onClose}
      footer={<><span className="t3" style={{ fontSize: 13 }}>{w}×{h} · {fps} fps · {codec === 'hevc' ? 'HEVC' : 'H.264'}{audio ? ' + AAC' : ' · sin audio'}</span><div className="grow" /><Button onClick={onClose}>Cancelar</Button><Button variant="primary" icon="export" onClick={start} disabled={!tl || dur < 1 / fps}>Exportar</Button></>}>
      <div className="xp-presets">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" className={`xp-preset ${preset === p.id ? 'on' : ''}`} disabled={p.codec === 'hevc' && !hevcOk}
            onClick={() => { setRes(p.res); setCodec(p.codec === 'hevc' && !hevcOk ? 'avc' : p.codec); setQuality(p.quality) }}>
            <Icon name={p.icon} size={20} /><b>{p.name}</b><span>{p.sub}</span>
          </button>
        ))}
      </div>
      <div className="xp-grid">
        <Field label="Nombre del archivo"><TextInput value={name} onChange={setName} suffix={<span className="t3">.mp4</span>} /></Field>
        {project.timelines.length > 1
          ? <Field label="Timeline"><Select value={tlId} onChange={(v) => setTlId(String(v))} options={project.timelines.map((x) => ({ value: x.id, label: x.name, icon: 'layers' as IconName }))} /></Field>
          : <Field label="Duración"><div className="input" style={{ color: 'var(--t2)' }}>{tl ? fmtTime(tl.duration, true, project.fps) : '…'}</div></Field>}
        <Field label="Resolución"><Select value={res} onChange={(v) => setRes(+v)} options={resOptions} /></Field>
        <Field label="Cuadros por segundo"><Segmented full value={fps} onChange={setFps} options={[...new Set([24, 25, 30, 50, 60, project.fps])].sort((a, b) => a - b).map((f) => ({ value: f, label: String(f) }))} /></Field>
        <Field label="Códec" hint={codec === 'hevc' ? 'HEVC: la mitad de tamaño con la misma calidad; algunos equipos viejos no lo reproducen.' : 'H.264: se reproduce en cualquier lado.'}>
          <Segmented full value={codec} onChange={setCodec} options={[{ value: 'avc', label: 'H.264' }, ...(hevcOk ? [{ value: 'hevc' as Codec, label: 'HEVC (H.265)' }] : [])]} />
        </Field>
        <Field label="Calidad" hint={`${(vbps / 1e6).toFixed(1)} Mbps de video`}><Segmented full value={quality} onChange={setQuality} options={QUALITY} /></Field>
        <Field label="Audio"><div className="row" style={{ height: 'var(--h-md)' }}><Switch checked={audio} onChange={setAudio} /><span className="t2">{audio ? 'Voz, música y efectos (AAC 192 kbps)' : 'Sin audio'}</span></div></Field>
        <Field label="Exportar sólo un tramo">
          <div className="row">
            <Switch checked={useRange} onChange={setUseRange} />
            {useRange && tl && <>
              <NumberInput width={120} value={range.start} min={0} max={tl.duration} step={1} decimals={2} suffix="s" onChange={(v) => setRange((r) => ({ ...r, start: Math.min(v, r.end) }))} />
              <span className="t3">a</span>
              <NumberInput width={120} value={range.end} min={0} max={tl.duration} step={1} decimals={2} suffix="s" onChange={(v) => setRange((r) => ({ ...r, end: Math.max(v, r.start) }))} />
            </>}
          </div>
        </Field>
      </div>
      <div className="xp-est">
        <Icon name="drive" size={20} />
        <span className="grow">Tamaño aproximado: <b>{fmtSize(estimate)}</b> para {fmtTime(dur)} de video.</span>
        <span className="row" style={{ gap: 10 }}><span className="t3">Guardar en la galería</span><Switch checked={settings?.android?.saveToGallery !== false} onChange={(v) => updateSettings({ android: { saveToGallery: v } })} /></span>
      </div>
      {lastDetails && <div style={{ marginTop: 12 }}><Details text={lastDetails} label="Detalles de la última exportación" /></div>}
      {saved.length > 0 && <>
        <div className="caps" style={{ margin: '24px 0 6px' }}>Exportaciones anteriores</div>
        <div className="xp-list">
          {saved.slice(0, 6).map((x) => (
            <div key={x.path} className="xp-item">
              <Icon name="film" size={18} className="t3" />
              <span className="grow ellipsis">{x.name}</span>
              <span className="t3 tabnum" style={{ fontSize: 13 }}>{fmtSize(x.size)}</span>
              <Button size="sm" variant="ghost" icon="play" tip="Ver" onClick={() => call('export:open', x.path)} />
              <Button size="sm" variant="ghost" icon="share" tip="Compartir" onClick={() => call('export:share', x.path)} />
              <Button size="sm" variant="ghost" icon="trash" tip="Borrar de la app" onClick={async () => {
                if (!(await dlg.confirm({ title: `¿Borrar «${x.name}»?`, message: 'Se borra la copia de la app. La de la galería (si la guardaste) no se toca.', ok: 'Borrar', danger: true }))) return
                await call('export:delete', x.path); setSaved(await call('export:list'))
              }} />
            </div>
          ))}
        </div>
      </>}
      {dlg.element}
    </Modal>
  )
}

/** Tiempos y métodos de la exportación, para copiarlos y mandarlos (sirven para ver dónde se va el tiempo). */
function Details({ text, label = 'Detalles' }: { text: string; label?: string }) {
  const { toast } = useApp()
  const copy = () => call('clipboard:text', text).then(() => toast('Detalles copiados'), (e) => toast(e.message, true))
  return (
    <details className="xp-details">
      <summary><Icon name="info" size={13} />{label}</summary>
      <pre>{text}</pre>
      <Button size="sm" icon="copy" onClick={copy}>Copiar detalles</Button>
    </details>
  )
}
