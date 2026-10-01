/** Proyectos como .zip (zip.import / zip.export del puente) con fflate, por partes: sin cargar el zip entero en memoria. */
import { Unzip, UnzipInflate, Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import type { WebFS } from './webfs'

const STORED = /\.(mp4|mov|m4v|webm|mkv|mp3|m4a|aac|ogg|opus|flac|jpg|jpeg|png|webp|gif|avif|zip|woff2?)$/i

export async function unzipTo(fs: WebFS, zipPath: string, dest: string, ev: (e: any) => void) {
  const total = fs.stat(zipPath)?.size || 0
  const writes: Promise<void>[] = []
  let files = 0
  const unzip = new Unzip((file) => {
    const name = file.name.replace(/\\/g, '/')
    if (name.endsWith('/') || name.split('/').includes('..') || name.startsWith('/')) { file.ondata = () => {}; file.start(); return }
    const parts: Uint8Array[] = []
    file.ondata = (err, chunk, final) => {
      if (err) throw err
      parts.push(chunk)
      if (final) { files++; writes.push(fs.writeBlob(`${dest}/${name}`, new Blob(parts as BlobPart[]))) }
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  const reader = (await fs.fileStream(zipPath)).getReader()
  let done = 0
  for (;;) {
    const { done: end, value } = await reader.read()
    if (end) { unzip.push(new Uint8Array(0), true); break }
    unzip.push(value)
    done += value.byteLength
    ev({ event: 'progress', done, total })
  }
  await Promise.all(writes)
  return { files }
}

export async function zipDir(fs: WebFS, dir: string, out: string, prefix: string, skip: string, ev: (e: any) => void) {
  const rx = skip ? new RegExp(skip) : null
  const list = fs.walk(dir, { depth: 64, max: 100000, skipHidden: false }).filter((e) => !e.dir && !(rx && rx.test(e.path!)))
  const total = list.reduce((n, e) => n + e.size, 0)
  const { writable, done } = await fs.openWritable(out)
  let size = 0, err: unknown = null
  let pending: Promise<void> = Promise.resolve()
  const zip = new Zip((e, chunk) => {
    if (e) { err = e; return }
    size += chunk.byteLength
    pending = pending.then(() => writable.write(chunk))
  })
  let sent = 0
  for (const e of list) {
    const name = (prefix ? `${prefix}/` : '') + e.path
    const entry = STORED.test(e.path!) ? new ZipPassThrough(name) : new ZipDeflate(name, { level: 6 })
    zip.add(entry)
    const reader = (await fs.fileStream(`${dir}/${e.path}`)).getReader()
    for (;;) {
      const { done: end, value } = await reader.read()
      if (end) { entry.push(new Uint8Array(0), true); break }
      entry.push(value)
      sent += value.byteLength
      ev({ event: 'progress', done: sent, total })
      await pending // que la escritura no quede atrás (memoria acotada)
    }
  }
  zip.end()
  await pending
  if (err) throw err
  await writable.close()
  done(size)
  return { path: out, size }
}
