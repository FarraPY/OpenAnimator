/**
 * OpenAnimator en el iPhone: una interfaz hecha para la pantalla de un teléfono (vertical, táctil, a una mano). Usa el
 * mismo backend que la tablet (window.oa) y algunas piezas de la PC (el chat con Claude, la vista previa); la
 * navegación, el inicio, el editor, el timeline y los ajustes son propios del teléfono.
 */
import { handleBack } from '../../android/ui/back'
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AppCtx, type Route } from '../../App'
import { AppInfo, call, Settings, SettingsPatch } from '../../api'
import { Icon, IconName } from '../../ui/icons'
import { recoveredBoot } from '../../platform'
import Projects from './Projects'
import PhoneEditor from './PhoneEditor'
import PhoneSettings from './PhoneSettings'

type ToastT = { id: number; text: string; kind: 'ok' | 'err' | 'info' }

/**
 * Con el teclado abierto, Safari achica sólo la parte visible (visualViewport), no la página: la app se acomoda a lo
 * visible (--vvh) para que el cuadro de mensaje quede arriba del teclado, y html.kb avisa que está abierto.
 */
/**
 * Volver deslizando desde el borde izquierdo (el gesto lo reconoce iOS: WebViewController llama a __oaBack). Primero
 * se cierra lo que esté abierto (menú, ventana, hoja); si no hay nada, es el botón de volver de la pantalla.
 */
;(window as any).__oaBack = () => {
  if (handleBack()) return
  const sheet = document.querySelector<HTMLElement>('.sheet-back')
  if (sheet) { sheet.dispatchEvent(new MouseEvent('click', { bubbles: true })); return }
  ;[...document.querySelectorAll<HTMLElement>('.ph-top [data-back]')].filter((b) => b.offsetParent).pop()?.click()
}

function useKeyboardViewport() {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const d = document.documentElement
    const fit = () => {
      d.style.setProperty('--vvh', `${Math.round(vv.height)}px`)
      d.classList.toggle('kb', window.innerHeight - vv.height > 120)
      if (window.scrollY) window.scrollTo(0, 0) // Safari corre la página para mostrar el campo: la app ya se acomodó
    }
    fit()
    vv.addEventListener('resize', fit)
    vv.addEventListener('scroll', fit)
    return () => { vv.removeEventListener('resize', fit); vv.removeEventListener('scroll', fit) }
  }, [])
}

export default function PhoneApp() {
  // iOS cerró el motor web (casi siempre por falta de memoria) y la app lo volvió a abrir: de vuelta al proyecto.
  const [route, setRoute] = useState<Route>(() => {
    try { const id = recoveredBoot && localStorage.getItem('oa.openProject'); return id ? { page: 'editor', id } : { page: 'home' } } catch { return { page: 'home' } }
  })
  const [toasts, setToasts] = useState<ToastT[]>([])
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const seq = useRef(0)
  useKeyboardViewport()

  const toast = useCallback((text: string, kind: boolean | 'ok' | 'info' = false) => {
    const k: ToastT['kind'] = kind === true ? 'err' : kind === 'info' ? 'info' : 'ok'
    const id = ++seq.current
    setToasts((xs) => [...xs.slice(-2), { id, text, kind: k }])
    window.setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), k === 'err' ? 7000 : 3200)
  }, [])

  const updateSettings = useCallback(async (patch: SettingsPatch) => {
    setSettings((s) => {
      if (!s) return s
      const n: any = { ...s }
      for (const k of Object.keys(patch) as Array<keyof Settings>) n[k] = typeof (patch as any)[k] === 'object' && !Array.isArray((patch as any)[k]) && k !== 'export' ? { ...(s as any)[k], ...(patch as any)[k] } : (patch as any)[k]
      return n
    })
    try { setSettings(await call<Settings>('settings:set', patch)) } catch (e: any) { toast(e.message, true) }
  }, [toast])

  const refreshInfo = useCallback(() => { call<AppInfo>('app:info').then(setInfo).catch(() => {}) }, [])
  useEffect(() => {
    refreshInfo()
    call<Settings>('settings:get').then((s) => {
      setSettings(s)
      const d = document.documentElement
      d.dataset.accent = s.ui.accent
      if (s.ui.reduceMotion) d.setAttribute('data-reduce-motion', '')
    })
  }, [])
  useEffect(() => { if (settings) document.documentElement.dataset.accent = settings.ui.accent }, [settings?.ui.accent])

  const go = useCallback((r: Route) => {
    setRoute(r)
    if (r.page === 'editor') call('settings:set', { lastProject: r.id }).catch(() => {})
    if (r.page !== 'settings') try { localStorage.setItem('oa.openProject', r.page === 'editor' ? r.id : '') } catch { /* sin almacenamiento */ }
  }, [])

  return (
    <AppCtx.Provider value={{ toast, info, settings, updateSettings, go, route, refreshInfo }}>
      <div className="ph">
        {route.page === 'editor' ? <PhoneEditor key={route.id} projectId={route.id} onClose={() => go({ page: 'home' })} />
          : route.page === 'settings' ? <PhoneSettings section={route.section} onBack={() => { refreshInfo(); go(route.from || { page: 'home' }) }} />
            : <Projects />}
      </div>
      <div className="ph-toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`ph-toast ${t.kind}`} onClick={() => setToasts((xs) => xs.filter((x) => x.id !== t.id))}>
            <Icon name={t.kind === 'err' ? 'x-circle' : t.kind === 'info' ? 'info' : 'check-circle'} size={18} />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </AppCtx.Provider>
  )
}

// ── piezas del teléfono ───────────────────────────────────────────────────────

/** Barra de arriba (debajo de la isla dinámica). */
export function TopBar({ left, title, right }: { left?: ReactNode; title?: ReactNode; right?: ReactNode }) {
  return <div className="ph-top">{left}<div className="ph-top-title">{title}</div>{right}</div>
}

/** Botón redondo con ícono (44 pt: el mínimo cómodo para un dedo). */
export function Tap({ icon, label, onClick, active, disabled, accent, size = 22, back }: { icon: IconName; label: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; active?: boolean; disabled?: boolean; accent?: boolean; size?: number; back?: boolean }) {
  return (
    <button className={`tap ${active ? 'on' : ''} ${accent ? 'accent' : ''}`} aria-label={label} disabled={disabled} onClick={onClick} data-back={back || undefined}>
      <Icon name={icon} size={size} />
    </button>
  )
}

/** Hoja que sube desde abajo. Se cierra tocando afuera o deslizando la manija hacia abajo. */
export function Sheet({ title, onClose, children, footer, tall, persistent }: { title?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; tall?: boolean; persistent?: boolean }) {
  const [dy, setDy] = useState(0)
  const drag = useRef<{ y: number; id: number } | null>(null)
  return createPortal(
    <div className="sheet-back" onClick={(e) => { if (e.target === e.currentTarget && !persistent) onClose() }}>
      <div className={`sheet ${tall ? 'tall' : ''}`} style={dy ? { transform: `translateY(${dy}px)`, transition: 'none' } : undefined} role="dialog" aria-modal="true">
        <div className="sheet-head"
          onPointerDown={(e) => { if (persistent) return; drag.current = { y: e.clientY, id: e.pointerId }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) }}
          onPointerMove={(e) => { if (drag.current?.id === e.pointerId) setDy(Math.max(0, e.clientY - drag.current.y)) }}
          onPointerUp={() => { if (!drag.current) return; drag.current = null; if (dy > 90) onClose(); else setDy(0) }}
          onPointerCancel={() => { drag.current = null; setDy(0) }}>
          <div className="sheet-grab" />
          {title && <div className="sheet-title">{title}</div>}
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

export type Act = { label: string; icon?: IconName; danger?: boolean; disabled?: boolean; desc?: string; onSelect: () => void } | { sep: true }

/** Lista de acciones (como la hoja de acciones de iOS). */
export function Actions({ title, items, onClose }: { title?: ReactNode; items: Act[]; onClose: () => void }) {
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="acts">
        {items.map((it, i) => ('sep' in it ? <div key={i} className="acts-sep" /> : (
          <button key={i} className={`act ${it.danger ? 'danger' : ''}`} disabled={it.disabled} onClick={() => { onClose(); it.onSelect() }}>
            {it.icon && <Icon name={it.icon} size={21} />}
            <span className="act-text"><span>{it.label}</span>{it.desc && <small>{it.desc}</small>}</span>
          </button>
        )))}
      </div>
    </Sheet>
  )
}

/** Grupo de filas, como las listas agrupadas de Ajustes en iOS. */
export function Group({ title, foot, children }: { title?: ReactNode; foot?: ReactNode; children: ReactNode }) {
  return (
    <div className="grp">
      {title && <div className="grp-title">{title}</div>}
      <div className="grp-box">{children}</div>
      {foot && <div className="grp-foot">{foot}</div>}
    </div>
  )
}

export function Row({ icon, label, detail, onClick, children, danger, chevron, stack }: { icon?: IconName; label: ReactNode; detail?: ReactNode; onClick?: () => void; children?: ReactNode; danger?: boolean; chevron?: boolean; stack?: boolean }) {
  const body = (
    <>
      {icon && <span className="row-ic"><Icon name={icon} size={18} /></span>}
      <span className="row-main">
        <span className="row-label">{label}</span>
        {detail && <span className="row-detail">{detail}</span>}
      </span>
      {children}
      {chevron && <Icon name="chevron-right" size={16} className="row-chev" />}
    </>
  )
  const cls = `prow2 ${danger ? 'danger' : ''} ${stack ? 'stack' : ''}`
  return onClick ? <button className={cls} onClick={onClick}>{body}</button> : <div className={cls}>{body}</div>
}

/** Chips para elegir una opción (formatos, calidad…). */
export function Chips<T extends string | number>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: ReactNode; sub?: ReactNode }>; onChange: (v: T) => void }) {
  return (
    <div className="chips">
      {options.map((o) => (
        <button key={String(o.value)} className={`chip ${o.value === value ? 'on' : ''}`} onClick={() => onChange(o.value)}>
          <span>{o.label}</span>{o.sub && <small>{o.sub}</small>}
        </button>
      ))}
    </div>
  )
}
