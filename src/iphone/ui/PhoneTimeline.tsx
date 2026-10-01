/**
 * Timeline del teléfono, como en los editores de video de celular: el cursor queda fijo en el centro y se desliza el
 * tiempo con el dedo (deslizar = buscar). Pellizcar acerca o aleja. Tocar un clip lo selecciona: seleccionado se
 * arrastra para moverlo y sus manijas lo recortan; abajo aparecen sus acciones. Las escenas se ven como tarjetas con
 * una miniatura del video en ese momento; el audio, con su onda.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { call, Clip, fmtTime, on, Timeline as TL, Track } from '../../api'
import { useApp } from '../../App'
import { TYPE_COLOR, TYPE_ICON, WAVE, Wave, trackRole } from '../../components/Timeline'
import { Icon, IconName } from '../../ui/icons'
import { Actions } from './PhoneApp'

const RULER = 28
const COL = 48 // la columna de las pistas (ícono)
const STEPS = [1 / 30, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
const isImage = (src: string) => /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(src)
const clipName = (c: Clip) => c.name || c.src.split('/').pop()!.replace(/\.[^.]+$/, '')
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const ruler = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

type Props = {
  tl: TL; tlId: string; t: number; fps: number; playing: boolean; sel: string[]; projectId: string
  onScrub: (t: number, phase: 'start' | 'move' | 'end') => void
  onSelect: (ids: string[]) => void
  onChange: (next: TL, commit?: boolean) => void
  onSplit: () => void; onDelete: () => void; onDuplicate: () => void
  onPatchTrack: (id: string, p: Partial<Track>) => void
  onAdd: () => void; onNote: () => void; onAsk: (text: string) => void
  /** Abrir los ajustes del clip elegido (la pestaña Timeline de la hoja). */
  onInspect: () => void
}

// ── miniaturas de las escenas ─────────────────────────────────────────────────
// Un fotograma del video en cada escena (frames:png, el compositor oculto), de a uno y en segundo plano; quedan
// guardadas mientras no cambien el clip ni los archivos del proyecto.
const thumbs = new Map<string, string>()
const thumbKey = (projectId: string, tlId: string, c: Clip) => `${projectId}|${tlId}|${c.id}|${c.src}|${c.start}|${c.in || 0}|${c.duration}`
function useSceneThumbs(projectId: string, tlId: string, clips: Clip[], busy: boolean) {
  const [, bump] = useState(0)
  useEffect(() => on('project:changed', (e: { id: string; kind: string }) => {
    if (e.id !== projectId || e.kind === 'timeline') return
    for (const k of [...thumbs.keys()]) if (k.startsWith(projectId + '|')) thumbs.delete(k)
    bump((x) => x + 1)
  }), [projectId])
  const want = clips.filter((c) => !thumbs.has(thumbKey(projectId, tlId, c)))
  useEffect(() => {
    if (busy || !want.length) return
    let stop = false
    const timer = window.setTimeout(async () => {
      for (const c of want) {
        if (stop) return
        const k = thumbKey(projectId, tlId, c)
        try { thumbs.set(k, 'data:image/png;base64,' + await call<string>('frames:png', projectId, tlId, c.start + Math.min(1.5, c.duration / 2), 240)) } catch { thumbs.set(k, '') }
        if (!stop) bump((x) => x + 1)
      }
    }, 600)
    return () => { stop = true; clearTimeout(timer) }
  }, [busy, want.map((c) => c.id).join()])
  return (c: Clip) => sceneThumb(projectId, tlId, c)
}
/** La miniatura de una escena, si ya está hecha (también la usa el inspector del clip). */
export const sceneThumb = (projectId: string, tlId: string, c: Clip) => thumbs.get(thumbKey(projectId, tlId, c)) || ''

export default function PhoneTimeline(p: Props) {
  const { tl, t } = p
  const { toast, settings } = useApp()
  const waves = settings?.editor.waveforms !== false
  const sc = useRef<HTMLDivElement>(null)
  const [vw, setVw] = useState(() => window.innerWidth)
  const [vh, setVh] = useState(320)
  const [left, setLeft] = useState(0)
  const [pps, setPps] = useState(() => clamp((window.innerWidth * 0.85) / Math.max(4, tl.duration), 6, 120))
  const [trackAct, setTrackAct] = useState<Track | null>(null)
  const ppsRef = useRef(pps); ppsRef.current = pps
  const pRef = useRef(p); pRef.current = p
  const touching = useRef(false)
  const ours = useRef(NaN) // el scrollLeft que puso el programa (no es el dedo; con -1, llegar a 0 no movía el cursor)
  const half = vw / 2
  const width = half * 2 + tl.duration * pps + 80
  // Las pistas llenan el alto que hay: entre 38 y 96 px cada una (con la hoja de Claude abierta queda compacto).
  const row = clamp(Math.floor((vh - RULER - 8) / Math.max(1, tl.tracks.length)), 38, 96)

  useEffect(() => {
    const el = sc.current!
    const ro = new ResizeObserver(() => { setVw(el.clientWidth); setVh(el.clientHeight) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // El tiempo manda al desplazamiento (reproducción, cortes, zoom) salvo cuando el dedo está moviendo el timeline.
  useLayoutEffect(() => {
    const el = sc.current!
    if (touching.current) return
    const x = t * pps
    if (Math.abs(el.scrollLeft - x) >= 1) { ours.current = Math.round(x); el.scrollLeft = x }
  }, [t, pps, vw])

  const onScroll = () => {
    const el = sc.current!
    setLeft(el.scrollLeft)
    if (!touching.current && Math.abs(el.scrollLeft - ours.current) <= 1.5) return
    ours.current = NaN
    p.onScrub(el.scrollLeft / ppsRef.current, 'move')
  }

  // Pellizcar con dos dedos: zoom (el cursor queda en el centro: el tiempo actual no se mueve).
  useEffect(() => {
    const el = sc.current!
    let pinch: { d0: number; pps0: number } | null = null
    const dist = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY)
    const start = (e: TouchEvent) => {
      touching.current = true
      if (e.touches.length === 1) pRef.current.onScrub(el.scrollLeft / ppsRef.current, 'start')
      if (e.touches.length === 2) pinch = { d0: Math.max(10, dist(e)), pps0: ppsRef.current }
    }
    const move = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return
      e.preventDefault()
      setPps(clamp(pinch.pps0 * (dist(e) / pinch.d0), 2, 400))
    }
    const end = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null
      if (!e.touches.length) touching.current = false
    }
    // Safari: el gesto de pellizcar de la página (zoom) no debe agrandar la app.
    const noZoom = (e: Event) => e.preventDefault()
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', end)
    el.addEventListener('touchcancel', end)
    el.addEventListener('gesturestart', noZoom)
    el.addEventListener('gesturechange', noZoom)
    // En la PC (pruebas): Ctrl + rueda.
    const wheel = (e: WheelEvent) => { if (!e.ctrlKey) return; e.preventDefault(); setPps((v) => clamp(v * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 2, 400)) }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => {
      el.removeEventListener('touchstart', start); el.removeEventListener('touchmove', move); el.removeEventListener('touchend', end); el.removeEventListener('touchcancel', end)
      el.removeEventListener('gesturestart', noZoom); el.removeEventListener('gesturechange', noZoom); el.removeEventListener('wheel', wheel)
    }
  }, [])

  // La regla: un número cada tanto (que entre cómodo) y marcas chicas entre medio.
  const ticks = useMemo(() => {
    const step = STEPS.find((s) => s * pps >= 70) || 600
    const minor = step / (step / 5 * pps >= 7 ? 5 : 2)
    const a = Math.max(0, Math.floor((left - half) / pps / step) * step), b = Math.min(tl.duration + step, (left + vw) / pps + step)
    const out: Array<{ x: number; label?: string }> = []
    for (let s = a; s <= b + 1e-6; s += minor) {
      const major = Math.abs(s / step - Math.round(s / step)) < 1e-6
      out.push({ x: half + s * pps, label: major ? (step < 1 ? fmtTime(s, true, p.fps) : ruler(s)) : undefined })
    }
    return out
  }, [pps, left, vw, tl.duration, p.fps])

  // ── mover y recortar el clip seleccionado ───────────────────────────────────
  const drag = useRef<{ mode: 'move' | 'l' | 'r'; id: string; trackId: string; x0: number; orig: TL; clip: Clip; pts: number[]; moved: boolean } | null>(null)
  const tap = useRef<{ id: string; x: number; y: number } | null>(null)
  const snapPts = (exclude: string) => {
    const pts = [0, t, tl.duration, ...(tl.notes || []).map((n) => n.t)]
    for (const tr of tl.tracks) for (const c of tr.clips) if (c.id !== exclude) pts.push(c.start, c.start + c.duration)
    return pts
  }
  const snap = (v: number, pts: number[]) => {
    const thr = 10 / pps
    let best = v, bd = thr
    for (const s of pts) { const d = Math.abs(s - v); if (d < bd) { bd = d; best = s } }
    return { v: best, snapped: bd < thr }
  }
  const down = (e: React.PointerEvent, c: Clip, tr: Track, mode: 'move' | 'l' | 'r') => {
    e.stopPropagation()
    if (!p.sel.includes(c.id)) { tap.current = { id: c.id, x: e.clientX, y: e.clientY }; return } // el dedo desliza el timeline
    if (tr.locked) return
    drag.current = { mode, id: c.id, trackId: tr.id, x0: e.clientX, orig: structuredClone(tl), clip: { ...c }, pts: snapPts(c.id), moved: false }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const move = (e: React.PointerEvent) => {
    if (tap.current && Math.hypot(e.clientX - tap.current.x, e.clientY - tap.current.y) > 10) tap.current = null
    const d = drag.current
    if (!d) return
    if (!d.moved && Math.abs(e.clientX - d.x0) < 6) return
    d.moved = true
    const dt = (e.clientX - d.x0) / pps
    const next: TL = structuredClone(d.orig)
    const c = next.tracks.find((x) => x.id === d.trackId)!.clips.find((x) => x.id === d.id)!
    const o = d.clip, minDur = 1 / p.fps
    if (d.mode === 'move') {
      let start = Math.max(0, o.start + dt)
      const a = snap(start, d.pts), b = snap(start + o.duration, d.pts)
      start = a.snapped ? a.v : b.snapped ? b.v - o.duration : start
      c.start = +Math.max(0, start).toFixed(3)
    } else if (d.mode === 'l') {
      let delta = snap(o.start + dt, d.pts).v - o.start
      delta = Math.min(Math.max(delta, -(o.in || 0), -o.start), o.duration - minDur)
      c.start = +(o.start + delta).toFixed(3); c.in = +((o.in || 0) + delta).toFixed(3); c.duration = +(o.duration - delta).toFixed(3)
    } else {
      let dur = Math.max(minDur, snap(o.start + o.duration + dt, d.pts).v - o.start)
      const srcDur = (o as any).srcDur
      if (srcDur) dur = Math.min(dur, srcDur - (o.in || 0))
      c.duration = +dur.toFixed(3)
    }
    p.onChange(next, false)
  }
  const up = () => {
    const d = drag.current
    drag.current = null
    if (d?.moved) { const cur = pRef.current.tl; p.onChange(structuredClone(cur), true) }
    if (tap.current) { p.onSelect([tap.current.id]); tap.current = null }
  }

  const selClip = useMemo(() => { for (const tr of tl.tracks) { const c = tr.clips.find((x) => p.sel.includes(x.id)); if (c) return { c, tr } } return null }, [tl, p.sel])
  const underCursor = tl.tracks.some((tr) => tr.clips.some((c) => t > c.start + 0.02 && t < c.start + c.duration - 0.02 && (!p.sel.length || p.sel.includes(c.id))))
  const color = (tr: Track, c: Clip) => TYPE_COLOR[tr.type === 'video' && isImage(c.src) ? 'image' : tr.type === 'audio' ? trackRole(tr) : tr.type] || 'var(--accent)'
  const icon = (tr: Track): IconName => TYPE_ICON[tr.type === 'audio' ? trackRole(tr) : tr.type] || 'film'

  // Las escenas: su número (en orden) y una miniatura, para las que están cerca de la pantalla.
  const scenes = useMemo(() => {
    const num = new Map<string, number>()
    for (const tr of tl.tracks) if (tr.type === 'scene') [...tr.clips].sort((a, b) => a.start - b.start).forEach((c, i) => num.set(c.id, i + 1))
    return num
  }, [tl])
  const near = (c: Clip) => { const cx = half + c.start * pps, cw = Math.max(4, c.duration * pps); return !(cx + cw < left - vw || cx > left + 2 * vw) }
  const thumb = useSceneThumbs(p.projectId, p.tlId, tl.tracks.filter((tr) => tr.type === 'scene' && !tr.hidden).flatMap((tr) => tr.clips.filter(near)), p.playing)

  return (
    <div className="tlp">
      <div className="tlp-view">
        <div className="tlp-scroll" ref={sc} onScroll={onScroll} onClick={(e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('tlp-track')) p.onSelect([]) }}>
          <div className="tlp-content" style={{ width, height: RULER + Math.max(1, tl.tracks.length) * row + 8, ['--row' as any]: `${row}px` }}>
            <div className="tlp-ruler">
              <div className="tlp-corner" />
              {ticks.map((k) => k.label ? <span key={k.x} className="tlp-tick" style={{ left: k.x }}>{k.label}</span> : <i key={k.x} className="tlp-minor" style={{ left: k.x }} />)}
              {(tl.notes || []).map((n) => <button key={n.id} className="tlp-note" style={{ left: half + n.t * pps }} aria-label={n.text} onClick={() => { p.onScrub(n.t, 'move'); toast(`Nota: ${n.text}`, 'info') }} />)}
            </div>
            {tl.tracks.map((tr, i) => (
              <div key={tr.id} className={`tlp-track ${i % 2 ? 'alt' : ''} ${tr.muted || tr.hidden ? 'off' : ''}`} style={{ top: RULER + i * row }}>
                <button className="tlp-trk" style={{ color: TYPE_COLOR[tr.type === 'audio' ? trackRole(tr) : tr.type] }} aria-label={tr.name} onClick={() => setTrackAct(tr)}>
                  <Icon name={tr.muted ? 'volume-x' : tr.hidden ? 'eye-off' : icon(tr)} size={19} />
                  {row >= 62 && <span className="tlp-trk-name">{tr.name}</span>}
                </button>
                {tr.clips.map((c) => {
                  const on = p.sel.includes(c.id)
                  // Sólo lo que está en pantalla (más una pantalla de margen a cada lado): con cientos de clips el
                  // timeline sigue liviano. El seleccionado se dibuja siempre (se puede estar arrastrando).
                  if (!on && !near(c)) return null
                  const w = Math.max(4, c.duration * pps)
                  const wave = waves && (tr.type === 'audio' || (tr.type === 'video' && !isImage(c.src)))
                  // Los fundidos: el clip se angosta en esa punta (como en los editores de audio).
                  const fi = Math.min(w / 2, (c.fadeIn || 0) * pps), fo = Math.min(w / 2, (c.fadeOut || 0) * pps)
                  const shape = !on && (fi || fo) ? `polygon(${fi}px 0, calc(100% - ${fo}px) 0, 100% 100%, 0 100%)` : undefined
                  const n = scenes.get(c.id)
                  return (
                    <div key={c.id} className={`tlp-clip ${on ? 'on' : ''} ${c.muted ? 'muted' : ''} ${wave ? 'wave' : ''} ${n ? 'scene' : ''}`}
                      style={{ left: half + c.start * pps, width: w, clipPath: shape, ['--c' as any]: color(tr, c), ...(n && thumb(c) ? { ['--thumb' as any]: `url(${thumb(c)})` } : {}) }}
                      onPointerDown={(e) => down(e, c, tr, 'move')} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { tap.current = null; up() }}>
                      {wave && (() => {
                        // La onda real, dibujada sólo cerca de lo que se ve del clip, en tramos de una pantalla: al
                        // desplazar el timeline se redibuja una vez por pantalla y no en cada cuadro.
                        const x = half + c.start * pps
                        const q = Math.max(1, vw), a = Math.floor((left - x) / q) * q
                        const x0 = Math.max(0, a), x1 = Math.min(w, a + 2 * q)
                        const named = row >= 50 && w >= 64
                        return x1 > x0 && <div className={`tlp-wave ${named ? '' : 'full'}`}><Wave projectId={p.projectId} src={c.src} inSec={c.in || 0} pps={pps} x0={x0} x1={x1} height={Math.max(12, row - (named ? 30 : 16))} color={WAVE[tr.type === 'audio' ? trackRole(tr) : 'video'] || WAVE.audio} fill /></div>
                      })()}
                      {n ? <span className="tlp-clip-name"><small>{String(n).padStart(2, '0')}</small>{clipName(c)}</span>
                        : (!wave || (row >= 50 && w >= 64)) && <span className="tlp-clip-name">{clipName(c)}</span>}
                      {on && <>
                        <span className="tlp-h l" onPointerDown={(e) => down(e, c, tr, 'l')} onPointerMove={move} onPointerUp={up}><i /></span>
                        <span className="tlp-h r" onPointerDown={(e) => down(e, c, tr, 'r')} onPointerMove={move} onPointerUp={up}><i /></span>
                      </>}
                    </div>
                  )
                })}
              </div>
            ))}
            <button className="tlp-add" style={{ left: half + tl.duration * pps + 14, top: RULER + 5, height: row - 10 }} aria-label="Agregar medios" onClick={p.onAdd}><Icon name="plus" size={22} /></button>
          </div>
        </div>
        <div className="tlp-cursor" />
      </div>

      <div className="tlp-bar" data-glass>
        {selClip ? <>
          <BarBtn icon="scissors" label="Dividir" disabled={!underCursor} onClick={p.onSplit} />
          <BarBtn icon="copy" label="Duplicar" onClick={p.onDuplicate} />
          <BarBtn icon="sliders" label="Ajustes" onClick={p.onInspect} />
          <BarBtn icon="sparkles" label="Claude" onClick={() => p.onAsk(`Sobre el clip «${clipName(selClip.c)}» (${selClip.c.src}, de ${fmtTime(selClip.c.start, true, p.fps)} a ${fmtTime(selClip.c.start + selClip.c.duration, true, p.fps)}): `)} />
          <BarBtn icon="trash" label="Borrar" danger onClick={p.onDelete} />
        </> : <>
          <BarBtn icon="plus" label="Agregar" onClick={p.onAdd} />
          <BarBtn icon="scissors" label="Dividir" disabled={!underCursor} onClick={p.onSplit} />
          <BarBtn icon="note" label="Nota" onClick={p.onNote} />
          <BarBtn icon="zoom-out" label="Alejar" onClick={() => setPps((v) => clamp(v / 1.5, 2, 400))} />
          <BarBtn icon="zoom-in" label="Acercar" onClick={() => setPps((v) => clamp(v * 1.5, 2, 400))} />
        </>}
      </div>

      {trackAct && <Actions title={trackAct.name} onClose={() => setTrackAct(null)} items={[
        ...(trackAct.type !== 'scene' ? [{ label: trackAct.muted ? 'Activar el sonido' : 'Silenciar la pista', icon: trackAct.muted ? 'volume-2' : 'volume-x', onSelect: () => p.onPatchTrack(trackAct.id, { muted: !trackAct.muted }) }] : []),
        ...(trackAct.type !== 'audio' ? [{ label: trackAct.hidden ? 'Mostrar la pista' : 'Ocultar la pista', icon: trackAct.hidden ? 'eye' : 'eye-off', onSelect: () => p.onPatchTrack(trackAct.id, { hidden: !trackAct.hidden }) }] : []),
        { label: trackAct.locked ? 'Desbloquear' : 'Bloquear (no se mueve)', icon: trackAct.locked ? 'unlock' : 'lock', onSelect: () => p.onPatchTrack(trackAct.id, { locked: !trackAct.locked }) },
      ]} />}
    </div>
  )
}

function BarBtn({ icon, label, onClick, disabled, danger }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return <button className={`tlp-btn ${danger ? 'danger' : ''}`} disabled={disabled} onClick={onClick}><Icon name={icon} size={21} /><span>{label}</span></button>
}
