/**
 * Archivos de la carpeta de datos de la app (proyectos, plantillas, ajustes), vía el puente nativo.
 * "projects/<id>/…" es un proyecto esté en la tablet o en la tarjeta SD (Java sabe dónde);
 * "@sd/…" es la carpeta de la app en la tarjeta (su papelera y sus videos exportados).
 */
import { host } from '../host'

/** `vol: 'sd'`: un proyecto que está en la tarjeta SD (sólo al listar "projects"). */
export type Entry = { name: string; dir: boolean; size: number; mtime: number; path?: string; vol?: 'sd' }

const call = <T = any>(m: string, a: Record<string, unknown>) => host().call<T>(m, a)
export type Volume = 'internal' | 'sd'

export const fs = {
  exists: (path: string) => call<boolean>('fs.exists', { path }),
  stat: (path: string) => call<Entry | null>('fs.stat', { path }),
  list: (path: string) => (fs.exists(path) ? call<Entry[]>('fs.list', { path }) : []),
  /** Listado recursivo; las rutas quedan relativas a `path`. */
  walk: (path: string, o: { depth?: number; max?: number; skipHidden?: boolean; skipDirs?: string[] } = {}) =>
    fs.exists(path) ? call<Entry[]>('fs.walk', { path, depth: o.depth ?? 8, max: o.max ?? 10000, skipHidden: o.skipHidden ?? true, skipDirs: o.skipDirs || [] }) : [],
  readText: (path: string) => call<string>('fs.readText', { path }),
  readTextLimited: (path: string, max = 200000) => call<{ text: string; size: number; truncated: boolean }>('fs.readTextLimited', { path, max }),
  writeText: (path: string, text: string) => { call('fs.writeText', { path, text }) },
  /** `volume`: dónde crear un proyecto que todavía no existe (si no, donde eligió el usuario). */
  mkdir: (path: string, volume?: Volume) => { call('fs.mkdir', volume ? { path, volume } : { path }) },
  /** 'sd' si la ruta está en la tarjeta SD, 'internal' si está en la tablet. */
  volume: (path: string) => call<Volume>('fs.volume', { path }),
  delete: (path: string) => call<boolean>('fs.delete', { path }),
  deleteAsync: (path: string) => host().callAsync<boolean>('fs.delete', { path }),
  rename: (from: string, to: string) => { call('fs.rename', { from, to }) },
  copy: (from: string, to: string) => { call('fs.copy', { from, to }) },
  copyAsync: (from: string, to: string) => host().callAsync('fs.copy', { from, to }),
  du: (path: string) => call<number>('fs.du', { path }),
  /** Tamaño de una carpeta entera, calculado en Java en segundo plano (recorrerla puede tardar: no frena la interfaz). */
  duAsync: (path: string) => host().callAsync<number>('fs.du', { path }).catch(() => 0),
  readJSON<T = any>(path: string): T { return JSON.parse(fs.readText(path).replace(/^﻿/, '')) },
  writeJSON(path: string, obj: unknown) { fs.writeText(path, JSON.stringify(obj, null, 2) + '\n') },
  url: (path: string) => host().fsUrl(path),
  async readBytes(path: string): Promise<ArrayBuffer> {
    const r = await fetch(fs.url(path), { cache: 'no-store' })
    if (!r.ok) throw new Error(`No se pudo leer ${path} (${r.status})`)
    return r.arrayBuffer()
  },
  /** Escribe binario por partes (el puente sólo lleva texto: base64). */
  async writeBytes(path: string, data: ArrayBuffer | Uint8Array | Blob) {
    const blob = data instanceof Blob ? data : new Blob([data as BlobPart])
    // iPhone: el archivo entero de una vez (agregar por partes a uno grande fallaba pasado 1,5 MB: no queda en memoria).
    if (host().kind === 'web') { await host().callAsync('fs.writeBlob', { path, blob }); return }
    const CHUNK = 3 * 512 * 1024 // múltiplo de 3: cada parte es base64 válido por sí sola
    if (!blob.size) { call('fs.writeBase64', { path, data: '', append: false }); return }
    for (let off = 0; off < blob.size; off += CHUNK) {
      const b64 = await blobToBase64(blob.slice(off, off + CHUNK))
      call('fs.writeBase64', { path, data: b64, append: off > 0 })
    }
  },
}

export function blobToBase64(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => { const s = String(r.result); res(s.slice(s.indexOf(',') + 1)) }
    r.onerror = () => rej(r.error)
    r.readAsDataURL(b)
  })
}

/**
 * Canvas → base64 sin toBlob: en el WebView de la app, toBlob y convertToBlob codifican en tareas de "tiempo libre" del
 * hilo que no llegan (WebView dibuja sincronizado con Android) y tardan siempre 4 s; toDataURL codifica en el momento
 * (unos ms a 960 px). Devuelve el tipo real: si el formato no se puede, Chromium da PNG.
 */
export function canvasBase64(cv: HTMLCanvasElement, mime = 'image/png', quality?: number): { data: string; mime: string } {
  const url = cv.toDataURL(mime, quality)
  if (url.length < 8) throw new Error('No hay memoria para la imagen') // "data:,": no se pudo crear el lienzo
  return { data: url.slice(url.indexOf(',') + 1), mime: url.slice(5, url.indexOf(';')) || mime }
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// ── rutas (siempre con "/") ─────────────────────────────────────────────────────
export const join = (...parts: string[]) => parts.filter((p) => p !== '').join('/').replace(/\/{2,}/g, '/').replace(/^\/+/, '')
export const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
export const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1)
export const extname = (p: string) => { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i).toLowerCase() : '' }
export const stem = (p: string) => { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(0, i) : b }

/** Normaliza una ruta relativa ("a/./b/../c") y rechaza las que salen de la raíz. */
export function normalizeRel(p: string): string {
  const out: string[] = []
  for (const part of p.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (!out.length) throw new Error('Ruta fuera del proyecto: ' + p); out.pop(); continue }
    out.push(part)
  }
  return out.join('/')
}

export function slugify(s: string) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'proyecto'
}
export function uid(prefix = 'c') { return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` }

/** Nombre libre dentro de una carpeta: base, base-2, base-3… */
export function uniqueName(dir: string, name: string) {
  const ext = extname(name), base = ext ? name.slice(0, -ext.length) : name
  let n = name, i = 2
  while (fs.exists(join(dir, n))) n = `${base}-${i++}${ext}`
  return n
}

/** Hash corto (FNV-1a 64 bits en hex) para claves de caché. */
export function hash(s: string) {
  let h1 = 0x811c9dc5 | 0, h2 = 0x01000193 | 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619)
    h2 = Math.imul(h2 ^ c, 2246822519)
  }
  return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0'))
}
