/**
 * Panel lateral de la pantalla de Claude (tablet): el fotograma actual del video, que se actualiza
 * solo cuando Claude cambia archivos, datos del timeline y pedidos rápidos.
 */
import { useEffect, useRef, useState } from 'react'
import { call, fmtTime, on, Timeline } from '../../api'
import { Icon } from '../../ui/icons'
import { Button, Spinner } from '../../ui/kit'

export default function ClaudeSide({ projectId, tlId, tl, t, fps, visible, busy, onGoEditor, onAsk }: {
  projectId: string; tlId: string; tl: Timeline; t: number; fps: number; visible: boolean; busy: boolean
  onGoEditor: () => void; onAsk: (text: string) => void
}) {
  const [img, setImg] = useState<string | null>(null)
  const [at, setAt] = useState(t)
  const [loading, setLoading] = useState(false)
  const timer = useRef(0)
  const live = useRef({ visible, t, tlId })
  live.current = { visible, t, tlId }

  const refresh = async () => {
    const cur = live.current
    if (!cur.visible) return
    setLoading(true)
    try {
      const data = await call<string>('frames:png', projectId, cur.tlId, cur.t, 800)
      setImg(`data:image/png;base64,${data}`); setAt(cur.t)
    } catch { /* el visor del editor muestra el error */ } finally { setLoading(false) }
  }
  // Al entrar a la pantalla y cuando cambia el instante o el timeline.
  useEffect(() => { if (visible) { window.clearTimeout(timer.current); timer.current = window.setTimeout(refresh, 250) } }, [visible, tlId, t])
  // Claude guardó algo: se vuelve a dibujar (agrupado, sin ahogar a la tablet mientras trabaja).
  useEffect(() => on('project:changed', (e: { id: string }) => {
    if (e.id !== projectId) return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(refresh, 2200)
  }), [projectId])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const clips = tl.tracks.reduce((n, x) => n + x.clips.length, 0)
  const notes = tl.notes?.length || 0
  return (
    <aside className="claude-side">
      <div className="cs-title"><Icon name="monitor" size={16} />Vista previa<div className="grow" />
        <Button size="sm" variant="ghost" icon="refresh" tip="Volver a dibujar" onClick={refresh} loading={loading} />
      </div>
      <div className="cs-frame" onClick={onGoEditor}>
        {img ? <img src={img} alt="" /> : <div className="cs-empty">{loading ? <Spinner size={20} /> : <Icon name="film" size={28} />}</div>}
        <span className="cs-tc">{fmtTime(at, true, fps)}</span>
        {busy && <span className="cs-busy"><Spinner size={16} /></span>}
      </div>
      <Button icon="film" onClick={onGoEditor}>Ver en el editor</Button>
      <div className="cs-stats">
        <div className="cs-stat"><div className="v tabnum">{fmtTime(tl.duration)}</div><div className="l">duración</div></div>
        <div className="cs-stat"><div className="v tabnum">{clips}</div><div className="l">clip{clips === 1 ? '' : 's'} · {tl.tracks.length} pista{tl.tracks.length === 1 ? '' : 's'}</div></div>
      </div>
      <div className="cs-title" style={{ marginTop: 4 }}><Icon name="zap" size={16} />Pedidos rápidos</div>
      <div className="cs-actions">
        {notes > 0 && <Button variant="subtle" icon="message" onClick={() => onAsk('Resolvé las notas que dejé en el timeline.')}>Resolver mis notas ({notes})</Button>}
        <Button variant="subtle" icon="grid" onClick={() => onAsk('Revisá todo el video con la hoja de contactos y mejorá lo que se vea flojo o repetitivo.')}>Revisar todo el video</Button>
        <Button variant="subtle" icon="scan" onClick={() => onAsk('Hacé una auditoría de layout y corregí todo lo que se superponga o salga de cuadro.')}>Arreglar el layout</Button>
        <Button variant="subtle" icon="camera" onClick={() => onAsk(`Mirá el fotograma en ${at.toFixed(2)} s y decime qué mejorarías.`)}>Opinar sobre este fotograma</Button>
      </div>
    </aside>
  )
}
