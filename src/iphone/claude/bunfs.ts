/**
 * Lee la tabla de módulos que `bun build --compile` mete al final del ejecutable de Claude Code (StandaloneModuleGraph):
 *   … [payload] [Offsets: byte_count u64, modules {u32 off, u32 len}, entry u32, argv {u32,u32}, flags u32] "\n---- Bun! ----\n"
 * Cada módulo: name, contents, sourcemap, bytecode… (StringPointer {u32 off, u32 len}) y al final 4 bytes:
 * encoding, loader, format, side. `read(off, len)` devuelve bytes del archivo (en el teléfono, de un Blob).
 */
export type BunModule = { name: string; off: number; len: number; loader: string }

const TRAILER = '\n---- Bun! ----\n'
/** Loader de Bun (enum Loader): js, text (require devuelve el texto), file (la ruta), napi (complemento nativo)… */
const LOADERS: Record<number, string> = { 0: 'jsx', 1: 'js', 2: 'ts', 3: 'tsx', 4: 'css', 5: 'file', 6: 'json', 7: 'jsonc', 8: 'toml', 9: 'wasm', 10: 'napi', 11: 'base64', 12: 'dataurl', 13: 'text', 14: 'bunsh', 15: 'sqlite', 16: 'sqlite_embedded', 17: 'html', 18: 'yaml' }
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 2 ** 24
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 2 ** 32

function lastIndexOf(hay: Uint8Array, needle: string) {
  outer: for (let i = hay.length - needle.length; i >= 0; i--) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle.charCodeAt(j)) continue outer
    return i
  }
  return -1
}

export async function readBunGraph(read: (off: number, len: number) => Promise<Uint8Array>, size: number) {
  const WIN = 4 * 1024 * 1024
  let tpos = -1
  for (let end = size; end > 0 && tpos < 0; end -= WIN - TRAILER.length) {
    const start = Math.max(0, end - WIN)
    const i = lastIndexOf(await read(start, end - start), TRAILER)
    if (i >= 0) tpos = start + i
  }
  if (tpos < 0) throw new Error('El archivo no es un ejecutable de Bun (no tiene la tabla de módulos)')
  const tail = await read(tpos - 64, 64)
  const dec = new TextDecoder()
  for (const osz of [32, 36, 40, 28]) {
    const o = tail.subarray(64 - osz)
    const byteCount = u64(o, 0), modOff = u32(o, 8), modLen = u32(o, 12), entry = u32(o, 16)
    const start = tpos - osz - byteCount
    if (start < 0 || !modLen || modOff + modLen > byteCount) continue
    const table = await read(start + modOff, modLen)
    for (const rec of [52, 56, 48, 64, 44, 40, 36]) {
      if (modLen % rec) continue
      const raw: Array<{ nameOff: number; nameLen: number; off: number; len: number; loader: number }> = []
      let ok = true
      for (let i = 0; i < modLen / rec && ok; i++) {
        const b = i * rec
        const nameOff = u32(table, b), nameLen = u32(table, b + 4), cOff = u32(table, b + 8), cLen = u32(table, b + 12)
        if (nameOff + nameLen > byteCount || cOff + cLen > byteCount || nameLen > 4096) { ok = false; break }
        raw.push({ nameOff, nameLen, off: start + cOff, len: cLen, loader: table[b + rec - 3] })
      }
      if (!ok || !raw.length) continue
      const lo = Math.min(...raw.map((m) => m.nameOff)), hi = Math.max(...raw.map((m) => m.nameOff + m.nameLen))
      const names = await read(start + lo, hi - lo)
      const mods: BunModule[] = raw.map((m) => ({ name: dec.decode(names.subarray(m.nameOff - lo, m.nameOff - lo + m.nameLen)), off: m.off, len: m.len, loader: LOADERS[m.loader] || String(m.loader) }))
      if (!mods.every((m) => /^(\/\$bunfs\/|B:[\\/]~BUN|compiled:\/\/)/.test(m.name))) continue
      for (const m of mods) m.name = m.name.replace(/^\/\$bunfs\/root\/|^B:[\\/]~BUN[\\/]root[\\/]|^compiled:\/\//, '')
      return { modules: mods, entry: mods[entry]?.name || 'cli' }
    }
  }
  throw new Error('No se pudo leer la tabla de módulos del ejecutable de Claude Code')
}
