/**
 * Protocolo oa:// — sirve la app y los proyectos con soporte de Range (para videos)
 * e inyecta el runtime de escenas en cada HTML de un proyecto.
 *
 *   oa://app/<ruta>            → carpeta app/ (runtime, compositor)
 *   oa://p/<proyecto>/<ruta>   → carpeta del proyecto
 *   oa://p/<proyecto>/__oa/…   → runtime/compositor (mismo origen que las escenas)
 */
import { protocol } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { APP_DIR, DATA_DIR } from './paths'
import { projectDir } from './projects'

export function registerSchemes() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'oa', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } },
  ])
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.wasm': 'application/wasm',
}

const RUNTIME_TAG = '<script src="oa://app/runtime/oa-runtime.js"></script>'

function injectRuntime(html: string) {
  if (html.includes('oa-runtime.js')) return html
  const m = /<head[^>]*>/i.exec(html)
  if (m) return html.slice(0, m.index + m[0].length) + RUNTIME_TAG + html.slice(m.index + m[0].length)
  const d = /<!doctype[^>]*>/i.exec(html)
  if (d) return html.slice(0, d.index + d[0].length) + RUNTIME_TAG + html.slice(d.index + d[0].length)
  return RUNTIME_TAG + html
}

function resolveUrl(u: URL): { file: string; inject: boolean } | null {
  const parts = decodeURIComponent(u.pathname).replace(/^\/+/, '')
  let root: string, rel: string, inject = false
  if (u.host === 'app') {
    root = APP_DIR; rel = parts
  } else if (u.host === 'ut') {
    root = path.join(DATA_DIR, 'templates'); rel = parts   // plantillas del usuario (vistas previas)
  } else if (u.host === 'p') {
    const slash = parts.indexOf('/')
    const id = slash < 0 ? parts : parts.slice(0, slash)
    rel = slash < 0 ? '' : parts.slice(slash + 1)
    if (rel.startsWith('__oa/')) {
      // Runtime y compositor servidos DESDE el origen del proyecto (mismo origen que las escenas).
      root = path.join(APP_DIR, 'runtime'); rel = rel.slice(5)
    } else {
      const dir = projectDir(id)
      if (!dir) return null
      root = dir; inject = true
    }
  } else return null
  const file = path.resolve(root, rel)
  if (file !== root && !file.startsWith(root + path.sep)) return null // path traversal
  return { file, inject }
}

export function handleProtocol() {
  protocol.handle('oa', async (req) => {
    const u = new URL(req.url)
    const r = resolveUrl(u)
    if (!r) return new Response('not found', { status: 404 })
    let stat: fs.Stats
    try { stat = fs.statSync(r.file) } catch { return new Response('not found: ' + u.pathname, { status: 404 }) }
    if (stat.isDirectory()) return new Response('is a directory', { status: 404 })
    const ext = path.extname(r.file).toLowerCase()
    const type = MIME[ext] || 'application/octet-stream'
    const headers: Record<string, string> = { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes' }

    if (r.inject && (ext === '.html' || ext === '.htm')) {
      const html = injectRuntime(fs.readFileSync(r.file, 'utf8'))
      return new Response(html, { status: 200, headers })
    }

    const range = req.headers.get('range')
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      let start = m && m[1] ? parseInt(m[1], 10) : 0
      let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1
      if (m && !m[1] && m[2]) { start = Math.max(0, stat.size - parseInt(m[2], 10)); end = stat.size - 1 }
      end = Math.min(end, stat.size - 1)
      if (start > end || start >= stat.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } })
      const stream = fs.createReadStream(r.file, { start, end })
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 206,
        headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': String(end - start + 1) },
      })
    }
    const stream = fs.createReadStream(r.file)
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: 200, headers: { ...headers, 'Content-Length': String(stat.size) } })
  })
}
