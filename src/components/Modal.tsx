import { ReactNode, useEffect, useRef } from 'react'
import { Icon, IconName } from '../ui/icons'
import { Button } from '../ui/kit'

export default function Modal({ title, subtitle, icon, onClose, children, footer, size, extra, persistent }: {
  title: ReactNode; subtitle?: ReactNode; icon?: IconName; onClose: () => void; children: ReactNode; footer?: ReactNode
  size?: 'narrow' | 'wide' | 'xl'; extra?: ReactNode; wide?: boolean; persistent?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.menu')) return
      const all = document.querySelectorAll('.modal-backdrop')
      if (all[all.length - 1] === ref.current) onClose()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div ref={ref} className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !persistent) onClose() }}>
      <div className={`modal ${size || ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          {icon && <div className="modal-icon"><Icon name={icon} size={18} /></div>}
          <div className="grow">
            <div className="modal-title">{title}</div>
            {subtitle && <div className="modal-sub">{subtitle}</div>}
          </div>
          {extra}
          <Button variant="ghost" icon="x" size="sm" tip="Cerrar" kbd="Esc" onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}
