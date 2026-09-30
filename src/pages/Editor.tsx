import { useCallback, useEffect, useRef, useState } from 'react'
import { Asset, call, Clip, fmtTime, on, Project, Timeline as TL, Track, TrackType, uid } from '../api'
import { useApp } from '../App'
import Stage, { StageHandle } from '../components/Stage'
import Timeline, { TYPE_COLOR, TYPE_ICON } from '../components/Timeline'
import MediaPanel from '../components/MediaPanel'
import ChatPanel, { ChatStatus } from '../components/ChatPanel'
import ExportDialog from '../components/ExportDialog'
import ExportAndroid from '../android/ui/ExportAndroid'
import ClaudeSide from '../android/ui/ClaudeSide'
import { useBack } from '../android/ui/back'
import { isAndroid, isTouch, recoveredBoot } from '../platform'
import SaveTemplate from '../components/SaveTemplate'
import Modal from '../components/Modal'
import { useDialogs } from '../components/Dialogs'
import { Icon, Logo } from '../ui/icons'
import { Badge, Button, Divider, Empty, Menu, MenuItem, NumberInput, Segmented, Select, Slider, Spinner, Switch, Tabs, TextArea, useMenu } from '../ui/kit'

const KIND_TRACK: Record<string, TrackType> = { scene: 'scene', video: 'video', image: 'video', audio: 'audio' }
const TRACK_NAME: Record<TrackType, string> = { scene: 'Escenas', video: 'Video', audio: 'Audio' }
const isImage = (src: string) => /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(src)

export default function Editor({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { toast, settings, updateSettings, go } = useApp()
  const ed = settings?.editor
  const [project, setProject] = useState<Project | null>(null)
  const [tlId, setTlId] = useState('')
  const [tl, setTl] = useState<TL | null>(null)
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState(1)
  const [loop, setLoop] = useState(false)
  const [sel, setSel] = useState<string[]>([])
  const [assets, setAssets] = useState<Asset[]>([])
  const [pps, setPps] = useState(() => settings?.editor.defaultZoom || 60)
  const [tlH, setTlH] = useState(() => Math.round(Math.min(320, Math.max(200, window.innerHeight * 0.34))))
  const [right, setRight] = useState<'ia' | 'inspector' | null>(() => (settings?.editor.showChat === false ? null : 'ia'))
  const [showExport, setShowExport] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [noteEdit, setNoteEdit] = useState<{ id?: string; t: number; text: string } | null>(null)
  const [audit, setAudit] = useState<{ running: boolean; res?: any } | null>(null)
  const [scale, setScale] = useState(0.5)
  const [full, setFull] = useState(false)
  const [fsIdle, setFsIdle] = useState(false)
  const [saveTpl, setSaveTpl] = useState(false)
  const viewerRef = useRef<HTMLDivElement>(null)
  const idleTimer = useRef<number>(0)
  const dlg = useDialogs()
  const stage = useRef<StageHandle>(null)
  const hist = useRef<{ past: TL[]; future: TL[] }>({ past: [], future: [] })
  const saveTimer = useRef<number>(0)
  const fitRef = useRef<(() => void) | null>(null)
  const tRef = useRef(0); tRef.current = t
  const tlRef = useRef<TL | null>(null); tlRef.current = tl
  const addMenu = useMenu()
  const tlMenuM = useMenu()
  // ── tablet: pestañas Editor / Claude y paneles que se deslizan ────────────
  const touch = isTouch(), android = isAndroid()
  // Tras un reinicio de la página (Android), se vuelve a la misma pestaña.
  const [tab, setTab] = useState<'edit' | 'claude'>(() => { try { return recoveredBoot && localStorage.getItem('oa.editorTab') === 'claude' ? 'claude' : 'edit' } catch { return 'edit' } })
  useEffect(() => { try { localStorage.setItem('oa.editorTab', tab) } catch { /* sin almacenamiento */ } }, [tab])
  const [drawer, setDrawer] = useState<'media' | 'props' | null>(null)
  const [chat, setChat] = useState<ChatStatus>({ busy: false, waiting: false, assistant: 0 })
  const [seen, setSeen] = useState(0)
  const [inject, setInject] = useState<{ text: string; n: number } | null>(null)
  const projMenu = useMenu()
  const moreMenu = useMenu()
  useEffect(() => { if (tab === 'claude') setSeen(chat.assistant) }, [tab, chat.assistant])
  // El visor se desmonta en la pestaña de Claude: la reproducción se detiene.
  useEffect(() => { if (tab === 'claude') setPlaying(false) }, [tab])
  const unread = tab === 'claude' ? 0 : Math.max(0, chat.assistant - seen)
  const askClaude = (text: string) => { setTab('claude'); setInject({ text, n: Date.now() }) }
  const fittedTl = useRef(false)
  useEffect(() => {
    if (!touch || !tl || fittedTl.current) return
    fittedTl.current = true
    const want = 18 + 36 + tl.tracks.length * 64 + 14 // agarradera + regla + pistas (tamaños táctiles) + margen
    setTlH(Math.round(Math.min(window.innerHeight * 0.45, Math.max(tlH, want))))
  }, [tl])
  useBack(() => {
    if (full) { setFull(false); return true }
    if (drawer) { setDrawer(null); return true }
    if (tab === 'claude') { setTab('edit'); return true }
    onClose(); return true
  }, touch)

  // ── carga ─────────────────────────────────────────────────────────────────
  const loadTimeline = useCallback(async (id: string) => {
    const x = await call<TL>('timeline:get', projectId, id)
    setTl(x); hist.current = { past: [], future: [] }
  }, [projectId])
  const refreshAssets = useCallback(() => call<Asset[]>('assets:list', projectId).then(setAssets).catch(() => {}), [projectId])

  useEffect(() => {
    call<Project>('project:open', projectId).then(async (p) => { setProject(p); setTlId(p.activeTimeline); await loadTimeline(p.activeTimeline) }).catch((e) => { toast(e.message, true); onClose() })
    refreshAssets()
    return () => { call('project:close', projectId) }
  }, [projectId])

  // Cambios de archivos (Claude guarda la escena, el timeline, un audio…): llegan en ráfagas, así que se
  // juntan y se recarga una sola vez cuando paran (antes cada archivo recargaba la escena entera).
  const changes = useRef<{ project?: boolean; timeline?: boolean; assets?: boolean; timer?: number }>({})
  useEffect(() => on('project:changed', (e: { id: string; kind: string; file: string }) => {
    if (e.id !== projectId) return
    const q = changes.current
    if (e.kind === 'project') q.project = true
    else if (e.kind === 'timeline') {
      const ref = project?.timelines.find((x) => x.id === tlId)
      if (ref && e.file === ref.file.replace(/\\/g, '/')) q.timeline = true
    } else q.assets = true
    window.clearTimeout(q.timer)
    q.timer = window.setTimeout(async () => {
      const { project: pj, timeline, assets } = changes.current
      changes.current = {}
      try {
        if (pj) setProject(await call<Project>('project:get', projectId))
        if (timeline) setTl(await call<TL>('timeline:get', projectId, tlId))
      } catch (err: any) { toast(err.message, true) }
      if (assets) refreshAssets()
      if (timeline || assets) stage.current?.reload()
    }, 400)
  }), [projectId, project, tlId])
  useEffect(() => () => window.clearTimeout(changes.current.timer), [])

  // ── edición con deshacer ──────────────────────────────────────────────────
  const persist = (next: TL) => {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => { call('timeline:save', projectId, tlId, next).then(() => stage.current?.reload()).catch((e) => toast(e.message, true)) }, 250)
  }
  const dragBase = useRef<TL | null>(null)
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
      const b: Clip = { ...c, id: uid('c'), start: time, duration: c.duration - a, in: (c.in || 0) + a, fadeIn: 0 }
      c.duration = a; c.fadeOut = 0
      tr.clips.push(b)
    }
  })
  const delSel = (ripple = false) => mutate((d) => {
    for (const tr of d.tracks) {
      const removed = tr.clips.filter((c) => sel.includes(c.id))
      tr.clips = tr.clips.filter((c) => !sel.includes(c.id))
      if (ripple) for (const r of removed.sort((a, b) => b.start - a.start)) tr.clips.forEach((c) => { if (c.start >= r.start + r.duration - 1e-6) c.start -= r.duration })
    }
    setSel([])
  })
  const dupSel = () => mutate((d) => {
    const nsel: string[] = []
    for (const tr of d.tracks) for (const c of [...tr.clips]) if (sel.includes(c.id)) {
      const end = Math.max(...tr.clips.map((x) => x.start + x.duration))
      const n = { ...c, id: uid('c'), start: end }; tr.clips.push(n); nsel.push(n.id)
    }
    setSel(nsel)
  })
  /** Pista nueva; el nombre define el rol y el color de las de audio (Voz, Música, SFX: ver trackRole). */
  const addTrack = (type: TrackType, base = TRACK_NAME[type]) => mutate((d) => {
    const taken = new Set(d.tracks.map((x) => x.name))
    let name = base, n = 2
    while (taken.has(name)) name = `${base} ${n++}`
    const tr: Track = { id: uid('t'), name, type, clips: [] }
    if (type === 'audio') d.tracks.push(tr)
    else { const i = d.tracks.findIndex((x) => x.type === 'audio'); d.tracks.splice(i < 0 ? d.tracks.length : i, 0, tr) }
  })

  const addAsset = async (a: Asset, trackId: string | null, time: number) => {
    if (!tl) return
    const type = KIND_TRACK[a.kind]
    if (!type) return
    let dur = a.kind === 'image' ? (settings?.editor.imageDuration || 5) : 5, srcDur: number | undefined
    try {
      if (a.kind === 'scene') { const r = await stage.current!.probe(a.path); dur = r.duration || 10 }
      else if (a.kind === 'audio' || a.kind === 'video') { const r = await call('media:probe', projectId, a.path); if (r.duration) { dur = r.duration; srcDur = r.duration } }
    } catch { /* duración por defecto */ }
    mutate((d) => {
      let tr = d.tracks.find((x) => x.id === trackId)
      if (!tr || tr.type !== type) tr = d.tracks.find((x) => x.type === type)
      if (!tr) { tr = { id: uid('t'), name: TRACK_NAME[type], type, clips: [] }; if (type === 'audio') d.tracks.push(tr); else d.tracks.unshift(tr) }
      const c: any = { id: uid('c'), src: a.path, start: +time.toFixed(3), duration: +dur.toFixed(3), in: 0 }
      if (srcDur) c.srcDur = srcDur
      tr.clips.push(c)
      setSel([c.id])
    })
  }

  // ── reproducción ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!playing || !tl) return
    let raf = 0, last = performance.now()
    const tick = (now: number) => {
      // Chromium corre sin límite de cuadros (acelera la exportación): la vista previa se limita a ~60 Hz.
      if (now - last < 15) { raf = requestAnimationFrame(tick); return }
      const dt = ((now - last) / 1000) * rate
      last = now
      let nt = tRef.current + dt
      if (nt >= tl.duration) { if (loop) nt = 0; else { setT(tl.duration); setPlaying(false); return } }
      setT(nt)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, rate, loop, tl?.duration])

  const fps = project?.fps || 30
  const seek = (x: number) => { setT(Math.max(0, Math.min(tl?.duration || 0, x))) }
  const toggleSnap = () => updateSettings({ editor: { snap: !ed?.snap } })
  const toggleRight = (tab: 'ia' | 'inspector') => setRight((r) => (r === tab ? null : tab))

  // ── pantalla completa ─────────────────────────────────────────────────────
  const toggleFull = () => {
    if (touch) { setFull((f) => !f); return }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    else viewerRef.current?.requestFullscreen().catch((e) => toast('No se pudo pasar a pantalla completa: ' + e.message, true))
  }
  useEffect(() => {
    const f = () => { const on = document.fullscreenElement === viewerRef.current; setFull(on); setFsIdle(false) }
    document.addEventListener('fullscreenchange', f)
    return () => document.removeEventListener('fullscreenchange', f)
  }, [])
  const wake = () => {
    setFsIdle(false)
    window.clearTimeout(idleTimer.current)
    idleTimer.current = window.setTimeout(() => setFsIdle(true), 2200)
  }
  useEffect(() => { if (full) wake() }, [full])

  // ── teclado ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (touch && tab === 'claude' && !(e.ctrlKey && (e.key === 'j' || e.key === 'J'))) return
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || showExport || noteEdit || menu || saveTpl || document.querySelector('.modal, .menu')) return
      if (full) wake()
      const f = 1 / fps
      if (e.code === 'Space') { e.preventDefault(); setPlaying((p) => !p) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(tRef.current - (e.shiftKey ? 1 : f)) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); seek(tRef.current + (e.shiftKey ? 1 : f)) }
      else if (e.key === 'Home') seek(0)
      else if (e.key === 'End') seek(tl?.duration || 0)
      else if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? redo() : undo() }
      else if (e.ctrlKey && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo() }
      else if (e.ctrlKey && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); dupSel() }
      else if (e.ctrlKey && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); setShowExport(true) }
      else if (e.ctrlKey && (e.key === 'j' || e.key === 'J')) { e.preventDefault(); if (touch) setTab((x) => (x === 'claude' ? 'edit' : 'claude')); else toggleRight('ia') }
      else if (e.ctrlKey && e.key === ',') { e.preventDefault(); go({ page: 'settings', from: { page: 'editor', id: projectId } }) }
      else if (e.ctrlKey || e.altKey) return
      else if (e.key === 's' || e.key === 'S') splitAt(tRef.current)
      else if (e.key === 'Delete' || e.key === 'Backspace') { if (sel.length) delSel(e.shiftKey) }
      else if (e.key === 'n' || e.key === 'N') setNoteEdit({ t: tRef.current, text: '' })
      else if (e.key === 'l' || e.key === 'L') setLoop((x) => !x)
      else if (e.key === 'm' || e.key === 'M') toggleSnap()
      else if (e.key === 'f' || e.key === 'F') toggleFull()
      else if ((e.key === 'z' || e.key === 'Z') && e.shiftKey) fitRef.current?.()
      else if (e.key === 'Escape') setSel([])
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  // ── timelines ─────────────────────────────────────────────────────────────
  const curName = project?.timelines.find((z) => z.id === tlId)?.name || ''
  const switchTl = async (id: string) => {
    if (id === '__new') {
      const name = await dlg.prompt({ title: 'Nuevo timeline', label: 'Nombre', value: `Timeline ${(project?.timelines.length || 0) + 1}`, ok: 'Crear', icon: 'plus', subtitle: 'Cada timeline es una pieza independiente (por ejemplo, un capítulo).' })
      if (!name) return
      const p = await call<Project>('timelines:create', projectId, name)
      setProject(p); setTlId(p.activeTimeline); await loadTimeline(p.activeTimeline); setT(0); return
    }
    const p = await call<Project>('timelines:setActive', projectId, id)
    setProject(p); setTlId(id); setSel([]); setT(0); setPlaying(false); await loadTimeline(id)
  }
  const tlItems: MenuItem[] = [
    { label: 'Nuevo timeline…', icon: 'plus', onSelect: () => switchTl('__new') },
    { label: 'Renombrar…', icon: 'edit', onSelect: async () => { const n = await dlg.prompt({ title: 'Renombrar timeline', label: 'Nombre', value: curName, ok: 'Renombrar' }); if (n) setProject(await call('timelines:rename', projectId, tlId, n)) } },
    { label: 'Duplicar', icon: 'copy', onSelect: async () => { const p = await call<Project>('timelines:create', projectId, curName + ' (copia)', tlId); setProject(p); setTlId(p.activeTimeline); await loadTimeline(p.activeTimeline) } },
    { sep: true },
    { label: 'Mover arriba', icon: 'chevron-up', onSelect: async () => setProject(await call('timelines:move', projectId, tlId, -1)) },
    { label: 'Mover abajo', icon: 'chevron-down', onSelect: async () => setProject(await call('timelines:move', projectId, tlId, 1)) },
    { sep: true },
    { label: 'Borrar timeline', icon: 'trash', danger: true, disabled: (project?.timelines.length || 0) < 2, onSelect: async () => {
      if (!(await dlg.confirm({ title: `¿Borrar «${curName}»?`, message: 'Se borra el timeline (los archivos de escenas y medios no se tocan).', ok: 'Borrar', danger: true }))) return
      try { const p = await call<Project>('timelines:delete', projectId, tlId); setProject(p); setTlId(p.activeTimeline); await loadTimeline(p.activeTimeline) } catch (e: any) { toast(e.message, true) }
    } },
  ]
  const renameProject = async () => {
    const n = await dlg.prompt({ title: 'Renombrar proyecto', label: 'Nombre', value: project?.name, ok: 'Renombrar' })
    if (n) { await call('projects:rename', projectId, n); setProject(await call('project:get', projectId)) }
  }

  const clipMenu = (c: Clip, tr: Track, x: number, y: number) => setMenu({ x, y, items: [
    { label: 'Cortar en el cursor', icon: 'scissors', kbd: 'S', onSelect: () => splitAt(tRef.current) },
    { label: 'Duplicar', icon: 'copy', kbd: 'Ctrl+D', onSelect: dupSel },
    { label: 'Propiedades', icon: 'sliders', onSelect: () => (touch ? setDrawer('props') : setRight('inspector')) },
    { label: 'Ir al inicio del clip', icon: 'skip-back', onSelect: () => seek(c.start) },
    android ? { label: 'Compartir archivo', icon: 'share', onSelect: () => call('assets:share', projectId, c.src) } : { label: 'Mostrar archivo', icon: 'folder-open', onSelect: () => call('project:reveal', projectId, c.src) },
    { sep: true },
    { label: 'Borrar', icon: 'trash', kbd: 'Supr', danger: true, onSelect: () => delSel(false) },
    { label: 'Borrar y cerrar hueco', icon: 'trash', kbd: 'Shift+Supr', danger: true, onSelect: () => delSel(true) },
  ] })
  const renameTrack = async (tr: Track) => { const n = await dlg.prompt({ title: 'Renombrar pista', label: 'Nombre', value: tr.name, ok: 'Renombrar' }); if (n) mutate((d) => { d.tracks.find((z) => z.id === tr.id)!.name = n }) }
  const trackMenu = (tr: Track, x: number, y: number) => setMenu({ x, y, items: [
    { label: 'Renombrar…', icon: 'edit', onSelect: () => renameTrack(tr) },
    { label: 'Subir', icon: 'chevron-up', onSelect: () => mutate((d) => { const i = d.tracks.findIndex((z) => z.id === tr.id); if (i > 0) { const [z] = d.tracks.splice(i, 1); d.tracks.splice(i - 1, 0, z) } }) },
    { label: 'Bajar', icon: 'chevron-down', onSelect: () => mutate((d) => { const i = d.tracks.findIndex((z) => z.id === tr.id); if (i < d.tracks.length - 1) { const [z] = d.tracks.splice(i, 1); d.tracks.splice(i + 1, 0, z) } }) },
    { sep: true },
    { label: 'Borrar pista', icon: 'trash', danger: true, onSelect: async () => {
      if (tr.clips.length && !(await dlg.confirm({ title: `¿Borrar la pista «${tr.name}»?`, message: `Tiene ${tr.clips.length} clip(s).`, ok: 'Borrar', danger: true }))) return
      mutate((d) => { d.tracks = d.tracks.filter((z) => z.id !== tr.id) })
    } },
  ] })

  const runAudit = async () => {
    if (!tl) return
    setAudit({ running: true })
    try { setAudit({ running: false, res: await call('frames:audit', projectId, tlId, { step: 0.5 }) }) } catch (e: any) { setAudit(null); toast(e.message, true) }
  }
  const copyFrame = () => call('frames:copy', projectId, tlId, t).then(() => toast('Fotograma copiado al portapapeles')).catch((e) => toast(e.message, true))

  if (!project || !tl || !settings) return (
    <>
      <div className="titlebar"><Button variant="ghost" size="sm" icon="arrow-left" onClick={onClose} /><div className="brand"><Logo size={20} /></div></div>
      <div className="editor" style={{ display: 'grid', placeItems: 'center' }}><div className="row t3"><Spinner />Abriendo proyecto…</div></div>
    </>
  )

  const selClip = sel.length === 1 ? findClip(tl, sel[0]) : null
  const cols = `272px minmax(0,1fr) ${right ? '392px' : '0px'}`
  const inspector = selClip
    ? <Inspector clip={selClip.c} track={selClip.tr} fps={fps} projectId={projectId} onSeek={seek} onChange={(patch) => mutate((d) => Object.assign(findClip(d, selClip.c.id)!.c, patch))} />
    : <div className="pane-body" style={{ display: 'grid', placeItems: 'center' }}><Empty compact icon="cursor" title={sel.length > 1 ? `${sel.length} clips seleccionados` : 'Nada seleccionado'} desc={touch ? 'Tocá un clip del timeline para ver y editar sus propiedades.' : 'Seleccioná un clip del timeline para ver y editar sus propiedades.'} /></div>

  // ── tablet: barra superior con pestañas Editor / Claude ───────────────────
  const shareFrame = () => call('frames:share', projectId, tlId, t).catch((e) => toast(e.message, true))
  const shareProject = () => { toast('Preparando el proyecto…', 'info'); call('projects:exportZip', projectId, { action: 'share' }).catch((e) => toast(e.message, true)) }
  const projItems: MenuItem[] = [
    { header: `Timelines · ${project.timelines.length}` },
    ...project.timelines.map((x) => ({ label: x.name, icon: 'layers', checked: x.id === tlId, onSelect: () => { if (x.id !== tlId) switchTl(x.id) } })),
    ...tlItems,
    { sep: true },
    { label: 'Renombrar proyecto…', icon: 'edit', onSelect: renameProject },
  ]
  const moreItems: MenuItem[] = [
    { label: 'Auditar layout', icon: 'scan', desc: 'Textos superpuestos o fuera de cuadro', onSelect: runAudit },
    { label: 'Nota para la IA en el cursor', icon: 'note', onSelect: () => setNoteEdit({ t, text: '' }) },
    { sep: true },
    { label: 'Compartir fotograma', icon: 'share', onSelect: shareFrame },
    { label: 'Copiar fotograma', icon: 'copy', onSelect: copyFrame },
    { label: 'Recargar vista previa', icon: 'refresh', onSelect: () => setReloadKey((k) => k + 1) },
    { sep: true },
    { label: 'Compartir proyecto (.zip)', icon: 'upload', desc: 'Para abrirlo en la PC o en otra tablet', onSelect: shareProject },
    { label: 'Guardar como plantilla…', icon: 'bookmark', onSelect: () => setSaveTpl(true) },
    { sep: true },
    { label: 'Ajustes', icon: 'settings', onSelect: () => go({ page: 'settings', from: { page: 'editor', id: projectId } }) },
  ]
  const claudeBadge = tab === 'claude' ? null : chat.waiting ? <span className="tb-tab-dot wait" /> : unread ? <span className="tb-tab-count">{unread}</span> : chat.busy ? <span className="tb-tab-dot busy" /> : null
  const titlebar = touch ? (
    <div className="titlebar tb-touch">
      <Button variant="ghost" icon="arrow-left" tip="Proyectos" onClick={onClose} />
      <button className="tb-project" onClick={projMenu.open}>
        <Logo size={28} />
        <span className="tb-project-txt"><span className="tb-project-name ellipsis">{project.name}</span><span className="tb-project-sub">{curName} · {project.width}×{project.height} · {project.fps} fps</span></span>
        <Icon name="chevron-down" size={16} className="t3" />
      </button>
      {projMenu.render(projItems, { width: 320 })}
      <div className="tb-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'edit'} className={`tb-tab ${tab === 'edit' ? 'on' : ''}`} onClick={() => setTab('edit')}><Icon name="film" size={18} /><span className="tb-tab-label">Editor</span></button>
        <button type="button" role="tab" aria-selected={tab === 'claude'} className={`tb-tab claude ${tab === 'claude' ? 'on' : ''}`} onClick={() => setTab('claude')}><Icon name="sparkles" size={18} /><span className="tb-tab-label">Claude</span>{claudeBadge}</button>
      </div>
      <div className="grow" />
      <Button variant="ghost" icon="undo" tip="Deshacer" onClick={undo} disabled={!hist.current.past.length} />
      <Button variant="ghost" icon="redo" tip="Rehacer" onClick={redo} disabled={!hist.current.future.length} />
      <Button variant="ghost" icon="more" tip="Más opciones" active={moreMenu.isOpen} onClick={moreMenu.open} />
      {moreMenu.render(moreItems, { align: 'end', width: 330 })}
      <Button variant="primary" icon="export" onClick={() => setShowExport(true)}>Exportar</Button>
    </div>
  ) : (
      <div className="titlebar">
        <Button variant="ghost" size="sm" icon="arrow-left" tip="Proyectos" onClick={onClose} />
        <Logo size={20} />
        <div className="crumbs">
          <button className="b b-ghost b-sm" style={{ fontWeight: 600, color: 'var(--t1)', maxWidth: 260 }} onClick={renameProject} data-tip="Renombrar proyecto"><span className="ellipsis">{project.name}</span></button>
          <Icon name="chevron-right" size={13} className="crumb-sep" />
          <Select size="sm" variant="ghost" value={tlId} width={220} menuWidth={280} icon="layers" tip="Timeline activo"
            onChange={(v) => switchTl(String(v))}
            options={[{ header: `Timelines · ${project.timelines.length}` }, ...project.timelines.map((x) => ({ value: x.id, label: x.name })), { sep: true }, { value: '__new', label: 'Nuevo timeline…', icon: 'plus' }]} />
          <Button size="sm" variant="ghost" icon="more" tip="Opciones del timeline" onClick={tlMenuM.open} />
          {tlMenuM.render(tlItems)}
        </div>
        <Badge>{project.width}×{project.height} · {project.fps} fps</Badge>
        <div className="grow" />
        <Button size="sm" variant="ghost" icon="undo" tip="Deshacer" kbd="Ctrl+Z" onClick={undo} disabled={!hist.current.past.length} />
        <Button size="sm" variant="ghost" icon="redo" tip="Rehacer" kbd="Ctrl+Y" onClick={redo} disabled={!hist.current.future.length} />
        <Divider vertical />
        <Button size="sm" variant="ghost" icon="scan" tip="Auditar layout: textos superpuestos o fuera de cuadro" onClick={runAudit} loading={audit?.running} />
        <Button size="sm" variant="ghost" icon="folder-open" tip="Abrir la carpeta del proyecto" onClick={() => call('projects:openFolder', projectId)} />
        <Button size="sm" variant="ghost" icon="bookmark" tip="Guardar como plantilla" onClick={() => setSaveTpl(true)} />
        <Button size="sm" variant="ghost" icon="settings" tip="Ajustes" kbd="Ctrl+," onClick={() => go({ page: 'settings', from: { page: 'editor', id: projectId } })} />
        <Divider vertical />
        <Button size="sm" variant="ghost" icon="sparkles" active={right === 'ia'} tip="Claude" kbd="Ctrl+J" onClick={() => toggleRight('ia')}>IA</Button>
        <Button size="sm" variant="primary" icon="export" kbd="Ctrl+E" tip="Exportar video" onClick={() => setShowExport(true)}>Exportar</Button>
      </div>
  )

  const body = (
      <div className="editor" onClick={() => menu && setMenu(null)}>
        <div className={`ed-work ${touch ? 'touch' : ''}`} style={touch ? undefined : { gridTemplateColumns: cols }}>
          {!touch && <MediaPanel projectId={projectId} assets={assets} onRefresh={refreshAssets} onAdd={(a) => addAsset(a, null, tRef.current)} />}

          <div className={`viewer ${full ? 'is-full' : ''} ${full && fsIdle && playing ? 'idle' : ''}`} ref={viewerRef} onMouseMove={full ? wake : undefined} onPointerDown={full ? wake : undefined}>
            <div className="viewer-bar">
              {touch ? <>
                <Button size="sm" variant="ghost" icon="folder" active={drawer === 'media'} tip="Medios del proyecto" onClick={() => setDrawer(drawer === 'media' ? null : 'media')}><span className="vb-btn-label">Medios</span></Button>
                <Button size="sm" variant="ghost" icon="sliders" active={drawer === 'props'} disabled={!sel.length && drawer !== 'props'} tip="Propiedades del clip" onClick={() => setDrawer(drawer === 'props' ? null : 'props')}><span className="vb-btn-label">Propiedades</span></Button>
                <div className="grow" />
                <span className="t3 tabnum" style={{ fontSize: 13, padding: '0 6px' }}>{Math.round(scale * 100)} %</span>
                <Divider vertical />
                <Button size="sm" variant="ghost" icon="safe-area" active={ed!.safeAreas} tip="Zonas seguras" onClick={() => updateSettings({ editor: { safeAreas: !ed!.safeAreas } })} />
                <Button size="sm" variant="ghost" icon="thirds" active={ed!.thirds} tip="Guía de tercios" onClick={() => updateSettings({ editor: { thirds: !ed!.thirds } })} />
                <Button size="sm" variant="ghost" icon="note" tip="Nota para la IA en este instante" onClick={() => setNoteEdit({ t, text: '' })} />
                <Button size="sm" variant="ghost" icon="maximize" tip="Pantalla completa" onClick={toggleFull} />
              </> : <>
              <span className="caps" style={{ padding: '0 6px' }}>Visor</span>
              <span className="t3 tabnum" style={{ fontSize: 11.5 }}>{Math.round(scale * 100)} %</span>
              <div className="grow" />
              <Button size="sm" variant="ghost" icon="safe-area" active={ed!.safeAreas} tip="Zonas seguras" onClick={() => updateSettings({ editor: { safeAreas: !ed!.safeAreas } })} />
              <Button size="sm" variant="ghost" icon="thirds" active={ed!.thirds} tip="Guía de tercios" onClick={() => updateSettings({ editor: { thirds: !ed!.thirds } })} />
              <Select size="sm" variant="ghost" value={ed!.stageBg} tip="Fondo del visor" icon="palette" onChange={(v) => updateSettings({ editor: { stageBg: v as any } })}
                options={[{ value: 'dark', label: 'Oscuro' }, { value: 'black', label: 'Negro' }, { value: 'gray', label: 'Gris' }, { value: 'checker', label: 'Damero' }]} />
              <Divider vertical />
              <Button size="sm" variant="ghost" icon="note" tip="Nota para la IA en este instante" kbd="N" onClick={() => setNoteEdit({ t, text: '' })} />
              <Button size="sm" variant="ghost" icon="copy" tip="Copiar fotograma" onClick={copyFrame} />
              <Button size="sm" variant="ghost" icon="refresh" tip="Recargar vista previa" onClick={() => setReloadKey((k) => k + 1)} />
              <Button size="sm" variant="ghost" icon="maximize" tip="Pantalla completa" kbd="F" onClick={toggleFull} />
              </>}
            </div>
            {/* En la tablet, con la pestaña de Claude al frente el visor no se ve: se desmonta para no tener otra
                copia viva de la escena mientras Claude trabaja (con escenas pesadas la memoria no alcanzaba). */}
            {!touch || tab === 'edit' ? <Stage ref={stage} projectId={projectId} tlId={tlId} t={t} playing={playing} rate={rate} width={project.width} height={project.height} reloadKey={reloadKey}
              onError={(m) => toast(m, true)} bg={full ? 'black' : ed!.stageBg} safeAreas={!full && ed!.safeAreas} thirds={!full && ed!.thirds} onScale={setScale} pad={full ? 0 : 20} />
              : <div className="stage-wrap" />}
            {full && (
              <div className="fs-bar" onMouseMove={(e) => e.stopPropagation()} onMouseEnter={() => { window.clearTimeout(idleTimer.current); setFsIdle(false) }} onMouseLeave={wake}>
                <input type="range" className="fs-scrub" min={0} max={tl.duration} step={1 / fps} value={t} style={{ ['--pct' as any]: `${(t / Math.max(0.001, tl.duration)) * 100}%` }}
                  onChange={(e) => seek(+e.target.value)} onKeyDown={(e) => e.preventDefault()} />
                <div className="fs-row">
                  <Button variant="ghost" icon="skip-back" tip="Inicio" onClick={() => seek(0)} />
                  <Button variant="primary" className="play-btn" icon={playing ? 'pause' : 'play'} tip={playing ? 'Pausa' : 'Reproducir'} kbd="Espacio" onClick={() => setPlaying((p) => !p)} />
                  <Button variant="ghost" icon="skip-fwd" tip="Final" onClick={() => seek(tl.duration)} />
                  <span className="timecode">{fmtTime(t, true, fps)}<span className="t3"> / {fmtTime(tl.duration, true, fps)}</span></span>
                  <div className="grow" />
                  <span className="fs-title ellipsis">{project.name}</span>
                  <div className="grow" />
                  <Button size="sm" variant="ghost" icon="repeat" active={loop} tip="Repetir" kbd="L" onClick={() => setLoop((x) => !x)} />
                  <Select size="sm" variant="ghost" value={rate} tip="Velocidad" placement="top" onChange={(v) => setRate(+v)} options={[0.25, 0.5, 1, 1.5, 2].map((r) => ({ value: r, label: `${r}×` }))} />
                  <Button variant="ghost" icon="minimize" tip="Salir de pantalla completa" kbd="Esc" onClick={toggleFull} />
                </div>
              </div>
            )}
            <div className="transport">
              <div className="transport-l">
                <span className="timecode">{fmtTime(t, true, fps)}<span className="t3"> / {fmtTime(tl.duration, true, fps)}</span></span>
              </div>
              <div className="transport-c">
                <Button variant="ghost" icon="skip-back" tip="Inicio" kbd="Inicio" onClick={() => seek(0)} />
                <Button variant="ghost" icon="step-back" tip="Fotograma anterior" kbd="←" onClick={() => seek(t - 1 / fps)} />
                <Button variant="primary" className="play-btn" icon={playing ? 'pause' : 'play'} tip={playing ? 'Pausa' : 'Reproducir'} kbd="Espacio" onClick={() => setPlaying((p) => !p)} />
                <Button variant="ghost" icon="step-fwd" tip="Fotograma siguiente" kbd="→" onClick={() => seek(t + 1 / fps)} />
                <Button variant="ghost" icon="skip-fwd" tip="Final" kbd="Fin" onClick={() => seek(tl.duration)} />
              </div>
              <div className="transport-r">
                <Button size="sm" variant="ghost" icon="repeat" active={loop} tip="Repetir" kbd="L" onClick={() => setLoop((x) => !x)} />
                <Select size="sm" variant="ghost" value={rate} tip="Velocidad" onChange={(v) => setRate(+v)} options={[0.25, 0.5, 1, 1.5, 2].map((r) => ({ value: r, label: `${r}×` }))} />
              </div>
            </div>
          </div>

          {!touch && (
          <div className="pane pane-right" style={{ display: right ? 'flex' : 'none' }}>
            <div className="pane-head" style={{ padding: '0 6px 0 4px', height: 40 }}>
              <Tabs size="sm" value={right || 'ia'} onChange={(v) => setRight(v)} tabs={[{ value: 'ia', label: 'Claude', icon: 'sparkles' }, { value: 'inspector', label: 'Propiedades', icon: 'sliders', count: sel.length || undefined }]} />
              <div className="grow" />
              <Button size="xs" variant="ghost" icon="x" tip="Cerrar panel" onClick={() => setRight(null)} />
            </div>
            <ChatPanel projectId={projectId} visible={right === 'ia'} context={() => ({ timeline: tlId, t: tRef.current })} />
            {right === 'inspector' && (selClip
              ? <Inspector clip={selClip.c} track={selClip.tr} fps={fps} projectId={projectId} onSeek={seek} onChange={(patch) => mutate((d) => Object.assign(findClip(d, selClip.c.id)!.c, patch))} />
              : <div className="pane-body" style={{ display: 'grid', placeItems: 'center' }}><Empty compact icon="cursor" title={sel.length > 1 ? `${sel.length} clips seleccionados` : 'Nada seleccionado'} desc="Seleccioná un clip del timeline para ver y editar sus propiedades." /></div>)}
          </div>
          )}
          {touch && <>
            <div className={`drawer left ${drawer === 'media' ? 'open' : ''}`}>
              <MediaPanel projectId={projectId} assets={assets} onRefresh={refreshAssets} onClose={() => setDrawer(null)}
                onAdd={(a) => { addAsset(a, null, tRef.current); toast(`«${a.name}» agregado en ${fmtTime(tRef.current, true, fps)}`, 'info') }} />
            </div>
            <div className={`drawer right ${drawer === 'props' ? 'open' : ''}`}>
              <div className="drawer-head"><div className="drawer-title"><Icon name="sliders" size={18} />Propiedades</div><div className="grow" /><Button variant="ghost" icon="x" tip="Cerrar" onClick={() => setDrawer(null)} /></div>
              {inspector}
            </div>
          </>}
        </div>

        <div className="tl-wrap">
          <div className="tl-bar">
            <Button size="sm" variant="ghost" icon="plus" iconRight="chevron-down" onClick={addMenu.open}>Pista</Button>
            {addMenu.render([
              { label: 'Pista de escenas', icon: 'code', iconColor: TYPE_COLOR.scene, desc: 'HTML/SVG animado', onSelect: () => addTrack('scene') },
              { label: 'Pista de video', icon: 'video', iconColor: TYPE_COLOR.video, desc: 'Videos e imágenes', onSelect: () => addTrack('video') },
              { sep: true },
              { label: 'Pista de voz', icon: 'mic', iconColor: TYPE_COLOR.voice, desc: 'Narración y diálogos', onSelect: () => addTrack('audio', 'Voz') },
              { label: 'Pista de música', icon: 'music', iconColor: TYPE_COLOR.music, desc: 'Música de fondo', onSelect: () => addTrack('audio', 'Música') },
              { label: 'Pista de efectos (SFX)', icon: 'wave', iconColor: TYPE_COLOR.sfx, desc: 'Golpes, whooshes, ambiente', onSelect: () => addTrack('audio', 'SFX') },
              { label: 'Otra pista de audio', icon: 'volume', iconColor: TYPE_COLOR.audio, onSelect: () => addTrack('audio') },
            ], { width: 270 })}
            <Divider vertical />
            <Button size="sm" variant="ghost" icon="scissors" tip="Cortar en el cursor" kbd="S" onClick={() => splitAt(t)} />
            <Button size="sm" variant="ghost" icon="copy" tip="Duplicar" kbd="Ctrl+D" onClick={dupSel} disabled={!sel.length} />
            <Button size="sm" variant="ghost" icon="trash" tip="Borrar" kbd="Supr" onClick={() => delSel(false)} disabled={!sel.length} />
            <Divider vertical />
            <Button size="sm" variant="ghost" icon="magnet" active={ed!.snap} tip={ed!.snap ? 'Imán activado' : 'Imán desactivado'} kbd="M" onClick={toggleSnap} />
            <Button size="sm" variant="ghost" icon="note" tip="Agregar nota para la IA" kbd="N" onClick={() => setNoteEdit({ t, text: '' })} />
            {(tl.notes?.length || 0) > 0 && <Badge tone="warn" icon="message" tip="Notas para la IA en este timeline">{tl.notes!.length}</Badge>}
            <div className="grow" />
            <span className="t3" style={{ fontSize: 12 }}>Duración</span>
            <NumberInput size="sm" width={104} value={+tl.duration.toFixed(2)} step={1} min={0.1} decimals={2} suffix="s" onChange={(v) => change({ ...tl, duration: Math.max(0.1, v) })} />
            <Divider vertical />
            <Button size="sm" variant="ghost" icon="zoom-out" tip="Alejar" onClick={() => setPps((p) => Math.max(2, p / 1.4))} />
            <Slider value={Math.log(pps)} min={Math.log(2)} max={Math.log(600)} step={0.01} width={110} onChange={(v) => setPps(Math.exp(v))} tip="Zoom (Ctrl + rueda)" />
            <Button size="sm" variant="ghost" icon="zoom-in" tip="Acercar" onClick={() => setPps((p) => Math.min(600, p * 1.4))} />
            <Button size="sm" variant="ghost" icon="fit" tip="Ajustar a la ventana" kbd="Shift+Z" onClick={() => fitRef.current?.()} />
          </div>
          <Timeline projectId={projectId} tl={tl} t={t} fps={fps} playing={playing} pps={pps} setPps={setPps} selected={sel} setSelected={setSel}
            onSeek={(x) => { setPlaying(false); seek(x) }} onChange={change} onDropAsset={addAsset}
            onClipMenu={clipMenu} onTrackMenu={trackMenu} onRenameTrack={renameTrack}
            onClipOpen={touch ? () => setDrawer('props') : undefined}
            onNote={(id) => { const n = tl.notes?.find((z) => z.id === id); if (n) { seek(n.t); setNoteEdit({ ...n }) } }}
            height={tlH} setHeight={setTlH} fitRef={fitRef}
            snapOn={ed!.snap} snapFrames={ed!.snapFrames} followPlayhead={ed!.followPlayhead} waveforms={ed!.waveforms} />
        </div>
      </div>
  )

  return (
    <>
      {titlebar}
      {touch ? (
        <div className="editor-shell">
          {body}
          <div className="claude-view" style={{ display: tab === 'claude' ? 'flex' : 'none' }}>
            <div className="claude-main">
              <ChatPanel projectId={projectId} visible={tab === 'claude'} context={() => ({ timeline: tlId, t: tRef.current })} onStatus={setChat} inject={inject} />
            </div>
            <ClaudeSide projectId={projectId} tlId={tlId} tl={tl} t={t} fps={fps} visible={tab === 'claude'} busy={chat.busy} onGoEditor={() => setTab('edit')} onAsk={askClaude} />
          </div>
          {tab === 'edit' && chat.waiting && <div className="wait-banner"><Icon name="shield" size={18} /><span>Claude necesita tu permiso para seguir</span><Button size="sm" variant="primary" onClick={() => setTab('claude')}>Ver</Button></div>}
        </div>
      ) : body}

      {menu && <Menu anchor={{ x: menu.x, y: menu.y }} items={menu.items} onClose={() => setMenu(null)} />}
      {saveTpl && <SaveTemplate projectId={projectId} projectName={project.name} onClose={() => setSaveTpl(false)} />}
      {showExport && (android
        ? <ExportAndroid project={project} currentTl={tlId} onClose={() => setShowExport(false)} />
        : <ExportDialog project={project} currentTl={tlId} range={null} onClose={() => setShowExport(false)} />)}
      {noteEdit && <Modal icon="note" title="Nota para la IA" subtitle={`En ${fmtTime(noteEdit.t, true, fps)} · Claude la ve con oa_proyecto`} onClose={() => setNoteEdit(null)}
        footer={<>
          {noteEdit.id && <Button variant="danger" icon="trash" onClick={() => { mutate((d) => { d.notes = (d.notes || []).filter((z) => z.id !== noteEdit.id) }); setNoteEdit(null) }}>Borrar</Button>}
          <div className="grow" /><Button onClick={() => setNoteEdit(null)}>Cancelar</Button>
          <Button variant="primary" icon="check" onClick={() => { const txt = noteEdit.text.trim(); if (txt) mutate((d) => { d.notes ||= []; if (noteEdit.id) d.notes.find((z) => z.id === noteEdit.id)!.text = txt; else d.notes.push({ id: uid('n'), t: +noteEdit.t.toFixed(3), text: txt }) }); setNoteEdit(null) }}>Guardar nota</Button>
        </>}>
        <TextArea rows={4} value={noteEdit.text} onChange={(v) => setNoteEdit({ ...noteEdit, text: v })} placeholder="Ej.: acá el texto se superpone con el ícono; hacé la transición más lenta…" />
        <div className="t3" style={{ fontSize: 12, marginTop: 8 }}>Después pedile en el chat «resolvé mis notas».</div>
      </Modal>}
      {audit?.res && <Modal icon="scan" title="Auditoría de layout" subtitle={`${audit.res.issues.length} incidencia(s) · revisado cada ${audit.res.step} s`} onClose={() => setAudit(null)}
        footer={<><div className="grow" />{audit.res.issues.length > 0 && <Button icon="sparkles" onClick={() => { setAudit(null); if (touch) askClaude('Hacé una auditoría de layout y corregí todo lo que se superponga o salga de cuadro.'); else { setRight('ia'); toast('Pedile a Claude: «Hacé una auditoría de layout y corregí todo»', 'info') } }}>Arreglar con Claude</Button>}<Button variant="primary" onClick={() => setAudit(null)}>Listo</Button></>}>
        {!audit.res.issues.length
          ? <Empty compact icon="check-circle" title="Todo en orden" desc="No hay textos superpuestos ni fuera de cuadro." />
          : <div className="col" style={{ gap: 2 }}>{audit.res.issues.map((i: any, k: number) => (
            <div key={k} className="audit-row" onClick={() => { seek(i.from); setAudit(null) }}>
              <Badge tone={i.kind === 'fuera-de-cuadro' ? 'warn' : 'err'}>{i.kind === 'fuera-de-cuadro' ? 'Fuera de cuadro' : 'Superpuesto'}</Badge>
              <span className="grow ellipsis">«{i.text}»</span><span className="mono t3" style={{ fontSize: 11.5 }}>{i.from}s – {i.to}s</span><Icon name="arrow-right" size={13} className="t3" />
            </div>))}</div>}
      </Modal>}
      {dlg.element}
    </>
  )
}

function Inspector({ clip, track, fps, projectId, onChange, onSeek }: { clip: Clip; track: Track; fps: number; projectId: string; onChange: (p: Partial<Clip>) => void; onSeek: (t: number) => void }) {
  const kind = track.type === 'video' && isImage(clip.src) ? 'image' : track.type
  const f = 1 / fps
  return (
    <div className="pane-body insp">
      <div className="insp-head">
        <span className="insp-kind" style={{ background: `color-mix(in srgb, ${TYPE_COLOR[kind]} 75%, #000)` }}><Icon name={TYPE_ICON[kind]} size={16} /></span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="ellipsis" style={{ fontWeight: 600 }}>{clip.name || clip.src.split('/').pop()}</div>
          <div className="t3 ellipsis mono" style={{ fontSize: 11 }}>{clip.src}</div>
        </div>
        {isAndroid()
          ? <Button size="sm" variant="ghost" icon="share" tip="Compartir archivo" onClick={() => call('assets:share', projectId, clip.src)} />
          : <Button size="sm" variant="ghost" icon="folder-open" tip="Mostrar archivo" onClick={() => call('project:reveal', projectId, clip.src)} />}
      </div>
      <div className="insp-sec">
        <div className="insp-sec-title caps">Tiempo</div>
        <div className="fields">
          <div className="field"><label className="field-label">Inicio</label><NumberInput value={clip.start} step={f} min={0} decimals={3} suffix="s" onChange={(v) => onChange({ start: v })} /></div>
          <div className="field"><label className="field-label">Duración</label><NumberInput value={clip.duration} step={f} min={f} decimals={3} suffix="s" onChange={(v) => onChange({ duration: v })} /></div>
          <div className="field"><label className="field-label">Desde (fuente)</label><NumberInput value={clip.in || 0} step={f} min={0} decimals={3} suffix="s" onChange={(v) => onChange({ in: v })} /></div>
          <div className="field"><label className="field-label">Fin</label><div className="input" style={{ color: 'var(--t2)' }}><span className="tabnum">{(clip.start + clip.duration).toFixed(3)}</span><span className="num-suffix">s</span></div></div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <Button size="sm" variant="subtle" icon="skip-back" onClick={() => onSeek(clip.start)}>Ir al inicio</Button>
          <Button size="sm" variant="subtle" icon="skip-fwd" onClick={() => onSeek(clip.start + clip.duration - f)}>Ir al final</Button>
        </div>
      </div>
      <div className="insp-sec">
        <div className="insp-sec-title caps">Fundidos</div>
        <div className="fields">
          <div className="field"><label className="field-label">Entrada</label><NumberInput value={clip.fadeIn || 0} step={0.1} min={0} decimals={2} suffix="s" onChange={(v) => onChange({ fadeIn: v })} /></div>
          <div className="field"><label className="field-label">Salida</label><NumberInput value={clip.fadeOut || 0} step={0.1} min={0} decimals={2} suffix="s" onChange={(v) => onChange({ fadeOut: v })} /></div>
        </div>
      </div>
      {track.type !== 'scene' && (
        <div className="insp-sec">
          <div className="insp-sec-title caps">Audio</div>
          <div className="field">
            <div className="row"><label className="field-label grow">Volumen</label><span className="t2 tabnum" style={{ fontSize: 12 }}>{Math.round((clip.volume ?? 1) * 100)} %</span></div>
            <Slider value={clip.volume ?? 1} min={0} max={2} step={0.01} onChange={(v) => onChange({ volume: +v.toFixed(2) })} />
          </div>
          <div className="row" style={{ marginTop: 12 }}><span className="grow">Silenciar clip</span><Switch checked={!!clip.muted} onChange={(v) => onChange({ muted: v })} /></div>
        </div>
      )}
      {track.type === 'video' && (
        <div className="insp-sec">
          <div className="insp-sec-title caps">Encuadre</div>
          <Segmented full value={clip.fit || 'contain'} onChange={(v) => onChange({ fit: v })} options={[{ value: 'contain', label: 'Contener' }, { value: 'cover', label: 'Cubrir' }, { value: 'fill', label: 'Estirar' }]} />
        </div>
      )}
    </div>
  )
}
