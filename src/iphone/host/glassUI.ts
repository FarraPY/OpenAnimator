/**
 * Liquid Glass de iOS debajo de la página (ios/OpenAnimator/NativeChrome.swift). En la app la página es transparente
 * (html.native-ui: el fondo azul noche lo pone iOS) y lo que lleva `data-glass` tiene debajo el vidrio de iOS en su
 * lugar: acá se mide y se le manda a Swift cada vez que algo puede haberse movido (cambios en la página, desplazar,
 * transiciones y animaciones, el teclado). Si hay vidrio de iOS, html.native-glass le saca el vidrio de CSS a esos
 * elementos; si no (Safari, antes de iOS 26), queda el de CSS.
 *
 * data-glass: "" vidrio, "accent" teñido del color de la app, "light" claro (el botón de reproducir), "clear"
 * transparente. El radio es el border-radius del elemento. Sólo para lo que no se desplaza: lo de adentro de una lista
 * que se desplaza iría un cuadro atrasado y su vidrio no se recorta con la lista.
 */
import { isNative, nativeCall } from './native'

export function installNativeGlass() {
  if (!isNative()) return
  const root = document.documentElement
  root.classList.add('native-ui')
  const ids = new WeakMap<Element, string>()
  const probe = document.createElement('i')
  probe.style.display = 'none'
  document.body.append(probe)
  /** Un color de CSS (variables incluidas) como rgb(…), que es lo que entiende Swift. */
  const rgb = (css: string, alpha: number) => {
    probe.style.color = css
    const n = getComputedStyle(probe).color.match(/[\d.]+/g)?.map(Number) || []
    return n.length >= 3 ? `rgba(${n[0]}, ${n[1]}, ${n[2]}, ${alpha})` : ''
  }
  let seq = 0, raf = 0, last = '', until = 0
  const sync = () => {
    raf = 0
    const items: object[] = []
    // También los botones redondos de la barra de arriba (todas las pantallas) y el cuadro de mensaje del chat
    // (componente compartido con la PC) dentro de la hoja del editor.
    for (const el of document.querySelectorAll<HTMLElement>('[data-glass], .ph-top .tap, .ed-sheet .composer')) {
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden') continue
      let id = ids.get(el)
      if (!id) { id = 'g' + ++seq; ids.set(el, id) }
      const rad = cs.borderTopLeftRadius
      const kind = el.dataset.glass
      items.push({
        id, x: r.left, y: r.top, w: r.width, h: r.height,
        r: rad.endsWith('%') ? (Math.min(r.width, r.height) * parseFloat(rad)) / 100 : parseFloat(rad) || 0,
        tint: kind === 'accent' ? rgb('var(--accent)', 0.8) : kind === 'light' ? 'rgba(255, 255, 255, 0.82)' : '',
        clear: kind === 'clear',
      })
    }
    const msg = JSON.stringify(items)
    if (msg !== last) {
      last = msg
      nativeCall<boolean>('glass.layout', { items }).then((ok) => root.classList.toggle('native-glass', !!ok)).catch(() => {})
    }
    if (performance.now() < until) later()
  }
  const later = () => { if (!raf) raf = requestAnimationFrame(sync) }
  // Mientras algo se anima (una hoja que sube, la pestaña elegida que se corre) se mide en cada cuadro.
  const moving = () => { until = performance.now() + 800; later() }
  new MutationObserver(later).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'data-glass', 'hidden'] })
  addEventListener('resize', later)
  addEventListener('scroll', later, { capture: true, passive: true })
  window.visualViewport?.addEventListener('resize', moving)
  for (const e of ['transitionrun', 'animationstart']) addEventListener(e, moving, true)
  for (const e of ['transitionend', 'transitioncancel', 'animationend']) addEventListener(e, later, true)
  void document.fonts?.ready.then(later)
  later()
}
