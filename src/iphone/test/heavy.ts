/**
 * Proyecto pesado en el simulador (la integración continua abre la app con `-OATest heavy`): 30 minutos, cientos de
 * clips en cuatro pistas, audios de verdad y escenas con muchas animaciones. Mide cuánto tarda en abrir el timeline,
 * si se traba al recorrerlo de punta a punta y al reproducir, y lo avisa con «OA-HEAVY {json}» (más una captura).
 */
import { host } from '../../android/host'
import { nativeCall } from '../host/native'
import { music, voice, wav, whoosh } from './glass'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const say = (text: string) => nativeCall('log', { text }).catch(() => {})

/** Una escena con muchas cosas animándose (lo que más le cuesta al motor web). */
const scene = (hue: number) => `<!doctype html><html><head><style>
body{margin:0;background:hsl(${hue} 40% 12%);overflow:hidden;font:600 70px system-ui;color:#fff}
.d{position:absolute;width:60px;height:60px;border-radius:16px;background:hsl(${hue} 70% 60%);animation:m 3s ease-in-out infinite alternate}
@keyframes m{from{transform:translate(0,0) rotate(0)}to{transform:translate(300px,500px) rotate(180deg)}}
</style></head><body><h1 style="position:absolute;top:120px;left:80px">Escena ${hue}</h1>
${Array.from({ length: 160 }, (_, i) => `<div class="d" style="left:${(i * 37) % 1000}px;top:${(i * 53) % 1800}px;animation-delay:-${(i % 30) / 10}s"></div>`).join('')}
</body></html>`

/** Tiempos entre cuadros mientras `run` hace lo suyo (ms): cómo se siente la interfaz. */
async function frames(run: (stop: () => boolean) => Promise<void>) {
  const dt: number[] = []
  let on = true, last = performance.now()
  const tick = (now: number) => { dt.push(now - last); last = now; if (on) requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
  await run(() => !on)
  on = false
  const sorted = [...dt].sort((a, b) => a - b)
  const avg = dt.reduce((a, b) => a + b, 0) / Math.max(1, dt.length)
  return { cuadros: dt.length, fps: Math.round(1000 / avg), p95ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] || 0), trabas: dt.filter((x) => x > 50).length, peorMs: Math.round(sorted[sorted.length - 1] || 0) }
}

export async function runHeavy() {
  const oa = (window as any).oa
  const R: Record<string, unknown> = {}
  try {
    if (localStorage.getItem('oa.heavyShots') !== '2') {
      const t0 = performance.now()
      const tpl = await oa.call('projects:templates')
      const p = await oa.call('projects:create', { name: 'Proyecto pesado', template: tpl[0]?.id || '', width: 1080, height: 1920, fps: 30 })
      const put = (path: string, data: string) => host().call('fs.writeBase64', { path: `projects/${p.id}/${path}`, data })
      for (let i = 0; i < 8; i++) put(`assets/voz-${i}.wav`, wav(12, voice(1.6 + i * 0.2)))
      for (let i = 0; i < 3; i++) put(`assets/musica-${i}.wav`, wav(60, music))
      put('assets/whoosh.wav', wav(1, whoosh))
      for (let i = 0; i < 8; i++) host().call('fs.writeText', { path: `projects/${p.id}/scenes/escena-${i}.html`, text: scene(i * 45) })
      const tlId = p.activeTimeline || 'main'
      const tl = await oa.call('timeline:get', p.id, tlId)
      const track = (n: string) => tl.tracks.find((x: any) => x.name === n) || { clips: [] }
      const D = 1800 // 30 minutos
      track('Escenas').clips = Array.from({ length: 60 }, (_, i) => ({ id: `e${i}`, src: `scenes/escena-${i % 8}.html`, start: i * 30, duration: 30, in: 0, name: `Escena ${i + 1}` }))
      track('Voz').clips = Array.from({ length: 140 }, (_, i) => ({ id: `v${i}`, src: `assets/voz-${i % 8}.wav`, start: i * 12.8, duration: 11.5, in: 0, name: `voz ${i + 1}` }))
      track('Música').clips = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, src: `assets/musica-${i % 3}.wav`, start: i * 60, duration: 60, in: 0, name: `música ${i + 1}` }))
      track('SFX').clips = Array.from({ length: 300 }, (_, i) => ({ id: `s${i}`, src: 'assets/whoosh.wav', start: i * 6 + 2, duration: 1, in: 0, name: 'whoosh' }))
      tl.duration = D
      await oa.call('timeline:save', p.id, tlId, tl)
      await wait(4000) // que terminen de guardarse los archivos
      localStorage.setItem('oa.heavyShots', '2')
      localStorage.setItem('oa.heavyArmado', String(Math.round(performance.now() - t0)))
      localStorage.setItem('oa.openProject', p.id)
      location.replace('/index.html?recovered=1')
      return
    }
    localStorage.removeItem('oa.heavyShots')
    R.clips = 530
    R.armarMs = Number(localStorage.getItem('oa.heavyArmado'))
    const tab = () => [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === 'Timeline')
    for (let i = 0; i < 80 && !tab(); i++) await wait(250)
    R.editorMs = Math.round(performance.now())
    const t1 = performance.now()
    tab()?.click()
    for (let i = 0; i < 80 && !document.querySelector('.tlp-clip'); i++) await wait(50)
    R.timelineMs = Math.round(performance.now() - t1)
    R.clipsEnPantalla = document.querySelectorAll('.tlp-clip').length
    await wait(2500)
    await say('OA-SHOT pesado-1')
    await wait(2500)
    // Recorrer los 30 minutos de punta a punta en 6 s (como arrastrar el dedo rápido).
    const sc = document.querySelector<HTMLElement>('.tlp-scroll')!
    R.recorrer = await frames(async () => {
      const max = sc.scrollWidth - sc.clientWidth, t0 = performance.now()
      while (performance.now() - t0 < 6000) { sc.scrollLeft = max * ((performance.now() - t0) / 6000); await new Promise((r) => requestAnimationFrame(r)) }
    })
    sc.scrollLeft = 0
    await wait(1500)
    // Reproducir 6 s (escenas con 160 animaciones cada una en la vista previa).
    const play = () => document.querySelector<HTMLElement>('.ed-play')
    R.reproducir = await frames(async () => { play()?.click(); await wait(6000); play()?.click() })
    await wait(1000)
    await say('OA-SHOT pesado-2')
    await wait(2500)
  } catch (e: any) { R.error = String(e?.stack || e) }
  await say('OA-HEAVY ' + JSON.stringify(R))
  await nativeCall('diag.result', { json: JSON.stringify(R) })
}
