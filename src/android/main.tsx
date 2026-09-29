/**
 * Arranque de OpenAnimator en Android: primero el "proceso principal" (backend/ → window.oa, sobre
 * el puente nativo), después la misma interfaz React que en la PC, con la capa táctil encima.
 */
import { createRoot } from 'react-dom/client'
import { installBackend } from './backend'
import '../styles.css'
import './tablet.css'

function fatal(e: unknown) {
  const root = document.getElementById('root')!
  root.innerHTML = ''
  const box = document.createElement('div')
  box.className = 'boot-error'
  const h = document.createElement('h1'); h.textContent = 'OpenAnimator no pudo arrancar'
  const p = document.createElement('pre'); p.textContent = String((e as any)?.stack || (e as any)?.message || e)
  const b = document.createElement('button'); b.textContent = 'Reintentar'; b.onclick = () => location.reload()
  box.append(h, p, b)
  root.appendChild(box)
}

try {
  installBackend()
  // La interfaz se importa después: algunos módulos miran la plataforma al cargarse (modelos de Claude…).
  import('../App').then(({ default: App }) => createRoot(document.getElementById('root')!).render(<App />), fatal)
} catch (e) { fatal(e) }
