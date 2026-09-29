/**
 * Datos visuales de los medios, cacheados en data/cache:
 *  - picos de audio (forma de onda del timeline): 100 valores por segundo, 0–255.
 *  - miniaturas de video (panel de medios).
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CACHE_DIR, PROJECTS_DIR, ffmpegPaths } from './paths'

export const PEAKS_PER_SEC = 100

const key = (file: string) => {
  const st = fs.statSync(file)
  return crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 20)
}
const inflight = new Map<string, Promise<any>>()
function once<T>(k: string, fn: () => Promise<T>): Promise<T> {
  if (!inflight.has(k)) inflight.set(k, fn().finally(() => inflight.delete(k)))
  return inflight.get(k)!
}

/** Picos de amplitud (Uint8 en base64) a PEAKS_PER_SEC por segundo. */
export function audioPeaks(file: string): Promise<{ rate: number; data: string }> {
  const k = key(file)
  const out = path.join(CACHE_DIR, 'peaks', `${k}.bin`)
  if (fs.existsSync(out)) return Promise.resolve({ rate: PEAKS_PER_SEC, data: fs.readFileSync(out).toString('base64') })
  return once(out, () => new Promise((resolve, reject) => {
    // 8 kHz mono s16 alcanza para la envolvente; se agrupa en ventanas de 80 muestras.
    const sr = 8000, win = sr / PEAKS_PER_SEC
    const p = spawn(ffmpegPaths().ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(sr), '-f', 's16le', '-'], { windowsHide: true })
    const peaks: number[] = []
    let n = 0, max = 0, carry: Buffer | null = null
    p.stdout.on('data', (d: Buffer) => {
      if (carry) { d = Buffer.concat([carry, d]); carry = null }
      const len = d.length - (d.length % 2)
      if (len < d.length) carry = d.subarray(len)
      for (let i = 0; i < len; i += 2) {
        const v = Math.abs(d.readInt16LE(i))
        if (v > max) max = v
        if (++n >= win) { peaks.push(max); n = 0; max = 0 }
      }
    })
    p.stderr.on('data', () => {})
    p.on('error', reject)
    p.on('close', () => {
      if (n) peaks.push(max)
      // Escala con raíz para que las partes suaves (voz baja, música de fondo) se vean.
      const buf = Buffer.from(peaks.map((v) => Math.min(255, Math.round(Math.sqrt(v / 32768) * 255))))
      fs.mkdirSync(path.dirname(out), { recursive: true })
      fs.writeFileSync(out, buf)
      resolve({ rate: PEAKS_PER_SEC, data: buf.toString('base64') })
    })
  }))
}

/** Miniatura JPG de un video (fotograma a ~10 % o 1 s). Devuelve la ruta en caché. */
export function videoThumb(file: string, at = 1): Promise<string> {
  const out = path.join(CACHE_DIR, 'thumbs', `${key(file)}.jpg`)
  if (fs.existsSync(out)) return Promise.resolve(out)
  return once(out, () => new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    const p = spawn(ffmpegPaths().ffmpeg, ['-v', 'error', '-y', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', out], { windowsHide: true })
    p.on('error', reject)
    p.on('close', (code) => {
      if (code === 0 && fs.existsSync(out)) return resolve(out)
      if (at > 0) return videoThumb(file, 0).then(resolve, reject) // video más corto que 1 s
      reject(new Error('sin miniatura'))
    })
  }))
}

function dirSize(dir: string): number {
  let total = 0
  if (!fs.existsSync(dir)) return 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name)
    try { total += e.isDirectory() ? dirSize(f) : fs.statSync(f).size } catch { /* ignore */ }
  }
  return total
}

/** Tamaño de cada caché (bytes). */
export function cacheStats() {
  let exportCache = 0
  if (fs.existsSync(PROJECTS_DIR)) for (const id of fs.readdirSync(PROJECTS_DIR)) exportCache += dirSize(path.join(PROJECTS_DIR, id, '.oa-cache'))
  return { export: exportCache, peaks: dirSize(path.join(CACHE_DIR, 'peaks')), thumbs: dirSize(path.join(CACHE_DIR, 'thumbs')) }
}

export function clearCache(kind: 'export' | 'peaks' | 'thumbs') {
  if (kind === 'export') {
    if (fs.existsSync(PROJECTS_DIR)) for (const id of fs.readdirSync(PROJECTS_DIR)) fs.rmSync(path.join(PROJECTS_DIR, id, '.oa-cache'), { recursive: true, force: true })
  } else fs.rmSync(path.join(CACHE_DIR, kind), { recursive: true, force: true })
  return cacheStats()
}

let _ffv: string | null = null
export function ffmpegVersion(): Promise<string> {
  if (_ffv) return Promise.resolve(_ffv)
  return new Promise((res) => {
    const p = spawn(ffmpegPaths().ffmpeg, ['-version'], { windowsHide: true })
    let o = ''
    p.stdout.on('data', (d) => { o += d })
    p.on('close', () => { _ffv = (o.split('\n')[0] || '').replace(/^ffmpeg version\s*/, '').split(' ')[0] || '?'; res(_ffv) })
    p.on('error', () => res('?'))
  })
}
