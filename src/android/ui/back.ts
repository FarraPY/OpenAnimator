/**
 * Botón "atrás" de Android. MainActivity llama a window.onAndroidBack(): si devuelve true la
 * interfaz lo resolvió (cerró un menú, un diálogo, un panel…); si no, Android pregunta si salir.
 *
 * Orden: menú abierto → diálogo abierto → lo que registró la pantalla actual (useBack).
 */
import { useEffect, useRef } from 'react'

type Handler = () => boolean
const stack: Array<{ fn: () => Handler }> = []

function escape() {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
}

export function handleBack(): boolean {
  if (document.querySelector('.menu')) { escape(); return true }
  if (document.querySelector('.modal-backdrop')) { escape(); return true }
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].fn()()) return true
  return false
}

export function installBack() {
  ;(window as any).onAndroidBack = handleBack
}

/** La pantalla actual decide qué hace "atrás" (devolver false = no lo usó). Siempre la última versión del callback. */
export function useBack(fn: Handler, enabled = true) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (!enabled) return
    const entry = { fn: () => ref.current }
    stack.push(entry)
    return () => { const i = stack.indexOf(entry); if (i >= 0) stack.splice(i, 1) }
  }, [enabled])
}
