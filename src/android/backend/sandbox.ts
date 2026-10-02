/**
 * oa_ejecutar_js: el código de Claude corre en app/runtime/sandbox.html, en un iframe con sandbox="allow-scripts" del
 * origen de los proyectos (origen opaco: no ve la interfaz, el puente ni los archivos; su CSP no deja usar la red).
 * Lo único que puede hacer afuera es pedir por mensajes leer o guardar archivos del proyecto (`io`). En el teléfono y
 * la tablet, donde no hay terminal: sintetizar sonidos con Web Audio, dibujar con canvas, calcular.
 */
import { runtimeUrl } from '../../platform'

export type SandboxIO = { read: (rel: string) => Promise<ArrayBuffer>; write: (rel: string, data: Uint8Array) => Promise<void> }
export type SandboxResult = { logs: string[]; value?: string; error?: string; saved: string[] }

export function runJs(projectId: string, code: string, io: SandboxIO, timeoutMs = 60000): Promise<SandboxResult> {
  const f = document.createElement('iframe')
  f.setAttribute('sandbox', 'allow-scripts')
  f.setAttribute('aria-hidden', 'true')
  f.style.cssText = 'position:fixed;left:-20px;top:-20px;width:1px;height:1px;border:0;opacity:0;pointer-events:none'
  const saved: string[] = []
  return new Promise((resolve) => {
    let over = false
    const finish = (r: Omit<SandboxResult, 'saved'>) => {
      if (over) return
      over = true
      clearTimeout(timer)
      removeEventListener('message', onReady)
      f.remove()
      resolve({ logs: r.logs || [], value: r.value, error: r.error, saved })
    }
    const timer = setTimeout(() => finish({ logs: [], error: `Tardó más de ${Math.round(timeoutMs / 1000)} s y se cortó` }), timeoutMs)
    const onReady = (e: MessageEvent) => {
      if (e.source !== f.contentWindow || e.data?.type !== 'oa-sandbox-ready') return
      removeEventListener('message', onReady)
      const ch = new MessageChannel()
      ch.port1.onmessage = async ({ data: m }) => {
        if (m?.type === 'done') return finish(m)
        try {
          if (m?.op === 'read') { const ab = await io.read(String(m.path)); ch.port1.postMessage({ id: m.id, value: ab }, [ab]) }
          else if (m?.op === 'write') { await io.write(String(m.path), new Uint8Array(m.data)); saved.push(String(m.path)); ch.port1.postMessage({ id: m.id, value: String(m.path) }) }
          else throw new Error('Operación desconocida')
        } catch (err: any) { ch.port1.postMessage({ id: m?.id, error: String(err?.message || err) }) }
      }
      f.contentWindow!.postMessage({ type: 'run', code }, '*', [ch.port2])
    }
    addEventListener('message', onReady)
    f.src = runtimeUrl(projectId, 'sandbox.html')
    document.body.appendChild(f)
  })
}
