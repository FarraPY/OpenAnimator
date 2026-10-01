/**
 * Herramientas de Claude en Android: las de archivos que usa Claude Code en la PC (Read, Write,
 * Edit, Glob, Grep, Skill) y las de OpenAnimator (oa_*), que en la PC llegan por MCP.
 * Todas trabajan dentro de la carpeta del proyecto.
 */
import { appManifest, assetUsage, listAssets, projectDir, readProject, readTimeline, writeTimeline } from './projects'
import { base64ToBytes, canvasBase64, extname, fs, join, normalizeRel } from './fsx'
import * as F from './frames'
import * as M from './media'
import * as PL from './plugins'
import { host } from '../host'
import { getSettings } from './settings'

export type ToolContent = Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string } }>
export type ToolKind = 'read' | 'edit' | 'cost'
export type ToolCtx = { projectId: string; changed: (file: string) => void }

const P = { type: 'string', description: 'Id del proyecto (por defecto, el actual)' }
const TL = { type: 'string', description: 'Id del timeline (por defecto, el activo)' }

/** Definiciones que se mandan a la API (orden fijo: la caché de prompts depende de eso). */
export const TOOL_DEFS: Array<{ name: string; description: string; input_schema: any; kind: ToolKind }> = [
  { name: 'Read', kind: 'read', description: 'Lee un archivo del proyecto (ruta relativa a la carpeta del proyecto, p. ej. scenes/intro.html). Devuelve las líneas numeradas (formato cat -n). Para archivos largos usá offset/limit. Las imágenes (png, jpg, webp, gif) se devuelven como imagen para que las veas.', input_schema: { type: 'object', properties: { file_path: { type: 'string', description: 'Ruta relativa al proyecto' }, offset: { type: 'number', description: 'Primera línea (desde 1)' }, limit: { type: 'number', description: 'Cantidad de líneas (por defecto 2000)' } }, required: ['file_path'] } },
  { name: 'Write', kind: 'edit', description: 'Crea o reemplaza por completo un archivo de texto del proyecto (crea las carpetas que falten). Para cambios chicos preferí Edit.', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string', description: 'Contenido completo del archivo' } }, required: ['file_path', 'content'] } },
  { name: 'Edit', kind: 'edit', description: 'Reemplaza un texto exacto en un archivo del proyecto. old_string tiene que aparecer una sola vez (agregá contexto para que sea única) salvo que uses replace_all.', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['file_path', 'old_string', 'new_string'] } },
  { name: 'Glob', kind: 'read', description: 'Busca archivos del proyecto por patrón (p. ej. "scenes/**/*.html", "**/*.mp3"). Devuelve rutas ordenadas de la más reciente a la más vieja.', input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Carpeta donde buscar (por defecto, todo el proyecto)' } }, required: ['pattern'] } },
  { name: 'Grep', kind: 'read', description: 'Busca texto (expresión regular de JavaScript) en los archivos de texto del proyecto.', input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Archivo o carpeta (por defecto, todo el proyecto)' }, glob: { type: 'string', description: 'Filtro de archivos, p. ej. "*.js"' }, output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'Por defecto files_with_matches' }, '-i': { type: 'boolean', description: 'Sin distinguir mayúsculas' }, '-C': { type: 'number', description: 'Líneas de contexto (con content)' }, head_limit: { type: 'number', description: 'Máximo de resultados (por defecto 100)' } }, required: ['pattern'] } },
  { name: 'Skill', kind: 'read', description: 'Carga una skill de OpenAnimator (guía detallada para una tarea). Leé la que corresponda antes de trabajar.', input_schema: { type: 'object', properties: { skill: { type: 'string', description: 'Nombre de la skill' } }, required: ['skill'] } },
  { name: 'oa_proyecto', kind: 'read', description: 'Resumen del proyecto: resolución, fps, timelines, pistas, clips y notas del usuario ancladas al tiempo.', input_schema: { type: 'object', properties: { project: P, timeline: TL } } },
  { name: 'oa_ver_fotogramas', kind: 'read', description: 'Renderiza el video en los instantes indicados (segundos del timeline) y devuelve las imágenes para que las MIRES, con lo que le cuesta cada escena a la tablet. Usalo después de cada cambio visual. Máx. 8 instantes.', input_schema: { type: 'object', properties: { project: P, timeline: TL, times: { type: 'array', items: { type: 'number' } }, width: { type: 'number', description: 'Ancho de la imagen (por defecto 960; subilo a 1280-1920 sólo para revisar detalles finos: cada imagen grande consume mucho contexto)' } }, required: ['times'] } },
  { name: 'oa_hoja_contactos', kind: 'read', description: 'Hoja de contactos: N fotogramas repartidos en un rango (o instantes dados) en una sola imagen con la hora de cada uno. Ideal para revisar ritmo, variedad y consistencia de todo el video.', input_schema: { type: 'object', properties: { project: P, timeline: TL, count: { type: 'number', description: 'Cantidad de fotogramas (2-48, por defecto 12)' }, from: { type: 'number' }, to: { type: 'number' }, times: { type: 'array', items: { type: 'number' } }, cols: { type: 'number' }, width: { type: 'number', description: 'Ancho de cada miniatura (por defecto 480)' } } } },
  { name: 'oa_auditar_layout', kind: 'read', description: 'Recorre el timeline cada `step` segundos y reporta textos fuera de cuadro y textos superpuestos (con el rango de tiempo donde ocurre). Debe dar 0 incidencias antes de entregar. Un audit limpio NO reemplaza mirar fotogramas.', input_schema: { type: 'object', properties: { project: P, timeline: TL, step: { type: 'number', description: 'Paso en segundos (por defecto 0.5)' }, from: { type: 'number' }, to: { type: 'number' } } } },
  { name: 'oa_medios', kind: 'read', description: 'Lista los archivos del proyecto (escenas, video, audio, imágenes, documentos) con tamaño.', input_schema: { type: 'object', properties: { project: P } } },
  { name: 'oa_info_medio', kind: 'read', description: 'Duración y dimensiones de un archivo de audio/video del proyecto (ruta relativa).', input_schema: { type: 'object', properties: { project: P, path: { type: 'string' } }, required: ['path'] } },
  { name: 'oa_plugins', kind: 'read', description: 'Plugins de IA configurados por el usuario (OpenAI, Gemini, OpenRouter, ElevenLabs, Fish Audio, Whisper en la tablet) y qué puede hacer cada uno. Consultalo antes de generar imágenes, voz o sonidos, o de transcribir.', input_schema: { type: 'object', properties: {} } },
  { name: 'oa_generar_imagen', kind: 'cost', description: 'Genera una imagen con el plugin del usuario (OpenAI o Gemini) y la guarda en assets/ia/ del proyecto. Devuelve la ruta relativa para usarla en escenas (<img src="../assets/ia/…">) o en una pista de video, y una vista previa. Tarda 20-90 s. Describí estilo, encuadre y colores con precisión; pedí fondo transparente para recortes/íconos.', input_schema: { type: 'object', properties: { project: P, prompt: { type: 'string', description: 'Descripción detallada de la imagen (idealmente en inglés)' }, nombre: { type: 'string', description: 'Nombre corto del archivo' }, formato: { type: 'string', enum: ['horizontal', 'vertical', 'cuadrado'] }, fondo_transparente: { type: 'boolean' }, proveedor: { type: 'string', enum: ['openai', 'gemini'], description: 'Opcional: por defecto el preferido del usuario' }, referencia: { type: 'string', description: 'Imagen de referencia (ruta del proyecto) para mantener estilo o personaje' } }, required: ['prompt'] } },
  { name: 'oa_generar_voz', kind: 'cost', description: 'Narración con ElevenLabs o Fish Audio (plugins del usuario). Guarda un MP3 en assets/voz/ y devuelve su duración y, con ElevenLabs, el tiempo de cada palabra (para sincronizar animaciones). Generá por párrafo o sección, no todo el guion junto. Con Fish Audio S2/S2.1 (por defecto s2.1-pro-free, GRATIS) el texto admite indicaciones entre [corchetes] en lenguaje natural ([calm], [excited], [whispering], [emphasis], [break], [long-break]…) y diálogos con <|speaker:0|>…<|speaker:1|>… pasando `voces`. Leé la skill voz-fish-audio antes de usar Fish.', input_schema: { type: 'object', properties: { project: P, texto: { type: 'string' }, proveedor: { type: 'string', enum: ['elevenlabs', 'fish'] }, voz: { type: 'string', description: 'Id de voz (opcional; ver oa_voces). Por defecto, la elegida por el usuario' }, voces: { type: 'array', items: { type: 'string' }, description: 'Fish S2/S2.1: una voz por hablante, en el orden de <|speaker:0|>, <|speaker:1|>…' }, modelo: { type: 'string', enum: ['s2.1-pro-free', 's2.1-pro', 's2-pro', 's1'], description: 'Fish: por defecto el de los ajustes (s2.1-pro-free es gratis)' }, temperatura: { type: 'number', description: 'Fish 0-1 (0.7): más alto = más expresiva y variable' }, nombre: { type: 'string' }, velocidad: { type: 'number', description: '0.7-1.3' } }, required: ['texto'] } },
  { name: 'oa_voces', kind: 'read', description: 'Lista voces disponibles de ElevenLabs o Fish Audio (id, nombre, info). En Fish, `buscar` acepta un código de idioma ("es"), un título ("narrador") o ambos ("es: narrador").', input_schema: { type: 'object', properties: { proveedor: { type: 'string', enum: ['elevenlabs', 'fish'] }, buscar: { type: 'string' } } } },
  { name: 'oa_generar_sfx', kind: 'cost', description: 'Efecto de sonido con ElevenLabs a partir de una descripción (whoosh, pop, ambiente…). Guarda un MP3 en assets/sfx/. Generá cada sonido distinto una vez y reusalo: un clip por efecto en la pista SFX, en el momento exacto del evento (no premezcles varios efectos en un archivo).', input_schema: { type: 'object', properties: { project: P, descripcion: { type: 'string' }, segundos: { type: 'number', description: '0.5-22' }, nombre: { type: 'string' } }, required: ['descripcion'] } },
  { name: 'oa_transcribir', kind: 'cost', description: 'Transcribe un audio/video del proyecto con tiempos por palabra. Sin `proveedor` usa Whisper en el equipo si el usuario lo instaló (gratis, sin internet; en la tablet tarda más que en la PC: transcribí sólo lo necesario; en el iPhone es rápido) y si no, ElevenLabs, OpenAI o Fish Audio (con costo). Útil para sincronizar escenas con una narración y para el control de calidad de voces generadas.', input_schema: { type: 'object', properties: { project: P, path: { type: 'string' }, proveedor: { type: 'string', enum: ['whisper', 'elevenlabs', 'openai', 'fish'] }, idioma: { type: 'string', description: 'Código ISO, p. ej. es. Pasalo siempre que lo sepas: sin él, Whisper lo detecta (en la tablet escucha el comienzo una vez más: tarda bastante más) y puede detectar otro' } }, required: ['path'] } },
  { name: 'oa_consultar_ia', kind: 'cost', description: 'Consulta a otro modelo de IA configurado por el usuario (OpenAI API, Gemini u OpenRouter): segunda opinión, ideas, revisión de un guion o de fotogramas (imagenes = rutas del proyecto).', input_schema: { type: 'object', properties: { project: P, consulta: { type: 'string' }, proveedor: { type: 'string', enum: ['openai', 'gemini', 'openrouter'] }, modelo: { type: 'string' }, imagenes: { type: 'array', items: { type: 'string' } }, sistema: { type: 'string', description: 'Instrucciones de sistema opcionales' } }, required: ['consulta'] } },
  { name: 'oa_resolver_nota', kind: 'edit', description: 'Borra una nota del usuario del timeline. Llamala apenas terminás el cambio que pedía esa nota (las notas resueltas no deben quedar en el timeline); no borres notas pendientes.', input_schema: { type: 'object', properties: { project: P, timeline: TL, id: { type: 'string' } }, required: ['id'] } },
]
export const toolKind = (name: string): ToolKind => TOOL_DEFS.find((t) => t.name === name)?.kind || 'cost'

// ── validación mínima de entradas (con streaming ansioso la API no valida) ─────
export function validateInput(name: string, input: any): string | null {
  const def = TOOL_DEFS.find((t) => t.name === name)
  if (!def) return `Herramienta desconocida: ${name}`
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'La entrada no es un objeto JSON'
  for (const k of def.input_schema.required || []) if (input[k] === undefined || input[k] === null) return `Falta el parámetro «${k}»`
  for (const [k, v] of Object.entries(input)) {
    const sch = def.input_schema.properties?.[k]
    if (!sch) continue
    if (sch.type === 'string' && typeof v !== 'string') return `«${k}» tiene que ser texto`
    if (sch.type === 'number' && typeof v !== 'number') return `«${k}» tiene que ser un número`
    if (sch.type === 'boolean' && typeof v !== 'boolean') return `«${k}» tiene que ser true o false`
    if (sch.type === 'array' && !Array.isArray(v)) return `«${k}» tiene que ser una lista`
  }
  return null
}

// ── rutas ─────────────────────────────────────────────────────────────────────
function projectRoot(ctx: ToolCtx, id?: string) {
  const pid = id || ctx.projectId
  const d = projectDir(pid)
  if (!d) throw new Error('Proyecto no encontrado: ' + pid)
  return d
}
/** Ruta del proyecto a partir de lo que escribe Claude ("scenes/a.html", "./a", "/proyecto/a"). */
function resolvePath(ctx: ToolCtx, p: string) {
  let r = String(p || '').replace(/\\/g, '/').trim()
  const root = projectRoot(ctx)
  r = r.replace(/^\/?(proyecto|project)\//i, '').replace(/^\.\//, '').replace(/^\/+/, '')
  if (r.startsWith(root + '/')) r = r.slice(root.length + 1)
  const rel = normalizeRel(r)
  if (/^(\.oa-chat|\.trash)(\/|$)/.test(rel)) throw new Error('Esa carpeta es interna de la app')
  return { rel, abs: rel ? join(root, rel) : root }
}

const TEXT_EXT = /\.(html?|js|mjs|cjs|ts|css|json|md|txt|svg|csv|srt|vtt|xml|yml|yaml)$/i
const IMG_EXT = /\.(png|jpe?g|webp|gif)$/i
const SKIP = new Set(['.oa-cache', '.oa-chat', '.trash', 'node_modules', '.git', 'renders'])

function walkProject(ctx: ToolCtx, base: string) {
  const { abs } = resolvePath(ctx, base || '')
  const root = projectRoot(ctx)
  return fs.walk(abs, { depth: 10, max: 8000, skipHidden: true, skipDirs: [...SKIP] })
    .filter((e) => !e.dir && !e.path!.split('/').some((x) => SKIP.has(x)))
    .map((e) => ({ ...e, rel: (abs === root ? '' : abs.slice(root.length + 1) + '/') + e.path }))
}

export function globToRegex(glob: string) {
  let re = '', i = 0
  while (i < glob.length) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') { re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += glob[i + 2] === '/' ? 3 : 2; continue }
      re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') { const j = glob.indexOf('}', i); if (j > i) { re += '(?:' + glob.slice(i + 1, j).split(',').map((x) => x.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')'; i = j + 1; continue } re += '\\{' }
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&')
    i++
  }
  return new RegExp('^' + re + '$', 'i')
}

async function imageBlock(bytes: ArrayBuffer, mime: string, maxSide = 1568): Promise<ToolContent[number]> {
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime }))
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s))
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h
  cv.getContext('2d')!.drawImage(bmp, 0, 0, w, h); bmp.close()
  const png = /png|gif|webp/.test(mime)
  const e = canvasBase64(cv, png ? 'image/png' : 'image/jpeg', 0.88)
  return { type: 'image', source: { type: 'base64', media_type: e.mime === 'image/png' ? 'image/png' : 'image/jpeg', data: e.data } }
}

/** Vista previa chica de una imagen generada + % de píxeles transparentes (como la PC). */
async function previewOf(rel: string) {
  try {
    const bmp = await createImageBitmap(new Blob([await fs.readBytes(rel)]))
    const s = Math.min(1, 640 / bmp.width)
    const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s))
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h
    const g = cv.getContext('2d')!
    g.drawImage(bmp, 0, 0, w, h); bmp.close()
    const px = g.getImageData(0, 0, w, h).data
    let clear = 0
    for (let i = 3; i < px.length; i += 4) if (px[i] < 16) clear++
    return { png: canvasBase64(cv, 'image/png').data, transparent: Math.round((clear / (px.length / 4)) * 100) }
  } catch { return null }
}

// ── skills ────────────────────────────────────────────────────────────────────
/** Adapta las guías de la PC a Android (sin terminal, sin ffprobe, sin CLI de exportación). */
export function adaptGuide(text: string) {
  return text
    .replace(/ \(o `ffprobe`, está en el PATH\)/g, '')
    .replace(/## Exportar \/ previsualizar desde la terminal[\s\S]*?(?=\n## )/, '')
    .replace(/4\. Tramo corto exportado \(`%OA_EXE%[^\n]*/g, '4. Si hay video o 3D, revisá el movimiento con fotogramas seguidos (oa_ver_fotogramas con tiempos cercanos, p. ej. 1.0, 1.1, 1.2 s).')
}
let skillsCache: Promise<Array<{ name: string; description: string; path: string }>> | null = null
export function listSkills() {
  if (!skillsCache) skillsCache = (async () => {
    const m = await appManifest()
    const out: Array<{ name: string; description: string; path: string }> = []
    for (const f of m.ai.filter((x) => /^skills\/[^/]+\/SKILL\.md$/.test(x))) {
      try {
        const t = await fetch(`app/ai/${f}`).then((r) => r.text())
        const fm = /^---\s*\n([\s\S]*?)\n---/.exec(t)?.[1] || ''
        const name = /^name:\s*(.+)$/m.exec(fm)?.[1].trim() || f.split('/')[1]
        const description = /^description:\s*(.+)$/m.exec(fm)?.[1].trim() || ''
        out.push({ name, description, path: `app/ai/${f}` })
      } catch { /* ignore */ }
    }
    return out
  })()
  return skillsCache
}
export async function aiGuide() {
  try { return adaptGuide(await fetch('app/ai/CLAUDE.md').then((r) => r.text())) } catch { return '' }
}

// ── ejecución ─────────────────────────────────────────────────────────────────
const txt = (text: string): ToolContent => [{ type: 'text', text }]

function summary(projectId: string, tlId?: string) {
  const p = readProject(projectId)
  const tid = tlId || p.activeTimeline
  const tl = readTimeline(projectId, tid)
  return {
    proyecto: { id: p.id, nombre: p.name, ancho: p.width, alto: p.height, fps: p.fps },
    timelines: p.timelines.map((t) => ({ id: t.id, nombre: t.name, archivo: t.file, activo: t.id === tid })),
    timeline: {
      id: tid, duracion: tl.duration,
      pistas: tl.tracks.map((t) => ({ id: t.id, nombre: t.name, tipo: t.type, silenciada: !!t.muted, clips: t.clips.map((c) => ({ id: c.id, src: c.src, start: c.start, duration: c.duration, in: c.in || 0 })) })),
      notas: tl.notes || [],
    },
  }
}

export async function runTool(name: string, input: any, ctx: ToolCtx): Promise<ToolContent> {
  const project = input.project || ctx.projectId
  switch (name) {
    case 'Read': {
      const { rel, abs } = resolvePath(ctx, input.file_path)
      const st = fs.stat(abs)
      if (!st) throw new Error(`No existe el archivo: ${rel}`)
      if (st.dir) {
        const list = fs.list(abs).filter((e) => !e.name.startsWith('.')).map((e) => (e.dir ? e.name + '/' : e.name))
        return txt(`${rel || '.'} es una carpeta. Contiene:\n${list.join('\n') || '(vacía)'}`)
      }
      if (IMG_EXT.test(rel)) {
        const mime = /\.png$/i.test(rel) ? 'image/png' : /\.webp$/i.test(rel) ? 'image/webp' : /\.gif$/i.test(rel) ? 'image/gif' : 'image/jpeg'
        return [{ type: 'text', text: `Imagen ${rel} (${Math.round(st.size / 1024)} KB)` }, await imageBlock(await fs.readBytes(abs), mime)]
      }
      if (!TEXT_EXT.test(rel) && st.size > 0) {
        if (/\.(mp3|wav|ogg|m4a|aac|flac|opus|mp4|webm|mov|mkv|m4v)$/i.test(rel)) return txt(`${rel} es un archivo de audio/video (${(st.size / 1e6).toFixed(1)} MB). Usá oa_info_medio para ver su duración.`)
        if (/\.pdf$/i.test(rel)) return txt(`${rel} es un PDF de ${(st.size / 1e6).toFixed(1)} MB. En Android no se puede leer como texto; pedile al usuario el contenido o un .txt/.md.`)
      }
      const { text, truncated } = fs.readTextLimited(abs, 8_000_000)
      const lines = text.split('\n')
      const off = Math.max(1, Math.floor(input.offset || 1)), lim = Math.max(1, Math.floor(input.limit || 2000))
      const part = lines.slice(off - 1, off - 1 + lim)
      const body = part.map((l, i) => `${String(off + i).padStart(6)}\t${l.length > 2000 ? l.slice(0, 2000) + '…' : l}`).join('\n')
      const more = off - 1 + lim < lines.length ? `\n\n(${lines.length} líneas en total; seguí con offset=${off + lim})` : ''
      return txt((body || '(archivo vacío)') + more + (truncated ? '\n(El archivo es muy grande: se leyeron los primeros 8 MB.)' : ''))
    }
    case 'Write': {
      const { rel, abs } = resolvePath(ctx, input.file_path)
      if (!rel) throw new Error('Falta la ruta del archivo')
      if (!TEXT_EXT.test(rel) && extname(rel)) throw new Error('Write sólo escribe archivos de texto (html, js, css, json, md…)')
      const existed = fs.exists(abs)
      fs.writeText(abs, String(input.content))
      ctx.changed(rel)
      return txt(`${existed ? 'Archivo reemplazado' : 'Archivo creado'}: ${rel} (${String(input.content).split('\n').length} líneas)`)
    }
    case 'Edit': {
      const { rel, abs } = resolvePath(ctx, input.file_path)
      if (!fs.exists(abs)) throw new Error(`No existe el archivo: ${rel}`)
      const old = String(input.old_string), neu = String(input.new_string)
      if (old === neu) throw new Error('old_string y new_string son iguales')
      const text = fs.readText(abs)
      const count = old ? text.split(old).length - 1 : 0
      if (!count) throw new Error(`No se encontró old_string en ${rel}. Leé el archivo (Read) y copiá el texto exacto, con espacios y saltos de línea.`)
      if (count > 1 && !input.replace_all) throw new Error(`old_string aparece ${count} veces en ${rel}: agregá contexto para que sea única o usá replace_all.`)
      fs.writeText(abs, input.replace_all ? text.split(old).join(neu) : text.replace(old, () => neu))
      ctx.changed(rel)
      return txt(`Editado ${rel}${input.replace_all ? ` (${count} reemplazos)` : ''}.`)
    }
    case 'Glob': {
      const re = globToRegex(String(input.pattern).replace(/^\.\//, ''))
      const list = walkProject(ctx, input.path || '').filter((e) => re.test(e.rel) || re.test(e.path!) || (!String(input.pattern).includes('/') && re.test(e.name)))
      list.sort((a, b) => b.mtime - a.mtime)
      return txt(list.length ? list.slice(0, 250).map((e) => e.rel).join('\n') + (list.length > 250 ? `\n(${list.length - 250} más…)` : '') : 'Ningún archivo coincide.')
    }
    case 'Grep': {
      let re: RegExp
      try { re = new RegExp(String(input.pattern), input['-i'] ? 'i' : '') } catch (e: any) { throw new Error('Expresión regular inválida: ' + e.message) }
      const mode = input.output_mode || 'files_with_matches'
      const limit = Math.max(1, input.head_limit || 100)
      const ctxN = Math.max(0, Math.min(10, input['-C'] || 0))
      const fg = input.glob ? globToRegex(String(input.glob).includes('/') ? input.glob : '**/' + input.glob) : null
      const target = resolvePath(ctx, input.path || '')
      const st = fs.stat(target.abs)
      const files = st && !st.dir ? [{ rel: target.rel, size: st.size }] : walkProject(ctx, input.path || '')
      const out: string[] = []
      let total = 0
      for (const f of files) {
        if (!TEXT_EXT.test(f.rel) || f.size > 3_000_000) continue
        if (fg && !fg.test(f.rel)) continue
        const lines = fs.readText(projectRoot(ctx) + '/' + f.rel).split('\n')
        const hits: number[] = []
        lines.forEach((l, i) => { if (re.test(l)) hits.push(i) })
        if (!hits.length) continue
        total += hits.length
        if (mode === 'files_with_matches') out.push(f.rel)
        else if (mode === 'count') out.push(`${f.rel}:${hits.length}`)
        else {
          const shown = new Set<number>()
          for (const i of hits) for (let j = Math.max(0, i - ctxN); j <= Math.min(lines.length - 1, i + ctxN); j++) shown.add(j)
          for (const j of [...shown].sort((a, b) => a - b)) out.push(`${f.rel}:${j + 1}${hits.includes(j) ? ':' : '-'}${lines[j].slice(0, 400)}`)
        }
        if (out.length >= limit) break
      }
      return txt(out.length ? out.slice(0, limit).join('\n') + (out.length > limit ? '\n(…)' : '') : `Sin coincidencias para /${input.pattern}/.`)
    }
    case 'Skill': {
      const skills = await listSkills()
      const s = skills.find((x) => x.name === input.skill) || skills.find((x) => x.name.includes(String(input.skill)))
      if (!s) throw new Error(`No existe la skill «${input.skill}». Disponibles: ${skills.map((x) => x.name).join(', ')}`)
      return txt(adaptGuide(await fetch(s.path).then((r) => r.text())))
    }
    case 'oa_proyecto': return txt(JSON.stringify(summary(project, input.timeline), null, 1))
    case 'oa_medios': return txt(JSON.stringify(listAssets(project).map((a) => ({ ruta: a.path, tipo: a.kind, kb: Math.round(a.size / 1024) })), null, 1))
    case 'oa_info_medio': {
      const { abs, rel } = resolvePath({ ...ctx, projectId: project }, input.path)
      if (!fs.exists(abs)) throw new Error('No existe: ' + rel)
      return txt(JSON.stringify(await M.probe(abs)))
    }
    case 'oa_ver_fotogramas': {
      const times: number[] = (input.times || [0]).slice(0, 8)
      const frames = await F.renderFrames(project, input.timeline, times, F.fitWidth(project, input.width || 960), true, 'jpeg', 4)
      const out: ToolContent = []
      for (const f of frames) { out.push({ type: 'text', text: `t=${f.t}s` }); out.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.data } }) }
      const note = F.costNote(frames.flatMap((f) => (f.cost ? [f.cost] : [])))
      if (note) out.push({ type: 'text', text: note })
      return out
    }
    case 'oa_hoja_contactos': {
      const r = await F.contactSheet(project, input.timeline, input)
      const note = F.costNote(r.costs)
      return [{ type: 'text', text: 'Instantes: ' + r.times.join(', ') + ' s' + (note ? '\n' + note : '') }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: r.jpeg } }]
    }
    case 'oa_auditar_layout': {
      const r = await F.auditLayout(project, input.timeline, input)
      const lines = r.issues.map((i) => `- ${i.kind} «${i.text}» en ${i.clip || '?'} (${i.from}s–${i.to}s)`)
      return txt(`Auditoría ${r.timeline} ${r.from}s–${r.to}s cada ${r.step}s: ${r.issues.length} incidencia(s)\n` + lines.join('\n'))
    }
    case 'oa_plugins': {
      if (getSettings().plugins.whisper?.enabled !== false) await PL.whisperState()
      const st = PL.pluginStatus()
      const s = getSettings().plugins
      return txt(JSON.stringify({
        plugins: st.map((p) => ({ id: p.id, nombre: p.name, listo: p.ready, capacidades: p.caps, detalle: p.detail })),
        preferidos: { imagen: s.image, voz: s.voice, consulta: s.ask, transcripcion: s.transcribe },
        voz_por_defecto: { elevenlabs: s.elevenlabs.voiceName || s.elevenlabs.voiceId || null, fish: s.fish.voiceName || s.fish.voiceId || null },
        fish: { modelo: s.fish.model, gratis: s.fish.model === 's2.1-pro-free', sintaxis: s.fish.model === 's1' ? '(parentesis) con etiquetas fijas' : '[corchetes] con lenguaje natural', guia: 'skill voz-fish-audio' },
        nota: host().kind === 'web'
          ? 'En el iPhone no hay ChatGPT/Codex ni yt-dlp. Whisper corre en el iPhone (WhisperKit en el Neural Engine): gratis, sin internet y rápido (10 minutos de audio en menos de un minuto).'
          : 'En Android no hay ChatGPT/Codex ni yt-dlp. Whisper corre en la tablet (whisper.cpp en Termux): gratis y sin internet, pero más lento que en la PC.',
      }, null, 1))
    }
    case 'oa_voces': return txt(JSON.stringify((await PL.listVoices(input.proveedor === 'fish' ? 'fish' : 'elevenlabs', input.buscar)).slice(0, 80).map((v) => ({ id: v.id, nombre: v.name, info: v.desc })), null, 1))
    case 'oa_generar_imagen': {
      const aspect = ({ horizontal: 'landscape', vertical: 'portrait', cuadrado: 'square' } as any)[input.formato] || 'landscape'
      const r = await PL.generateImage(project, { prompt: input.prompt, name: input.nombre, aspect, transparent: input.fondo_transparente, provider: input.proveedor, reference: input.referencia })
      ctx.changed(r.path)
      const pv = await previewOf(r.abs)
      const alpha = pv == null ? '' : pv.transparent > 1 ? ` Fondo transparente: sí (${pv.transparent} % de píxeles transparentes).` : ' Sin transparencia (fondo opaco).'
      const out: ToolContent = [{ type: 'text', text: `Imagen guardada en ${r.path} (${r.provider}).${alpha} Desde una escena en scenes/: src="../${r.path}".` }]
      if (pv) out.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: pv.png } })
      return out
    }
    case 'oa_generar_voz': {
      const r = await PL.tts(project, { text: input.texto, provider: input.proveedor, voice: input.voces?.length ? input.voces : input.voz, name: input.nombre, speed: input.velocidad, model: input.modelo, temperature: input.temperatura })
      ctx.changed(r.path)
      const words = r.words ? '\nPalabras (inicio s): ' + r.words.map((w) => `${w.w}@${w.start}`).join(' ') : '\n(Sin tiempos por palabra: usá oa_transcribir si los necesitás.)'
      return txt(`Voz guardada en ${r.path} · ${r.duration} s · ${r.provider}. Agregala a la pista de voz del timeline.${words}`)
    }
    case 'oa_generar_sfx': {
      const r = await PL.sfx(project, { text: input.descripcion, seconds: input.segundos, name: input.nombre })
      ctx.changed(r.path)
      return txt(`Efecto guardado en ${r.path} · ${r.duration} s.`)
    }
    case 'oa_transcribir': {
      const { abs } = resolvePath({ ...ctx, projectId: project }, input.path)
      const r = await PL.transcribe(abs, { provider: input.proveedor, lang: input.idioma })
      return txt(`${r.provider}${r.lang ? ' · ' + r.lang : ''}\n${r.text}\n\nPalabras (inicio-fin s): ` + r.words.map((w) => `${w.w}@${w.start}-${w.end}`).join(' '))
    }
    case 'oa_consultar_ia': {
      const imgs = (input.imagenes || []).map((f: string) => resolvePath({ ...ctx, projectId: project }, f).abs)
      const r = await PL.ask({ prompt: input.consulta, provider: input.proveedor, model: input.modelo, images: imgs, system: input.sistema })
      return txt(`[${r.provider} · ${r.model}]\n${r.text}`)
    }
    case 'oa_resolver_nota': {
      const p = readProject(project)
      const tid = input.timeline || p.activeTimeline
      const tl = readTimeline(project, tid)
      const before = (tl.notes || []).length
      tl.notes = (tl.notes || []).filter((n) => n.id !== input.id)
      writeTimeline(project, tid, tl)
      ctx.changed(p.timelines.find((t) => t.id === tid)?.file || 'timelines/main.json')
      return txt(JSON.stringify({ removed: before - tl.notes.length }))
    }
  }
  throw new Error('Herramienta desconocida: ' + name)
}

export { assetUsage, base64ToBytes }
