/**
 * Lo que la app de Android agrega a nivel global: el botón "atrás" y abrir un proyecto .zip que
 * llega desde otra app (Archivos, Drive, WhatsApp, Gmail…) con "Abrir con" o "Compartir".
 */
import { useEffect, useRef } from 'react'
import { call, on } from '../../api'
import { useApp } from '../../App'
import { useDialogs } from '../../components/Dialogs'
import { installBack } from './back'

export default function AndroidIntegration() {
  const { go, toast } = useApp()
  const dlg = useDialogs()
  const busy = useRef(false)

  useEffect(() => { installBack() }, [])

  useEffect(() => {
    const check = async () => {
      if (busy.current) return
      const f = await call<{ path: string; name: string; size: number } | null>('app:takePendingOpen').catch(() => null)
      if (!f?.path) return
      busy.current = true
      try {
        if (!/\.zip$/i.test(f.name) && !(await dlg.confirm({ title: 'Abrir archivo', message: `«${f.name}» no parece un proyecto .zip. ¿Intentar importarlo igual?`, ok: 'Importar' }))) return
        if (!(await dlg.confirm({ title: 'Importar proyecto', icon: 'import', message: <>¿Importar <b>{f.name}</b> a OpenAnimator? Se agrega como un proyecto nuevo (no reemplaza a ninguno).</>, ok: 'Importar' }))) return
        toast('Importando el proyecto…', 'info')
        const p = await call<{ id: string; name: string }>('projects:importZip', f.path)
        if (p) { toast(`Importado «${p.name}»`); go({ page: 'editor', id: p.id }) }
      } catch (e: any) { toast(e.message, true) } finally { busy.current = false }
    }
    check()
    return on('app:open', check)
  }, [])

  return <>{dlg.element}</>
}
