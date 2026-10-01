/**
 * `Bun` mínimo: Claude Code usa sin preguntar algunas utilidades de Bun (hash, ancho de texto, semver, YAML…).
 * Sólo las puras, hechas en JavaScript. No define Bun.version (así las librerías siguen viendo "Node") ni nada que
 * abra procesos o servidores: esas ramas fallan como si el programa no estuviera.
 */
import semver from 'semver'
import YAML from 'yaml'
import * as TOML from 'smol-toml'
import { decompress as zstd } from 'fzstd'
import { Buffer } from 'buffer'

const ANSI = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g
const stripANSI = (s) => String(s).replace(ANSI, '')

const ZERO = [[0x300, 0x36f], [0x483, 0x489], [0x591, 0x5bd], [0x610, 0x61a], [0x64b, 0x65f], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xfeff, 0xfeff], [0xe0100, 0xe01ef]]
const WIDE = [[0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f5], [0x26fa, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f251], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd]]
const inRanges = (c, r) => { let lo = 0, hi = r.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (c < r[m][0]) hi = m - 1; else if (c > r[m][1]) lo = m + 1; else return true } return false }
const charWidth = (c) => (c < 32 || (c >= 0x7f && c < 0xa0) || inRanges(c, ZERO) ? 0 : inRanges(c, WIDE) ? 2 : 1)
const stringWidth = (s) => { let w = 0; for (const ch of stripANSI(s)) w += charWidth(ch.codePointAt(0)); return w }

/** Corta por columnas visibles conservando los códigos ANSI. */
function sliceAnsi(s, start = 0, end = Infinity) {
  let out = '', col = 0
  const re = new RegExp(ANSI.source, 'y')
  for (let i = 0; i < s.length;) {
    re.lastIndex = i
    const m = re.exec(s)
    if (m) { out += m[0]; i += m[0].length; continue }
    const ch = String.fromCodePoint(s.codePointAt(i))
    const w = charWidth(ch.codePointAt(0))
    if (col >= start && col + w <= end) out += ch
    col += w
    i += ch.length
  }
  return out
}
/** Ajuste de líneas por palabras al ancho `cols` (las palabras más largas se cortan con hard). */
function wrapAnsi(s, cols, o = {}) {
  return String(s).split('\n').map((line) => {
    const words = line.split(' ')
    const lines = []
    let cur = '', w = 0
    for (const word of words) {
      const ww = stringWidth(word)
      if (w && w + 1 + ww > cols) { lines.push(cur); cur = ''; w = 0 }
      if (o.hard && ww > cols) { let rest = word; while (stringWidth(rest) > cols) { lines.push((cur ? cur + ' ' : '') + sliceAnsi(rest, 0, cols)); cur = ''; w = 0; rest = sliceAnsi(rest, cols) } cur = rest; w = stringWidth(rest); continue }
      cur = w ? cur + ' ' + word : word
      w = w ? w + 1 + ww : ww
    }
    lines.push(cur)
    return (o.trim === false ? lines : lines.map((l) => l.replace(/\s+$/, ''))).join('\n')
  }).join('\n')
}
/** Hash de 64 bits (FNV-1a) como BigInt, como Bun.hash. */
function hash(data, seed = 0n) {
  const b = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength ?? data.length)
  let h = 0xcbf29ce484222325n ^ BigInt.asUintN(64, BigInt(seed))
  for (const x of b) h = BigInt.asUintN(64, (h ^ BigInt(x)) * 0x100000001b3n)
  return h
}
const u8 = (d) => (typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(d.buffer || d, d.byteOffset || 0, d.byteLength ?? d.length))
const enoent = (cmd) => Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT', errno: -2, syscall: 'spawn ' + cmd, path: cmd })

export function createBun({ fs, proc, deepEqual, toWeb }) {
  const file = (p) => {
    const path = String(p?.pathname ?? p)
    const read = () => fs.readFileSync(path)
    return {
      name: path, type: 'application/octet-stream',
      get size() { try { return fs.statSync(path).size } catch { return 0 } },
      exists: async () => fs.existsSync(path), text: async () => read().toString('utf8'), json: async () => JSON.parse(read().toString('utf8')),
      arrayBuffer: async () => { const b = read(); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }, bytes: async () => new Uint8Array(read()),
      stream: () => new Blob([read()]).stream(), write: async (d) => { fs.writeFileSync(path, typeof d === 'string' ? d : Buffer.from(u8(d))); return d.length ?? 0 }, delete: async () => fs.rmSync(path, { force: true }),
    }
  }
  return {
    env: proc.env, argv: proc.argv, main: '/$bunfs/root/cli', revision: '', enableANSIColors: false,
    hash, stringWidth, stripANSI, sliceAnsi, wrapAnsi,
    semver: { order: (a, b) => semver.compare(String(a), String(b)), satisfies: (v, r) => semver.satisfies(String(v), String(r)) },
    deepEquals: (a, b) => deepEqual(a, b), deepMatch: (a, b) => deepEqual(a, b),
    YAML: { parse: (s) => YAML.parse(String(s)), stringify: (v, r, space) => YAML.stringify(v, typeof r === 'function' ? r : null, { indent: typeof space === 'number' ? space : 2 }) },
    TOML: { parse: (s) => TOML.parse(String(s)) },
    zstdDecompressSync: (d) => Buffer.from(zstd(u8(d))), zstdDecompress: async (d) => Buffer.from(zstd(u8(d))),
    sleepSync: (ms) => { const end = performance.now() + Math.min(ms, 5000); while (performance.now() < end) { /* espera */ } }, sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    nanoseconds: () => Math.floor(performance.now() * 1e6), which: () => null,
    stdin: { stream: () => toWeb(proc.stdin), text: async () => new Response(toWeb(proc.stdin)).text() },
    spawn: (cmd) => { throw enoent(Array.isArray(cmd) ? cmd[0] : cmd?.cmd?.[0] || String(cmd)) }, spawnSync: (cmd) => { throw enoent(Array.isArray(cmd) ? cmd[0] : String(cmd)) },
    file, write: async (dest, data) => file(dest).write(typeof data === 'string' ? data : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data),
    gc: () => {}, generateHeapSnapshot: () => { throw new Error('Bun.generateHeapSnapshot no está disponible') }, unsafe: {},
    escapeHTML: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    randomUUIDv7: () => crypto.randomUUID(), peek: (p) => p,
  }
}
