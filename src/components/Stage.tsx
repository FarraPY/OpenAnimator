import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'

export type StageHandle = { reload: () => void; probe: (src: string) => Promise<{ duration: number; mode: string }>; audit: (t: number) => Promise<any[]> }

type Props = { projectId: string; tlId: string; t: number; playing: boolean; rate: number; width: number; height: number; reloadKey: number; onError?: (m: string) => void; bg?: string; safeAreas?: boolean; thirds?: boolean; onScale?: (s: number) => void; pad?: number }

/** Vista previa: el MISMO compositor que usa la exportación, escalado a la ventana. */
const Stage = forwardRef<StageHandle, Props>(function Stage({ projectId, tlId, t, playing, rate, width, height, reloadKey, onError, bg = 'dark', safeAreas, thirds, onScale, pad = 20 }, ref) {
  const wrap = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const [box, setBox] = useState({ scale: 0.5, x: 0, y: 0 })
  const ready = useRef(false)
  const inflight = useRef(false)
  const pending = useRef<number | null>(null)
  const reqs = useRef(new Map<string, (v: any) => void>())
  const last = useRef({ t: -1, playing: false })

  useLayoutEffect(() => {
    const el = wrap.current!
    const fit = () => {
      const W = el.clientWidth - pad * 2, H = el.clientHeight - pad * 2
      const scale = Math.max(0.05, Math.min(W / width, H / height))
      setBox({ scale, x: (el.clientWidth - width * scale) / 2, y: (el.clientHeight - height * scale) / 2 })
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [width, height, pad])
  useEffect(() => { onScale?.(box.scale) }, [box.scale])

  const post = (m: any) => frame.current?.contentWindow?.postMessage({ target: 'oa-compositor', ...m }, '*')

  const flush = () => {
    if (!ready.current || inflight.current || pending.current == null) return
    const tt = pending.current
    pending.current = null
    inflight.current = true
    post({ type: 'seek', t: tt, playing: last.current.playing, rate })
  }

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const m = e.data
      if (!m || m.source !== 'oa-compositor' || e.source !== frame.current?.contentWindow) return
      if (m.type === 'ready') { ready.current = true; inflight.current = false; pending.current = last.current.t >= 0 ? last.current.t : 0; flush() }
      else if (m.type === 'rendered') { inflight.current = false; flush() }
      else if (m.type === 'error') { inflight.current = false; onError?.(m.message); flush() }
      else if ((m.type === 'probe' || m.type === 'audit') && reqs.current.has(m.id)) { reqs.current.get(m.id)!(m.type === 'probe' ? m.result : m.issues); reqs.current.delete(m.id) }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  useEffect(() => {
    const wasPlaying = last.current.playing
    last.current = { t, playing }
    if (wasPlaying && !playing) post({ type: 'pause', t })
    pending.current = t
    // Si el render anterior quedó colgado (escena pesada), no bloquear para siempre.
    if (inflight.current && !playing) setTimeout(() => { inflight.current = false; flush() }, 1500)
    flush()
  }, [t, playing])

  useEffect(() => { ready.current = false }, [projectId, tlId, reloadKey])

  useImperativeHandle(ref, () => ({
    reload: () => { ready.current = false; post({ type: 'reload' }); setTimeout(() => { ready.current = true; pending.current = last.current.t; inflight.current = false; flush() }, 400) },
    probe: (src) => new Promise((res) => { const id = Math.random().toString(36).slice(2); reqs.current.set(id, res); post({ type: 'probe', id, src }); setTimeout(() => { if (reqs.current.has(id)) { reqs.current.delete(id); res({ duration: 0, mode: 'desconocido' }) } }, 20000) }),
    audit: (tt) => new Promise((res) => { const id = Math.random().toString(36).slice(2); reqs.current.set(id, res); post({ type: 'audit', id, t: tt }) }),
  }))

  const src = `oa://p/${encodeURIComponent(projectId)}/__oa/compositor.html?p=${encodeURIComponent(projectId)}&tl=${encodeURIComponent(tlId)}&mode=preview&k=${reloadKey}`
  return (
    <div className={`stage-wrap bg-${bg}`} ref={wrap}>
      <iframe ref={frame} key={src} className="stage-frame" src={src} title="stage"
        style={{ width, height, transform: `translate(${box.x}px, ${box.y}px) scale(${box.scale})` }} />
      {(safeAreas || thirds) && (
        <div className="stage-guides" style={{ left: box.x, top: box.y, width: width * box.scale, height: height * box.scale }}>
          {safeAreas && <><div className="safe" style={{ inset: '3.5%' }} /><div className="safe" style={{ inset: '10%', opacity: .7 }} /></>}
          {thirds && <>{[33.333, 66.666].map((v) => <div key={'v' + v} className="third" style={{ left: `${v}%`, top: 0, bottom: 0, width: 1 }} />)}{[33.333, 66.666].map((v) => <div key={'h' + v} className="third" style={{ top: `${v}%`, left: 0, right: 0, height: 1 }} />)}</>}
        </div>
      )}
    </div>
  )
})
export default Stage
