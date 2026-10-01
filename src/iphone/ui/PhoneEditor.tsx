/**
 * El editor en el iPhone: botones de vidrio arriba, el video, la barra de reproducción y el timeline siempre a la vista
 * (al estilo de los editores de teléfono: cursor fijo en el centro, se desliza el tiempo); abajo, una hoja de vidrio con
 * Claude (el chat) y Medios, que con la pestaña Timeline queda chica y se agranda arrastrando la manija. Con el teclado
 * abierto queda el video chico y la hoja. La lógica de edición (deshacer, cortar, duplicar, agregar medios) es la del
 * editor de la PC; la forma de tocarla es la del teléfono.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { afterPaint, Asset, call, Clip, EFFORTS, fmtTime, on, Project, Timeline as TL, Track, TrackType, uid } from '../../api'
import { useApp } from '../../App'
import Stage, { StageHandle } from '../../components/Stage'
import ChatPanel, { ChatHeadApi, ChatStatus } from '../../components/ChatPanel'
import { useDialogs } from '../../components/Dialogs'
import { Icon } from '../../ui/icons'
import { Spinner } from '../../ui/kit'
import { useBack } from '../../android/ui/back'
import { syncGlassNow } from '../host/glassUI'
import { isNative, nativeCall } from '../host/native'
import { MenuButton, Tap, TopBar } from './PhoneApp'
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
/** La hoja de abajo: sólo las pestañas, a media altura, alta (con el video chico) o hasta arriba (debajo de la barra:
 *  el video y la reproducción se apagan). Alta y arriba esconden el timeline de arriba. */
type Sheet = 'min' | 'mid' | 'max' | 'top'
const SHEETS: Sheet[] = ['min', 'mid', 'max', 'top']
const clipName = (c: Clip) => c.name || c.src.split('/').pop()!.replace(/\.[^.]+$/, '')
/** Las áreas seguras (la isla dinámica arriba, el indicador de inicio abajo), medidas una vez. */
let safe: { top: number; bottom: number } | null = null
function insets() {
  if (!safe) {
    const p = document.createElement('div')
    p.style.cssText = 'position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)'
    document.body.append(p)
    const cs = getComputedStyle(p)
    safe = { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0 }
    p.remove()
  }
  return safe
}
/** Las alturas de la hoja: sólo las pestañas, media altura, alta (lo que deja el video chico) y hasta arriba. */
function detents(): Record<Sheet, number> {
  const vh = window.visualViewport?.height || window.innerHeight, s = insets()
  const max = Math.max(320, Math.round(vh - s.top - 54 - (vh * 0.17 + 12) - 62 - 4))
  return { min: 84 + s.bottom, mid: Math.max(250, Math.round(vh * 0.31)), max, top: Math.max(max + 60, Math.round(vh - s.top - 54 - 6)) }
}

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
  // De qué se habla con Claude: todo el proyecto (null), la escena del cursor ('cursor') o una escena (el id del clip).
  const [scenePick, setScenePick] = useState<string | null>(null)
  const scenePickRef = useRef(scenePick); scenePickRef.current = scenePick
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
    setTab('timeline'); moveSheet('mid')
  }

  // ── reproducción: el reloj de la página; el sonido lo pone PreviewAudio ────
  const [rate, setRate] = useState(1)
  const [loop, setLoop] = useState(false)
  const loopRef = useRef(loop); loopRef.current = loop
  const [muted, setMuted] = useState(false)
  useEffect(() => {
    if (!playing || !tl) return
    let raf = 0, last = performance.now()
    const tick = (now: number) => {
      const dt = ((now - last) / 1000) * rate
      last = now
      const nt = tRef.current + dt
      if (nt >= tl.duration) {
        if (!loopRef.current) { setT(tl.duration); setPlaying(false); return }
        // Repetir: vuelve al principio sin cortar.
        tRef.current = 0; setT(0); audio.current!.play(projectId, tl, 0, rate)
      } else setT(nt)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, tl?.duration, rate])
  const changeRate = (r: number) => { setRate(r); if (playing && tl) audio.current!.play(projectId, tl, tRef.current, r) }
  const toggleMute = () => { audio.current?.setMuted(!muted); setMuted(!muted) }
  // Pantalla completa: el video de borde a borde con los controles encima, que se esconden solos mientras se reproduce
  // (un toque los muestra o los esconde); iOS saca la barra de estado y gira si el video es horizontal.
  const [chrome, setChrome] = useState(true)
  const [kick, setKick] = useState(0)
  useEffect(() => {
    if (!full || !playing || !chrome) return
    const timer = window.setTimeout(() => setChrome(false), 3000)
    return () => clearTimeout(timer)
  }, [full, playing, chrome, kick])
  useEffect(() => { if (!playing || !full) setChrome(true) }, [playing, full])
  useEffect(() => {
    if (!isNative() || !project) return
    void nativeCall('screen.full', { on: full, landscape: full && project.width > project.height }).catch(() => {})
  }, [full])
  useEffect(() => () => { if (isNative()) void nativeCall('screen.full', { on: false }).catch(() => {}) }, [])
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
  // La isla dinámica y la pantalla bloqueada: el nombre del proyecto con el ícono de la app (sin esto iOS mostraba un
  // cuadrado gris) y sus botones de reproducir y pausar.
  const playRef = useRef({ playing, togglePlay }); playRef.current = { playing, togglePlay }
  useEffect(() => {
    const ms = navigator.mediaSession
    if (!ms || !project) return
    try {
      ms.metadata = new MediaMetadata({ title: project.name, artist: 'OpenAnimator', artwork: [{ src: new URL('icon.png', location.href).href, sizes: '512x512', type: 'image/png' }] })
      for (const [action, want] of [['play', true], ['pause', false]] as const) ms.setActionHandler(action, () => { const p = playRef.current; if (p.playing !== want) p.togglePlay() })
    } catch { /* sin Media Session */ }
    return () => { try { ms.metadata = null; ms.setActionHandler('play', null); ms.setActionHandler('pause', null) } catch { /* sin Media Session */ } }
  }, [project?.name])
  useEffect(() => { if (navigator.mediaSession) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused' }, [playing])
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
  // ── la hoja de abajo (el cajón) ────────────────────────────────────────────
  // Sigue al dedo y, al soltarla, se acomoda en una de sus tres alturas con un resorte (como las hojas de iOS), según
  // dónde quedó y con qué velocidad se soltó; el video, el timeline y el vidrio se van ajustando mientras se mueve
  // (variables de CSS en .ed, sin volver a dibujar React en cada cuadro).
  const edRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef(sheet); sheetRef.current = sheet
  const drawer = useRef({ h: 0, raf: 0, moving: false })
  const drag = useRef<{ y0: number; h0: number; on: boolean; ys: Array<[number, number]> } | null>(null)
  const justDragged = useRef(false)
  const applyDrawer = (h: number) => {
    drawer.current.h = h
    const el = edRef.current
    if (!el) return
    const d = detents(), k = (a: number, b: number) => Math.max(0, Math.min(1, (h - a) / (b - a)))
    const tr = 1 - k(d.max, d.top) // de alta a arriba: el video y la reproducción se achican y se apagan
    el.style.setProperty('--sheet-h', `${Math.round(h)}px`)
    el.style.setProperty('--pv', ((0.3 - 0.09 * k(d.min, d.mid) - 0.04 * k(d.mid, d.max)) * tr).toFixed(4))
    el.style.setProperty('--tr', tr.toFixed(3))
    el.style.setProperty('--tl-o', (1 - k(d.max - 150, d.max - 20)).toFixed(3))
    syncGlassNow()
  }
  const moveSheet = (target: Sheet, v0 = 0) => {
    const dr = drawer.current, to = detents()[target]
    cancelAnimationFrame(dr.raf)
    if (target === 'mid') setSheet('mid') // el contenido aparece mientras sube; al minimizar o expandir, cambia al llegar
    let x = dr.h || to, v = v0, last = performance.now()
    const K = 240, C = 2 * 0.86 * Math.sqrt(K) // un resorte rápido, apenas con rebote
    dr.moving = true
    const step = (now: number) => {
      const dt = Math.min(0.034, (now - last) / 1000)
      last = now
      v += (-K * (x - to) - C * v) * dt
      x += v * dt
      if (Math.abs(x - to) < 0.6 && Math.abs(v) < 10) { applyDrawer(to); dr.moving = false; setSheet(target); return }
      applyDrawer(x)
      dr.raf = requestAnimationFrame(step)
    }
    dr.raf = requestAnimationFrame(step)
  }
  const dragDown = (e: React.PointerEvent) => {
    if (e.button) return
    cancelAnimationFrame(drawer.current.raf)
    drawer.current.moving = false
    drag.current = { y0: e.clientY, h0: drawer.current.h, on: false, ys: [[performance.now(), e.clientY]] }
  }
  const dragMove = (e: React.PointerEvent) => {
    const g = drag.current
    if (!g) return
    const dy = e.clientY - g.y0
    if (!g.on) {
      if (Math.abs(dy) < 6) return
      g.on = true
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* ya terminó */ }
      if (sheetRef.current !== 'mid') setSheet('mid') // que se vea el contenido mientras se mueve
    }
    // Más allá de los extremos se estira con resistencia, como en iOS.
    const d = detents(), rubber = (x: number) => 46 * (1 - 1 / (x / 140 + 1))
    let h = g.h0 - dy
    if (h > d.top) h = d.top + rubber(h - d.top)
    else if (h < d.min) h = d.min - rubber(d.min - h)
    g.ys.push([performance.now(), e.clientY])
    if (g.ys.length > 5) g.ys.shift()
    applyDrawer(h)
  }
  const dragEnd = (e: React.PointerEvent) => {
    const g = drag.current
    drag.current = null
    if (!g) return
    if (!g.on) {
      // Un toque en la manija: de abajo, hasta arriba; de arriba (o alta), a media altura.
      if ((e.target as HTMLElement).closest('.ed-grab')) moveSheet(sheetRef.current === 'min' || sheetRef.current === 'mid' ? 'top' : 'mid')
      return
    }
    justDragged.current = true
    setTimeout(() => { justDragged.current = false }, 80)
    const [t0, y0] = g.ys[0], [t1, y1] = g.ys[g.ys.length - 1]
    const v = t1 > t0 ? -(y1 - y0) / ((t1 - t0) / 1000) : 0 // px/s, hacia arriba
    const d = detents(), proj = drawer.current.h + v * 0.2
    moveSheet(SHEETS.reduce((a, b) => (Math.abs(d[b] - proj) < Math.abs(d[a] - proj) ? b : a)), v)
  }
  // Al abrir el proyecto, al volver de pantalla completa y si cambia el tamaño (el teclado): la altura de su lugar.
  useLayoutEffect(() => { if (!drawer.current.moving && !drag.current) applyDrawer(detents()[sheetRef.current]) }, [!!tl, !!project, full])
  useEffect(() => {
    const fit = () => { if (!drawer.current.moving && !drag.current) applyDrawer(detents()[sheetRef.current]) }
    window.visualViewport?.addEventListener('resize', fit)
    return () => { window.visualViewport?.removeEventListener('resize', fit); cancelAnimationFrame(drawer.current.raf) }
  }, [])
  // Pantalla completa: volver deslizando desde el borde sale de ella.
  useBack(() => { setFull(false); return true }, full)
  /** Abrir una pestaña de la hoja (si estaba minimizada, sube a media altura). */
  const openTab = (id: Tab) => { setTab(id); if (sheetRef.current === 'min') moveSheet('mid') }
  /** Tocar una pestaña: la abre; tocar la que ya está abierta minimiza la hoja. */
  const pickTab = (id: Tab) => { if (justDragged.current) return; if (id === tab && sheet !== 'min') moveSheet('min'); else openTab(id) }
  const askClaude = (text: string) => { openTab('claude'); setInject({ text, n: Date.now() }) }
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
  const editNote = async (id: string) => {
    const n = tl?.notes?.find((x) => x.id === id)
    if (!n) return
    const text = await dlg.prompt({ title: `Nota en ${fmtTime(n.t, true, fps)}`, label: 'Para Claude: qué cambiar en este momento del video', value: n.text, ok: 'Guardar nota', icon: 'note' })
    if (text) mutate((d) => { d.notes = (d.notes || []).map((x) => (x.id === id ? { ...x, text } : x)) })
  }
  const deleteNote = (id: string) => mutate((d) => { d.notes = (d.notes || []).filter((x) => x.id !== id) })

  if (!project || !tl) return <><TopBar left={<Tap icon="chevron-left" label="Volver" onClick={onClose} back />} /><div className="ph-center"><Spinner size={22} /><span className="t3">Abriendo el proyecto…</span></div></>

  const ar = project.height / project.width
  const tabs = [['claude', 'sparkles', 'Claude'], ['timeline', 'film', 'Timeline'], ['media', 'folder', 'Medios']] as const
  const timeline = (
    <PhoneTimeline tl={tl} tlId={tlId} t={t} fps={fps} playing={playing} sel={sel} projectId={projectId}
      onScrub={scrub} onSelect={setSel} onChange={change} onSplit={() => splitAt(tRef.current)} onDelete={delSel} onDuplicate={dupSel}
      onPatchTrack={patchTrack} onAdd={() => openTab('media')} onNote={addNote} onEditNote={editNote} onDeleteNote={deleteNote} onAsk={askClaude} onInspect={() => openTab('timeline')} />
  )
  // De qué se habla con Claude: todo el proyecto, la escena del cursor o una escena elegida.
  const scenes = tl.tracks.filter((x) => x.type === 'scene').flatMap((x) => [...x.clips].sort((a, b) => a.start - b.start))
  const sceneOf = (pick: string | null, x: number) => (!pick ? undefined : pick === 'cursor' ? scenes.find((c) => x >= c.start && x < c.start + c.duration) : scenes.find((c) => c.id === pick))
  const num = (c: Clip) => String(scenes.indexOf(c) + 1).padStart(2, '0')
  const chatScene = sceneOf(scenePick, t)
  const claudeHead = (api: ChatHeadApi) => {
    const name = chatScene ? clipName(chatScene) : ''
    const chips: Array<[string, string]> = chatScene
      ? [['Animar escena', `Animá la escena «${name}»: `], ['Más rápido', `Hacé más rápida la escena «${name}».`], ['Cambiar colores', `Cambiá los colores de la escena «${name}»: `], ['Ajustar voz', `Ajustá la voz de la escena «${name}»: `]]
      : scenes.length ? [['Revisar el video', 'Mirá el video completo y decime qué mejorarías.'], ['Más ritmo', 'Hacé el video más dinámico: '], ['Agregar una escena', 'Agregá una escena que muestre '], ['Agregar música', 'Agregá música de fondo que acompañe el video.']]
        : [['Crear un video', 'Creá un video a partir de este guion: '], ['Agregar una escena', 'Agregá una escena que muestre ']]
    const effort = EFFORTS.find((e) => e.id === api.effort) || EFFORTS[0]
    const perm = api.perms.find((x) => x.value === api.permissionMode) || api.perms[1]
    return (
      <div className="cl-head">
        <div className="cl-row">
          <span className="cl-title"><Icon name="sparkles" size={21} />Claude{api.busy && <Spinner size={14} />}</span>
          <div className="grow" />
          {scenes.length > 0 && <MenuButton className="cl-scene" glass label="De qué se habla con Claude" title="¿De qué hablamos?" items={[
            { label: 'Todo el proyecto', icon: 'film', desc: 'Claude piensa en el video completo', checked: !scenePick, onSelect: () => setScenePick(null) },
            { label: 'La escena del cursor', icon: 'scissors', desc: 'La que se ve en la vista previa', checked: scenePick === 'cursor', onSelect: () => setScenePick('cursor') },
            { sep: true },
            ...scenes.map((c) => ({ label: `${num(c)} · ${clipName(c)}`, checked: scenePick === c.id, onSelect: () => setScenePick(c.id) })),
          ]}><Icon name="film" size={15} /><span className="ellipsis">{!scenePick ? 'Todo el proyecto' : chatScene ? `Escena ${num(chatScene)}` : 'Escena del cursor'}</span><Icon name="chevron-down" size={14} /></MenuButton>}
          <MenuButton className="g-btn cl-more" glass label="Opciones de Claude" title="Claude" items={[
            { label: 'Nueva conversación', icon: 'plus', onSelect: api.newChat },
            { label: 'Conversaciones anteriores', icon: 'history', onSelect: api.history },
            { sep: true },
            { label: 'Modelo', icon: 'cpu', desc: api.modelName(api.model), sub: api.models.map((o) => ({ label: typeof o.label === 'string' ? o.label : api.modelName(o.value), checked: o.value === api.modelValue, onSelect: () => api.setOption({ model: o.value }, `Modelo: ${api.modelName(o.value)} (se aplica al próximo mensaje).`) })) },
            { label: 'Esfuerzo', icon: 'gauge', desc: effort.name, sub: EFFORTS.map((e) => ({ label: e.name, desc: e.desc, checked: e.id === api.effort, onSelect: () => api.setOption({ effort: e.id }, `Esfuerzo: ${e.name} (se aplica al próximo mensaje).`) })) },
            { label: 'Permisos', icon: 'shield', desc: perm.label, sub: api.perms.map((x) => ({ label: x.label, desc: x.desc, checked: x.value === api.permissionMode, onSelect: () => api.setOption({ permissionMode: x.value }, `Permisos: ${x.label}`) })) },
            { label: 'Modo ahorro', icon: 'leaf', desc: 'Imágenes más chicas y respuestas cortas', checked: api.saver, onSelect: () => api.setOption({ saver: !api.saver }, api.saver ? 'Modo ahorro desactivado (se aplica al próximo mensaje).' : 'Modo ahorro activado (se aplica al próximo mensaje).') },
            { sep: true },
            { label: 'Compactar la conversación', icon: 'compress', desc: api.context ? `${Math.round(api.context.used / 1000)} mil tokens (${api.context.pct} %)` : 'Todavía sin medir', disabled: api.busy || !api.context, onSelect: api.compact },
          ]}><Icon name="more" size={19} /></MenuButton>
        </div>
        <div className="cl-chips">{chips.map(([label, text]) => <button key={label} className="cl-chip" onClick={() => setInject({ text, n: Date.now() })}>{label}</button>)}</div>
      </div>
    )
  }
  const projectItems = [
    { label: 'Renombrar proyecto…', icon: 'edit', onSelect: renameProject },
    { label: 'Nota para Claude en el cursor…', icon: 'note', onSelect: addNote },
    { sep: true as const },
    { label: 'Timelines', icon: 'film', desc: project.timelines.find((x) => x.id === tlId)?.name, sub: [
      ...project.timelines.map((x) => ({ label: x.name, checked: x.id === tlId, onSelect: () => { if (x.id !== tlId) switchTl(x.id) } })),
      { sep: true as const },
      { label: 'Nuevo timeline…', icon: 'plus', onSelect: newTl },
    ] },
    { sep: true as const },
    { label: 'Ajustes', icon: 'settings', onSelect: () => go({ page: 'settings', from: { page: 'editor', id: projectId } }) },
  ]
  return (
    <div ref={edRef} className={`ed sh-${sheet} tab-${tab} ${full ? 'full' : ''}`}
      onClick={full ? (e) => { if (!(e.target as HTMLElement).closest('.fs-top, .fs-panel')) setChrome((c) => !c) } : undefined}>
      {!full && <div className="ph-top ed-top">
        <button className="g-btn" data-glass aria-label="Proyectos" data-back onClick={onClose}><Icon name="chevron-left" size={22} /></button>
        <MenuButton className="ed-name" glass align="start" label="Proyecto" title={project.name} items={projectItems}><span className="ellipsis">{project.name}</span><Icon name="chevron-down" size={15} /></MenuButton>
        <div className="grow" />
        <button className="g-btn" data-glass aria-label="Deshacer" onClick={undo} disabled={!hist.current.past.length}><Icon name="undo" size={19} /></button>
        <button className="g-btn" data-glass aria-label="Rehacer" onClick={redo} disabled={!hist.current.future.length}><Icon name="redo" size={19} /></button>
        <button className="ed-export" data-glass="accent" onClick={() => setExporting(true)}><Icon name="export" size={17} />Exportar</button>
      </div>}

      <div className="ed-media">
        <div className="ed-player" style={{ ['--ar' as any]: ar }}>
          <div className="ed-stage">
            {!exporting && <Stage ref={stage} projectId={projectId} tlId={tlId} t={hold ?? t} playing={playing} rate={rate} width={project.width} height={project.height} reloadKey={0} pad={0} bg="black" onError={(m) => toast(m, true)} />}
            <button className="ed-tapzone" aria-label={full ? 'Mostrar u ocultar los controles' : playing ? 'Pausa' : 'Reproducir'} onClick={full ? undefined : togglePlay} />
          </div>
        </div>

        {!full && <div className="ed-transport" data-glass>
          <span className="ed-time tabnum"><b>{clock(t)}</b><span> / {clock(tl.duration, false)}</span></span>
          <div className="ed-tp" data-glass>
            <button className="ed-tpb" aria-label="Ir al inicio" disabled={t <= 0} onClick={() => seek(0)}><Icon name="skip-back" size={20} /></button>
            <button className="ed-play" data-glass="light" aria-label={playing ? 'Pausa' : 'Reproducir'} onClick={togglePlay}><Icon name={playing ? 'pause' : 'play'} size={22} /></button>
            <button className="ed-tpb" aria-label="Ir al final" disabled={t >= tl.duration} onClick={() => seek(tl.duration)}><Icon name="skip-fwd" size={20} /></button>
          </div>
          <div className="ed-tright">
            <button className={`ed-tpb ${muted ? 'muted' : ''}`} aria-label={muted ? 'Activar el sonido' : 'Silenciar'} onClick={toggleMute}><Icon name={muted ? 'volume-x' : 'volume-2'} size={19} /></button>
            <button className="ed-tpb" aria-label="Pantalla completa" onClick={() => setFull(true)}><Icon name="maximize" size={19} /></button>
          </div>
        </div>}
      </div>

      {full && <div className={`fs ${chrome ? '' : 'hide'}`} onPointerDown={() => setKick((k) => k + 1)}>
        <div className="fs-top">
          <button className="fs-btn" data-glass aria-label="Salir de pantalla completa" onClick={() => setFull(false)}><Icon name="chevron-left" size={22} /></button>
          <MenuButton className="fs-title" glass align="end" label="Proyecto" title={project.name} items={projectItems}><span className="ellipsis">{project.name}</span><Icon name="chevron-down" size={15} /></MenuButton>
          <MenuButton className="fs-btn" glass label="Reproducción" title="Reproducción" items={[
            { label: 'Velocidad', icon: 'gauge', desc: `${rate}×`.replace('.', ','), sub: [0.5, 1, 1.5, 2].map((r) => ({ label: `${r}×`.replace('.', ','), checked: rate === r, onSelect: () => changeRate(r) })) },
            { label: 'Repetir', icon: 'repeat', checked: loop, onSelect: () => setLoop(!loop) },
          ]}><Icon name="more" size={20} /></MenuButton>
        </div>
        <div className="fs-panel" data-glass>
          <div className="fs-line">
            <span className="fs-time tabnum"><b>{clock(t, false)}</b> / {clock(tl.duration, false)}</span>
            <input className="fs-seek" type="range" min={0} max={tl.duration || 1} step={1 / fps} value={t} onChange={(e) => seek(+e.target.value)} style={{ ['--pct' as any]: `${(t / (tl.duration || 1)) * 100}%` }} />
          </div>
          <div className="fs-ctrls">
            <button className="ed-tpb" aria-label="Salir de pantalla completa" onClick={() => setFull(false)}><Icon name="minimize" size={20} /></button>
            <button className="ed-tpb" aria-label="Ir al inicio" disabled={t <= 0} onClick={() => seek(0)}><Icon name="skip-back" size={22} /></button>
            <button className="fs-play" aria-label={playing ? 'Pausa' : 'Reproducir'} onClick={togglePlay}><Icon name={playing ? 'pause' : 'play'} size={26} /></button>
            <button className="ed-tpb" aria-label="Ir al final" disabled={t >= tl.duration} onClick={() => seek(tl.duration)}><Icon name="skip-fwd" size={22} /></button>
            <button className={`ed-tpb ${muted ? 'muted' : ''}`} aria-label={muted ? 'Activar el sonido' : 'Silenciar'} onClick={toggleMute}><Icon name={muted ? 'volume-x' : 'volume-2'} size={21} /></button>
          </div>
        </div>
      </div>}

      {!full && <>
        <div className="ed-tl">{sheet !== 'max' && sheet !== 'top' && timeline}</div>

        {/* La hoja de abajo (vidrio) con sus pestañas: Claude, Timeline (los ajustes del clip) y Medios. Se arrastra
            desde la manija o las pestañas. */}
        <div className="ed-sheet" data-glass>
          <div className="ed-sheet-head" onPointerDown={dragDown} onPointerMove={dragMove} onPointerUp={dragEnd} onPointerCancel={dragEnd}>
            <div className="ed-grab"><i /></div>
            <div className="ed-tabs" role="tablist" data-glass>
              {tabs.map(([id, icon, label]) => (
                <button key={id} role="tab" aria-selected={tab === id} className={`ed-tab ${tab === id ? 'on' : ''}`} data-glass={tab === id ? 'accent' : undefined} onClick={() => pickTab(id)}>
                  <Icon name={icon} size={17} />{label}
                  {id === 'claude' && (chat.waiting ? <span className="ed-dot warn" /> : chat.busy ? <span className="ed-dot busy" /> : unread ? <span className="ed-count">{unread}</span> : null)}
                </button>
              ))}
            </div>
          </div>
          <div className="ed-pane" style={{ display: sheet === 'min' ? 'none' : undefined }}>
            <div className="ed-chat" style={{ display: tab === 'claude' ? 'flex' : 'none' }}>
              <ChatPanel projectId={projectId} visible={tab === 'claude' && sheet !== 'min'} onStatus={setChat} inject={inject} head={claudeHead} compactBar
                context={() => {
                  const c = sceneOf(scenePickRef.current, tRef.current)
                  return { timeline: tlId, t: tRef.current, scene: c ? `«${clipName(c)}» (${c.src}, de ${fmtTime(c.start, true, fps)} a ${fmtTime(c.start + c.duration, true, fps)})` : undefined }
                }} />
            </div>
            {tab === 'media' && <PhoneMedia projectId={projectId} assets={assets} onRefresh={refreshAssets} onAdd={addAssets} onAsk={askClaude} full={sheet === 'max' || sheet === 'top'} />}
            {tab === 'timeline' && <div className="ed-montage">
              {(sheet === 'max' || sheet === 'top') && <div className="ed-montage-tl">{timeline}</div>}
              <PhoneInspector projectId={projectId} tlId={tlId} tl={tl} sel={sel} t={t} fps={fps} onSelect={setSel} onPatch={patchClip}
                onSplit={() => splitAt(tRef.current)} onDuplicate={dupSel} onDelete={delSel} />
            </div>}
          </div>
        </div>
      </>}

      {exporting && <PhoneExport project={project} currentTl={tlId} onClose={() => setExporting(false)} />}
      {dlg.element}
    </div>
  )
}
