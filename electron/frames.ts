/**
 * Herramientas de "visión" para la IA y el editor: ver fotogramas, hoja de contactos
 * y auditoría de layout. Usan el mismo compositor que la exportación.
 */
import { BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { openCompositor, captureExact, renderAt } from './capture'
import { readProject, projectDir, readTimeline } from './projects'
import { CACHE_DIR, ffmpegPaths } from './paths'
import { run } from './ffmpeg'

type Pooled = { win: BrowserWindow; key: string; busy: Promise<unknown>; timer?: NodeJS.Timeout }
const pool = new Map<string, Pooled>()

async function getWin(projectId: string, tlId: string, w: number, h: number) {
  const key = `${projectId}|${tlId}|${w}x${h}`
  let p = pool.get(key)
  if (p && p.win.isDestroyed()) { pool.delete(key); p = undefined }
  if (!p) {
    const pr = readProject(projectId)
    const win = await openCompositor(projectId, tlId, pr.width, pr.height, w, h)
    p = { win, key, busy: Promise.resolve() }
    pool.set(key, p)
  } else {
    // El timeline pudo cambiar en disco: recargar antes de usar.
    await p.win.webContents.executeJavaScript('window.__oaCompositor.reload()')
  }
  clearTimeout(p.timer)
  const cur = p
  cur.timer = setTimeout(() => { if (!cur.win.isDestroyed()) cur.win.destroy(); pool.delete(key) }, 90_000)
  return p
}

function exclusive<T>(p: Pooled, fn: () => Promise<T>): Promise<T> {
  const job = p.busy.then(fn, fn)
  p.busy = job.catch(() => {})
  return job
}

function sizeFor(projectId: string, width: number) {
  const pr = readProject(projectId)
  const w = Math.max(160, Math.min(3840, Math.round(width / 2) * 2))
  const h = Math.round((w * pr.height) / pr.width / 2) * 2
  return { w, h }
}

const label = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`

async function withLabel(win: BrowserWindow, text: string | null) {
  const js = text == null
    ? `(function(){var e=document.getElementById('__oa_label'); if(e) e.remove();})()`
    : `(function(){var e=document.getElementById('__oa_label'); if(!e){e=document.createElement('div'); e.id='__oa_label'; e.style.cssText='position:fixed;left:14px;top:12px;z-index:99999;padding:4px 12px;border-radius:8px;background:rgba(0,0,0,.72);color:#fff;font:600 30px/1.2 system-ui';document.body.appendChild(e);} e.textContent=${JSON.stringify(text)};})()`
  await win.webContents.executeJavaScript(js)
}

/** Renderiza fotogramas en los instantes pedidos y devuelve PNGs. */
export async function renderFrames(projectId: string, tlId: string | undefined, times: number[], width = 1280, withTime = false) {
  const pr = readProject(projectId)
  const tid = tlId || pr.activeTimeline
  const { w, h } = sizeFor(projectId, width)
  const p = await getWin(projectId, tid, w, h)
  return exclusive(p, async () => {
    const out: Array<{ t: number; png: Buffer }> = []
    for (const t of times) {
      await renderAt(p.win, t)
      if (withTime) await withLabel(p.win, label(t))
      const img = await captureExact(p.win, w, h)
      if (withTime) await withLabel(p.win, null)
      out.push({ t, png: img.toPNG() })
    }
    return out
  })
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
  const frames = await renderFrames(projectId, tid, times, opts.width || 480, true)
  const dir = fs.mkdtempSync(path.join(CACHE_DIR, 'sheet-'))
  frames.forEach((f, i) => fs.writeFileSync(path.join(dir, `f_${String(i).padStart(3, '0')}.png`), f.png))
  const rows = Math.ceil(frames.length / cols)
  const out = path.join(dir, 'hoja.png')
  const r = await run(ffmpegPaths().ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-framerate', '1', '-i', path.join(dir, 'f_%03d.png'),
    '-vf', `tile=${cols}x${rows}:padding=8:margin=8:color=0x16181d`, '-frames:v', '1', out])
  if (r.code !== 0) throw new Error('No se pudo armar la hoja de contactos: ' + r.stderr.slice(-300))
  const png = fs.readFileSync(out)
  fs.rmSync(dir, { recursive: true, force: true })
  return { png, times }
}

export type AuditIssue = { kind: string; text: string; clip?: string; t: number; box?: number[] }

/** Auditoría de layout: barre el timeline y reporta textos fuera de cuadro o superpuestos. */
export async function auditLayout(projectId: string, tlId: string | undefined, opts: { step?: number; from?: number; to?: number }) {
  const pr = readProject(projectId)
  const tid = tlId || pr.activeTimeline
  const tl = readTimeline(projectId, tid)
  const step = Math.max(0.1, opts.step || 0.5)
  const a = Math.max(0, opts.from ?? 0), b = Math.min(tl.duration, opts.to ?? tl.duration)
  const p = await getWin(projectId, tid, pr.width, pr.height)
  return exclusive(p, async () => {
    const groups = new Map<string, { kind: string; text: string; clip?: string; from: number; to: number; count: number; box?: number[] }>()
    for (let t = a; t < b; t += step) {
      const issues: AuditIssue[] = await p.win.webContents.executeJavaScript(`window.__oaCompositor.audit(${t.toFixed(4)})`)
      for (const is of issues) {
        const k = `${is.kind}|${is.text}|${is.clip}`
        const g = groups.get(k)
        if (g) { g.to = is.t; g.count++ } else groups.set(k, { kind: is.kind, text: is.text, clip: is.clip, from: is.t, to: is.t, count: 1, box: is.box })
      }
    }
    return { timeline: tid, step, from: a, to: b, issues: [...groups.values()] }
  })
}

export function closeFramePool(projectId?: string) {
  for (const [k, p] of pool) if (!projectId || k.startsWith(projectId + '|')) { if (!p.win.isDestroyed()) p.win.destroy(); pool.delete(k) }
}

export function projectPath(id: string) { return projectDir(id) }
