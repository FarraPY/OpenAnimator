/**
 * «Plantilla desde un video» en el iPhone: un enlace de YouTube o un video del teléfono → la app lo mide, Claude (en el
 * teléfono) escribe el análisis y una escena de muestra, y se guarda como plantilla (src/android/backend/analyzer.ts).
 * Es la herramienta de la PC (components/Analyzer.tsx), de la que usa el informe y la vista previa, en una pantalla.
 */
import { useEffect, useRef, useState } from 'react'
import { call, fmtTime, on } from '../../api'
import type { AnalyzeResult } from '../../../electron/analyzer-core'
import { useApp } from '../../App'
import { AnalysisReport, MiniPlayer } from '../../components/Analyzer'
import { useDialogs } from '../../components/Dialogs'
import { Icon, IconName } from '../../ui/icons'
import { Button, Progress, Spinner, Switch, TextArea, TextInput } from '../../ui/kit'
import { Chips, Group, Row, Tap, TopBar } from './PhoneApp'

type PhaseState = { id: string; label: string; status?: 'run' | 'ok' | 'skip' | 'error'; message?: string; progress?: number }
const isUrl = (s: string) => /^https?:\/\//i.test(s.trim())

export default function PhoneAnalyzer({ onClose }: { onClose: () => void }) {
  const { toast } = useApp()
  const dlg = useDialogs()
  const [mode, setMode] = useState<'url' | 'file'>('url')
  const [url, setUrl] = useState('')
  const [file, setFile] = useState<{ path: string; name: string } | null>(null)
  const [maxMin, setMaxMin] = useState(10)
  const [transcribe, setTranscribe] = useState(true)
  const [notes, setNotes] = useState('')
  const [job, setJob] = useState<string | null>(null)
  const [phases, setPhases] = useState<PhaseState[]>([])
  const [log, setLog] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AnalyzeResult | null>(null)
  const [started, setStarted] = useState(0)
  const [, tick] = useState(0)
  const jobRef = useRef<string | null>(null)
  const early = useRef<any[]>([])
  const logRef = useRef<HTMLDivElement>(null)

  const apply = (e: any) => {
    if (e.log) setLog((l) => [...l.slice(-200), e.log])
    if (e.phase && e.status) setPhases((ps) => ps.map((p) => (p.id === e.phase ? { ...p, status: e.status, message: e.message ?? p.message, progress: e.progress } : p)))
    if (e.done) { if (e.error) setError(e.error); if (e.result) setResult(e.result) }
  }
  // Los primeros eventos pueden llegar antes de que 'analyze:start' devuelva el id: se guardan y se aplican después.
  useEffect(() => on('analyze:event', (e: any) => { if (e.id === jobRef.current) apply(e); else if (!jobRef.current) early.current.push(e) }), [])
  const running = !!job && !result && !error
  useEffect(() => { if (!running) return; const i = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(i) }, [running])
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight }, [log])

  const source = mode === 'url' ? url.trim() : file?.path || ''
  const canStart = mode === 'url' ? isUrl(url) : !!file

  const start = async () => {
    if (!canStart) return
    try {
      const ph = await call<Array<{ id: string; label: string }>>('analyze:phases')
      setPhases(ph.map((p) => ({ ...p })))
      setLog([]); setError(null); setResult(null); setStarted(Date.now()); early.current = []
      const id = await call<string>('analyze:start', { source, name: file?.name, transcribe, maxMinutes: maxMin, notes: notes.trim() || undefined })
      jobRef.current = id; setJob(id)
      early.current.filter((e) => e.id === id).forEach(apply); early.current = []
    } catch (e: any) { toast(e.message, true) }
  }
  const close = async () => {
    if (running) {
      if (!(await dlg.confirm({ title: '¿Cancelar el análisis?', message: 'Se pierde lo hecho hasta ahora.', ok: 'Cancelar análisis', cancel: 'Seguir', danger: true }))) return
      await call('analyze:cancel', job).catch(() => {})
    } else if (result && !(await dlg.confirm({ title: '¿Descartar el análisis?', message: 'Si no lo guardás como plantilla, se pierde.', ok: 'Descartar', cancel: 'Volver', danger: true }))) return
    if (job) await call('analyze:discard', job).catch(() => {})
    onClose()
  }
  const retry = async () => { if (job) await call('analyze:discard', job).catch(() => {}); jobRef.current = null; setJob(null); setResult(null); setError(null); setPhases([]) }
  const pick = async () => {
    try { const f = await call<{ path: string; name: string } | null>('analyze:pickFile'); if (f) { setFile(f); setMode('file') } } catch (e: any) { toast(e.message, true) }
  }

  const title = result ? 'Análisis listo' : running ? 'Analizando…' : error ? 'No terminó' : undefined
  return (
    <>
      <TopBar left={<Tap icon="chevron-left" label="Volver" onClick={close} back />} title={title} />
      <div className="ph-scroll an2">
        {!job && <>
          <h1 className="ph-title">Plantilla desde un video</h1>
          <div className="ph-sub">Claude analiza los colores, las animaciones, las formas, el ritmo y la narración, y arma una plantilla con ese estilo.</div>
          <Chips value={mode} onChange={setMode} options={[{ value: 'url', label: 'Enlace de YouTube' }, { value: 'file', label: 'Video del teléfono' }]} />
          {mode === 'url' ? <div className="an2-src">
            <TextInput icon="link" value={url} onChange={setUrl} onEnter={start} placeholder="https://youtu.be/…" clearable />
            <div className="an2-hint">Se baja en 720p sólo para analizarlo; no queda en la plantilla.</div>
          </div> : (
            <button className={`an2-pick ${file ? 'has' : ''}`} onClick={pick}>
              <Icon name={file ? 'video' : 'upload'} size={28} stroke={1.4} />
              <b className="ellipsis">{file ? file.name : 'Elegir un video'}</b>
              <small>{file ? 'Tocá para elegir otro' : 'De Fotos o de Archivos'}</small>
            </button>
          )}
          <label className="ph-label">Indicaciones para Claude (opcional)</label>
          <TextArea rows={3} value={notes} onChange={setNotes} placeholder="Ej.: fijate en cómo entran los textos y en las transiciones." />
          <Group title="Opciones">
            <Row label="Transcribir la narración" detail="Con Whisper en el iPhone, si el video no trae subtítulos"><Switch checked={transcribe} onChange={setTranscribe} /></Row>
            <Row label="Analizar hasta" detail="En videos largos, sólo el comienzo" stack>
              <Chips value={maxMin} onChange={setMaxMin} options={[3, 5, 10, 20].map((m) => ({ value: m, label: `${m} min` }))} />
            </Row>
          </Group>
          <div className="an2-hint">Usa Claude Code con tu plan. Tarda unos minutos: dejá la app abierta (la pantalla no se apaga).</div>
        </>}

        {job && !result && <>
          <div className="an2-head">
            {running ? <><Spinner size={14} /><span className="tabnum">{fmtTime((Date.now() - started) / 1000)}</span><span className="t3 ellipsis">{isUrl(source) ? source : file?.name}</span></>
              : <><Icon name="x-circle" size={16} /><span>El análisis no terminó</span></>}
          </div>
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
          {error && <div className="notice error" style={{ marginTop: 12 }}><Icon name="x-circle" size={14} />{error}</div>}
          <label className="ph-label">Actividad de Claude</label>
          <div className="an-log an2-log" ref={logRef}>
            {!log.length && <div className="t4">Aparece cuando Claude empieza a mirar el video…</div>}
            {log.map((l, i) => <div key={i} className={/^(Mira|Escribe|Edita|Busca|Verifica|Revisa|Audita|Planifica|Lee)/.test(l) ? 'act' : 'say'}>{l}</div>)}
          </div>
        </>}

        {result && <ResultView r={result} onSaved={(name) => { toast(`Plantilla «${name}» guardada: elegila al crear un proyecto nuevo`); onClose() }} onDiscard={close} />}
      </div>
      {!job && <button className="fab" data-glass="accent" disabled={!canStart} onClick={start}><Icon name="sparkles" size={20} />Analizar video</button>}
      {running && <button className="fab an2-stop" data-glass onClick={close}><Icon name="stop" size={18} />Cancelar</button>}
      {error && <button className="fab" data-glass="accent" onClick={retry}><Icon name="refresh" size={18} />Volver a intentar</button>}
      {dlg.element}
    </>
  )
}

function ResultView({ r, onSaved, onDiscard }: { r: AnalyzeResult; onSaved: (name: string) => void; onDiscard: () => void }) {
  const { toast } = useApp()
  const [tab, setTab] = useState<'muestra' | 'original'>(r.sceneOk ? 'muestra' : 'original')
  const p = r.analysis?.plantilla || {}
  const [name, setName] = useState<string>(p.nombre || r.analysis?.titulo || r.title)
  const [desc, setDesc] = useState<string>(p.descripcion || r.analysis?.resumen || '')
  const [busy, setBusy] = useState(false)
  const vertical = r.stats.height > r.stats.width * 1.1
  const save = async () => {
    setBusy(true)
    try {
      await call('analyze:save', r.id, { name: name.trim() || 'Plantilla', description: desc.trim(), tags: p.etiquetas || [], analysis: r.analysis, stats: r.stats, source: r.source, title: r.title })
      onSaved(name.trim() || 'Plantilla')
    } catch (e: any) { toast(e.message, true); setBusy(false) }
  }
  const metric = (icon: IconName, v: string, l: string) => <div className="an-metric"><Icon name={icon} size={14} /><div><div className="v tabnum">{v}</div><div className="l">{l}</div></div></div>
  return (
    <div className="an2-result">
      <h1 className="ph-title">{r.analysis?.titulo || r.title}</h1>
      <Chips value={tab} onChange={setTab} options={[{ value: 'muestra', label: 'Muestra de estilo' }, { value: 'original', label: 'Video analizado' }]} />
      <div className={`an2-view ${vertical ? 'v' : ''}`}>
        {tab === 'muestra' ? (r.sceneOk ? <MiniPlayer projectId={r.workspace} width={vertical ? 1080 : 1920} height={vertical ? 1920 : 1080} />
          : <div className="notice warn"><Icon name="alert" size={14} />Claude no llegó a crear la escena de muestra. El análisis igual se puede guardar.</div>)
          : <img className="an-sheet" src={r.sheet} alt="Hoja de contactos del video" />}
      </div>
      <div className="an-metrics">
        {metric('clock', fmtTime(r.stats.duration), r.stats.analyzed < r.stats.duration ? `analizados ${fmtTime(r.stats.analyzed)}` : 'duración')}
        {metric('scissors', String(r.stats.shots), 'planos')}
        {metric('film', `${r.stats.avgShot.toFixed(1).replace('.', ',')} s`, 'plano promedio')}
        {metric('zap', r.stats.cutsPerMin.toFixed(1).replace('.', ','), 'cortes/min')}
        {metric('mic', r.stats.speechRatio == null ? '—' : `${Math.round(r.stats.speechRatio * 100)} %`, 'con sonido')}
        {metric('message', r.stats.wpm ? String(r.stats.wpm) : '—', 'palabras/min')}
      </div>
      <label className="ph-label">Paleta medida</label>
      <div className="an-palbar">{r.stats.palette.map((x) => <div key={x.hex} style={{ background: x.hex, flex: x.share }} />)}</div>
      <div className="an2-report"><AnalysisReport a={r.analysis} /></div>
      <label className="ph-label">Guardar como plantilla</label>
      <div className="an2-save">
        <TextInput value={name} onChange={setName} placeholder="Nombre de la plantilla" clearable />
        <TextArea rows={2} value={desc} onChange={setDesc} placeholder="Descripción" />
        <Button variant="primary" size="lg" icon="bookmark" onClick={save} loading={busy} disabled={!name.trim()}>Guardar en mis plantillas</Button>
        <Button variant="ghost" icon="trash" onClick={onDiscard} disabled={busy}>Descartar</Button>
      </div>
    </div>
  )
}
