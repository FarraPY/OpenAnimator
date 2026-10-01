/**
 * El editor en el iPhone: botones de vidrio arriba, el video, la barra de reproducción y el timeline siempre a la vista
 * (al estilo de los editores de teléfono: cursor fijo en el centro, se desliza el tiempo); abajo, una hoja de vidrio con
 * Claude (el chat) y Medios, que con la pestaña Timeline queda chica y se agranda arrastrando la manija. Con el teclado
 * abierto queda el video chico y la hoja. La lógica de edición (deshacer, cortar, duplicar, agregar medios) es la del
 * editor de la PC; la forma de tocarla es la del teléfono.
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
import PhoneInspector from './PhoneInspector'
import PhoneExport from './PhoneExport'
import { PreviewAudio } from './previewAudio'

const KIND_TRACK: Record<string, TrackType> = { scene: 'scene', video: 'video', image: 'video', audio: 'audio' }
const TRACK_NAME: Record<TrackType, string> = { scene: 'Escenas', video: 'Video', audio: 'Audio' }
/** Los clips que se ven en x (escenas y videos): si cambian, la vista previa tiene que cargar algo. */
const visualAt = (d: TL, x: number) => d.tracks.map((tr) => tr.type === 'audio' ? '' : tr.clips.find((c) => x >= c.start && x < c.start + c.duration)?.id || '').join()
type Tab = 'claude' | 'timeline' | 'media'
/** La hoja de abajo: sólo las pestañas, a media altura o casi toda la pantalla (el timeline de arriba se esconde). */
type Sheet = 'min' | 'mid' | 'max'

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
  const [sheet, setSheet] = useState<Sheet>('mid')
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

  const addAssets = async (list: Asset[]) => {
    if (!tl) return
    const ok = list.filter((a) => KIND_TRACK[a.kind])
    if (!ok.length) { toast('Ese archivo no va en el timeline', true); return }
    toast(ok.length === 1 ? `Agregando «${ok[0].name}»…` : `Agregando ${ok.length} archivos…`, 'info')
    const items = await Promise.all(ok.map(async (a) => {
      let dur = a.kind === 'image' ? (settings?.editor.imageDuration || 5) : 5, srcDur: number | undefined
      try {
        if (a.kind === 'scene') { const r = await stage.current!.probe(a.path); dur = r.duration || 10 }
        else if (a.kind === 'audio' || a.kind === 'video') { const r = await call('media:probe', projectId, a.path); if (r.duration) { dur = r.duration; srcDur = r.duration } }
      } catch { /* duración por defecto */ }
      return { a, dur, srcDur }
    }))
    const at = tRef.current, ids: string[] = []
    mutate((d) => {
      for (const { a, dur, srcDur } of items) {
        const type = KIND_TRACK[a.kind]
        let tr = d.tracks.find((x) => x.type === type)
        if (!tr) { tr = { id: uid('t'), name: TRACK_NAME[type], type, clips: [] }; if (type === 'audio') d.tracks.push(tr); else d.tracks.unshift(tr) }
        // En el cursor; si ahí ya hay algo en esa pista, a continuación del último clip.
        const busy = tr.clips.some((c) => at < c.start + c.duration && at + dur > c.start)
        const start = busy ? Math.max(0, ...tr.clips.map((c) => c.start + c.duration)) : at
        const c: any = { id: uid('c'), src: a.path, start: +start.toFixed(3), duration: +dur.toFixed(3), in: 0 }
        if (srcDur) c.srcDur = srcDur
        tr.clips.push(c)
        ids.push(c.id)
      }
      setSel(ids)
    })
    // Se ve en el timeline y abajo quedan sus ajustes.
    setTab('timeline'); setSheet('mid')
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
  /** Abrir una pestaña de la hoja (si estaba minimizada, sube a media altura). */
  const openTab = (id: Tab) => { setTab(id); setSheet((s) => (s === 'min' ? 'mid' : s)) }
  /** Tocar una pestaña: la abre; tocar la que ya está abierta minimiza la hoja. */
  const pickTab = (id: Tab) => { if (id === tab && sheet !== 'min') setSheet('min'); else openTab(id) }
  const askClaude = (text: string) => { openTab('claude'); setInject({ text, n: Date.now() }) }
  // La manija: tocarla alterna media altura y casi toda la pantalla; arrastrarla, un paso hacia donde va el dedo.
  const grab = useRef<number | null>(null)
  const grabDown = (e: React.PointerEvent) => { grab.current = e.clientY; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) }
  const grabUp = (e: React.PointerEvent) => {
    if (grab.current == null) return
    const dy = e.clientY - grab.current
    grab.current = null
    const order: Sheet[] = ['min', 'mid', 'max'], i = order.indexOf(sheet)
    setSheet(Math.abs(dy) < 12 ? (sheet === 'mid' ? 'max' : 'mid') : order[Math.max(0, Math.min(2, i + (dy < 0 ? 1 : -1)))])
  }
  /** 00:28.24 (o 01:15 sin centésimas). */
  const clock = (x: number, frac = true) => {
    const cs = Math.round(Math.max(0, x) * 100), m = Math.floor(cs / 6000), sec = (cs % 6000) / 100
    return `${String(m).padStart(2, '0')}:${frac ? sec.toFixed(2).padStart(5, '0') : String(Math.floor(sec)).padStart(2, '0')}`
  }

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
  const tabs = [['claude', 'sparkles', 'Claude'], ['timeline', 'film', 'Timeline'], ['media', 'folder', 'Medios']] as const
  const timeline = (
    <PhoneTimeline tl={tl} tlId={tlId} t={t} fps={fps} playing={playing} sel={sel} projectId={projectId}
      onScrub={scrub} onSelect={setSel} onChange={change} onSplit={() => splitAt(tRef.current)} onDelete={delSel} onDuplicate={dupSel}
      onPatchTrack={patchTrack} onAdd={() => openTab('media')} onNote={addNote} onAsk={askClaude} onInspect={() => openTab('timeline')} />
  )
  return (
    <div className={`ed sh-${sheet} tab-${tab} ${full ? 'full' : ''}`}>
      <div className="ph-top ed-top">
        <button className="g-btn" data-glass aria-label="Proyectos" data-back onClick={onClose}><Icon name="chevron-left" size={22} /></button>
        <button className="ed-name" data-glass onClick={() => setMenu(true)}><span className="ellipsis">{project.name}</span><Icon name="chevron-down" size={15} /></button>
        <div className="grow" />
        <button className="g-btn" data-glass aria-label="Deshacer" onClick={undo} disabled={!hist.current.past.length}><Icon name="undo" size={19} /></button>
        <button className="g-btn" data-glass aria-label="Rehacer" onClick={redo} disabled={!hist.current.future.length}><Icon name="redo" size={19} /></button>
        <button className="ed-export" data-glass="accent" onClick={() => setExporting(true)}><Icon name="export" size={17} />Exportar</button>
      </div>

      <div className="ed-media">
        <div className="ed-player" style={{ ['--ar' as any]: ar }}>
          <div className="ed-stage">
            {!exporting && <Stage ref={stage} projectId={projectId} tlId={tlId} t={hold ?? t} playing={playing} rate={rate} width={project.width} height={project.height} reloadKey={0} pad={0} bg="black" onError={(m) => toast(m, true)} />}
            <button className="ed-tapzone" aria-label={playing ? 'Pausa' : 'Reproducir'} onClick={togglePlay} />
            {full && <div className="ed-fullbar">
              <Tap icon="minimize" label="Salir de pantalla completa" onClick={() => setFull(false)} />
              <span className="tabnum">{fmtTime(t)} / {fmtTime(tl.duration)}</span>
              <input className="ed-seek" type="range" min={0} max={tl.duration || 1} step={1 / fps} value={t} onChange={(e) => seek(+e.target.value)} />
              <Tap icon={playing ? 'pause' : 'play'} label={playing ? 'Pausa' : 'Reproducir'} onClick={togglePlay} />
            </div>}
          </div>
        </div>

        {!full && <div className="ed-transport" data-glass>
          <span className="ed-time tabnum"><b>{clock(t)}</b><span> / {clock(tl.duration, false)}</span></span>
          <div className="ed-tp" data-glass>
            <button className="ed-tpb" aria-label="Ir al inicio" disabled={t <= 0} onClick={() => seek(0)}><Icon name="skip-back" size={20} /></button>
            <button className="ed-play" data-glass="light" aria-label={playing ? 'Pausa' : 'Reproducir'} onClick={togglePlay}><Icon name={playing ? 'pause' : 'play'} size={22} /></button>
            <button className="ed-tpb" aria-label="Ir al final" disabled={t >= tl.duration} onClick={() => seek(tl.duration)}><Icon name="skip-fwd" size={20} /></button>
          </div>
          <button className="ed-tpb ed-fs" aria-label="Pantalla completa" onClick={() => setFull(true)}><Icon name="maximize" size={19} /></button>
        </div>}
      </div>

      {!full && <>
        {sheet !== 'max' && <div className="ed-tl">{timeline}</div>}

        {/* La hoja de abajo (vidrio) con sus pestañas: Claude, Timeline (los ajustes del clip) y Medios. */}
        <div className="ed-sheet" data-glass>
          <div className="ed-grab" onPointerDown={grabDown} onPointerUp={grabUp} onPointerCancel={() => { grab.current = null }}><i /></div>
          <div className="ed-tabs" role="tablist" data-glass>
            {tabs.map(([id, icon, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={`ed-tab ${tab === id ? 'on' : ''}`} data-glass={tab === id ? 'accent' : undefined} onClick={() => pickTab(id)}>
                <Icon name={icon} size={17} />{label}
                {id === 'claude' && (chat.waiting ? <span className="ed-dot warn" /> : chat.busy ? <span className="ed-dot busy" /> : unread ? <span className="ed-count">{unread}</span> : null)}
              </button>
            ))}
          </div>
          <div className="ed-pane" style={{ display: sheet === 'min' ? 'none' : undefined }}>
            <div className="ed-chat" style={{ display: tab === 'claude' ? 'flex' : 'none' }}>
              <ChatPanel projectId={projectId} visible={tab === 'claude' && sheet !== 'min'} context={() => ({ timeline: tlId, t: tRef.current })} onStatus={setChat} inject={inject} />
            </div>
            {tab === 'media' && <PhoneMedia projectId={projectId} assets={assets} onRefresh={refreshAssets} onAdd={addAssets} onAsk={askClaude} full={sheet === 'max'} />}
            {tab === 'timeline' && <div className="ed-montage">
              {sheet === 'max' && <div className="ed-montage-tl">{timeline}</div>}
              <PhoneInspector projectId={projectId} tlId={tlId} tl={tl} sel={sel} t={t} fps={fps} onSelect={setSel} onPatch={patchClip}
                onSplit={() => splitAt(tRef.current)} onDuplicate={dupSel} onDelete={delSel} />
            </div>}
          </div>
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
