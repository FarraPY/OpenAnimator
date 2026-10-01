/**
 * Lo nativo de iOS que acompaña a la página (ios/OpenAnimator/NativeChrome.swift y NativeMenus.swift):
 *
 * Liquid Glass debajo de la página. En la app la página es transparente (html.native-ui: el fondo azul noche lo pone
 * iOS) y lo que lleva `data-glass` tiene debajo el vidrio de iOS en su lugar: acá se mide y se le manda a Swift cada vez
 * que algo puede haberse movido (cambios en la página, desplazar, transiciones y animaciones, el teclado). Si hay vidrio
 * de iOS, html.native-glass le saca el vidrio de CSS a esos elementos; si no (Safari, antes de iOS 26), queda el de CSS.
 * data-glass: "" vidrio, "accent" teñido del color de la app, "light" claro (el botón de reproducir), "clear"
 * transparente. El radio es el border-radius del elemento. Sólo para lo que no se desplaza: lo de adentro de una lista
 * que se desplaza iría un cuadro atrasado y su vidrio no se recorta con la lista.
 *
 * Menús de iOS. Los botones con `data-menu` (MenuButton, en PhoneApp) tienen encima un botón invisible de iOS con un
 * UIMenu: sale del botón con su vidrio y su animación; lo elegido vuelve como evento `menu`.
 */
import { host } from '../../android/host'
import { isNative, nativeCall } from './native'

/** Una opción de menú (como las de las hojas de acciones), con submenús. */
export type MenuEntry =
  | { label: string; icon?: string; desc?: string; danger?: boolean; disabled?: boolean; checked?: boolean; onSelect: () => void }
  | { label: string; icon?: string; desc?: string; sub: MenuEntry[] }
  | { sep: true }

const menus = new Map<string, { title?: string; items: MenuEntry[] }>()
let kick = () => {}
export function registerMenu(key: string, title: string | undefined, items: MenuEntry[]) { menus.set(key, { title, items }); kick() }
export function unregisterMenu(key: string) { menus.delete(key); kick() }
/** Medir y mandar ya (no en el próximo cuadro): lo que se mueve con el dedo, para que el vidrio no quede atrás. */
export let syncGlassNow = () => {}

// Los íconos de la app con su equivalente de iOS (SF Symbols).
const SF: Record<string, string> = {
  import: 'square.and.arrow.down', export: 'square.and.arrow.up', share: 'square.and.arrow.up', settings: 'gearshape', edit: 'pencil',
  note: 'note.text', check: 'checkmark', film: 'film', plus: 'plus', trash: 'trash', copy: 'plus.square.on.square', eye: 'eye',
  'eye-off': 'eye.slash', sparkles: 'sparkles', 'volume-x': 'speaker.slash', 'volume-2': 'speaker.wave.2', lock: 'lock', unlock: 'lock.open',
  folder: 'folder', 'folder-open': 'folder', history: 'clock.arrow.circlepath', compress: 'arrow.down.right.and.arrow.up.left', leaf: 'leaf',
  cpu: 'cpu', gauge: 'gauge.with.dots.needle.67percent', shield: 'checkmark.shield', code: 'chevron.left.forwardslash.chevron.right',
  zap: 'bolt', bolt: 'bolt', clipboard: 'list.clipboard', hand: 'hand.raised', x: 'xmark', scissors: 'scissors', brain: 'brain',
}

/** Las opciones para Swift: cada una con su número (`id`), que es lo que vuelve al elegirla. */
function entries(items: MenuEntry[], acts: Array<() => void>): object[] {
  return items.map((it) => {
    if ('sep' in it) return { sep: true }
    if ('sub' in it) return { label: it.label, sf: SF[it.icon || ''], desc: it.desc, sub: entries(it.sub, acts) }
    acts.push(it.onSelect)
    return { id: acts.length - 1, label: it.label, sf: SF[it.icon || ''], desc: it.desc, danger: it.danger, disabled: it.disabled, checked: it.checked }
  })
}

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
  const actions = new Map<string, Array<() => void>>()
  host().onEvent('menu', (d: { key: string; index: number }) => actions.get(d.key)?.[d.index]?.())

  let seq = 0, raf = 0, last = '', lastMenus = '', until = 0
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
      let alpha = 1
      for (let n: HTMLElement | null = el; n && n !== document.body && alpha > 0.01; n = n.parentElement) alpha *= parseFloat(getComputedStyle(n).opacity) || 0
      if (alpha < 0.02) continue
      items.push({
        id, x: r.left, y: r.top, w: r.width, h: r.height, alpha: Math.round(alpha * 100) / 100,
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
    // Los menús: ninguno si algo de la página tapa la pantalla (los botones de iOS quedarían por encima).
    const covered = !!document.querySelector('.sheet-back, .modal-backdrop, .menu')
    const mitems: object[] = []
    actions.clear()
    if (!covered) for (const el of document.querySelectorAll<HTMLElement>('[data-menu]')) {
      const key = el.dataset.menu!, m = menus.get(key)
      if (!m) continue
      const r = el.getBoundingClientRect()
      // Recortado a lo que se ve de su lista (los botones de las tarjetas del inicio).
      const box = el.closest('.ph-scroll')?.getBoundingClientRect()
      const top = Math.max(r.top, box?.top ?? 0), bottom = Math.min(r.bottom, box?.bottom ?? innerHeight)
      if (r.width < 1 || bottom - top < 10) continue
      const acts: Array<() => void> = []
      const list = entries(m.items, acts)
      actions.set(key, acts)
      mitems.push({ key, x: r.left, y: top, w: r.width, h: bottom - top, title: m.title || '', items: list, sig: JSON.stringify([m.title, list]) })
    }
    const mmsg = JSON.stringify(mitems)
    if (mmsg !== lastMenus) { lastMenus = mmsg; nativeCall('menu.layout', { items: mitems }).catch(() => {}) }
    if (performance.now() < until) later()
  }
  const later = () => { if (!raf) raf = requestAnimationFrame(sync) }
  kick = later
  syncGlassNow = () => { cancelAnimationFrame(raf); raf = 0; sync() }
  // Mientras algo se anima (una hoja que sube, la pestaña elegida que se corre) se mide en cada cuadro.
  const moving = () => { until = performance.now() + 800; later() }
  new MutationObserver(later).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'data-glass', 'data-menu', 'hidden'] })
  addEventListener('resize', later)
  addEventListener('scroll', later, { capture: true, passive: true })
  window.visualViewport?.addEventListener('resize', moving)
  for (const e of ['transitionrun', 'animationstart']) addEventListener(e, moving, true)
  for (const e of ['transitionend', 'transitioncancel', 'animationend']) addEventListener(e, later, true)
  void document.fonts?.ready.then(later)
  later()
}
