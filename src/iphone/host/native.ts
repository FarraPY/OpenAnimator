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
