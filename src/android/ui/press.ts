/**
 * Respuesta inmediata al tocar. Chrome en Android marca :active recién cuando descarta que el toque sea
 * un desplazamiento (≈100 ms, o al soltar el dedo), así que los botones "se apretaban" después de hacer
 * su acción. Acá se marca [data-pressed] en el mismo pointerdown (tablet.css lo pinta sin transición) y
 * se saca un poco después de soltar (así el click, que llega después del pointerup, cambia el estado
 * elegido todavía sin transición y se llega a ver), o apenas el gesto resulta ser un desplazamiento
 * (pointercancel).
 */
const PRESSABLE = [
  'button', '[role="button"]', 'a[href]', '.menu-item', '.side-item', '.seg-btn', '.tab', '.tb-tab', '.chip-f',
  '.mtile', '.pcard', '.tcard', '.prow', '.fmt', '.preset', '.xp-preset', '.sys-btn', '.madd', '.tb-project',
].join(', ')
const MIN_MS = 90, AFTER_UP_MS = 60

export function installPressFeedback() {
  let cur: { el: Element; id: number; at: number } | null = null
  const timers = new WeakMap<Element, number>() // un segundo toque rápido no se apaga con el primero
  const release = (keep: boolean) => {
    if (!cur) return
    const { el, at } = cur
    cur = null
    const wait = keep ? Math.max(MIN_MS - (performance.now() - at), AFTER_UP_MS) : 0
    if (wait > 0) timers.set(el, window.setTimeout(() => el.removeAttribute('data-pressed'), wait))
    else el.removeAttribute('data-pressed')
  }
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    release(false)
    const el = e.target instanceof Element ? e.target.closest(PRESSABLE) : null
    if (!el || el.matches(':disabled, [aria-disabled="true"], .disabled')) return
    clearTimeout(timers.get(el))
    el.setAttribute('data-pressed', '')
    cur = { el, id: e.pointerId, at: performance.now() }
  }, { capture: true, passive: true })
  const end = (e: PointerEvent) => { if (cur?.id === e.pointerId) release(e.type === 'pointerup') }
  document.addEventListener('pointerup', end, { capture: true, passive: true })
  document.addEventListener('pointercancel', end, { capture: true, passive: true })
  window.addEventListener('blur', () => release(false))
}
