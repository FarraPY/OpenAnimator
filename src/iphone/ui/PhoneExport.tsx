/**
 * Exportar en el iPhone: el codificador de hardware (WebCodecs: H.264 o HEVC) con opciones claras, el progreso con el
 * fotograma que se está codificando y, al terminar, Guardar en Fotos / Compartir (la hoja de iOS, que sólo se abre
 * con un toque: por eso es un botón y no algo automático).
 */
import { useEffect, useRef, useState } from 'react'
import { call, fmtSize, fmtTime, on, Project, Timeline } from '../../api'
import { useApp } from '../../App'
import { useDialogs } from '../../components/Dialogs'
import { Icon } from '../../ui/icons'
import { Button, Progress, Switch, TextInput } from '../../ui/kit'
import { autoBitrate, type ExportQuality as Quality } from '../../android/bitrate'
import { Chips, Group, Row, Sheet } from './PhoneApp'

type Codec = 'avc' | 'hevc'
type Prog = { id: string; phase: string; message: string; done: number; total: number; fps?: number; eta?: number; elapsed?: number; file?: string; size?: number; encoder?: string; preview?: string; details?: string }
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
const PHASE: Record<string, string> = { preparando: 'Preparando', audio: 'Mezclando el audio', render: 'Renderizando', final: 'Escribiendo el archivo', listo: 'Listo', error: 'Error', cancelado: 'Cancelado' }
const secs = (s?: number) => { if (s == null || !isFinite(s)) return '—'; const r = Math.max(1, Math.round(s)); return r < 60 ? `${r} s` : `${Math.floor(r / 60)} min ${r % 60} s` }

export default function PhoneExport({ project, currentTl, onClose }: { project: Project; currentTl: string; onClose: () => void }) {
  const { toast, settings, updateSettings, info } = useApp()
  const dlg = useDialogs()
  const def = settings?.androidExport
  const aspect = project.width / project.height
  const short = Math.min(project.width, project.height)
  const sizeFor = (h: number) => (aspect >= 1 ? { w: even(h * aspect), h: even(h) } : { w: even(h), h: even(h / aspect) })
  const hevcOk = (info as any)?.codecs?.hevc !== false
  const [tl, setTl] = useState<Timeline | null>(null)
  const [res, setRes] = useState<number>(def?.height || (short >= 1080 ? 1080 : 720))
  const [fps, setFps] = useState<number>(def?.fps || project.fps)
  const [codec, setCodec] = useState<Codec>(def?.codec === 'hevc' && hevcOk ? 'hevc' : 'avc')
  const [quality, setQuality] = useState<Quality>((def?.quality as Quality) || 'high')
  const [audio, setAudio] = useState(def?.audio !== false)
  const [name, setName] = useState(project.name)
  const [job, setJob] = useState<string | null>(null)
  const [prog, setProg] = useState<Prog | null>(null)
  const jobRef = useRef<string | null>(null)
  const latest = useRef(new Map<string, Prog>())

  useEffect(() => { call<Timeline>('timeline:get', project.id, currentTl).then(setTl).catch(() => setTl(null)) }, [])
  useEffect(() => on('export:progress', (p: Prog) => {
    const next = { ...p, preview: p.preview || latest.current.get(p.id)?.preview }
    latest.current.set(p.id, next)
    if (p.id === jobRef.current) setProg(next)
  }), [])

  const { w, h } = sizeFor(res)
  const dur = tl?.duration || 0
  const vbps = autoBitrate(w, h, fps, quality, codec)
  const estimate = (vbps + (audio ? 192000 : 0)) * dur / 8
  const running = !!job && !!prog && !['listo', 'error', 'cancelado'].includes(prog.phase)

  const start = async () => {
    if (!tl || dur < 1 / fps) { toast('No hay nada para exportar en este timeline', true); return }
    updateSettings({ androidExport: { codec, quality, height: res, fps: fps === project.fps ? 0 : fps, audio, bitrate: 0, audioBitrate: 192 } })
    try {
      const id = await call<string>('export:start', { projectId: project.id, timeline: currentTl, range: null, width: w, height: h, fps, codec, quality, audio, audioBitrate: 192, name: name.trim() || project.name })
      jobRef.current = id
      setJob(id); setProg(latest.current.get(id) || { id, phase: 'preparando', message: 'Preparando…', done: 0, total: 1 })
    } catch (e: any) { toast(e.message, true) }
  }
  const cancel = async () => { if (job && (await dlg.confirm({ title: '¿Cancelar la exportación?', message: 'Se descarta el video a medio hacer.', ok: 'Cancelar exportación', cancel: 'Seguir', danger: true }))) call('export:cancel', job) }
  const act = (ch: string, file: string) => call(ch, file).catch((e) => { if (e?.name !== 'AbortError' && !/abort|cancel/i.test(e?.message || '')) toast(e.message, true) })

  if (job && prog) {
    const done = prog.phase === 'listo', failed = prog.phase === 'error' || prog.phase === 'cancelado'
    const pct = done ? 100 : prog.phase === 'render' && prog.total ? (prog.done / prog.total) * 100 : prog.phase === 'final' ? 99 : 0
    const file = prog.file || ''
    return (
      <Sheet title={done ? 'Video listo' : failed ? PHASE[prog.phase] : 'Exportando'} onClose={done || failed ? onClose : () => {}} persistent={running} tall
        footer={done ? <>
          <Button variant="primary" size="lg" icon="gallery" onClick={() => act('export:gallery', file)}>Guardar en Fotos</Button>
          <Button size="lg" icon="share" onClick={() => act('export:share', file)}>Compartir</Button>
        </> : failed ? <Button size="lg" onClick={() => { jobRef.current = null; setJob(null); setProg(null) }}>Volver a las opciones</Button>
          : <Button variant="danger" size="lg" icon="stop" onClick={cancel}>Cancelar</Button>}>
        <div className="xp2">
          <div className="xp2-preview" style={{ aspectRatio: `${w} / ${h}` }}>{prog.preview ? <img src={prog.preview} alt="" /> : <Icon name="film" size={34} className="t4" />}</div>
          {done ? <>
            <div className="xp2-big"><Icon name="check-circle" size={26} />{fmtSize(prog.size || 0)}</div>
            <div className="t2">{fmtTime(dur)} · {w}×{h} · {fps} fps · en {secs(prog.elapsed)}</div>
            {prog.encoder && <div className="t3 xp2-small">{prog.encoder}{prog.fps ? ` · ${prog.fps.toFixed(1).replace('.', ',')} fps` : ''}</div>}
          </> : <>
            <div className="xp2-big tabnum">{Math.floor(pct)} %</div>
            <div className="t2">{failed ? prog.message : `${PHASE[prog.phase] || prog.phase}${prog.phase === 'render' ? ` · ${prog.message}` : ''}`}</div>
            <Progress value={pct} indeterminate={['preparando', 'audio', 'final'].includes(prog.phase) || (prog.phase === 'render' && !prog.done)} tone={failed ? 'err' : undefined} />
            {!failed && <div className="xp2-meta">
              <span><small>Velocidad</small><b className="tabnum">{prog.fps ? `${prog.fps.toFixed(1)} fps` : '—'}</b></span>
              <span><small>Falta</small><b className="tabnum">{prog.phase === 'render' ? secs(prog.eta) : '—'}</b></span>
              <span><small>Tamaño</small><b className="tabnum">~{fmtSize(estimate)}</b></span>
            </div>}
            {running && <div className="t3 xp2-small">No salgas de la app ni bloquees el teléfono mientras exporta: iOS la pausa.</div>}
          </>}
          {prog.details && (done || failed) && <details className="xp-details"><summary>Detalles</summary><pre>{prog.details}</pre>
            <Button size="sm" icon="copy" onClick={() => call('clipboard:text', prog.details).then(() => toast('Detalles copiados'))}>Copiar</Button></details>}
        </div>
        {dlg.element}
      </Sheet>
    )
  }

  const resOptions = [720, 1080, 1440, 2160].filter((x) => x <= Math.max(1080, short)).map((x) => ({ value: x, label: `${x}p`, sub: `${sizeFor(x).w}×${sizeFor(x).h}` }))
  return (
    <Sheet title="Exportar video" onClose={onClose} tall
      footer={<Button variant="primary" size="lg" icon="export" onClick={start} disabled={!tl || dur < 1 / fps}>Exportar · ~{fmtSize(estimate)}</Button>}>
      <label className="ph-label">Nombre</label>
      <TextInput value={name} onChange={setName} suffix={<span className="t3">.mp4</span>} />
      <label className="ph-label">Resolución</label>
      <Chips value={res} onChange={setRes} options={resOptions} />
      <label className="ph-label">Cuadros por segundo</label>
      <Chips value={fps} onChange={setFps} options={[...new Set([24, 30, 60, project.fps])].sort((a, b) => a - b).map((f) => ({ value: f, label: String(f) }))} />
      <label className="ph-label">Calidad</label>
      <Chips value={quality} onChange={setQuality} options={[{ value: 'medium' as Quality, label: 'Liviana' }, { value: 'high' as Quality, label: 'Alta' }, { value: 'max' as Quality, label: 'Máxima' }]} />
      <label className="ph-label">Códec</label>
      <Chips value={codec} onChange={setCodec} options={[{ value: 'avc' as Codec, label: 'H.264', sub: 'se ve en todos lados' }, ...(hevcOk ? [{ value: 'hevc' as Codec, label: 'HEVC', sub: 'la mitad de tamaño' }] : [])]} />
      <Group>
        <Row label="Audio" detail={audio ? 'Voz, música y efectos (AAC)' : 'Sin audio'}><Switch checked={audio} onChange={setAudio} /></Row>
        <Row label="Duración" detail={tl ? fmtTime(dur, true, project.fps) : '…'} />
      </Group>
    </Sheet>
  )
}
