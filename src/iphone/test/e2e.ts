/**
 * Prueba de punta a punta dentro de la app nativa (la corre la integración continua en el simulador de iPhone, con
 * `-OATest e2e`): instalar Claude Code de npm, arrancarlo contra una API de mentira (oa.claudeDev), crear un proyecto,
 * que Claude escriba una escena por MCP, ponerla en el timeline, exportar y revisar el MP4 con AVFoundation.
 * El resultado va a Swift (diag.result), que lo imprime y cierra la app.
 */
import { b64encode, nativeCall } from '../host/native'
import { host } from '../../android/host'
import type { WebHost } from '../host/webhost'

const call = <T = any>(ch: string, ...a: unknown[]): Promise<T> => (window as any).oa.call(ch, ...a)
const on = (ch: string, cb: (p: any) => void): (() => void) => (window as any).oa.on(ch, cb)
const log = (text: string) => { void nativeCall('log', { text }); console.log(text) }

async function step<T>(R: Record<string, unknown>, name: string, fn: () => Promise<T>, ms = 300000): Promise<T | undefined> {
  const t0 = performance.now()
  log(`▸ ${name}`)
  try {
    const v = await Promise.race([fn(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])
    R[name] = { ok: true, ms: Math.round(performance.now() - t0), value: v }
    log(`  ok (${Math.round(performance.now() - t0)} ms)`)
    return v
  } catch (e: any) {
    R[name] = { ok: false, ms: Math.round(performance.now() - t0), error: String(e?.stack || e?.message || e).slice(0, 1500) }
    log(`  ERROR ${e?.message || e}`)
    return undefined
  }
}

/** Espera el turno de Claude: hasta que el chat deja de trabajar; devuelve lo que se agregó a la conversación. */
function turn(chatId: string, send: () => Promise<unknown>) {
  return new Promise<any[]>((resolve, reject) => {
    const items: any[] = []
    let started = false
    const off = on('chat:event', (e: any) => {
      if (e.session !== chatId) return
      if (e.type === 'item') items.push(e.item)
      if (e.type === 'patch') { const it = items.find((x) => x.id === e.item.id); if (it) Object.assign(it, e.item) }
      if (e.type === 'state') {
        if (e.state.busy) started = true
        else if (started) { off(); resolve(items) }
      }
    })
    send().catch((err) => { off(); reject(err) })
  })
}

export async function runE2E() {
  const R: Record<string, unknown> = { ua: navigator.userAgent }
  await step(R, 'claude:install', async () => (await call('claude:install')).version, 600000)
  R.status = await call('claude:webStatus').catch((e) => String(e))
  await step(R, 'claude:test', () => call<string>('claude:test'), 180000)
  // Los modelos que ofrece Claude Code (pedido de control initialize): los pide la app sola después de instalar.
  await step(R, 'claude:models', async () => {
    for (let i = 0; i < 60; i++) {
      const list = await call<Array<{ value: string; resolvedModel?: string }> | null>('claude:models')
      if (list?.length) return list.map((m) => `${m.value} → ${m.resolvedModel || '?'}`)
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw new Error('Claude Code no dijo sus modelos en 60 s')
  }, 90000)
  // Iniciar sesión: el de Claude Code, con la vuelta por el servidor de la app (acá Swift hace de navegador con un código
  // de mentira) y el canje por la red de iOS. Si todo está conectado, Anthropic rechaza ese código.
  await step(R, 'claude:login', async () => {
    let error = ''
    try { await call('claude:login') } catch (e: any) { error = String(e?.message || e) }
    if (!/status code 400|invalid/i.test(error)) throw new Error(error || 'Anthropic aceptó un código de mentira')
    return `Anthropic rechazó el código de prueba (${error})`
  }, 120000)
  const templates = await call<any[]>('projects:templates').catch(() => [])
  const project = await step(R, 'projects:create', () => call<any>('projects:create', { name: 'Prueba E2E', template: templates[0]?.id || '', width: 1080, height: 1920, fps: 30 }))
  if (project) {
    const chat = await step(R, 'chat:create', () => call<any>('chat:create', project.id))
    if (chat) {
      const scene = '<!doctype html><html><body style="margin:0;background:#123;color:#fff;font:140px sans-serif;display:grid;place-items:center;height:100vh"><div>Hola iPhone</div></body></html>'
      const items = await step(R, 'chat:mcp-write', () => turn(chat.id, () => call('chat:send', chat.id, `[mcp] Write ${JSON.stringify({ file_path: 'scenes/e2e.html', content: scene })}`, [], [])), 180000)
      R.chatItems = (items || []).map((x: any) => `${x.kind}${x.name ? ':' + x.name : ''}${x.status ? '(' + x.status + ')' : ''} ${String(x.text || x.result || '').slice(0, 160)}`)
      const files = await call<any[]>('project:files', project.id).catch(() => [])
      R.sceneWritten = JSON.stringify(files).includes('e2e.html')
      const sid = (await call<any>('chat:get', chat.id).catch(() => null))?.sessionId as string | undefined
      await call('chat:kill', chat.id).catch(() => {})
      // Retomarla (como «Conversaciones anteriores» o al volver al proyecto) y escribir: Claude Code arranca con --resume.
      // Se cerraba solo (código 143): preguntaba si seguía vivo el proceso anterior y la emulación lo tomaba como SIGTERM.
      if (sid) await step(R, 'chat:resume', async () => {
        await new Promise((r) => setTimeout(r, 3500)) // el anterior termina y guarda la conversación
        const listed = (await call<Array<{ id: string }>>('chat:sessions', project.id)).some((x) => x.id === sid)
        const again = await call<any>('chat:create', project.id, { resume: sid })
        const items = await turn(again.id, () => call('chat:send', again.id, 'Seguimos', [], []))
        const bad = items.filter((x) => (x.kind === 'notice' && x.level === 'error') || (x.kind === 'result' && x.isError))
        if (bad.length) { await call('chat:kill', again.id).catch(() => {}); throw new Error(bad.map((x) => x.text).join(' · ')) }
        const said = items.filter((x) => x.kind === 'assistant').map((x) => String(x.text || '')).join(' ')
        // La API de mentira dice cuántos mensajes le llegaron: con el historial son más que el nuevo.
        const n = Number(/Mensajes: (\d+)/.exec(said)?.[1] || 0)
        if (n < 3) { await call('chat:kill', again.id).catch(() => {}); throw new Error(`Claude no recibió la conversación anterior (${n} mensajes): ${said}`) }
        // Escribir mientras Claude trabaja: el segundo queda en cola y sale solo cuando termina el primero.
        const queued = await new Promise<any[]>((resolve, reject) => {
          const got: any[] = []
          const off = on('chat:event', (e: any) => {
            if (e.session !== again.id) return
            if (e.type === 'item') got.push({ ...e.item, wasQueued: !!e.item.queued })
            if (e.type === 'patch') { const it = got.find((x) => x.id === e.item.id); if (it) Object.assign(it, e.item) }
            if (got.filter((x) => x.kind === 'result').length === 2) { off(); resolve(got) }
          })
          call('chat:send', again.id, 'Primero', [], []).then(() => call('chat:send', again.id, 'Segundo', [], [])).catch((err) => { off(); reject(err) })
        })
        await call('chat:kill', again.id).catch(() => {})
        const second = queued.find((x) => x.kind === 'user' && x.text === 'Segundo')
        const order = queued.map((x) => (x.kind === 'user' ? `${x.text}${x.wasQueued ? ' (en cola)' : ''}` : x.kind)).join(' → ')
        if (!second?.wasQueued || second.queued) throw new Error('La cola no funcionó: ' + order)
        return { listed, loaded: again.items.length, messages: n, queue: order }
      }, 180000)
      // Un subagente «escena» en segundo plano: arranca con sus instrucciones y su fila termina con el resumen.
      await step(R, 'chat:subagent', async () => {
        const c = await call<any>('chat:create', project.id)
        const got: any[] = []
        const done = new Promise<void>((resolve) => {
          const off = on('chat:event', (e: any) => {
            if (e.session !== c.id) return
            if (e.type === 'item') got.push({ ...e.item })
            if (e.type === 'patch') { const it = got.find((x) => x.id === e.item.id); if (it) Object.assign(it, e.item) }
            if (e.type === 'state' && !e.state.busy && !e.state.tasks && got.find((x) => x.name === 'Agent')?.status === 'ok') { off(); resolve() }
          })
        })
        await call('chat:send', c.id, `[mcp] Agent ${JSON.stringify({ description: 'Escena E2E', prompt: 'Escribí la escena de prueba', subagent_type: 'escena' })}`, [], [])
        const late = await Promise.race([done.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 150000))])
        await call('chat:kill', c.id).catch(() => {})
        if (late) {
          // El registro de depuración de Claude Code (oa.claudeDev con debug, como en la integración continua).
          let dbg = ''
          try { dbg = (host() as WebHost).fs.readText(`claude/home/oa-debug/${c.id}.log`).slice(-6000) } catch (e: any) { dbg = 'sin registro: ' + e.message }
          throw new Error(`El subagente no terminó en 150 s. Items: ${got.map((x) => `${x.kind}${x.name ? ':' + x.name : ''}(${x.status || ''}) ${String(x.text || x.result || '').slice(0, 120)}`).join(' | ')}\nRegistro de Claude Code:\n${dbg}`)
        }
        const agent = got.find((x) => x.name === 'Agent')
        if (!/Subagente con guía/.test(String(agent?.result || ''))) throw new Error('El subagente no recibió sus instrucciones: ' + String(agent?.result || '').slice(0, 200))
        return { result: String(agent.result).slice(0, 160), items: got.map((x) => `${x.kind}${x.name ? ':' + x.name : ''}${x.status ? '(' + x.status + ')' : ''}`) }
      }, 180000)
      // Si Claude no la escribió, la escena igual existe (la exportación se prueba aparte).
      if (!R.sceneWritten) (host() as WebHost).fs.writeText(`projects/${project.id}/scenes/e2e.html`, scene)
    }
    // La escena al principio del timeline, 3 s.
    await step(R, 'timeline:add', async () => {
      const tl = await call<any>('timeline:get', project.id, project.activeTimeline || 'main')
      let tr = tl.tracks.find((t: any) => t.type === 'scene')
      if (!tr) { tr = { id: 't-e2e', name: 'Escenas', type: 'scene', clips: [] }; tl.tracks.unshift(tr) }
      tr.clips = [{ id: 'c-e2e', src: 'scenes/e2e.html', start: 0, duration: 2, in: 0 }]
      // Sólo la escena de la prueba (la plantilla trae otras pistas y clips).
      tl.tracks = [tr]
      tl.duration = 2
      await call('timeline:save', project.id, project.activeTimeline || 'main', tl)
      return true
    })
    // Un fotograma con el compositor oculto (lo que usa la exportación y lo que mira Claude).
    await step(R, 'frames:png', async () => {
      const b64 = await call<string>('frames:png', project.id, project.activeTimeline || 'main', 0.5, 320)
      return { bytes: Math.round((b64?.length || 0) * 0.75) }
    }, 120000)
    R.iframes = [...document.querySelectorAll('iframe')].map((f) => f.src.slice(0, 120))
    // El codificador de iOS (AVFoundation, el respaldo de la exportación) directo: 30 fotogramas JPEG y 1 s de audio.
    await step(R, 'avfoundation', async () => {
      const W = 320, H = 568, path = 'exports/avf-prueba.mp4'
      await nativeCall('venc.start', { out: path, width: W, height: H, fps: 30, bitrate: 2e6, codec: 'avc', audio: { sampleRate: 48000, channels: 2, bitrate: 128000 } })
      const cv = document.createElement('canvas')
      cv.width = W; cv.height = H
      const g = cv.getContext('2d')!
      for (let i = 0; i < 30; i++) {
        g.fillStyle = `hsl(${i * 12} 70% 50%)`; g.fillRect(0, 0, W, H)
        await nativeCall('venc.frame', { data: cv.toDataURL('image/jpeg', 0.9).split(',')[1] })
      }
      const pcm = new Float32Array(48000 * 2)
      for (let i = 0; i < 48000; i++) pcm[i] = pcm[48000 + i] = Math.sin((i / 48000) * 2 * Math.PI * 440) * 0.3
      await nativeCall('venc.audio', { data: b64encode(new Uint8Array(pcm.buffer)) })
      const r = await nativeCall('venc.finish')
      return { ...r, probe: await nativeCall('probe', { path }) }
    }, 60000)
    // «Crear plantilla desde un video» con ese video: medirlo en Swift (VideoAnalysis.swift), que Claude escriba el
    // análisis (la API de mentira escribe uno mínimo) y guardarlo como plantilla.
    await step(R, 'analyzer', async () => {
      // Lo escribió Swift: entra al índice de la página como lo que se elige con pick.files (en la app, con su tamaño).
      const fsw = (host() as WebHost).fs
      fsw.noteFile('exports/avf-prueba.mp4', Number((R.avfoundation as any)?.value?.size) || 1)
      await fsw.copy('exports/avf-prueba.mp4', '.incoming/e2e/avf.mp4')
      const id = await call<string>('analyze:start', { source: '.incoming/e2e/avf.mp4', name: 'avf.mp4', transcribe: false, maxMinutes: 1 })
      const phases: string[] = []
      const res = await new Promise<any>((resolve, reject) => {
        const off = on('analyze:event', (e: any) => {
          if (e.id !== id) return
          if (e.status && e.status !== 'run') phases.push(`${e.phase}: ${e.status} ${e.message || ''}`)
          if (e.done) { off(); if (e.error) reject(new Error(`${e.error} · ${phases.join(' · ')}`)); else resolve(e.result) }
        })
      })
      const t = await call<{ id: string }>('analyze:save', id, { name: 'Plantilla E2E', analysis: res.analysis, stats: res.stats, source: res.source, title: res.title })
      if (!(await call<any[]>('projects:templates')).some((x) => x.id === t.id)) throw new Error('La plantilla no aparece en la lista')
      return { phases, stats: res.stats, analysis: res.analysis, template: t.id }
    }, 300000)
    // «Guardar como plantilla» con la guía de estilo de Claude (la API de mentira contesta un texto cualquiera).
    await step(R, 'template:describe', async () => {
      const t = await call<{ id: string; dir: string }>('templates:saveProject', project.id, { name: 'Estilo E2E', includeAssets: false, describe: true })
      const guide = (host() as WebHost).fs.readText(`${t.dir}/files/PLANTILLA.md`)
      if (!/^# Plantilla «Estilo E2E»/.test(guide) || !/Claude de prueba/.test(guide)) throw new Error('PLANTILLA.md sin la guía de Claude: ' + guide.slice(0, 300))
      const tpl = (await call<any[]>('projects:templates')).find((x) => x.id === t.id)
      if (!tpl) throw new Error('La plantilla no aparece en la lista')
      return { id: t.id, description: tpl.description, guide: guide.slice(0, 200) }
    }, 180000)
    // Recursos libres de Claude: íconos (Iconify), tipografías (Fontsource) y quitar el fondo (Vision).
    await step(R, 'tools:recursos', async () => {
      const { runTool } = await import('../../android/backend/tools')
      const ctx = { projectId: project.id, changed: () => {} }
      const text = async (name: string, input: any) => ((await runTool(name, input, ctx))[0] as any).text as string
      const fsw = (host() as WebHost).fs
      const iconos = await text('oa_buscar_iconos', { buscar: 'rocket' })
      if (!/:rocket/.test(iconos)) throw new Error('Búsqueda de íconos: ' + iconos.slice(0, 300))
      await text('oa_guardar_iconos', { iconos: ['lucide:rocket'] })
      if (!fsw.exists(`projects/${project.id}/assets/iconos/lucide-rocket.svg`)) throw new Error('No se guardó el ícono')
      const fuente = await text('oa_usar_fuente', { familia: 'Inter' })
      if (!fsw.exists(`projects/${project.id}/assets/fuentes/inter.css`) || !fsw.exists(`projects/${project.id}/assets/fuentes/inter/latin-400-normal.woff2`)) throw new Error('No se guardó la tipografía: ' + fuente)
      // Quitar el fondo: una figura dibujada sobre un fondo liso (el simulador puede no tener Vision completo: no corta la prueba).
      let recorte = ''
      try {
        const cv = document.createElement('canvas'); cv.width = cv.height = 512
        const g = cv.getContext('2d')!
        g.fillStyle = '#f2f2f2'; g.fillRect(0, 0, 512, 512)
        g.fillStyle = '#d33'; g.beginPath(); g.arc(256, 230, 140, 0, Math.PI * 2); g.fill()
        g.fillStyle = '#333'; g.fillRect(226, 360, 60, 120)
        await fsw.writeBytes(`projects/${project.id}/assets/figura.png`, Uint8Array.from(atob(cv.toDataURL('image/png').split(',')[1]), (ch) => ch.charCodeAt(0)))
        recorte = await text('oa_quitar_fondo', { imagen: 'assets/figura.png' })
      } catch (e: any) { recorte = 'ERROR ' + (e?.message || e) }
      // Código aislado: un «bip» con Web Audio a un WAV del proyecto; sin ver la app ni la red.
      const js = await text('oa_ejecutar_js', { codigo: `
        const sr = 48000, ctx = new OfflineAudioContext(1, sr / 2, sr), o = ctx.createOscillator(), g = ctx.createGain()
        o.frequency.value = 880; g.gain.setValueAtTime(0.5, 0); g.gain.linearRampToValueAtTime(0, 0.5)
        o.connect(g).connect(ctx.destination); o.start()
        await guardar('assets/sfx/bip.wav', wav(await ctx.startRendering()))
        let app = 'aislado'; try { app = 'VE LA APP: ' + parent.document.title } catch (e) { app = 'aislado (' + e.name + ')' }
        let red = 'sin red'; try { await fetch('https://api.iconify.design/'); red = 'HAY RED' } catch (e) {}
        return { app, red }` })
      if (!fsw.exists(`projects/${project.id}/assets/sfx/bip.wav`) || /VE LA APP|HAY RED/.test(js)) throw new Error('oa_ejecutar_js: ' + js)
      return { iconos: iconos.split('\n')[0], fuente: fuente.split('\n')[0], recorte, js }
    }, 120000)
    const out = await step(R, 'export', () => new Promise<any>((resolve, reject) => {
      let id = ''
      let shown = 0
      const off = on('export:progress', (p: any) => {
        if (id && p.id !== id) return
        if (Date.now() - shown > 3000 || p.phase !== 'render') { shown = Date.now(); log(`  exportando: ${p.phase} · ${p.message} · ${p.done}/${p.total}`) }
        if (p.phase === 'listo') { off(); resolve({ file: p.file, size: p.size, fps: p.fps, encoder: p.encoder, details: p.details }) }
        else if (p.phase === 'error' || p.phase === 'cancelado') { off(); reject(new Error(p.message + '\n' + (p.details || ''))) }
      })
      call<string>('export:start', { projectId: project.id, timeline: project.activeTimeline || 'main', range: null, width: 540, height: 960, fps: 30, codec: 'avc', quality: 'medium', audio: false, audioBitrate: 128, name: 'e2e' })
        .then((x) => { id = x }, (e) => { off(); reject(e) })
    }), 300000)
    if (out?.file) await step(R, 'probe', () => nativeCall('probe', { path: out.file }))
  }
  await nativeCall('diag.result', { json: JSON.stringify(R) })
}
