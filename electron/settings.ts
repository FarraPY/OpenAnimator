import fs from 'node:fs'
import path from 'node:path'
import { APP_DIR, DATA_DIR, SETTINGS_FILE } from './paths'
import { DEFAULT_SETTINGS, ExportSettings } from './ffmpeg'
import { readJSON, writeJSON } from './projects'
import { DEFAULTS, mergeSettings as merge } from './settings-defaults'

export { DEFAULTS }

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Settings = {
  ui: {
    accent: 'violet' | 'blue' | 'teal' | 'green' | 'amber' | 'rose'
    density: 'comfortable' | 'compact'
    reduceMotion: boolean
    openLastProject: boolean
    confirmDelete: boolean
    homeView: 'grid' | 'list'
    homeSort: 'recent' | 'name' | 'duration'
  }
  editor: {
    snap: boolean
    snapFrames: boolean
    followPlayhead: boolean
    waveforms: boolean
    imageDuration: number
    defaultZoom: number
    stageBg: 'dark' | 'black' | 'gray' | 'checker'
    safeAreas: boolean
    thirds: boolean
    showChat: boolean
  }
  claude: {
    permissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
    model: string
    effort: Effort | ''
    extraInstructions: string
    /** Modo ahorro: reglas para gastar menos contexto (imágenes chicas, no releer, respuestas cortas). */
    saver: boolean
    showThinking: boolean
    showCost: boolean
    autoAttachFrame: boolean
    /** Al abrir un proyecto, seguir con su última conversación (si no, una nueva). */
    continueChat: boolean
    claudePath: string
    /** iPhone: actualizar Claude Code solo (se prueba antes de usarlo). Sin el campo, sí. */
    autoUpdate?: boolean
  }
  export: Partial<ExportSettings>
  exportPrefs: { defaultDir: string; openFolderWhenDone: boolean; notify: boolean }
  plugins: PluginSettings
  lastExportDir?: string
  lastProject?: string
}
export type PluginSettings = {
  /** Proveedor preferido para cada capacidad ('auto' = el primero configurado). */
  image: 'auto' | 'codex' | 'openai' | 'gemini'
  voice: 'auto' | 'elevenlabs' | 'fish'
  ask: 'auto' | 'codex' | 'openai' | 'gemini' | 'openrouter'
  transcribe: 'auto' | 'whisper' | 'elevenlabs' | 'openai' | 'fish'
  codex: { enabled: boolean; path: string; model: string }
  openai: { enabled: boolean; chatModel: string; imageModel: string; imageQuality: 'low' | 'medium' | 'high' | 'auto' }
  gemini: { enabled: boolean; chatModel: string; imageModel: string }
  openrouter: { enabled: boolean; chatModel: string }
  elevenlabs: { enabled: boolean; voiceId: string; voiceName: string; modelId: string; stability: number; similarity: number; style: number; speed: number }
  fish: { enabled: boolean; voiceId: string; voiceName: string; model: string; temperature: number; topP: number; speed: number; volume: number; latency: 'normal' | 'balanced' | 'low'; v?: number }
  whisper: { enabled: boolean; python: string; model: string; device: 'auto' | 'cuda' | 'cpu' }
  ytdlp: { path: string }
}
export function getSettings(): Settings {
  let raw: any
  try { raw = readJSON(SETTINGS_FILE) } catch { return structuredClone(DEFAULTS) }
  // Fish Audio: los ajustes guardados antes de S2.1 (s1/speech-1.x) pasan a S2.1 Pro Free, el actual y gratuito.
  const f = raw?.plugins?.fish
  if (f && !f.v) { if (/^(s1|speech-1\.\d)$/.test(f.model || '')) f.model = 's2.1-pro-free'; f.v = 2 }
  return merge(structuredClone(DEFAULTS), raw)
}
/** Aplica un parche parcial (anidado) y guarda. */
export function setSettings(patch: any) {
  const s = merge(getSettings(), patch)
  writeJSON(SETTINGS_FILE, s)
  return s
}
export function resetSettings() { writeJSON(SETTINGS_FILE, DEFAULTS); return structuredClone(DEFAULTS) }
export function exportDefaults(): ExportSettings { return { ...DEFAULT_SETTINGS, ...getSettings().export } }

/**
 * Instala las guías para la IA en data/: CLAUDE.md, AGENTS.md y .claude/skills/*.
 * Claude Code las encuentra "subiendo" desde la carpeta de cada proyecto (data/projects/<id>).
 * Los archivos gestionados se actualizan en cada inicio; las notas del usuario van en NOTAS-IA.md.
 */
export function seedAiGuides() {
  const src = path.join(APP_DIR, 'ai')
  if (!fs.existsSync(src)) return
  const copyTree = (from: string, to: string) => {
    fs.mkdirSync(to, { recursive: true })
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, e.name), b = path.join(to, e.name)
      if (e.isDirectory()) copyTree(a, b)
      else if (!fs.existsSync(b) || fs.readFileSync(a, 'utf8') !== fs.readFileSync(b, 'utf8')) fs.copyFileSync(a, b)
    }
  }
  const claudeMd = path.join(src, 'CLAUDE.md')
  if (fs.existsSync(claudeMd)) {
    const txt = fs.readFileSync(claudeMd, 'utf8')
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      const dst = path.join(DATA_DIR, name)
      if (!fs.existsSync(dst) || fs.readFileSync(dst, 'utf8') !== txt) fs.writeFileSync(dst, txt)
    }
  }
  const notes = path.join(DATA_DIR, 'NOTAS-IA.md')
  if (!fs.existsSync(notes)) fs.writeFileSync(notes, '# Notas para la IA\n\nEscribí acá tus preferencias (voz, estilo, colores, idioma…). Claude las lee en cada proyecto.\n')
  if (fs.existsSync(path.join(src, 'skills'))) copyTree(path.join(src, 'skills'), path.join(DATA_DIR, '.claude', 'skills'))
}
