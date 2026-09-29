/**
 * Diálogos de texto y confirmación con el estilo de la app
 * (window.prompt no existe en Electron y window.confirm se ve como del sistema).
 *
 *   const dlg = useDialogs()
 *   const name = await dlg.prompt({ title: 'Renombrar', value: 'x' })
 *   if (await dlg.confirm({ title: '¿Borrar?', danger: true })) …
 *   return <>{…}{dlg.element}</>
 */
import { ReactNode, useState } from 'react'
import Modal from './Modal'
import { Button, TextInput } from '../ui/kit'
import { IconName } from '../ui/icons'

type PromptOpts = { title: string; label?: string; value?: string; placeholder?: string; ok?: string; icon?: IconName; subtitle?: ReactNode }
type ConfirmOpts = { title: string; message?: ReactNode; ok?: string; cancel?: string; danger?: boolean; icon?: IconName }

export function useDialogs() {
  const [state, setState] = useState<null | { kind: 'prompt'; o: PromptOpts; resolve: (v: string | null) => void; value: string } | { kind: 'confirm'; o: ConfirmOpts; resolve: (v: boolean) => void }>(null)
  const prompt = (o: PromptOpts) => new Promise<string | null>((resolve) => setState({ kind: 'prompt', o, resolve, value: o.value || '' }))
  const confirm = (o: ConfirmOpts) => new Promise<boolean>((resolve) => setState({ kind: 'confirm', o, resolve }))
  let element: ReactNode = null
  if (state?.kind === 'prompt') {
    const close = (v: string | null) => { state.resolve(v); setState(null) }
    const ok = () => { const v = state.value.trim(); if (v) close(v) }
    element = (
      <Modal size="narrow" title={state.o.title} subtitle={state.o.subtitle} icon={state.o.icon || 'edit'} onClose={() => close(null)}
        footer={<><div className="grow" /><Button onClick={() => close(null)}>Cancelar</Button><Button variant="primary" onClick={ok} disabled={!state.value.trim()}>{state.o.ok || 'Aceptar'}</Button></>}>
        <div className="field">
          {state.o.label && <label className="field-label">{state.o.label}</label>}
          <TextInput autoFocus value={state.value} placeholder={state.o.placeholder} onChange={(v) => setState({ ...state, value: v })} onEnter={ok} />
        </div>
      </Modal>
    )
  } else if (state?.kind === 'confirm') {
    const close = (v: boolean) => { state.resolve(v); setState(null) }
    element = (
      <Modal size="narrow" title={state.o.title} icon={state.o.icon || (state.o.danger ? 'alert' : 'help')} onClose={() => close(false)}
        footer={<><div className="grow" /><Button onClick={() => close(false)}>{state.o.cancel || 'Cancelar'}</Button><Button variant={state.o.danger ? 'danger' : 'primary'} autoFocus onClick={() => close(true)}>{state.o.ok || 'Aceptar'}</Button></>}>
        {state.o.message && <div className="t2" style={{ lineHeight: 1.55 }}>{state.o.message}</div>}
      </Modal>
    )
  }
  return { prompt, confirm, element }
}
