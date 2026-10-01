/**
 * Timeline del teléfono, como en los editores de video de celular: el cursor queda fijo en el centro y se desliza el
 * tiempo con el dedo (deslizar = buscar). Pellizcar acerca o aleja. Tocar un clip lo selecciona: seleccionado se
 * arrastra para moverlo y sus manijas lo recortan; abajo aparecen sus acciones.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Clip, fmtTime, Timeline as TL, Track } from '../../api'
import { useApp } from '../../App'
import { TYPE_COLOR, TYPE_ICON, trackRole } from '../../components/Timeline'
import { Icon, IconName } from '../../ui/icons'
import { Slider, Switch } from '../../ui/kit'
import { Actions, Group, Row, Sheet } from './PhoneApp'

const RULER = 26, ROW = 54
const STEPS = [1 / 30, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
const isImage = (src: string) => /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(src)
const clipName = (c: Clip) => c.name || c.src.split('/').pop()!.replace(/\.[^.]+$/, '')
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

type Props = {
  tl: TL; t: number; fps: number; playing: boolean; sel: string[]; projectId: string
  onScrub: (t: number, phase: 'start' | 'move' | 'end') => void
  onSelect: (ids: string[]) => void
  onChange: (next: TL, commit?: boolean) => void
  onSplit: () => void; onDelete: () => void; onDuplicate: () => void
  onPatchClip: (id: string, p: Partial<Clip>, commit?: boolean) => void
  onPatchTrack: (id: string, p: Partial<Track>) => void
  onAdd: () => void; onNote: () => void; onAsk: (text: string) => void
}

export default function PhoneTimeline(p: Props) {
  const { tl, t } = p
  const { toast } = useApp()
  const sc = useRef<HTMLDivElement>(null)
  const [vw, setVw] = useState(() => window.innerWidth)
  const [left, setLeft] = useState(0)
  const [pps, setPps] = useState(() => clamp((window.innerWidth * 0.85) / Math.max(4, tl.duration), 6, 120))
  const [clipSheet, setClipSheet] = useState(false)
  const [trackAct, setTrackAct] = useState<Track | null>(null)
  const ppsRef = useRef(pps); ppsRef.current = pps
  const pRef = useRef(p); pRef.current = p
  const touching = useRef(false)
  const ours = useRef(-1) // el scrollLeft que puso el programa (no es el dedo)
  const half = vw / 2
  const width = half * 2 + tl.duration * pps + 80

  useEffect(() => {
    const el = sc.current!
    const ro = new ResizeObserver(() => setVw(el.clientWidth))
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
    ours.current = -1
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

  const ticks = useMemo(() => {
    const step = STEPS.find((s) => s * pps >= 64) || 600
    const a = Math.max(0, Math.floor((left - half) / pps / step) * step), b = Math.min(tl.duration + step, (left + vw) / pps + step)
    const out: Array<{ x: number; label: string }> = []
    for (let s = a; s <= b; s += step) out.push({ x: half + s * pps, label: fmtTime(s, step < 1, p.fps) })
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
  const hasAudio = selClip && (selClip.tr.type === 'audio' || (selClip.tr.type === 'video' && !isImage(selClip.c.src)))
  const color = (tr: Track, c: Clip) => TYPE_COLOR[tr.type === 'video' && isImage(c.src) ? 'image' : tr.type === 'audio' ? trackRole(tr) : tr.type] || 'var(--accent)'
  const icon = (tr: Track): IconName => TYPE_ICON[tr.type === 'audio' ? trackRole(tr) : tr.type] || 'film'

  return (
    <div className="tlp">
      <div className="tlp-scroll" ref={sc} onScroll={onScroll} onClick={(e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('tlp-track')) p.onSelect([]) }}>
        <div className="tlp-content" style={{ width, height: RULER + Math.max(1, tl.tracks.length) * ROW + 12 }}>
          <div className="tlp-ruler">
            {ticks.map((k) => <span key={k.x} className="tlp-tick" style={{ left: k.x }}>{k.label}</span>)}
            {(tl.notes || []).map((n) => <button key={n.id} className="tlp-note" style={{ left: half + n.t * pps }} aria-label={n.text} onClick={() => { p.onScrub(n.t, 'move'); toast(`Nota: ${n.text}`, 'info') }} />)}
          </div>
          {tl.tracks.map((tr, i) => (
            <div key={tr.id} className={`tlp-track ${tr.muted || tr.hidden ? 'off' : ''}`} style={{ top: RULER + i * ROW }}>
              <button className="tlp-trk" style={{ color: TYPE_COLOR[tr.type === 'audio' ? trackRole(tr) : tr.type] }} aria-label={tr.name} onClick={() => setTrackAct(tr)}>
                <Icon name={tr.muted ? 'volume-x' : tr.hidden ? 'eye-off' : icon(tr)} size={15} />
                <span className="tlp-trk-name">{tr.name}</span>
              </button>
              {tr.clips.map((c) => {
                const on = p.sel.includes(c.id)
                return (
                  <div key={c.id} className={`tlp-clip ${on ? 'on' : ''} ${c.muted ? 'muted' : ''}`} style={{ left: half + c.start * pps, width: Math.max(4, c.duration * pps), ['--c' as any]: color(tr, c) }}
                    onPointerDown={(e) => down(e, c, tr, 'move')} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { tap.current = null; up() }}>
                    {c.fadeIn ? <span className="tlp-fade l" style={{ width: c.fadeIn * pps }} /> : null}
                    {c.fadeOut ? <span className="tlp-fade r" style={{ width: c.fadeOut * pps }} /> : null}
                    <span className="tlp-clip-name">{clipName(c)}</span>
                    {on && <>
                      <span className="tlp-h l" onPointerDown={(e) => down(e, c, tr, 'l')} onPointerMove={move} onPointerUp={up}><i /></span>
                      <span className="tlp-h r" onPointerDown={(e) => down(e, c, tr, 'r')} onPointerMove={move} onPointerUp={up}><i /></span>
                    </>}
                  </div>
                )
              })}
            </div>
          ))}
          <button className="tlp-add" style={{ left: half + tl.duration * pps + 14, top: RULER + 6 }} aria-label="Agregar medios" onClick={p.onAdd}><Icon name="plus" size={22} /></button>
        </div>
      </div>
      <div className="tlp-cursor" />

      <div className="tlp-bar">
        {selClip ? <>
          <BarBtn icon="scissors" label="Dividir" disabled={!underCursor} onClick={p.onSplit} />
          <BarBtn icon="copy" label="Duplicar" onClick={p.onDuplicate} />
          <BarBtn icon={hasAudio ? 'volume-2' : 'sliders'} label={hasAudio ? 'Sonido' : 'Ajustes'} onClick={() => setClipSheet(true)} />
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

      {clipSheet && selClip && <ClipSheet clip={selClip.c} track={selClip.tr} fps={p.fps} audio={!!hasAudio} onPatch={(x, commit) => p.onPatchClip(selClip.c.id, x, commit)} onClose={() => setClipSheet(false)} />}
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

/** Ajustes del clip: volumen y fundidos (con sonido) o la duración (escenas e imágenes). */
function ClipSheet({ clip, track, fps, audio, onPatch, onClose }: { clip: Clip; track: Track; fps: number; audio: boolean; onPatch: (p: Partial<Clip>, commit?: boolean) => void; onClose: () => void }) {
  const vol = clip.volume ?? 1
  const maxFade = Math.max(0.1, Math.min(5, clip.duration / 2))
  return (
    <Sheet title={clipName(clip)} onClose={onClose}>
      <div className="t3 sheet-sub">{track.name} · {fmtTime(clip.start, true, fps)} → {fmtTime(clip.start + clip.duration, true, fps)} ({clip.duration.toFixed(2)} s)</div>
      <Group>
        {audio && <>
          <Row label="Silenciar el clip"><Switch checked={!!clip.muted} onChange={(v) => onPatch({ muted: v })} /></Row>
          <Row label="Volumen" detail={`${Math.round(vol * 100)} %`} stack><Slider value={vol} min={0} max={2} step={0.01} onChange={(v) => onPatch({ volume: +v.toFixed(2) }, false)} onCommit={() => onPatch({}, true)} /></Row>
        </>}
        <Row label="Entrada gradual" detail={`${(clip.fadeIn || 0).toFixed(1)} s`} stack><Slider value={clip.fadeIn || 0} min={0} max={maxFade} step={0.1} onChange={(v) => onPatch({ fadeIn: +v.toFixed(2) }, false)} onCommit={() => onPatch({}, true)} /></Row>
        <Row label="Salida gradual" detail={`${(clip.fadeOut || 0).toFixed(1)} s`} stack><Slider value={clip.fadeOut || 0} min={0} max={maxFade} step={0.1} onChange={(v) => onPatch({ fadeOut: +v.toFixed(2) }, false)} onCommit={() => onPatch({}, true)} /></Row>
      </Group>
    </Sheet>
  )
}
