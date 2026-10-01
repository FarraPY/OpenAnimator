/**
 * El "puente nativo" del iPhone: los mismos métodos que Java le da al backend en Android (android/app/java/…/Bridge.java),
 * hechos con APIs de WebKit. Así src/android/backend (proyectos, timelines, plantillas, fotogramas, exportación,
 * herramientas de Claude) corre igual en el teléfono, sin PC.
 *
 *   archivos → WebFS                 video → WebCodecs + Mediabunny (encoder.ts)     audio → Mediabunny + Web Audio (audio.ts)
 *   zip → fflate                     claves → cifradas con WebCrypto (secrets.ts)
 *
 * Dos formas: dentro de la app nativa (ios/, `native`), los archivos van al disco del iPhone y lo que sólo hace iOS
 * (elegir fotos y archivos, compartir, guardar en Fotos, la pantalla encendida) lo hace la app (native.ts); como app
 * web en Safari, OPFS y las APIs del navegador.
 *
 * La captura de la exportación (cap.*) y los fotogramas para Claude (snap.*) los hace la app con vistas web propias
 * (NativeCapture.swift, NativeSnap.swift); en Safari no hay: el backend pasa solo al método compatible (el compositor
 * redibuja cada fotograma).
 */
import type { Host, DeviceInfo, AsyncOpts } from '../../android/host'
import { WebFS } from './webfs'
import { nativeCall } from './native'
import { Secrets } from './secrets'
import * as Enc from './encoder'
import * as Aud from './audio'
import * as Zip from './zip'

export type WebHost = Host & { fs: WebFS; base: string; secrets: Secrets; native: boolean; stageFiles: (files: File[]) => Promise<Array<{ path: string; name: string; size: number; mime: string }>> }

const asOpts = (o?: AsyncOpts | ((e: any) => void)): AsyncOpts => (typeof o === 'function' ? { onEvent: o } : o || {})
const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/')
const rid = () => Math.random().toString(36).slice(2, 10)

/** Lo que informa la app nativa (Bridge.swift, op "info"). */
type NativeInfo = { model: string; name: string; system: string; app: string; build: string; memory: number; free: number; total: number; scale: number }

function deviceInfo(n: NativeInfo | null): DeviceInfo {
  const ua = navigator.userAgent
  const ios = /OS (\d+)[_.](\d+)/.exec(ua)
  const safari = /Version\/([\d.]+)/.exec(ua)?.[1] || ''
  const release = n?.system || (ios ? `${ios[1]}.${ios[2]}` : '')
  return {
    platform: 'android', sdk: 0, release, manufacturer: 'Apple', brand: 'Apple', model: n?.name || (/iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : 'Navegador'), device: n?.model || '', soc: '',
    versionName: n?.app || (globalThis as any).__OA_VERSION__ || '0.1.0', versionCode: +(n?.build || 1), abi: 'arm64', webview: n ? `WebKit · iOS ${release}` : safari ? `Safari ${safari}` : ua,
    density: devicePixelRatio || 1, screenWidth: screen.width, screenHeight: screen.height, memory: n?.memory || ((navigator as any).deviceMemory || 8) * 1024 ** 3, dataDir: n ? 'Documentos' : 'OPFS',
  }
}

/** Orígenes de la app nativa: la interfaz y los proyectos (otro origen: una escena no puede tocar la app). */
const APP_ORIGIN = 'oa://localhost', PROJECT_ORIGIN = 'oaproj://localhost'

export async function createWebHost(base: string, native = false): Promise<WebHost> {
  const fs = new WebFS()
  await fs.open(native ? { native: APP_ORIGIN } : {})
  const secrets = new Secrets(fs)
  await secrets.load()
  const caps = await Enc.codecCaps()
  const listeners = new Map<string, Set<(d: any) => void>>()
  const emit = (name: string, data?: any) => listeners.get(name)?.forEach((cb) => { try { cb(data) } catch (e) { console.error(e) } })
  let info: NativeInfo | null = null
  let estimate = { free: 0, total: 0 }
  let refreshEstimate: () => void
  if (native) {
    // Eventos de la app (pause, resume, memory): los manda WebViewController.emit.
    ;(window as any).__oaNativeEvent = (name: string, data: unknown) => emit(name, data)
    refreshEstimate = () => { nativeCall<NativeInfo>('info').then((i) => { info = i; estimate = { free: i.free, total: i.total } }).catch(() => {}) }
    info = await nativeCall<NativeInfo>('info').catch(() => null)
    if (info) estimate = { free: info.free, total: info.total }
  } else {
    document.addEventListener('visibilitychange', () => emit(document.hidden ? 'pause' : 'resume'))
    refreshEstimate = () => { navigator.storage?.estimate?.().then((e) => { estimate = { free: Math.max(0, (e.quota || 0) - (e.usage || 0)), total: e.quota || 0 } }).catch(() => {}) }
    refreshEstimate()
    // Que Safari no borre los datos por falta de espacio (en la app de la pantalla de inicio ya es así).
    navigator.storage?.persist?.().catch(() => {})
  }
  let wake: any = null
  const origin = native ? APP_ORIGIN : location.origin + base.replace(/\/$/, '')

  /** Archivos elegidos por el usuario → .incoming/<id>/ (como Java), sin pasar por memoria. */
  async function stageFiles(files: File[]) {
    const id = rid()
    const out: Array<{ path: string; name: string; size: number; mime: string }> = []
    for (const f of files) {
      const name = f.name.replace(/[\\/:*?"<>|]+/g, '-') || 'archivo'
      const path = `.incoming/${id}/${name}`
      await fs.writeBlob(path, f)
      out.push({ path, name, size: f.size, mime: f.type })
    }
    return out
  }
  function pickFiles(accept: string[], multiple: boolean): Promise<File[]> {
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = multiple
      if (accept?.length) input.accept = accept.join(',')
      input.style.cssText = 'position:fixed;left:-9999px;top:0'
      input.onchange = () => { resolve([...(input.files || [])]); input.remove() }
      input.addEventListener('cancel', () => { resolve([]); input.remove() })
      document.body.appendChild(input)
      input.click()
    })
  }
  /** Elegir archivos: en la app, los selectores de iOS (Fotos o Archivos) los copian directo a .incoming. */
  async function pick(accept: string[], multiple: boolean) {
    if (!native) return stageFiles(await pickFiles(accept, multiple))
    const files = await nativeCall<Array<{ path: string; name: string; size: number; mime: string }>>('pick', { accept, multiple })
    for (const f of files) fs.noteFile(f.path, f.size)
    return files
  }
  /** Hoja de Compartir de iOS con el archivo (Guardar video / Guardar en Archivos / AirDrop…). */
  async function share(path: string, name?: string, mime?: string, title?: string) {
    if (native) { await fs.flush(); await nativeCall('share', { path }); return true }
    const blob = await fs.fileBlob(path)
    const file = new File([blob], name || path.split('/').pop()!, { type: mime || blob.type || guessMime(path) })
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title })
      return true
    }
    const a = document.createElement('a')
    a.href = URL.createObjectURL(file); a.download = file.name
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 60000)
    return true
  }

  const sync: Record<string, (a: any) => any> = {
    'app.info': () => deviceInfo(info),
    'app.toast': (a) => { window.dispatchEvent(new CustomEvent('oa-toast', { detail: String(a.text || '') })); return true },
    'app.immersive': () => true, 'app.debug': () => true, 'app.openSettings': () => true, 'app.takePendingOpen': () => null, 'app.exits': () => [],
    'app.openUrl': (a) => { if (native) void nativeCall('openUrl', { url: String(a.url) }); else window.open(String(a.url), '_blank', 'noopener'); return true },
    'app.keepScreenOn': (a) => {
      if (native) { void nativeCall('awake', { on: !!a.on }); return true }
      // Pantalla encendida mientras se exporta o Claude trabaja (si se apaga, iOS pausa la página).
      if (a.on && !wake) (navigator as any).wakeLock?.request('screen').then((w: any) => { wake = w }).catch(() => {})
      if (!a.on && wake) { wake.release?.(); wake = null }
      return true
    },
    'codec.caps': () => caps,
    'clipboard.text': (a) => { if (native) void nativeCall('clipboard.text', { text: String(a.text || '') }); else navigator.clipboard?.writeText(String(a.text || '')).catch(() => {}); return true },
    'secrets.masked': (a) => secrets.masked(a.name), 'secrets.set': (a) => { secrets.set(a.name, a.value || ''); return true }, 'secrets.list': (a) => Object.fromEntries(((a.names as string[]) || secrets.names()).map((n) => [n, secrets.masked(n)])),
    'storage.info': () => { refreshEstimate(); return { internal: estimate, newProjects: 'internal', missing: 0, cardLabel: '' } },
    'storage.setNew': () => true, 'storage.cancel': () => true,
    'termux.status': () => ({ installed: false, permission: false }),
    'fs.exists': (a) => fs.exists(a.path), 'fs.stat': (a) => fs.stat(a.path), 'fs.list': (a) => fs.list(a.path), 'fs.walk': (a) => fs.walk(a.path, a),
    'fs.readText': (a) => fs.readText(a.path), 'fs.readTextLimited': (a) => fs.readTextLimited(a.path, a.max), 'fs.writeText': (a) => { fs.writeText(a.path, a.text); return true },
    'fs.writeBase64': (a) => { fs.writeBase64(a.path, a.data, !!a.append); return true }, 'fs.mkdir': (a) => { fs.mkdir(a.path); return true }, 'fs.volume': () => 'internal',
    'fs.delete': (a) => fs.delete(a.path), 'fs.rename': (a) => { fs.rename(a.from, a.to); return true }, 'fs.copy': (a) => { fs.copy(a.from, a.to); return true }, 'fs.du': (a) => fs.du(a.path),
    'enc.start': (a) => Enc.start(fs, a), 'enc.cancel': () => { Enc.cancel(); return true }, 'enc.fallback': () => Enc.fallback(),
    // La captura de la exportación en la app (ios/OpenAnimator/NativeCapture.swift): los fotogramas van solos al codificador.
    'cap.available': () => native, 'cap.close': () => { if (native) void nativeCall('cap.close').catch(() => {}); return true },
    // Whisper en el iPhone (ios/OpenAnimator/LocalWhisper.swift, WhisperKit): sólo en la app.
    'whisper.available': () => native,
    'snap.close': () => { if (native) void nativeCall('snap.close').catch(() => {}); return true },
  }
  /** Una operación de Whisper en Swift; su avance (evento nativo "whisper") va al que la pidió. */
  const whisper = (op: string) => async (a: any, emitEvent: (e: any) => void) => {
    if (!native) throw unavailable('Whisper local')
    if (op === 'whisper.transcribe') await fs.flush() // el archivo tiene que estar en el disco
    const off = host.onEvent('whisper', emitEvent)
    try { return await nativeCall(op, a) } finally { off() }
  }
  const async: Record<string, (a: any, emitEvent: (e: any) => void, o: AsyncOpts) => Promise<any>> = {
    'fs.delete': async (a) => fs.delete(a.path), 'fs.copy': async (a) => { fs.copy(a.from, a.to); await fs.flush(); return true }, 'fs.du': async (a) => fs.du(a.path),
    'pick.files': async (a) => pick(a.accept || [], a.multiple !== false),
    'file.share': async (a) => share(a.path, a.name, a.mime, a.title),
    'file.toPc': async (a) => { if (!native) throw new Error('Sólo en la app'); await fs.flush(); return nativeCall('log.upload', { path: a.path, name: a.name }) },
    'file.save': async (a) => ({ saved: await share(a.path, a.name, a.mime) }),
    // En la app va directo a Fotos (pide permiso la primera vez); en Safari, la hoja de Compartir (Guardar video).
    'gallery.save': async (a) => {
      if (native) { await fs.flush(); return nativeCall('photos.save', { path: a.path }) }
      await share(a.path, a.name, a.mime || 'video/mp4'); return { folder: 'Fotos' }
    },
    'file.open': async (a) => {
      if (native) { await fs.flush(); return nativeCall('open', { path: a.path }) }
      const b = await fs.fileBlob(a.path); window.open(URL.createObjectURL(new Blob([b], { type: guessMime(a.path) })), '_blank'); return true
    },
    'clipboard.image': async (a) => { const b = await fs.fileBlob(a.path); await navigator.clipboard.write([new ClipboardItem({ [b.type || 'image/png']: b })]); return true },
    'http.request': async (a, ev, o) => httpRequest(fs, secrets, a, ev, o.signal),
    'zip.import': async (a, ev) => Zip.unzipTo(fs, a.zip, a.dest, ev), 'zip.export': async (a, ev) => Zip.zipDir(fs, a.dir, a.out, a.prefix, a.skip, ev),
    'audio.peaks': async (a) => Aud.peaks(fs, a.path, a.perSec || 100), 'audio.decode': async (a) => Aud.decodePcm(fs, a),
    'cap.start': async (a) => nativeCall('cap.start', { url: a.url, width: a.width, height: a.height, workers: a.workers, prefs: a.prefs }),
    'cap.frame': async (a) => nativeCall('cap.frame', { t: a.t, i: a.i, preview: !!a.preview }), 'cap.stop': async () => nativeCall('cap.stop'),
    // Los fotogramas para Claude (ios/OpenAnimator/NativeSnap.swift): el compositor lee el proyecto del disco.
    'snap.open': async (a) => { if (!native) throw unavailable('snap.open'); await fs.flush(); return nativeCall('snap.open', { url: a.url, width: a.width, height: a.height }) },
    'snap.reload': async () => { await fs.flush(); return nativeCall('snap.reload') },
    'snap.frame': async (a) => nativeCall('snap.frame', { t: a.t, width: a.width, format: a.format, quality: a.quality, cost: !!a.cost }),
    'enc.frame': async (a) => Enc.frame(a), 'enc.frames': async () => Enc.frames(), 'enc.mix': async (a, ev) => Enc.mix(fs, a, ev), 'enc.finish': async () => Enc.finish(fs),
    ...Object.fromEntries(['status', 'install', 'remove', 'transcribe', 'test'].map((k) => [`whisper.${k}`, whisper(`whisper.${k}`)])),
  }
  const unavailable = (m: string) => new Error(`${m} no está disponible en el iPhone`)
  const host: WebHost = {
    kind: 'web', appOrigin: origin, projectOrigin: native ? PROJECT_ORIGIN : origin, info: deviceInfo(info), fs, base, secrets, stageFiles, native,
    call(method, args = {}) {
      const fn = sync[method]
      if (!fn) throw unavailable(method)
      return fn(args)
    },
    async callAsync(method, args = {}, opts) {
      const o = asOpts(opts)
      if (o.signal?.aborted) throw new DOMException('Cancelado', 'AbortError')
      const fn = async[method]
      if (!fn) throw unavailable(method)
      return fn(args, (e) => o.onEvent?.(e), o)
    },
    onEvent(name, cb) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name)!.add(cb)
      return () => { listeners.get(name)?.delete(cb) }
    },
    fsUrl: (path) => `${origin}/fs/${encPath(path)}`,
  }
  return host
}

const MIME: Record<string, string> = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/mp4', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', html: 'text/html', htm: 'text/html', json: 'application/json', md: 'text/markdown', txt: 'text/plain', pdf: 'application/pdf', zip: 'application/zip', css: 'text/css', js: 'text/javascript' }
export const guessMime = (p: string) => MIME[(p.split('.').pop() || '').toLowerCase()] || 'application/octet-stream'

/**
 * http.request del puente (plugins por API: OpenAI, Gemini, ElevenLabs…): fetch del navegador. Las claves viajan como
 * {{secret:NOMBRE}} y se reemplazan acá, sólo en encabezados y sólo hacia el servicio de esa clave (como en Java).
 */
const SECRET_HOSTS: Record<string, RegExp> = {
  'plugin.openai': /^api\.openai\.com$/, 'plugin.gemini': /^generativelanguage\.googleapis\.com$/, 'plugin.openrouter': /^openrouter\.ai$/,
  'plugin.elevenlabs': /^api\.elevenlabs\.io$/, 'plugin.fish': /^api\.fish\.audio$/, claude: /^api\.anthropic\.com$/,
}
async function httpRequest(fs: WebFS, secrets: Secrets, a: any, ev: (e: any) => void, signal?: AbortSignal) {
  const url = String(a.url)
  if (!/^https:\/\//.test(url)) throw new Error('URL inválida')
  const hostName = new URL(url).hostname
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(a.headers || {})) {
    headers[k] = String(v).replace(/\{\{secret:([\w.-]+)\}\}/g, (_, name) => {
      if (!SECRET_HOSTS[name]?.test(hostName)) throw new Error(`La clave ${name} no se puede mandar a ${hostName}`)
      return secrets.get(name) || ''
    })
  }
  let body: BodyInit | undefined
  if (a.body) body = a.body.type === 'base64' ? Uint8Array.from(atob(a.body.data), (c) => c.charCodeAt(0)) : a.body.type === 'file' ? await fs.fileBlob(a.body.path) : String(a.body.data)
  const ac = new AbortController()
  signal?.addEventListener('abort', () => ac.abort(), { once: true })
  const timer = a.timeoutMs ? setTimeout(() => ac.abort(), a.timeoutMs) : 0
  try {
    const r = await fetch(url, { method: a.method || 'GET', headers, body, signal: ac.signal })
    const hs: Record<string, string> = {}
    r.headers.forEach((v, k) => { hs[k] = v })
    if (a.saveTo && r.ok) { const blob = await r.blob(); await fs.writeBlob(a.saveTo, blob); return { status: r.status, headers: hs, size: blob.size } }
    if (a.stream) {
      ev({ event: 'head', status: r.status, headers: hs })
      const dec = new TextDecoder()
      const reader = r.body!.getReader()
      for (;;) { const { done, value } = await reader.read(); if (done) break; ev({ event: 'chunk', text: dec.decode(value, { stream: true }) }) }
      return { status: r.status, headers: hs }
    }
    return { status: r.status, headers: hs, text: await r.text() }
  } finally { clearTimeout(timer) }
}
