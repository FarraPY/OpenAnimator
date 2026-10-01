/**
 * Worker que corre Claude Code (extraído en el teléfono del paquete oficial de npm) como si fuera un proceso de Node.
 * Un Worker por conversación: cerrarlo es matar el proceso. Ahí no hay window ni document, así que el SDK de Anthropic
 * que viene adentro no se cree en un navegador.
 *
 * Mensajes de la página: start {opts}, stdin {data}, stdin-end, mcp-reply {id, status, headers, body},
 *   net-event {ev: {id, type: head|chunk|end|error, …}}, http-request {port, url}.
 * Mensajes a la página: stdout/stderr {data}, exit {code}, crash {error}, fs {files: [ruta, bytes|null][]},
 *   mcp {id, url, method, headers, body}, ready {ms}, net {id, url, method, headers, body}, net-cancel {id};
 *   al iniciar sesión: login-url {manual, automatic}, login-token {token, expiresAt}, login-error {error}.
 */
import { install, mod, ProcessExit, servers } from './index.js'

globalThis.__oaMod = mod
let rt = null
const mcpWaiting = new Map()
let mcpSeq = 0
const nativeFetch = globalThis.fetch.bind(globalThis)
const ANTHROPIC = /^https:\/\/api\.anthropic\.com\//
/** Lo de Anthropic, en la app: por la red de iOS (con una cuenta del plan, la API rechaza los pedidos de un navegador). */
const APP = /^https:\/\/(api\.anthropic\.com|platform\.claude\.com|claude\.ai|console\.anthropic\.com)\//
const nets = new Map()
let netSeq = 0

/**
 * fetch por la app (Bridge.swift http.stream → NetStream.swift): los encabezados tal cual (un Request del navegador
 * quitaría algunos), sin Origin ni CORS; la respuesta llega por partes (net-event: head, chunk, end, error) a un
 * ReadableStream, así el streaming de Claude sigue andando. Cancelar (signal) corta el pedido en iOS.
 */
async function appFetch(input, init = {}) {
  const req = new Request(input, init)
  const headers = {}
  new Headers(input instanceof Request ? input.headers : undefined).forEach((v, k) => { headers[k] = v })
  new Headers(init.headers || undefined).forEach((v, k) => { headers[k] = v })
  const body = req.method === 'GET' || req.method === 'HEAD' ? '' : Buffer.from(await req.arrayBuffer()).toString('base64')
  const signal = init.signal || (input instanceof Request ? input.signal : undefined)
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  const id = `${Date.now().toString(36)}-${++netSeq}-${Math.random().toString(36).slice(2, 8)}`
  return new Promise((resolve, reject) => {
    let ctrl = null
    let done = false
    const finish = () => { done = true; nets.delete(id); signal?.removeEventListener('abort', onAbort) }
    const onAbort = () => {
      if (done) return
      const e = signal.reason ?? new DOMException('Aborted', 'AbortError')
      finish()
      postMessage({ type: 'net-cancel', id })
      reject(e)
      try { ctrl?.error(e) } catch { /* ignore */ }
    }
    const stream = new ReadableStream({ start(c) { ctrl = c }, cancel() { if (!done) { finish(); postMessage({ type: 'net-cancel', id }) } } })
    signal?.addEventListener('abort', onAbort, { once: true })
    nets.set(id, (ev) => {
      if (ev.type === 'head') resolve(new Response([101, 204, 205, 304].includes(ev.status) ? null : stream, { status: ev.status, headers: ev.headers }))
      else if (ev.type === 'chunk') { try { ctrl.enqueue(Buffer.from(ev.data, 'base64')) } catch { /* ya se cerró */ } }
      else if (ev.type === 'end') { finish(); try { ctrl.close() } catch { /* ignore */ } }
      else if (ev.type === 'error') {
        finish()
        const e = new TypeError(ev.message || 'Error de red')
        reject(e)
        try { ctrl.error(e) } catch { /* ignore */ }
      }
    })
    postMessage({ type: 'net', id, url: req.url, method: req.method, headers, body })
  })
}

/**
 * fetch de Claude Code: el MCP de OpenAnimator (http://oa.mcp/…) lo atiende la página (ahí están el proyecto y las
 * herramientas); a la API de Anthropic se le agrega el encabezado que habilita CORS: el pedido va directo desde el
 * teléfono, sin servidores en el medio.
 */
function makeFetch(extraAnthropicBase, viaApp) {
  return async function fetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (viaApp && (APP.test(url) || (extraAnthropicBase && url.startsWith(extraAnthropicBase)))) return appFetch(input, init)
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

/**
 * Iniciar sesión (lo mismo que `claude setup-token`, sin la interfaz de la terminal): la clase de OAuth del Claude Code
 * instalado (o.login.chunk, la encuentra la app) arma la dirección de la página de Claude, espera la vuelta en su
 * servidor local (se la entrega la app: http-request) y canjea el código por un token de un año, sólo para usar Claude.
 */
async function login(o) {
  await globalThis.__oaPreload()
  const m = await import(o.base + o.login.chunk)
  const OAuth = Object.values(m).find((v) => typeof v === 'function' && typeof v.prototype?.startOAuthFlow === 'function')
  if (!OAuth) throw new Error('Esta versión de Claude Code no trae el inicio de sesión que usa la app.')
  const t = await new OAuth().startOAuthFlow(async (manual, automatic) => postMessage({ type: 'login-url', manual, automatic }), {
    loginWithClaudeAi: true, inferenceOnly: true, expiresIn: 365 * 24 * 3600, skipBrowserOpen: true,
  })
  postMessage({ type: 'login-token', token: t.accessToken, expiresAt: t.expiresAt })
}

function start(o) {
  if (o.login) globalThis.__oaAllowListen = true
  if (o.native) {
    // Sin XMLHttpRequest, axios (lo que usa Claude Code para la cuenta y otros pedidos) va por fetch y de ahí a la red
    // de iOS, como el chat.
    try { delete globalThis.XMLHttpRequest } catch { /* ignore */ }
    if (globalThis.XMLHttpRequest) globalThis.XMLHttpRequest = undefined
  }
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
    fetch: makeFetch(o.env?.ANTHROPIC_BASE_URL, !!o.native),
  })
  const t0 = performance.now()
  globalThis.__oaPreload = async () => {
    for (const n of o.preload || []) chunks.set('/$bunfs/root/' + n, await import(o.base + '$bunfs/root/' + n))
    postMessage({ type: 'ready', ms: Math.round(performance.now() - t0) })
  }
  if (o.login) { login(o).catch((e) => { if (!(e instanceof ProcessExit)) postMessage({ type: 'login-error', error: String(e?.message || e) }) }); return }
  import(o.base + '$bunfs/root/cli').catch((e) => { if (!(e instanceof ProcessExit)) postMessage({ type: 'crash', error: String(e?.stack || e) }) })
}

self.addEventListener('message', ({ data: m }) => {
  if (m.type === 'start') start(m.opts)
  else if (m.type === 'stdin') rt?.stdin(m.data)
  else if (m.type === 'stdin-end') rt?.stdinEnd()
  else if (m.type === 'mcp-reply') { mcpWaiting.get(m.id)?.(m); mcpWaiting.delete(m.id) }
  else if (m.type === 'net-event') nets.get(m.ev?.id)?.(m.ev)
  else if (m.type === 'http-request') {
    // La vuelta del navegador, que recibió la app: al servidor local que la espera (sólo lee url y host).
    const res = { statusCode: 200, writeHead(code) { this.statusCode = code; return this }, setHeader() {}, getHeader() {}, removeHeader() {}, write() { return true }, end() { return this } }
    servers.get(m.port)?.emit('request', { url: m.url, method: 'GET', headers: { host: `localhost:${m.port}` } }, res)
  }
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
