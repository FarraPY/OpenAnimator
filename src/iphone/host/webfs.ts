/**
 * Carpeta de datos de OpenAnimator en el iPhone.
 *
 * El backend (el mismo de Android) usa el disco de forma sincrónica (en la tablet lo hace Java). Acá hay un índice en
 * memoria de toda la carpeta (rutas, tamaños, fechas) y el contenido de los archivos chicos de texto (proyectos,
 * timelines, escenas, ajustes): eso se lee y escribe al instante y se guarda por detrás, en orden. Los medios grandes
 * (videos, audio, exportaciones) nunca se cargan enteros: se leen por partes.
 *
 * Dónde se guarda (Store):
 *   - app nativa (ios/): el disco del iPhone (Documentos, se ve en la app Archivos), por el puente de la app; los
 *     archivos se leen por URL (oa://localhost/fs/…, con Range) — ver NativeStore.
 *   - app web: OPFS, el almacenamiento privado de archivos de Safari — ver OpfsStore.
 */
import { b64decode, b64encode, nativeCall } from './native'

export type Entry = { name: string; dir: boolean; size: number; mtime: number; path?: string }
type FNode = { dir: true; mtime: number } | { dir: false; size: number; mtime: number; data?: Uint8Array }
type Scanned = { path: string; dir: boolean; size: number; mtime: number; data?: Uint8Array }
/** Lo que el codificador o el .zip escriben por partes: datos sueltos (a continuación) o en una posición. */
export type Chunk = Uint8Array | { type: 'write'; position?: number; data: Uint8Array }
type Writable = { write(chunk: Chunk): Promise<void>; close(): Promise<void>; abort(reason?: unknown): Promise<void> }

// .jsonl no: son registros que sólo crecen (las conversaciones de Claude Code); los grandes se leen por partes.
const TEXT = /\.(json|html?|css|m?js|md|txt|srt|vtt|svg|csv|xml|ya?ml|toml)$/i
const MEM_MAX = 4 * 1024 * 1024
const keepInMemory = (path: string, size: number) => size <= MEM_MAX && (TEXT.test(path) || size <= 256 * 1024)

export const norm = (p: string) => {
  const out: string[] = []
  for (const part of String(p).replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (!out.length) throw new Error('Ruta fuera de la carpeta de datos: ' + p); out.pop() } else out.push(part)
  }
  return out.join('/')
}
const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const enoent = (p: string) => Object.assign(new Error(`No existe: ${p}`), { code: 'ENOENT' })
const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/')

/** Dónde se guardan de verdad los archivos. Todo asincrónico; WebFS lo llama en orden. */
interface Store {
  scan(): Promise<Scanned[]>
  write(p: string, data: Uint8Array | Blob): Promise<void>
  remove(p: string): Promise<void>
  mkdir(p: string): Promise<void>
  copy(from: string, to: string): Promise<void>
  /** Mover en un solo paso (si se puede; si no, WebFS copia y borra). */
  move?(from: string, to: string): Promise<void>
  file(p: string): Promise<Blob>
  stream(p: string): Promise<ReadableStream<Uint8Array>>
  writable(p: string): Promise<Writable>
  /** URL para leer el archivo por partes (Range), si hay. */
  url?(p: string): string
}

// ── OPFS (app web) ────────────────────────────────────────────────────────────
class OpfsStore implements Store {
  private dirs = new Map<string, Promise<FileSystemDirectoryHandle>>()
  constructor(private root: FileSystemDirectoryHandle) { this.dirs.set('', Promise.resolve(root)) }

  private dir(p: string): Promise<FileSystemDirectoryHandle> {
    let d = this.dirs.get(p)
    if (!d) {
      d = this.dir(parentOf(p)).then((parent) => parent.getDirectoryHandle(nameOf(p), { create: true }))
      this.dirs.set(p, d)
      d.catch(() => this.dirs.delete(p))
    }
    return d
  }
  async scan() {
    const out: Scanned[] = []
    const walk = async (dir: FileSystemDirectoryHandle, path: string) => {
      const loads: Promise<void>[] = []
      for await (const [name, h] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
        const p = path ? `${path}/${name}` : name
        if (h.kind === 'directory') { out.push({ path: p, dir: true, size: 0, mtime: 0 }); this.dirs.set(p, Promise.resolve(h as FileSystemDirectoryHandle)); await walk(h as FileSystemDirectoryHandle, p) }
        else loads.push((async () => {
          const f = await (h as FileSystemFileHandle).getFile()
          out.push({ path: p, dir: false, size: f.size, mtime: f.lastModified, data: keepInMemory(p, f.size) ? new Uint8Array(await f.arrayBuffer()) : undefined })
        })())
      }
      await Promise.all(loads)
    }
    await walk(this.root, '')
    return out
  }
  async write(p: string, data: Uint8Array | Blob) {
    const fh = await (await this.dir(parentOf(p))).getFileHandle(nameOf(p), { create: true })
    const w = await (fh as any).createWritable()
    await w.write(data)
    await w.close()
  }
  async remove(p: string) {
    for (const k of [...this.dirs.keys()]) if (k === p || k.startsWith(p + '/')) this.dirs.delete(k)
    try { await (await this.dir(parentOf(p))).removeEntry(nameOf(p), { recursive: true }) } catch (e: any) { if (e?.name !== 'NotFoundError') throw e }
  }
  async mkdir(p: string) { await this.dir(p) }
  async copy(from: string, to: string) { await this.write(to, await this.file(from)) }
  async file(p: string): Promise<Blob> { return (await (await this.dir(parentOf(p))).getFileHandle(nameOf(p))).getFile() }
  async stream(p: string) { return (await this.file(p)).stream() as ReadableStream<Uint8Array> }
  async writable(p: string) {
    const fh = await (await this.dir(parentOf(p))).getFileHandle(nameOf(p), { create: true })
    return (await (fh as any).createWritable()) as Writable
  }
}

// ── el disco del iPhone (app nativa) ───────────────────────────────────────────
const PART = 4 * 1024 * 1024 // por mensaje (en base64): el puente no lleva binario
class NativeStore implements Store {
  constructor(private origin: string) {}
  url(p: string) { return `${this.origin}/fs/${encPath(p)}` }
  async scan() {
    const r = await nativeCall<{ entries: Array<[string, number, number, number]>; texts: Array<[string, string]> }>('fs.scan')
    const texts = new Map(r.texts)
    return r.entries.map(([path, dir, size, mtime]) => {
      const b64 = texts.get(path)
      return { path, dir: !!dir, size, mtime, data: b64 != null ? b64decode(b64) : undefined }
    })
  }
  async write(p: string, data: Uint8Array | Blob) {
    if (data instanceof Blob && data.size <= PART) data = new Uint8Array(await data.arrayBuffer())
    if (data instanceof Uint8Array && data.byteLength <= PART) { await nativeCall('fs.write', { path: p, data: b64encode(data) }); return }
    // Grande: por partes.
    const blob = data instanceof Blob ? data : new Blob([data as BlobPart])
    for (let pos = 0; pos < blob.size || pos === 0; pos += PART) {
      const part = new Uint8Array(await blob.slice(pos, pos + PART).arrayBuffer())
      await nativeCall('fs.writeAt', { path: p, pos, data: b64encode(part), truncate: pos === 0 })
      if (!blob.size) break
    }
  }
  async remove(p: string) { await nativeCall('fs.delete', { path: p }) }
  async mkdir(p: string) { await nativeCall('fs.mkdir', { path: p }) }
  async copy(from: string, to: string) { await nativeCall('fs.copy', { from, to }) }
  async move(from: string, to: string) { await nativeCall('fs.rename', { from, to }) }
  async file(p: string) {
    const r = await fetch(this.url(p), { cache: 'no-store' })
    if (!r.ok) throw new Error(`No se pudo leer ${p} (${r.status})`)
    return r.blob()
  }
  async stream(p: string) {
    const r = await fetch(this.url(p), { cache: 'no-store' })
    if (!r.ok || !r.body) throw new Error(`No se pudo leer ${p} (${r.status})`)
    return r.body
  }
  async writable(p: string): Promise<Writable> {
    let pos = 0, first = true
    const put = async (data: Uint8Array, at: number) => {
      for (let off = 0; off < data.byteLength || (off === 0 && first); off += PART) {
        const part = data.subarray(off, off + PART)
        await nativeCall('fs.writeAt', { path: p, pos: at + off, data: b64encode(part), truncate: first })
        first = false
        if (!data.byteLength) break
      }
      pos = Math.max(pos, at + data.byteLength)
    }
    return {
      write: (c) => (c instanceof Uint8Array ? put(c, pos) : put(c.data, c.position ?? pos)),
      close: async () => { if (first) await put(new Uint8Array(0), 0) },
      abort: async () => { await nativeCall('fs.delete', { path: p }).catch(() => {}) },
    }
  }
}

export class WebFS {
  private nodes = new Map<string, FNode>([['', { dir: true, mtime: 0 }]])
  private kids = new Map<string, Set<string>>([['', new Set()]])
  private store!: Store
  /** Trabajo pendiente en el almacenamiento (en orden): escribir, borrar, copiar. */
  private chain: Promise<unknown> = Promise.resolve()
  private pendingWrites = new Map<string, Uint8Array>()
  private writeScheduled = false
  onError: (e: unknown) => void = (e) => console.error('[WebFS]', e)

  /** Abre la carpeta y arma el índice: en la app nativa, el disco del iPhone (origin: oa://localhost); si no, OPFS. */
  async open(o: { native?: string; folder?: string } = {}) {
    if (o.native) this.store = new NativeStore(o.native)
    else {
      const top = await navigator.storage.getDirectory()
      this.store = new OpfsStore(await top.getDirectoryHandle(o.folder || 'oa-data', { create: true }))
    }
    for (const s of await this.store.scan()) this.addNode(s.path, s.dir ? { dir: true, mtime: s.mtime } : { dir: false, size: s.size, mtime: s.mtime, data: s.data })
  }

  private addNode(p: string, n: FNode) {
    const parent = parentOf(p)
    if (!this.nodes.has(parent)) this.addNode(parent, { dir: true, mtime: Date.now() })
    this.nodes.set(p, n)
    if (!this.kids.has(parent)) this.kids.set(parent, new Set())
    this.kids.get(parent)!.add(nameOf(p))
    if (n.dir && !this.kids.has(p)) this.kids.set(p, new Set())
  }
  private removeNode(p: string) {
    const n = this.nodes.get(p)
    if (!n) return
    if (n.dir) for (const k of [...(this.kids.get(p) || [])]) this.removeNode(p ? `${p}/${k}` : k)
    this.nodes.delete(p)
    this.kids.delete(p)
    this.kids.get(parentOf(p))?.delete(nameOf(p))
  }
  /** Un archivo que apareció en el disco por fuera (lo eligió el usuario, lo bajó la app): al índice. */
  noteFile(p: string, size: number) { this.addNode(norm(p), { dir: false, size, mtime: Date.now() }) }

  // ── el almacenamiento (por detrás, en orden) ─────────────────────────────────
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const r = this.chain.then(work)
    this.chain = r.catch((e) => this.onError(e))
    return r
  }
  /** Las escrituras chicas se juntan: si un archivo cambia varias veces seguidas, se guarda la última versión. */
  private persist(p: string, data: Uint8Array) {
    this.pendingWrites.set(p, data)
    if (this.writeScheduled) return
    this.writeScheduled = true
    this.queue(async () => {
      this.writeScheduled = false
      const batch = [...this.pendingWrites]
      this.pendingWrites.clear()
      for (const [path, d] of batch) await this.store.write(path, d)
    })
  }
  private removeStored(p: string) {
    this.pendingWrites.forEach((_, k) => { if (k === p || k.startsWith(p + '/')) this.pendingWrites.delete(k) })
    return this.queue(() => this.store.remove(p))
  }
  /** Espera a que todo lo pendiente quede guardado. */
  flush() { return this.queue(async () => {}) }

  // ── API sincrónica (la del puente de Java) ───────────────────────────────────
  exists(p: string) { return this.nodes.has(norm(p)) }
  stat(p: string): Entry | null {
    const k = norm(p), n = this.nodes.get(k)
    if (!n) return null
    return { name: nameOf(k), dir: n.dir, size: n.dir ? 0 : n.size, mtime: n.mtime }
  }
  list(p: string): Entry[] {
    const k = norm(p)
    const set = this.kids.get(k)
    if (!set) return []
    return [...set].map((name) => this.stat(k ? `${k}/${name}` : name)!).filter(Boolean)
  }
  walk(p: string, o: { depth?: number; max?: number; skipHidden?: boolean; skipDirs?: string[] } = {}): Entry[] {
    const base = norm(p), out: Entry[] = []
    const depth = o.depth ?? 8, max = o.max ?? 10000, skip = new Set(o.skipDirs || [])
    const go = (dir: string, rel: string, d: number) => {
      if (d > depth) return
      for (const name of this.kids.get(dir) || []) {
        if (out.length >= max) return
        if (o.skipHidden !== false && name.startsWith('.')) continue
        const full = dir ? `${dir}/${name}` : name, r = rel ? `${rel}/${name}` : name
        const n = this.nodes.get(full)!
        out.push({ name, dir: n.dir, size: n.dir ? 0 : n.size, mtime: n.mtime, path: r })
        if (n.dir && !skip.has(name)) go(full, r, d + 1)
      }
    }
    go(base, '', 0)
    return out
  }
  private file(p: string) {
    const n = this.nodes.get(norm(p))
    if (!n) throw enoent(p)
    if (n.dir) throw Object.assign(new Error(`Es una carpeta: ${p}`), { code: 'EISDIR' })
    return n
  }
  readBytesSync(p: string): Uint8Array {
    const n = this.file(p)
    if (!n.data) throw new Error(`«${p}» es un archivo grande: se lee por partes (no de una vez)`)
    return n.data
  }
  readText(p: string) { return new TextDecoder().decode(this.readBytesSync(p)) }
  readTextLimited(p: string, max = 200000) {
    const n = this.file(p)
    if (!n.data) return { text: '', size: n.size, truncated: true }
    return { text: new TextDecoder().decode(n.data.subarray(0, max)), size: n.size, truncated: n.size > max }
  }
  writeBytes(p: string, data: Uint8Array) {
    const k = norm(p)
    if (this.nodes.get(k)?.dir) throw Object.assign(new Error(`Es una carpeta: ${p}`), { code: 'EISDIR' })
    this.addNode(k, { dir: false, size: data.byteLength, mtime: Date.now(), data: keepInMemory(k, data.byteLength) ? data : undefined })
    this.persist(k, data)
  }
  writeText(p: string, text: string) { this.writeBytes(p, new TextEncoder().encode(text)) }
  /** Escritura por partes (base64), como Fs.writeBase64 en Java. */
  writeBase64(p: string, b64: string, append: boolean) {
    const chunk = b64decode(b64)
    const k = norm(p)
    const prev = append ? this.nodes.get(k) : undefined
    if (prev && !prev.dir && !prev.data) throw new Error(`No se puede agregar a «${p}» por partes`)
    const old = prev && !prev.dir ? prev.data! : new Uint8Array(0)
    const all = new Uint8Array(old.length + chunk.length)
    all.set(old); all.set(chunk, old.length)
    this.writeBytes(k, all)
  }
  mkdir(p: string) {
    const k = norm(p)
    if (this.nodes.get(k)?.dir) return
    if (this.nodes.has(k)) throw Object.assign(new Error(`Ya existe un archivo: ${p}`), { code: 'EEXIST' })
    this.addNode(k, { dir: true, mtime: Date.now() })
    void this.queue(() => this.store.mkdir(k))
  }
  delete(p: string) {
    const k = norm(p)
    if (!this.nodes.has(k) || !k) return false
    this.removeNode(k)
    void this.removeStored(k)
    return true
  }
  du(p: string) {
    const k = norm(p), n = this.nodes.get(k)
    if (!n) return 0
    if (!n.dir) return n.size
    let total = 0
    for (const name of this.kids.get(k) || []) total += this.du(k ? `${k}/${name}` : name)
    return total
  }
  /** Copia (los archivos grandes se copian por detrás; mientras tanto se leen del original). */
  copy(from: string, to: string) {
    const a = norm(from), b = norm(to), n = this.nodes.get(a)
    if (!n) throw enoent(from)
    if (n.dir) {
      this.mkdir(b)
      for (const name of [...(this.kids.get(a) || [])]) this.copy(`${a}/${name}`, `${b}/${name}`)
      return
    }
    if (n.data) { this.writeBytes(b, n.data.slice()); return }
    this.addNode(b, { dir: false, size: n.size, mtime: Date.now() })
    void this.queue(() => this.store.copy(a, b))
  }
  rename(from: string, to: string) {
    const a = norm(from), b = norm(to)
    if (!this.nodes.has(a)) throw enoent(from)
    if (a === b) return
    const moved: Array<[string, FNode]> = []
    for (const [k, n] of this.nodes) if (k === a || k.startsWith(a + '/')) moved.push([b + k.slice(a.length), n])
    this.removeNode(a)
    for (const [k, n] of moved.sort((x, y) => x[0].length - y[0].length)) this.addNode(k, n)
    // Lo pendiente de escribir se escribe con el nombre nuevo.
    for (const [k, d] of [...this.pendingWrites]) if (k === a || k.startsWith(a + '/')) { this.pendingWrites.delete(k); this.pendingWrites.set(b + k.slice(a.length), d) }
    const store = this.store
    if (store.move) { void this.queue(() => store.move!(a, b)); return }
    // OPFS: copiar y borrar (mover carpetas no está en todos los navegadores).
    void this.queue(async () => {
      for (const [k, n] of moved) {
        if (n.dir) await store.mkdir(k)
        else if (n.data) await store.write(k, n.data)
        else await store.copy(a + k.slice(b.length), k)
      }
      await store.remove(a)
    })
  }

  // ── asincrónico ───────────────────────────────────────────────────────────────
  /** El contenido como Blob (de memoria o del almacenamiento), después de que se guardó lo pendiente. */
  async fileBlob(p: string): Promise<Blob> {
    const n = this.file(p)
    if (n.data) return new Blob([n.data as BlobPart])
    await this.flush()
    return this.store.file(norm(p))
  }
  /** El contenido por partes (para no cargar un video entero). */
  async fileStream(p: string): Promise<ReadableStream<Uint8Array>> {
    const n = this.file(p)
    if (n.data) return new Blob([n.data as BlobPart]).stream() as ReadableStream<Uint8Array>
    await this.flush()
    return this.store.stream(norm(p))
  }
  /** URL para leerlo por partes (Range): sólo en la app nativa. */
  urlOf(p: string): string | null { return this.store.url ? this.store.url(norm(p)) : null }
  /** Escribe un archivo grande (importar un video, exportar) sin pasarlo por memoria. */
  async writeBlob(p: string, data: Blob) {
    const k = norm(p)
    this.addNode(k, { dir: false, size: data.size, mtime: Date.now(), data: keepInMemory(k, data.size) ? new Uint8Array(await data.arrayBuffer()) : undefined })
    await this.queue(() => this.store.write(k, data))
  }
  /** Para el codificador y el .zip: un archivo que se escribe por partes. */
  async openWritable(p: string) {
    const k = norm(p)
    await this.flush()
    const writable = await this.store.writable(k)
    return { writable, done: (size: number) => this.addNode(k, { dir: false, size, mtime: Date.now() }) }
  }
}
