/**
 * Ventanas de captura: una ventana Chromium oculta con el compositor del timeline,
 * dimensionada en píxeles reales de salida (compensando el DPI de Windows).
 *
 * Aprendido probando en Windows (Electron 44):
 *  - `webPreferences.offscreen` + capturePage → UnknownVizError; los eventos `paint` llegan vacíos.
 *  - Ventana oculta normal + `enableLargerThanScreen` + setContentSize funciona hasta 4K (~36 capturas/s).
 *  - capturePage falla hasta que existe el primer fotograma del compositor → reintentar.
 *  - Crear una ventana justo después de destruir otra a veces falla la carga (ERR_FAILED) → reintentar.
 */
import { BrowserWindow, screen, NativeImage } from 'electron'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const dlog = (...a: unknown[]) => { if (process.env.OA_DEBUG) process.stdout.write('[debug] ' + a.map(String).join(' ') + String.fromCharCode(10)) }

export async function openCompositor(projectId: string, tlId: string, projW: number, projH: number, outW: number, outH: number) {
  const sf = screen.getPrimaryDisplay().scaleFactor || 1
  const dipW = Math.round(outW / sf), dipH = Math.round(outH / sf)
  const win = new BrowserWindow({
    show: false, width: dipW, height: dipH, useContentSize: true, frame: false, enableLargerThanScreen: true,
    skipTaskbar: true, focusable: false, resizable: false, paintWhenInitiallyHidden: true,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: false, zoomFactor: 1 },
  })
  win.setContentSize(dipW, dipH)
  win.webContents.setAudioMuted(true)
  if (process.env.OA_DEBUG) win.webContents.on('console-message', (e: any) => dlog('console', e.message ?? e))
  dlog('window', dipW, dipH)
  const url = `oa://p/${encodeURIComponent(projectId)}/__oa/compositor.html?p=${encodeURIComponent(projectId)}&tl=${encodeURIComponent(tlId)}&mode=export`
  let lastErr: unknown
  for (let i = 0; i < 4; i++) {
    try { await win.loadURL(url); lastErr = null; break } catch (e) { lastErr = e; await sleep(250 * (i + 1)) }
  }
  if (lastErr) { win.destroy(); throw lastErr }
  dlog('loaded', url)
  // El stage del compositor mide projW×projH px CSS: el zoom lo lleva a los píxeles de salida.
  win.webContents.setZoomFactor(Math.min(dipW / projW, dipH / projH))
  const ok = await win.webContents.executeJavaScript('window.__oaCompositor.ready.then(() => true, (e) => String(e && e.message || e))')
  dlog('ready', ok)
  if (ok !== true) { win.destroy(); throw new Error(`No se pudo cargar el timeline: ${ok}`) }
  return win
}

/** capturePage con reintentos (hasta que Chromium tenga un fotograma) y tamaño exacto. */
export async function captureExact(win: BrowserWindow, outW: number, outH: number): Promise<NativeImage> {
  let img: NativeImage | null = null
  let lastErr: unknown
  for (let i = 0; i < 200; i++) {
    try { img = await win.webContents.capturePage(); if (!img.isEmpty()) break } catch (e) { lastErr = e }
    await sleep(25)
  }
  if (!img || img.isEmpty()) throw new Error(`No se pudo capturar el fotograma: ${String((lastErr as any)?.message || lastErr)}`)
  const s = img.getSize()
  if (s.width !== outW || s.height !== outH) img = img.resize({ width: outW, height: outH, quality: 'best' })
  return img
}

export async function renderAt(win: BrowserWindow, t: number) {
  dlog('renderAt', t)
  return win.webContents.executeJavaScript(`window.__oaCompositor.renderAt(${t.toFixed(6)}, { force: true })`)
}
