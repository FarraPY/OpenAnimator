/**
 * La app nativa del iPhone (ios/): lo que hace iOS por la interfaz llega por window.webkit.messageHandlers.oa
 * (ios/OpenAnimator/Bridge.swift). Cada pedido es {op, …} y devuelve una promesa con la respuesta.
 */
type Handler = { postMessage(m: unknown): Promise<any> }
const handler = (): Handler | undefined => (globalThis as any).webkit?.messageHandlers?.oa

/** true dentro de la app nativa (en Safari no existe el puente). */
export const isNative = () => !!handler()

export function nativeCall<T = any>(op: string, args: Record<string, unknown> = {}): Promise<T> {
  const h = handler()
  if (!h) return Promise.reject(new Error(`«${op}» sólo existe en la app del iPhone`))
  return h.postMessage({ op, ...args })
}

/** base64 (el puente sólo lleva texto). Safari 18.2+ trae Uint8Array.toBase64 / fromBase64, mucho más rápidos. */
export function b64encode(u8: Uint8Array): string {
  if ((u8 as any).toBase64) return (u8 as any).toBase64()
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000))
  return btoa(s)
}
export function b64decode(s: string): Uint8Array {
  if ((Uint8Array as any).fromBase64) return (Uint8Array as any).fromBase64(s)
  const bin = atob(s), out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export type OnEvent = (name: string, cb: (d: any) => void) => () => void

/** fetch por la red de iOS, con la respuesta por partes (evento "net": head, chunk, end, error). */
export function nativeFetch(onEvent: OnEvent) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : null
    const url = req ? req.url : String(input)
    const method = (init?.method || req?.method || 'GET').toUpperCase()
    const headers: Record<string, string> = {}
    // Los de la librería vienen en init.headers (un Headers suelto: conserva User-Agent y Origin).
    if (req) req.headers.forEach((v, k) => { headers[k] = v })
    if (init?.headers) new Headers(init.headers).forEach((v, k) => { headers[k] = v })
    const raw = init?.body ?? (req && method !== 'GET' && method !== 'HEAD' ? await req.arrayBuffer() : null)
    let body = ''
    if (raw != null) {
      const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw instanceof ArrayBuffer ? new Uint8Array(raw)
        : ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(await new Response(raw as BodyInit).arrayBuffer())
      body = b64encode(bytes)
    }
    const id = 'yt' + Math.random().toString(36).slice(2)
    return new Promise<Response>((resolve, reject) => {
      let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null
      const stream = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c } })
      const off = onEvent('net', (ev) => {
        if (ev?.id !== id) return
        if (ev.type === 'head') {
          const empty = [101, 204, 205, 304].includes(ev.status)
          resolve(new Response(empty ? null : stream, { status: ev.status, headers: ev.headers }))
        } else if (ev.type === 'chunk') ctrl?.enqueue(b64decode(ev.data))
        else if (ev.type === 'end') { off(); ctrl?.close() }
        else if (ev.type === 'error') {
          off()
          const e = new Error(ev.message || 'Error de red')
          reject(e)
          try { ctrl?.error(e) } catch { /* ya cerrado */ }
        }
      })
      init?.signal?.addEventListener('abort', () => { void nativeCall('http.cancel', { id }).catch(() => {}) })
      nativeCall('http.stream', { id, url, method, headers, body }).catch((e) => { off(); reject(e) })
    })
  }
}
