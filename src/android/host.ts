/**
 * Acceso a lo nativo de Android (Java, ver android/app/java/…/Bridge.java).
 *
 * En la tablet el objeto window.AndroidBridge lo inyecta el WebView. Para desarrollar y probar en un
 * navegador de escritorio, android/dev/server.mjs imita ese puente por HTTP (mismos métodos).
 */
export type DeviceInfo = {
  platform: 'android'; sdk: number; release: string; manufacturer: string; brand: string; model: string; device: string; soc: string
  versionName: string; versionCode: number; abi: string; webview?: string; density: number; screenWidth: number; screenHeight: number
  memory: number; dataDir: string
}

export type Host = {
  kind: 'android' | 'dev'
  appOrigin: string
  /** Origen de los proyectos: distinto del de la interfaz, así una escena no puede tocar la app. */
  projectOrigin: string
  info: DeviceInfo
  /** Llamada rápida y sincrónica (archivos, claves…). Lanza Error con el mensaje de Java. */
  call<T = any>(method: string, args?: Record<string, unknown>): T
  /**
   * Llamada larga (red, selector de archivos, zip…). `onEvent` recibe progreso o texto parcial.
   * Con `id` + `signal` se puede cancelar (http.request).
   */
  callAsync<T = any>(method: string, args?: Record<string, unknown>, opts?: AsyncOpts | ((e: any) => void)): Promise<T>
  /** Eventos del sistema: pause, resume, open (un .zip abierto desde otra app). */
  onEvent(name: string, cb: (data: any) => void): () => void
  /** URL para leer un archivo de la carpeta de datos (fetch, <img>, <audio>…), del mismo origen que la interfaz. */
  fsUrl(path: string): string
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; onEvent?: (e: any) => void }
export type AsyncOpts = { onEvent?: (e: any) => void; id?: string; signal?: AbortSignal }
const asOpts = (o?: AsyncOpts | ((e: any) => void)): AsyncOpts => (typeof o === 'function' ? { onEvent: o } : o || {})

const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/')

function events() {
  const listeners = new Map<string, Set<(d: any) => void>>()
  ;(window as any).__oaNativeEvent = (name: string, data: any) => listeners.get(name)?.forEach((cb) => { try { cb(data) } catch (e) { console.error(e) } })
  return (name: string, cb: (d: any) => void) => {
    if (!listeners.has(name)) listeners.set(name, new Set())
    listeners.get(name)!.add(cb)
    return () => { listeners.get(name)?.delete(cb) }
  }
}

function androidHost(): Host {
  const B = (window as any).AndroidBridge
  const init = JSON.parse(B.init())
  const token: string | undefined = init.token
  if (!token) throw new Error('El puente con Android no está disponible (recargá la app).')
  const pending = new Map<string, Pending>()
  ;(window as any).__oaNative = (id: string, msg: any) => {
    const p = pending.get(id)
    if (!p) return
    if (msg && typeof msg === 'object' && 'event' in msg) { p.onEvent?.(msg); return }
    pending.delete(id)
    if (msg?.ok) p.resolve(msg.value)
    else p.reject(new Error(msg?.error || 'Error de Android'))
  }
  let seq = 0
  return {
    kind: 'android',
    appOrigin: location.origin,
    projectOrigin: 'https://oaproject.androidplatform.net',
    info: init.info,
    call(method, args = {}) {
      const r = JSON.parse(B.call(token, method, JSON.stringify(args)))
      if (!r.ok) throw new Error(r.error || 'Error de Android')
      return r.value
    },
    callAsync(method, args = {}, opts) {
      const o = asOpts(opts)
      const id = o.id || `n${++seq}-${Date.now().toString(36)}`
      return new Promise((resolve, reject) => {
        if (o.signal?.aborted) { reject(new DOMException('Cancelado', 'AbortError')); return }
        pending.set(id, { resolve, reject, onEvent: o.onEvent })
        o.signal?.addEventListener('abort', () => {
          if (!pending.has(id)) return
          pending.delete(id)
          try { B.call(token, 'http.cancel', JSON.stringify({ id })) } catch { /* ignore */ }
          reject(new DOMException('Cancelado', 'AbortError'))
        }, { once: true })
        B.callAsync(token, id, method, JSON.stringify(args))
      })
    },
    onEvent: events(),
    fsUrl: (path) => `${location.origin}/fs/${encPath(path)}`,
  }
}

/** Puente de desarrollo: el servidor de android/dev imita a Java (XHR sincrónico para call). */
function devHost(): Host {
  const post = (method: string, args: unknown) => {
    const x = new XMLHttpRequest()
    x.open('POST', '/__bridge', false)
    x.setRequestHeader('Content-Type', 'application/json')
    x.send(JSON.stringify({ method, args }))
    const r = JSON.parse(x.responseText)
    if (!r.ok) throw new Error(r.error)
    return r.value
  }
  const info = post('app.info', {})
  return {
    kind: 'dev',
    appOrigin: location.origin,
    // Mismo servidor, otro nombre de host: otro origen, como en Android.
    projectOrigin: `${location.protocol}//127.0.0.1:${location.port}`,
    info,
    call: (method, args = {}) => post(method, args),
    async callAsync(method, args = {}, opts) {
      const { onEvent, signal } = asOpts(opts)
      const r = await fetch('/__bridge/async', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }), signal })
      const reader = r.body!.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (value) buf += dec.decode(value, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1)
          if (!line.trim()) continue
          const msg = JSON.parse(line)
          if ('event' in msg) onEvent?.(msg)
          else if (msg.ok) return msg.value
          else throw new Error(msg.error)
        }
        if (done) throw new Error('El servidor de desarrollo cortó la respuesta')
      }
    },
    onEvent: events(),
    fsUrl: (path) => `${location.origin}/fs/${encPath(path)}`,
  }
}

let _host: Host | null = null
export function host(): Host {
  if (!_host) _host = (window as any).AndroidBridge ? androidHost() : devHost()
  return _host
}
