// Antes que cualquier otro módulo del paquete: lo que las librerías (memfs, readable-stream, util…) esperan encontrar.
import { Buffer } from 'buffer'
// Symbol.dispose / asyncDispose (los `using` de Claude Code se reescriben al instalar, ver lowerUsing): los mismos
// símbolos que usa Node cuando el motor no los trae.
if (typeof Symbol.dispose !== 'symbol') Object.defineProperty(Symbol, 'dispose', { value: Symbol.for('nodejs.dispose') })
if (typeof Symbol.asyncDispose !== 'symbol') Object.defineProperty(Symbol, 'asyncDispose', { value: Symbol.for('nodejs.asyncDispose') })
// La pila de recursos de cada bloque reescrito (pares [async, valor]): se liberan en orden inverso al salir.
globalThis.$oaUse = (stack, isAsync, v) => { if (v != null) stack.push(isAsync, v); return v }
globalThis.$oaDispose = (stack) => { for (let i = stack.length - 2; i >= 0; i -= 2) stack[i + 1][Symbol.dispose]() }
globalThis.$oaDisposeAsync = async (stack) => {
  for (let i = stack.length - 2; i >= 0; i -= 2) { const v = stack[i + 1]; await (stack[i] ? (v[Symbol.asyncDispose] || v[Symbol.dispose]) : v[Symbol.dispose]).call(v) }
}
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
