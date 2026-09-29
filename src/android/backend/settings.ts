/** Ajustes en Android: el mismo esquema que la PC (electron/settings.ts) más lo propio de la tablet. */
import type { Settings } from '../../api'
import { fs } from './fsx'

const FILE = 'settings.json'

export const DEFAULTS: Settings = {
  ui: { accent: 'violet', density: 'comfortable', reduceMotion: false, openLastProject: false, confirmDelete: true, homeView: 'grid', homeSort: 'recent' },
  editor: { snap: true, snapFrames: true, followPlayhead: true, waveforms: true, imageDuration: 5, defaultZoom: 60, stageBg: 'dark', safeAreas: false, thirds: false, showChat: true },
  // En Android no hay Claude Code: el chat usa la API de Claude con la clave del usuario.
  claude: { permissionMode: 'acceptEdits', model: 'claude-opus-5-5', effort: '', extraInstructions: '', saver: true, showThinking: true, showCost: true, autoAttachFrame: false, claudePath: '' },
  export: {},
  exportPrefs: { defaultDir: '', openFolderWhenDone: false, notify: true },
  plugins: {
    image: 'auto', voice: 'auto', ask: 'auto', transcribe: 'auto',
    codex: { enabled: false, path: '', model: '' },
    openai: { enabled: true, chatModel: 'gpt-5', imageModel: 'gpt-image-1', imageQuality: 'high' },
    gemini: { enabled: true, chatModel: 'gemini-2.5-pro', imageModel: 'gemini-2.5-flash-image' },
    openrouter: { enabled: true, chatModel: 'openai/gpt-5' },
    elevenlabs: { enabled: true, voiceId: '', voiceName: '', modelId: 'eleven_multilingual_v2', stability: 0.5, similarity: 0.75, style: 0, speed: 1 },
    fish: { enabled: true, voiceId: '', voiceName: '', model: 's2.1-pro-free', temperature: 0.7, topP: 0.7, speed: 1, volume: 0, latency: 'normal', v: 2 },
    whisper: { enabled: false, python: '', model: '', device: 'auto' },
    ytdlp: { path: '' },
  },
  android: { immersive: true, uiScale: 1, debug: false, saveToGallery: true, keepAwake: true },
  androidExport: { codec: 'avc', quality: 'high', bitrate: 0, height: 0, fps: 0, audio: true, audioBitrate: 192 },
}

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x)
function merge<T>(base: T, over: any): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : over) as T
  const out: any = { ...base }
  for (const k of Object.keys(over)) out[k] = isObj((base as any)[k]) && isObj(over[k]) && k !== 'export' ? merge((base as any)[k], over[k]) : over[k]
  return out
}

let cache: Settings | null = null

export function getSettings(): Settings {
  if (cache) return structuredClone(cache)
  let raw: any
  try { raw = fs.readJSON(FILE) } catch { raw = {} }
  const f = raw?.plugins?.fish
  if (f && !f.v) { if (/^(s1|speech-1\.\d)$/.test(f.model || '')) f.model = 's2.1-pro-free'; f.v = 2 }
  cache = merge(structuredClone(DEFAULTS), raw)
  // Claude Code y sus modelos no existen en Android: "Predeterminado" pasa a Opus 5.5.
  if (!cache.claude.model || !/^claude-/.test(cache.claude.model)) cache.claude.model = DEFAULTS.claude.model
  return structuredClone(cache)
}

/** Aplica un parche parcial (anidado) y guarda. */
export function setSettings(patch: any): Settings {
  const s = merge(getSettings(), patch)
  fs.writeJSON(FILE, s)
  cache = s
  return structuredClone(s)
}

export function resetSettings(): Settings {
  fs.writeJSON(FILE, DEFAULTS)
  cache = structuredClone(DEFAULTS)
  return structuredClone(DEFAULTS)
}

/** Notas del usuario para la IA (las lee Claude en cada proyecto). */
export const NOTES_FILE = 'NOTAS-IA.md'
export function ensureNotes() {
  if (!fs.exists(NOTES_FILE)) fs.writeText(NOTES_FILE, '# Notas para la IA\n\nEscribí acá tus preferencias (voz, estilo, colores, idioma…). Claude las lee en cada proyecto.\n')
}
