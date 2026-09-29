/**
 * "Visión" en Android: compositores ocultos (el mismo compositor de la vista previa y la exportación,
 * en el origen de los proyectos) que devuelven fotogramas como imágenes. Los usan Claude
 * (oa_ver_fotogramas, oa_hoja_contactos, oa_auditar_layout), las miniaturas y la exportación.
 */
import { compositorUrl } from '../../platform'
import { base64ToBytes, fs, join } from './fsx'
import { readProject, readTimeline } from './projects'

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; type: string }
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
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => { if (this.pending.delete(id)) reject(new Error('El compositor tardó demasiado')) }, timeout)
      this.pending.set(id, { type, resolve: (v) => { clearTimeout(t); resolve(v) }, reject: (e) => { clearTimeout(t); reject(e) } })
      this.post({ ...msg, type, id })
    })
  }

  reload() {
    return this.exclusive(async () => {
      await this.ready
      await new Promise((resolve, reject) => {
        this.reloading = { type: 'reload', resolve, reject }
        this.post({ type: 'reload' })
        setTimeout(() => { if (this.reloading) { this.reloading = null; resolve(false) } }, 30000)
      })
    })
  }

  /** Fotograma en t como base64 (jpeg o png) del tamaño pedido. */
  frame(t: number, width: number, height: number, format: 'jpeg' | 'png' = 'png', quality = 0.92) {
    return this.exclusive(async () => {
      await this.ready
      const r = await this.request<{ data: string; mime: string; width: number; height: number }>('frame', { t, width, height, format, quality })
      return r
    })
  }

  /** Fotograma como ImageBitmap (sin compresión), para la exportación con WebCodecs. */
  bitmap(t: number, width: number, height: number) {
    return this.exclusive(async () => {
      await this.ready
      const r = await this.request<{ bitmap: ImageBitmap }>('frame', { t, width, height, format: 'bitmap' })
      return r.bitmap
    })
  }

  audit(t: number) {
    return this.exclusive(async () => {
      await this.ready
      const r = await this.request<{ issues: any[] }>('audit', { t })
      return r.issues
    })
  }

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
  clearTimeout(cur.timer)
  cur.timer = window.setTimeout(() => { cur.destroy(); if (pool.get(key) === cur) pool.delete(key) }, 90_000)
  return cur
}

export function closeFramePool(projectId?: string) {
  for (const [k, r] of pool) if (!projectId || k.startsWith(projectId + '|')) { clearTimeout(r.timer); r.destroy(); pool.delete(k) }
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

async function toBase64(cv: HTMLCanvasElement | OffscreenCanvas, mime = 'image/png', quality?: number) {
  const blob = cv instanceof HTMLCanvasElement
    ? await new Promise<Blob>((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('No se pudo codificar la imagen'))), mime, quality))
    : await cv.convertToBlob({ type: mime, quality })
  const { blobToBase64 } = await import('./fsx')
  return blobToBase64(blob)
}

/** Renderiza fotogramas en los instantes pedidos y devuelve PNG (base64). */
export async function renderFrames(projectId: string, tlId: string | undefined, times: number[], width = 1280, withTime = false, format: 'png' | 'jpeg' = 'png') {
  const pr = readProject(projectId)
  const tid = tlId || pr.activeTimeline
  const { w, h } = sizeFor(projectId, width)
  const r = await getRenderer(projectId, tid)
  const out: Array<{ t: number; data: string; mime: string }> = []
  for (const t of times) {
    const f = await r.frame(t, w, h, withTime ? 'png' : format, 0.9)
    if (!withTime) { out.push({ t, data: f.data, mime: f.mime }); continue }
    const bmp = await decode(f.data, f.mime)
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h
    const g = cv.getContext('2d')!
    g.drawImage(bmp, 0, 0); bmp.close()
    drawLabel(g, label(t), w)
    out.push({ t, data: await toBase64(cv, format === 'png' ? 'image/png' : 'image/jpeg', 0.9), mime: format === 'png' ? 'image/png' : 'image/jpeg' })
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
  const cols = opts.cols || Math.min(4, times.length)
  const frames = await renderFrames(projectId, tid, times, opts.width || 480, true, 'jpeg')
  const { w, h } = sizeFor(projectId, opts.width || 480)
  const rows = Math.ceil(frames.length / cols)
  const pad = 8
  const cv = document.createElement('canvas')
  cv.width = pad + cols * (w + pad); cv.height = pad + rows * (h + pad)
  const g = cv.getContext('2d')!
  g.fillStyle = '#16181d'; g.fillRect(0, 0, cv.width, cv.height)
  for (let i = 0; i < frames.length; i++) {
    const bmp = await decode(frames[i].data, frames[i].mime)
    g.drawImage(bmp, pad + (i % cols) * (w + pad), pad + Math.floor(i / cols) * (h + pad), w, h)
    bmp.close()
  }
  return { png: await toBase64(cv, 'image/png'), times }
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
