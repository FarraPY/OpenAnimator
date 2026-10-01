// Temporizadores con la forma de los de Node (unref, ref, refresh, hasRef): el código de Node los usa siempre.
const native = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis), setInterval: globalThis.setInterval.bind(globalThis), clearInterval: globalThis.clearInterval.bind(globalThis) }

export class Timeout {
  constructor(fn, ms, args, repeat) {
    this._fn = fn; this._ms = Math.max(1, +ms || 1); this._args = args; this._repeat = repeat; this._ref = true
    this._start()
  }
  _start() { this._id = (this._repeat ? native.setInterval : native.setTimeout)(() => this._fn(...this._args), this._ms) }
  ref() { this._ref = true; return this }
  unref() { this._ref = false; return this }
  hasRef() { return this._ref }
  refresh() { this._clear(); this._start(); return this }
  close() { this._clear(); return this }
  _clear() { (this._repeat ? native.clearInterval : native.clearTimeout)(this._id) }
  [Symbol.toPrimitive]() { return this._id }
  [Symbol.dispose]() { this._clear() }
}
export class Immediate {
  constructor(fn, args) { this._ref = true; this._id = native.setTimeout(() => fn(...args), 0) }
  ref() { this._ref = true; return this }
  unref() { this._ref = false; return this }
  hasRef() { return this._ref }
}
const clear = (t) => { if (t instanceof Timeout) t._clear(); else if (t instanceof Immediate) native.clearTimeout(t._id); else if (t != null) native.clearTimeout(t) }
export const setTimeout = (fn, ms, ...args) => new Timeout(fn, ms, args, false)
export const setInterval = (fn, ms, ...args) => new Timeout(fn, ms, args, true)
export const setImmediate = (fn, ...args) => new Immediate(fn, args)
export const clearTimeout = clear, clearInterval = clear, clearImmediate = clear

export function installTimers() {
  Object.assign(globalThis, { setTimeout, setInterval, setImmediate, clearTimeout, clearInterval, clearImmediate })
}

const abortErr = (signal) => Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR', cause: signal?.reason })
function delay(ms, value, opts = {}) {
  return new Promise((res, rej) => {
    if (opts.signal?.aborted) return rej(abortErr(opts.signal))
    const t = native.setTimeout(() => res(value), ms)
    opts.signal?.addEventListener('abort', () => { native.clearTimeout(t); rej(abortErr(opts.signal)) }, { once: true })
  })
}
export const promises = {
  setTimeout: delay,
  setImmediate: (value, opts) => delay(0, value, opts),
  async *setInterval(ms, value, opts = {}) { for (;;) { await delay(ms, undefined, opts); yield value } },
  scheduler: { wait: (ms, opts) => delay(ms, undefined, opts), yield: () => delay(0) },
}
