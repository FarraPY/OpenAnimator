/**
 * Capturas del timeline en el simulador (la integración continua abre la app con `-OATest glass`): arma un proyecto de
 * muestra con escenas, voz, música y efectos (el audio se hace acá, para que se vean ondas de verdad), lo abre en la
 * pestaña Timeline y avisa «OA-SHOT <nombre>» para que el workflow saque la captura con simctl. El vidrio de la columna
 * de pistas es el Liquid Glass de iOS (GlassOverlay.swift).
 */
import { host } from '../../android/host'
import { b64encode, nativeCall } from '../host/native'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const say = (text: string) => nativeCall('log', { text }).catch(() => {})

/** WAV mono de 16 bits. */
export function wav(sec: number, f: (t: number) => number, sr = 16000) {
  const n = Math.floor(sec * sr), v = new DataView(new ArrayBuffer(44 + n * 2))
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true)
  v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, f(i / sr))) * 32767, true)
  return b64encode(new Uint8Array(v.buffer))
}
const noise = () => Math.random() * 2 - 1
export const voice = (rate: number) => (t: number) => (t % 1.4 < 1 ? 0.2 + 0.8 * Math.abs(Math.sin(2 * Math.PI * rate * t)) : 0.02) * noise() * 0.7
export const music = (t: number) => (0.3 + 0.7 * Math.abs(Math.sin(Math.PI * t)) ** 3) * (0.5 * Math.sin(2 * Math.PI * 110 * t) + 0.3 * Math.sin(2 * Math.PI * 165 * t))
export const whoosh = (t: number) => Math.min(t / 0.45, 1, (1 - t) / 0.5) * noise() * 0.8
const click = (t: number) => Math.max(0, 1 - t / 0.25) * noise() * 0.9

export async function runGlass() {
  const oa = (window as any).oa
  try {
    if (localStorage.getItem('oa.glassShots') !== '2') {
      const tpl = await oa.call('projects:templates')
      const p = await oa.call('projects:create', { name: 'Mi video', template: tpl[0]?.id || '', width: 1080, height: 1920, fps: 30 })
      const put = (name: string, sec: number, f: (t: number) => number) => host().call('fs.writeBase64', { path: `projects/${p.id}/assets/${name}`, data: wav(sec, f) })
      put('narracion-1.wav', 6.5, voice(2.3)); put('narracion-2.wav', 9, voice(1.9)); put('musica.wav', 20, music); put('whoosh.wav', 1, whoosh); put('click.wav', 0.8, click)
      const tlId = p.activeTimeline || 'main'
      const tl = await oa.call('timeline:get', p.id, tlId)
      const clip = (id: string, src: string, start: number, duration: number, name: string) => ({ id, src, start, duration, in: 0, name })
      const track = (n: string) => tl.tracks.find((x: any) => x.name === n) || { clips: [] }
      track('Escenas').clips = [clip('e1', 'scenes/intro.html', 0, 6, 'Intro'), clip('e2', 'scenes/desarrollo.html', 6, 8, 'Desarrollo'), clip('e3', 'scenes/cierre.html', 14, 6, 'Cierre')]
      track('Voz').clips = [clip('v1', 'assets/narracion-1.wav', 0.5, 6.5, 'narracion-1'), clip('v2', 'assets/narracion-2.wav', 8, 9, 'narracion-2')]
      track('Música').clips = [clip('m1', 'assets/musica.wav', 0, 20, 'musica')]
      track('SFX').clips = [clip('s1', 'assets/whoosh.wav', 5.6, 1, 'whoosh'), clip('s2', 'assets/click.wav', 13.7, 0.8, 'click')]
      tl.duration = 20
      await oa.call('timeline:save', p.id, tlId, tl)
      await wait(2000) // que termine de guardarse
      // Se abre directo el proyecto (como al volver de un cierre del motor web) y sigue la segunda parte.
      localStorage.setItem('oa.glassShots', '2')
      localStorage.setItem('oa.openProject', p.id)
      location.replace('/index.html?recovered=1')
      return
    }
    localStorage.removeItem('oa.glassShots')
    const tab = () => [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === 'Timeline')
    for (let i = 0; i < 60 && !tab(); i++) await wait(250)
    tab()?.click()
    await wait(5000)
    // Los dos estilos del vidrio (ver GlassOverlay.swift): al principio y con los clips pasando por detrás.
    const sc = document.querySelector<HTMLElement>('.tlp-scroll')
    for (const [style, k] of [['panel', 'a'], ['chips', 'b']]) {
      ;(window as any).__oaGlassStyle = style
      if (sc) sc.scrollLeft = 0
      window.dispatchEvent(new Event('resize'))
      await wait(2500)
      await say(`OA-SHOT vidrio-${k}1`)
      await wait(3000)
      if (sc) sc.scrollLeft = 260
      await wait(2500)
      await say(`OA-SHOT vidrio-${k}2`)
      await wait(3000)
    }
  } catch (e: any) { await say('ERROR ' + (e?.stack || e)) }
  await nativeCall('diag.result', { json: '{}' })
}
