/** Ajustes en Android: el mismo esquema que la PC (electron/settings.ts) más lo propio de la tablet. */
import type { Settings } from '../../api'
import { DEFAULTS as PC_DEFAULTS, mergeSettings } from '../../../electron/settings-defaults'
import { fs } from './fsx'
import { host } from '../host'

const FILE = 'settings.json'

/**
 * Los de la PC (electron/settings-defaults.ts) con lo propio de la tablet: Claude con el plan del
 * usuario (Claude Code en Termux) o por la API, sin Codex, Whisper con whisper.cpp en Termux (el
 * modelo es el nombre de whisper-install.sh) y las preferencias de pantalla y exportación.
 */
export const DEFAULTS: Settings = mergeSettings(structuredClone(PC_DEFAULTS) as Settings, {
  claude: { model: 'claude-opus-5-5', backend: 'termux' },
  plugins: { codex: { enabled: false }, whisper: { enabled: true, model: 'small' } },
  android: { immersive: true, uiScale: 1, debug: false, saveToGallery: true, keepAwake: true },
  androidExport: { codec: 'avc', quality: 'high', bitrate: 0, height: 0, fps: 0, audio: true, audioBitrate: 192 },
})
const merge = mergeSettings

let cache: Settings | null = null

export function getSettings(): Settings {
  if (cache) return structuredClone(cache)
  let raw: any
  try { raw = fs.readJSON(FILE) } catch { raw = {} }
  const f = raw?.plugins?.fish
  if (f && !f.v) { if (/^(s1|speech-1\.\d)$/.test(f.model || '')) f.model = 's2.1-pro-free'; f.v = 2 }
  // Antes Whisper no existía en la tablet (quedaba apagado y sin modelo): ahora arranca con los valores nuevos.
  const w = raw?.plugins?.whisper
  if (w && !/^(base|small|large-v3-turbo-q5_0)$/.test(w.model || '')) Object.assign(w, DEFAULTS.plugins.whisper)
  cache = merge(structuredClone(DEFAULTS), raw)
  // Por la API (Android) sólo valen los nombres completos: "Predeterminado" pasa a Opus 5.5. En el iPhone corre Claude
  // Code, que entiende los alias (opus, sonnet…): así sigue al modelo más nuevo.
  if (host().kind !== 'web' && (!cache.claude.model || !/^claude-/.test(cache.claude.model))) cache.claude.model = DEFAULTS.claude.model
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
