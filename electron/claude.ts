/**
 * Chat con Claude Code (el CLI oficial del usuario, con su propia cuenta).
 *
 *   claude -p --input-format stream-json --output-format stream-json --verbose
 *          --include-partial-messages --permission-prompt-tool stdio
 *          --permission-mode <modo> --mcp-config <openanimator MCP>
 *
 * El protocolo (mensajes, permisos, opciones en caliente) está en claude-session.ts, compartido con
 * la tablet; acá se lanza `claude` como proceso hijo.
 */
import { spawn, ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { app } from 'electron'
import { APP_DIR, CACHE_DIR, DATA_DIR, claudePath, ffmpegPaths } from './paths'
import { projectDir } from './projects'
import { ClaudeStreamSession, nid, type ChatItem } from './claude-session'

export type { ChatEvent, ChatItem, ChatOptions, ChatStats } from './claude-session'

const READONLY_TOOLS = ['oa_proyecto', 'oa_ver_fotogramas', 'oa_hoja_contactos', 'oa_auditar_layout', 'oa_medios', 'oa_info_medio', 'oa_resolver_nota', 'oa_plugins', 'oa_voces']
const SYSTEM_APPEND = [
  'Estás trabajando dentro de OpenAnimator, un estudio de video donde las escenas son HTML/SVG/JS en función del tiempo.',
  'Antes de crear o cambiar escenas leé CLAUDE.md y las skills de OpenAnimator (dirección artística, escenas, voz y tiempos).',
  'VERIFICÁ SIEMPRE tu trabajo visualmente con las herramientas mcp__openanimator__* (oa_ver_fotogramas, oa_hoja_contactos, oa_auditar_layout) antes de decir que terminaste.',
  'Si hacen falta imágenes, voz, efectos de sonido o la opinión de otro modelo, usá los plugins del usuario (oa_plugins, oa_generar_imagen, oa_generar_voz, oa_generar_sfx, oa_transcribir, oa_consultar_ia): pueden tener costo, así que usalos con criterio.',
  'Los archivos que el usuario adjunta al chat quedan en la carpeta adjuntos/ del proyecto: leelos con Read cuando los mencione.',
  'El editor recarga solo cuando guardás archivos. Respondé en el idioma del usuario.',
].join(' ')

/** Modo ahorro: el usuario tiene un límite de uso por sesión; estas reglas bajan mucho el consumo de contexto. */
const SAVER = [
  'MODO AHORRO ACTIVADO (el usuario tiene un límite de uso cada 5 horas; cuidalo):',
  '1) Las imágenes son lo más caro: para revisar usá oa_hoja_contactos (una sola imagen con muchos instantes) antes que varios oa_ver_fotogramas; pedí width 640-960 salvo que necesites ver un detalle fino, y como máximo 4 fotogramas por verificación. No mires de nuevo lo que no cambió.',
  '2) No leas archivos grandes enteros: usá Grep o Read con offset/limit. Si un adjunto es largo (más de ~500 líneas), leelo una sola vez, guardá un resumen con lo esencial en scripts/ y después trabajá con ese resumen.',
  '3) No vuelvas a leer un archivo que ya leíste y no cambió. Para cambios chicos usá Edit, no reescribas archivos completos.',
  '4) Respuestas cortas: no repitas el plan, no pegues código ni el contenido de archivos en el chat; contá en 1-3 líneas qué hiciste.',
  '5) Trabajá por tandas: terminá una escena o sección completa, verificala una vez y seguí; no hagas muchas verificaciones intermedias.',
].join(' ')

/** Entorno limpio para lanzar Claude Code desde la app (sin variables de una sesión de Claude que la haya abierto). */
export function claudeEnv(projectId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|AI_AGENT)/.test(k)) delete env[k]
  delete env.ELECTRON_RUN_AS_NODE
  const ffdir = path.dirname(ffmpegPaths().ffmpeg)
  env.PATH = `${ffdir}${path.delimiter}${env.PATH || env.Path || ''}`
  env.OA_DATA_DIR = DATA_DIR
  env.OA_PROJECT = projectId
  env.OA_EXE = app.isPackaged ? process.execPath : `${process.execPath} "${app.getAppPath()}"`
  return env
}

/** Configuración MCP con las herramientas de OpenAnimator para un proyecto. */
export function writeMcpConfig(projectId: string) {
  const mcpFile = path.join(CACHE_DIR, `mcp-${projectId}.json`)
  fs.writeFileSync(mcpFile, JSON.stringify({
    mcpServers: {
      openanimator: {
        command: process.execPath,
        args: [path.join(APP_DIR, 'mcp', 'server.js')],
        env: { ELECTRON_RUN_AS_NODE: '1', OA_DATA_DIR: DATA_DIR, OA_PROJECT: projectId },
      },
    },
  }, null, 1))
  return mcpFile
}

export class ChatSession extends ClaudeStreamSession {
  proc: ChildProcess | null = null
  protected get alive() { return !!this.proc }

  start() {
    const bin = this.opts.claudePath || claudePath()
    if (!bin) { this.notice('No se encontró Claude Code. Instalalo desde claude.com/code y volvé a abrir el chat.', 'error'); return false }
    const dir = projectDir(this.opts.projectId)
    if (!dir) { this.notice('Proyecto no encontrado', 'error'); return false }
    const mcpFile = writeMcpConfig(this.opts.projectId)
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--permission-prompt-tool', 'stdio', '--permission-mode', this.opts.permissionMode || 'acceptEdits',
      '--mcp-config', mcpFile, '--append-system-prompt', SYSTEM_APPEND + (this.opts.saver !== false ? String.fromCharCode(10, 10) + SAVER : '') + (this.opts.extraInstructions?.trim() ? String.fromCharCode(10, 10) + 'Instrucciones del usuario (ajustes de OpenAnimator): ' + this.opts.extraInstructions.trim() : ''),
      // Herramientas propias que sólo leen o renderizan: no hace falta pedir permiso cada vez.
      '--allowedTools', READONLY_TOOLS.map((n) => `mcp__openanimator__${n}`).join(',')]
    if (this.opts.model) args.push('--model', this.opts.model)
    if (this.opts.effort) args.push('--effort', this.opts.effort)
    if (this.opts.resume) args.push('--resume', this.opts.resume)
    const env = claudeEnv(this.opts.projectId)
    const p = spawn(bin, args, { cwd: dir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = p
    let errTail = ''
    p.stderr!.on('data', (d) => { errTail = (errTail + d).slice(-3000) })
    readline.createInterface({ input: p.stdout! }).on('line', (line) => this.onLine(line))
    p.on('close', (code) => {
      if (this.proc !== p) return // un proceso viejo que se cerró después de relanzar
      this.proc = null
      this.closed(code, errTail)
    })
    p.on('error', (e) => { this.notice('No se pudo iniciar Claude: ' + e.message, 'error'); this.proc = null; this.state() })
    this.state()
    return true
  }

  protected writeLine(obj: unknown) { try { this.proc?.stdin?.write(JSON.stringify(obj) + '\n') } catch { /* ignore */ } }
  protected terminate() { try { this.proc?.kill() } catch { /* ignore */ } this.proc = null }
}

// ── historial: las conversaciones que Claude Code guarda para la carpeta del proyecto ──────────
export type SessionInfo = { id: string; title: string; first: string; updated: number; size: number }
const CTX_SUFFIX = /\n\n\(Contexto del editor:[\s\S]*$/

function sessionsDir(projectId: string): string | null {
  const dir = projectDir(projectId)
  if (!dir) return null
  const base = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects')
  const enc = dir.replace(/[^a-zA-Z0-9]/g, '-')
  if (fs.existsSync(path.join(base, enc))) return path.join(base, enc)
  // Rutas muy largas: Claude Code recorta el nombre y le agrega un hash.
  try { const d = fs.readdirSync(base).find((x) => x.startsWith(enc.slice(0, 180))); return d ? path.join(base, d) : null } catch { return null }
}
function readSlice(f: string, start: number, len: number) {
  const fd = fs.openSync(f, 'r')
  try { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, start); return b.subarray(0, n).toString('utf8') } finally { fs.closeSync(fd) }
}
const userText = (m: any): string => {
  const c = m?.message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
  return ''
}
const isRealPrompt = (m: any) => m.type === 'user' && !m.isMeta && !m.isSidechain && !!userText(m).trim() && !/^\s*<|^\[Request interrupted/.test(userText(m))

export function listSessions(projectId: string): SessionInfo[] {
  const dir = sessionsDir(projectId)
  if (!dir) return []
  const out: SessionInfo[] = []
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
    const file = path.join(dir, f)
    const st = fs.statSync(file)
    if (st.size < 400) continue
    let first = '', title = ''
    for (const line of readSlice(file, 0, Math.min(st.size, 256 * 1024)).split('\n')) {
      try { const m = JSON.parse(line); if (!first && isRealPrompt(m)) first = userText(m).replace(CTX_SUFFIX, '').trim() } catch { /* línea cortada */ }
      if (first) break
    }
    if (!first) continue
    const tail = readSlice(file, Math.max(0, st.size - 128 * 1024), Math.min(st.size, 128 * 1024))
    const titles = [...tail.matchAll(/"aiTitle":"((?:[^"\\]|\\.)*)"/g)]
    if (titles.length) try { title = JSON.parse(`"${titles[titles.length - 1][1]}"`) } catch { /* ignore */ }
    out.push({ id: f.slice(0, -6), title: title || first.split('\n')[0].slice(0, 80), first: first.slice(0, 220), updated: st.mtimeMs, size: st.size })
  }
  return out.sort((a, b) => b.updated - a.updated)
}

/** Reconstruye lo que se ve en el chat a partir del archivo de la conversación. */
export function loadTranscript(projectId: string, sessionId: string): ChatItem[] {
  const dir = sessionsDir(projectId)
  const file = dir && path.join(dir, `${sessionId}.jsonl`)
  if (!file || !/^[\w-]+$/.test(sessionId) || !fs.existsSync(file)) return []
  const items: ChatItem[] = []
  const tools = new Map<string, ChatItem>()
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let m: any
    try { m = JSON.parse(line) } catch { continue }
    if (m.isSidechain) continue
    if (m.type === 'system' && m.subtype === 'compact_boundary') { items.push({ id: nid('n'), kind: 'notice', text: 'Conversación compactada.', level: 'info' }); continue }
    const c = m.message?.content
    if (m.type === 'user') {
      if (m.isMeta || m.isCompactSummary) continue
      if (Array.isArray(c)) for (const b of c) if (b.type === 'tool_result') {
        const it = tools.get(b.tool_use_id)
        if (!it) continue
        const txt = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x: any) => (x.type === 'text' ? x.text : x.type === 'image' ? '[imagen]' : '')).join('\n') : ''
        it.status = b.is_error ? 'error' : 'ok'; it.isError = !!b.is_error; it.result = txt.slice(0, 4000)
      }
      if (isRealPrompt(m)) {
        const imgs = Array.isArray(c) ? c.filter((b: any) => b.type === 'image').length : 0
        items.push({ id: nid('u'), kind: 'user', text: userText(m), images: imgs || undefined })
      } else if (/^\[Request interrupted/.test(userText(m))) items.push({ id: nid('n'), kind: 'notice', text: 'Interrumpido.', level: 'info' })
    } else if (m.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text' && b.text?.trim()) items.push({ id: nid('a'), kind: 'assistant', text: b.text, status: 'ok' })
        else if (b.type === 'tool_use') { const it: ChatItem = { id: nid('tool'), kind: 'tool', name: b.name, input: b.input, status: 'ok' }; tools.set(b.id, it); items.push(it) }
      }
    }
  }
  return items.slice(-400)
}
