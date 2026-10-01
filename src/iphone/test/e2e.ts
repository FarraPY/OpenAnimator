/**
 * Prueba de punta a punta dentro de la app nativa (la corre la integración continua en el simulador de iPhone, con
 * `-OATest e2e`): instalar Claude Code de npm, arrancarlo contra una API de mentira (oa.claudeDev), crear un proyecto,
 * que Claude escriba una escena por MCP, ponerla en el timeline, exportar y revisar el MP4 con AVFoundation.
 * El resultado va a Swift (diag.result), que lo imprime y cierra la app.
 */
import { nativeCall } from '../host/native'

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
      await call('chat:kill', chat.id).catch(() => {})
    }
    // La escena al principio del timeline, 3 s.
    await step(R, 'timeline:add', async () => {
      const tl = await call<any>('timeline:get', project.id, project.activeTimeline || 'main')
      let tr = tl.tracks.find((t: any) => t.type === 'scene')
      if (!tr) { tr = { id: 't-e2e', name: 'Escenas', type: 'scene', clips: [] }; tl.tracks.unshift(tr) }
      tr.clips = [{ id: 'c-e2e', src: 'scenes/e2e.html', start: 0, duration: 3, in: 0 }]
      tl.duration = 3
      await call('timeline:save', project.id, project.activeTimeline || 'main', tl)
      return true
    })
    const out = await step(R, 'export', () => new Promise<any>((resolve, reject) => {
      let id = ''
      const off = on('export:progress', (p: any) => {
        if (id && p.id !== id) return
        if (p.phase === 'listo') { off(); resolve({ file: p.file, size: p.size, fps: p.fps, encoder: p.encoder }) }
        else if (p.phase === 'error' || p.phase === 'cancelado') { off(); reject(new Error(p.message + '\n' + (p.details || ''))) }
      })
      call<string>('export:start', { projectId: project.id, timeline: project.activeTimeline || 'main', range: null, width: 540, height: 960, fps: 30, codec: 'avc', quality: 'medium', audio: false, audioBitrate: 128, name: 'e2e' })
        .then((x) => { id = x }, (e) => { off(); reject(e) })
    }), 300000)
    if (out?.file) await step(R, 'probe', () => nativeCall('probe', { path: out.file }))
  }
  await nativeCall('diag.result', { json: JSON.stringify(R) })
}
