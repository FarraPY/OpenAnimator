/**
 * El registro de la app (logs/app.log en el iPhone; lo escribe Swift, ios/OpenAnimator/AppLog.swift, que también lo
 * manda en vivo a la computadora si se activa en Ajustes › Depuración). Acá se junta lo de la página: errores y avisos
 * (con «Registro detallado», toda la consola), Claude Code (turnos, resultados, herramientas que fallan, sus errores)
 * y la exportación (fases, velocidad cada 2 s y el informe final). Va en tandas al puente.
 */
import { isNative, nativeCall } from './native'

type Level = 'INFO' | 'WARN' | 'ERROR'
let queue: Array<[Level, string, string, number]> = []
let timer = 0
let verbose = (() => { try { return localStorage.getItem('oa.logVerbose') === '1' } catch { return false } })()

export const logVerbose = () => verbose
export function setLogVerbose(v: boolean) {
  verbose = v
  try { localStorage.setItem('oa.logVerbose', v ? '1' : '0') } catch { /* ignore */ }
}

export function appLog(level: Level, source: string, text: string) {
  if (!isNative()) return
  queue.push([level, source, text.length > 6000 ? text.slice(0, 6000) + '…' : text, Date.now()])
  if (level === 'ERROR' || queue.length > 200) flush()
  else if (!timer) timer = window.setTimeout(flush, 400)
}

function flush() {
  clearTimeout(timer)
  timer = 0
  if (!queue.length) return
  const lines = queue
  queue = []
  void nativeCall('log', { lines }).catch(() => {})
}

const fmt = (a: unknown[]) => a.map((x) => {
  if (typeof x === 'string') return x
  if (x instanceof Error) return x.stack || x.message
  try { return JSON.stringify(x) } catch { return String(x) }
}).join(' ')
const secs = (ms?: number) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} s`)

/** Se engancha a la consola, a los errores sin atrapar y a los eventos de la app (`on`: el de src/api.ts). */
export function installAppLog(on: (ch: string, cb: (p: any) => void) => unknown) {
  if (!isNative()) return
  for (const [m, level] of [['error', 'ERROR'], ['warn', 'WARN'], ['log', 'INFO'], ['info', 'INFO']] as const) {
    const orig = console[m].bind(console)
    console[m] = (...a: unknown[]) => { orig(...a); if (level !== 'INFO' || verbose) appLog(level, 'consola', fmt(a)) }
  }
  addEventListener('error', (e) => appLog('ERROR', 'página', `${e.message} (${e.filename || '?'}:${e.lineno || '?'})`))
  addEventListener('unhandledrejection', (e) => appLog('ERROR', 'página', `Promesa rechazada: ${fmt([e.reason])}`))
  addEventListener('pagehide', flush)

  // Exportación: cada fase, la velocidad cada 2 s y el informe (o el error con sus detalles).
  let shown = 0
  on('export:progress', (p) => {
    if (p.phase === 'render') {
      if (Date.now() - shown < 2000 && p.done !== p.total) return
      shown = Date.now()
      appLog('INFO', 'exportar', `${p.message} · ${p.fps ? p.fps.toFixed(1) : '—'} fps · faltan ${p.eta != null ? Math.round(p.eta) + ' s' : '—'} · van ${secs(p.elapsed * 1000)}`)
    } else appLog(p.phase === 'error' ? 'ERROR' : 'INFO', 'exportar', `${p.phase}: ${p.message}${p.details ? '\n' + p.details : ''}`)
  })

  // Claude: lo que se pide, cómo termina cada turno, avisos y herramientas que fallan.
  const tools = new Map<string, string>()
  on('chat:event', (e) => {
    const it = e?.item
    if (e?.type === 'item' && it) {
      if (it.kind === 'user') appLog('INFO', 'claude', `Pedido: ${String(it.text || '').slice(0, 300)}${it.images ? ` (+${it.images} imágenes)` : ''}`)
      else if (it.kind === 'result') appLog(it.isError ? 'ERROR' : 'INFO', 'claude', `Fin del turno · ${secs(it.durationMs)}${it.cost ? ` · US$ ${it.cost.toFixed(4)}` : ''}${it.isError ? ` · error: ${it.text}` : ''}`)
      else if (it.kind === 'notice') appLog(it.level === 'error' ? 'ERROR' : it.level === 'warn' ? 'WARN' : 'INFO', 'claude', String(it.text || ''))
      else if (it.kind === 'permission') appLog('INFO', 'claude', `Pide permiso para ${it.name}`)
      else if (it.kind === 'tool') { tools.set(it.id, it.name); if (verbose) appLog('INFO', 'claude', `Herramienta ${it.name}`) }
    } else if (e?.type === 'patch' && it && (it.isError || it.status === 'error')) {
      appLog('WARN', 'claude', `Falló la herramienta ${it.name || tools.get(it.id) || ''}: ${String(it.result || '').slice(0, 600)}`)
    }
  })
  let phase = ''
  on('claude:installProgress', (p) => { if (p?.phase && p.phase !== phase) { phase = p.phase; appLog('INFO', 'claude', `Instalando Claude Code: ${p.phase}`) } })
}
