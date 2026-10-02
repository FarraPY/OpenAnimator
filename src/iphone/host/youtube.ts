/**
 * Bajar un video de YouTube para analizar su estilo («Crear plantilla desde un video»; en la PC lo hace yt-dlp).
 * youtubei.js (LuanRT/YouTube.js, MIT) le pide el video a YouTube como el cliente de visionOS, que entrega direcciones
 * directas sin «PO token» ni firmas para descifrar (es el que usa yt-dlp desde agosto de 2026); si falla, como el de
 * iOS. Todo lo de YouTube sale por la red de iOS (Bridge http.stream → NetStream.swift): desde la página no se puede
 * (CORS) y así van los encabezados que pone la librería. Los bytes del video los baja Swift directo a disco
 * (VideoAnalysis.swift vana.download, por tramos). Se baja hasta 720p en H.264 y el audio AAC aparte; para analizar no
 * hace falta juntarlos. Si el video trae subtítulos (español, si no inglés), también.
 */
import { b64decode, b64encode, nativeCall } from './native'

type OnEvent = (name: string, cb: (d: any) => void) => () => void
export type YtResult = { title: string; channel: string; duration: number; description: string; video: string; audio: string | null; subs: string | null; client: string }

/** fetch por la red de iOS, con la respuesta por partes (evento "net": head, chunk, end, error). */
export function nativeFetch(onEvent: OnEvent) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : null
    const url = req ? req.url : String(input)
    const method = (init?.method || req?.method || 'GET').toUpperCase()
    const headers: Record<string, string> = {}
    // Los de la librería vienen en init.headers (un Headers suelto: conserva User-Agent y Origin).
    if (req) req.headers.forEach((v, k) => { headers[k] = v })
    if (init?.headers) new Headers(init.headers).forEach((v, k) => { headers[k] = v })
    const raw = init?.body ?? (req && method !== 'GET' && method !== 'HEAD' ? await req.arrayBuffer() : null)
    let body = ''
    if (raw != null) {
      const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw instanceof ArrayBuffer ? new Uint8Array(raw)
        : ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(await new Response(raw as BodyInit).arrayBuffer())
      body = b64encode(bytes)
    }
    const id = 'yt' + Math.random().toString(36).slice(2)
    return new Promise<Response>((resolve, reject) => {
      let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null
      const stream = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c } })
      const off = onEvent('net', (ev) => {
        if (ev?.id !== id) return
        if (ev.type === 'head') {
          const empty = [101, 204, 205, 304].includes(ev.status)
          resolve(new Response(empty ? null : stream, { status: ev.status, headers: ev.headers }))
        } else if (ev.type === 'chunk') ctrl?.enqueue(b64decode(ev.data))
        else if (ev.type === 'end') { off(); ctrl?.close() }
        else if (ev.type === 'error') {
          off()
          const e = new Error(ev.message || 'Error de red')
          reject(e)
          try { ctrl?.error(e) } catch { /* ya cerrado */ }
        }
      })
      init?.signal?.addEventListener('abort', () => { void nativeCall('http.cancel', { id }).catch(() => {}) })
      nativeCall('http.stream', { id, url, method, headers, body }).catch((e) => { off(); reject(e) })
    })
  }
}

/** El id de un enlace de YouTube (watch?v=, youtu.be/, shorts/, embed/, live/), o null. */
export function videoId(link: string): string | null {
  let u: URL
  try { u = new URL(link.trim()) } catch { return null }
  const host = u.hostname.replace(/^(www|m|music)\./, '')
  const ok = (id: string | null | undefined) => (id && /^[\w-]{11}$/.test(id) ? id : null)
  if (host === 'youtu.be') return ok(u.pathname.split('/')[1])
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null
  if (u.searchParams.get('v')) return ok(u.searchParams.get('v'))
  const m = /^\/(shorts|embed|live|v)\/([\w-]{11})/.exec(u.pathname)
  return m ? ok(m[2]) : null
}

/** Qué decirle al usuario cuando YouTube no entrega el video. */
function why(status: string, reason: string) {
  if (/bot/i.test(reason)) return 'YouTube pide confirmar que no sos un robot desde esta red. Probá con otra red (wifi o datos) o más tarde, o bajá el video y elegilo como archivo.'
  if (status === 'LOGIN_REQUIRED') return `YouTube pide iniciar sesión para ver este video (${reason || 'restricción de edad o privado'}). Bajalo de otra forma y elegilo como archivo.`
  return `YouTube no entrega este video: ${reason || status}.`
}

/**
 * {url, dir, job}: baja el video (y el audio y los subtítulos) a `dir` (carpeta de datos). `ev` recibe el avance:
 * {phase: 'info'} y {phase: 'video' | 'audio', p}.
 */
export async function ytDownload(a: { url: string; dir: string; job: string }, ev: (e: any) => void, onEvent: OnEvent, writeText: (path: string, text: string) => void, noteFile: (path: string, size: number) => void): Promise<YtResult> {
  const id = videoId(a.url)
  if (!id) throw new Error('En el iPhone se pueden analizar enlaces de YouTube (watch, youtu.be o shorts). Para otros sitios, bajá el video y elegilo como archivo.')
  ev({ phase: 'info' })
  const nfetch = nativeFetch(onEvent)
  const { Innertube } = await import('youtubei.js/web')
  // Con la sesión de visitante que da YouTube (generada en el teléfono, VISIONOS pedía «confirmá que no sos un robot»).
  const yt = await Innertube.create({ fetch: nfetch, retrieve_player: false })
  let info: any = null, client = '', problem = ''
  for (const c of ['VISIONOS', 'IOS'] as const) {
    try {
      const i = await yt.getBasicInfo(id, { client: c })
      const st = i.playability_status
      if (st?.status !== 'OK') { problem ||= why(String(st?.status || ''), String(st?.reason || '')); continue }
      if (!(i.streaming_data?.adaptive_formats?.length || i.streaming_data?.formats?.length)) { problem ||= 'YouTube no dio formatos que se puedan bajar.'; continue }
      info = i; client = c
      break
    } catch (e: any) { problem ||= `YouTube no respondió: ${e?.message || e}` }
  }
  if (!info) throw new Error(problem || 'YouTube no entrega este video.')
  const all: any[] = [...(info.streaming_data?.formats || []), ...(info.streaming_data?.adaptive_formats || [])].filter((f) => f.url)
  const size = (f: any) => Number(f.content_length) || 0
  // Video: H.264 en MP4 (lo lee AVFoundation) de hasta 720p, el más grande; si no hay, el más chico de los que hay.
  const avc = all.filter((f) => f.has_video && /^video\/mp4/.test(f.mime_type) && /avc1/.test(f.mime_type))
  const video = avc.filter((f) => (f.height || 0) <= 720).sort((x, y) => (y.height || 0) - (x.height || 0))[0]
    || avc.sort((x, y) => (x.height || 0) - (y.height || 0))[0]
  if (!video) throw new Error('YouTube no dio el video en un formato que pueda leer el iPhone (H.264).')
  // Audio: AAC (el itag 140), el principal y sin compresión de rango dinámico; si el video ya lo trae, no hace falta.
  const aac = all.filter((f) => f.has_audio && !f.has_video && /^audio\/mp4/.test(f.mime_type))
  const audio = video.has_audio ? null : aac.sort((x, y) => Number(!!x.is_drc) - Number(!!y.is_drc) || Number(x.audio_track?.audio_is_default === false) - Number(y.audio_track?.audio_is_default === false) || (y.bitrate || 0) - (x.bitrate || 0))[0] || null
  const relay = (phase: string) => (e: any) => { if (e?.job === a.job && e.phase === phase) ev({ phase, p: e.p }) }
  const get = async (f: any, path: string, phase: string) => {
    const off = onEvent('vana', relay(phase))
    try {
      const r = await nativeCall<{ size: number }>('vana.download', { job: a.job, url: f.url, path, size: size(f), phase })
      noteFile(path, r.size)
      return path
    } finally { off() }
  }
  const out: YtResult = {
    title: info.basic_info?.title || 'Video de YouTube', channel: info.basic_info?.author || '', duration: info.basic_info?.duration || 0,
    description: info.basic_info?.short_description || '', video: '', audio: null, subs: null, client,
  }
  out.video = await get(video, `${a.dir}/source.mp4`, 'video')
  if (audio) out.audio = await get(audio, `${a.dir}/source-audio.m4a`, 'audio')
  // Subtítulos (español, si no inglés; los que piden «PO token» no se pueden bajar).
  const tracks: any[] = (info.captions?.caption_tracks || []).filter((t: any) => t.base_url && !/[?&]exp=xp[ev]/.test(t.base_url))
  const lang = (t: any) => String(t.language_code || '')
  const sub = tracks.find((t) => /^es/.test(lang(t)) && t.kind !== 'asr') || tracks.find((t) => /^es/.test(lang(t)))
    || tracks.find((t) => /^en/.test(lang(t)) && t.kind !== 'asr') || tracks.find((t) => /^en/.test(lang(t)))
  if (sub) {
    try {
      const r = await nfetch(sub.base_url + '&fmt=vtt')
      const text = r.ok ? await r.text() : ''
      if (/^WEBVTT/.test(text)) { out.subs = `${a.dir}/source.${lang(sub)}.vtt`; writeText(out.subs, text) }
    } catch { /* sin subtítulos: se transcribe */ }
  }
  return out
}
