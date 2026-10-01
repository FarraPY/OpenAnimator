/**
 * Carpeta de datos de OpenAnimator en el iPhone, sobre OPFS (el almacenamiento privado de archivos de Safari).
 *
 * El backend (el mismo de Android) usa el disco de forma sincrónica (en la tablet lo hace Java). Acá hay un índice en
 * memoria de toda la carpeta (rutas, tamaños, fechas) y el contenido de los archivos chicos de texto (proyectos,
 * timelines, escenas, ajustes): eso se lee y escribe al instante y se guarda en OPFS por detrás, en orden. Los medios
 * grandes (videos, audio, exportaciones) nunca se cargan enteros: quedan en OPFS y se leen por partes (fileBlob) —
 * el visor los pide por tramos al Service Worker, que a su vez se los pide a esta página.
 */
export type Entry = { name: string; dir: boolean; size: number; mtime: number; path?: string }
type FNode = { dir: true; mtime: number } | { dir: false; size: number; mtime: number; data?: Uint8Array }

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

export class WebFS {
  private nodes = new Map<string, FNode>([['', { dir: true, mtime: 0 }]])
  private kids = new Map<string, Set<string>>([['', new Set()]])
  private root!: FileSystemDirectoryHandle
  private dirs = new Map<string, Promise<FileSystemDirectoryHandle>>()
  /** Trabajo pendiente en OPFS (en orden): escribir, borrar, copiar. */
  private chain: Promise<unknown> = Promise.resolve()
  private pendingWrites = new Map<string, Uint8Array>()
  private writeScheduled = false
  onError: (e: unknown) => void = (e) => console.error('[WebFS]', e)

  /** Abre (o crea) la carpeta y arma el índice. */
  async open(folder = 'oa-data') {
    const top = await navigator.storage.getDirectory()
    this.root = await top.getDirectoryHandle(folder, { create: true })
    this.dirs.set('', Promise.resolve(this.root))
    await this.scan(this.root, '')
  }

  private async scan(dir: FileSystemDirectoryHandle, path: string) {
    const loads: Promise<void>[] = []
    for await (const [name, h] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
      const p = path ? `${path}/${name}` : name
      if (h.kind === 'directory') { this.addNode(p, { dir: true, mtime: 0 }); this.dirs.set(p, Promise.resolve(h as FileSystemDirectoryHandle)); await this.scan(h as FileSystemDirectoryHandle, p) }
      else loads.push((async () => {
        const f = await (h as FileSystemFileHandle).getFile()
        const n: FNode = { dir: false, size: f.size, mtime: f.lastModified }
        if (keepInMemory(p, f.size)) n.data = new Uint8Array(await f.arrayBuffer())
        this.addNode(p, n)
      })())
    }
    await Promise.all(loads)
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

  // ── OPFS (por detrás, en orden) ───────────────────────────────────────────────
  private dirHandle(p: string): Promise<FileSystemDirectoryHandle> {
    let d = this.dirs.get(p)
    if (!d) {
      d = this.dirHandle(parentOf(p)).then((parent) => parent.getDirectoryHandle(nameOf(p), { create: true }))
      this.dirs.set(p, d)
      d.catch(() => this.dirs.delete(p))
    }
    return d
  }
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const r = this.chain.then(work)
    this.chain = r.catch((e) => this.onError(e))
    return r
  }
  private async writeOpfs(p: string, data: Uint8Array | Blob) {
    const dir = await this.dirHandle(parentOf(p))
    const fh = await dir.getFileHandle(nameOf(p), { create: true })
    const w = await (fh as any).createWritable()
    await w.write(data)
    await w.close()
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
      for (const [path, d] of batch) await this.writeOpfs(path, d)
    })
  }
  private removeOpfs(p: string) {
    const parent = parentOf(p), name = nameOf(p)
    for (const k of [...this.dirs.keys()]) if (k === p || k.startsWith(p + '/')) this.dirs.delete(k)
    this.pendingWrites.forEach((_, k) => { if (k === p || k.startsWith(p + '/')) this.pendingWrites.delete(k) })
    return this.queue(async () => { try { await (await this.dirHandle(parent)).removeEntry(name, { recursive: true }) } catch (e: any) { if (e?.name !== 'NotFoundError') throw e } })
  }
  /** Espera a que todo lo pendiente quede guardado en OPFS. */
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
    const bin = atob(b64), chunk = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) chunk[i] = bin.charCodeAt(i)
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
    void this.queue(() => this.dirHandle(k))
  }
  delete(p: string) {
    const k = norm(p)
    if (!this.nodes.has(k) || !k) return false
    this.removeNode(k)
    void this.removeOpfs(k)
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
  /** Copia (los archivos grandes se copian en OPFS por detrás; mientras tanto se leen del original). */
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
    void this.queue(async () => this.writeOpfs(b, await this.opfsFile(a)))
  }
  rename(from: string, to: string) {
    const a = norm(from), b = norm(to)
    if (!this.nodes.has(a)) throw enoent(from)
    if (a === b) return
    // Índice: al instante. OPFS: copiar y borrar (mover carpetas no está en todos los navegadores).
    const moved: Array<[string, FNode]> = []
    for (const [k, n] of this.nodes) if (k === a || k.startsWith(a + '/')) moved.push([b + k.slice(a.length), n])
    this.removeNode(a)
    for (const [k, n] of moved.sort((x, y) => x[0].length - y[0].length)) this.addNode(k, n)
    void this.queue(async () => {
      for (const [k, n] of moved) {
        if (n.dir) await this.dirHandle(k)
        else if (n.data) await this.writeOpfs(k, n.data)
        else await this.writeOpfs(k, await this.opfsFile(a + k.slice(b.length)))
      }
    })
    void this.removeOpfs(a)
  }

  // ── asincrónico ───────────────────────────────────────────────────────────────
  private async opfsFile(p: string): Promise<File> {
    const k = norm(p)
    const dir = await this.dirHandle(parentOf(k))
    return (await dir.getFileHandle(nameOf(k))).getFile()
  }
  /** El contenido como Blob (de memoria o de OPFS), después de que se guardó lo pendiente de ese archivo. */
  async fileBlob(p: string): Promise<Blob> {
    const n = this.file(p)
    if (n.data) return new Blob([n.data as BlobPart])
    await this.flush()
    return this.opfsFile(p)
  }
  /** Escribe un archivo grande (importar un video, exportar) sin pasarlo por memoria. */
  async writeBlob(p: string, data: Blob) {
    const k = norm(p)
    this.addNode(k, { dir: false, size: data.size, mtime: Date.now(), data: keepInMemory(k, data.size) ? new Uint8Array(await data.arrayBuffer()) : undefined })
    await this.queue(() => this.writeOpfs(k, data))
  }
  /** Para el codificador: un archivo de OPFS que se escribe por partes (FileSystemWritableFileStream). */
  async openWritable(p: string) {
    const k = norm(p)
    await this.flush()
    const dir = await this.dirHandle(parentOf(k))
    const fh = await dir.getFileHandle(nameOf(k), { create: true })
    return { writable: await (fh as any).createWritable(), done: (size: number) => this.addNode(k, { dir: false, size, mtime: Date.now() }) }
  }
}
