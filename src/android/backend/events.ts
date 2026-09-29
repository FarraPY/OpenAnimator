/** Eventos del "proceso principal" hacia la interfaz (el equivalente de webContents.send). */
const listeners = new Map<string, Set<(p: any) => void>>()

export function send(ch: string, payload: unknown) {
  listeners.get(ch)?.forEach((cb) => { try { cb(payload) } catch (e) { console.error(e) } })
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
