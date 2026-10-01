/**
 * Service Worker de OpenAnimator en el iPhone (lo arma scripts/build-iphone.mjs; corre en el alcance de la app).
 *
 *   <base>fs/<ruta>              archivo de la carpeta de datos
 *   <base>p/<proyecto>/<ruta>    archivo de un proyecto (a las escenas HTML se les agrega el runtime)
 *   <base>p/<proyecto>/__oa/…    runtime y compositor (app/runtime), del mismo origen que las escenas
 *   <base>ut/<plantilla>/…       plantillas del usuario
 *   <base>cc/<versión>/…         Claude Code extraído en el teléfono (Cache Storage "oa-claude-<versión>")
 *   el resto                     la app (precargada: funciona sin conexión)
 *
 * Los archivos de los datos se los pide a la página que los tiene (WebFS: índice y archivos chicos en memoria, el resto
 * en OPFS): así una escena recién escrita por Claude se ve al instante, sin esperar a que se guarde. Con Range para
 * que el visor lea los videos por tramos.
 */
const sw = self as any
const VERSION = '__OA_VERSION__'
const APP_CACHE = `oa-app-${VERSION}`
const SCOPE = new URL(sw.registration.scope).pathname // p. ej. "/OpenAnimator/"

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', glb: 'model/gltf-binary', gltf: 'model/gltf+json', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', wasm: 'application/wasm', pdf: 'application/pdf',
}
const mimeOf = (p: string) => MIME[(p.split('.').pop() || '').toLowerCase()] || 'application/octet-stream'

sw.addEventListener('install', (e: any) => {
  e.waitUntil((async () => {
    const list: string[] = await fetch(`${SCOPE}precache.json`, { cache: 'no-store' }).then((r) => r.json()).catch(() => [])
    const cache = await caches.open(APP_CACHE)
    // De a varios: si uno falla, la app igual se instala (se baja la próxima vez que se pida).
    for (let i = 0; i < list.length; i += 16) await Promise.all(list.slice(i, i + 16).map((u) => cache.add(SCOPE + u).catch(() => {})))
    await sw.skipWaiting()
  })())
})
sw.addEventListener('activate', (e: any) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('oa-app-') && k !== APP_CACHE) await caches.delete(k)
    await sw.clients.claim()
  })())
})

// ── archivos de los datos: los da la página dueña del WebFS ─────────────────────
let ownerId = ''
sw.addEventListener('message', (e: any) => { if (e.data?.type === 'fs-owner') ownerId = e.source?.id || '' })

/** La página de la app (no un iframe de escena, que también es una "ventana" del mismo origen). */
const isApp = (c: any) => !/^(p|ut|fs|cc)\//.test(decodeURIComponent(new URL(c.url).pathname.slice(SCOPE.length)))

async function askPage(path: string): Promise<{ blob: Blob } | null> {
  const clients: any[] = await sw.clients.matchAll({ type: 'window' })
  // iOS cierra el Service Worker cuando no se usa: al volver, ownerId ya no está y se busca la página de la app.
  const owner = clients.find((c) => c.id === ownerId) || clients.find(isApp)
  if (!owner) return null
  return new Promise((resolve) => {
    const ch = new MessageChannel()
    const t = setTimeout(() => resolve(null), 20000)
    ch.port1.onmessage = (m) => { clearTimeout(t); resolve(m.data?.blob ? { blob: m.data.blob } : null) }
    owner.postMessage({ type: 'fs-read', path }, [ch.port2])
  })
}

function rangeResponse(req: Request, blob: Blob, type: string) {
  const headers: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '')
  if (!m) return new Response(blob, { status: 200, headers: { ...headers, 'Content-Length': String(blob.size) } })
  let start = m[1] ? +m[1] : Math.max(0, blob.size - +m[2])
  const end = m[1] && m[2] ? Math.min(+m[2], blob.size - 1) : blob.size - 1
  if (!m[1] && !m[2]) start = 0
  if (start > end || start >= blob.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } })
  return new Response(blob.slice(start, end + 1), { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${blob.size}`, 'Content-Length': String(end - start + 1) } })
}

/** El runtime de escenas, del mismo origen que la escena (como en la PC y en Android). */
function injectRuntime(html: string, tag: string) {
  if (html.includes('oa-runtime.js')) return html
  const m = /<head[^>]*>/i.exec(html) || /<!doctype[^>]*>/i.exec(html)
  return m ? html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length) : tag + html
}

async function dataFile(req: Request, path: string, projectId?: string) {
  const r = await askPage(path)
  if (!r) return new Response('No existe: ' + path, { status: 404 })
  const type = mimeOf(path)
  if (projectId && /\.html?$/i.test(path)) {
    const html = injectRuntime(await r.blob.text(), `<script src="${SCOPE}p/${encodeURIComponent(projectId)}/__oa/oa-runtime.js"></script>`)
    return new Response(html, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } })
  }
  return rangeResponse(req, r.blob, type)
}

async function appFile(req: Request, url: string) {
  const hit = await caches.match(url, { ignoreSearch: true })
  if (hit) return hit
  const res = await fetch(url, { cache: 'no-cache' })
  if (res.ok && req.method === 'GET') { const c = await caches.open(APP_CACHE); c.put(url, res.clone()).catch(() => {}) }
  return res
}

sw.addEventListener('fetch', (e: any) => {
  const req: Request = e.request
  const url = new URL(req.url)
  if (url.origin !== location.origin || !url.pathname.startsWith(SCOPE) || req.method !== 'GET') return
  const rel = decodeURIComponent(url.pathname.slice(SCOPE.length))
  let m: RegExpExecArray | null
  if (rel.startsWith('fs/')) return e.respondWith(dataFile(req, rel.slice(3)))
  if ((m = /^p\/([^/]+)\/__oa\/(.+)$/.exec(rel))) return e.respondWith(appFile(req, `${SCOPE}app/runtime/${m[2]}`))
  if ((m = /^p\/([^/]+)\/(.+)$/.exec(rel))) return e.respondWith(dataFile(req, `projects/${m[1]}/${m[2]}`, m[1]))
  if (rel.startsWith('ut/')) return e.respondWith(dataFile(req, `templates/${rel.slice(3)}`))
  if (rel.startsWith('cc/')) {
    return e.respondWith(caches.match(url.pathname, { ignoreSearch: true }).then((r) => r || new Response('Claude Code no está instalado en el teléfono', { status: 404 })))
  }
  // La app: precargada; las páginas (navegación) son siempre index.html.
  if (req.mode === 'navigate') return e.respondWith(appFile(req, `${SCOPE}index.html`).catch(() => caches.match(`${SCOPE}index.html`) as Promise<Response>))
  e.respondWith(appFile(req, url.pathname + url.search).catch(() => new Response('Sin conexión', { status: 503 })))
})
