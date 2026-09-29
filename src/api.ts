// Tipos compartidos y acceso al proceso principal.
export type Clip = { id: string; src: string; start: number; duration: number; in?: number; volume?: number; muted?: boolean; fadeIn?: number; fadeOut?: number; fit?: string; name?: string }
export type TrackType = 'scene' | 'video' | 'audio'
export type Track = { id: string; name: string; type: TrackType; clips: Clip[]; muted?: boolean; solo?: boolean; hidden?: boolean; volume?: number; locked?: boolean }
export type Note = { id: string; t: number; text: string }
export type Timeline = { format: 'oa-timeline/1'; duration: number; tracks: Track[]; notes?: Note[]; rev?: number }
export type TimelineRef = { id: string; name: string; file: string }
export type Project = { format: 'openanimator/1'; id: string; name: string; width: number; height: number; fps: number; background?: string; timelines: TimelineRef[]; activeTimeline: string; template?: string; updatedAt?: string }
export type ProjectSummary = { id: string; name: string; width: number; height: number; fps: number; timelines: number; duration: number; updatedAt?: string; thumb?: string }
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
  claude: { permissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'; model: string; effort: Effort | ''; extraInstructions: string; saver: boolean; showThinking: boolean; showCost: boolean; autoAttachFrame: boolean; claudePath: string }
  export: Partial<ExportSettings>
  exportPrefs: { defaultDir: string; openFolderWhenDone: boolean; notify: boolean }
  plugins: PluginSettings
  lastExportDir?: string
  lastProject?: string
}
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
export type SettingsPatch = { [K in keyof Settings]?: Settings[K] extends object ? { [J in keyof Settings[K]]?: Settings[K][J] extends object ? Partial<Settings[K][J]> : Settings[K][J] } : Settings[K] }

export type ChatItem = { id: string; kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'permission' | 'result' | 'notice'; text?: string; name?: string; input?: any; status?: string; result?: string; isError?: boolean; requestId?: string; images?: number; files?: string[]; cost?: number; durationMs?: number; level?: string }
export type ChatEvent = { session: string; type: 'item' | 'patch' | 'state'; item?: Partial<ChatItem> & { id: string }; state?: { busy: boolean; alive: boolean; sessionId?: string; model?: string; effort?: string; permissionMode?: string; stats?: ChatStats } }
export type ChatStats = { context: number; window: number; cost: number; turns: number; compactions: number; output: number }

declare global {
  interface Window { oa: { call: (ch: string, ...a: unknown[]) => Promise<any>; on: (ch: string, cb: (p: any) => void) => () => void; pathForFile: (f: File) => string } }
}

export const call = <T = any>(ch: string, ...a: unknown[]): Promise<T> => window.oa.call(ch, ...a)
export const on = (ch: string, cb: (p: any) => void) => window.oa.on(ch, cb)

export const fileUrl = (projectId: string, rel: string) => `oa://p/${encodeURIComponent(projectId)}/` + rel.split('/').map(encodeURIComponent).join('/')

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
export const MODELS: Array<{ id: string; name: string; desc: string; note?: string }> = [
  { id: '', name: 'Predeterminado', desc: 'El modelo configurado en tu cuenta de Claude Code' },
  { id: 'claude-opus-5-5', name: 'Opus 5.5', desc: 'El más capaz: dirección artística y escenas complejas' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', desc: 'Rápido y muy capaz para el trabajo diario' },
  { id: 'claude-haiku-4-5', name: 'Haiku 4.5', desc: 'El más rápido, para cambios chicos' },
  { id: 'claude-fable-5-1', name: 'Fable 5.1', desc: 'Frontera de capacidad', note: 'requiere créditos de uso' },
]
export const EFFORTS: Array<{ id: Effort | ''; name: string; desc: string; bars: number }> = [
  { id: '', name: 'Automático', desc: 'Lo decide Claude Code', bars: 0 },
  { id: 'low', name: 'Bajo', desc: 'Respuestas rápidas, poco razonamiento', bars: 1 },
  { id: 'medium', name: 'Medio', desc: 'Equilibrio entre velocidad y calidad', bars: 2 },
  { id: 'high', name: 'Alto', desc: 'Piensa más antes de actuar', bars: 3 },
  { id: 'xhigh', name: 'Muy alto', desc: 'Para escenas y videos complejos', bars: 4 },
  { id: 'max', name: 'Máximo', desc: 'El más lento y cuidadoso', bars: 5 },
]
export const modelName = (id?: string) => MODELS.find((m) => m.id === (id || ''))?.name || id || 'Predeterminado'
