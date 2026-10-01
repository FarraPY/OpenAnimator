/**
 * Worker que corre Claude Code (extraído en el teléfono del paquete oficial de npm) como si fuera un proceso de Node.
 * Un Worker por conversación: cerrarlo es matar el proceso. Ahí no hay window ni document, así que el SDK de Anthropic
 * que viene adentro no se cree en un navegador.
 *
 * Mensajes de la página: start {opts}, stdin {data}, stdin-end, mcp-reply {id, status, headers, body}.
 * Mensajes a la página: stdout/stderr {data}, exit {code}, crash {error}, fs {files: [ruta, bytes|null][]},
 *   mcp {id, url, method, headers, body}, ready {ms}.
 */
import { install, mod, ProcessExit } from './index.js'

globalThis.__oaMod = mod
let rt = null
const mcpWaiting = new Map()
let mcpSeq = 0
const nativeFetch = globalThis.fetch.bind(globalThis)
const ANTHROPIC = /^https:\/\/api\.anthropic\.com\//

/**
 * fetch de Claude Code: el MCP de OpenAnimator (http://oa.mcp/…) lo atiende la página (ahí están el proyecto y las
 * herramientas); a la API de Anthropic se le agrega el encabezado que habilita CORS: el pedido va directo desde el
 * teléfono, sin servidores en el medio.
 */
function makeFetch(extraAnthropicBase) {
  return async function fetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith('http://oa.mcp/')) {
      const req = new Request(input, init)
      const id = ++mcpSeq
      const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text()
      postMessage({ type: 'mcp', id, url, method: req.method, headers: Object.fromEntries(req.headers), body })
      const r = await new Promise((res) => mcpWaiting.set(id, res))
      return new Response(r.body, { status: r.status, headers: r.headers })
    }
    if (ANTHROPIC.test(url) || (extraAnthropicBase && url.startsWith(extraAnthropicBase))) {
      const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined))
      headers.set('anthropic-dangerous-direct-browser-access', 'true')
      return nativeFetch(input, { ...init, headers })
    }
    return nativeFetch(input, init)
  }
}

/**
 * Bun evalúa algunos trozos recién cuando se los pide (import.meta.require dentro de funciones, sincrónico). Acá se
 * precargan con import() después de los imports estáticos del punto de entrada (el mismo orden que en Bun) y
 * __oaChunk los devuelve al instante.
 */
const chunks = new Map()
globalThis.__oaChunk = (p) => {
  const m = chunks.get(p)
  if (!m) throw new Error(`Trozo de Claude Code no precargado: ${p}`)
  return m
}

function start(o) {
  const dirty = new Set()
  let timer = null
  const flush = () => {
    timer = null
    const files = []
    for (const p of dirty) {
      try { const st = rt.fs.statSync(p); if (st.isFile()) files.push([p, new Uint8Array(rt.fs.readFileSync(p))]) } catch { files.push([p, null]) }
    }
    dirty.clear()
    if (files.length) postMessage({ type: 'fs', files })
  }
  rt = install({
    ...o,
    stdout: (s) => postMessage({ type: 'stdout', data: s }),
    stderr: (s) => postMessage({ type: 'stderr', data: s }),
    exit: (code) => { if (timer) flush(); postMessage({ type: 'exit', code }) },
    // Se guarda lo de la carpeta personal (configuración, sesiones y conversaciones de Claude Code).
    onFsChange: (p) => { if (typeof p === 'string' && p.startsWith(o.home + '/')) { dirty.add(p); if (!timer) timer = setTimeout(flush, 300) } },
    fetch: makeFetch(o.env?.ANTHROPIC_BASE_URL),
  })
  const t0 = performance.now()
  globalThis.__oaPreload = async () => {
    for (const n of o.preload || []) chunks.set('/$bunfs/root/' + n, await import(o.base + '$bunfs/root/' + n))
    postMessage({ type: 'ready', ms: Math.round(performance.now() - t0) })
  }
  import(o.base + '$bunfs/root/cli').catch((e) => { if (!(e instanceof ProcessExit)) postMessage({ type: 'crash', error: String(e?.stack || e) }) })
}

self.addEventListener('message', ({ data: m }) => {
  if (m.type === 'start') start(m.opts)
  else if (m.type === 'stdin') rt?.stdin(m.data)
  else if (m.type === 'stdin-end') rt?.stdinEnd()
  else if (m.type === 'mcp-reply') { mcpWaiting.get(m.id)?.(m); mcpWaiting.delete(m.id) }
})
// Como Node: los errores sin atrapar van a los manejadores de process, si los hay.
self.addEventListener('unhandledrejection', (e) => {
  if (e.reason instanceof ProcessExit) { e.preventDefault(); return }
  const p = globalThis.process
  if (p?.listenerCount?.('unhandledRejection')) { e.preventDefault(); p.emit('unhandledRejection', e.reason, e.promise) }
  else postMessage({ type: 'stderr', data: `[promesa rechazada sin atrapar] ${e.reason?.stack || e.reason}\n` })
})
self.addEventListener('error', (e) => {
  if (e.error instanceof ProcessExit) { e.preventDefault(); return }
  const p = globalThis.process
  if (p?.listenerCount?.('uncaughtException')) { e.preventDefault(); p.emit('uncaughtException', e.error) }
  else postMessage({ type: 'stderr', data: `[error sin atrapar] ${e.error?.stack || e.message}\n` })
})
