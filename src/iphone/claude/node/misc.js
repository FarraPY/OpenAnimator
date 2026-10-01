// Módulos de Node chicos o que en el iPhone no tienen sentido (sin depurador, sin hilos de Node, sin UDP…).
import { EventEmitter } from 'events'
import { Readable, Writable } from 'readable-stream'
import { Buffer } from 'buffer'

const unavailable = (what) => function () { throw new Error(`${what} no está disponible en el iPhone`) }
const unavailableClass = (what) => class { constructor() { throw new Error(`${what} no está disponible en el iPhone`) } }

/**
 * AsyncLocalStorage sin soporte del motor: el valor vale durante run() y, si fn devuelve una promesa, hasta que se
 * resuelve. Alcanza para una conversación (un solo agente); no separa trabajos asíncronos que corren a la vez.
 */
class AsyncLocalStorage {
  constructor() { this._store = undefined }
  getStore() { return this._store }
  run(store, fn, ...args) {
    const prev = this._store
    this._store = store
    let r
    try { r = fn(...args) } catch (e) { this._store = prev; throw e }
    if (r && typeof r.then === 'function') { const back = () => { if (this._store === store) this._store = prev }; r.then(back, back); return r }
    this._store = prev
    return r
  }
  exit(fn, ...args) { const prev = this._store; this._store = undefined; try { return fn(...args) } finally { this._store = prev } }
  enterWith(store) { this._store = store }
  disable() { this._store = undefined }
  static bind(fn) { return fn }
  static snapshot() { return (fn, ...a) => fn(...a) }
}
class AsyncResource {
  constructor(type) { this.type = type }
  runInAsyncScope(fn, thisArg, ...args) { return fn.apply(thisArg, args) }
  bind(fn) { return fn.bind(this) }
  emitDestroy() { return this } asyncId() { return 1 } triggerAsyncId() { return 0 }
  static bind(fn) { return fn }
}
export const asyncHooks = { AsyncLocalStorage, AsyncResource, executionAsyncId: () => 1, triggerAsyncId: () => 0, executionAsyncResource: () => ({}), createHook: () => ({ enable() { return this }, disable() { return this } }), asyncWrapProviders: {} }

const histogram = () => ({ enable() { return true }, disable() { return true }, reset() {}, percentile: () => 0, percentiles: new Map(), min: 0, max: 0, mean: 0, stddev: 0, exceeds: 0, count: 0, record() {}, recordDelta() {} })
const perf = globalThis.performance
export const perfHooks = {
  performance: Object.assign(Object.create(null), {
    now: () => perf.now(), timeOrigin: perf.timeOrigin, mark: (...a) => perf.mark(...a), measure: (...a) => perf.measure(...a), clearMarks: (...a) => perf.clearMarks(...a), clearMeasures: (...a) => perf.clearMeasures(...a),
    getEntries: () => perf.getEntries(), getEntriesByName: (...a) => perf.getEntriesByName(...a), getEntriesByType: (...a) => perf.getEntriesByType(...a), toJSON: () => perf.toJSON(),
    eventLoopUtilization: () => ({ idle: 0, active: 0, utilization: 0 }), timerify: (f) => f, nodeTiming: { name: 'node', entryType: 'node', startTime: 0, duration: perf.now(), bootstrapComplete: 0, environment: 0, idleTime: 0, loopExit: -1, loopStart: 0, nodeStart: 0, v8Start: 0 },
  }),
  PerformanceObserver: globalThis.PerformanceObserver || class { observe() {} disconnect() {} }, PerformanceEntry: globalThis.PerformanceEntry || class {}, PerformanceMark: globalThis.PerformanceMark || class {}, PerformanceMeasure: globalThis.PerformanceMeasure || class {},
  monitorEventLoopDelay: histogram, createHistogram: histogram, constants: { NODE_PERFORMANCE_GC_MAJOR: 4, NODE_PERFORMANCE_GC_MINOR: 1, NODE_PERFORMANCE_GC_INCREMENTAL: 8, NODE_PERFORMANCE_GC_WEAKCB: 16 },
}

export const tty = { isatty: () => false, ReadStream: class extends Readable { constructor() { super({ read() {} }); this.isTTY = false } setRawMode() { return this } }, WriteStream: class extends Writable { constructor() { super({ write(c, e, cb) { cb() } }); this.isTTY = false; this.columns = 120; this.rows = 40 } getColorDepth() { return 1 } hasColors() { return false } } }

export function createVm() {
  const runInNewContext = (code, ctx = {}) => { const keys = Object.keys(ctx); return new Function(...keys, `return eval(${JSON.stringify(String(code))})`)(...keys.map((k) => ctx[k])) }
  class Script {
    constructor(code) { this.code = String(code) }
    runInThisContext() { return (0, eval)(this.code) }
    runInNewContext(ctx) { return runInNewContext(this.code, ctx) }
    runInContext(ctx) { return runInNewContext(this.code, ctx) }
    createCachedData() { return Buffer.alloc(0) }
  }
  return {
    Script, runInNewContext, runInContext: runInNewContext, runInThisContext: (code) => (0, eval)(String(code)), createContext: (o = {}) => o, isContext: () => true,
    compileFunction: (code, params = []) => new Function(...params, String(code)), measureMemory: async () => ({ total: { jsMemoryEstimate: 0, jsMemoryRange: [0, 0] } }),
    SourceTextModule: unavailableClass('vm.SourceTextModule'), SyntheticModule: unavailableClass('vm.SyntheticModule'), Module: unavailableClass('vm.Module'),
    constants: { USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol('vm_dynamic_import_main_context_default'), DONT_CONTEXTIFY: Symbol('vm_context_no_contextify') },
  }
}

export const v8 = {
  getHeapStatistics: () => ({ total_heap_size: 1.2e8, total_heap_size_executable: 1e6, total_physical_size: 1.2e8, total_available_size: 3e9, used_heap_size: 9e7, heap_size_limit: 4e9, malloced_memory: 1e6, peak_malloced_memory: 2e6, does_zap_garbage: 0, number_of_native_contexts: 1, number_of_detached_contexts: 0, total_global_handles_size: 0, used_global_handles_size: 0, external_memory: 0 }),
  getHeapSpaceStatistics: () => [], getHeapCodeStatistics: () => ({ code_and_metadata_size: 0, bytecode_and_metadata_size: 0, external_script_source_size: 0, cpu_profiler_metadata_size: 0 }),
  setFlagsFromString: () => {}, cachedDataVersionTag: () => 0, writeHeapSnapshot: () => '', getHeapSnapshot: unavailable('v8.getHeapSnapshot'), takeCoverage: () => {}, stopCoverage: () => {}, queryObjects: () => 0, setHeapSnapshotNearHeapLimit: () => {}, isStringOneByteRepresentation: () => false,
  serialize: (v) => Buffer.from(JSON.stringify(v)), deserialize: (b) => JSON.parse(Buffer.from(b).toString('utf8')),
  Serializer: unavailableClass('v8.Serializer'), Deserializer: unavailableClass('v8.Deserializer'), DefaultSerializer: unavailableClass('v8.DefaultSerializer'), DefaultDeserializer: unavailableClass('v8.DefaultDeserializer'),
  startupSnapshot: { isBuildingSnapshot: () => false, addSerializeCallback() {}, addDeserializeCallback() {}, setDeserializeMainFunction() {} },
  promiseHooks: { onInit: () => () => {}, onSettled: () => () => {}, onBefore: () => () => {}, onAfter: () => () => {}, createHook: () => () => {} }, GCProfiler: class { start() {} stop() { return { version: 1, startTime: 0, endTime: 0, statistics: [] } } },
}

export const workerThreads = {
  isMainThread: true, parentPort: null, workerData: null, threadId: 0, resourceLimits: {}, SHARE_ENV: Symbol('nodejs.worker_threads.SHARE_ENV'),
  Worker: unavailableClass('worker_threads.Worker'), MessageChannel: globalThis.MessageChannel, MessagePort: globalThis.MessagePort, BroadcastChannel: globalThis.BroadcastChannel,
  markAsUntransferable: () => {}, isMarkedAsUntransferable: () => false, markAsUncloneable: () => {}, moveMessagePortToContext: (p) => p, receiveMessageOnPort: () => undefined,
  setEnvironmentData: () => {}, getEnvironmentData: () => undefined, postMessageToThread: async () => {},
}
export const inspector = { open: () => {}, close: () => {}, url: () => undefined, waitForDebugger: () => {}, console: globalThis.console, Session: class extends EventEmitter { connect() {} connectToMainThread() {} post(m, p, cb) { (typeof p === 'function' ? p : cb)?.(new Error('inspector no disponible')) } disconnect() {} }, Network: { requestWillBeSent() {}, responseReceived() {}, loadingFinished() {}, loadingFailed() {} } }
const channel = (name) => ({ name, hasSubscribers: false, publish() {}, subscribe() {}, unsubscribe() { return false }, bindStore() {}, unbindStore() {}, runStores(d, fn, t, ...a) { return fn.apply(t, a) } })
export const diagnosticsChannel = { channel, hasSubscribers: () => false, subscribe: () => {}, unsubscribe: () => false, tracingChannel: (n) => ({ start: channel(n + ':start'), end: channel(n + ':end'), asyncStart: channel(n + ':asyncStart'), asyncEnd: channel(n + ':asyncEnd'), error: channel(n + ':error'), hasSubscribers: false, subscribe() {}, unsubscribe() {}, traceSync: (fn, ctx, t, ...a) => fn.apply(t, a), tracePromise: (fn, ctx, t, ...a) => fn.apply(t, a), traceCallback: (fn, pos, ctx, t, ...a) => fn.apply(t, a) }), Channel: class {} }
export const cluster = Object.assign(new EventEmitter(), { isPrimary: true, isMaster: true, isWorker: false, workers: {}, settings: {}, SCHED_NONE: 1, SCHED_RR: 2, schedulingPolicy: 2, fork: unavailable('cluster.fork'), setupPrimary() {}, setupMaster() {}, disconnect(cb) { cb?.() } })
export const dgram = { createSocket: unavailable('dgram.createSocket'), Socket: unavailableClass('dgram.Socket') }
export const sqlite = { DatabaseSync: unavailableClass('sqlite'), StatementSync: unavailableClass('sqlite'), constants: {}, backup: unavailable('sqlite.backup') }
export const wasi = { WASI: unavailableClass('WASI') }
export const traceEvents = { createTracing: () => ({ enable() {}, disable() {}, enabled: false, categories: '' }), getEnabledCategories: () => '' }
export const punycode = { toASCII: (s) => s, toUnicode: (s) => s, encode: (s) => s, decode: (s) => s, ucs2: { decode: (s) => Array.from(s, (c) => c.codePointAt(0)), encode: (a) => String.fromCodePoint(...a) }, version: '2.1.0' }

// Externos que Bun trae incorporados.
export const ws = { WebSocket: globalThis.WebSocket, WebSocketServer: unavailableClass('WebSocketServer'), Server: unavailableClass('WebSocketServer'), createWebSocketStream: unavailable('createWebSocketStream') }
export const bunJsc = {
  heapStats: () => ({ heapSize: 0, heapCapacity: 0, extraMemorySize: 0, objectCount: 0, protectedObjectCount: 0, globalObjectCount: 0, protectedGlobalObjectCount: 0, objectTypeCounts: {}, protectedObjectTypeCounts: {} }),
  memoryUsage: () => ({ current: 0, peak: 0, currentCommit: 0, peakCommit: 0, pageFaults: 0 }), serialize: (v) => new TextEncoder().encode(JSON.stringify(v)), deserialize: (b) => JSON.parse(new TextDecoder().decode(b)),
  setTimeZone: () => {}, gcAndSweep: () => 0, fullGC: () => 0, edenGC: () => 0, getRandomSeed: () => 0, setRandomSeed: () => {}, estimateShallowMemoryUsageOf: () => 0, describe: (v) => String(v), describeArray: (v) => String(v),
  profile: () => {}, startSamplingProfiler: () => {}, samplingProfilerStackTraces: () => '', drainMicrotasks: () => {}, totalCompileTime: () => 0, reoptimizationRetryCount: () => 0, numberOfDFGCompiles: () => 0, noFTL: (f) => f, noOSRExitFuzzing: (f) => f, optimizeNextInvocation: () => {}, releaseWeakRefs: () => {}, getProtectedObjects: () => [], isRope: () => false, callerSourceOrigin: () => '', startRemoteDebugger: () => {}, generateHeapSnapshotForDebugging: () => ({}),
}
export const nodeFetch = { default: (...a) => globalThis.fetch(...a), Headers: globalThis.Headers, Request: globalThis.Request, Response: globalThis.Response, FetchError: class extends Error {}, AbortError: class extends Error {}, isRedirect: (c) => [301, 302, 303, 307, 308].includes(c) }
