/**
 * "Visión" en Android: compositores ocultos (el mismo compositor de la vista previa y la exportación,
 * en el origen de los proyectos) que devuelven fotogramas como imágenes. Los usan Claude
 * (oa_ver_fotogramas, oa_hoja_contactos, oa_auditar_layout), las miniaturas y la exportación.
 */
import { compositorUrl } from '../../platform'
import { host } from '../host'
import { base64ToBytes, canvasBase64, fs, join } from './fsx'
import { readProject, readTimeline } from './projects'

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; type: string }

/** Lo que mide el compositor de una escena al dibujar un fotograma (measureCost en compositor.js). */
export type SceneCost = {
  seekMs: number; frameMs: number; loadMs: number; fps: number; scenes: string[]
  /** Pasar al fotograma siguiente: el JS de la escena y recalcular estilos y maquetar (sin pasos si no se pudo medir). */
  stepJsMs?: number; stepLayoutMs?: number
  /** Lo que tarda la GPU en el WebGL de ese paso (sólo escenas con WebGL). */
  stepGpuMs?: number
  weight: { elements: number; filters: number; bigBlurs: number; svgFilters: number; backdrops: number; blends: number; shadows: number; layers: number; turbulence: number; babel: number; canvasPx: number; imagePx: number; videos: number; animations: number; ms: number }
}
let seq = 0

export class Renderer {
  readonly iframe: HTMLIFrameElement
  readonly ready: Promise<{ duration: number; width: number; height: number }>
  private pending = new Map<string, Pending>()
  private reloading: Pending | null = null
  private onReady!: (v: any) => void
  private onFail!: (e: Error) => void
  private busy: Promise<unknown> = Promise.resolve()
  timer = 0
  /** Último pedido (empezado o terminado): el pool no cierra un compositor que se está usando. */
  usedAt = Date.now()

  constructor(readonly projectId: string, readonly tlId: string, width: number, height: number) {
    this.iframe = document.createElement('iframe')
    // En pantalla pero invisible: Chromium no pausa un iframe que "se ve" (uno fuera de pantalla sí).
    this.iframe.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px;border:0;transform:scale(0.0005);transform-origin:0 0;opacity:0.001;pointer-events:none;z-index:-1`
    this.iframe.setAttribute('aria-hidden', 'true')
    this.iframe.tabIndex = -1
    this.ready = new Promise((res, rej) => { this.onReady = res; this.onFail = rej })
    this.ready.catch(() => {})
    renderers.add(this)
    this.iframe.src = compositorUrl(projectId, { p: projectId, tl: tlId, mode: 'export' })
    document.body.appendChild(this.iframe)
    setTimeout(() => this.onFail(new Error('El compositor no respondió')), 45000)
  }

  handle(m: any) {
    if (m.type === 'ready') { this.onReady({ duration: m.duration, width: m.width, height: m.height }); return }
    if (m.type === 'reloaded') { this.reloading?.resolve(true); this.reloading = null; return }
    if (m.type === 'error' && !m.id) {
      this.onFail(new Error(m.message))
      this.reloading?.reject(new Error(m.message)); this.reloading = null
      return
    }
    const p = m.id && this.pending.get(m.id)
    if (!p) return
    this.pending.delete(m.id)
    if (m.type === 'error') p.reject(new Error(m.message))
    else p.resolve(m)
  }

  private post(msg: any) { this.iframe.contentWindow?.postMessage({ target: 'oa-compositor', ...msg }, '*') }

  /** Una operación a la vez por compositor. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.busy.then(fn, fn)
    this.busy = job.catch(() => {})
    return job
  }

  private request<T = any>(type: string, msg: any, timeout = 120000): Promise<T> {
    const id = `r${++seq}`
    this.usedAt = Date.now()
    return new Promise<T>((resolve, reject) => {
      // Ya cerrado: fallar enseguida en vez de esperar el plazo con un iframe que no está.
      if (!this.iframe.isConnected) { reject(new Error('cancelado')); return }
      const t = setTimeout(() => { if (this.pending.delete(id)) reject(new Error('El compositor tardó demasiado')) }, timeout)
      const settle = () => { clearTimeout(t); this.usedAt = Date.now() }
      this.pending.set(id, { type, resolve: (v) => { settle(); resolve(v) }, reject: (e) => { settle(); reject(e) } })
      this.post({ ...msg, type, id })
    })
  }

  reload() {
    return this.exclusive(async () => {
      await this.ready
      await new Promise((resolve, reject) => {
        const entry: Pending = { type: 'reload', resolve, reject }
        this.reloading = entry
        this.post({ type: 'reload' })
        // Sólo este pedido: el plazo de uno viejo no puede soltar la recarga siguiente.
        setTimeout(() => { if (this.reloading === entry) { this.reloading = null; resolve(false) } }, 30000)
      })
    })
  }

  /** Fotograma en t como base64 (jpeg o png) del tamaño pedido; con cost, además lo que le cuesta a la escena. */
  frame(t: number, width: number, height: number, format: 'jpeg' | 'png' = 'png', quality = 0.92, cost = false) {
    return this.exclusive(async () => {
      await this.ready
      const r = await this.request<{ data: string; mime: string; width: number; height: number; cost?: SceneCost | null }>('frame', { t, width, height, format, quality, cost })
      return r
    })
  }

  /** Fotograma en t como ImageBitmap (iPhone: va directo al codificador, sin pasar por JPEG). */
  bitmap(t: number, width: number, height: number) {
    return this.exclusive(async () => {
      await this.ready
      return (await this.request<{ bitmap: ImageBitmap }>('frame', { t, width, height, format: 'bitmap' })).bitmap
    })
  }

  audit(t: number) {
    return this.exclusive(async () => {
      await this.ready
      const r = await this.request<{ issues: any[] }>('audit', { t })
      return r.issues
    })
  }

  /** Sin pedidos en curso (se puede cerrar sin cortarle nada a nadie). */
  get idle() { return !this.pending.size && !this.reloading }

  destroy() {
    renderers.delete(this)
    this.pending.forEach((p) => p.reject(new Error('cancelado')))
    this.pending.clear()
    this.iframe.remove()
  }
}

const renderers = new Set<Renderer>()
window.addEventListener('message', (e) => {
  const m = e.data
  if (!m || m.source !== 'oa-compositor') return
  for (const r of renderers) if (e.source === r.iframe.contentWindow) { r.handle(m); return }
})

// ── pool (como frames.ts en la PC) ─────────────────────────────────────────────
const pool = new Map<string, Renderer>()
async function getRenderer(projectId: string, tlId: string) {
  const key = `${projectId}|${tlId}`
  let r = pool.get(key)
  if (r) {
    try { await r.reload() } catch { r.destroy(); pool.delete(key); r = undefined }
  }
  if (!r) {
    const p = readProject(projectId)
    r = new Renderer(projectId, tlId, p.width, p.height)
    pool.set(key, r)
    try { await r.ready } catch (e) { r.destroy(); pool.delete(key); throw e }
  }
  const cur = r
  cur.usedAt = Date.now()
  clearTimeout(cur.timer)
  // Se cierra a los 90 s sin uso, no a los 90 s de pedirlo: en la tablet una hoja de contactos con escenas
  // pesadas tarda más que eso y perdía el compositor a mitad («cancelado», o 120 s esperando a uno cerrado).
  const expire = () => {
    const left = cur.usedAt + 90_000 - Date.now()
    if (!cur.idle || left > 0) { cur.timer = window.setTimeout(expire, Math.max(1000, left)); return }
    cur.destroy(); if (pool.get(key) === cur) pool.delete(key)
  }
  cur.timer = window.setTimeout(expire, 90_000)
  return cur
}

// ── con la GPU (Snap.java) ────────────────────────────────────────────────────
/**
 * Fotogramas con la GPU: el compositor en una pantalla virtual y lo que el motor dibuja de verdad (Snap.java). Con el
 * compositor oculto de arriba, cada fotograma de una escena pesada tardaba 8–14 s en la tablet (rasterizar el DOM con
 * modern-screenshot) y el primer cuadro de un canvas WebGL salía vacío. Hay uno solo en toda la app; si no se puede
 * (p. ej. durante una exportación, que usa la GPU), se sigue con el compositor oculto.
 */
class SnapRenderer {
  usedAt = Date.now()
  timer = 0
  private jobs = 0
  private busy: Promise<unknown> = Promise.resolve()
  constructor(readonly key: string) {}
  get idle() { return !this.jobs }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.jobs++
    const run = async () => { this.usedAt = Date.now(); try { return await fn() } finally { this.jobs--; this.usedAt = Date.now() } }
    const job = this.busy.then(run, run)
    this.busy = job.catch(() => {})
    return job
  }

  open(projectId: string, tlId: string, width: number, height: number) {
    const url = compositorUrl(projectId, { p: projectId, tl: tlId, mode: 'export', capture: '1' })
    return this.exclusive(() => host().callAsync('snap.open', { url, width, height }))
  }

  reload() { return this.exclusive(() => host().callAsync('snap.reload')) }

  frame(t: number, width: number, _height: number, format: 'jpeg' | 'png' = 'png', quality = 0.92, cost = false) {
    return this.exclusive(async () => {
      const r = await host().callAsync<{ data: string; mime: string; width: number; height: number; ms: number; cost?: SceneCost }>('snap.frame', { t, width, format, quality, cost })
      return { ...r, cost: r.cost ? { ...r.cost, seekMs: r.ms, frameMs: r.ms } : null }
    })
  }

  destroy() { clearTimeout(this.timer); try { host().call('snap.close') } catch { /* sin puente */ } }
}
let snap: SnapRenderer | null = null

/** El de la GPU para projectId|tlId, o null si no se puede (va el compositor oculto). */
async function getSnap(projectId: string, tlId: string): Promise<SnapRenderer | null> {
  if (host().kind === 'web') return null // el iPhone no tiene la captura de Android (Snap.java)
  // Con el tamaño: la pantalla virtual se abre a la medida del proyecto (si cambia, se abre otra).
  const p = readProject(projectId)
  const key = `${projectId}|${tlId}|${p.width}x${p.height}`
  try {
    if (snap && snap.key !== key) {
      if (!snap.idle) return null // lo está usando otro proyecto: éste va por el compositor oculto
      snap.destroy(); snap = null
    }
    // Recargar: el timeline pudo cambiar en disco (si no anda, se abre de nuevo).
    if (snap) try { await snap.reload() } catch { snap.destroy(); snap = null }
    if (!snap) {
      const s = snap = new SnapRenderer(key)
      try { await s.open(projectId, tlId, p.width, p.height) } catch (e) { if (snap === s) snap = null; s.destroy(); throw e }
    }
  } catch (e) {
    console.warn('Fotogramas sin la GPU:', e)
    return null
  }
  const cur = snap!
  cur.usedAt = Date.now()
  clearTimeout(cur.timer)
  const expire = () => {
    const left = cur.usedAt + 90_000 - Date.now()
    if (!cur.idle || left > 0) { cur.timer = window.setTimeout(expire, Math.max(1000, left)); return }
    cur.destroy(); if (snap === cur) snap = null
  }
  cur.timer = window.setTimeout(expire, 90_000)
  return cur
}

export function closeFramePool(projectId?: string) {
  for (const [k, r] of pool) if (!projectId || k.startsWith(projectId + '|')) { clearTimeout(r.timer); r.destroy(); pool.delete(k) }
  if (snap && (!projectId || snap.key.startsWith(projectId + '|'))) { snap.destroy(); snap = null }
}

/** Poca memoria: cierra los compositores ocultos que no están dibujando nada (se vuelven a abrir al pedirlos). */
export function trimFramePool() {
  // Entre dos fotogramas de un mismo trabajo el compositor queda libre un instante: no cerrar uno recién usado.
  for (const [k, r] of pool) if (r.idle && Date.now() - r.usedAt > 10_000) { clearTimeout(r.timer); r.destroy(); pool.delete(k) }
  if (snap && snap.idle && Date.now() - snap.usedAt > 10_000) { snap.destroy(); snap = null }
}

/**
 * Ancho para que la imagen no pase de maxSide por lado (la API pide como mucho 2000 px cuando la
 * conversación tiene muchas imágenes; un proyecto vertical a 1920 de ancho mediría 3413 de alto).
 */
export function fitWidth(projectId: string, width: number, maxSide = 1920) {
  const pr = readProject(projectId)
  return Math.max(160, Math.min(width, maxSide, Math.floor((maxSide * pr.width) / pr.height)))
}

function sizeFor(projectId: string, width: number) {
  const pr = readProject(projectId)
  const w = Math.max(160, Math.min(3840, Math.round(width / 2) * 2))
  const h = Math.round((w * pr.height) / pr.width / 2) * 2
  return { w, h }
}

const label = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`

async function decode(data: string, mime: string) {
  return createImageBitmap(new Blob([base64ToBytes(data) as BlobPart], { type: mime }))
}

/** Dibuja la hora en la esquina (como el rótulo que agrega la PC para la IA). */
function drawLabel(g: CanvasRenderingContext2D, text: string, w: number) {
  const fs = Math.max(12, Math.round(w * 0.028))
  g.font = `600 ${fs}px system-ui, sans-serif`
  const tw = g.measureText(text).width
  const pad = Math.round(fs * 0.4)
  g.fillStyle = 'rgba(0,0,0,.72)'
  g.beginPath(); g.roundRect(Math.round(fs * 0.5), Math.round(fs * 0.4), tw + pad * 2, fs * 1.35, 6); g.fill()
  g.fillStyle = '#fff'; g.textBaseline = 'middle'
  g.fillText(text, Math.round(fs * 0.5) + pad, Math.round(fs * 0.4) + fs * 0.7)
}


/**
 * Renderiza fotogramas en los instantes pedidos y devuelve PNG (base64). measure: en cuántos de ellos
 * (repartidos) medir lo que le cuesta a la escena (para Claude; cada medición suma 3 pasos de un fotograma).
 */
export async function renderFrames(projectId: string, tlId: string | undefined, times: number[], width = 1280, withTime = false, format: 'png' | 'jpeg' = 'png', measure = 0) {
  const pr = readProject(projectId)
  const tid = tlId || pr.activeTimeline
  const { w, h } = sizeFor(projectId, width)
  let r: SnapRenderer | Renderer = (await getSnap(projectId, tid)) || (await getRenderer(projectId, tid))
  const out: Array<{ t: number; data: string; mime: string; cost?: SceneCost | null }> = []
  const every = measure > 0 ? Math.max(1, Math.ceil(times.length / measure)) : 0
  for (let i = 0; i < times.length; i++) {
    const t = times[i]
    const cost = every > 0 && i % every === 0
    // Con la GPU va JPEG casi sin pérdida (el PNG de Java es lento) cuando después se le dibuja la hora encima.
    const one = (x: SnapRenderer | Renderer) => x instanceof SnapRenderer
      ? x.frame(t, w, h, withTime ? 'jpeg' : format, withTime ? 0.95 : 0.9, cost)
      : x.frame(t, w, h, withTime ? 'png' : format, 0.9, cost)
    let f
    try { f = await one(r) } catch (e) {
      // La GPU se cortó a mitad (p. ej. empezó una exportación): el resto, con el compositor oculto.
      if (!(r instanceof SnapRenderer)) throw e
      console.warn('Fotogramas sin la GPU desde', t, e)
      // Una escena que no termina de dibujarse deja trabada esa página: el próximo pedido abre otra.
      r.destroy(); if (snap === r) snap = null
      r = await getRenderer(projectId, tid)
      f = await one(r)
    }
    if (!withTime) { out.push({ t, data: f.data, mime: f.mime, cost: f.cost }); continue }
    const bmp = await decode(f.data, f.mime)
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h
    const g = cv.getContext('2d')!
    g.drawImage(bmp, 0, 0, w, h); bmp.close() // la de la GPU no se agranda: un proyecto más angosto viene más chico
    drawLabel(g, label(t), w)
    out.push({ t, data: canvasBase64(cv, format === 'png' ? 'image/png' : 'image/jpeg', 0.9).data, mime: format === 'png' ? 'image/png' : 'image/jpeg', cost: f.cost })
  }
  return out
}

/** Hoja de contactos: N fotogramas repartidos (o instantes dados) en una grilla con la hora de cada uno. */
export async function contactSheet(projectId: string, tlId: string | undefined, opts: { count?: number; times?: number[]; from?: number; to?: number; cols?: number; width?: number }) {
  const pr = readProject(projectId)
  const tid = tlId || pr.activeTimeline
  const tl = readTimeline(projectId, tid)
  let times = opts.times
  if (!times || !times.length) {
    const n = Math.max(2, Math.min(48, opts.count || 12))
    const a = Math.max(0, opts.from ?? 0), b = Math.min(tl.duration, opts.to ?? tl.duration)
    times = Array.from({ length: n }, (_, i) => +(a + ((b - a) * (i + 0.5)) / n).toFixed(3))
  }
  const cols = Math.max(1, Math.min(8, Math.round(opts.cols || Math.min(4, times.length))))
  const rows = Math.ceil(times.length / cols)
  const pad = 8
  // La hoja entera entra en 1990 px por lado (ver fitWidth).
  const fit = Math.floor(Math.min((1990 - pad) / cols - pad, (((1990 - pad) / rows - pad) * pr.width) / pr.height))
  const tw = Math.max(160, Math.min(opts.width || 480, fit))
  const frames = await renderFrames(projectId, tid, times, tw, true, 'jpeg', 4)
  const { w, h } = sizeFor(projectId, tw)
  const cv = document.createElement('canvas')
  cv.width = pad + cols * (w + pad); cv.height = pad + rows * (h + pad)
  const g = cv.getContext('2d')!
  g.fillStyle = '#16181d'; g.fillRect(0, 0, cv.width, cv.height)
  for (let i = 0; i < frames.length; i++) {
    const bmp = await decode(frames[i].data, frames[i].mime)
    g.drawImage(bmp, pad + (i % cols) * (w + pad), pad + Math.floor(i / cols) * (h + pad), w, h)
    bmp.close()
  }
  return { jpeg: canvasBase64(cv, 'image/jpeg', 0.88).data, times, costs: frames.map((f) => f.cost).filter((c): c is SceneCost => !!c) }
}

/**
 * Para Claude, con los fotogramas: lo que le cuesta cada escena a la tablet (medido en el equipo) y, si es
 * pesada, por qué. Presupuesto: a 30 fps hay 33 ms por fotograma para todo (el JS y los estilos de la escena,
 * pintar y la interfaz de la app, que comparte el hilo): la escena no debería pasar de ~10 ms.
 */
export function costNote(costs: SceneCost[]): string {
  const groups = new Map<string, SceneCost[]>()
  for (const c of costs) {
    const k = c.scenes.length ? c.scenes.join(' + ') : ''
    if (k) groups.set(k, [...(groups.get(k) || []), c])
  }
  if (!groups.size) return ''
  const ms = (v: number) => (v < 10 ? v.toFixed(1) : String(Math.round(v)))
  const light: string[] = [], heavy: string[] = []
  for (const [scenes, cs] of groups) {
    const fps = cs[0].fps || 30
    const budget = Math.round(Math.min(10, 300 / fps))
    // El fotograma más lento de los medidos (con cuánto fue JS y cuánto estilos y maquetado).
    const slow = cs.filter((c) => c.stepJsMs != null).sort((a, b) => (b.stepJsMs! + b.stepLayoutMs!) - (a.stepJsMs! + a.stepLayoutMs!))[0]
    const step = slow ? slow.stepJsMs! + slow.stepLayoutMs! : null
    const w = { ...cs[0].weight }
    for (const c of cs) for (const k of Object.keys(w) as Array<keyof typeof w>) w[k] = Math.max(w[k], c.weight[k])
    const load = Math.max(...cs.map((c) => c.loadMs || 0))
    const flags: string[] = []
    if (w.elements > 3000) flags.push(`${w.elements} elementos en el DOM`)
    if (w.animations > 150) flags.push(`${w.animations} animaciones CSS/WAAPI (se posicionan una por una en cada fotograma)`)
    if (w.bigBlurs) flags.push(`${w.bigBlurs} desenfoque(s) grande(s) (filter: blur sobre más del 10 % del cuadro)`)
    else if (w.filters > 30) flags.push(`${w.filters} elementos con filter`)
    if (w.backdrops) flags.push(`backdrop-filter en ${w.backdrops} elemento(s)`)
    if (w.blends > 8) flags.push(`${w.blends} elementos con mix-blend-mode`)
    if (w.shadows > 20) flags.push(`${w.shadows} sombras grandes (box-shadow con desenfoque de 24 px o más)`)
    if (w.layers > 40) flags.push(`${w.layers} capas de GPU (will-change o 3D)`)
    if (w.turbulence) flags.push(`feTurbulence ×${w.turbulence} (se dibuja en la CPU)`)
    else if (w.svgFilters > 10) flags.push(`${w.svgFilters} elementos con filtros SVG`)
    const mb = Math.round(((w.canvasPx + w.imagePx) * 4) / 2 ** 20)
    if (mb > 250) flags.push(`~${mb} MB de imágenes y canvas decodificados`)
    if (w.videos > 2) flags.push(`${w.videos} videos a la vez`)
    if (w.babel) flags.push('Babel en el navegador (compila al cargar)')
    if (load > 2500) flags.push(`tarda ${(load / 1000).toFixed(1)} s en cargar`)
    // El WebGL no cuenta en el JS: la GPU lo dibuja después, y cada fotograma de la exportación la espera.
    const gpu = Math.max(0, ...cs.map((c) => c.stepGpuMs || 0))
    if (gpu > 16) flags.push(`WebGL: ~${ms(gpu)} ms de GPU por fotograma (la exportación no pasa de ~${Math.max(1, Math.floor(1000 / gpu))} fps: menos pasos en el shader o un canvas más chico)`)
    const stepText = step == null ? '' : `${ms(step)} ms por fotograma de JS y estilos`
    if ((step == null || step <= budget) && !flags.length) { light.push(`${scenes} ${stepText ? '~' + stepText : 'sin pasos medidos'}`); continue }
    const split = slow ? ` (JS ${ms(slow.stepJsMs!)} + estilos y maquetado ${ms(slow.stepLayoutMs!)}; a ${fps} fps debería quedar bajo ~${budget} ms, y pintar va aparte)` : ''
    heavy.push(`${scenes}: ${[step == null ? '' : stepText + split, ...flags].filter(Boolean).join(' · ')}`)
  }
  const out: string[] = []
  if (heavy.length) out.push(`ATENCIÓN, escena pesada para la tablet (medido en el equipo): ${heavy.join(' | ')}. Así la vista previa se traba, la interfaz puede parpadear y la app puede cerrarse por falta de memoria: simplificala antes de seguir (skill escenas-html, «Rendimiento»).`)
  if (light.length) out.push(`Costo en la tablet (medido): ${light.join(' · ')}: liviana${light.length > 1 ? 's' : ''}.`)
  return out.join('\n')
}

export type AuditIssue = { kind: string; text: string; clip?: string; t: number; box?: number[] }

/** Auditoría de layout: barre el timeline y reporta textos fuera de cuadro o superpuestos. */
export async function auditLayout(projectId: string, tlId: string | undefined, opts: { step?: number; from?: number; to?: number }) {
  const pr = readProject(projectId)
  const tid = tlId || pr.activeTimeline
  const tl = readTimeline(projectId, tid)
  const step = Math.max(0.1, opts.step || 0.5)
  const a = Math.max(0, opts.from ?? 0), b = Math.min(tl.duration, opts.to ?? tl.duration)
  const r = await getRenderer(projectId, tid)
  const groups = new Map<string, { kind: string; text: string; clip?: string; from: number; to: number; count: number; box?: number[] }>()
  for (let t = a; t < b; t += step) {
    const issues: AuditIssue[] = await r.audit(+t.toFixed(4))
    for (const is of issues) {
      const k = `${is.kind}|${is.text}|${is.clip}`
      const g = groups.get(k)
      if (g) { g.to = is.t; g.count++ } else groups.set(k, { kind: is.kind, text: is.text, clip: is.clip, from: is.t, to: is.t, count: 1, box: is.box })
    }
  }
  return { timeline: tid, step, from: a, to: b, issues: [...groups.values()] }
}

/** Miniatura de la pantalla de inicio (thumbnail.jpg del proyecto). */
export async function makeThumb(projectId: string) {
  try {
    const tl = readTimeline(projectId)
    const t = Math.min(tl.duration * 0.25, 3)
    const [f] = await renderFrames(projectId, undefined, [t], 480, false, 'jpeg')
    await fs.writeBytes(join('projects', projectId, 'thumbnail.jpg'), base64ToBytes(f.data))
  } catch (e) { console.warn('sin miniatura', e) }
}
