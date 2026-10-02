import { DragEvent as RDragEvent, ReactNode, useEffect, useRef, useState } from 'react'
import { call, EFFORTS, fmtTime, MODELS, on, PluginStatus, Timeline } from '../api'
import { useApp } from '../App'
import Modal from './Modal'
import { useDialogs } from './Dialogs'
import Stage from './Stage'
import { Icon, IconName } from '../ui/icons'
import { Badge, Button, Progress, Segmented, Select, Spinner, Switch, Tabs, TextArea, TextInput } from '../ui/kit'

type PhaseState = { id: string; label: string; status?: 'run' | 'ok' | 'skip' | 'error'; message?: string; progress?: number }
type Result = {
  id: string; workspace: string; title: string; source: string; isUrl: boolean; analysis: any; sheet: string; preview?: string; sceneOk: boolean
  stats: { duration: number; analyzed: number; width: number; height: number; fps: number; shots: number; avgShot: number; cutsPerMin: number; motion: number; speechRatio: number | null; pauses: number; lufs: number | null; wpm: number | null; palette: Array<{ hex: string; share: number }>; transcript: string }
}
const ASPECTS = ['Colores', 'Tipografía', 'Animaciones', 'Transiciones', 'Formas', 'Objetos', 'Composición', 'Ritmo y cortes', 'Narración', 'Sonido']
const isUrl = (s: string) => /^https?:\/\//i.test(s.trim())

/** Herramienta de plantillas: analiza un video (archivo o YouTube) y crea una plantilla que replica su estilo. */
export default function Analyzer({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const { settings, toast } = useApp()
  const [mode, setMode] = useState<'url' | 'file'>('url')
  const [url, setUrl] = useState('')
  const [file, setFile] = useState('')
  const [maxMin, setMaxMin] = useState(20)
  const [transcribe, setTranscribe] = useState(true)
  const [model, setModel] = useState(settings?.claude.model || '')
  const [effort, setEffort] = useState<string>(settings?.claude.effort || 'high')
  const [notes, setNotes] = useState('')
  const [plugins, setPlugins] = useState<PluginStatus[] | null>(null)
  const [installing, setInstalling] = useState<number | null>(null)
  const [job, setJob] = useState<string | null>(null)
  const [phases, setPhases] = useState<PhaseState[]>([])
  const [log, setLog] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [started, setStarted] = useState(0)
  const [, tick] = useState(0)
  const [drag, setDrag] = useState(false)
  const jobRef = useRef<string | null>(null)
  const dlg = useDialogs()
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => { call<PluginStatus[]>('plugins:status').then(setPlugins) }, [])
  useEffect(() => on('plugins:progress', (e) => { if (e.id === 'ytdlp') setInstalling(e.p) }), [])
  const early = useRef<any[]>([])
  const apply = (e: any) => {
    if (e.log) setLog((l) => [...l.slice(-300), e.log])
    if (e.phase && e.status) setPhases((ps) => ps.map((p) => (p.id === e.phase ? { ...p, status: e.status, message: e.message ?? p.message, progress: e.progress } : p)))
    else if (e.phase && e.message) setPhases((ps) => ps.map((p) => (p.id === e.phase ? { ...p, message: e.message, progress: e.progress } : p)))
    if (e.done) { if (e.error) setError(e.error); if (e.result) setResult(e.result) }
  }
  // Los primeros eventos pueden llegar antes de que 'analyze:start' devuelva el id: se guardan y se aplican después.
  useEffect(() => on('analyze:event', (e: any) => { if (e.id === jobRef.current) apply(e); else if (!jobRef.current) early.current.push(e) }), [])
  useEffect(() => { if (!job || result || error) return; const i = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(i) }, [job, result, error])
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight }, [log])

  const yt = plugins?.find((p) => p.id === 'ytdlp')
  const stt = plugins?.filter((p) => (p.id === 'whisper' || p.id === 'elevenlabs' || p.id === 'openai' || p.id === 'fish') && p.ready) || []
  const source = mode === 'url' ? url.trim() : file
  const canStart = mode === 'url' ? isUrl(url) && !!yt?.ready : !!file

  const start = async () => {
    if (!canStart) return
    const ph = await call<Array<{ id: string; label: string }>>('analyze:phases')
    setPhases(ph.map((p) => ({ ...p })))
    setLog([]); setError(null); setResult(null); setStarted(Date.now()); early.current = []
    const id = await call<string>('analyze:start', { source, transcribe, model, effort, maxMinutes: maxMin, notes: notes.trim() || undefined })
    jobRef.current = id; setJob(id)
    early.current.filter((e) => e.id === id).forEach(apply); early.current = []
  }
  const close = async () => {
    if (job && !result && !error) {
      if (!(await dlg.confirm({ title: '¿Cancelar el análisis?', message: 'Se pierde el trabajo hecho hasta ahora.', ok: 'Cancelar análisis', cancel: 'Seguir analizando', danger: true }))) return
      await call('analyze:cancel', job)
    } else if (result && !(await dlg.confirm({ title: '¿Descartar el análisis?', message: 'Si no lo guardás como plantilla, se pierde.', ok: 'Descartar', cancel: 'Volver', danger: true }))) return
    if (job) await call('analyze:discard', job)
    onClose()
  }
  const reset = async () => { if (job) await call('analyze:discard', job); jobRef.current = null; setJob(null); setResult(null); setError(null); setPhases([]) }
  const install = async () => {
    setInstalling(0)
    try { await call('plugins:installYtdlp'); setPlugins(await call('plugins:status', true)); toast('yt-dlp instalado') } catch (e: any) { toast(e.message, true) } finally { setInstalling(null) }
  }
  const pick = async () => { const f = await call<string | null>('analyze:pickFile'); if (f) { setFile(f); setMode('file') } }
  const onDrop = (e: RDragEvent) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) { setFile(window.oa.pathForFile(f)); setMode('file') } }

  const running = !!job && !result && !error
  const title = result ? 'Análisis listo' : running ? 'Analizando el video…' : error ? 'El análisis no terminó' : 'Crear plantilla desde un video'
  const sub = result ? result.title : running ? (isUrl(source) ? source : source.split(/[\\/]/).pop()) : 'Claude analiza colores, animaciones, formas, objetos, ritmo y narración, y arma una plantilla que replica el estilo.'

  return (
    <Modal size="xl" icon="wand" title={title} subtitle={sub} onClose={close} persistent={!!job}
      footer={result ? <SaveBar result={result} onSaved={(id) => { onSaved(id) }} onDiscard={close} />
        : running ? <><span className="row t3" style={{ gap: 8, fontSize: 12 }}><Spinner size={12} />{fmtTime((Date.now() - started) / 1000)} · podés seguir usando la app, esto puede tardar varios minutos</span><div className="grow" /><Button variant="danger" icon="stop" onClick={close}>Cancelar</Button></>
          : error ? <><div className="grow" /><Button onClick={close}>Cerrar</Button><Button variant="primary" icon="refresh" onClick={reset}>Volver a intentar</Button></>
            : <><span className="t3" style={{ fontSize: 12 }}>Usa Claude Code{transcribe && stt.length ? ` y ${stt[0].name} (transcripción)` : ''} con tu cuenta.</span><div className="grow" /><Button onClick={close}>Cancelar</Button><Button variant="primary" icon="sparkles" onClick={start} disabled={!canStart}>Analizar video</Button></>}>

      {!job && (
        <div className="an-input">
          <div className="an-src">
            <Segmented value={mode} onChange={setMode} options={[{ value: 'url', label: 'Enlace de YouTube', icon: 'youtube' }, { value: 'file', label: 'Archivo de video', icon: 'video' }]} />
            {mode === 'url' ? <>
              <div className="an-url"><TextInput autoFocus icon="link" value={url} onChange={setUrl} onEnter={start} placeholder="https://www.youtube.com/watch?v=…" clearable /></div>
              {yt && !yt.ready && (
                <div className="an-note"><Icon name="download" size={16} /><div className="grow">Para descargar videos de YouTube hace falta <b>yt-dlp</b> (libre y oficial, ≈18 MB). Se instala dentro de la carpeta de OpenAnimator.</div>
                  {installing != null ? <div style={{ width: 140 }}><Progress value={installing} /></div> : <Button variant="primary" size="sm" icon="download" onClick={install}>Instalar yt-dlp</Button>}</div>
              )}
              <div className="t3" style={{ fontSize: 12 }}>También sirven enlaces de Vimeo, X, Instagram y otros sitios que soporte yt-dlp. Se descarga en 720p sólo para analizar; no se guarda en la plantilla.</div>
            </> : (
              <div className={`an-drop ${drag ? 'drag' : ''} ${file ? 'has' : ''}`} onClick={pick} onDragOver={(e) => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
                <Icon name={file ? 'video' : 'upload'} size={28} stroke={1.4} />
                {file ? <><b className="ellipsis" style={{ maxWidth: '90%' }}>{file.split(/[\\/]/).pop()}</b><span className="mono ellipsis t3" style={{ maxWidth: '90%', fontSize: 11 }}>{file}</span><Button size="sm" variant="ghost" icon="refresh" onClick={(e) => { e.stopPropagation(); pick() }}>Cambiar</Button></>
                  : <><b>Arrastrá un video acá</b><span className="t3">o hacé clic para elegirlo · MP4, MOV, WebM, MKV</span></>}
              </div>
            )}
          </div>

          <div className="an-cols">
            <div>
              <div className="field-label" style={{ marginBottom: 8 }}>Qué se analiza</div>
              <div className="an-aspects">{ASPECTS.map((a) => <span key={a}><Icon name="check" size={12} />{a}</span>)}</div>
              <div className="field-label" style={{ margin: '18px 0 8px' }}>Indicaciones para Claude <span className="t4">(opcional)</span></div>
              <TextArea rows={3} value={notes} onChange={setNotes} placeholder="Ej.: fijate especialmente en cómo entran los textos y en las transiciones entre secciones." />
            </div>
            <div className="set-card an-opts">
              <div className="set-row"><div className="set-text"><div className="set-label">Transcribir la narración</div><div className="set-desc">{stt.length ? `Con ${stt[0].name} si el video no trae subtítulos${stt[0].id === 'whisper' ? ' (en tu equipo, gratis)' : ' (usa créditos)'}.` : 'Configurá Whisper local, ElevenLabs, OpenAI o Fish Audio en Plugins para analizar la voz. Los videos de YouTube con subtítulos no lo necesitan.'}</div></div><div className="set-ctrl"><Switch checked={transcribe && stt.length > 0} disabled={!stt.length} onChange={setTranscribe} /></div></div>
              <div className="set-row"><div className="set-text"><div className="set-label">Analizar hasta</div><div className="set-desc">En videos largos, sólo el comienzo.</div></div><div className="set-ctrl"><Select value={maxMin} width={130} onChange={setMaxMin} options={[3, 5, 10, 20, 40].map((m) => ({ value: m, label: `${m} min` }))} /></div></div>
              <div className="set-row"><div className="set-text"><div className="set-label">Modelo</div></div><div className="set-ctrl"><Select value={model} width={170} menuWidth={300} onChange={setModel} options={MODELS.map((m) => ({ value: m.id, label: m.name, desc: m.desc, hint: m.note }))} /></div></div>
              <div className="set-row"><div className="set-text"><div className="set-label">Esfuerzo</div><div className="set-desc">Más esfuerzo = análisis y muestra más finos.</div></div><div className="set-ctrl"><Select value={effort} width={170} menuWidth={280} onChange={setEffort} options={EFFORTS.map((e) => ({ value: e.id, label: e.name, desc: e.desc }))} /></div></div>
            </div>
          </div>
        </div>
      )}

      {job && !result && (
        <div className="an-run">
          <div className="an-phases">
            {phases.map((p, i) => (
              <div key={p.id} className={`an-phase ${p.status || 'wait'}`}>
                <span className="an-phase-ico">{p.status === 'run' ? <Spinner size={14} /> : p.status === 'ok' ? <Icon name="check" size={13} stroke={2.4} /> : p.status === 'error' ? <Icon name="x" size={13} stroke={2.4} /> : p.status === 'skip' ? <Icon name="minus" size={13} stroke={2.4} /> : <span>{i + 1}</span>}</span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="an-phase-l">{p.label}</div>
                  {p.message && <div className="an-phase-m">{p.message}</div>}
                  {p.status === 'run' && p.progress != null && <div style={{ marginTop: 6 }}><Progress value={p.progress * 100} /></div>}
                </div>
              </div>
            ))}
          </div>
          <div className="an-log-wrap">
            <div className="caps" style={{ marginBottom: 8 }}>Actividad de Claude</div>
            <div className="an-log" ref={logRef}>
              {!log.length && <div className="t4">Aparece cuando Claude empieza a mirar el video…</div>}
              {log.map((l, i) => <div key={i} className={/^(Mira|Escribe|Edita|Busca|Verifica|Revisa|Audita|Planifica)/.test(l) ? 'act' : 'say'}>{l}</div>)}
            </div>
            {error && <div className="notice error" style={{ marginTop: 12 }}><Icon name="x-circle" size={14} />{error}</div>}
          </div>
        </div>
      )}

      {result && <ResultView r={result} />}
      {dlg.element}
    </Modal>
  )
}

function SaveBar({ result, onSaved, onDiscard }: { result: Result; onSaved: (id: string) => void; onDiscard: () => void }) {
  const { toast } = useApp()
  const p = result.analysis?.plantilla || {}
  const [name, setName] = useState(p.nombre || result.analysis?.titulo || result.title)
  const [desc, setDesc] = useState(p.descripcion || result.analysis?.resumen || '')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      const r = await call('analyze:save', result.id, { name: name.trim() || 'Plantilla', description: desc.trim(), tags: p.etiquetas || [], analysis: result.analysis, stats: result.stats, source: result.source, title: result.title })
      toast(`Plantilla «${name.trim()}» guardada en tus plantillas`)
      onSaved(r.id)
    } catch (e: any) { toast(e.message, true); setBusy(false) }
  }
  return (
    <div className="an-save">
      <Icon name="bookmark" size={16} style={{ color: 'var(--accent-t)' }} />
      <div style={{ width: 230 }}><TextInput value={name} onChange={setName} placeholder="Nombre de la plantilla" /></div>
      <div className="grow"><TextInput value={desc} onChange={setDesc} placeholder="Descripción" /></div>
      <Button variant="ghost" icon="trash" onClick={onDiscard}>Descartar</Button>
      <Button variant="primary" icon="bookmark" onClick={save} loading={busy} disabled={!name.trim()}>Guardar en mis plantillas</Button>
    </div>
  )
}

/** Vista previa en vivo de la escena de muestra (reproducción en bucle). */
export function MiniPlayer({ projectId, width, height }: { projectId: string; width: number; height: number }) {
  const [tl, setTl] = useState<Timeline | null>(null)
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(true)
  useEffect(() => { call<Timeline>('timeline:get', projectId).then(setTl).catch(() => {}) }, [projectId])
  useEffect(() => {
    if (!playing || !tl) return
    let raf = 0, last = performance.now()
    const f = (now: number) => { const dt = (now - last) / 1000; last = now; setT((x) => (x + dt >= tl.duration ? 0 : x + dt)); raf = requestAnimationFrame(f) }
    raf = requestAnimationFrame(f)
    return () => cancelAnimationFrame(raf)
  }, [playing, tl])
  if (!tl) return <div className="an-player" style={{ display: 'grid', placeItems: 'center' }}><Spinner /></div>
  return (
    <div className="an-player">
      <Stage projectId={projectId} tlId="main" t={t} playing={playing} rate={1} width={width} height={height} reloadKey={0} bg="black" pad={0} />
      <div className="an-player-bar">
        <Button size="xs" variant="ghost" icon={playing ? 'pause' : 'play'} onClick={() => setPlaying(!playing)} />
        <input type="range" className="fs-scrub" min={0} max={tl.duration} step={0.01} value={t} style={{ ['--pct' as any]: `${(t / tl.duration) * 100}%` }} onChange={(e) => { setPlaying(false); setT(+e.target.value) }} />
        <span className="mono t3" style={{ fontSize: 11, flex: 'none' }}>{fmtTime(t)} / {fmtTime(tl.duration)}</span>
      </div>
    </div>
  )
}

function ResultView({ r }: { r: Result }) {
  const [tab, setTab] = useState<'muestra' | 'original'>(r.sceneOk ? 'muestra' : 'original')
  const vertical = r.stats.height > r.stats.width * 1.1
  return (
    <div className="an-result">
      <div className="an-left">
        <Tabs size="sm" value={tab} onChange={setTab} tabs={[{ value: 'muestra', label: 'Muestra de estilo', icon: 'play' }, { value: 'original', label: 'Video analizado', icon: 'grid' }]} />
        <div style={{ marginTop: 10 }}>
          {tab === 'muestra' ? (r.sceneOk ? <MiniPlayer projectId={r.workspace} width={vertical ? 1080 : 1920} height={vertical ? 1920 : 1080} /> : <div className="notice warn"><Icon name="alert" size={14} />Claude no llegó a crear la escena de muestra. El análisis igual se puede guardar.</div>)
            : <img className="an-sheet" src={r.sheet} alt="Hoja de contactos" />}
        </div>
        <div className="an-metrics">
          <Metric icon="clock" v={fmtTime(r.stats.duration)} l={r.stats.analyzed < r.stats.duration ? `analizados ${fmtTime(r.stats.analyzed)}` : 'duración'} />
          <Metric icon="scissors" v={String(r.stats.shots)} l="planos" />
          <Metric icon="film" v={`${r.stats.avgShot.toFixed(1)} s`} l="plano promedio" />
          <Metric icon="zap" v={r.stats.cutsPerMin.toFixed(1)} l="cortes/min" />
          <Metric icon="mic" v={r.stats.speechRatio == null ? '—' : `${Math.round(r.stats.speechRatio * 100)} %`} l="con sonido" />
          <Metric icon="message" v={r.stats.wpm ? String(r.stats.wpm) : '—'} l="palabras/min" />
        </div>
        <div className="caps" style={{ margin: '14px 0 6px' }}>Paleta medida (k-means)</div>
        <div className="an-palbar">{r.stats.palette.map((p) => <div key={p.hex} style={{ background: p.hex, flex: p.share }} data-tip={`${p.hex} · ${Math.round(p.share * 100)} %`} />)}</div>
      </div>
      <div className="an-right"><AnalysisReport a={r.analysis} /></div>
    </div>
  )
}

function Metric({ icon, v, l }: { icon: IconName; v: string; l: string }) {
  return <div className="an-metric"><Icon name={icon} size={14} /><div><div className="v tabnum">{v}</div><div className="l">{l}</div></div></div>
}

const freqTone = (f?: string) => (/alta/i.test(f || '') ? 'accent' : /media/i.test(f || '') ? 'info' : 'neutral') as 'accent' | 'info' | 'neutral'
function Sec({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return <section className="an-sec"><h4><Icon name={icon} size={14} />{title}</h4>{children}</section>
}
const list = (xs: any) => (Array.isArray(xs) ? xs : xs ? [xs] : []).filter(Boolean)
const txt = (x: any) => (typeof x === 'string' ? x : x == null ? '' : typeof x === 'object' ? Object.values(x).filter((v) => typeof v === 'string' || typeof v === 'number').join(' · ') : String(x))

/** Informe legible del análisis (se usa al terminar y desde "Ver análisis" en una plantilla guardada). */
export function AnalysisReport({ a }: { a: any }) {
  if (!a) return null
  const n = a.narracion || {}
  return (
    <div className="an-report">
      {a.titulo && <div className="an-title">{a.titulo}</div>}
      {a.resumen && <p className="an-lead">{a.resumen}</p>}
      {a.formato && <div className="an-tags">{list([a.formato.relacion, a.formato.tipo, a.formato.publico]).map((x: string) => <Badge key={x}>{x}</Badge>)}</div>}

      {list(a.paleta).length > 0 && <Sec icon="droplet" title="Paleta">
        <div className="an-swatches">{list(a.paleta).map((p: any, i: number) => (
          <div key={i} className="an-swatch"><span style={{ background: p.hex }} /><div><b className="mono">{p.hex}</b><div>{p.nombre}</div>{p.uso && <div className="t3">{p.uso}</div>}</div></div>
        ))}</div>
      </Sec>}

      {list(a.tipografia).length > 0 && <Sec icon="type" title="Tipografía">
        {list(a.tipografia).map((t: any, i: number) => <div key={i} className="an-item"><b>{t.rol || 'Texto'}</b><span>{t.descripcion || txt(t)}</span>{t.sugerencia && <em>→ {t.sugerencia}</em>}</div>)}
      </Sec>}

      {list(a.animaciones).length > 0 && <Sec icon="move" title="Animaciones">
        <div className="an-cards">{list(a.animaciones).map((x: any, i: number) => (
          <div key={i} className="an-card"><div className="row" style={{ gap: 6 }}><b className="grow">{x.tipo || txt(x)}</b>{x.frecuencia && <Badge tone={freqTone(x.frecuencia)}>{x.frecuencia}</Badge>}</div>
            {x.descripcion && <div className="t2">{x.descripcion}</div>}
            {(x.duracion_s || x.easing) && <div className="t3 mono" style={{ fontSize: 11 }}>{[x.duracion_s && `${x.duracion_s} s`, x.easing].filter(Boolean).join(' · ')}</div>}</div>
        ))}</div>
      </Sec>}

      {list(a.transiciones).length > 0 && <Sec icon="split-v" title="Transiciones">
        {list(a.transiciones).map((x: any, i: number) => <div key={i} className="an-item"><b>{x.tipo || txt(x)}</b><span>{x.descripcion}</span>{x.frecuencia && <Badge tone={freqTone(x.frecuencia)}>{x.frecuencia}</Badge>}</div>)}
      </Sec>}

      {(list(a.formas).length > 0 || list(a.objetos).length > 0 || list(a.texturas_y_efectos).length > 0) && <Sec icon="shapes" title="Formas, objetos y texturas">
        {[['Formas', a.formas], ['Objetos', a.objetos], ['Texturas y efectos', a.texturas_y_efectos]].map(([l, xs]) => list(xs).length ? (
          <div key={l as string} className="an-chiprow"><span className="caps">{l as string}</span><div>{list(xs).map((x: any, i: number) => <span key={i} className="an-chip">{txt(x)}</span>)}</div></div>
        ) : null)}
      </Sec>}

      {a.composicion && <Sec icon="thirds" title="Composición"><p>{txt(a.composicion)}</p></Sec>}
      {a.ritmo && <Sec icon="clock" title="Ritmo"><p>{a.ritmo.descripcion || txt(a.ritmo)}</p></Sec>}

      {(n.tipo || n.tono) && <Sec icon="mic" title="Narración">
        <div className="an-kv">
          {[['Tipo', n.tipo], ['Tono', n.tono], ['Persona', n.persona], ['Estructura', n.estructura], ['Velocidad', n.velocidad_ppm ? `${n.velocidad_ppm} palabras/min` : '']].filter(([, v]) => v).map(([k, v]) => <div key={k as string}><span>{k as string}</span><b>{txt(v)}</b></div>)}
        </div>
        {list(n.recursos).length > 0 && <div className="an-tags" style={{ marginTop: 8 }}>{list(n.recursos).map((x: string, i: number) => <span key={i} className="an-chip">{txt(x)}</span>)}</div>}
      </Sec>}

      {a.sonido && <Sec icon="music" title="Sonido"><div className="an-kv">{a.sonido.musica && <div><span>Música</span><b>{txt(a.sonido.musica)}</b></div>}{a.sonido.efectos && <div><span>Efectos</span><b>{txt(a.sonido.efectos)}</b></div>}</div></Sec>}
      {a.texto_en_pantalla && <Sec icon="type" title="Texto en pantalla"><p>{txt(a.texto_en_pantalla)}</p></Sec>}

      {list(a.claves_para_replicar).length > 0 && <Sec icon="target" title="Claves para replicarlo">
        <ul className="an-list ok">{list(a.claves_para_replicar).map((x: any, i: number) => <li key={i}><Icon name="check" size={13} />{txt(x)}</li>)}</ul>
      </Sec>}
      {list(a.evitar).length > 0 && <Sec icon="alert" title="Evitar">
        <ul className="an-list bad">{list(a.evitar).map((x: any, i: number) => <li key={i}><Icon name="x" size={13} />{txt(x)}</li>)}</ul>
      </Sec>}
    </div>
  )
}
