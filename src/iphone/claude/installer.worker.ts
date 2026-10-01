/**
 * Instala Claude Code en el teléfono (en un Worker, para no trabar la interfaz). Todo pasa en el iPhone: se baja el paquete
 * oficial de npm (@anthropic-ai/claude-code-linux-arm64: el ejecutable de Bun con el JavaScript de Claude Code adentro),
 * se descomprime, se sacan sus módulos, se adaptan para el navegador (transform.ts) y se guardan en Cache Storage
 * ("oa-claude-<versión>", servidos por el Service Worker en <app>cc/<versión>/). OpenAnimator no redistribuye nada de
 * Anthropic: es la copia que el usuario baja de npm.
 *
 * En la app nativa (native: true) los archivos no van a Cache Storage sino al disco del iPhone: el Worker los manda por
 * tandas a la página (files {version, files: [ruta, ArrayBuffer][]}), que los guarda con el puente y contesta ack.
 *
 * Mensajes: install {appBase, version?, tarball?, native?} → progress {phase, done, total} | files | done {manifest} | error {message}
 */
import { readBunGraph } from './bunfs'
import { ready, transformModule, wrapperSource, nodeModuleFile, isCode, type TransformCtx } from './transform'
import nodeNames from './node-names.json'

const PKG = '@anthropic-ai/claude-code-linux-arm64'
const post = (m: any, transfer: Transferable[] = []) => (self as any).postMessage(m, transfer)
let lastProgress = 0
function progress(phase: string, done: number, total: number) {
  const now = Date.now()
  if (now - lastProgress < 120 && done < total) return
  lastProgress = now
  post({ type: 'progress', phase, done, total })
}

/** Lee un .tar (ya descomprimido) y devuelve el contenido de los archivos `want`, sin guardar lo demás. */
async function untar(stream: ReadableStream<Uint8Array>, want: string[]): Promise<Map<string, Blob>> {
  const found = new Map<string, Blob>()
  const reader = stream.getReader()
  let buf = new Uint8Array(0)
  const need = async (n: number) => {
    while (buf.length < n) {
      const { done, value } = await reader.read()
      if (done) return false
      const next = new Uint8Array(buf.length + value.length)
      next.set(buf); next.set(value, buf.length)
      buf = next
    }
    return true
  }
  const skip = async (n: number) => {
    while (n > 0) {
      if (!buf.length && !(await need(1))) throw new Error('El paquete de Claude Code está incompleto')
      const k = Math.min(n, buf.length)
      buf = buf.subarray(k)
      n -= k
    }
  }
  const dec = new TextDecoder()
  const str = (b: Uint8Array) => dec.decode(b.subarray(0, b.indexOf(0) < 0 ? b.length : b.indexOf(0)))
  let longName = ''
  for (;;) {
    if (!(await need(512))) break
    const h = buf.subarray(0, 512)
    if (h.every((x) => x === 0)) break
    const size = parseInt(str(h.subarray(124, 136)).trim() || '0', 8)
    const type = String.fromCharCode(h[156] || 48)
    const prefix = str(h.subarray(345, 500))
    const name = longName || (prefix ? `${prefix}/${str(h.subarray(0, 100))}` : str(h.subarray(0, 100)))
    longName = ''
    buf = buf.subarray(512)
    const padded = Math.ceil(size / 512) * 512
    if (type === 'L') { await need(padded); longName = str(buf.subarray(0, size)); buf = buf.subarray(padded); continue }
    if (want.includes(name)) {
      // El archivo buscado se junta por partes (un Blob), sin un único arreglo gigante.
      // ponytail: el ejecutable (~240 MB) queda en memoria mientras se instala; si molesta en iPhones con poca
      // memoria, escribirlo en OPFS y leer de ahí.
      const parts: Uint8Array[] = []
      let left = size
      while (left > 0) {
        if (!buf.length && !(await need(1))) throw new Error('El paquete de Claude Code está incompleto')
        const take = buf.subarray(0, Math.min(left, buf.length))
        parts.push(take.slice())
        left -= take.length
        buf = buf.subarray(take.length)
      }
      found.set(name, new Blob(parts as BlobPart[]))
      await skip(padded - size)
      if (found.size === want.length) { reader.cancel().catch(() => {}); return found }
      continue
    }
    await skip(padded) // otro archivo del paquete
  }
  return found
}

let ack: ((error?: string) => void) | null = null

async function install(o: { appBase: string; version?: string; tarball?: string; native?: boolean }) {
  let version = o.version || '', tarball = o.tarball || ''
  progress('buscando', 0, 1)
  if (!tarball) {
    const r = await fetch(`https://registry.npmjs.org/${PKG.replace('/', '%2f')}/${version || 'latest'}`, { cache: 'no-store' })
    if (!r.ok) throw new Error(`npm respondió ${r.status} al buscar Claude Code`)
    const meta = await r.json()
    version = meta.version; tarball = meta.dist.tarball
  }
  const res = await fetch(tarball)
  if (!res.ok || !res.body) throw new Error(`No se pudo bajar Claude Code (${res.status})`)
  const total = +(res.headers.get('content-length') || 0)
  let got = 0
  const counted = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(c, ctl) { got += c.byteLength; progress('descargando', got, total || got); ctl.enqueue(c) } }))
  const files = await untar(counted.pipeThrough(new DecompressionStream('gzip') as any), ['package/claude', 'package/package.json'])
  const exe = files.get('package/claude')
  if (!exe) throw new Error('El paquete de Claude Code no trae el programa (package/claude)')
  try { version ||= JSON.parse(await files.get('package/package.json')!.text()).version } catch { /* sin package.json */ }
  version ||= /-(\d+\.\d+\.\d+)\.tgz$/.exec(tarball)?.[1] || 'dev'
  progress('descargando', total || got, total || got)

  const read = async (off: number, len: number) => new Uint8Array(await exe.slice(off, off + len).arrayBuffer())
  const { modules, entry } = await readBunGraph(read, exe.size)
  await ready
  const base = `${o.appBase}cc/${version}/`
  const cacheName = `oa-claude-${version}`
  // Dónde se guarda cada archivo: Cache Storage (Safari) o, por tandas de ~4 MB, el disco del iPhone (app nativa).
  let cache: Cache | null = null
  let batch: Array<[string, ArrayBuffer]> = [], batchBytes = 0
  const flushBatch = async () => {
    if (!batch.length) return
    const files = batch
    batch = []; batchBytes = 0
    const done = new Promise<void>((resolve, reject) => { ack = (error) => (error ? reject(new Error(error)) : resolve()) })
    post({ type: 'files', version, files }, files.map((f) => f[1])) // transferidos: sin otra copia
    await done
  }
  const save = async (rel: string, body: Uint8Array | string, type: string) => {
    if (!o.native) { await cache!.put(`${base}${rel}`, new Response(body as BodyInit, { headers: { 'Content-Type': type } })); return }
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
    batch.push([rel, bytes.slice().buffer])
    batchBytes += bytes.byteLength
    if (batchBytes >= 4 * 1024 * 1024) await flushBatch()
  }
  if (!o.native) { await caches.delete(cacheName); cache = await caches.open(cacheName) }
  const ctx: TransformCtx = { base, externals: new Map(), lazy: new Set() }
  const loaders: Record<string, string> = {}, assets: string[] = []
  const dec = new TextDecoder()
  let i = 0
  for (const m of modules) {
    const bytes = await read(m.off, m.len)
    loaders[m.name] = m.loader
    let body: Uint8Array | string = bytes, type = 'application/octet-stream'
    if (isCode(m.name)) {
      type = 'text/javascript; charset=utf-8'
      try { body = transformModule(m.name, dec.decode(bytes), ctx) } catch { /* no es un módulo ES (una librería que va como recurso): tal cual */ }
    } else assets.push(m.name)
    await save(`$bunfs/root/${m.name}`, body, type)
    progress('adaptando', ++i, modules.length)
  }
  const names = nodeNames as Record<string, string[]>
  for (const [spec, used] of ctx.externals) {
    const b = spec.replace(/^node:/, '')
    await save(`oa-node/${nodeModuleFile(spec)}`, wrapperSource(b, [...(names[b] || []), ...used]), 'text/javascript; charset=utf-8')
  }
  const manifest = { version, entry, base, loaders, assets, preload: [...ctx.lazy].filter((n) => /\.m?js$/.test(n)), installedAt: Date.now(), size: exe.size }
  await save('manifest.json', JSON.stringify(manifest), 'application/json') // al final: sin él, la versión no cuenta como instalada
  await flushBatch()
  if (!o.native) for (const k of await caches.keys()) if (k.startsWith('oa-claude-') && k !== cacheName) await caches.delete(k)
  return manifest
}

self.addEventListener('message', async ({ data: m }: MessageEvent) => {
  if (m?.type === 'ack') { const a = ack; ack = null; a?.(m.error); return }
  if (m?.type !== 'install') return
  try { post({ type: 'done', manifest: await install(m) }) } catch (e: any) { post({ type: 'error', message: String(e?.message || e) }) }
})
