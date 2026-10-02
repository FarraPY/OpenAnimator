// Tipos compartidos y acceso al proceso principal.
import { isAndroid, projectUrl } from './platform'

export type Clip = { id: string; src: string; start: number; duration: number; in?: number; volume?: number; muted?: boolean; fadeIn?: number; fadeOut?: number; fit?: string; name?: string
  /** Opacidad del clip visual (0-1); speed: sólo escenas, velocidad de su tiempo interno (compositor.js). */
  opacity?: number; speed?: number }
export type TrackType = 'scene' | 'video' | 'audio'
export type Track = { id: string; name: string; type: TrackType; clips: Clip[]; muted?: boolean; solo?: boolean; hidden?: boolean; volume?: number; locked?: boolean }
export type Note = { id: string; t: number; text: string }
export type Timeline = { format: 'oa-timeline/1'; duration: number; tracks: Track[]; notes?: Note[]; rev?: number }
export type TimelineRef = { id: string; name: string; file: string }
export type Project = { format: 'openanimator/1'; id: string; name: string; width: number; height: number; fps: number; background?: string; timelines: TimelineRef[]; activeTimeline: string; template?: string; updatedAt?: string }
/** `volume` (Android): 'sd' si el proyecto está en la tarjeta SD. */
export type ProjectSummary = { id: string; name: string; width: number; height: number; fps: number; timelines: number; duration: number; updatedAt?: string; thumb?: string; volume?: 'internal' | 'sd' }
export type Template = { id: string; name: string; description: string; defaults?: { duration: number }; preview?: string; user?: boolean; createdAt?: string; width?: number; height?: number; fps?: number; tags?: string[]; hasAnalysis?: boolean; fromProject?: string }
export type Asset = { path: string; name: string; kind: 'scene' | 'video' | 'audio' | 'image' | 'doc' | 'other'; size: number; mtime?: number }

export type VCodec = 'h264_nvenc' | 'hevc_nvenc' | 'av1_nvenc' | 'libx264' | 'libx265'
export type ExportSettings = {
  width: number; height: number; fps: number
  vcodec: VCodec; preset: string; tune: 'hq' | 'uhq' | 'll' | 'ull' | 'lossless'
  rc: 'cq' | 'vbr' | 'cbr' | 'cqp' | 'size' | 'lossless'
  cq: number; qp: number; bitrate: number; maxrate: number; targetMB: number
  multipass: 'disabled' | 'qres' | 'fullres'
  pixfmt: 'yuv420p' | 'p010le' | 'yuv422p' | 'p210le' | 'yuv444p'
  bframes: number; gopSec: number; lookahead: number; spatialAQ: boolean; temporalAQ: boolean; aqStrength: number
  color: 'bt709' | 'bt601' | 'none'; range: 'tv' | 'pc'
  container: 'mp4' | 'mkv' | 'mov' | 'webm'
  acodec: 'aac' | 'libopus' | 'libmp3lame' | 'ac3' | 'flac' | 'pcm_s16le' | 'pcm_s24le' | 'none'
  abitrate: number; arate: number; achannels: 0 | 1 | 2 | 6; volumeDb: number; loudnorm: boolean; lufs: number
  faststart: boolean; title: string; workers: number; segmentSec: number
}
export type ExportProgress = { id: string; phase: string; message: string; done: number; total: number; fps?: number; eta?: number; elapsed?: number; file?: string }
export type AppInfo = { version: string; dataDir: string; projectsDir: string; portable: boolean; claude: string | null; ffmpeg: string; gpu: string; encoders: Record<string, boolean> }
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Settings = {
  ui: { accent: 'violet' | 'blue' | 'teal' | 'green' | 'amber' | 'rose'; density: 'comfortable' | 'compact'; reduceMotion: boolean; openLastProject: boolean; confirmDelete: boolean; homeView: 'grid' | 'list'; homeSort: 'recent' | 'name' | 'duration' }
  editor: { snap: boolean; snapFrames: boolean; followPlayhead: boolean; waveforms: boolean; imageDuration: number; defaultZoom: number; stageBg: 'dark' | 'black' | 'gray' | 'checker'; safeAreas: boolean; thirds: boolean; showChat: boolean }
  claude: {
    permissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'; model: string; effort: Effort | ''; extraInstructions: string; saver: boolean; showThinking: boolean; showCost: boolean; autoAttachFrame: boolean; continueChat?: boolean; claudePath: string; autoUpdate?: boolean
    /** Sólo en Android: con el plan del usuario (Claude Code en Termux) o con una clave de la API. */
    backend?: 'termux' | 'api'
  }
  export: Partial<ExportSettings>
  exportPrefs: { defaultDir: string; openFolderWhenDone: boolean; notify: boolean }
  plugins: PluginSettings
  lastExportDir?: string
  lastProject?: string
  /** Sólo en Android. */
  android?: AndroidPrefs
  androidExport?: AndroidExport
}
export type AndroidPrefs = { immersive: boolean; uiScale: number; debug: boolean; saveToGallery: boolean; keepAwake: boolean }
export type AndroidExport = { codec: 'avc' | 'hevc'; quality: 'low' | 'medium' | 'high' | 'max'; bitrate: number; height: number; fps: number; audio: boolean; audioBitrate: number }
export type PluginSettings = {
  image: 'auto' | 'codex' | 'openai' | 'gemini'; voice: 'auto' | 'elevenlabs' | 'fish'; ask: 'auto' | 'codex' | 'openai' | 'gemini' | 'openrouter'; transcribe: 'auto' | 'whisper' | 'elevenlabs' | 'openai' | 'fish'
  codex: { enabled: boolean; path: string; model: string }
  openai: { enabled: boolean; chatModel: string; imageModel: string; imageQuality: 'low' | 'medium' | 'high' | 'auto' }
  gemini: { enabled: boolean; chatModel: string; imageModel: string }
  openrouter: { enabled: boolean; chatModel: string }
  elevenlabs: { enabled: boolean; voiceId: string; voiceName: string; modelId: string; stability: number; similarity: number; style: number; speed: number }
  fish: { enabled: boolean; voiceId: string; voiceName: string; model: string; temperature: number; topP: number; speed: number; volume: number; latency: 'normal' | 'balanced' | 'low'; v?: number }
  whisper: { enabled: boolean; python: string; model: string; device: 'auto' | 'cuda' | 'cpu' }
  ytdlp: { path: string }
}
export type PluginId = 'codex' | 'openai' | 'gemini' | 'openrouter' | 'elevenlabs' | 'fish' | 'whisper' | 'ytdlp'
export type PluginStatus = { id: PluginId; name: string; ready: boolean; enabled: boolean; detail: string; masked?: string; caps: string[]; needsKey: boolean }
export type Voice = { id: string; name: string; desc?: string; preview?: string; lang?: string }
export type Attachment = { rel: string; name: string; size: number; image?: string }

/** Parche anidado de ajustes (cada sección parcial). */
type NN<T> = NonNullable<T>
export type SettingsPatch = { [K in keyof Settings]?: NN<Settings[K]> extends object ? { [J in keyof NN<Settings[K]>]?: NN<Settings[K]>[J] extends object ? Partial<NN<Settings[K]>[J]> : NN<Settings[K]>[J] } : Settings[K] }

export type ChatItem = { id: string; kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'permission' | 'result' | 'notice'; text?: string; name?: string; input?: any; status?: string; result?: string; isError?: boolean; requestId?: string; images?: number; files?: string[]; cost?: number; durationMs?: number; level?: string; tokens?: number; streamed?: number; at?: number; queued?: boolean; midTurn?: boolean; parent?: string }
export type ChatEvent = { session: string; type: 'item' | 'patch' | 'remove' | 'state'; item?: Partial<ChatItem> & { id: string }; state?: { busy: boolean; alive: boolean; sessionId?: string; model?: string; effort?: string; permissionMode?: string; stats?: ChatStats; signalAt?: number; tasks?: number } }
export type ChatStats = { context: number; window: number; cost: number; turns: number; compactions: number; output: number }

declare global {
  interface Window { oa: { call: (ch: string, ...a: unknown[]) => Promise<any>; on: (ch: string, cb: (p: any) => void) => () => void; pathForFile: (f: File) => string } }
}

export const call = <T = any>(ch: string, ...a: unknown[]): Promise<T> => window.oa.call(ch, ...a)
export const on = (ch: string, cb: (p: any) => void) => window.oa.on(ch, cb)
/**
 * Corre fn después de que se pinte lo que ya está en pantalla; devuelve cómo cancelarlo. Para cargar los datos
 * de una pantalla nueva sin demorarla: tras un toque, React corre los efectos antes de pintar y, en la tablet,
 * cada llamada sincrónica a Java se sumaba a la espera (~1 s al entrar a un proyecto o a Ajustes).
 */
export function afterPaint(fn: () => void): () => void {
  let done = false, t = 0
  const run = () => { if (done) return; done = true; clearTimeout(backup); fn() }
  const raf = requestAnimationFrame(() => { t = window.setTimeout(run, 0) })
  // Con la página oculta (la app en segundo plano) no se pinta ni corre requestAnimationFrame: igual se carga.
  const backup = window.setTimeout(run, 300)
  return () => { done = true; cancelAnimationFrame(raf); clearTimeout(t); clearTimeout(backup) }
}

export const fileUrl = (projectId: string, rel: string) => projectUrl(projectId, rel)

export function fmtTime(sec: number, withFrames = false, fps = 30) {
  if (!isFinite(sec)) sec = 0
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = Math.floor(s % 60)
  const base = `${h ? h + ':' : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(x).padStart(2, '0')}`
  if (!withFrames) return base
  return `${base}.${String(Math.floor((s % 1) * fps)).padStart(2, '0')}`
}
export const fmtSize = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`)
export const uid = (p = 'c') => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** Modelos de Claude que se pueden elegir desde el chat (IDs verificados con Claude Code). */
const PC_MODELS: Array<{ id: string; name: string; desc: string; note?: string }> = [
  { id: '', name: 'Predeterminado', desc: 'El modelo configurado en tu cuenta de Claude Code' },
  { id: 'claude-opus-5-5', name: 'Opus 5.5', desc: 'El más capaz: dirección artística y escenas complejas' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', desc: 'Rápido y muy capaz para el trabajo diario' },
  { id: 'claude-haiku-4-5', name: 'Haiku 4.5', desc: 'El más rápido, para cambios chicos' },
  { id: 'claude-fable-5-1', name: 'Fable 5.1', desc: 'Frontera de capacidad', note: 'requiere créditos de uso' },
]
/** En Android el chat usa la API de Claude (clave propia, se cobra por uso). Precios en US$ por millón de tokens. */
const ANDROID_MODELS: Array<{ id: string; name: string; desc: string; note?: string }> = [
  { id: 'claude-opus-5-5', name: 'Opus 5.5', desc: 'El más capaz: dirección artística y escenas complejas', note: '4 / 20' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', desc: 'Rápido y muy capaz, a mitad de precio', note: '2 / 10' },
  { id: 'claude-haiku-4-5', name: 'Haiku 4.5', desc: 'El más rápido y económico, para cambios chicos', note: '1 / 5' },
  { id: 'claude-fable-5-1', name: 'Fable 5.1', desc: 'Frontera de capacidad, el más caro', note: '10 / 50' },
]
export const MODELS = isAndroid() ? ANDROID_MODELS : PC_MODELS
export const EFFORTS: Array<{ id: Effort | ''; name: string; desc: string; bars: number }> = [
  { id: '', name: 'Automático', desc: isAndroid() ? 'El nivel recomendado para el modelo' : 'Lo decide Claude Code', bars: 0 },
  { id: 'low', name: 'Bajo', desc: 'Respuestas rápidas, poco razonamiento', bars: 1 },
  { id: 'medium', name: 'Medio', desc: 'Equilibrio entre velocidad y calidad', bars: 2 },
  { id: 'high', name: 'Alto', desc: 'Piensa más antes de actuar', bars: 3 },
  { id: 'xhigh', name: 'Muy alto', desc: 'Para escenas y videos complejos', bars: 4 },
  { id: 'max', name: 'Máximo', desc: 'El más lento y cuidadoso', bars: 5 },
]
export const modelName = (id?: string) => MODELS.find((m) => m.id === (id || ''))?.name || id || 'Predeterminado'
