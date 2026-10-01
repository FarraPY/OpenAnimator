// Antes que cualquier otro módulo del paquete: lo que las librerías (memfs, readable-stream, util…) esperan encontrar.
import { Buffer } from 'buffer'
if (!globalThis.global) globalThis.global = globalThis
if (!globalThis.Buffer) globalThis.Buffer = Buffer
if (!globalThis.process) {
  // Provisorio hasta install(): sólo lo que usan las librerías al cargarse.
  globalThis.process = { env: {}, argv: [], platform: 'linux', version: 'v22.12.0', versions: { node: '22.12.0' }, browser: false, cwd: () => '/', getuid: () => 1000, getgid: () => 1000, geteuid: () => 1000, getegid: () => 1000, umask: () => 0o022, nextTick: (f, ...a) => queueMicrotask(() => f(...a)), emitWarning: () => {}, stdout: {}, stderr: {} }
}
if (!globalThis.setImmediate) {
  globalThis.setImmediate = (f, ...a) => setTimeout(f, 0, ...a)
  globalThis.clearImmediate = (t) => clearTimeout(t)
}
export { Buffer }
