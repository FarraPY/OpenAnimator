/** Eventos del "proceso principal" hacia la interfaz (el equivalente de webContents.send). */
const listeners = new Map<string, Set<(p: any) => void>>()

/**
 * Como el IPC de Electron, la interfaz recibe copias y nunca los objetos vivos del backend: si no,
 * p. ej. un mensaje del chat que el backend agrega a su lista aparecería dos veces en la pantalla.
 */
export function copy<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v
  try { return structuredClone(v) } catch { return v } // algo que no se puede copiar (no debería pasar)
}

export function send(ch: string, payload: unknown) {
  const set = listeners.get(ch)
  if (!set?.size) return
  const p = copy(payload)
  set.forEach((cb) => { try { cb(p) } catch (e) { console.error(e) } })
}

export function on(ch: string, cb: (p: any) => void) {
  if (!listeners.has(ch)) listeners.set(ch, new Set())
  listeners.get(ch)!.add(cb)
  return () => { listeners.get(ch)?.delete(cb) }
}

/** Un archivo del proyecto cambió desde el backend (Claude, un plugin): el editor recarga. */
export function projectChanged(id: string, file: string) {
  const f = file.replace(/\\/g, '/')
  const kind = f === 'project.json' ? 'project' : f.startsWith('timelines/') ? 'timeline' : 'files'
  send('project:changed', { id, kind, file: f })
}
