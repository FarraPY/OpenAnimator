/**
 * «Guardar como plantilla» en el iPhone: el proyecto (escenas, guías, timeline y, si se quiere, los medios) queda entre
 * las plantillas propias. Claude puede mirar el proyecto y escribir su guía de estilo (paleta, tipografía, animaciones,
 * ritmo): la lee cuando un proyecto nuevo sale de esa plantilla (backend: templates:saveProject con `describe`).
 */
import { useEffect, useState } from 'react'
import { call, on } from '../../api'
import { useApp } from '../../App'
import { useDialogs } from '../../components/Dialogs'
import { Button, Spinner, Switch, TextArea, TextInput } from '../../ui/kit'
import { Group, Row, Sheet } from './PhoneApp'

export default function PhoneSaveTemplate({ projectId, projectName, onClose }: { projectId: string; projectName: string; onClose: () => void }) {
  const { toast } = useApp()
  const dlg = useDialogs()
  const [name, setName] = useState(projectName)
  const [desc, setDesc] = useState('')
  const [assets, setAssets] = useState(true)
  const [canDescribe, setCanDescribe] = useState(false)
  const [describe, setDescribe] = useState(true)
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState('')
  useEffect(() => {
    call<boolean>('templates:canDescribe').then(setCanDescribe).catch(() => {})
    return on('templates:progress', (e: { projectId: string; text: string }) => { if (e.projectId === projectId) setStep(e.text) })
  }, [projectId])

  const save = async (withClaude: boolean) => {
    const n = name.trim()
    if (!n || busy) return
    setBusy(true); setStep('')
    try {
      await call('templates:saveProject', projectId, { name: n, description: desc.trim(), includeAssets: assets, describe: withClaude })
      toast(`Plantilla «${n}» guardada: aparece al crear un proyecto`)
      onClose()
    } catch (e: any) {
      setBusy(false)
      const msg = String(e?.message || e)
      if (!withClaude) { toast(msg, true); return }
      if (/cancelado/.test(msg)) return // lo canceló el usuario
      if (await dlg.confirm({ title: 'Claude no pudo describir el estilo', message: `${msg}. ¿Guardar la plantilla igual, con una guía básica?`, ok: 'Guardar igual' })) save(false)
    }
  }
  const working = busy && describe && canDescribe

  return (
    <Sheet title="Guardar como plantilla" onClose={onClose} persistent={busy} closeX
      footer={working
        ? <Button size="lg" onClick={() => call('templates:cancelDescribe')}>Cancelar</Button>
        : <Button variant="primary" size="lg" icon="bookmark" onClick={() => save(describe && canDescribe)} loading={busy} disabled={!name.trim()}>Guardar plantilla</Button>}>
      <div className="tpl-save">
        <TextInput value={name} onChange={setName} placeholder="Nombre de la plantilla" clearable />
        <TextArea rows={2} value={desc} onChange={setDesc} placeholder={canDescribe && describe ? 'Descripción (si la dejás vacía, la escribe Claude)' : 'Descripción: qué estilo tiene y para qué sirve'} />
      </div>
      <Group foot="Se guardan las escenas, las guías (brief) y el timeline activo. No se copian las exportaciones.">
        <Row icon="image" label="Incluir medios" detail="Imágenes, voces, música y videos. Sin ellos pesa menos y lleva sólo el estilo.">
          <Switch checked={assets} onChange={setAssets} disabled={busy} />
        </Row>
        {canDescribe && <Row icon="sparkles" label="Que Claude describa el estilo" detail="Mira las escenas y anota paleta, tipografía, animaciones y ritmo, para que los proyectos nuevos lo sigan. Usa tu plan y tarda unos minutos.">
          <Switch checked={describe} onChange={setDescribe} disabled={busy} />
        </Row>}
      </Group>
      {working && <div className="tpl-save-step"><Spinner size={14} /><span>{step || 'Claude está mirando el proyecto…'}</span></div>}
      {dlg.element}
    </Sheet>
  )
}
