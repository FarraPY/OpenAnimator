/**
 * Rutas de la app. OpenAnimator es PORTABLE: todo lo que crea (proyectos, ajustes,
 * skills para la IA) vive en `data/` junto al ejecutable, nunca en AppData.
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const isPackaged = app.isPackaged

/** Carpeta raíz de la instalación portable (donde está OpenAnimator.exe) o el repo en desarrollo. */
export const ROOT = isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..')

/** Recursos de la app (runtime de escenas, plantillas, skills, servidor MCP). */
export const APP_DIR = isPackaged ? path.join(app.getAppPath(), 'app') : path.join(ROOT, 'app')

/** Datos del usuario, portables. */
export const DATA_DIR = process.env.OA_DATA_DIR || path.join(ROOT, isPackaged ? 'data' : 'data-dev')
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects')
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
export const CACHE_DIR = path.join(DATA_DIR, 'cache')

export function ensureDataDirs() {
  for (const d of [DATA_DIR, PROJECTS_DIR, CACHE_DIR]) fs.mkdirSync(d, { recursive: true })
}

export function which(name: string): string | null {
  try {
    const out = execFileSync('where.exe', [name], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const first = out.split(/\r?\n/).find(Boolean)
    return first && fs.existsSync(first) ? first : null
  } catch { return null }
}

let _ff: { ffmpeg: string; ffprobe: string } | null = null
/** FFmpeg: primero el que viene con la app portable, después variables de entorno, después PATH. */
export function ffmpegPaths() {
  if (_ff) return _ff
  const candidates = [
    path.join(ROOT, 'ffmpeg'),
    path.join(ROOT, 'resources', 'ffmpeg'),
  ]
  for (const dir of candidates) {
    const f = path.join(dir, 'ffmpeg.exe'), p = path.join(dir, 'ffprobe.exe')
    if (fs.existsSync(f) && fs.existsSync(p)) return (_ff = { ffmpeg: f, ffprobe: p })
  }
  const envF = process.env.FFMPEG_PATH, envP = process.env.FFPROBE_PATH
  if (envF && envP && fs.existsSync(envF) && fs.existsSync(envP)) return (_ff = { ffmpeg: envF, ffprobe: envP })
  return (_ff = { ffmpeg: which('ffmpeg') || 'ffmpeg', ffprobe: which('ffprobe') || 'ffprobe' })
}

/** Claude Code CLI (para el chat de IA). */
export function claudePath(): string | null {
  const home = process.env.USERPROFILE || ''
  const known = [path.join(home, '.local', 'bin', 'claude.exe'), path.join(process.env.APPDATA || '', 'npm', 'claude.cmd')]
  for (const k of known) if (k && fs.existsSync(k)) return k
  return which('claude')
}
