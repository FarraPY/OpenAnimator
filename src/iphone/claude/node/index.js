/**
 * "Node" para correr Claude Code dentro de un Worker del navegador (Safari en el iPhone).
 * install() arma los módulos (fs en memoria, process, os, crypto…) y las variables globales; después el Worker importa
 * /$bunfs/root/cli (Claude Code extraído). Cada módulo de Node lo pide un envoltorio generado (/oa-node/<nombre>.js)
 * con mod(nombre, exportados).
 */
import { Buffer } from 'buffer'
import { createProcess, ProcessExit } from './process.js'
import { createFs } from './fs.js'
import { posix, win32 } from './path.js'
import * as cryptoMod from './crypto.js'
import { createOs, childProcess, net, tls, dns, dnsPromises, http, https, http2 } from './sys.js'
import { events, buffer, stream, streamPromises, streamConsumers, streamWeb, util, types, url, zlib, readline, stringDecoder, assert, querystring, timersPromises } from './lib.js'
import * as T from './timers.js'
import { createBun } from './bun.js'
import { asyncHooks, perfHooks, tty, createVm, v8, workerThreads, inspector, diagnosticsChannel, cluster, dgram, sqlite, wasi, traceEvents, punycode, ws, bunJsc, nodeFetch } from './misc.js'

export { ProcessExit }
let modules = null

const BUILTINS = ['assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'dns/promises', 'events', 'fs', 'fs/promises', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'path/posix', 'path/win32', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'readline/promises', 'stream', 'stream/consumers', 'stream/promises', 'stream/web', 'string_decoder', 'sys', 'timers', 'timers/promises', 'tls', 'trace_events', 'tty', 'url', 'util', 'util/types', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib', 'sqlite']

/** El módulo `name` (ya armado por install). Si un envoltorio pide un nombre que no existe, recibe uno que avisa al usarse. */
export function mod(name, exported = []) {
  if (!modules) throw new Error('El entorno de Node no está instalado (install)')
  const m = modules[name.replace(/^node:/, '')]
  if (!m) throw new Error(`Módulo desconocido: ${name}`)
  for (const k of exported) if (!(k in m)) {
    try { m[k] = /^[A-Z][A-Z0-9_]+$/.test(k) ? undefined : Object.assign(function () { throw new Error(`${name}.${k} no está disponible en el iPhone`) }, { __oaMissing: true }) } catch { /* objeto congelado */ }
  }
  return m
}

/**
 * o: { argv, env, cwd, home, files: [ruta, datos][], dirs: string[], stdout(s), stderr(s), exit(code), onFsChange(ruta),
 *      fetch?: reemplazo de fetch (el Worker agrega el encabezado de CORS de Anthropic y responde el MCP) }
 */
export function install(o) {
  let fs = null
  const proc = createProcess({
    argv: o.argv, env: o.env, cwd: o.cwd, stdout: o.stdout, stderr: o.stderr, exit: o.exit,
    isDir: (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } },
    builtin: (n) => (BUILTINS.includes(n.replace(/^node:/, '')) ? req(n) : undefined),
  })
  // process antes que el disco: memfs toma el dueño de cada archivo de process.getuid() (Claude Code lo verifica).
  globalThis.process = proc
  const made = createFs({ files: o.files, dirs: [o.home, '/tmp', o.cwd, ...(o.dirs || [])], onChange: o.onFsChange })
  fs = made.fs
  const vol = made.vol
  const os = createOs({ home: o.home })
  const vm = createVm()
  const timers = { setTimeout: T.setTimeout, setInterval: T.setInterval, setImmediate: T.setImmediate, clearTimeout: T.clearTimeout, clearInterval: T.clearInterval, clearImmediate: T.clearImmediate, promises: timersPromises, active: () => {}, unenroll: () => {}, enroll: () => {} }
  const moduleMod = {
    builtinModules: BUILTINS, isBuiltin: (n) => BUILTINS.includes(String(n).replace(/^node:/, '')), createRequire: () => req, register: () => {}, syncBuiltinESMExports: () => {},
    findSourceMap: () => undefined, SourceMap: class {}, enableCompileCache: () => ({ status: 0 }), getCompileCacheDir: () => undefined, flushCompileCache: () => {}, findPackageJSON: () => undefined, stripTypeScriptTypes: (s) => s,
    constants: { compileCacheStatus: { FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED: 3 } }, _extensions: {}, _cache: {}, _pathCache: {}, wrap: (s) => `(function (exports, require, module, __filename, __dirname) { ${s}\n});`,
    Module: class Module { static builtinModules = BUILTINS; static _load(n) { return req(n) } static _resolveFilename(r) { return r } static createRequire() { return req } },
  }
  const constants = { ...os.constants.errno, ...os.constants.signals, ...fs.constants }
  const def = (m) => { m.default = m; return m }
  modules = {
    fs: def(fs), 'fs/promises': def(fs.promises), path: def(posix), 'path/posix': def(posix), 'path/win32': def(win32), os: def(os), crypto: def({ ...cryptoMod.default }),
    child_process: def(childProcess), net: def(net), tls: def(tls), dns: def(dns), 'dns/promises': def(dnsPromises), http: def(http), https: def(https), http2: def(http2),
    events: events, buffer: def(buffer), stream: stream, 'stream/promises': def(streamPromises), 'stream/consumers': def(streamConsumers), 'stream/web': def(streamWeb),
    util: def(util), sys: def(util), 'util/types': def(types), url: def(url), zlib: def(zlib), readline: def(readline), 'readline/promises': def(readline.promises),
    string_decoder: def(stringDecoder), assert: assert, 'assert/strict': assert.strict || assert, querystring: def(querystring), timers: def(timers), 'timers/promises': def(timersPromises),
    tty: def(tty), vm: def(vm), v8: def(v8), module: def(moduleMod), perf_hooks: def(perfHooks), async_hooks: def(asyncHooks), worker_threads: def(workerThreads), inspector: def(inspector),
    diagnostics_channel: def(diagnosticsChannel), constants: def(constants), cluster: def(cluster), dgram: def(dgram), sqlite: def(sqlite), wasi: def(wasi), trace_events: def(traceEvents), punycode: def(punycode),
    process: proc, console: globalThis.console, ws: def(ws), 'bun:jsc': def(bunJsc), 'node-fetch': nodeFetch,
  }
  if (!('default' in proc)) proc.default = proc
  // require() de CommonJS (Bun lo guarda en una variable): los módulos de Node, ya cargados.
  function req(name) {
    // Recursos de Bun (/$bunfs/root/…): require devuelve el texto (loader text), la ruta (file) o el JSON.
    if (String(name).startsWith('/$bunfs/root/')) {
      if (/\.m?js$/.test(name)) return globalThis.__oaChunk(name)
      const loader = o.assets?.[name.slice(13)]
      if (loader === 'text') return fs.readFileSync(name, 'utf8')
      if (loader === 'json' || loader === 'jsonc') return JSON.parse(fs.readFileSync(name, 'utf8'))
      if (loader === 'napi') throw Object.assign(new Error(`No se pueden cargar complementos nativos (${name})`), { code: 'ERR_DLOPEN_FAILED' })
      return name
    }
    const n = String(name).replace(/^node:/, '')
    const m = modules[n]
    if (!m) throw Object.assign(new Error(`Cannot find module '${name}'`), { code: 'MODULE_NOT_FOUND' })
    return n === 'node-fetch' ? m.default : m
  }
  req.resolve = (n) => n
  req.cache = {}
  globalThis.__oaRequire = req
  // Sin aislamiento de origen no hay SharedArrayBuffer: Claude Code lo usa para "dormir" de forma sincrónica
  // (Atomics.wait) al reintentar operaciones de archivos. Acá alcanza con una espera activa corta (es un Worker).
  if (typeof globalThis.SharedArrayBuffer === 'undefined') {
    globalThis.SharedArrayBuffer = class SharedArrayBuffer extends ArrayBuffer {}
    const wait = Atomics.wait
    Atomics.wait = function (ta, i, v, ms) {
      if (ta?.buffer instanceof globalThis.SharedArrayBuffer) {
        if (Atomics.load(ta, i) !== v) return 'not-equal'
        const end = performance.now() + Math.min(ms ?? 5000, 5000)
        while (performance.now() < end) { /* espera */ }
        return 'timed-out'
      }
      return wait.call(Atomics, ta, i, v, ms)
    }
  }
  globalThis.process = proc
  globalThis.Bun = createBun({ fs, proc, deepEqual: util.isDeepStrictEqual, toWeb: stream.Readable.toWeb })
  globalThis.Buffer = Buffer
  globalThis.global = globalThis
  // console de Node: escribe en process.stdout / stderr (en el Worker iría a la consola del navegador).
  globalThis.__oaConsole = globalThis.console
  const NL = String.fromCharCode(10)
  const fmt = (...a) => util.format(...a) + NL
  const con = {
    log: (...a) => proc.stdout.write(fmt(...a)), info: (...a) => proc.stdout.write(fmt(...a)), debug: (...a) => proc.stdout.write(fmt(...a)),
    error: (...a) => proc.stderr.write(fmt(...a)), warn: (...a) => proc.stderr.write(fmt(...a)), trace: (...a) => proc.stderr.write(fmt(...a)),
    dir: (v) => proc.stdout.write(util.inspect(v) + NL), table: (v) => proc.stdout.write(util.inspect(v) + NL),
    assert: (c, ...a) => { if (!c) proc.stderr.write(fmt('Assertion failed', ...a)) }, group: () => {}, groupEnd: () => {}, groupCollapsed: () => {},
    time: () => {}, timeEnd: () => {}, timeLog: () => {}, count: () => {}, countReset: () => {}, clear: () => {}, profile: () => {}, profileEnd: () => {}, timeStamp: () => {},
  }
  globalThis.console = con
  modules.console = def(con)
  T.installTimers()
  if (o.fetch) globalThis.fetch = o.fetch
  return { proc, fs, vol, stdin: (s) => proc.stdin.push(s), stdinEnd: () => proc.stdin.push(null) }
}
