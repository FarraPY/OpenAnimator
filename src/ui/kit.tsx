/** Kit de componentes de la interfaz de OpenAnimator. */
import { ButtonHTMLAttributes, ClipboardEvent, CSSProperties, forwardRef, ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon, IconName } from './icons'

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ')

// ── botones ─────────────────────────────────────────────────────────────────
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle'
  size?: 'xs' | 'sm' | 'md' | 'lg'
  icon?: IconName; iconRight?: IconName; tip?: string; kbd?: string; active?: boolean; loading?: boolean
}
export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button({ variant = 'secondary', size = 'md', icon, iconRight, tip, kbd, active, loading, className, children, ...rest }, ref) {
  const only = !children && (icon || loading)
  const is = size === 'xs' ? 13 : size === 'sm' ? 14 : size === 'lg' ? 17 : 15.5
  return (
    <button ref={ref} type="button" className={cx('b', `b-${variant}`, `b-${size}`, only && 'b-icon', active && 'is-active', className)}
      data-tip={tip} data-kbd={kbd} aria-label={tip} {...rest}>
      {loading ? <Spinner size={is - 1} /> : icon && <Icon name={icon} size={is} />}
      {children != null && children !== false && <span className="b-label">{children}</span>}
      {iconRight && <Icon name={iconRight} size={is - 2} className="b-right" />}
    </button>
  )
})
export const IconButton = (p: BtnProps & { icon: IconName }) => <Button variant="ghost" {...p} />

export function Spinner({ size = 14 }: { size?: number }) {
  return <svg className="spinner" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="42 60" /></svg>
}
export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="kbd">{children}</kbd>

export function Badge({ tone = 'neutral', icon, children, style, tip }: { tone?: 'neutral' | 'ok' | 'warn' | 'err' | 'accent' | 'info'; icon?: IconName; children: ReactNode; style?: CSSProperties; tip?: string }) {
  return <span className={`badge badge-${tone}`} style={style} data-tip={tip}>{icon && <Icon name={icon} size={12} stroke={2} />}{children}</span>
}

// ── tooltips (una sola capa global; cualquier elemento con data-tip) ────────
export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; kbd?: string; x: number; y: number; below: boolean } | null>(null)
  useEffect(() => {
    let timer = 0, cur: HTMLElement | null = null, touchAt = 0, press = 0, pressXY = { x: 0, y: 0 }
    const hide = () => { window.clearTimeout(timer); cur = null; setTip(null) }
    const show = (el: HTMLElement) => {
      if (!document.body.contains(el)) return
      const r = el.getBoundingClientRect()
      const below = r.top < 60
      setTip({ text: el.dataset.tip!, kbd: el.dataset.kbd, x: r.left + r.width / 2, y: below ? r.bottom + 8 : r.top - 8, below })
    }
    const over = (e: MouseEvent) => {
      // Con el dedo no hay "pasar por encima": el navegador simula el mouse después de cada toque.
      if (Date.now() - touchAt < 1200) return
      const el = (e.target as HTMLElement)?.closest?.('[data-tip]') as HTMLElement | null
      if (el === cur) return
      hide()
      if (!el || !el.dataset.tip) return
      cur = el
      timer = window.setTimeout(() => { if (cur) show(cur) }, 420)
    }
    // Pantalla táctil: mantener apretado un botón muestra su ayuda (como en Android).
    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') { if (!(e.target as HTMLElement)?.closest?.('.tooltip')) hide(); return }
      touchAt = Date.now()
      hide()
      window.clearTimeout(press)
      const el = (e.target as HTMLElement)?.closest?.('button[data-tip], .b[data-tip], .seg-btn[data-tip]') as HTMLElement | null
      if (!el?.dataset.tip) return
      pressXY = { x: e.clientX, y: e.clientY }
      press = window.setTimeout(() => { show(el); window.setTimeout(hide, 1800) }, 480)
    }
    const move = (e: PointerEvent) => { if (press && Math.hypot(e.clientX - pressXY.x, e.clientY - pressXY.y) > 10) { window.clearTimeout(press); press = 0 } }
    const up = () => { window.clearTimeout(press); press = 0 }
    window.addEventListener('mouseover', over)
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', up, true)
    window.addEventListener('wheel', hide, true)
    window.addEventListener('keydown', hide, true)
    return () => {
      window.removeEventListener('mouseover', over); window.removeEventListener('pointerdown', down, true); window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true); window.removeEventListener('wheel', hide, true); window.removeEventListener('keydown', hide, true)
    }
  }, [])
  const ref = useRef<HTMLDivElement>(null)
  const [dx, setDx] = useState(0)
  useLayoutEffect(() => {
    if (!tip || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    setDx(r.left < 8 ? 8 - r.left : r.right > window.innerWidth - 8 ? window.innerWidth - 8 - r.right : 0)
  }, [tip])
  if (!tip) return null
  return createPortal(
    <div ref={ref} className={cx('tooltip', tip.below && 'below')} style={{ left: tip.x + dx, top: tip.y }}>
      {tip.text}{tip.kbd && <span className="tooltip-kbd">{tip.kbd}</span>}
    </div>, document.body)
}

// ── menús desplegables ──────────────────────────────────────────────────────
export type MenuItem =
  | { label: ReactNode; icon?: IconName; iconColor?: string; hint?: ReactNode; kbd?: string; checked?: boolean; danger?: boolean; disabled?: boolean; onSelect: () => void; desc?: ReactNode }
  | { sep: true }
  | { header: ReactNode }

export function Menu({ anchor, items, onClose, align = 'start', width, placement = 'bottom' }: { anchor: DOMRect | { x: number; y: number }; items: MenuItem[]; onClose: () => void; align?: 'start' | 'end'; width?: number; placement?: 'bottom' | 'top' }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [hi, setHi] = useState(-1)
  const selectable = items.map((it, i) => ('onSelect' in it && !it.disabled ? i : -1)).filter((i) => i >= 0)
  useLayoutEffect(() => {
    const el = ref.current!
    const w = el.offsetWidth, h = el.offsetHeight
    const r = 'width' in anchor ? anchor : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0 } as any
    let left = align === 'end' ? r.right - w : r.left
    let top = placement === 'top' ? r.top - h - 6 : r.bottom + 6
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6)
    if (top < 8) top = 8
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
    setPos({ left, top })
  }, [])
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation()
        const k = selectable.indexOf(hi)
        setHi(selectable[(k + (e.key === 'ArrowDown' ? 1 : -1) + selectable.length) % selectable.length])
      } else if (e.key === 'Enter' && hi >= 0) { e.preventDefault(); e.stopPropagation(); const it = items[hi] as any; onClose(); it.onSelect() }
    }
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    return () => { window.removeEventListener('mousedown', down, true); window.removeEventListener('keydown', key, true); window.removeEventListener('blur', onClose) }
  })
  // El menú está en un portal, pero React igual pasa sus eventos a los padres del disparador: sin
  // cortarlos, tocar «Duplicar» en el menú de una tarjeta también abría el proyecto.
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()
  return createPortal(
    <div ref={ref} className="menu" style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, minWidth: width }} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
      onClick={stop} onDoubleClick={stop} onMouseDown={stop} onPointerDown={stop} onTouchStart={stop}>
      {items.map((it, i) => {
        if ('sep' in it) return <div key={i} className="menu-sep" />
        if ('header' in it) return <div key={i} className="menu-header">{it.header}</div>
        return (
          <div key={i} className={cx('menu-item', it.danger && 'danger', it.disabled && 'disabled', hi === i && 'hi', !!it.desc && 'has-desc')}
            onMouseEnter={() => setHi(i)} onClick={() => { if (it.disabled) return; onClose(); it.onSelect() }}>
            <span className="menu-check" style={it.iconColor && !it.checked ? { color: it.iconColor } : undefined}>{it.checked ? <Icon name="check" size={14} stroke={2.2} /> : it.icon ? <Icon name={it.icon} size={15} /> : null}</span>
            <span className="menu-label">{it.label}{it.desc && <span className="menu-desc">{it.desc}</span>}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
            {it.kbd && <Kbd>{it.kbd}</Kbd>}
          </div>
        )
      })}
    </div>, document.body)
}

/** Menú anclado a un disparador: `const m = useMenu(); <Button onClick={m.open}/>{m.render(items)}` */
export function useMenu() {
  const [anchor, setAnchor] = useState<DOMRect | { x: number; y: number } | null>(null)
  return {
    isOpen: !!anchor,
    open: (e: React.MouseEvent) => { e.stopPropagation(); setAnchor(anchor ? null : (e.currentTarget as HTMLElement).getBoundingClientRect()) },
    openAt: (x: number, y: number) => setAnchor({ x, y }),
    close: () => setAnchor(null),
    render: (items: MenuItem[], o: { align?: 'start' | 'end'; width?: number; placement?: 'bottom' | 'top' } = {}) => anchor && <Menu anchor={anchor} items={items} onClose={() => setAnchor(null)} {...o} />,
  }
}

// ── select propio ───────────────────────────────────────────────────────────
export type Option<T> = { value: T; label: ReactNode; hint?: ReactNode; icon?: IconName; disabled?: boolean; desc?: ReactNode }
export function Select<T extends string | number>({ value, options, onChange, size = 'md', width, placeholder, tip, icon, menuWidth, variant, disabled, renderValue, placement }: {
  value: T; options: Array<Option<T> | { sep: true } | { header: ReactNode }>; onChange: (v: T) => void; size?: 'sm' | 'md'; width?: number | string
  placeholder?: string; tip?: string; icon?: IconName; menuWidth?: number; variant?: 'field' | 'ghost'; disabled?: boolean; renderValue?: (o: Option<T> | undefined) => ReactNode; placement?: 'bottom' | 'top'
}) {
  const m = useMenu()
  const cur = options.find((o) => 'value' in o && o.value === value) as Option<T> | undefined
  return (
    <>
      <button type="button" className={cx('select', `select-${size}`, variant === 'ghost' && 'select-ghost', m.isOpen && 'open')} style={{ width }} onClick={m.open} data-tip={tip} disabled={disabled}>
        {(icon || cur?.icon) && <Icon name={(icon || cur?.icon)!} size={size === 'sm' ? 13.5 : 15} />}
        <span className="select-value">{renderValue ? renderValue(cur) : cur ? cur.label : <span className="t3">{placeholder || 'Elegir…'}</span>}</span>
        <Icon name="chevron-down" size={13} className="select-chev" />
      </button>
      {m.render(options.map((o) => ('value' in o ? { label: o.label, icon: o.icon, hint: o.hint, desc: o.desc, disabled: o.disabled, checked: o.value === value, onSelect: () => onChange(o.value) } : o)), { width: menuWidth, placement })}
    </>
  )
}

// ── controles de formulario ─────────────────────────────────────────────────
export function Switch({ checked, onChange, disabled, size = 'md' }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; size?: 'sm' | 'md' }) {
  return <button type="button" role="switch" aria-checked={checked} className={cx('switch', `switch-${size}`, checked && 'on')} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children?: ReactNode }) {
  return (
    <label className="check">
      <button type="button" role="checkbox" aria-checked={checked} className={cx('check-box', checked && 'on')} onClick={() => onChange(!checked)}>{checked && <Icon name="check" size={12} stroke={2.6} />}</button>
      {children && <span onClick={() => onChange(!checked)}>{children}</span>}
    </label>
  )
}

export function Segmented<T extends string | number>({ value, options, onChange, size = 'md', full }: { value: T; options: Array<{ value: T; label?: ReactNode; icon?: IconName; tip?: string }>; onChange: (v: T) => void; size?: 'sm' | 'md'; full?: boolean }) {
  return (
    <div className={cx('seg', `seg-${size}`, full && 'seg-full')}>
      {options.map((o) => (
        <button type="button" key={String(o.value)} className={cx('seg-btn', o.value === value && 'on', !o.label && 'icon-only')} onClick={() => onChange(o.value)} data-tip={o.tip}>
          {o.icon && <Icon name={o.icon} size={size === 'sm' ? 13.5 : 15} />}{o.label}
        </button>
      ))}
    </div>
  )
}

export function Slider({ value, min, max, step = 1, onChange, onCommit, width, tip }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; onCommit?: () => void; width?: number | string; tip?: string }) {
  const pct = ((value - min) / (max - min)) * 100
  return <input type="range" className="slider" min={min} max={max} step={step} value={value} style={{ width, ['--pct' as any]: `${pct}%` }} data-tip={tip}
    onChange={(e) => onChange(+e.target.value)} onPointerUp={onCommit} onKeyUp={onCommit} />
}

export function NumberInput({ value, onChange, step = 1, min, max, suffix, width, size = 'md', decimals }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; suffix?: string; width?: number | string; size?: 'sm' | 'md'; decimals?: number }) {
  const [txt, setTxt] = useState<string | null>(null)
  const clamp = (v: number) => Math.max(min ?? -Infinity, Math.min(max ?? Infinity, v))
  const shown = txt ?? (decimals != null ? (+value.toFixed(decimals)).toString() : String(value))
  const commit = () => { if (txt != null) { const v = parseFloat(txt.replace(',', '.')); if (isFinite(v)) onChange(clamp(v)); setTxt(null) } }
  return (
    <div className={cx('input', 'num', `input-${size}`)} style={{ width }}>
      <input value={shown} onChange={(e) => setTxt(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') commit(); if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); onChange(clamp(+(value + (e.key === 'ArrowUp' ? step : -step) * (e.shiftKey ? 10 : 1)).toFixed(6))); setTxt(null) } }} />
      {suffix && <span className="num-suffix">{suffix}</span>}
      <span className="num-steps">
        <button type="button" tabIndex={-1} onClick={() => onChange(clamp(+(value + step).toFixed(6)))}><Icon name="chevron-up" size={10} stroke={2.4} /></button>
        <button type="button" tabIndex={-1} onClick={() => onChange(clamp(+(value - step).toFixed(6)))}><Icon name="chevron-down" size={10} stroke={2.4} /></button>
      </span>
    </div>
  )
}

export function TextInput({ value, onChange, placeholder, icon, width, size = 'md', autoFocus, onEnter, mono, clearable, readOnly, type, onBlur, suffix, onPaste }: { value: string; onChange?: (v: string) => void; placeholder?: string; icon?: IconName; width?: number | string; size?: 'sm' | 'md'; autoFocus?: boolean; onEnter?: () => void; mono?: boolean; clearable?: boolean; readOnly?: boolean; type?: 'text' | 'password' | 'url'; onBlur?: () => void; suffix?: ReactNode; onPaste?: (e: ClipboardEvent<HTMLInputElement>) => void }) {
  return (
    <div className={cx('input', `input-${size}`, mono && 'mono')} style={{ width }}>
      {icon && <Icon name={icon} size={size === 'sm' ? 13.5 : 15} className="input-icon" />}
      <input value={value} placeholder={placeholder} autoFocus={autoFocus} readOnly={readOnly} type={type || 'text'} spellCheck={false} autoComplete="off" onChange={(e) => onChange?.(e.target.value)} onBlur={onBlur} onPaste={onPaste}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') onEnter?.() }} />
      {clearable && value && <button type="button" className="input-clear" onClick={() => onChange?.('')}><Icon name="x" size={12} stroke={2.2} /></button>}
      {suffix}
    </div>
  )
}

export function TextArea({ value, onChange, placeholder, rows = 4, mono }: { value: string; onChange: (v: string) => void; placeholder?: string; rows?: number; mono?: boolean }) {
  return <textarea className={cx('textarea', mono && 'mono')} rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
}

export function Field({ label, hint, children, span, row }: { label?: ReactNode; hint?: ReactNode; children: ReactNode; span?: number; row?: boolean }) {
  return (
    <div className={cx('field', row && 'field-row')} style={span ? { gridColumn: `span ${span}` } : undefined}>
      {label && <label className="field-label">{label}</label>}
      {children}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  )
}

export function Tabs<T extends string>({ value, tabs, onChange, size = 'md' }: { value: T; tabs: Array<{ value: T; label: ReactNode; icon?: IconName; count?: number }>; onChange: (v: T) => void; size?: 'sm' | 'md' }) {
  return (
    <div className={cx('tabs', `tabs-${size}`)} role="tablist">
      {tabs.map((t) => (
        <button type="button" role="tab" key={t.value} className={cx('tab', t.value === value && 'on')} onClick={() => onChange(t.value)}>
          {t.icon && <Icon name={t.icon} size={size === 'sm' ? 14 : 15} />}{t.label}{t.count != null && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function Progress({ value, indeterminate, tone }: { value?: number; indeterminate?: boolean; tone?: 'ok' | 'err' }) {
  return <div className={cx('progress', indeterminate && 'indeterminate', tone && `progress-${tone}`)}><div style={{ width: indeterminate ? undefined : `${Math.max(0, Math.min(100, value || 0))}%` }} /></div>
}

export function Empty({ icon, title, desc, children, compact }: { icon: IconName; title: ReactNode; desc?: ReactNode; children?: ReactNode; compact?: boolean }) {
  return (
    <div className={cx('empty', compact && 'empty-compact')}>
      <div className="empty-icon"><Icon name={icon} size={compact ? 20 : 26} stroke={1.5} /></div>
      <div className="empty-title">{title}</div>
      {desc && <div className="empty-desc">{desc}</div>}
      {children && <div className="empty-actions">{children}</div>}
    </div>
  )
}

export function Divider({ vertical, style }: { vertical?: boolean; style?: CSSProperties }) { return <div className={vertical ? 'vdiv' : 'hdiv'} style={style} /> }
