/**
 * Instrucciones de sistema de Claude en la tablet, para los dos caminos: la API de Claude (agent.ts)
 * y el Claude Code del usuario en Termux (code.ts, donde van como --append-system-prompt).
 */
import { fs } from './fsx'
import { readProject } from './projects'
import { ensureNotes, NOTES_FILE } from './settings'
import { aiGuide, listSkills } from './tools'

const common = (device: string) => [
  'Antes de crear o cambiar escenas seguí la guía de abajo y cargá con Skill las skills que correspondan (dirección artística, escenas, voz y tiempos).',
  'VERIFICÁ SIEMPRE tu trabajo visualmente (oa_ver_fotogramas, oa_hoja_contactos, oa_auditar_layout) antes de decir que terminaste.',
  'Las notas que el usuario deja en el timeline (oa_proyecto → notas, cada una con su id y su momento) son pedidos para vos: cuando termines el cambio que pide una nota, borrala enseguida con oa_resolver_nota (si no, sigue en el timeline como pendiente). No borres las que no resolviste.',
  `${device} tiene mucha menos potencia y memoria que una PC, y la vista previa comparte el motor con la interfaz: una escena pesada traba la app y puede cerrarla. Hacé escenas livianas (skill escenas-html, «Rendimiento»); los fotogramas vienen con lo que cuesta cada escena, medido en el equipo: si dice que es pesada, simplificala.`,
  'Si hacen falta imágenes, voz, efectos de sonido o la opinión de otro modelo, usá los plugins del usuario (oa_plugins, oa_generar_imagen, oa_generar_voz, oa_generar_sfx, oa_transcribir, oa_consultar_ia): pueden tener costo, así que usalos con criterio.',
  'Los archivos que el usuario adjunta al chat quedan en la carpeta adjuntos/ del proyecto: leelos con Read cuando los mencione.',
  'El editor recarga solo cuando guardás archivos. Respondé en el idioma del usuario.',
]
const BASE = {
  api: [
    'Estás trabajando dentro de OpenAnimator para Android (en una tablet), un estudio de video donde las escenas son HTML/SVG/JS en función del tiempo.',
    'Tu carpeta de trabajo es la del proyecto abierto: todas las rutas son relativas a ella (p. ej. scenes/intro.html, timelines/main.json).',
    'Tenés Read, Write, Edit, Glob y Grep para los archivos del proyecto, Skill para cargar las guías de OpenAnimator y las herramientas oa_* de la app. No hay terminal, ffmpeg ni ffprobe: todo se hace con estas herramientas. Para generar o procesar archivos con código (sonidos sintetizados con Web Audio, imágenes dibujadas con canvas, cálculos) está oa_ejecutar_js, que corre JavaScript aislado y guarda en el proyecto.',
    ...common('La tablet'),
  ].join(' '),
  code: [
    'Estás trabajando dentro de OpenAnimator para Android (en una tablet), un estudio de video donde las escenas son HTML/SVG/JS en función del tiempo. Corrés en Termux, en la misma tablet.',
    'Los archivos del proyecto viven en la app, NO en tu disco: usá SIEMPRE las herramientas mcp__openanimator__Read, Write, Edit, Glob y Grep, con rutas relativas a la carpeta del proyecto (p. ej. scenes/intro.html, timelines/main.json).',
    'mcp__openanimator__Skill carga las guías de OpenAnimator y mcp__openanimator__oa_* son las herramientas de la app. No hay terminal, ffmpeg ni ffprobe: todo se hace con estas herramientas. Para generar o procesar archivos con código (sonidos sintetizados con Web Audio, imágenes dibujadas con canvas, cálculos) está oa_ejecutar_js, que corre JavaScript aislado y guarda en el proyecto.',
    ...common('La tablet'),
  ].join(' '),
  web: [
    'Estás trabajando dentro de OpenAnimator para iPhone, un estudio de video donde las escenas son HTML/SVG/JS en función del tiempo. Corrés dentro de la app, en el mismo teléfono.',
    'Los archivos del proyecto viven en la app, NO en tu disco: usá SIEMPRE las herramientas mcp__openanimator__Read, Write, Edit, Glob y Grep, con rutas relativas a la carpeta del proyecto (p. ej. scenes/intro.html, timelines/main.json).',
    'mcp__openanimator__Skill carga las guías de OpenAnimator y mcp__openanimator__oa_* son las herramientas de la app. No hay terminal, ffmpeg ni ffprobe: todo se hace con estas herramientas. Para generar o procesar archivos con código (sonidos sintetizados con Web Audio, imágenes dibujadas con canvas, cálculos) está oa_ejecutar_js, que corre JavaScript aislado y guarda en el proyecto.',
    'La pantalla es la de un teléfono vertical: el usuario lee tus respuestas en poco espacio.',
    ...common('El teléfono'),
  ].join(' '),
}
const SAVER_RULES = [
  '1) Las imágenes son lo más caro: para revisar usá oa_hoja_contactos (una sola imagen con muchos instantes) antes que varios oa_ver_fotogramas; pedí width 640-960 salvo que necesites ver un detalle fino, y como máximo 4 fotogramas por verificación. No mires de nuevo lo que no cambió.',
  '2) No leas archivos grandes enteros: usá Grep o Read con offset/limit. Si un adjunto es largo (más de ~500 líneas), leelo una sola vez, guardá un resumen con lo esencial en scripts/ y después trabajá con ese resumen.',
  '3) No vuelvas a leer un archivo que ya leíste y no cambió. Para cambios chicos usá Edit, no reescribas archivos completos.',
  '4) Respuestas cortas: no repitas el plan, no pegues código ni el contenido de archivos en el chat; contá en 1-3 líneas qué hiciste.',
  '5) Trabajá por tandas: terminá una escena o sección completa, verificala una vez y seguí; no hagas muchas verificaciones intermedias.',
]
export const SAVER_API = ['MODO AHORRO ACTIVADO (cada token se cobra en la cuenta de la API del usuario; cuidalo):', ...SAVER_RULES].join(' ')
const SAVER_PLAN = ['MODO AHORRO ACTIVADO (el usuario usa su plan de Claude, con un límite de uso cada 5 horas; cuidalo):', ...SAVER_RULES].join(' ')
export const PLAN_NOTE = '(Modo planificar, puesto por el usuario en la app: todavía no modifiques archivos ni generes medios. Investigá lo necesario con las herramientas de lectura y presentá un plan claro paso a paso; cuando el usuario lo apruebe va a cambiar el modo.)'

function readNotes() {
  try { ensureNotes(); return fs.readText(NOTES_FILE).trim() } catch { return '' }
}

/** Instrucciones para una conversación nueva (se congelan con ella). */
export async function buildSystem(projectId: string, flavor: 'api' | 'code' | 'web', saver: boolean, extra: string) {
  const p = readProject(projectId)
  const notes = readNotes()
  let guide = (await aiGuide())
    .replace(/^@NOTAS-IA\.md\s*$/m, notes ? `## Notas del usuario para la IA (NOTAS-IA.md)\n\n${notes.replace(/^#\s+Notas para la IA\s*\n/, '')}` : '')
  // Por la API las herramientas se llaman oa_*; en Claude Code llegan por el MCP «openanimator», como en la PC.
  if (flavor === 'api') guide = guide.replace(/ \(MCP `openanimator`\)/g, ' (oa_*)')
  const skills = await listSkills()
  const parts = [
    BASE[flavor],
    guide ? `# Guía de OpenAnimator\n\n${guide.trim()}` : '',
    skills.length ? `# Skills de OpenAnimator (cargalas con la herramienta Skill)\n\n${skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')}` : '',
    `# Proyecto abierto\n\nId: ${p.id} · Nombre: ${p.name} · ${p.width}×${p.height} a ${p.fps} fps.`,
    saver ? (flavor === 'api' ? SAVER_API : SAVER_PLAN) : '',
    extra.trim() ? `Instrucciones del usuario (ajustes de OpenAnimator): ${extra.trim()}` : '',
  ]
  return parts.filter(Boolean).join('\n\n')
}
