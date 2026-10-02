/**
 * Lo que comparten el analizador de videos de la PC (electron/analyzer.ts: FFmpeg y yt-dlp) y el del iPhone
 * (src/android/backend/analyzer.ts: AVFoundation): las fases, las cuentas sobre lo medido (cortes, planos,
 * fotogramas clave, tiras de movimiento, paleta), las instrucciones para Claude y la guía de la plantilla. Sin Node.
 */

export type Phase = 'descarga' | 'video' | 'escenas' | 'fotogramas' | 'colores' | 'audio' | 'narracion' | 'ia' | 'vista'
export const PHASES: Array<{ id: Phase; label: string }> = [
  { id: 'descarga', label: 'Obtener el video' }, { id: 'video', label: 'Formato y duración' }, { id: 'escenas', label: 'Cortes, planos y movimiento' },
  { id: 'fotogramas', label: 'Fotogramas clave' }, { id: 'colores', label: 'Paleta de colores' }, { id: 'audio', label: 'Voz, silencios y sonoridad' },
  { id: 'narracion', label: 'Narración' }, { id: 'ia', label: 'Análisis con Claude y escena de muestra' }, { id: 'vista', label: 'Vista previa' },
]
export type AnalyzeOpts = { source: string; transcribe?: boolean; model?: string; effort?: string; maxMinutes?: number; notes?: string }
export type AnalyzeEvent = { id: string; phase?: Phase; status?: 'run' | 'ok' | 'skip' | 'error'; message?: string; progress?: number; log?: string; done?: boolean; error?: string; result?: AnalyzeResult }
export type Swatch = { hex: string; share: number }
export type AnalyzeStats = { duration: number; analyzed: number; width: number; height: number; fps: number; shots: number; avgShot: number; cutsPerMin: number; motion: number; speechRatio: number | null; pauses: number; lufs: number | null; wpm: number | null; palette: Swatch[]; transcript: 'subtitulos' | 'plugin' | 'no' }
export type AnalyzeResult = { id: string; workspace: string; title: string; source: string; isUrl: boolean; stats: AnalyzeStats; analysis: any; sheet: string; preview?: string; sceneOk: boolean }
type Word = { w: string; start: number; end: number }

export const isUrl = (s: string) => /^https?:\/\//i.test(s.trim())
const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('')

/** Paleta dominante por k-means (determinista) sobre píxeles RGB muestreados. */
export function kmeansPalette(buf: Uint8Array, k = 9): Swatch[] {
  const n = Math.floor(buf.length / 3)
  if (!n) return []
  const step = Math.max(1, Math.floor(n / 50000))
  const pts: number[][] = []
  for (let i = 0; i < n; i += step) pts.push([buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2]])
  // Inicialización por el punto más lejano (determinista).
  const cents: number[][] = [pts[Math.floor(pts.length / 2)].slice()]
  const d2 = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
  while (cents.length < k) {
    let best = 0, bi = 0
    for (let i = 0; i < pts.length; i += 7) { const d = Math.min(...cents.map((c) => d2(c, pts[i]))); if (d > best) { best = d; bi = i } }
    if (best < 60) break
    cents.push(pts[bi].slice())
  }
  const asg = new Int32Array(pts.length)
  for (let it = 0; it < 14; it++) {
    const sum = cents.map(() => [0, 0, 0, 0])
    for (let i = 0; i < pts.length; i++) {
      let bj = 0, bd = Infinity
      for (let j = 0; j < cents.length; j++) { const d = d2(cents[j], pts[i]); if (d < bd) { bd = d; bj = j } }
      asg[i] = bj; const s = sum[bj]; s[0] += pts[i][0]; s[1] += pts[i][1]; s[2] += pts[i][2]; s[3]++
    }
    cents.forEach((c, j) => { const s = sum[j]; if (s[3]) { c[0] = s[0] / s[3]; c[1] = s[1] / s[3]; c[2] = s[2] / s[3] } })
  }
  const count = cents.map(() => 0)
  for (let i = 0; i < pts.length; i++) count[asg[i]]++
  let sw = cents.map((c, j) => ({ c, share: count[j] / pts.length }))
  // Unir colores casi iguales.
  sw.sort((a, b) => b.share - a.share)
  const merged: typeof sw = []
  for (const x of sw) { const m = merged.find((y) => d2(y.c, x.c) < 22 ** 2); if (m) m.share += x.share; else merged.push({ ...x }) }
  sw = merged.filter((x) => x.share >= 0.008).sort((a, b) => b.share - a.share)
  return sw.slice(0, 10).map((x) => ({ hex: hex(x.c[0], x.c[1], x.c[2]), share: +x.share.toFixed(3) }))
}

/** Subtítulos VTT (incluidos los automáticos de YouTube, que repiten líneas) → segmentos limpios. */
export function parseVtt(txt: string) {
  const segs: Array<{ start: number; end: number; text: string }> = []
  const ts = (s: string) => { const p = s.trim().split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1] }
  const blocks = txt.replace(/\r/g, '').split(/\n\n+/)
  const seen = new Set<string>()
  for (const b of blocks) {
    const m = /(\d[\d:.]+)\s+-->\s+(\d[\d:.]+)/.exec(b)
    if (!m) continue
    const lines = b.split('\n').slice(b.split('\n').findIndex((l) => l.includes('-->')) + 1)
    for (const l of lines) {
      const clean = l.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim()
      if (!clean || seen.has(clean)) continue
      seen.add(clean)
      segs.push({ start: ts(m[1]), end: ts(m[2]), text: clean })
    }
  }
  return segs
}

/**
 * Cortes, planos y movimiento a partir del puntaje de cambio de escena (0-1, el `scene` de FFmpeg) de cada cuadro
 * muestreado a 5 por segundo: es corte si pasa 0,32 y hace más de medio segundo del anterior; el movimiento es el
 * promedio de lo que no es corte, también por segundo (para elegir los momentos "animados").
 */
export function shotsFromScores(scores: Array<[number, number]>, maxSec: number) {
  const cuts: number[] = []
  for (const [t, s] of scores) if (s > 0.32 && (!cuts.length || t - cuts[cuts.length - 1] > 0.5)) cuts.push(t)
  const bounds = [0, ...cuts, maxSec]
  const shots = bounds.slice(1).map((b, i) => ({ start: bounds[i], end: b })).filter((s) => s.end - s.start > 0.2)
  const avgShot = shots.length ? maxSec / shots.length : maxSec
  const nonCut = scores.filter(([, s]) => s <= 0.32).map(([, s]) => s)
  const motion = nonCut.length ? nonCut.reduce((a, b) => a + b, 0) / nonCut.length : 0
  const perSec = new Map<number, number>()
  for (const [t, s] of scores) if (s <= 0.32) perSec.set(Math.floor(t), (perSec.get(Math.floor(t)) || 0) + s)
  return { cuts, shots, avgShot, motion, perSec }
}

/** Los fotogramas clave: la mitad de cada plano (hasta 30) y, si son pocos, repartidos hasta 14. */
export function keyframeTimes(shots: Array<{ start: number; end: number }>, maxSec: number) {
  let times = shots.map((s) => +(s.start + (s.end - s.start) * 0.5).toFixed(2))
  const MAX = 30
  if (times.length > MAX) times = Array.from({ length: MAX }, (_, i) => times[Math.floor((i * times.length) / MAX)])
  const extra = Math.max(0, 14 - times.length)
  for (let i = 0; i < extra; i++) times.push(+((maxSec * (i + 0.5)) / extra).toFixed(2))
  return [...new Set(times)].sort((a, b) => a - b)
}

/**
 * Los segundos con más movimiento interno, para las tiras de movimiento (6 cuadros cada 0,25 s): lejos entre sí y sin
 * un corte en el medio. `ok` prueba cada candidato (en la PC, que FFmpeg haya podido sacar la tira).
 */
export async function stripSeconds(perSec: Map<number, number>, cuts: number[], maxSec: number, ok: (s: number, n: number) => Promise<boolean> | boolean = () => true) {
  const moving = [...perSec.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s)
  const out: number[] = []
  for (const s of moving) {
    if (out.length >= 6) break
    if (out.some((x) => Math.abs(x - s) < Math.max(4, maxSec / 12)) || cuts.some((c) => c > s && c < s + 1.6)) continue
    if (await ok(s, out.length + 1)) out.push(s)
  }
  return out
}

/** El espacio de trabajo: un proyecto oculto con la orientación del video y una escena de muestra de 15 s. */
export function workspaceProject(workspace: string, title: string, W: number, H: number) {
  const vertical = H > W * 1.1, square = !vertical && Math.abs(W - H) < W * 0.1
  const PW = vertical ? 1080 : 1920, PH = vertical ? 1920 : square ? 1920 : 1080
  const project = { format: 'openanimator/1', id: workspace, name: `Análisis · ${title}`, width: PW, height: PH, fps: 30, background: '#000000', timelines: [{ id: 'main', name: 'Muestra', file: 'timelines/main.json' }], activeTimeline: 'main', createdAt: new Date().toISOString() }
  const timeline = { format: 'oa-timeline/1', duration: 15, notes: [], tracks: [
    { id: 'escenas', name: 'Escenas', type: 'scene', clips: [{ id: 'c-estilo', src: 'scenes/estilo.html', start: 0, duration: 15, in: 0, name: 'Muestra de estilo' }] },
    { id: 'voz', name: 'Voz', type: 'audio', clips: [] }, { id: 'musica', name: 'Música', type: 'audio', clips: [], volume: 0.3 }, { id: 'sfx', name: 'SFX', type: 'audio', clips: [] },
  ] }
  return { PW, PH, project, timeline }
}

/** La narración transcripta, en líneas «[segundo] texto» (cortadas en el punto o cada 18 palabras). */
export function transcriptLines(words: Word[]) {
  const lines: string[] = []
  let cur: Word[] = []
  for (const w of words) { cur.push(w); if (/[.?!]$/.test(w.w) || cur.length >= 18) { lines.push(`[${cur[0].start.toFixed(1)}] ${cur.map((x) => x.w).join(' ')}`); cur = [] } }
  if (cur.length) lines.push(`[${cur[0].start.toFixed(1)}] ${cur.map((x) => x.w).join(' ')}`)
  return lines
}

/**
 * Las instrucciones para Claude. `measured`: con qué se midió (FFmpeg en la PC, el iPhone); `fonts`: ejemplos de
 * fuentes locales del equipo donde se va a usar la plantilla.
 */
export function analysisPrompt(PW: number, PH: number, o: { notes?: string; measured?: string; fonts?: string } = {}) {
  const measured = o.measured || 'con FFmpeg'
  const fonts = o.fonts || 'Segoe UI, Georgia, Bahnschrift, Consolas…'
  return `Sos director/a de arte y motion designer. Analizá un video de referencia para REPLICAR SU ESTILO en OpenAnimator (escenas HTML/SVG/JS en función del tiempo). Trabajá SOLO dentro de esta carpeta.

MATERIAL (en _analisis/):
- datos.json: métricas medidas ${measured} (duración, planos y cortes, movimiento, paleta por k-means con proporción, voz/silencios, sonoridad, palabras por minuto) y la lista de fotogramas con su segundo.
- hoja.jpg: hoja de contactos con todos los fotogramas clave en orden.
- fotogramas/f###.jpg: cada fotograma clave en grande. Mirá TODOS (usá Read sobre cada imagen).
- mov#.jpg: tiras de 6 cuadros cada 0,25 s en los momentos con más movimiento: sirven para deducir los TIPOS de animación (entradas, easing, escalas, trazos que se dibujan, parallax, cámara…).
- transcripcion.txt (si existe): narración con tiempos. fuente.json (si existe): título y descripción.
- guia-escenas-html.md y guia-direccion-artistica.md: el contrato de escena de OpenAnimator y criterios de diseño. Leelas antes de escribir la escena.
${o.notes ? `\nPEDIDO DEL USUARIO: ${o.notes}\n` : ''}
ENTREGABLES:
1) _analisis/analisis.json (JSON válido, en español), con esta forma:
{
  "titulo": "nombre corto y evocador del estilo",
  "resumen": "2-3 frases: qué tipo de video es y qué lo hace reconocible",
  "formato": { "relacion": "16:9", "tipo": "explicativo animado / reel / documental / …", "publico": "…" },
  "paleta": [ { "hex": "#RRGGBB", "nombre": "…", "uso": "fondo | texto | acento | …" } ],
  "tipografia": [ { "rol": "títulos | cuerpo | datos", "descripcion": "familia, peso, caja, tracking…", "sugerencia": "fuente local equivalente (${fonts})" } ],
  "animaciones": [ { "tipo": "…", "descripcion": "cómo se mueve", "duracion_s": 0.5, "easing": "…", "frecuencia": "alta | media | baja" } ],
  "transiciones": [ { "tipo": "…", "descripcion": "…", "frecuencia": "…" } ],
  "formas": [ "…" ], "objetos": [ "íconos, personajes, gráficos, fotos, mapas…" ], "texturas_y_efectos": [ "…" ],
  "composicion": "grilla, márgenes, jerarquía, uso del espacio, cámara",
  "ritmo": { "descripcion": "…", "plano_promedio_s": 0, "cortes_por_minuto": 0 },
  "narracion": { "tipo": "voz en off | sin voz | texto en pantalla | diálogo", "tono": "…", "persona": "…", "estructura": "gancho → … → cierre", "velocidad_ppm": 0, "recursos": [ "…" ] },
  "sonido": { "musica": "…", "efectos": "…" },
  "texto_en_pantalla": "cuánto texto, cómo aparece, qué resalta",
  "claves_para_replicar": [ "reglas concretas y accionables" ],
  "evitar": [ "lo que rompería el estilo" ],
  "plantilla": { "nombre": "…", "descripcion": "1-2 frases para la galería de plantillas", "etiquetas": [ "…" ] }
}
Basate en lo que VES y en las métricas (no inventes lo que no se ve; si algo no se puede saber, decilo).

2) brief.md: guía de estilo completa para que otra IA produzca videos NUEVOS con este estilo (paleta con hex y usos, tipografía, animaciones con duraciones y easing, transiciones, formas y objetos, composición, ritmo, narración con un ejemplo de guion original de 3-4 frases, sonido, checklist). Arriba: "# Brief" + un campo "Tema del video: {{PROJECT_NAME}}".

3) scenes/estilo.html: una escena de MUESTRA de 12 a 20 s, ${PW}×${PH}, que demuestre el estilo con contenido ORIGINAL de ejemplo (sí: paleta, tipografía, formas, tipos de animación, transiciones, ritmo, composición; NO: logos, marcas, personajes reconocibles ni textos copiados del video). Cumplí el contrato (window.__oa = { duration, render(t) }, pura y determinista, todo local, sin CDN). Mostrá 3-4 "momentos" que cubran las animaciones y transiciones típicas. Si cambiás la duración, actualizá timelines/main.json (clip c-estilo y duration).

4) VERIFICÁ la escena con mcp__openanimator__oa_hoja_contactos y oa_ver_fotogramas (y oa_auditar_layout): compará con hoja.jpg y corregí hasta que se parezca en estilo y no haya textos superpuestos ni fuera de cuadro.

No uses la terminal. Terminá con un resumen de 3 líneas.`
}

/** Cómo contar en el registro lo que hace Claude (del stream-json de Claude Code): una línea por herramienta. */
export function describeTool(name: string, input: any) {
  const TOOL: Record<string, string> = { Read: 'Mira', Write: 'Escribe', Edit: 'Edita', MultiEdit: 'Edita', Glob: 'Busca', Grep: 'Busca', TodoWrite: 'Planifica', Skill: 'Lee la guía' }
  const n = String(name).replace(/^mcp__openanimator__/, '')
  const f = String(input?.file_path || input?.path || input?.skill || '').replace(/\\/g, '/').split('/').slice(-2).join('/')
  const image = n === 'Read' && /\.jpe?g$/i.test(f)
  const label = n === 'oa_ver_fotogramas' ? 'Verifica fotogramas de su escena' : n === 'oa_hoja_contactos' ? 'Revisa su escena con una hoja de contactos' : n === 'oa_auditar_layout' ? 'Audita el layout' : `${TOOL[n] || n} ${f}`
  return { label: label.trim(), image, write: n === 'Write', check: /^oa_/.test(n), file: f }
}

/** PLANTILLA.md legible para la IA a partir del análisis (además de brief.md). */
export function guideFromAnalysis(name: string, a: any) {
  const L: string[] = [`# Plantilla «${name}»`, '', a.resumen || '', '', 'Plantilla creada analizando un video de referencia. Seguí `brief.md` (guía de estilo) y usá `scenes/estilo.html` como base visual: mismos colores, tipografía, formas, animaciones y ritmo, con contenido nuevo.', '']
  if (a.paleta?.length) L.push('## Paleta', ...a.paleta.map((p: any) => `- ${p.hex} — ${p.nombre || ''}${p.uso ? ` (${p.uso})` : ''}`), '')
  if (a.animaciones?.length) L.push('## Animaciones', ...a.animaciones.map((x: any) => `- **${x.tipo}**: ${x.descripcion || ''}${x.duracion_s ? ` · ${x.duracion_s} s` : ''}${x.easing ? ` · ${x.easing}` : ''}`), '')
  if (a.claves_para_replicar?.length) L.push('## Claves', ...a.claves_para_replicar.map((x: string) => `- ${x}`), '')
  if (a.evitar?.length) L.push('## Evitar', ...a.evitar.map((x: string) => `- ${x}`), '')
  return L.join('\n')
}
