/**
 * Lo que la app de Android agrega a nivel global: el botón "atrás", abrir un proyecto .zip que
 * llega desde otra app (Archivos, Drive, WhatsApp, Gmail…) con "Abrir con" o "Compartir", y avisar
 * por qué se cerró la app o su motor web la vez anterior (app:exits).
 */
import { useEffect, useRef } from 'react'
import { afterPaint, call, on } from '../../api'
import { useApp } from '../../App'
import { useDialogs } from '../../components/Dialogs'
import { recoveredBoot } from '../../platform'
import { installBack } from './back'

/** Un cierre: el registro de Android (kind android), el motor web que se cerró (web) o un error de Java (java). */
type Exit = {
  kind: 'android' | 'web' | 'java' | 'error'; at: number
  reason?: string; status?: number; importance?: number; process?: string; description?: string; pssMB?: number; rssMB?: number
  crashed?: boolean; priority?: number; doing?: string
  thread?: string; error?: string; stack?: string
  availMB?: number; lowMemory?: boolean; javaMB?: number
}

const REASONS: Record<string, string> = {
  'low-memory': 'Android cerró la app por falta de memoria',
  crash: 'La app se cerró por un error',
  'crash-native': 'La app se cerró por un error en código nativo (el motor web, el codificador de video…)',
  anr: 'La app dejó de responder y Android la cerró',
  'excessive-resource-usage': 'Android cerró la app por usar demasiados recursos',
  'initialization-failure': 'La app no pudo arrancar',
  'dependency-died': 'Android cerró la app porque se cerró algo de lo que depende (p. ej. el motor web al actualizarse)',
}

function exitText(x: Exit): string {
  if (x.kind === 'web') {
    const what = x.crashed ? 'El motor web (el que dibuja la app y las escenas) falló y se volvió a abrir' : 'Android cerró el motor web (el que dibuja la app y las escenas) para recuperar memoria y se volvió a abrir'
    return what + (x.doing === 'exportando' ? ', durante una exportación' : '')
  }
  if (x.kind === 'java') return 'Error de la app: ' + (x.error || '')
  if (x.kind === 'error') return x.error || 'Error'
  if (x.reason === 'signaled') return x.status === 9 ? 'Android cerró la app (casi siempre es por falta de memoria)' : `Android cerró la app (señal ${x.status})`
  return REASONS[x.reason || ''] || 'Android cerró la app' + (x.description ? ': ' + x.description : '')
}

/** Algo que suele pasar por falta de memoria (con escenas muy pesadas). */
const memoryLike = (x: Exit) => x.kind === 'web' || x.reason === 'low-memory' || (x.reason === 'signaled' && x.status === 9) || !!x.lowMemory

function when(at: number): string {
  const d = new Date(at), now = new Date()
  const hm = d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === now.toDateString() ? 'Hoy ' + hm : d.toLocaleDateString('es', { day: 'numeric', month: 'short' }) + ' ' + hm
}

/** Para pegar en un mensaje: el equipo, la versión y cada cierre con todo lo que se registró. */
async function exitDetails(xs: Exit[]): Promise<string> {
  const info = await call<any>('app:info').catch(() => null)
  const d = info?.device || {}
  const lines = [`OpenAnimator ${d.versionName || info?.version || ''} (${d.versionCode || ''}) · ${[d.manufacturer, d.model].filter(Boolean).join(' ')} · Android ${d.release || ''} (API ${d.sdk || ''}) · ${d.webview || ''} · memoria ${d.memory ? (d.memory / 2 ** 30).toFixed(1) + ' GB' : '?'}`]
  for (const x of xs) {
    const { stack, ...rest } = x
    lines.push('', `${new Date(x.at).toLocaleString('es')} · ${exitText(x)}`, JSON.stringify(rest))
    if (stack) lines.push(stack.trimEnd())
  }
  return lines.join('\n')
}

export default function AndroidIntegration() {
  const { go, toast, route } = useApp()
  const dlg = useDialogs()
  const exitDlg = useDialogs()
  const busy = useRef(false)

  useEffect(() => { installBack() }, [])

  // Por qué se cerró la vez anterior (Android lo registra; el motor web y los errores de Java, la app). Una vez cada cierre.
  useEffect(() => {
    const back = recoveredBoot && route.page === 'editor'
    return afterPaint(async () => {
      const all = ((await call<Exit[]>('app:exits').catch(() => null)) || []).sort((a, b) => a.at - b.at)
      // Si no se pudo leer el registro de Android, va en los detalles pero no abre el aviso (sería en cada arranque).
      const xs = all.filter((x) => x.kind !== 'error')
      if (!xs.length) {
        if (recoveredBoot) toast(back ? 'Android reinició la app (seguramente por falta de memoria): volviste a tu proyecto.' : 'Android reinició la app (seguramente por falta de memoria).', 'info')
        return
      }
      const memory = xs.some(memoryLike)
      const copy = await exitDlg.confirm({
        title: xs.some((x) => x.kind === 'android' || x.kind === 'java') ? 'La app se cerró' : 'La app se volvió a abrir',
        icon: 'alert', ok: 'Copiar detalles', cancel: 'Cerrar',
        message: <>
          {xs.map((x, i) => <div key={i} style={{ marginBottom: 6 }}><b>{when(x.at)}</b> · {exitText(x)}.</div>)}
          {back && <div style={{ marginBottom: 6 }}>Volviste al proyecto que tenías abierto.</div>}
          {memory && <div style={{ marginTop: 10 }}>Suele pasar con escenas muy pesadas para la tablet: muchos elementos animados a la vez, desenfoques o sombras grandes, imágenes enormes. Podés pedirle a Claude que la simplifique (menos elementos, partículas en un solo canvas, sin desenfoques grandes).</div>}
          <div style={{ marginTop: 10 }}>«Copiar detalles» copia lo que se registró, para mandarlo si hace falta.</div>
        </>,
      })
      if (!copy) return
      try { await call('clipboard:text', await exitDetails(all)); toast('Detalles copiados') } catch (e: any) { toast(e.message, true) }
    })
  }, [])

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

  return <>{dlg.element}{exitDlg.element}</>
}
