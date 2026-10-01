/**
 * Arranque de OpenAnimator en el iPhone (una app web: se abre en Safari y se agrega a la pantalla de inicio).
 *   1. El Service Worker (sw.ts): la app sin conexión, los archivos de los proyectos y el Claude Code instalado.
 *   2. El "puente nativo" hecho con APIs de Safari (host/webhost.ts) y, encima, el backend de Android (window.oa).
 *   3. La interfaz del teléfono (ui/PhoneApp.tsx).
 */
import { createRoot } from 'react-dom/client'
import { setHost } from '../android/host'
import { installBackend } from '../android/backend'
import { installPressFeedback } from '../android/ui/press'
import { createWebHost } from './host/webhost'
import '../styles.css'
import './phone.css'

/** Carpeta de la app (p. ej. "/OpenAnimator/" en GitHub Pages). */
const BASE = location.pathname.replace(/[^/]*$/, '')

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

async function serviceWorker() {
  if (!('serviceWorker' in navigator)) throw new Error('Este navegador no deja instalar OpenAnimator. Abrilo con Safari (y agregalo a la pantalla de inicio).')
  const reg = await navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE })
  await navigator.serviceWorker.ready
  // La primera vez la página todavía no está en manos del Service Worker (sin él no se ven los proyectos).
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) => { navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }); setTimeout(resolve, 4000) })
    if (!navigator.serviceWorker.controller) { location.reload(); await new Promise(() => {}) }
  }
  // Una versión nueva de la app se baja sola; se usa la próxima vez que se abre.
  setInterval(() => reg.update().catch(() => {}), 60 * 60e3)
}

async function boot() {
  await serviceWorker()
  const h = await createWebHost(BASE)
  setHost(h)
  // El Service Worker le pide a esta página los archivos de los datos (escenas, medios): los tiene WebFS.
  const sw = navigator.serviceWorker
  sw.addEventListener('message', async (e: MessageEvent) => {
    if (e.data?.type !== 'fs-read') return
    const port = e.ports[0]
    try { port.postMessage({ blob: h.fs.stat(e.data.path)?.dir === false ? await h.fs.fileBlob(e.data.path) : null }) } catch { port.postMessage({ blob: null }) }
  })
  sw.startMessages()
  const claim = () => sw.controller?.postMessage({ type: 'fs-owner' })
  claim()
  sw.addEventListener('controllerchange', claim)
  installBackend('iphone')
  installPressFeedback()
  // La interfaz se importa después: algunos módulos miran la plataforma al cargarse (modelos de Claude…).
  const { default: PhoneApp } = await import('./ui/PhoneApp')
  createRoot(document.getElementById('root')!).render(<PhoneApp />)
}

boot().catch(fatal)
