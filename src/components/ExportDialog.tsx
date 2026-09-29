import { useEffect, useMemo, useState } from 'react'
import { call, ExportProgress, ExportSettings, fmtTime, on, Project } from '../api'
import { useApp } from '../App'
import Modal from './Modal'
import { useDialogs } from './Dialogs'
import { Icon, IconName } from '../ui/icons'
import { Badge, Button, Check, Field, NumberInput, Progress, Segmented, Select, Slider, Switch, Tabs, TextInput } from '../ui/kit'

type Preset = { id: string; name: string; sub: string; icon: IconName; s: Partial<ExportSettings>; h?: number }
const PRESETS: Preset[] = [
  { id: 'yt1080', name: 'YouTube 1080p', sub: 'H.264 · CQ 19', icon: 'monitor', h: 1080, s: { vcodec: 'h264_nvenc', preset: 'p6', tune: 'hq', rc: 'cq', cq: 19, pixfmt: 'yuv420p', container: 'mp4', acodec: 'aac', abitrate: 256, arate: 48000 } },
  { id: 'yt4k', name: 'YouTube 4K', sub: 'HEVC 10 bits', icon: 'star', h: 2160, s: { vcodec: 'hevc_nvenc', preset: 'p6', tune: 'uhq', rc: 'cq', cq: 22, pixfmt: 'p010le', container: 'mp4', acodec: 'aac', abitrate: 320 } },
  { id: 'av1', name: 'Liviano', sub: 'AV1 10 bits', icon: 'zap', h: 1080, s: { vcodec: 'av1_nvenc', preset: 'p7', tune: 'uhq', rc: 'cq', cq: 30, pixfmt: 'p010le', container: 'mp4', acodec: 'aac', abitrate: 160 } },
  { id: 'web', name: 'Web 720p', sub: 'H.264 · 2,5 Mbps', icon: 'external', h: 720, s: { vcodec: 'h264_nvenc', preset: 'p6', tune: 'hq', rc: 'vbr', bitrate: 2500, maxrate: 4000, pixfmt: 'yuv420p', container: 'mp4', acodec: 'aac', abitrate: 128 } },
  { id: 'edit', name: 'Para editar', sub: '4:2:2 10 bits · MOV', icon: 'scissors', s: { vcodec: 'h264_nvenc', preset: 'p4', tune: 'hq', rc: 'cqp', qp: 16, pixfmt: 'p210le', gopSec: 0.5, bframes: 0, container: 'mov', acodec: 'pcm_s24le' } },
  { id: 'master', name: 'Master', sub: 'Sin pérdida · 4:4:4', icon: 'shield', s: { vcodec: 'hevc_nvenc', preset: 'p7', tune: 'lossless', rc: 'lossless', pixfmt: 'yuv444p', container: 'mkv', acodec: 'flac' } },
  { id: 'cpu', name: 'Sin GPU', sub: 'x264 · CPU', icon: 'cpu', s: { vcodec: 'libx264', rc: 'cq', cq: 20, pixfmt: 'yuv420p', container: 'mp4', acodec: 'aac', abitrate: 192 } },
  { id: 'custom', name: 'Personalizado', sub: 'Tus ajustes', icon: 'sliders', s: {} },
]
const ACODECS: Array<[ExportSettings['acodec'], string]> = [['aac', 'AAC'], ['libopus', 'Opus'], ['libmp3lame', 'MP3'], ['ac3', 'AC3'], ['flac', 'FLAC (sin pérdida)'], ['pcm_s16le', 'PCM 16 bits'], ['pcm_s24le', 'PCM 24 bits'], ['none', 'Sin audio']]
const PHASE: Record<string, string> = { preparando: 'Preparando', render: 'Renderizando', audio: 'Mezclando audio', final: 'Escribiendo archivo', listo: 'Listo', error: 'Error', cancelado: 'Cancelado' }

export default function ExportDialog({ project, currentTl, range, onClose }: { project: Project; currentTl: string; range: { start: number; end: number } | null; onClose: () => void }) {
  const { toast, info } = useApp()
  const dlg = useDialogs()
  const [s, setS] = useState<ExportSettings | null>(null)
  const [preset, setPreset] = useState('custom')
  const [tab, setTab] = useState<'general' | 'video' | 'audio'>('general')
  const [sel, setSel] = useState<string[]>([currentTl])
  const [join, setJoin] = useState(true)
  const [chapters, setChapters] = useState(true)
  const [useRange, setUseRange] = useState(false)
  const [r, setR] = useState(range || { start: 0, end: 10 })
  const [output, setOutput] = useState('')
  const [outTouched, setOutTouched] = useState(false)
  const [job, setJob] = useState<string | null>(null)
  const [prog, setProg] = useState<ExportProgress | null>(null)
  const [rp, setRp] = useState<ExportProgress | null>(null) // último progreso de render (para las cifras finales)
  const aspect = project.width / project.height

  useEffect(() => { call<ExportSettings>('export:defaults').then((d) => setS({ ...d, width: project.width, height: project.height, fps: project.fps })) }, [])
  useEffect(() => on('export:progress', (p: ExportProgress) => { if (p.id !== job) return; setProg(p); if (p.phase === 'render') setRp(p) }), [job])

  const set = (patch: Partial<ExportSettings>) => { setS((x) => ({ ...x!, ...patch })); setPreset('custom') }
  const resFor = (h: number) => (aspect >= 1 ? { width: Math.round((h * aspect) / 2) * 2, height: h } : { width: h, height: Math.round(h / aspect / 2) * 2 })
  const resOptions = useMemo(() => [720, 1080, 1440, 2160].map((h) => ({ h, ...resFor(h) })), [aspect])
  const multi = sel.length > 1
  const separate = multi && !join
  const outName = multi && join ? project.name : sel.length === 1 ? `${project.name}${project.timelines.length > 1 ? ' - ' + project.timelines.find((t) => t.id === sel[0])?.name : ''}` : project.name

  // Destino por defecto (carpeta de exportación + nombre); se actualiza si el usuario no lo cambió a mano.
  useEffect(() => { if (s && !outTouched) call('export:defaultOutput', outName, s.container, separate).then(setOutput) }, [s?.container, outName, separate, outTouched])

  if (!s) return null
  const applyPreset = (p: Preset) => { setS((x) => ({ ...x!, ...p.s, ...(p.h ? resFor(p.h) : {}) })); setPreset(p.id) }
  const pick = async () => {
    const out = await call('export:pickOutput', outName, s.container, separate)
    if (out) { setOutput(out); setOutTouched(true) }
  }
  const start = async () => {
    if (!output) { toast('Elegí dónde guardar', true); return }
    try {
      if (!separate && await call<boolean>('export:exists', output) && !(await dlg.confirm({ title: 'El archivo ya existe', message: <>¿Reemplazar <b>{output.split(/[\\/]/).pop()}</b>?</>, ok: 'Reemplazar', danger: true }))) return
      const id = await call('export:start', { projectId: project.id, timelines: sel, join: !separate, chapters, range: !multi && useRange ? r : null, settings: s, output })
      setJob(id); setRp(null); setProg({ id, phase: 'preparando', message: 'Preparando…', done: 0, total: 1 })
    } catch (e: any) { toast(e.message, true) }
  }
  const nv = (c: string) => !info || info.encoders[c]
  const gpu = s.vcodec.endsWith('_nvenc')

  // ── progreso ──
  if (job && prog) {
    const done = prog.phase === 'listo', failed = prog.phase === 'error' || prog.phase === 'cancelado'
    const pct = done ? 100 : prog.phase === 'render' && prog.total ? (prog.done / prog.total) * 100 : prog.phase === 'audio' || prog.phase === 'final' ? 100 : 0
    const file = (prog.file || output).split('\n')[0]
    return (
      <Modal icon={done ? 'check-circle' : failed ? 'x-circle' : 'export'} title={done ? 'Exportación terminada' : failed ? PHASE[prog.phase] : 'Exportando'} subtitle={output.split(/[\\/]/).pop()}
        onClose={async () => { if (done || failed || await dlg.confirm({ title: '¿Cerrar esta ventana?', message: 'La exportación sigue en segundo plano y te avisamos al terminar.', ok: 'Cerrar' })) onClose() }}
        footer={done ? <><Button icon="folder-open" onClick={() => call('shell:showItem', file)}>Mostrar en carpeta</Button><div className="grow" /><Button onClick={onClose}>Cerrar</Button><Button variant="primary" icon="play" onClick={() => call('shell:openPath', file)}>Abrir video</Button></>
          : failed ? <><div className="grow" /><Button onClick={() => { setJob(null); setProg(null) }}>Volver a los ajustes</Button><Button onClick={onClose}>Cerrar</Button></>
            : <><span className="t3" style={{ fontSize: 12 }}>Podés seguir trabajando; se exporta en segundo plano.</span><div className="grow" /><Button variant="danger" icon="stop" onClick={() => call('export:cancel', job)}>Cancelar</Button></>}>
        {dlg.element}
        <div className="col" style={{ gap: 16 }}>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div className="grow"><div className="t2" style={{ marginBottom: 4 }}>{PHASE[prog.phase] || prog.phase}</div><div className="t3" style={{ fontSize: 12 }}>{prog.message}</div></div>
            <div className="big-pct tabnum">{pct.toFixed(prog.phase === 'render' ? 1 : 0)}%</div>
          </div>
          <Progress value={pct} indeterminate={prog.phase === 'preparando' || prog.phase === 'audio' || prog.phase === 'final'} tone={done ? 'ok' : prog.phase === 'error' ? 'err' : undefined} />
          {rp && <div className="x-stats">
            <div className="x-stat"><div className="v tabnum">{rp.done.toLocaleString()}</div><div className="l">de {rp.total.toLocaleString()} fotogramas</div></div>
            <div className="x-stat"><div className="v tabnum">{rp.fps ? rp.fps.toFixed(0) : '–'}</div><div className="l">fps de render</div></div>
            <div className="x-stat"><div className="v tabnum">{fmtTime(rp.elapsed || 0)}</div><div className="l">render</div></div>
            <div className="x-stat"><div className="v tabnum">{done || prog.phase !== 'render' ? '0:00' : rp.eta != null ? fmtTime(rp.eta) : '–'}</div><div className="l">restante</div></div>
          </div>}
          {prog.phase === 'error' && <div className="notice error"><Icon name="x-circle" size={14} />{prog.message}</div>}
          {!done && <div className="t3 row" style={{ fontSize: 12, alignItems: 'flex-start' }}><Icon name="info" size={13} style={{ marginTop: 2 }} />Los segmentos terminados se guardan: si cancelás o se corta la luz, al volver a exportar con los mismos ajustes se retoma donde quedó.</div>}
        </div>
      </Modal>
    )
  }

  return (
    <Modal size="wide" icon="export" title="Exportar video" subtitle={`${project.name} · ${s.width}×${s.height} · ${s.fps} fps${gpu && info?.gpu ? ` · ${info.gpu}` : ''}`} onClose={onClose}
      footer={<>
        {gpu ? <Badge tone="ok" icon="zap">Codificación por GPU</Badge> : <Badge tone="warn" icon="cpu">Codificación por CPU</Badge>}
        <div className="grow" /><Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" icon="export" onClick={start} disabled={!sel.length || !output}>Exportar{multi ? ` ${sel.length} timelines` : ''}</Button>
      </>}>
      {dlg.element}
      <div className="preset-grid">
        {PRESETS.map((p) => (
          <button key={p.id} className={`preset ${preset === p.id ? 'on' : ''}`} onClick={() => p.id === 'custom' ? setPreset('custom') : applyPreset(p)} disabled={p.s.vcodec ? !nv(p.s.vcodec) : false}>
            <span className="preset-name"><Icon name={p.icon} size={14} />{p.name}</span><span className="preset-sub">{p.sub}</span>
          </button>
        ))}
      </div>
      <div style={{ borderBottom: '1px solid var(--line)', marginBottom: 16 }}>
        <Tabs value={tab} onChange={setTab} tabs={[{ value: 'general', label: 'General', icon: 'sliders' }, { value: 'video', label: 'Video avanzado', icon: 'film' }, { value: 'audio', label: 'Audio', icon: 'music' }]} />
      </div>

      {tab === 'general' && <>
        <div className="fields three">
          <Field label="Resolución" hint="Se renderiza nativo: lo vectorial queda nítido.">
            <Select value={`${s.width}x${s.height}`} onChange={(v) => { const [w, h] = String(v).split('x').map(Number); set({ width: w, height: h }) }}
              options={[...(!resOptions.some((o) => o.width === s.width && o.height === s.height) ? [{ value: `${s.width}x${s.height}`, label: `${s.width}×${s.height}`, hint: 'proyecto' }] : []),
                ...resOptions.map((o) => ({ value: `${o.width}x${o.height}`, label: `${o.width}×${o.height}`, hint: o.h === 2160 ? '4K' : o.h === 1440 ? '2K' : o.h === 1080 ? 'Full HD' : 'HD' }))]} />
          </Field>
          <Field label="Cuadros por segundo">
            <Select value={s.fps} onChange={(v) => set({ fps: +v })} options={[23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120].map((f) => ({ value: f, label: `${f} fps`, hint: f === project.fps ? 'proyecto' : undefined }))} />
          </Field>
          <Field label="Contenedor">
            <Select value={s.container} onChange={(v) => set({ container: v as any })} options={[{ value: 'mp4', label: 'MP4', hint: 'recomendado' }, { value: 'mkv', label: 'MKV' }, { value: 'mov', label: 'MOV' }, { value: 'webm', label: 'WEBM', hint: 'AV1 + Opus' }]} />
          </Field>
          <Field label="Códec">
            <Select value={s.vcodec} onChange={(v) => set({ vcodec: v as any })} options={[
              { header: 'GPU (NVENC)' },
              { value: 'h264_nvenc', label: 'H.264', hint: 'compatible', disabled: !nv('h264_nvenc'), icon: 'zap' },
              { value: 'hevc_nvenc', label: 'HEVC / H.265', hint: 'eficiente', disabled: !nv('hevc_nvenc'), icon: 'zap' },
              { value: 'av1_nvenc', label: 'AV1', hint: 'el más liviano', disabled: !nv('av1_nvenc'), icon: 'zap' },
              { header: 'CPU' },
              { value: 'libx264', label: 'H.264 · x264', icon: 'cpu' }, { value: 'libx265', label: 'HEVC · x265', icon: 'cpu' }]} />
          </Field>
          <Field label="Control de calidad">
            <Select value={s.rc} onChange={(v) => set({ rc: v as any })} options={[
              { value: 'cq', label: 'Calidad constante', hint: 'CQ' }, { value: 'vbr', label: 'Bitrate variable', hint: 'VBR' }, { value: 'cbr', label: 'Bitrate constante', hint: 'CBR' },
              { value: 'cqp', label: 'QP constante' }, { value: 'size', label: 'Tamaño objetivo' }, { value: 'lossless', label: 'Sin pérdida' }]} />
          </Field>
          <Field label={s.rc === 'cq' ? `Calidad · CQ ${s.cq}` : s.rc === 'cqp' ? `QP ${s.qp}` : s.rc === 'size' ? 'Tamaño objetivo' : s.rc === 'lossless' ? 'Calidad' : 'Bitrate'}
            hint={s.rc === 'cq' ? 'Menor = mejor calidad y archivo más grande.' : s.rc === 'lossless' ? 'Máxima calidad; archivos enormes.' : undefined}>
            {s.rc === 'cq' && <Slider value={s.cq} min={10} max={40} onChange={(v) => set({ cq: v })} />}
            {s.rc === 'cqp' && <Slider value={s.qp} min={0} max={40} onChange={(v) => set({ qp: v })} />}
            {(s.rc === 'vbr' || s.rc === 'cbr') && <NumberInput value={s.bitrate} step={500} min={100} suffix="kbps" onChange={(v) => set({ bitrate: v })} />}
            {s.rc === 'size' && <NumberInput value={s.targetMB} step={50} min={1} suffix="MB" onChange={(v) => set({ targetMB: v })} />}
            {s.rc === 'lossless' && <Badge tone="accent" icon="shield">Sin pérdida</Badge>}
          </Field>
        </div>

        <div className="x-section caps">Qué exportar</div>
        <div className="tl-pick">
          {project.timelines.map((tl) => (
            <div key={tl.id} className="tl-pick-row">
              <Check checked={sel.includes(tl.id)} onChange={(c) => setSel(c ? project.timelines.filter((x) => x.id === tl.id || sel.includes(x.id)).map((x) => x.id) : sel.filter((x) => x !== tl.id))}>{tl.name}</Check>
              {tl.id === currentTl && <Badge tone="accent">actual</Badge>}
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: 10, gap: 18, flexWrap: 'wrap' }}>
          {project.timelines.length > 1 && <Button size="sm" variant="subtle" onClick={() => setSel(sel.length === project.timelines.length ? [currentTl] : project.timelines.map((t) => t.id))}>{sel.length === project.timelines.length ? 'Sólo el actual' : `Todos (${project.timelines.length})`}</Button>}
          {multi && <Check checked={join} onChange={setJoin}>Unir en un solo video</Check>}
          {multi && join && <Check checked={chapters} onChange={setChapters}>Capítulos con el nombre de cada timeline</Check>}
          {!multi && <Check checked={useRange} onChange={setUseRange}>Sólo un tramo</Check>}
          {!multi && useRange && <div className="row"><NumberInput size="sm" width={100} value={r.start} step={0.1} min={0} suffix="s" onChange={(v) => setR({ ...r, start: v })} /><span className="t3">a</span><NumberInput size="sm" width={100} value={r.end} step={0.1} min={0} suffix="s" onChange={(v) => setR({ ...r, end: v })} /></div>}
        </div>

        <div className="x-section caps">Destino</div>
        <div className="row">
          <div className="grow"><TextInput mono icon={separate ? 'folder' : 'file'} value={output} readOnly placeholder={separate ? 'Carpeta para los videos' : 'Archivo de salida'} /></div>
          <Button icon="folder-open" onClick={pick}>Cambiar…</Button>
        </div>
        <div className="fields three" style={{ marginTop: 14 }}>
          <Field label="Título (metadatos)"><TextInput value={s.title} placeholder={project.name} onChange={(v) => set({ title: v })} /></Field>
          <Field label="Workers en paralelo" hint="Ventanas de captura simultáneas."><Segmented full value={s.workers} onChange={(v) => set({ workers: v })} options={[1, 2, 4, 6, 8].map((n) => ({ value: n, label: String(n) }))} /></Field>
          <Field label="Optimizar para web" hint="Reproducción inmediata al subir (faststart)."><div style={{ paddingTop: 5 }}><Switch checked={s.faststart} onChange={(v) => set({ faststart: v })} /></div></Field>
        </div>
      </>}

      {tab === 'video' && <div className="fields three">
        <Field label="Preset NVENC" hint="p1 más rápido · p7 mejor calidad."><Select value={s.preset} onChange={(v) => set({ preset: v as string })} options={['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'].map((p) => ({ value: p, label: p.toUpperCase(), hint: p === 'p1' ? 'más rápido' : p === 'p7' ? 'mejor' : p === 'p5' ? 'equilibrado' : undefined }))} /></Field>
        <Field label="Ajuste (tune)"><Select value={s.tune} onChange={(v) => set({ tune: v as any })} options={[{ value: 'hq', label: 'Alta calidad' }, { value: 'uhq', label: 'Ultra calidad', hint: 'HEVC/AV1' }, { value: 'll', label: 'Baja latencia' }, { value: 'ull', label: 'Ultra baja latencia' }, { value: 'lossless', label: 'Sin pérdida' }]} /></Field>
        <Field label="Formato de color"><Select value={s.pixfmt} onChange={(v) => set({ pixfmt: v as any })} options={[{ value: 'yuv420p', label: '8 bits 4:2:0', hint: 'compatible' }, { value: 'p010le', label: '10 bits 4:2:0', hint: 'sin banding' }, { value: 'yuv422p', label: '8 bits 4:2:2', hint: 'RTX 50' }, { value: 'p210le', label: '10 bits 4:2:2', hint: 'RTX 50' }, { value: 'yuv444p', label: '8 bits 4:4:4' }]} /></Field>
        <Field label="Multipasada"><Select value={s.multipass} onChange={(v) => set({ multipass: v as any })} options={[{ value: 'disabled', label: 'Desactivada' }, { value: 'qres', label: '2 pasadas', hint: '¼ resolución' }, { value: 'fullres', label: '2 pasadas', hint: 'completa' }]} /></Field>
        <Field label="Bitrate máximo" hint="0 = sin límite."><NumberInput value={s.maxrate} step={500} min={0} suffix="kbps" onChange={(v) => set({ maxrate: v })} /></Field>
        <Field label="B-frames"><Segmented full value={s.bframes} onChange={(v) => set({ bframes: v })} options={[0, 1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }))} /></Field>
        <Field label="Keyframe cada"><NumberInput value={s.gopSec} step={0.5} min={0.1} suffix="s" onChange={(v) => set({ gopSec: v })} /></Field>
        <Field label="Lookahead"><NumberInput value={s.lookahead} step={4} min={0} suffix="cuadros" onChange={(v) => set({ lookahead: v })} /></Field>
        <Field label={`Fuerza AQ · ${s.aqStrength}`}><Slider value={s.aqStrength} min={1} max={15} onChange={(v) => set({ aqStrength: v })} /></Field>
        <Field label="Espacio de color"><Select value={s.color} onChange={(v) => set({ color: v as any })} options={[{ value: 'bt709', label: 'BT.709', hint: 'HD' }, { value: 'bt601', label: 'BT.601', hint: 'SD' }, { value: 'none', label: 'Sin etiquetar' }]} /></Field>
        <Field label="Rango"><Segmented full value={s.range} onChange={(v) => set({ range: v })} options={[{ value: 'tv', label: 'Limitado' }, { value: 'pc', label: 'Completo' }]} /></Field>
        <Field label="Segmentos" hint="Unidad de reanudación."><NumberInput value={s.segmentSec} step={10} min={5} suffix="s" onChange={(v) => set({ segmentSec: v })} /></Field>
        <Field label="Cuantización adaptativa"><div className="row" style={{ gap: 16, paddingTop: 6 }}><Check checked={s.spatialAQ} onChange={(v) => set({ spatialAQ: v })}>Espacial</Check><Check checked={s.temporalAQ} onChange={(v) => set({ temporalAQ: v })}>Temporal</Check></div></Field>
        <Field label="Caché"><Button icon="trash" onClick={() => call('export:clearCache', project.id).then(() => toast('Caché de exportación borrada'))}>Borrar segmentos</Button></Field>
      </div>}

      {tab === 'audio' && <div className="fields three">
        <Field label="Códec de audio"><Select value={s.acodec} onChange={(v) => set({ acodec: v as any })} options={ACODECS.map(([v, l]) => ({ value: v, label: l }))} /></Field>
        <Field label="Bitrate"><Select value={s.abitrate} onChange={(v) => set({ abitrate: +v })} options={[96, 128, 160, 192, 256, 320, 384, 448].map((n) => ({ value: n, label: `${n} kbps` }))} /></Field>
        <Field label="Frecuencia"><Segmented full value={s.arate} onChange={(v) => set({ arate: v })} options={[{ value: 44100, label: '44,1 kHz' }, { value: 48000, label: '48 kHz' }, { value: 96000, label: '96 kHz' }]} /></Field>
        <Field label="Canales"><Segmented full value={s.achannels} onChange={(v) => set({ achannels: v })} options={[{ value: 1, label: 'Mono' }, { value: 2, label: 'Estéreo' }, { value: 6, label: '5.1' }]} /></Field>
        <Field label="Ganancia"><NumberInput value={s.volumeDb} step={0.5} suffix="dB" onChange={(v) => set({ volumeDb: v })} /></Field>
        <Field label="Normalización de sonoridad" hint="YouTube −14 LUFS · TV −23 LUFS.">
          <div className="row"><Switch checked={s.loudnorm} onChange={(v) => set({ loudnorm: v })} /><NumberInput width={110} value={s.lufs} step={1} suffix="LUFS" onChange={(v) => set({ lufs: v })} /></div>
        </Field>
      </div>}
    </Modal>
  )
}
