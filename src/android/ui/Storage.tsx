/**
 * La tarjeta SD en la tablet: dónde se guardan los proyectos, cuánto lugar queda en cada lado y
 * mover proyectos entre la tablet y la tarjeta (con progreso y cancelar). Un proyecto en la tarjeta
 * se abre, se edita y se exporta ahí mismo; los videos que exporta también quedan en la tarjeta.
 */
import { useEffect, useState } from 'react'
import { call, fmtSize, on } from '../../api'
import { useApp } from '../../App'
import Modal from '../../components/Modal'
import { isAndroid } from '../../platform'
import { Button, Progress } from '../../ui/kit'

export type Volume = 'internal' | 'sd'
type Place = { free: number; total: number; projects: number; used: Record<string, number> }
export type StorageInfo = {
  newProjects: Volume
  /** Proyectos que quedaron en una tarjeta que ahora no está. */
  missing: number
  cardLabel: string
  internal: Place
  sd: (Place & { label: string; uuid: string }) | null
}
export const PLACE: Record<Volume, string> = { internal: 'la tablet', sd: 'la tarjeta SD' }

/** Estado del almacenamiento (sólo en Android); se actualiza al poner o sacar la tarjeta. */
export function useStorage() {
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const load = () => { if (isAndroid()) call<StorageInfo>('storage:info').then(setInfo).catch(() => {}) }
  useEffect(() => { load(); return on('storage:changed', load) }, [])
  return { info, reload: load }
}

type Prog = { to: Volume; id: string; name: string; index: number; count: number; done: number; total: number }

/** Mover proyectos con un diálogo de progreso: `move(ids, 'sd')`, y `element` en la página. */
export function useMoveProjects() {
  const { toast } = useApp()
  const [run, setRun] = useState<{ to: Volume; prog?: Prog; cancelling?: boolean } | null>(null)
  useEffect(() => on('storage:progress', (p: Prog) => setRun((r) => (r ? { ...r, prog: p } : r))), [])
  const move = async (ids: string[], to: Volume) => {
    if (!ids.length || run) return
    setRun({ to })
    try {
      const r = await call<{ moved: number; count: number; cancelled: boolean }>('storage:move', ids, to)
      if (r.cancelled) toast(r.moved ? `Se movieron ${r.moved} de ${r.count}; los demás quedaron donde estaban.` : 'Cancelado: quedó todo donde estaba.', 'info')
      else if (r.moved) toast(r.moved === 1 ? `Proyecto movido a ${PLACE[to]}` : `${r.moved} proyectos movidos a ${PLACE[to]}`)
    } catch (e: any) { toast(e.message, true) } finally { setRun(null) }
  }
  const cancel = () => { setRun((r) => (r ? { ...r, cancelling: true } : r)); call('storage:cancel').catch(() => {}) }
  const p = run?.prog
  const element = run && (
    <Modal title={`Moviendo a ${PLACE[run.to]}`} icon={run.to === 'sd' ? 'sd' : 'tablet'} size="narrow" persistent onClose={cancel}
      footer={<><div className="grow" /><Button onClick={cancel} disabled={run.cancelling}>{run.cancelling ? 'Cancelando…' : 'Cancelar'}</Button></>}>
      <div className="col" style={{ gap: 12 }}>
        <div className="ellipsis" style={{ fontWeight: 600 }}>{p ? p.name : 'Preparando…'}{p && p.count > 1 && <span className="t3" style={{ fontWeight: 400 }}> · {p.index + 1} de {p.count}</span>}</div>
        <Progress value={p && p.total ? (p.done / p.total) * 100 : 0} indeterminate={!p || !p.total} />
        <div className="t3 tabnum" style={{ fontSize: 13, minHeight: 18 }}>{p && p.total ? `${fmtSize(p.done)} de ${fmtSize(p.total)}` : ''}</div>
        <div className="t3" style={{ fontSize: 12.5 }}>Se copia, se comprueba la copia y recién ahí se borra el original: si algo falla o cancelás, el proyecto queda donde estaba.</div>
      </div>
    </Modal>
  )
  return { move, moving: !!run, element }
}
