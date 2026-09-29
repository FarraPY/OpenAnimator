#!/usr/bin/env node
/*
 * Servidor MCP de OpenAnimator (stdio, JSON-RPC 2.0, sin dependencias).
 * Le da a la IA herramientas para VER y VERIFICAR el video mientras lo crea.
 * Habla con la app abierta a través de la API local (data/api.json).
 *
 * Se ejecuta con el propio OpenAnimator.exe (ELECTRON_RUN_AS_NODE=1) o con node.
 */
'use strict'
const fs = require('fs')
const path = require('path')
const http = require('http')
const readline = require('readline')

const DATA_DIR = process.env.OA_DATA_DIR || path.resolve(__dirname, '..', '..', 'data')
const DEFAULT_PROJECT = process.env.OA_PROJECT || (() => {
  const cwd = process.cwd()
  return fs.existsSync(path.join(cwd, 'project.json')) ? path.basename(cwd) : ''
})()

function api(name, body) {
  return new Promise((resolve, reject) => {
    let cfg
    try { cfg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'api.json'), 'utf8')) } catch (e) {
      return reject(new Error('OpenAnimator no está abierto (no hay data/api.json). Abrí la app para usar esta herramienta.'))
    }
    const data = JSON.stringify(body)
    const req = http.request({ host: '127.0.0.1', port: cfg.port, path: '/' + name, method: 'POST', headers: { 'Content-Type': 'application/json', 'x-oa-token': cfg.token, 'Content-Length': Buffer.byteLength(data) }, timeout: 600000 }, (res) => {
      let out = ''
      res.on('data', (d) => { out += d })
      res.on('end', () => {
        try { const j = JSON.parse(out); j.ok ? resolve(j.result) : reject(new Error(j.error)) } catch (e) { reject(new Error('Respuesta inválida de la app (' + res.statusCode + ')')) }
      })
    })
    req.on('error', (e) => reject(new Error('No se pudo conectar con OpenAnimator (' + e.message + '). Reintentá en unos segundos: la app restaura la conexión sola; no hace falta reiniciarla.')))
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.end(data)
  })
}

const P = { type: 'string', description: 'Id del proyecto (por defecto, el de la carpeta actual)' }
const TL = { type: 'string', description: 'Id del timeline (por defecto, el activo)' }
const TOOLS = [
  { name: 'oa_proyecto', description: 'Resumen del proyecto: resolución, fps, timelines, pistas, clips y notas del usuario ancladas al tiempo.', inputSchema: { type: 'object', properties: { project: P, timeline: TL } } },
  { name: 'oa_ver_fotogramas', description: 'Renderiza el video en los instantes indicados (segundos del timeline) y devuelve las imágenes para que las MIRES. Usalo después de cada cambio visual. Máx. 8 instantes.', inputSchema: { type: 'object', properties: { project: P, timeline: TL, times: { type: 'array', items: { type: 'number' } }, width: { type: 'number', description: 'Ancho de la imagen (por defecto 960; subilo a 1280-1920 sólo para revisar detalles finos: cada imagen grande consume mucho contexto)' } }, required: ['times'] } },
  { name: 'oa_hoja_contactos', description: 'Hoja de contactos: N fotogramas repartidos en un rango (o instantes dados) en una sola imagen con la hora de cada uno. Ideal para revisar ritmo, variedad y consistencia de todo el video.', inputSchema: { type: 'object', properties: { project: P, timeline: TL, count: { type: 'number', description: 'Cantidad de fotogramas (2-48, por defecto 12)' }, from: { type: 'number' }, to: { type: 'number' }, times: { type: 'array', items: { type: 'number' } }, cols: { type: 'number' }, width: { type: 'number', description: 'Ancho de cada miniatura (por defecto 480)' } } } },
  { name: 'oa_auditar_layout', description: 'Recorre el timeline cada `step` segundos y reporta textos fuera de cuadro y textos superpuestos (con el rango de tiempo donde ocurre). Debe dar 0 incidencias antes de entregar. Un audit limpio NO reemplaza mirar fotogramas.', inputSchema: { type: 'object', properties: { project: P, timeline: TL, step: { type: 'number', description: 'Paso en segundos (por defecto 0.5)' }, from: { type: 'number' }, to: { type: 'number' } } } },
  { name: 'oa_medios', description: 'Lista los archivos del proyecto (escenas, video, audio, imágenes) con tamaño.', inputSchema: { type: 'object', properties: { project: P } } },
  { name: 'oa_info_medio', description: 'Duración y streams de un archivo de audio/video (ruta relativa al proyecto o absoluta).', inputSchema: { type: 'object', properties: { project: P, path: { type: 'string' } }, required: ['path'] } },
  { name: 'oa_plugins', description: 'Plugins de IA configurados por el usuario (ChatGPT/Codex, OpenAI, Gemini, OpenRouter, ElevenLabs, Fish Audio, Whisper local) y qué puede hacer cada uno. Consultalo antes de generar imágenes, voz o sonidos.', inputSchema: { type: 'object', properties: {} } },
  { name: 'oa_generar_imagen', description: 'Genera una imagen con el plugin del usuario (ChatGPT con su cuenta vinculada, OpenAI o Gemini) y la guarda en assets/ia/ del proyecto. Devuelve la ruta relativa para usarla en escenas (<img src="../assets/ia/…">) o en una pista de video, y una vista previa. Tarda 20-90 s. Describí estilo, encuadre y colores con precisión; pedí fondo transparente para recortes/íconos.', inputSchema: { type: 'object', properties: { project: P, prompt: { type: 'string', description: 'Descripción detallada de la imagen (idealmente en inglés)' }, nombre: { type: 'string', description: 'Nombre corto del archivo' }, formato: { type: 'string', enum: ['horizontal', 'vertical', 'cuadrado'] }, fondo_transparente: { type: 'boolean' }, proveedor: { type: 'string', enum: ['codex', 'openai', 'gemini'], description: 'Opcional: por defecto el preferido del usuario' }, referencia: { type: 'string', description: 'Imagen de referencia (ruta del proyecto) para mantener estilo o personaje' } }, required: ['prompt'] } },
  { name: 'oa_generar_voz', description: 'Narración con ElevenLabs o Fish Audio (plugins del usuario). Guarda un MP3 en assets/voz/ y devuelve su duración y, con ElevenLabs, el tiempo de cada palabra (para sincronizar animaciones). Generá por párrafo o sección, no todo el guion junto. Con Fish Audio S2/S2.1 (por defecto s2.1-pro-free, GRATIS) el texto admite indicaciones entre [corchetes] en lenguaje natural ([calm], [excited], [whispering], [emphasis], [break], [long-break]…) y diálogos con <|speaker:0|>…<|speaker:1|>… pasando `voces`. Leé la skill voz-fish-audio antes de usar Fish.', inputSchema: { type: 'object', properties: { project: P, texto: { type: 'string' }, proveedor: { type: 'string', enum: ['elevenlabs', 'fish'] }, voz: { type: 'string', description: 'Id de voz (opcional; ver oa_voces). Por defecto, la elegida por el usuario' }, voces: { type: 'array', items: { type: 'string' }, description: 'Fish S2/S2.1: una voz por hablante, en el orden de <|speaker:0|>, <|speaker:1|>…' }, modelo: { type: 'string', enum: ['s2.1-pro-free', 's2.1-pro', 's2-pro', 's1'], description: 'Fish: por defecto el de los ajustes (s2.1-pro-free es gratis)' }, temperatura: { type: 'number', description: 'Fish 0-1 (0.7): más alto = más expresiva y variable' }, nombre: { type: 'string' }, velocidad: { type: 'number', description: '0.7-1.3' } }, required: ['texto'] } },
  { name: 'oa_voces', description: 'Lista voces disponibles de ElevenLabs o Fish Audio (id, nombre, info). En Fish, `buscar` acepta un código de idioma ("es"), un título ("narrador") o ambos ("es: narrador").', inputSchema: { type: 'object', properties: { proveedor: { type: 'string', enum: ['elevenlabs', 'fish'] }, buscar: { type: 'string' } } } },
  { name: 'oa_generar_sfx', description: 'Efecto de sonido con ElevenLabs a partir de una descripción (whoosh, pop, ambiente…). Guarda un MP3 en assets/sfx/. Generá cada sonido distinto una vez y reusalo: un clip por efecto en la pista SFX, en el momento exacto del evento (no premezcles varios efectos en un archivo).', inputSchema: { type: 'object', properties: { project: P, descripcion: { type: 'string' }, segundos: { type: 'number', description: '0.5-22' }, nombre: { type: 'string' } }, required: ['descripcion'] } },
  { name: 'oa_transcribir', description: 'Transcribe un audio/video del proyecto con tiempos por palabra. Por defecto usa Whisper LOCAL (en la GPU del usuario, gratis, sin internet, tiempos por palabra precisos): preferilo siempre; ElevenLabs/OpenAI/Fish sólo si el usuario lo pide. Útil para sincronizar escenas con una narración y para el control de calidad de voces generadas.', inputSchema: { type: 'object', properties: { project: P, path: { type: 'string' }, proveedor: { type: 'string', enum: ['whisper', 'elevenlabs', 'openai', 'fish'], description: 'Omitilo: usa Whisper local' }, idioma: { type: 'string', description: 'Código ISO, p. ej. es' } }, required: ['path'] } },
  { name: 'oa_consultar_ia', description: 'Consulta a otro modelo de IA configurado por el usuario (ChatGPT con su cuenta, OpenAI API, Gemini u OpenRouter): segunda opinión, ideas, revisión de un guion o de fotogramas (imagenes = rutas del proyecto).', inputSchema: { type: 'object', properties: { project: P, consulta: { type: 'string' }, proveedor: { type: 'string', enum: ['codex', 'openai', 'gemini', 'openrouter'] }, modelo: { type: 'string' }, imagenes: { type: 'array', items: { type: 'string' } }, sistema: { type: 'string', description: 'Instrucciones de sistema opcionales' } }, required: ['consulta'] } },
  { name: 'oa_resolver_nota', description: 'Borra una nota del usuario (annotations) una vez que hiciste el cambio pedido.', inputSchema: { type: 'object', properties: { project: P, timeline: TL, id: { type: 'string' } }, required: ['id'] } },
]

async function call(name, args) {
  args = args || {}
  switch (name) {
    case 'oa_plugins': return [{ type: 'text', text: JSON.stringify(await api('plugins', {}), null, 1) }]
    case 'oa_voces': return [{ type: 'text', text: JSON.stringify(await api('voices', { provider: args.proveedor, query: args.buscar }), null, 1) }]
  }
  const project = args.project || DEFAULT_PROJECT
  if (!project) throw new Error('Indicá el proyecto (parámetro project).')
  const base = { project, timeline: args.timeline }
  switch (name) {
    case 'oa_proyecto': return [{ type: 'text', text: JSON.stringify(await api('info', base), null, 1) }]
    case 'oa_medios': return [{ type: 'text', text: JSON.stringify(await api('assets', base), null, 1) }]
    case 'oa_info_medio': return [{ type: 'text', text: JSON.stringify(await api('probe', { ...base, path: args.path })) }]
    case 'oa_generar_imagen': {
      const aspect = { horizontal: 'landscape', vertical: 'portrait', cuadrado: 'square' }[args.formato] || 'landscape'
      const r = await api('genImage', { ...base, prompt: args.prompt, name: args.nombre, aspect, transparent: args.fondo_transparente, provider: args.proveedor, reference: args.referencia })
      const alpha = r.transparent == null ? '' : r.transparent > 1 ? ` Fondo transparente: sí (${r.transparent} % de píxeles transparentes).` : ' Sin transparencia (fondo opaco).'
      const out = [{ type: 'text', text: `Imagen guardada en ${r.path} (${r.provider}).${alpha} Desde una escena en scenes/: src="../${r.path}".` }]
      if (r.preview) out.push({ type: 'image', data: r.preview, mimeType: 'image/png' })
      return out
    }
    case 'oa_generar_voz': {
      const r = await api('tts', { ...base, text: args.texto, provider: args.proveedor, voice: args.voz, voices: args.voces, model: args.modelo, temperature: args.temperatura, name: args.nombre, speed: args.velocidad })
      const words = r.words ? '\nPalabras (inicio s): ' + r.words.map((w) => `${w.w}@${w.start}`).join(' ') : '\n(Sin tiempos por palabra: usá oa_transcribir si los necesitás.)'
      return [{ type: 'text', text: `Voz guardada en ${r.path} · ${r.duration} s · ${r.provider}. Agregala a la pista de voz del timeline.${words}` }]
    }
    case 'oa_generar_sfx': {
      const r = await api('sfx', { ...base, text: args.descripcion, seconds: args.segundos, name: args.nombre })
      return [{ type: 'text', text: `Efecto guardado en ${r.path} · ${r.duration} s.` }]
    }
    case 'oa_transcribir': {
      const r = await api('transcribe', { ...base, path: args.path, provider: args.proveedor, lang: args.idioma })
      return [{ type: 'text', text: `${r.provider}${r.lang ? ' · ' + r.lang : ''}
${r.text}

Palabras (inicio-fin s): ` + r.words.map((w) => `${w.w}@${w.start}-${w.end}`).join(' ') }]
    }
    case 'oa_consultar_ia': {
      const r = await api('ask', { ...base, prompt: args.consulta, provider: args.proveedor, model: args.modelo, images: args.imagenes, system: args.sistema })
      return [{ type: 'text', text: `[${r.provider} · ${r.model}]
${r.text}` }]
    }
    case 'oa_resolver_nota': return [{ type: 'text', text: JSON.stringify(await api('resolveNote', { ...base, id: args.id })) }]
    case 'oa_auditar_layout': {
      const r = await api('audit', { ...base, step: args.step, from: args.from, to: args.to })
      const lines = r.issues.map((i) => `- ${i.kind} «${i.text}» en ${i.clip || '?'} (${i.from}s–${i.to}s)`)
      return [{ type: 'text', text: `Auditoría ${r.timeline} ${r.from}s–${r.to}s cada ${r.step}s: ${r.issues.length} incidencia(s)\n` + lines.join('\n') }]
    }
    case 'oa_ver_fotogramas': {
      const r = await api('frames', { ...base, times: args.times, width: args.width })
      const out = []
      for (const f of r) { out.push({ type: 'text', text: `t=${f.t}s` }); out.push({ type: 'image', data: f.png, mimeType: 'image/png' }) }
      return out
    }
    case 'oa_hoja_contactos': {
      const r = await api('contactSheet', { ...base, count: args.count, from: args.from, to: args.to, times: args.times, cols: args.cols, width: args.width })
      return [{ type: 'text', text: 'Instantes: ' + r.times.join(', ') + ' s' }, { type: 'image', data: r.png, mimeType: 'image/png' }]
    }
  }
  throw new Error('Herramienta desconocida: ' + name)
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n') }

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  line = line.trim()
  if (!line) return
  let msg
  try { msg = JSON.parse(line) } catch (e) { return }
  const { id, method, params } = msg
  if (id === undefined || id === null) return // notificación
  try {
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'openanimator', version: '0.1.0' } } })
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    } else if (method === 'tools/call') {
      try {
        const content = await call(params.name, params.arguments)
        send({ jsonrpc: '2.0', id, result: { content } })
      } catch (e) {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: ' + (e && e.message || e) }], isError: true } })
      }
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} })
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Método no soportado: ' + method } })
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e && e.message || e) } })
  }
})
