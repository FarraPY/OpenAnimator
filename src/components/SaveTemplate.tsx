import { useState } from 'react'
import { call } from '../api'
import { useApp } from '../App'
import Modal from './Modal'
import { Icon } from '../ui/icons'
import { Button, Switch, TextArea, TextInput } from '../ui/kit'

/** Guarda un proyecto como plantilla propia para reutilizar escenas, motores, estilo y timeline. */
export default function SaveTemplate({ projectId, projectName, onClose, onSaved }: { projectId: string; projectName: string; onClose: () => void; onSaved?: (id: string) => void }) {
  const { toast } = useApp()
  const [name, setName] = useState(projectName)
  const [desc, setDesc] = useState('')
  const [assets, setAssets] = useState(true)
  const [busy, setBusy] = useState(false)
  const [stamp] = useState(() => Date.now())
  const save = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      const r = await call('templates:saveProject', projectId, { name: name.trim(), description: desc.trim(), includeAssets: assets })
      toast(`Plantilla «${name.trim()}» guardada`)
      onSaved?.(r.id); onClose()
    } catch (e: any) { toast(e.message, true); setBusy(false) }
  }
  return (
    <Modal icon="bookmark" title="Guardar como plantilla" subtitle="Reutilizá lo que te gustó de este proyecto en otros nuevos." onClose={onClose}
      footer={<><div className="grow" /><Button onClick={onClose}>Cancelar</Button><Button variant="primary" icon="bookmark" onClick={save} loading={busy} disabled={!name.trim()}>Guardar plantilla</Button></>}>
      <div className="save-tpl">
        <div className="save-tpl-img"><Icon name="template" size={26} stroke={1.3} /><img src={`oa://p/${encodeURIComponent(projectId)}/thumbnail.jpg?${stamp}`} alt="" onError={(e) => { e.currentTarget.style.display = 'none' }} /></div>
        <div className="fields" style={{ gridTemplateColumns: '1fr', gap: 12, flex: 1 }}>
          <div className="field"><label className="field-label">Nombre</label><TextInput autoFocus value={name} onChange={setName} onEnter={save} /></div>
          <div className="field"><label className="field-label">Descripción</label><TextArea rows={3} value={desc} onChange={setDesc} placeholder="Qué estilo tiene y para qué sirve (la ve Claude cuando la usás)." /></div>
        </div>
      </div>
      <div className="set-card" style={{ marginTop: 16 }}>
        <div className="set-row"><div className="set-text"><div className="set-label">Incluir medios</div><div className="set-desc">Imágenes, voces, música y videos del proyecto. Sin medios, la plantilla pesa menos y sólo lleva el estilo.</div></div><div className="set-ctrl"><Switch checked={assets} onChange={setAssets} /></div></div>
      </div>
      <div className="t3" style={{ fontSize: 12, marginTop: 12, lineHeight: 1.55 }}>
        Se guardan las escenas, motores, guías (brief) y el timeline activo. No se copian las exportaciones ni las cachés.
      </div>
    </Modal>
  )
}
