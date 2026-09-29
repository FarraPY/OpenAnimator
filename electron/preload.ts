import { contextBridge, ipcRenderer, webUtils } from 'electron'

/** Puente seguro renderer ⇄ main. Cada llamada devuelve el valor o lanza el error del main. */
async function call(ch: string, ...args: unknown[]) {
  const r = await ipcRenderer.invoke(ch, ...args)
  if (!r.ok) throw new Error(r.error)
  return r.value
}

function on(ch: string, cb: (payload: any) => void) {
  const fn = (_e: unknown, p: any) => cb(p)
  ipcRenderer.on(ch, fn)
  return () => { ipcRenderer.removeListener(ch, fn) }
}

contextBridge.exposeInMainWorld('oa', {
  call,
  on,
  pathForFile: (f: File) => webUtils.getPathForFile(f),
})
