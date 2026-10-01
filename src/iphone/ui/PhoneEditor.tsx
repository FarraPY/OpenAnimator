/**
 * El editor en el iPhone: el video arriba (se achica con el teclado abierto), los controles de reproducción y abajo
 * tres pestañas: Claude (el chat), Timeline (al estilo de los editores de teléfono: cursor fijo en el centro, se
 * desliza el tiempo) y Medios. La lógica de edición (deshacer, cortar, duplicar, agregar medios) es la del editor de
 * la PC; la forma de tocarla es la del teléfono.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { afterPaint, Asset, call, Clip, fmtTime, on, Project, Timeline as TL, Track, TrackType, uid } from '../../api'
import { useApp } from '../../App'
import Stage, { StageHandle } from '../../components/Stage'
import ChatPanel, { ChatStatus } from '../../components/ChatPanel'
import { useDialogs } from '../../components/Dialogs'
import { Icon } from '../../ui/icons'
import { Spinner } from '../../ui/kit'
import { Actions, Tap, TopBar } from './PhoneApp'
import PhoneTimeline from './PhoneTimeline'
import PhoneMedia from './PhoneMedia'
import PhoneExport from './PhoneExport'
import { PreviewAudio } from './previewAudio'

const KIND_TRACK: Record<string, TrackType> = { scene: 'scene', video: 'video', image: 'video', audio: 'audio' }
const TRACK_NAME: Record<TrackType, string> = { scene: 'Escenas', video: 'Video', audio: 'Audio' }
/** Los clips que se ven en x (escenas y videos): si cambian, la vista previa tiene que cargar algo. */
const visualAt = (d: TL, x: number) => d.tracks.map((tr) => tr.type === 'audio' ? '' : tr.clips.find((c) => x >= c.start && x < c.start + c.duration)?.id || '').join()
type Tab = 'claude' | 'timeline' | 'media'

export default function PhoneEditor({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { toast, settings, go } = useApp()
  const dlg = useDialogs()
  const [project, setProject] = useState<Project | null>(null)
  const [tlId, setTlId] = useState('')
  const [tl, setTl] = useState<TL | null>(null)
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [sel, setSel] = useState<string[]>([])
  const [assets, setAssets] = useState<Asset[]>([])
  const [tab, setTab] = useState<Tab>('claude')
  const [full, setFull] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [menu, setMenu] = useState(false)
  const [chat, setChat] = useState<ChatStatus>({ busy: false, waiting: false, assistant: 0, session: null })
  const [seen, setSeen] = useState(0)
  const [inject, setInject] = useState<{ text: string; n: number } | null>(null)
  const stage = useRef<StageHandle>(null)
  const hist = useRef<{ past: TL[]; future: TL[] }>({ past: [], future: [] })
  const saveTimer = useRef(0)
  const tRef = useRef(0); tRef.current = t
  const tlRef = useRef<TL | null>(null); tlRef.current = tl
  const audio = useRef<PreviewAudio | null>(null)
  if (!audio.current) audio.current = new PreviewAudio()

  // ── carga y cambios de archivos (Claude guarda escenas, el timeline…) ──────
  const loadTimeline = useCallback(async (id: string) => { setTl(await call<TL>('timeline:get', projectId, id)); hist.current = { past: [], future: [] } }, [projectId])
  const refreshAssets = useCallback(() => call<Asset[]>('assets:list', projectId).then(setAssets).catch(() => {}), [projectId])
  useEffect(() => {
    let opened = false
    const cancel = afterPaint(() => {
      opened = true
      call<Project>('project:open', projectId).then(async (p) => { setProject(p); setTlId(p.activeTimeline); await loadTimeline(p.activeTimeline) }).catch((e) => { toast(e.message, true); onClose() })
      refreshAssets()
    })
    const a = audio.current!
    return () => { cancel(); a.close(); if (opened) call('project:close', projectId) }
  }, [projectId])

  const changes = useRef<{ project?: boolean; timeline?: boolean; assets?: boolean; timer?: number }>({})
  useEffect(() => on('project:changed', (e: { id: string; kind: string; file: string }) => {
    if (e.id !== projectId) return
    const q = changes.current
    if (e.kind === 'project') q.project = true
    else if (e.kind === 'timeline') { const ref = project?.timelines.find((x) => x.id === tlId); if (ref && e.file === ref.file.replace(/\\/g, '/')) q.timeline = true }
    else q.assets = true
    window.clearTimeout(q.timer)
    q.timer = window.setTimeout(async () => {
      const { project: pj, timeline, assets: as } = changes.current
      changes.current = {}
      try {
        if (pj) setProject(await call<Project>('project:get', projectId))
        if (timeline) setTl(await call<TL>('timeline:get', projectId, tlId))
      } catch (err: any) { toast(err.message, true) }
      if (as) { refreshAssets(); audio.current?.forget() }
      if (timeline || as) stage.current?.reload()
    }, 400)
  }), [projectId, project, tlId])
  useEffect(() => () => window.clearTimeout(changes.current.timer), [])

  // ── edición con deshacer (como en la PC) ──────────────────────────────────
  const persist = (next: TL) => {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => { call('timeline:save', projectId, tlId, next).then(() => stage.current?.reload()).catch((e) => toast(e.message, true)) }, 250)
  }
  const dragBase = useRef<TL | null>(null)
  /** commit=false mientras se arrastra (no guarda ni entra al historial hasta soltar). */
  const change = (next: TL, commit = true) => {
    if (!commit) { if (!dragBase.current) dragBase.current = tlRef.current; setTl(next); return }
    const base = dragBase.current || tlRef.current
    dragBase.current = null
    if (base) { hist.current.past.push(base); if (hist.current.past.length > 200) hist.current.past.shift(); hist.current.future = [] }
    const end = Math.max(0, ...next.tracks.flatMap((x) => x.clips.map((c) => c.start + c.duration)))
    if (end > next.duration) next.duration = +end.toFixed(3)
    setTl(next); persist(next)
  }
  const undo = () => { const h = hist.current; const prev = h.past.pop(); if (!prev || !tl) return; h.future.push(tl); setTl(prev); persist(prev) }
  const redo = () => { const h = hist.current; const nx = h.future.pop(); if (!nx || !tl) return; h.past.push(tl); setTl(nx); persist(nx) }
  const mutate = (fn: (d: TL) => void) => { if (!tl) return; const d = structuredClone(tl); fn(d); change(d) }
  const findClip = (d: TL, id: string) => { for (const tr of d.tracks) { const c = tr.clips.find((x) => x.id === id); if (c) return { tr, c } } return null }

  const splitAt = (time: number) => mutate((d) => {
    const ids = sel.length ? sel : d.tracks.flatMap((tr) => tr.clips.filter((c) => time > c.start && time < c.start + c.duration).map((c) => c.id))
    for (const id of ids) {
      const f = findClip(d, id); if (!f) continue
      const { tr, c } = f
      if (time <= c.start + 0.02 || time >= c.start + c.duration - 0.02) continue
      const a = time - c.start
      tr.clips.push({ ...c, id: uid('c'), start: time, duration: c.duration - a, in: (c.in || 0) + a, fadeIn: 0 })
      c.duration = a; c.fadeOut = 0
    }
  })
  const delSel = () => mutate((d) => { for (const tr of d.tracks) tr.clips = tr.clips.filter((c) => !sel.includes(c.id)); setSel([]) })
  const dupSel = () => mutate((d) => {
    const nsel: string[] = []
    for (const tr of d.tracks) for (const c of [...tr.clips]) if (sel.includes(c.id)) {
      const end = Math.max(...tr.clips.map((x) => x.start + x.duration))
      const n = { ...c, id: uid('c'), start: end }; tr.clips.push(n); nsel.push(n.id)
    }
    setSel(nsel)
  })
  const patchClip = (id: string, p: Partial<Clip>, commit = true) => { if (!tl) return; const d = structuredClone(tl); const f = findClip(d, id); if (f) Object.assign(f.c, p); change(d, commit) }
  const patchTrack = (id: string, p: Partial<Track>) => mutate((d) => { const tr = d.tracks.find((x) => x.id === id); if (tr) Object.assign(tr, p) })

  const addAsset = async (a: Asset) => {
    if (!tl) return
    const type = KIND_TRACK[a.kind]
    if (!type) { toast('Ese archivo no va en el timeline', true); return }
    toast(`Agregando «${a.name}»…`, 'info')
    let dur = a.kind === 'image' ? (settings?.editor.imageDuration || 5) : 5, srcDur: number | undefined
    try {
      if (a.kind === 'scene') { const r = await stage.current!.probe(a.path); dur = r.duration || 10 }
      else if (a.kind === 'audio' || a.kind === 'video') { const r = await call('media:probe', projectId, a.path); if (r.duration) { dur = r.duration; srcDur = r.duration } }
    } catch { /* duración por defecto */ }
    const at = tRef.current
    mutate((d) => {
      let tr = d.tracks.find((x) => x.type === type)
      if (!tr) { tr = { id: uid('t'), name: TRACK_NAME[type], type, clips: [] }; if (type === 'audio') d.tracks.push(tr); else d.tracks.unshift(tr) }
      // En el cursor; si ahí ya hay algo en esa pista, a continuación del último clip.
      const busy = tr.clips.some((c) => at < c.start + c.duration && at + dur > c.start)
      const start = busy ? Math.max(0, ...tr.clips.map((c) => c.start + c.duration)) : at
      const c: any = { id: uid('c'), src: a.path, start: +start.toFixed(3), duration: +dur.toFixed(3), in: 0 }
      if (srcDur) c.srcDur = srcDur
      tr.clips.push(c)
      setSel([c.id])
    })
    setTab('timeline')
  }

  // ── reproducción: el reloj de la página; el sonido lo pone PreviewAudio ────
  const rate = 1
  useEffect(() => {
    if (!playing || !tl) return
    let raf = 0, last = performance.now()
    const tick = (now: number) => {
      const dt = ((now - last) / 1000) * rate
      last = now
      const nt = tRef.current + dt
      if (nt >= tl.duration) { setT(tl.duration); setPlaying(false); return }
      setT(nt)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, tl?.duration])
  useEffect(() => { if (!playing) audio.current?.stop() }, [playing])
  /** Se llama desde el toque (Safari sólo deja sonar el audio así). */
  const togglePlay = () => {
    if (!tl) return
    if (playing) { setPlaying(false); return }
    const from = tRef.current >= tl.duration - 0.05 ? 0 : tRef.current
    audio.current!.unlock()
    setT(from)
    setPlaying(true)
    audio.current!.play(projectId, tl, from, rate)
  }
  const seek = (x: number) => {
    const nt = Math.max(0, Math.min(tl?.duration || 0, x))
    setT(nt)
    if (playing && tl) audio.current!.play(projectId, tl, nt, rate)
  }
  /** El dedo en el timeline pausa (como en los editores de teléfono) y mueve el cursor. Si va rápido y pasa a otra
   *  escena (o video), la vista previa se queda en su cuadro hasta que frena: cada escena nueva se carga entera, en el
   *  mismo hilo que la interfaz, y recorrer un proyecto largo iba a 2 cuadros por segundo (prueba del proyecto pesado). */
  const [hold, setHold] = useState<number | null>(null)
  const fling = useRef({ t: 0, at: 0, timer: 0 })
  const scrub = (x: number, phase: 'start' | 'move' | 'end') => {
    if (phase === 'start' && playing) setPlaying(false)
    const nt = Math.max(0, Math.min(tl?.duration || 0, x))
    const f = fling.current, now = performance.now()
    const fast = phase === 'move' && Math.abs(nt - f.t) * 1000 > 10 * Math.max(1, now - f.at) // más de 10 s del timeline por segundo
    f.t = nt; f.at = now
    const shown = hold ?? tRef.current
    if (fast && tl && visualAt(tl, nt) !== visualAt(tl, shown)) {
      if (hold == null) setHold(shown)
      clearTimeout(f.timer)
      f.timer = window.setTimeout(() => setHold(null), 150)
    }
    setT(nt)
  }
  const fps = project?.fps || 30
  useEffect(() => { if (tab === 'claude') setSeen(chat.assistant) }, [tab, chat.assistant])
  useEffect(() => { if (exporting) setPlaying(false) }, [exporting])
  const unread = tab === 'claude' ? 0 : Math.max(0, chat.assistant - seen)
  const askClaude = (text: string) => { setTab('claude'); setInject({ text, n: Date.now() }) }

  // ── timelines y proyecto ───────────────────────────────────────────────────
  const switchTl = async (id: string) => {
    const p = await call<Project>('timelines:setActive', projectId, id)
    setProject(p); setTlId(id); setSel([]); setT(0); setPlaying(false); await loadTimeline(id)
  }
  const newTl = async () => {
    const name = await dlg.prompt({ title: 'Nuevo timeline', label: 'Nombre', value: `Timeline ${(project?.timelines.length || 0) + 1}`, ok: 'Crear', icon: 'plus' })
    if (!name) return
    const p = await call<Project>('timelines:create', projectId, name)
    setProject(p); setTlId(p.activeTimeline); await loadTimeline(p.activeTimeline); setT(0)
  }
  const renameProject = async () => {
    if (!project) return
    const name = await dlg.prompt({ title: 'Renombrar proyecto', value: project.name, ok: 'Renombrar' })
    if (name) { await call('projects:rename', projectId, name).catch((e) => toast(e.message, true)); setProject(await call<Project>('project:get', projectId)) }
  }
  const addNote = async () => {
    const text = await dlg.prompt({ title: `Nota en ${fmtTime(tRef.current, true, fps)}`, label: 'Para Claude: qué cambiar en este momento del video', placeholder: 'p. ej. que el título entre más lento', ok: 'Guardar nota', icon: 'note' })
    if (text) mutate((d) => { d.notes = [...(d.notes || []), { id: uid('n'), t: +tRef.current.toFixed(3), text }] })
  }

  if (!project || !tl) return <><TopBar left={<Tap icon="chevron-left" label="Volver" onClick={onClose} back />} /><div className="ph-center"><Spinner size={22} /><span className="t3">Abriendo el proyecto…</span></div></>

  const ar = project.height / project.width
  return (
    <div className={`ed ${full ? 'full' : ''}`}>
      <TopBar left={<Tap icon="chevron-left" label="Proyectos" onClick={onClose} back />}
        title={<button className="ed-name" onClick={() => setMenu(true)}><span className="ellipsis">{project.name}</span><Icon name="chevron-down" size={14} /></button>}
        right={<>
          <Tap icon="undo" label="Deshacer" onClick={undo} disabled={!hist.current.past.length} />
          <Tap icon="redo" label="Rehacer" onClick={redo} disabled={!hist.current.future.length} />
          <button className="ed-export" onClick={() => setExporting(true)}><Icon name="export" size={17} />Exportar</button>
        </>} />

      <div className="ed-player" style={{ ['--ar' as any]: ar }}>
        {!exporting && <Stage ref={stage} projectId={projectId} tlId={tlId} t={hold ?? t} playing={playing} rate={rate} width={project.width} height={project.height} reloadKey={0} pad={full ? 0 : 6} bg="black" onError={(m) => toast(m, true)} />}
        <button className="ed-tapzone" aria-label={playing ? 'Pausa' : 'Reproducir'} onClick={togglePlay} />
        {full && <div className="ed-fullbar">
          <Tap icon="minimize" label="Salir de pantalla completa" onClick={() => setFull(false)} />
          <span className="tabnum">{fmtTime(t)} / {fmtTime(tl.duration)}</span>
          <input className="ed-seek" type="range" min={0} max={tl.duration || 1} step={1 / fps} value={t} onChange={(e) => seek(+e.target.value)} />
          <Tap icon={playing ? 'pause' : 'play'} label={playing ? 'Pausa' : 'Reproducir'} onClick={togglePlay} />
        </div>}
      </div>

      {!full && <>
        <div className="ed-transport">
          <span className="tabnum ed-time"><b>{fmtTime(t, true, fps)}</b><span className="t3"> / {fmtTime(tl.duration)}</span></span>
          <div className="grow" />
          <Tap icon="skip-back" label="Ir al inicio" disabled={t <= 0} onClick={() => seek(0)} />
          <Tap icon="step-back" label="Fotograma anterior" onClick={() => seek(t - 1 / fps)} />
          <button className="ed-play" aria-label={playing ? 'Pausa' : 'Reproducir'} onClick={togglePlay}><Icon name={playing ? 'pause' : 'play'} size={24} /></button>
          <Tap icon="step-fwd" label="Fotograma siguiente" onClick={() => seek(t + 1 / fps)} />
          <div className="grow" />
          <Tap icon="maximize" label="Pantalla completa" onClick={() => setFull(true)} />
        </div>

        <div className="ed-tabs" role="tablist">
          {([['claude', 'sparkles', 'Claude'], ['timeline', 'film', 'Timeline'], ['media', 'folder', 'Medios']] as const).map(([id, icon, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={`ed-tab ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>
              <Icon name={icon} size={17} />{label}
              {id === 'claude' && (chat.waiting ? <span className="ed-dot warn" /> : chat.busy ? <span className="ed-dot busy" /> : unread ? <span className="ed-count">{unread}</span> : null)}
            </button>
          ))}
        </div>

        <div className="ed-pane">
          <div className="ed-chat" style={{ display: tab === 'claude' ? 'flex' : 'none' }}>
            <ChatPanel projectId={projectId} visible={tab === 'claude'} context={() => ({ timeline: tlId, t: tRef.current })} onStatus={setChat} inject={inject} />
          </div>
          {tab === 'timeline' && <PhoneTimeline tl={tl} t={t} fps={fps} playing={playing} sel={sel} projectId={projectId}
            onScrub={scrub} onSelect={setSel} onChange={change} onSplit={() => splitAt(tRef.current)} onDelete={delSel} onDuplicate={dupSel}
            onPatchClip={patchClip} onPatchTrack={patchTrack} onAdd={() => setTab('media')} onNote={addNote} onAsk={askClaude} />}
          {tab === 'media' && <PhoneMedia projectId={projectId} assets={assets} onRefresh={refreshAssets} onAdd={addAsset} onAsk={askClaude} />}
        </div>
      </>}

      {exporting && <PhoneExport project={project} currentTl={tlId} onClose={() => setExporting(false)} />}
      {menu && <Actions title={project.name} onClose={() => setMenu(false)} items={[
        { label: 'Renombrar proyecto…', icon: 'edit', onSelect: renameProject },
        { label: 'Nota para Claude en el cursor…', icon: 'note', onSelect: addNote },
        { sep: true },
        ...project.timelines.map((x) => ({ label: x.name, icon: x.id === tlId ? 'check' : 'film', desc: x.id === tlId ? 'Timeline actual' : undefined, onSelect: () => { if (x.id !== tlId) switchTl(x.id) } })),
        { label: 'Nuevo timeline…', icon: 'plus', onSelect: newTl },
        { sep: true },
        { label: 'Ajustes', icon: 'settings', onSelect: () => go({ page: 'settings', from: { page: 'editor', id: projectId } }) },
      ]} />}
      {dlg.element}
    </div>
  )
}
