// os, child_process y la red de bajo nivel (net, tls, dns, http, https, http2): en el iPhone no hay procesos ni sockets.
import { EventEmitter } from 'events'
import { Readable, Writable } from 'readable-stream'

const signals = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGWINCH: 28 }
const errno = { E2BIG: 7, EACCES: 13, EADDRINUSE: 98, EAGAIN: 11, EBADF: 9, EBUSY: 16, ECONNREFUSED: 111, ECONNRESET: 104, EEXIST: 17, EINTR: 4, EINVAL: 22, EIO: 5, EISDIR: 21, EMFILE: 24, ENOENT: 2, ENOSPC: 28, ENOTDIR: 20, ENOTEMPTY: 39, EPERM: 1, EPIPE: 32, ETIMEDOUT: 110 }

export function createOs(o) {
  const cpu = { model: 'Apple A19 Pro', speed: 4260, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }
  return {
    EOL: '\n', devNull: '/dev/null', constants: { signals, errno, priority: { PRIORITY_LOW: 19, PRIORITY_NORMAL: 0, PRIORITY_HIGH: -14 }, dlopen: {}, UV_UDP_REUSEADDR: 4 },
    homedir: () => o.home, tmpdir: () => '/tmp', hostname: () => 'iphone', platform: () => 'linux', type: () => 'Linux', release: () => '6.1.0', version: () => '#1 SMP iOS',
    arch: () => 'arm64', machine: () => 'aarch64', endianness: () => 'LE', cpus: () => Array.from({ length: 6 }, () => ({ ...cpu })), availableParallelism: () => 6,
    totalmem: () => 12e9, freemem: () => 6e9, loadavg: () => [0, 0, 0], uptime: () => Math.floor(performance.now() / 1000), networkInterfaces: () => ({}),
    userInfo: () => ({ username: 'user', uid: 1000, gid: 1000, shell: '/bin/sh', homedir: o.home }), getPriority: () => 0, setPriority: () => {},
  }
}

// ── procesos: spawn termina con ENOENT (como si el programa no estuviera instalado) ─────────────
const enoent = (cmd) => Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT', errno: -2, syscall: `spawn ${cmd}`, path: cmd, spawnargs: [] })
class ChildProcess extends EventEmitter {
  constructor(cmd, args = []) {
    super()
    this.spawnfile = cmd; this.spawnargs = [cmd, ...args]; this.pid = undefined; this.exitCode = null; this.signalCode = null; this.killed = false; this.connected = false
    this.stdin = new Writable({ write(c, e, cb) { cb() } })
    this.stdout = new Readable({ read() {} }); this.stderr = new Readable({ read() {} })
    this.stdio = [this.stdin, this.stdout, this.stderr]
    queueMicrotask(() => {
      this.emit('error', enoent(cmd))
      this.stdout.push(null); this.stderr.push(null)
      this.exitCode = -2
      this.emit('close', -2, null)
    })
  }
  kill() { this.killed = true; return false }
  ref() { return this } unref() { return this } disconnect() {}
  send() { return false }
}
const spawn = (cmd, args, o) => new ChildProcess(cmd, Array.isArray(args) ? args : [])
const execFile = (cmd, args, o, cb) => { cb = [args, o, cb].find((x) => typeof x === 'function'); const c = new ChildProcess(cmd, Array.isArray(args) ? args : []); queueMicrotask(() => cb?.(enoent(cmd), '', '')); return c }
const exec = (cmd, o, cb) => execFile(String(cmd).split(' ')[0], [], o, cb)
const spawnSync = (cmd) => ({ pid: 0, output: [null, '', ''], stdout: '', stderr: '', status: null, signal: null, error: enoent(cmd) })
const execSync = (cmd) => { throw Object.assign(enoent(String(cmd).split(' ')[0]), { status: 127, stdout: '', stderr: '' }) }
const execFileSync = (cmd) => { throw Object.assign(enoent(cmd), { status: 127, stdout: '', stderr: '' }) }
export const childProcess = { spawn, exec, execFile, fork: (m) => new ChildProcess(m), spawnSync, execSync, execFileSync, ChildProcess, _forkChild: () => {} }

// ── red: sin sockets; fetch (del navegador) es la única salida ────────────────
const noNet = (what) => () => { throw Object.assign(new Error(`${what} no está disponible en el iPhone (sin sockets)`), { code: 'ENOTSUP' }) }
class Socket extends EventEmitter {
  constructor() { super(); this.destroyed = false; this.readyState = 'closed' }
  connect() { queueMicrotask(() => this.emit('error', Object.assign(new Error('Sin sockets en el iPhone'), { code: 'ECONNREFUSED' }))); return this }
  setNoDelay() { return this } setKeepAlive() { return this } setTimeout() { return this } ref() { return this } unref() { return this }
  write() { return false } end() { return this } destroy() { this.destroyed = true; return this } address() { return {} }
}
/**
 * Servidores: no hay sockets, así que abrir uno da error. Salvo al iniciar sesión (worker.js, `login`): ahí el de la
 * vuelta del navegador (http://localhost:<puerto>/callback) "escucha" y el pedido se lo entrega la app (http-request),
 * que es la que de verdad lo recibe en ese puerto (Bridge.swift, login.open).
 */
export const servers = new Map()
class Server extends EventEmitter {
  listen(...a) {
    const cb = a.find((x) => typeof x === 'function')
    if (!globalThis.__oaAllowListen) { queueMicrotask(() => { this.emit('error', Object.assign(new Error('No se puede abrir un servidor en el iPhone'), { code: 'EACCES' })) }); return this }
    const asked = typeof a[0] === 'number' ? a[0] : a[0]?.port
    this._port = asked || 49152 + Math.floor(Math.random() * 16000)
    servers.set(this._port, this)
    queueMicrotask(() => { this.listening = true; this.emit('listening'); cb?.() })
    return this
  }
  close(cb) { if (this._port) servers.delete(this._port); this.listening = false; queueMicrotask(() => { this.emit('close'); cb?.() }); return this }
  address() { return this._port ? { port: this._port, address: '127.0.0.1', family: 'IPv4' } : null }
  ref() { return this } unref() { return this }
}
const createServer = (o, handler) => { const s = new Server(); const h = typeof o === 'function' ? o : handler; if (h) s.on('request', h); return s }
const isIPv4 = (s) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(s)
const isIPv6 = (s) => s.includes(':') && /^[0-9a-f:.]+$/i.test(s)
/** Dirección → BigInt (IPv4 de 32 bits, IPv6 de 128). */
function ipBits(addr, family) {
  if (family === 'ipv4' || (!family && isIPv4(addr))) return addr.split('.').reduce((n, x) => (n << 8n) | BigInt(+x), 0n)
  let [head, tail = ''] = addr.split('::')
  const conv = (s) => (s ? s.split(':').flatMap((g) => (g.includes('.') ? [((+g.split('.')[0] << 8) | +g.split('.')[1]).toString(16), ((+g.split('.')[2] << 8) | +g.split('.')[3]).toString(16)] : [g])) : [])
  const h = conv(head), t = conv(tail)
  const groups = addr.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h
  return groups.reduce((n, g) => (n << 16n) | BigInt(parseInt(g || '0', 16)), 0n)
}
class BlockList {
  constructor() { this._rules = [] }
  addAddress(a, family = 'ipv4') { const f = typeof a === 'object' ? a.family : family, x = ipBits(typeof a === 'object' ? a.address : a, f); this._rules.push({ f, lo: x, hi: x }) }
  addRange(s, e, family = 'ipv4') { this._rules.push({ f: family, lo: ipBits(s, family), hi: ipBits(e, family) }) }
  addSubnet(net, prefix, family = 'ipv4') {
    const bits = family === 'ipv6' ? 128n : 32n, p = BigInt(prefix), base = ipBits(typeof net === 'object' ? net.address : net, family)
    if (p < 0n || p > bits) throw new RangeError('prefix fuera de rango')
    const mask = ((1n << bits) - 1n) ^ ((1n << (bits - p)) - 1n)
    this._rules.push({ f: family, lo: base & mask, hi: (base & mask) | ((1n << (bits - p)) - 1n) })
  }
  check(a, family = 'ipv4') { const f = typeof a === 'object' ? a.family : family; const x = ipBits(typeof a === 'object' ? a.address : a, f); return this._rules.some((r) => r.f === f && x >= r.lo && x <= r.hi) }
  get rules() { return this._rules.map((r) => `${r.f} ${r.lo}-${r.hi}`) }
}
export const net = {
  Socket, Stream: Socket, Server, createServer, createConnection: () => new Socket().connect(), connect: () => new Socket().connect(),
  isIP: (s) => (isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0), isIPv4, isIPv6, BlockList, SocketAddress: class { constructor(o = {}) { Object.assign(this, { address: '127.0.0.1', port: 0, family: 'ipv4', flowlabel: 0 }, o) } },
  getDefaultAutoSelectFamily: () => true, setDefaultAutoSelectFamily: () => {}, getDefaultAutoSelectFamilyAttemptTimeout: () => 250, setDefaultAutoSelectFamilyAttemptTimeout: () => {},
}
export const tls = { ...net, TLSSocket: Socket, connect: () => new Socket().connect(), createSecureContext: () => ({}), rootCertificates: [], DEFAULT_MIN_VERSION: 'TLSv1.2', DEFAULT_MAX_VERSION: 'TLSv1.3', DEFAULT_ECDH_CURVE: 'auto', checkServerIdentity: () => undefined, getCiphers: () => [], SecureContext: class {} }
const lookup = (host, o, cb) => { cb = typeof o === 'function' ? o : cb; queueMicrotask(() => cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }))) }
const dnsPromises = { lookup: async (h) => { throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${h}`), { code: 'ENOTFOUND' }) }, resolve: async () => [], resolve4: async () => [], resolve6: async () => [], resolveTxt: async () => [], resolveSrv: async () => [], reverse: async () => [], setDefaultResultOrder: () => {}, getDefaultResultOrder: () => 'ipv4first' }
export const dns = { lookup, resolve: (h, cb) => cb(null, []), resolve4: (h, cb) => cb(null, []), setDefaultResultOrder: () => {}, getDefaultResultOrder: () => 'ipv4first', promises: dnsPromises, Resolver: class { resolve() {} setServers() {} } }
export { dnsPromises }

const STATUS_CODES = { 100: 'Continue', 101: 'Switching Protocols', 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 206: 'Partial Content', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 408: 'Request Timeout', 409: 'Conflict', 413: 'Payload Too Large', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' }
class Agent extends EventEmitter { constructor(o) { super(); this.options = o || {}; this.maxSockets = Infinity } destroy() {} }
class ClientRequest extends EventEmitter {
  constructor() { super(); queueMicrotask(() => this.emit('error', Object.assign(new Error('http/https de Node no está disponible en el iPhone: usá fetch'), { code: 'ENOTSUP' }))) }
  write() { return true } end() { return this } abort() {} destroy() { return this } setTimeout() { return this } setHeader() {} getHeader() {} removeHeader() {} setNoDelay() {} setSocketKeepAlive() {} flushHeaders() {}
}
const httpMod = (proto) => ({
  STATUS_CODES, METHODS: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'], Agent, globalAgent: new Agent(), ClientRequest, IncomingMessage: class extends Readable {}, OutgoingMessage: class extends Writable {}, ServerResponse: class extends Writable {}, Server,
  request: () => new ClientRequest(), get: () => new ClientRequest(), createServer, validateHeaderName: () => {}, validateHeaderValue: () => {}, maxHeaderSize: 16384, setMaxIdleHTTPParsers: () => {}, _proto: proto,
})
export const http = httpMod('http:')
export const https = httpMod('https:')
export const http2 = { connect: noNet('http2.connect'), createServer: noNet('http2.createServer'), createSecureServer: noNet('http2.createSecureServer'), constants: {}, getDefaultSettings: () => ({}), sensitiveHeaders: Symbol('nodejs.http2.sensitiveHeaders') }
