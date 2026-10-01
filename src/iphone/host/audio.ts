/**
 * Audio en el iPhone (audio.* del puente y la mezcla de la exportación), como AudioDecoder.java / AudioMix.java en Android.
 * Mediabunny lee el archivo por partes desde OPFS (un video 4K de varios GB no se carga entero) y decodifica sólo el
 * tramo pedido con WebCodecs. Si el formato no se puede leer así, se usa decodeAudioData (sólo archivos chicos).
 */
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from 'mediabunny'
import type { WebFS } from './webfs'

const BIG = 150 * 1024 * 1024 // decodeAudioData necesita el archivo entero en memoria

type Pcm = { sampleRate: number; channels: Float32Array[]; frames: number }

/** PCM (float, un arreglo por canal) de [from, to) segundos del audio de un archivo. */
async function decodeRange(fs: WebFS, path: string, from: number, to: number): Promise<Pcm | null> {
  const blob = await fs.fileBlob(path)
  try {
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
    const track = await input.getPrimaryAudioTrack()
    if (!track) return null // un video sin sonido
    if (!(await track.canDecode())) throw new Error('sin decodificador')
    const sr = track.sampleRate, ch = track.numberOfChannels
    const want = Math.max(0, Math.round((to - from) * sr))
    const out = Array.from({ length: ch }, () => new Float32Array(want))
    const sink = new AudioSampleSink(track)
    for await (const s of sink.samples(from, to)) {
      try {
        // Lo que cae fuera de [from, to) se recorta (el primer y el último bloque pueden empezar antes o terminar después).
        const startFrame = Math.round((s.timestamp - from) * sr)
        for (let c = 0; c < ch; c++) {
          const tmp = new Float32Array(s.numberOfFrames)
          s.copyTo(tmp, { planeIndex: c, format: 'f32-planar' })
          const a = Math.max(0, -startFrame), b = Math.min(s.numberOfFrames, want - startFrame)
          if (b > a) out[c].set(tmp.subarray(a, b), startFrame + a)
        }
      } finally { s.close() }
    }
    return { sampleRate: sr, channels: out, frames: want }
  } catch {
    if (blob.size > BIG) throw new Error('No se pudo leer el audio de este archivo (formato no compatible con el iPhone)')
    const ctx = new OfflineAudioContext(1, 1, 48000)
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer())
    const a = Math.max(0, Math.floor(from * buf.sampleRate)), b = Math.min(buf.length, Math.ceil(to * buf.sampleRate))
    return { sampleRate: buf.sampleRate, channels: Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c).slice(a, b)), frames: Math.max(0, b - a) }
  }
}

/** audio.peaks: la envolvente para el timeline (perSec valores por segundo, 0–255, raíz como en la PC). */
export async function peaks(fs: WebFS, path: string, perSec: number) {
  const blob = await fs.fileBlob(path)
  const out: number[] = []
  let max = 0, n = 0, win = 0
  const push = (v: number) => { if (v > max) max = v; if (++n >= win) { out.push(Math.min(255, Math.round(Math.sqrt(Math.min(1, max)) * 255))); n = 0; max = 0 } }
  try {
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
    const track = await input.getPrimaryAudioTrack()
    if (!track) throw new Error('El archivo no tiene audio')
    win = Math.max(1, Math.floor(track.sampleRate / perSec))
    let tmp = new Float32Array(0)
    for await (const s of new AudioSampleSink(track).samples()) {
      try {
        if (tmp.length < s.numberOfFrames) tmp = new Float32Array(s.numberOfFrames)
        s.copyTo(tmp, { planeIndex: 0, format: 'f32-planar' })
        for (let i = 0; i < s.numberOfFrames; i++) push(Math.abs(tmp[i]))
      } finally { s.close() }
    }
  } catch (e) {
    if (blob.size > BIG) throw e
    // Formatos que WebCodecs no lee: a 8 kHz alcanza para la envolvente (y ocupa poco).
    const buf = await new OfflineAudioContext(1, 1, 8000).decodeAudioData(await blob.arrayBuffer())
    win = Math.max(1, Math.floor(buf.sampleRate / perSec)); out.length = 0; n = 0; max = 0
    const d = buf.getChannelData(0)
    for (let i = 0; i < d.length; i++) push(Math.abs(d[i]))
  }
  if (n) out.push(Math.min(255, Math.round(Math.sqrt(Math.min(1, max)) * 255)))
  let bin = ''
  for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode(...out.slice(i, i + 0x8000))
  return { rate: perSec, data: btoa(bin) }
}

/** audio.decode: PCM s16le de un tramo a un archivo (lo usa la transcripción). */
export async function decodePcm(fs: WebFS, a: { path: string; start: number; duration: number; out: string }) {
  const pcm = await decodeRange(fs, a.path, Math.max(0, a.start || 0), Math.max(0, a.start || 0) + a.duration)
  if (!pcm) throw new Error('El archivo no tiene audio')
  const ch = pcm.channels.length, s16 = new Int16Array(pcm.frames * ch)
  for (let i = 0; i < pcm.frames; i++) for (let c = 0; c < ch; c++) s16[i * ch + c] = Math.max(-32768, Math.min(32767, Math.round(pcm.channels[c][i] * 32767)))
  fs.writeBytes(a.out, new Uint8Array(s16.buffer))
  return { sampleRate: pcm.sampleRate, channels: ch, frames: pcm.frames }
}

type Part = { path: string; start: number; duration: number; in: number; volume: number; fadeIn: number; fadeOut: number }

/**
 * Una ventana [at, at+len) de la mezcla: cada clip que suena ahí se decodifica sólo en ese tramo y Web Audio lo
 * remuestrea, le aplica volumen y fundidos (lineales, en el tiempo del clip, como afade en la PC) y lo suma.
 */
export async function mixWindow(fs: WebFS, parts: Part[], at: number, len: number, sampleRate: number, failed: Set<string>) {
  const frames = Math.max(1, Math.round(len * sampleRate))
  const ctx = new OfflineAudioContext(2, frames, sampleRate)
  for (const p of parts) {
    const a = Math.max(p.start, at), b = Math.min(p.start + p.duration, at + len)
    if (b - a < 0.001) continue
    let pcm: Pcm | null = null
    try { pcm = await decodeRange(fs, p.path, p.in + (a - p.start), p.in + (b - p.start)) } catch { failed.add(p.path) }
    if (!pcm || !pcm.frames) continue
    const buf = ctx.createBuffer(pcm.channels.length, pcm.frames, pcm.sampleRate)
    pcm.channels.forEach((d, c) => buf.copyToChannel(d as Float32Array<ArrayBuffer>, c))
    const src = ctx.createBufferSource()
    src.buffer = buf
    const g = ctx.createGain()
    // Volumen con fundidos: la curva en el tiempo del clip (lineal), recortada a esta ventana.
    const gainAt = (t: number) => {
      const lt = t - p.start
      let v = p.volume
      if (p.fadeIn > 0 && lt < p.fadeIn) v *= Math.max(0, lt / p.fadeIn)
      if (p.fadeOut > 0 && p.duration - lt < p.fadeOut) v *= Math.max(0, (p.duration - lt) / p.fadeOut)
      return v
    }
    const t0 = a - at, t1 = b - at
    g.gain.setValueAtTime(gainAt(a), t0)
    const marks = [p.start + p.fadeIn, p.start + p.duration - p.fadeOut].filter((m) => m > a && m < b).sort((x, y) => x - y)
    for (const m of marks) g.gain.linearRampToValueAtTime(gainAt(m), m - at)
    g.gain.linearRampToValueAtTime(gainAt(b), t1)
    src.connect(g).connect(ctx.destination)
    src.start(t0)
  }
  return ctx.startRendering()
}
