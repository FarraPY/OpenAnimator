// Módulos de Node hechos con librerías del navegador: events, buffer, stream, util, url, zlib, readline y los chicos.
import * as eventsMod from 'events'
import * as bufferMod from 'buffer'
import * as rs from 'readable-stream'
import utilPkg from 'util'
import * as sdMod from 'string_decoder'
import assertPkg from 'assert'
import * as fflate from 'fflate'
import { decompress as zstdDecompress } from 'fzstd'
import { posix as path } from './path.js'
import { promises as timerPromises } from './timers.js'

// ── events ──────────────────────────────────────────────────────────────────
const EE = eventsMod.EventEmitter || eventsMod.default
if (!EE.setMaxListeners) EE.setMaxListeners = () => {}
if (!EE.getEventListeners) EE.getEventListeners = (t, n) => (t.listeners ? t.listeners(n) : [])
if (!EE.getMaxListeners) EE.getMaxListeners = (t) => (t.getMaxListeners ? t.getMaxListeners() : 10)
if (!EE.addAbortListener) EE.addAbortListener = (sig, fn) => { sig.addEventListener('abort', fn, { once: true }); return { [Symbol.dispose]() { sig.removeEventListener('abort', fn) } } }
if (!EE.errorMonitor) EE.errorMonitor = Symbol('events.errorMonitor')
if (!EE.captureRejectionSymbol) EE.captureRejectionSymbol = Symbol.for('nodejs.rejection')
if (!EE.on) EE.on = async function* on(em, name, o = {}) {
  const q = [], waiting = []
  const push = (...a) => { const w = waiting.shift(); if (w) w({ value: a, done: false }); else q.push(a) }
  em.on(name, push)
  try { for (;;) { if (q.length) yield q.shift(); else yield await new Promise((r) => waiting.push((x) => r(x.value))) ; if (o.signal?.aborted) return } } finally { em.off(name, push) }
}
EE.EventEmitter = EE
EE.default = EE
export const events = EE

// ── buffer ──────────────────────────────────────────────────────────────────
export const buffer = {
  ...bufferMod, Buffer: bufferMod.Buffer, Blob: globalThis.Blob, File: globalThis.File, atob: globalThis.atob, btoa: globalThis.btoa,
  constants: { MAX_LENGTH: bufferMod.kMaxLength, MAX_STRING_LENGTH: 2 ** 29 - 24 },
  isUtf8: (b) => { try { new TextDecoder('utf-8', { fatal: true }).decode(b); return true } catch { return false } },
  isAscii: (b) => { for (const x of new Uint8Array(b.buffer || b, b.byteOffset || 0, b.byteLength)) if (x > 127) return false; return true },
  transcode: () => { throw new Error('buffer.transcode no está disponible') }, resolveObjectURL: () => undefined,
}

// ── stream ──────────────────────────────────────────────────────────────────
const S = rs.default || rs
const fromWeb = (web, o) => S.Readable.from((async function* () { const r = web.getReader(); try { for (;;) { const { done, value } = await r.read(); if (done) return; yield value } } finally { r.releaseLock() } })(), o)
if (!S.Readable.fromWeb) S.Readable.fromWeb = fromWeb
if (!S.Readable.toWeb) S.Readable.toWeb = (r) => new ReadableStream({ start(c) { r.on('data', (d) => c.enqueue(typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(d))); r.on('end', () => c.close()); r.on('error', (e) => c.error(e)) }, cancel() { r.destroy() } })
if (!S.Writable.fromWeb) S.Writable.fromWeb = (ws) => { const w = ws.getWriter(); return new S.Writable({ write(c, e, cb) { w.write(c).then(() => cb(), cb) }, final(cb) { w.close().then(() => cb(), cb) } }) }
if (!S.Writable.toWeb) S.Writable.toWeb = (w) => new WritableStream({ write(c) { return new Promise((r) => (w.write(c) ? r() : w.once('drain', r))) }, close() { return new Promise((r) => w.end(r)) } })
const streamPromises = S.promises || { pipeline: (...a) => new Promise((res, rej) => S.pipeline(...a, (e) => (e ? rej(e) : res()))), finished: (s, o) => new Promise((res, rej) => S.finished(s, o || {}, (e) => (e ? rej(e) : res()))) }
if (!S.promises) Object.defineProperty(S, 'promises', { value: streamPromises, enumerable: true })
if (!S.getDefaultHighWaterMark) S.getDefaultHighWaterMark = (obj) => (obj ? 16 : 65536)
if (!S.setDefaultHighWaterMark) S.setDefaultHighWaterMark = () => {}
if (!S.isReadable) S.isReadable = (s) => !!s && s.readable !== false && !s.destroyed
if (!S.isErrored) S.isErrored = (s) => !!s?.errored
if (!S.isDisturbed) S.isDisturbed = (s) => !!s?._readableState?.dataEmitted
if (!S.Stream) Object.defineProperty(S, 'Stream', { value: S })
export const stream = S
export { streamPromises }
const collect = async (src) => { const chunks = []; for await (const c of src) chunks.push(typeof c === 'string' ? bufferMod.Buffer.from(c) : bufferMod.Buffer.from(c)); return bufferMod.Buffer.concat(chunks) }
export const streamConsumers = {
  buffer: collect, arrayBuffer: async (s) => { const b = await collect(s); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) },
  text: async (s) => (await collect(s)).toString('utf8'), json: async (s) => JSON.parse((await collect(s)).toString('utf8')), blob: async (s) => new Blob([await collect(s)]),
}
export const streamWeb = { ReadableStream, WritableStream, TransformStream, TextEncoderStream: globalThis.TextEncoderStream, TextDecoderStream: globalThis.TextDecoderStream, CompressionStream: globalThis.CompressionStream, DecompressionStream: globalThis.DecompressionStream, ByteLengthQueuingStrategy, CountQueuingStrategy, ReadableStreamDefaultReader, ReadableStreamBYOBReader: globalThis.ReadableStreamBYOBReader, WritableStreamDefaultWriter }

// ── util ────────────────────────────────────────────────────────────────────
const U = { ...utilPkg }
const tag = (v) => Object.prototype.toString.call(v)
export const types = {
  ...(utilPkg.types || {}),
  isPromise: (v) => v instanceof Promise || (!!v && typeof v.then === 'function' && typeof v.catch === 'function'),
  isRegExp: (v) => tag(v) === '[object RegExp]', isDate: (v) => tag(v) === '[object Date]', isMap: (v) => tag(v) === '[object Map]', isSet: (v) => tag(v) === '[object Set]',
  isNativeError: (v) => v instanceof Error || tag(v) === '[object Error]', isAsyncFunction: (v) => tag(v) === '[object AsyncFunction]', isGeneratorFunction: (v) => /GeneratorFunction\]$/.test(tag(v)),
  isUint8Array: (v) => tag(v) === '[object Uint8Array]', isArrayBuffer: (v) => tag(v) === '[object ArrayBuffer]', isAnyArrayBuffer: (v) => /ArrayBuffer\]$/.test(tag(v)), isSharedArrayBuffer: (v) => tag(v) === '[object SharedArrayBuffer]',
  isTypedArray: (v) => ArrayBuffer.isView(v) && !(v instanceof DataView), isArrayBufferView: (v) => ArrayBuffer.isView(v), isDataView: (v) => v instanceof DataView, isProxy: () => false, isExternal: () => false,
  isBoxedPrimitive: (v) => v instanceof Number || v instanceof String || v instanceof Boolean, isWeakMap: (v) => v instanceof WeakMap, isWeakSet: (v) => v instanceof WeakSet, isKeyObject: () => false, isCryptoKey: (v) => tag(v) === '[object CryptoKey]',
  isModuleNamespaceObject: (v) => tag(v) === '[object Module]', isArgumentsObject: (v) => tag(v) === '[object Arguments]', isStringObject: (v) => v instanceof String, isNumberObject: (v) => v instanceof Number, isBooleanObject: (v) => v instanceof Boolean, isSymbolObject: () => false, isBigIntObject: () => false,
  isMapIterator: (v) => tag(v) === '[object Map Iterator]', isSetIterator: (v) => tag(v) === '[object Set Iterator]', isGeneratorObject: (v) => tag(v) === '[object Generator]',
  isFloat32Array: (v) => v instanceof Float32Array, isFloat64Array: (v) => v instanceof Float64Array, isInt8Array: (v) => v instanceof Int8Array, isInt16Array: (v) => v instanceof Int16Array, isInt32Array: (v) => v instanceof Int32Array,
  isUint8ClampedArray: (v) => v instanceof Uint8ClampedArray, isUint16Array: (v) => v instanceof Uint16Array, isUint32Array: (v) => v instanceof Uint32Array, isBigInt64Array: (v) => v instanceof BigInt64Array, isBigUint64Array: (v) => v instanceof BigUint64Array,
}
function deepEqual(a, b, seen = new Map()) {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
  if (seen.get(a) === b) return true
  seen.set(a, b)
  if (a instanceof Date) return a.getTime() === b.getTime()
  if (a instanceof RegExp) return String(a) === String(b)
  if (a instanceof Map || a instanceof Set) { if (a.size !== b.size) return false; for (const [k, v] of a.entries()) { if (!b.has(k) || (a instanceof Map && !deepEqual(v, b.get(k), seen))) return false } return true }
  if (ArrayBuffer.isView(a)) { if (a.byteLength !== b.byteLength) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true }
  const ka = Object.keys(a), kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k], seen))
}
const ANSI = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g
Object.assign(U, {
  types, isDeepStrictEqual: (a, b) => deepEqual(a, b), stripVTControlCharacters: (s) => String(s).replace(ANSI, ''), styleText: (f, t) => String(t), toUSVString: (s) => String(s).toWellFormed?.() ?? String(s),
  getSystemErrorName: (n) => `E${-n}`, getSystemErrorMap: () => new Map(), aborted: (signal) => new Promise((r) => (signal.aborted ? r() : signal.addEventListener('abort', () => r(), { once: true }))),
  TextEncoder, TextDecoder, MIMEType: class { constructor(s) { this.essence = String(s).split(';')[0].trim(); this.params = new Map() } toString() { return this.essence } }, MIMEParams: Map,
  parseEnv: (s) => Object.fromEntries(String(s).split('\n').map((l) => /^\s*([\w.-]+)\s*=\s*(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].replace(/^(['"])(.*)\1$/, '$2')])),
  parseArgs: () => { throw new Error('util.parseArgs no está disponible') }, transferableAbortSignal: (s) => s, transferableAbortController: () => new AbortController(),
  getCallSite: () => [], getCallSites: () => [], deprecate: (fn) => fn, debuglog: () => Object.assign(() => {}, { enabled: false }), debug: () => Object.assign(() => {}, { enabled: false }),
})
if (!U.inspect.custom) U.inspect.custom = Symbol.for('nodejs.util.inspect.custom')
if (!U.inspect.defaultOptions) U.inspect.defaultOptions = { depth: 2, colors: false, maxArrayLength: 100, maxStringLength: 10000, breakLength: 128, compact: 3, sorted: false }
U.promisify.custom = U.promisify.custom || Symbol.for('nodejs.util.promisify.custom')
export const util = U

// ── url ─────────────────────────────────────────────────────────────────────
const fileURLToPath = (u) => {
  const x = typeof u === 'string' ? new URL(u) : u
  if (x.protocol !== 'file:') throw Object.assign(new TypeError('The URL must be of scheme file'), { code: 'ERR_INVALID_URL_SCHEME' })
  return decodeURIComponent(x.pathname)
}
const pathToFileURL = (p) => { const u = new URL('file://'); u.pathname = path.resolve(p).split('/').map((s) => encodeURIComponent(s)).join('/'); return u }
function legacyParse(s, parseQuery) {
  let u
  try { u = new URL(s) } catch { try { u = new URL(s, 'relative:///'); return { protocol: null, slashes: null, auth: null, host: null, port: null, hostname: null, hash: u.hash || null, search: u.search || null, query: parseQuery ? Object.fromEntries(u.searchParams) : (u.search.slice(1) || null), pathname: u.pathname, path: u.pathname + u.search, href: s } } catch { return { href: s } } }
  return { protocol: u.protocol, slashes: true, auth: u.username ? `${u.username}${u.password ? ':' + u.password : ''}` : null, host: u.host, port: u.port || null, hostname: u.hostname, hash: u.hash || null, search: u.search || null, query: parseQuery ? Object.fromEntries(u.searchParams) : (u.search.slice(1) || null), pathname: u.pathname, path: u.pathname + u.search, href: u.href }
}
const legacyFormat = (o) => (typeof o === 'string' ? o : o instanceof URL ? o.href : `${o.protocol ? o.protocol + '//' : ''}${o.auth ? o.auth + '@' : ''}${o.host || (o.hostname || '') + (o.port ? ':' + o.port : '')}${o.pathname || ''}${o.search || (o.query && typeof o.query === 'object' ? '?' + new URLSearchParams(o.query) : '')}${o.hash || ''}`)
export const url = {
  URL, URLSearchParams, fileURLToPath, pathToFileURL, parse: legacyParse, format: legacyFormat, resolve: (from, to) => { const u = new URL(to, new URL(from, 'resolve://')); return u.protocol === 'resolve:' ? u.pathname + u.search + u.hash : u.href },
  domainToASCII: (d) => { try { return new URL('http://' + d).hostname } catch { return '' } }, domainToUnicode: (d) => d,
  urlToHttpOptions: (u) => ({ protocol: u.protocol, hostname: u.hostname, hash: u.hash, search: u.search, pathname: u.pathname, path: u.pathname + u.search, href: u.href, port: u.port ? +u.port : undefined }), Url: function Url() {},
}

// ── zlib (fflate; zstd con fzstd; sin brotli) ────────────────────────────────
const B = (u8) => bufferMod.Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)
const u8 = (d) => (typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(d.buffer || d, d.byteOffset || 0, d.byteLength ?? d.length))
const syncs = {
  gzipSync: (d, o) => B(fflate.gzipSync(u8(d), { level: o?.level ?? 6 })), gunzipSync: (d) => B(fflate.gunzipSync(u8(d))),
  deflateSync: (d, o) => B(fflate.zlibSync(u8(d), { level: o?.level ?? 6 })), inflateSync: (d) => B(fflate.unzlibSync(u8(d))),
  deflateRawSync: (d, o) => B(fflate.deflateSync(u8(d), { level: o?.level ?? 6 })), inflateRawSync: (d) => B(fflate.inflateSync(u8(d))),
  unzipSync: (d) => B(fflate.decompressSync(u8(d))), zstdDecompressSync: (d) => B(zstdDecompress(u8(d))),
  brotliCompressSync: () => { throw new Error('brotli no está disponible') }, brotliDecompressSync: () => { throw new Error('brotli no está disponible') }, zstdCompressSync: () => { throw new Error('zstd (comprimir) no está disponible') },
}
const asyncOf = (f) => (d, o, cb) => { if (typeof o === 'function') { cb = o; o = {} } queueMicrotask(() => { try { cb(null, f(d, o)) } catch (e) { cb(e) } }) }
const transformOf = (f) => () => { const chunks = []; return new S.Transform({ transform(c, e, cb) { chunks.push(bufferMod.Buffer.from(c)); cb() }, flush(cb) { try { this.push(f(bufferMod.Buffer.concat(chunks))); cb() } catch (e) { cb(e) } } }) }
export const zlib = {
  ...syncs, gzip: asyncOf(syncs.gzipSync), gunzip: asyncOf(syncs.gunzipSync), deflate: asyncOf(syncs.deflateSync), inflate: asyncOf(syncs.inflateSync), deflateRaw: asyncOf(syncs.deflateRawSync), inflateRaw: asyncOf(syncs.inflateRawSync), unzip: asyncOf(syncs.unzipSync), zstdDecompress: asyncOf(syncs.zstdDecompressSync),
  brotliCompress: asyncOf(syncs.brotliCompressSync), brotliDecompress: asyncOf(syncs.brotliDecompressSync),
  createGzip: transformOf(syncs.gzipSync), createGunzip: transformOf(syncs.gunzipSync), createDeflate: transformOf(syncs.deflateSync), createInflate: transformOf(syncs.inflateSync), createDeflateRaw: transformOf(syncs.deflateRawSync), createInflateRaw: transformOf(syncs.inflateRawSync), createUnzip: transformOf(syncs.unzipSync),
  createBrotliCompress: transformOf(syncs.brotliCompressSync), createBrotliDecompress: transformOf(syncs.brotliDecompressSync), createZstdDecompress: transformOf(syncs.zstdDecompressSync),
  constants: { Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_OK: 0, Z_STREAM_END: 1, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1, BROTLI_OPERATION_FLUSH: 1, BROTLI_PARAM_QUALITY: 1 },
  crc32: (d, v = 0) => { const c = new fflate.Zlib(); void c; let crc = ~v >>> 0; for (const x of u8(d)) { crc ^= x; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)) } return ~crc >>> 0 },
}

// ── readline: líneas de un stream (Claude Code lee así los mensajes stream-json) ─────────────
class Interface extends EE {
  constructor(o) {
    super()
    const input = o?.input || o
    this.input = input; this.output = o?.output; this.terminal = false; this.line = ''; this.closed = false
    let buf = ''
    const dec = new TextDecoder()
    this._onData = (d) => {
      buf += typeof d === 'string' ? d : dec.decode(d, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); this.emit('line', l) }
    }
    this._onEnd = () => { if (buf) { this.emit('line', buf); buf = '' } this.close() }
    input?.on?.('data', this._onData)
    input?.on?.('end', this._onEnd)
  }
  close() { if (this.closed) return; this.closed = true; this.input?.off?.('data', this._onData); this.input?.off?.('end', this._onEnd); this.emit('close') }
  pause() { this.input?.pause?.(); return this } resume() { this.input?.resume?.(); return this }
  setPrompt() {} prompt() {} write() {} getPrompt() { return '' } getCursorPos() { return { rows: 0, cols: 0 } }
  question(q, o, cb) { cb = typeof o === 'function' ? o : cb; this.once('line', (l) => cb?.(l)) }
  [Symbol.asyncIterator]() {
    const q = [], waiting = []
    let done = false
    this.on('line', (l) => { const w = waiting.shift(); if (w) w({ value: l, done: false }); else q.push(l) })
    this.on('close', () => { done = true; for (const w of waiting.splice(0)) w({ value: undefined, done: true }) })
    return { next: () => (q.length ? Promise.resolve({ value: q.shift(), done: false }) : done ? Promise.resolve({ value: undefined, done: true }) : new Promise((r) => waiting.push(r))), return: () => { this.close(); return Promise.resolve({ value: undefined, done: true }) }, [Symbol.asyncIterator]() { return this } }
  }
  [Symbol.dispose]() { this.close() }
}
const noopTrue = () => true
export const readline = { Interface, createInterface: (o, out) => new Interface(o?.input ? o : { input: o, output: out }), emitKeypressEvents: () => {}, clearLine: noopTrue, clearScreenDown: noopTrue, cursorTo: noopTrue, moveCursor: noopTrue, promises: {} }
readline.promises = { Interface, createInterface: readline.createInterface, Readline: class { clearLine() { return this } clearScreenDown() { return this } cursorTo() { return this } moveCursor() { return this } commit() { return Promise.resolve() } rollback() { return this } } }

// ── string_decoder, assert, querystring, timers/promises ─────────────────────
export const stringDecoder = { StringDecoder: sdMod.StringDecoder || sdMod.default?.StringDecoder }
export const assert = assertPkg
export const querystring = {
  parse: (s, sep = '&', eq = '=') => { const o = {}; for (const part of String(s || '').split(sep)) { if (!part) continue; const i = part.indexOf(eq); const k = decodeURIComponent((i < 0 ? part : part.slice(0, i)).replace(/\+/g, ' ')); const v = i < 0 ? '' : decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' ')); o[k] = k in o ? [].concat(o[k], v) : v } return o },
  stringify: (o, sep = '&', eq = '=') => Object.entries(o || {}).flatMap(([k, v]) => [].concat(v).map((x) => encodeURIComponent(k) + eq + encodeURIComponent(x ?? ''))).join(sep),
  escape: encodeURIComponent, unescape: decodeURIComponent,
}
querystring.decode = querystring.parse; querystring.encode = querystring.stringify
export const timersPromises = timerPromises
