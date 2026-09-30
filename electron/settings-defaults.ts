/**
 * Ajustes por defecto y su mezcla, sin dependencias de Node: los usan la PC (electron/settings.ts)
 * y la tablet (src/android/backend/settings.ts), así un ajuste nuevo aparece en las dos.
 */
import type { Settings } from './settings'

export const DEFAULTS: Settings = {
  ui: { accent: 'violet', density: 'comfortable', reduceMotion: false, openLastProject: false, confirmDelete: true, homeView: 'grid', homeSort: 'recent' },
  editor: { snap: true, snapFrames: true, followPlayhead: true, waveforms: true, imageDuration: 5, defaultZoom: 60, stageBg: 'dark', safeAreas: false, thirds: false, showChat: true },
  claude: { permissionMode: 'acceptEdits', model: '', effort: '', extraInstructions: '', saver: true, showThinking: true, showCost: true, autoAttachFrame: false, continueChat: true, claudePath: '' },
  export: {},
  exportPrefs: { defaultDir: '', openFolderWhenDone: false, notify: true },
  plugins: {
    image: 'auto', voice: 'auto', ask: 'auto', transcribe: 'auto',
    codex: { enabled: true, path: '', model: '' },
    openai: { enabled: true, chatModel: 'gpt-5', imageModel: 'gpt-image-1', imageQuality: 'high' },
    gemini: { enabled: true, chatModel: 'gemini-2.5-pro', imageModel: 'gemini-2.5-flash-image' },
    openrouter: { enabled: true, chatModel: 'openai/gpt-5' },
    elevenlabs: { enabled: true, voiceId: '', voiceName: '', modelId: 'eleven_multilingual_v2', stability: 0.5, similarity: 0.75, style: 0, speed: 1 },
    fish: { enabled: true, voiceId: '', voiceName: '', model: 's2.1-pro-free', temperature: 0.7, topP: 0.7, speed: 1, volume: 0, latency: 'normal', v: 2 },
    whisper: { enabled: true, python: '', model: 'openai/whisper-large-v3-turbo', device: 'auto' },
    ytdlp: { path: '' },
  },
}

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x)
/** Mezcla profunda de un parche sobre los ajustes (export se reemplaza entero). */
export function mergeSettings<T>(base: T, over: any): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : over) as T
  const out: any = { ...base }
  for (const k of Object.keys(over)) out[k] = isObj((base as any)[k]) && isObj(over[k]) && k !== 'export' ? mergeSettings((base as any)[k], over[k]) : over[k]
  return out
}
