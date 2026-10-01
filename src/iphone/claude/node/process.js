// `process` de Node para Claude Code en un Worker: argv, env, cwd, stdin/stdout por mensajes, salida.
import { EventEmitter } from 'events'
import { Readable, Writable } from 'readable-stream'
import { Buffer } from 'buffer'
import { posix as path } from './path.js'

/** process.exit corta lo que se está ejecutando, como en Node (el Worker termina después). */
export class ProcessExit extends Error { constructor(code) { super(`process.exit(${code})`); this.code = code } }

export function createProcess(o) {
  const p = new EventEmitter()
  p.setMaxListeners(0)
  let cwd = o.cwd || '/'
  const t0 = performance.now()
  const dec = new TextDecoder()
  const writer = (fd, sink) => {
    const w = new Writable({ decodeStrings: false, write(chunk, enc, cb) { sink(typeof chunk === 'string' ? chunk : dec.decode(chunk)); cb() } })
    Object.assign(w, { fd, isTTY: false, columns: 120, rows: 40, _isStdio: true, getColorDepth: () => 1, hasColors: () => false, getWindowSize: () => [120, 40], cursorTo: () => true, moveCursor: () => true, clearLine: () => true, clearScreenDown: () => true })
    w.destroySoon = w.destroy
    return w
  }
  const stdin = new Readable({ read() {} })
  Object.assign(stdin, { fd: 0, isTTY: false, isRaw: false, setRawMode() { return stdin }, ref() { return stdin }, unref() { return stdin } })
  const hr = (prev) => {
    const t = performance.now(), s = Math.floor(t / 1000), ns = Math.floor((t % 1000) * 1e6)
    if (!prev) return [s, ns]
    let ds = s - prev[0], dn = ns - prev[1]
    if (dn < 0) { ds--; dn += 1e9 }
    return [ds, dn]
  }
  hr.bigint = () => BigInt(Math.floor(performance.now() * 1e6))
  const mem = () => ({ rss: 2e8, heapTotal: 1.2e8, heapUsed: 9e7, external: 1e7, arrayBuffers: 1e6 })
  mem.rss = () => 2e8
  Object.assign(p, {
    title: 'claude', version: 'v22.12.0', versions: { node: '22.12.0', v8: '12.4.254.21-node.33', uv: '1.49.2', zlib: '1.3.0.1', modules: '127', openssl: '3.0.15', unicode: '15.1', ares: '1.34.3', napi: '9' },
    platform: 'linux', arch: 'arm64', release: { name: 'node', lts: 'Jod', sourceUrl: '', headersUrl: '' },
    env: o.env, argv: o.argv, argv0: 'node', execArgv: [], execPath: '/usr/local/bin/node', pid: 4242, ppid: 1, exitCode: undefined,
    config: { variables: {} }, features: { inspector: false, ipv6: true, tls: true, typescript: false }, allowedNodeEnvironmentFlags: new Set(), noDeprecation: true, throwDeprecation: false,
    stdin, stdout: writer(1, o.stdout), stderr: writer(2, o.stderr),
    cwd: () => cwd,
    chdir: (d) => { const n = path.resolve(cwd, String(d)); if (!o.isDir(n)) throw Object.assign(new Error(`ENOENT: no such file or directory, chdir '${d}'`), { code: 'ENOENT', syscall: 'chdir', path: d }); cwd = n },
    umask: () => 0o022, getuid: () => 1000, geteuid: () => 1000, getgid: () => 1000, getegid: () => 1000, getgroups: () => [1000],
    hrtime: hr, uptime: () => (performance.now() - t0) / 1000, memoryUsage: mem, cpuUsage: () => ({ user: 0, system: 0 }),
    resourceUsage: () => ({ userCPUTime: 0, systemCPUTime: 0, maxRSS: 200000, fsRead: 0, fsWrite: 0, voluntaryContextSwitches: 0, involuntaryContextSwitches: 0 }),
    constrainedMemory: () => 0, availableMemory: () => 4e9,
    nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
    emitWarning: (w, ...rest) => { if (o.env.OA_DEBUG) console.warn('[aviso]', w, ...rest) },
    exit: (code) => { const c = code ?? p.exitCode ?? 0; p.exitCode = c; try { p.emit('exit', c) } catch { /* ignore */ } o.exit(c); throw new ProcessExit(c) },
    reallyExit: (code) => p.exit(code), abort: () => p.exit(134),
    kill: (pid, sig) => { if (pid === p.pid) p.emit(sig || 'SIGTERM', sig || 'SIGTERM'); return true },
    binding: (n) => { throw new Error(`process.binding('${n}') no existe`) }, dlopen: () => { throw new Error('No se pueden cargar complementos nativos') },
    getBuiltinModule: (n) => o.builtin(n),
    report: { getReport: () => ({ header: { glibcVersionRuntime: '2.39', osName: 'Linux', osRelease: '6.1.0', osMachine: 'aarch64' }, sharedObjects: [] }), excludeNetwork: true },
    setUncaughtExceptionCaptureCallback: () => {}, hasUncaughtExceptionCaptureCallback: () => false, setSourceMapsEnabled: () => {}, loadEnvFile: () => {},
    channel: undefined, connected: false, debugPort: 9229, sourceMapsEnabled: false, finalization: { register() {}, unregister() {} },
  })
  return p
}
