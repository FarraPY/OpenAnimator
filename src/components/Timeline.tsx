import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Asset, call, Clip, fmtTime, Timeline as TL, Track, TrackType } from '../api'
import { isTouch, projectUrl } from '../platform'
import { Icon, IconName } from '../ui/icons'
import { Button, Slider } from '../ui/kit'

type Props = {
  projectId: string
  tl: TL; t: number; fps: number; playing: boolean
  pps: number; setPps: (n: number) => void
  selected: string[]; setSelected: (ids: string[]) => void
  onSeek: (t: number) => void
  onChange: (next: TL, commit: boolean) => void
  onDropAsset: (a: Asset, trackId: string | null, time: number) => void
  onClipMenu: (clip: Clip, track: Track, x: number, y: number) => void
  onTrackMenu: (track: Track, x: number, y: number) => void
  onRenameTrack: (track: Track) => void
  onNote: (id: string) => void
  /** Doble toque en un clip (tablet): abre sus propiedades. */
  onClipOpen?: (clip: Clip, track: Track) => void
  height: number; setHeight: (h: number) => void
  snapOn: boolean; snapFrames: boolean; followPlayhead: boolean; waveforms: boolean
  fitRef?: React.MutableRefObject<(() => void) | null>
}

// En la tablet las pistas son más altas (dedo) y la regla también.
const TOUCH = isTouch()
const ROW = TOUCH ? 64 : 58, RULER = TOUCH ? 36 : 30
export const TYPE_COLOR: Record<string, string> = { scene: 'var(--scene)', video: 'var(--video)', image: 'var(--image)', audio: 'var(--audio)', voice: 'var(--voice)', music: 'var(--music)', sfx: 'var(--sfx)' }
export const TYPE_ICON: Record<string, IconName> = { scene: 'code', video: 'video', image: 'image', audio: 'music', voice: 'mic', music: 'music', sfx: 'wave' }
export const WAVE: Record<string, string> = { voice: 'rgba(170, 245, 200, .8)', music: 'rgba(150, 232, 244, .78)', sfx: 'rgba(255, 224, 150, .8)', audio: 'rgba(150, 232, 244, .78)', video: 'rgba(255, 214, 170, .55)' }
/** Rol de una pista de audio según su id o nombre: cada tipo tiene su color propio. */
export function trackRole(tr: Track): string {
  if (tr.type !== 'audio') return tr.type
  const s = `${tr.id} ${tr.name}`.toLowerCase()
  if (/voz|voice|narra|locu|dialog/.test(s)) return 'voice'
  if (/m[uú]sica|music|banda|bgm/.test(s)) return 'music'
  if (/sfx|efecto|fx|sonido|foley/.test(s)) return 'sfx'
  return 'audio'
}
const STEPS = [1 / 30, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200]
const isImage = (src: string) => /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(src)
const clipKind = (tr: Track, c: Clip) => (tr.type === 'video' && isImage(c.src) ? 'image' : tr.type)
const clipRole = (tr: Track, c: Clip) => (tr.type === 'audio' ? trackRole(tr) : clipKind(tr, c))

// ── formas de onda (picos cacheados por archivo) ──────────────────────────────
const peaksCache = new Map<string, Promise<{ rate: number; data: Uint8Array } | null>>()
function loadPeaks(projectId: string, src: string) {
  const k = projectId + '|' + src
  if (!peaksCache.has(k)) peaksCache.set(k, call('media:peaks', projectId, src).then((r: any) => {
    const bin = atob(r.data); const a = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i)
    return { rate: r.rate, data: a }
  }).catch(() => null))
  return peaksCache.get(k)!
}
/** La forma de onda real de un archivo (sus picos, cacheados), sólo en la parte visible del clip: de x0 a x1. */
export const Wave = memo(function Wave({ projectId, src, inSec, pps, x0, x1, height, color }: { projectId: string; src: string; inSec: number; pps: number; x0: number; x1: number; height: number; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [peaks, setPeaks] = useState<{ rate: number; data: Uint8Array } | null>(null)
  useEffect(() => { let on = true; loadPeaks(projectId, src).then((p) => on && setPeaks(p)); return () => { on = false } }, [projectId, src])
  const w = Math.max(1, Math.round(x1 - x0))
  useLayoutEffect(() => {
    const cv = ref.current
    if (!cv || !peaks) return
    const dpr = window.devicePixelRatio || 1
    cv.width = w * dpr; cv.height = height * dpr
    const g = cv.getContext('2d')!
    g.scale(dpr, dpr)
    g.clearRect(0, 0, w, height)
    g.fillStyle = color
    const mid = height / 2
    for (let x = 0; x < w; x++) {
      const a = inSec + (x0 + x) / pps, b = inSec + (x0 + x + 1) / pps
      const i0 = Math.floor(a * peaks.rate), i1 = Math.max(i0 + 1, Math.floor(b * peaks.rate))
      let m = 0
      for (let i = i0; i < i1 && i < peaks.data.length; i++) if (peaks.data[i] > m) m = peaks.data[i]
      const hh = Math.max(0.5, (m / 255) * (height / 2 - 2))
      g.fillRect(x, mid - hh, 1, hh * 2)
    }
  }, [peaks, w, height, inSec, pps, x0, color])
  return <canvas ref={ref} style={{ position: 'absolute', left: x0, top: 0, width: w, height }} />
})

function FadeRamp({ w, out }: { w: number; out?: boolean }) {
  return (
    <div className="fade" style={out ? { right: 0, width: w } : { left: 0, width: w }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <path d={out ? 'M0 0 L100 100 L100 0 Z' : 'M0 0 L100 0 L0 100 Z'} fill="rgba(0,0,0,.42)" />
        <path d={out ? 'M0 0 L100 100' : 'M0 100 L100 0'} stroke="rgba(255,255,255,.7)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" fill="none" />
      </svg>
    </div>
  )
}

export default function Timeline(p: Props) {
  const { tl, t, pps } = p
  const scroll = useRef<HTMLDivElement>(null)
  const heads = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ left: 0, width: 1200 })
  const [snapX, setSnapX] = useState<number | null>(null)
  const [dropRow, setDropRow] = useState<number | null>(null)
  const drag = useRef<any>(null)
  /** Toque pendiente (tablet): si el dedo no se movió, al soltar selecciona / mueve el cursor. */
  const tap = useRef<{ kind: 'clip' | 'bg'; clip?: Clip; track?: Track; x: number; y: number } | null>(null)
  const lastTap = useRef<{ id: string; at: number } | null>(null)
  const ppsRef = useRef(pps); ppsRef.current = pps
  const pRef = useRef(p); pRef.current = p
  const total = Math.max(tl.duration * 1.15 + 10, 30)
  const width = total * pps

  useEffect(() => {
    const el = scroll.current!
    const upd = () => setView({ left: el.scrollLeft, width: el.clientWidth })
    upd()
    el.addEventListener('scroll', upd)
    const ro = new ResizeObserver(upd); ro.observe(el)
    return () => { el.removeEventListener('scroll', upd); ro.disconnect() }
  }, [])

  // Pellizcar con dos dedos: zoom del timeline alrededor del punto medio.
  useEffect(() => {
    const el = scroll.current!
    let pinch: { d0: number; pps0: number; tAt: number } | null = null
    const dist = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY)
    const mid = (e: TouchEvent) => (e.touches[0].clientX + e.touches[1].clientX) / 2
    const start = (e: TouchEvent) => {
      if (e.touches.length !== 2) return
      const r = el.getBoundingClientRect()
      pinch = { d0: Math.max(10, dist(e)), pps0: ppsRef.current, tAt: (mid(e) - r.left + el.scrollLeft) / ppsRef.current }
      tap.current = null
      if (drag.current?.moved) pRef.current.onChange(structuredClone(drag.current.orig), true)
      drag.current = null
    }
    const move = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return
      e.preventDefault()
      const np = Math.max(2, Math.min(600, pinch.pps0 * (dist(e) / pinch.d0)))
      const x = mid(e) - el.getBoundingClientRect().left
      pRef.current.setPps(np)
      const tAt = pinch.tAt
      requestAnimationFrame(() => { el.scrollLeft = tAt * np - x })
    }
    const end = (e: TouchEvent) => { if (e.touches.length < 2) pinch = null }
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', end)
    el.addEventListener('touchcancel', end)
    return () => { el.removeEventListener('touchstart', start); el.removeEventListener('touchmove', move); el.removeEventListener('touchend', end); el.removeEventListener('touchcancel', end) }
  }, [])

  // Ajustar a la ventana.
  useEffect(() => {
    if (!p.fitRef) return
    p.fitRef.current = () => { const el = scroll.current!; p.setPps(Math.max(2, Math.min(600, (el.clientWidth - 40) / Math.max(1, tl.duration)))); el.scrollLeft = 0 }
  })

  // Seguir el cursor al reproducir.
  useEffect(() => {
    if (!p.playing || !p.followPlayhead) return
    const el = scroll.current!
    const x = t * pps
    if (x > el.scrollLeft + el.clientWidth - 60 || x < el.scrollLeft) el.scrollLeft = x - 80
  }, [t, p.playing, pps, p.followPlayhead])

  const ticks = useMemo(() => {
    const step = STEPS.find((s) => s * pps >= 90) || 1200
    const minor = STEPS.slice().reverse().find((s) => s < step && s * pps >= 10)
    const a = Math.max(0, Math.floor(view.left / pps / step) * step), b = (view.left + view.width) / pps + step
    const out: Array<{ x: number; label?: string; minor?: boolean }> = []
    for (let s = a; s <= b; s += step) out.push({ x: s * pps, label: fmtTime(s, step < 1, p.fps) })
    if (minor) for (let s = Math.floor(a / minor) * minor; s <= b; s += minor) if (Math.abs(s / step - Math.round(s / step)) > 1e-6) out.push({ x: s * pps, minor: true })
    return out
  }, [pps, view, p.fps])

  const timeAt = (clientX: number) => {
    const el = scroll.current!
    const r = el.getBoundingClientRect()
    return Math.max(0, (clientX - r.left + el.scrollLeft) / pps)
  }
  const rowAt = (clientY: number) => {
    const el = scroll.current!
    const r = el.getBoundingClientRect()
    return Math.floor((clientY - r.top + el.scrollTop - RULER) / ROW)
  }
  const q = (v: number) => (p.snapFrames ? Math.round(v * p.fps) / p.fps : v)

  const snapPoints = (exclude: string) => {
    const pts = [0, t, tl.duration, ...(tl.notes || []).map((n) => n.t)]
    for (const tr of tl.tracks) for (const c of tr.clips) if (c.id !== exclude) pts.push(c.start, c.start + c.duration)
    return pts
  }
  const snap = (v: number, pts: number[]) => {
    if (!p.snapOn) return { v: q(v), snapped: false }
    const thr = 8 / pps
    let best = v, bd = thr
    for (const s of pts) { const d = Math.abs(s - v); if (d < bd) { bd = d; best = s } }
    return bd < thr ? { v: best, snapped: true } : { v: q(v), snapped: false }
  }

  // ── arrastre / recorte ─────────────────────────────────────────────────────
  const onClipDown = (e: React.PointerEvent, clip: Clip, track: Track, mode: 'move' | 'l' | 'r') => {
    if (e.button !== 0) return
    e.stopPropagation()
    // Con el dedo, un clip sin seleccionar no se arrastra: tocarlo lo selecciona y deslizar desplaza el timeline.
    if (e.pointerType === 'touch' && mode === 'move' && !p.selected.includes(clip.id)) {
      tap.current = { kind: 'clip', clip, track, x: e.clientX, y: e.clientY }
      return
    }
    const sel = e.ctrlKey || e.shiftKey ? (p.selected.includes(clip.id) ? p.selected.filter((x) => x !== clip.id) : [...p.selected, clip.id]) : p.selected.includes(clip.id) ? p.selected : [clip.id]
    p.setSelected(sel)
    if (track.locked) return
    drag.current = { mode, clipId: clip.id, trackId: track.id, x0: e.clientX, y0: e.clientY, orig: structuredClone(tl), clip: { ...clip }, pts: snapPoints(clip.id), moved: false, touch: e.pointerType === 'touch' }
    if (e.pointerType === 'touch' && mode === 'move') tap.current = { kind: 'clip', clip, track, x: e.clientX, y: e.clientY }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    if (tap.current && Math.hypot(e.clientX - tap.current.x, e.clientY - tap.current.y) > 10) tap.current = null
    const d = drag.current
    if (!d) return
    if (d.mode === 'scrub') { p.onSeek(q(timeAt(e.clientX))); return }
    const dt = (e.clientX - d.x0) / pps
    if (!d.moved && Math.abs(e.clientX - d.x0) < (d.touch ? 10 : 3) && (!d.touch || Math.abs(e.clientY - d.y0) < 10)) return
    d.moved = true
    const next: TL = structuredClone(d.orig)
    let track = next.tracks.find((x) => x.id === d.trackId)!
    const idx = track.clips.findIndex((c) => c.id === d.clipId)
    const c = track.clips[idx]
    const o = d.clip as Clip
    const minDur = 1 / p.fps
    let sx: number | null = null
    if (d.mode === 'move') {
      let start = Math.max(0, o.start + dt)
      const a = snap(start, d.pts), b = snap(start + o.duration, d.pts)
      if (a.snapped && (!b.snapped || Math.abs(a.v - start) <= Math.abs(b.v - start - o.duration))) { start = a.v; sx = a.v } else if (b.snapped) { start = b.v - o.duration; sx = b.v } else start = a.v
      c.start = Math.max(0, start)
      const row = rowAt(e.clientY)
      const target = next.tracks[row]
      if (target && target.id !== track.id && target.type === track.type && !target.locked) { track.clips.splice(idx, 1); target.clips.push(c); track = target }
    } else if (d.mode === 'l') {
      let start = o.start + dt
      const a = snap(start, d.pts); start = a.v; if (a.snapped) sx = a.v
      let delta = start - o.start
      delta = Math.max(delta, -(o.in || 0))
      delta = Math.min(delta, o.duration - minDur)
      if (o.start + delta < 0) delta = -o.start
      c.start = o.start + delta; c.in = (o.in || 0) + delta; c.duration = o.duration - delta
    } else {
      let end = o.start + o.duration + dt
      const a = snap(end, d.pts); end = a.v; if (a.snapped) sx = a.v
      let dur = Math.max(minDur, end - o.start)
      const srcDur = (o as any).srcDur
      if (srcDur) dur = Math.min(dur, srcDur - (o.in || 0))
      c.duration = dur
    }
    setSnapX(sx == null ? null : sx * pps)
    p.onChange(next, false)
  }
  const onUp = (e?: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    setSnapX(null)
    if (d && d.mode !== 'scrub' && d.moved) { tap.current = null; p.onChange(structuredClone(tl), true); return }
    const tp = tap.current
    tap.current = null
    if (!tp || !e) return
    if (tp.kind === 'bg') { p.setSelected([]); p.onSeek(q(timeAt(tp.x))); return }
    if (tp.kind === 'clip' && tp.clip) {
      const now = Date.now()
      const dbl = lastTap.current && lastTap.current.id === tp.clip.id && now - lastTap.current.at < 350
      lastTap.current = { id: tp.clip.id, at: now }
      p.setSelected([tp.clip.id])
      if (dbl && tp.track) p.onClipOpen?.(tp.clip, tp.track)
    }
  }
  const onCancel = () => {
    // El navegador tomó el gesto (desplazamiento): no es un toque.
    tap.current = null
    const d = drag.current
    drag.current = null
    setSnapX(null)
    if (d && d.mode !== 'scrub' && d.moved) p.onChange(structuredClone(tl), true)
  }

  const onDragOver = (e: React.DragEvent) => { if (!e.dataTransfer.types.includes('application/x-oa-asset')) return; e.preventDefault(); setDropRow(rowAt(e.clientY)) }
  const onDrop = (e: React.DragEvent) => {
    setDropRow(null)
    const raw = e.dataTransfer.getData('application/x-oa-asset')
    if (!raw) return
    e.preventDefault()
    const a = JSON.parse(raw) as Asset
    p.onDropAsset(a, tl.tracks[rowAt(e.clientY)]?.id || null, q(timeAt(e.clientX)))
  }
  const setTrack = (id: string, patch: Partial<Track>, commit = true) => {
    const next = structuredClone(tl)
    Object.assign(next.tracks.find((x) => x.id === id)!, patch)
    p.onChange(next, commit)
  }

  return (
    <div className="tl" style={{ height: p.height }}>
      <div className="tl-resize" onPointerDown={(e) => {
        const y0 = e.clientY, h0 = p.height
        const mv = (ev: PointerEvent) => p.setHeight(Math.max(140, Math.min(window.innerHeight - 260, h0 - (ev.clientY - y0))))
        const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up) }
        window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up)
      }} />
      <div className="tl-main">
        <div className="tl-heads">
          <div className="tl-head-ruler"><span className="caps">Pistas</span><div className="grow" /><span className="t3 tabnum" style={{ fontSize: 11 }}>{tl.tracks.length}</span></div>
          <div ref={heads}>
            {tl.tracks.map((tr) => { const role = trackRole(tr); return (
              <div key={tr.id} className="tl-head" style={{ ['--tc' as any]: TYPE_COLOR[role] }} onContextMenu={(e) => { e.preventDefault(); p.onTrackMenu(tr, e.clientX, e.clientY) }}
                onDoubleClick={TOUCH ? () => p.onRenameTrack(tr) : undefined}>
                <div className="tl-head-stripe" style={{ background: TYPE_COLOR[role] }} />
                <div className="tl-head-in">
                  <div className="name" onDoubleClick={() => p.onRenameTrack(tr)} data-tip="Doble clic para renombrar">
                    <Icon name={TYPE_ICON[role]} size={13} style={{ color: TYPE_COLOR[role] }} /><span className="ellipsis">{tr.name}</span>
                  </div>
                  <div className="ctrls">
                    {tr.type !== 'audio' && <Button size="xs" variant="ghost" icon={tr.hidden ? 'eye-off' : 'eye'} active={!!tr.hidden} tip={tr.hidden ? 'Mostrar pista' : 'Ocultar pista'} onClick={() => setTrack(tr.id, { hidden: !tr.hidden })} />}
                    {tr.type !== 'scene' && <Button size="xs" variant="ghost" icon={tr.muted ? 'volume-x' : 'volume'} className={tr.muted ? 'err-on' : ''} tip={tr.muted ? 'Activar sonido' : 'Silenciar'} onClick={() => setTrack(tr.id, { muted: !tr.muted })} />}
                    {tr.type === 'audio' && <Button size="xs" variant="ghost" icon="headphones" className={tr.solo ? 'warn-on' : ''} tip="Solo" onClick={() => setTrack(tr.id, { solo: !tr.solo })} />}
                    <Button size="xs" variant="ghost" icon={tr.locked ? 'lock' : 'unlock'} active={!!tr.locked} tip={tr.locked ? 'Desbloquear' : 'Bloquear'} onClick={() => setTrack(tr.id, { locked: !tr.locked })} />
                    {tr.type !== 'scene' && <div style={{ marginLeft: 4, flex: 1, minWidth: 0 }}>
                      <Slider value={tr.volume ?? 1} min={0} max={1.5} step={0.01} width="100%" tip={`Volumen ${Math.round((tr.volume ?? 1) * 100)} %`}
                        onChange={(v) => setTrack(tr.id, { volume: v }, false)} onCommit={() => p.onChange(structuredClone(tl), true)} />
                    </div>}
                  </div>
                </div>
              </div>
            ) })}
          </div>
        </div>
        <div className="tl-scroll" ref={scroll}
          onScroll={(e) => { if (heads.current) heads.current.style.transform = `translateY(${-e.currentTarget.scrollTop}px)` }}
          onWheel={(e) => {
            if (!e.ctrlKey) return
            e.preventDefault()
            const el = scroll.current!
            const tAt = timeAt(e.clientX)
            const np = Math.max(2, Math.min(600, pps * (e.deltaY < 0 ? 1.18 : 1 / 1.18)))
            p.setPps(np)
            requestAnimationFrame(() => { el.scrollLeft = tAt * np - (e.clientX - el.getBoundingClientRect().left) })
          }}
          onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel}
          onDragOver={onDragOver} onDragLeave={() => setDropRow(null)} onDrop={onDrop}>
          <div style={{ width, position: 'relative', minHeight: '100%' }}>
            <div className="tl-ruler" style={{ width }}
              onPointerDown={(e) => { drag.current = { mode: 'scrub' }; (e.target as HTMLElement).setPointerCapture(e.pointerId); p.onSeek(q(timeAt(e.clientX))) }}>
              {ticks.map((k, i) => <div key={i} className={`tick ${k.minor ? 'minor' : ''}`} style={{ left: k.x }}>{k.label && <span>{k.label}</span>}</div>)}
              {(tl.notes || []).map((n) => <div key={n.id} className="note-mark" style={{ left: n.t * pps }} data-tip={n.text} onPointerDown={(e) => { e.stopPropagation(); p.onNote(n.id) }}><Icon name="message" size={9} stroke={2.5} /></div>)}
            </div>
            <div className="tl-after-end" style={{ left: tl.duration * pps }} />
            <div className="tl-end" style={{ left: tl.duration * pps }} />
            {tl.tracks.map((tr, ri) => (
              <div key={tr.id} className={`tl-track ${dropRow === ri ? 'drop' : ''} ${tr.locked ? 'locked' : ''}`} style={{ ['--tc' as any]: TYPE_COLOR[trackRole(tr)] }}
                onPointerDown={(e) => {
                  if (e.target !== e.currentTarget) return
                  if (e.pointerType === 'touch') { tap.current = { kind: 'bg', x: e.clientX, y: e.clientY }; return }
                  p.setSelected([]); p.onSeek(q(timeAt(e.clientX)))
                }}>
                {tr.clips.map((c) => {
                  const left = c.start * pps, w = Math.max(3, c.duration * pps)
                  if (left + w < view.left - 200 || left > view.left + view.width + 200) return null
                  const kind = clipKind(tr, c), role = clipRole(tr, c)
                  const name = c.name || c.src.split('/').pop()
                  // porción visible (para no dibujar ondas de miles de píxeles fuera de pantalla)
                  const vx0 = Math.max(0, view.left - left - 50), vx1 = Math.min(w, view.left + view.width - left + 50)
                  return (
                    <div key={c.id} className={`clip ${kind} ${role} ${p.selected.includes(c.id) ? 'sel' : ''} ${c.muted || tr.muted || tr.hidden ? 'muted' : ''}`} style={{ left, width: w }}
                      data-tip={TOUCH ? undefined : `${c.src} · ${fmtTime(c.start, true, p.fps)} → ${fmtTime(c.start + c.duration, true, p.fps)} (${c.duration.toFixed(2)} s)`}
                      onPointerDown={(e) => onClipDown(e, c, tr, 'move')}
                      onDoubleClick={() => p.onSeek(c.start)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        // Mantener apretado (tablet) abre el menú, salvo que el clip ya se esté arrastrando.
                        if (drag.current?.moved) return
                        drag.current = null; tap.current = null
                        if (!p.selected.includes(c.id)) p.setSelected([c.id])
                        p.onClipMenu(c, tr, e.clientX, e.clientY)
                      }}>
                      {kind === 'image' && <div className="clip-thumb" style={{ backgroundImage: `url("${projectUrl(p.projectId, c.src)}")` }} />}
                      {(kind === 'scene' || kind === 'video') && <div className="clip-pattern" />}
                      {(kind === 'audio' || kind === 'video') && p.waveforms && vx1 > vx0 && (
                        <div className="clip-wave"><Wave projectId={p.projectId} src={c.src} inSec={c.in || 0} pps={pps} x0={vx0} x1={vx1} height={ROW - 10 - (TOUCH ? 20 : 17)} color={WAVE[role] || WAVE.audio} /></div>
                      )}
                      {c.fadeIn ? <FadeRamp w={c.fadeIn * pps} /> : null}
                      {c.fadeOut ? <FadeRamp w={c.fadeOut * pps} out /> : null}
                      {w > 26 && <div className="lbl">{w > 60 && <Icon name={TYPE_ICON[role] || TYPE_ICON[kind]} size={11} stroke={2} />}<span className="ellipsis">{name}</span></div>}
                      {w > 110 && <div className="sub">{c.duration.toFixed(2)}s{c.volume != null && c.volume !== 1 ? ` · ${Math.round(c.volume * 100)}%` : ''}</div>}
                      <div className="hdl l" onPointerDown={(e) => onClipDown(e, c, tr, 'l')} />
                      <div className="hdl r" onPointerDown={(e) => onClipDown(e, c, tr, 'r')} />
                    </div>
                  )
                })}
              </div>
            ))}
            <div className={`tl-empty-row ${dropRow === tl.tracks.length ? 'tl-track drop' : ''}`} onPointerDown={(e) => { if (e.pointerType === 'touch') tap.current = { kind: 'bg', x: e.clientX, y: e.clientY }; else p.setSelected([]) }} />
            <div className="playhead" style={{ left: t * pps }} />
            {snapX != null && <div className="snapline" style={{ left: snapX }} />}
          </div>
        </div>
      </div>
    </div>
  )
}
