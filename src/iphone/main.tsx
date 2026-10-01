/**
 * Arranque de OpenAnimator en el iPhone, en la app nativa (ios/: WKWebView) o como app web en Safari.
 *   1. Sólo en Safari: el Service Worker (sw.ts) sirve la app sin conexión, los archivos de los proyectos y Claude Code.
 *      En la app nativa eso lo hace la app (ios/OpenAnimator/SchemeHandler.swift).
 *   2. El "puente nativo" (host/webhost.ts) y, encima, el backend de Android (window.oa).
 *   3. La interfaz del teléfono (ui/PhoneApp.tsx).
 */
import { createRoot } from 'react-dom/client'
import { setHost } from '../android/host'
import { installBackend } from '../android/backend'
import { installPressFeedback } from '../android/ui/press'
import { createWebHost } from './host/webhost'
import { isNative } from './host/native'
import { appLog, installAppLog } from './host/applog'
import '../styles.css'
import './phone.css'

/** Carpeta de la app (p. ej. "/OpenAnimator/" en GitHub Pages). */
const BASE = location.pathname.replace(/[^/]*$/, '')

function fatal(e: unknown) {
  console.error('[arranque]', e)
  appLog('ERROR', 'arranque', String((e as any)?.stack || e))
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
  const native = isNative()
  if (!native) await serviceWorker()
  const h = await createWebHost(BASE, native)
  setHost(h)
  if (!native) {
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
  }
  installBackend('iphone')
  installAppLog((ch, cb) => (window as any).oa.on(ch, cb))
  installPressFeedback()
  // La interfaz se importa después: algunos módulos miran la plataforma al cargarse (modelos de Claude…).
  const { default: PhoneApp } = await import('./ui/PhoneApp')
  createRoot(document.getElementById('root')!).render(<PhoneApp />)
  appLog('INFO', 'app', `Interfaz lista en ${Math.round(performance.now())} ms${location.search.includes('recovered') ? ' (después de un cierre del motor web)' : ''}`)
  // Prueba de punta a punta en el simulador (la app la abre con -OATest e2e).
  if ((window as any).__oaTest === 'e2e') void import('./test/e2e').then((m) => m.runE2E())
}

boot().catch(fatal)
