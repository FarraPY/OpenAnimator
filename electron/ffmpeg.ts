/**
 * FFmpeg: detección de encoders, argumentos de video (NVENC y CPU) y mezcla de audio.
 * Las combinaciones NVENC están verificadas en RTX serie 50 (ver docs/investigacion).
 */
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ffmpegPaths } from './paths'
import type { Timeline } from './projects'

export type VCodec = 'h264_nvenc' | 'hevc_nvenc' | 'av1_nvenc' | 'libx264' | 'libx265' | 'copy'
export type ExportSettings = {
  width: number; height: number; fps: number
  vcodec: VCodec; preset: string; tune: 'hq' | 'uhq' | 'll' | 'ull' | 'lossless'
  rc: 'cq' | 'vbr' | 'cbr' | 'cqp' | 'size' | 'lossless'
  cq: number; qp: number; bitrate: number; maxrate: number; targetMB: number
  multipass: 'disabled' | 'qres' | 'fullres'
  pixfmt: 'yuv420p' | 'p010le' | 'yuv422p' | 'p210le' | 'yuv444p'
  bframes: number; gopSec: number; lookahead: number; spatialAQ: boolean; temporalAQ: boolean; aqStrength: number
  color: 'bt709' | 'bt601' | 'none'; range: 'tv' | 'pc'
  container: 'mp4' | 'mkv' | 'mov' | 'webm'
  acodec: 'aac' | 'libopus' | 'libmp3lame' | 'ac3' | 'flac' | 'pcm_s16le' | 'pcm_s24le' | 'none'
  abitrate: number; arate: number; achannels: 0 | 1 | 2 | 6; volumeDb: number; loudnorm: boolean; lufs: number
  faststart: boolean; title: string
  workers: number; segmentSec: number
}

export const DEFAULT_SETTINGS: ExportSettings = {
  width: 1920, height: 1080, fps: 30,
  vcodec: 'h264_nvenc', preset: 'p5', tune: 'hq', rc: 'cq', cq: 20, qp: 20, bitrate: 8000, maxrate: 0, targetMB: 500,
  multipass: 'qres', pixfmt: 'yuv420p', bframes: 3, gopSec: 2, lookahead: 20, spatialAQ: true, temporalAQ: true, aqStrength: 8,
  color: 'bt709', range: 'tv', container: 'mp4',
  acodec: 'aac', abitrate: 192, arate: 48000, achannels: 2, volumeDb: 0, loudnorm: false, lufs: -14,
  faststart: true, title: '', workers: 4, segmentSec: 60,
}

export function run(bin: string, args: string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout || 0, env: opts.env }, (err: any, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

export async function probeDuration(file: string): Promise<number> {
  const r = await run(ffmpegPaths().ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeout: 30000 })
  const d = parseFloat(r.stdout.trim())
  return isFinite(d) ? d : 0
}

export async function probeMedia(file: string) {
  const r = await run(ffmpegPaths().ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,r_frame_rate', '-of', 'json', file], { timeout: 30000 })
  try {
    const j = JSON.parse(r.stdout)
    const v = (j.streams || []).find((s: any) => s.codec_type === 'video')
    const a = (j.streams || []).find((s: any) => s.codec_type === 'audio')
    return { duration: parseFloat(j.format?.duration) || 0, video: v ? { codec: v.codec_name, width: v.width, height: v.height } : null, audio: a ? { codec: a.codec_name } : null }
  } catch { return { duration: 0, video: null, audio: null } }
}

let _encoders: Record<string, boolean> | null = null
/** Prueba real (encode nulo de 0,2 s) de cada encoder: la lista de -encoders no garantiza que la GPU/driver funcione. */
export async function detectEncoders(): Promise<Record<string, boolean>> {
  if (_encoders) return _encoders
  const res: Record<string, boolean> = {}
  const { ffmpeg } = ffmpegPaths()
  await Promise.all(['h264_nvenc', 'hevc_nvenc', 'av1_nvenc', 'libx264', 'libx265'].map(async (enc) => {
    const r = await run(ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=640x360:d=0.2', '-c:v', enc, '-f', 'null', '-'], { timeout: 30000 })
    res[enc] = r.code === 0
  }))
  return (_encoders = res)
}

export async function gpuName(): Promise<string> {
  const r = await run('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { timeout: 8000 })
  return r.code === 0 ? r.stdout.trim().split(/\r?\n/)[0] : ''
}

const PROFILES: Record<string, [string, string]> = {
  // pix_fmt: [perfil h264, perfil hevc]
  yuv420p: ['high', 'main'], p010le: ['high10', 'main10'], yuv422p: ['high422', 'rext'], p210le: ['high422', 'rext'], yuv444p: ['high444p', 'rext'],
}

/** Argumentos de codificación de video (sin entrada ni salida). `durationSec` sólo se usa en el modo tamaño objetivo. */
export function videoArgs(s: ExportSettings, durationSec: number): string[] {
  const a: string[] = []
  if (s.vcodec === 'copy') return ['-c:v', 'copy']
  const nv = s.vcodec.endsWith('_nvenc')
  let pix = s.pixfmt
  if (s.vcodec === 'av1_nvenc' && !['yuv420p', 'p010le'].includes(pix)) throw new Error('AV1 NVENC sólo admite 4:2:0 (8 o 10 bits).')
  const lossless = s.rc === 'lossless' || s.tune === 'lossless'
  if (lossless && s.vcodec === 'av1_nvenc') throw new Error('AV1 NVENC no tiene modo sin pérdida. Usá HEVC o H.264.')
  if (!nv) {
    // CPU (x264/x265): respaldo si no hay GPU NVIDIA.
    const cpuPix = pix === 'p010le' ? 'yuv420p10le' : pix === 'p210le' ? 'yuv422p10le' : pix
    a.push('-pix_fmt', cpuPix, '-c:v', s.vcodec, '-preset', 'medium')
    if (lossless) a.push(s.vcodec === 'libx264' ? '-qp' : '-x265-params', s.vcodec === 'libx264' ? '0' : 'lossless=1')
    else if (s.rc === 'cq' || s.rc === 'cqp') a.push('-crf', String(s.rc === 'cq' ? s.cq : s.qp))
    else a.push(...rateArgs(s, durationSec))
    a.push('-g', String(Math.max(1, Math.round(s.gopSec * s.fps))))
    a.push(...colorArgs(s))
    return a
  }
  let tune = lossless ? 'lossless' : s.tune
  if (tune === 'uhq' && s.vcodec === 'h264_nvenc') tune = 'hq'
  a.push('-pix_fmt', pix, '-c:v', s.vcodec, '-preset', s.preset, '-tune', tune)
  if (s.vcodec !== 'av1_nvenc') a.push('-profile:v', s.vcodec === 'h264_nvenc' ? PROFILES[pix][0] : PROFILES[pix][1])
  if (lossless) a.push('-rc', 'constqp', '-qp', '0')
  else if (s.rc === 'cq') {
    a.push('-rc', 'vbr', '-cq', String(s.cq), '-b:v', '0')
    if (s.maxrate > 0) a.push('-maxrate', `${s.maxrate}k`, '-bufsize', `${s.maxrate * 2}k`)
  } else if (s.rc === 'cqp') a.push('-rc', 'constqp', '-qp', String(s.qp))
  else a.push(...rateArgs(s, durationSec))
  if (s.multipass !== 'disabled' && !['ll', 'ull', 'lossless'].includes(tune)) a.push('-multipass', s.multipass)
  if (!lossless) {
    if (s.spatialAQ) a.push('-spatial-aq', '1', '-aq-strength', String(s.aqStrength))
    if (s.temporalAQ) a.push('-temporal-aq', '1')
  }
  if (tune !== 'uhq') { // uhq fija sus propios B-frames; forzarlos hace fallar al encoder
    a.push('-bf', String(s.bframes))
    if (s.bframes >= 2) a.push('-b_ref_mode', 'middle')
  }
  if (s.lookahead > 0) a.push('-rc-lookahead', String(s.lookahead))
  a.push('-g', String(Math.max(1, Math.round(s.gopSec * s.fps))))
  a.push(...colorArgs(s))
  return a
}

function rateArgs(s: ExportSettings, durationSec: number): string[] {
  let br: number, mx: number, mode: 'vbr' | 'cbr'
  if (s.rc === 'size') {
    const abr = ['aac', 'libopus', 'libmp3lame', 'ac3'].includes(s.acodec) ? s.abitrate : 0
    br = (s.targetMB * 8 * 1024) / Math.max(1, durationSec) - abr
    if (br < 100) throw new Error('El tamaño objetivo es demasiado chico para esta duración.')
    mx = br * 1.5; mode = 'vbr'
  } else {
    br = s.bitrate; mode = s.rc === 'cbr' ? 'cbr' : 'vbr'
    mx = s.maxrate || (mode === 'cbr' ? br : br * 1.5)
  }
  const nv = s.vcodec.endsWith('_nvenc')
  return [...(nv ? ['-rc', mode] : []), '-b:v', `${Math.round(br)}k`, '-maxrate', `${Math.round(mx)}k`, '-bufsize', `${Math.round(mx * 2)}k`]
}

function colorArgs(s: ExportSettings): string[] {
  const a: string[] = []
  if (s.color === 'bt709') a.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709')
  else if (s.color === 'bt601') a.push('-color_primaries', 'smpte170m', '-color_trc', 'smpte170m', '-colorspace', 'smpte170m')
  a.push('-color_range', s.range)
  return a
}

export function audioCodecArgs(s: ExportSettings): string[] {
  if (s.acodec === 'none') return ['-an']
  const a = ['-c:a', s.acodec]
  if (['aac', 'libopus', 'libmp3lame', 'ac3'].includes(s.acodec)) a.push('-b:a', `${s.acodec === 'libmp3lame' ? Math.min(320, s.abitrate) : s.abitrate}k`)
  a.push('-ar', String(s.acodec === 'libopus' ? 48000 : s.arate))
  if (s.achannels) a.push('-ac', String(s.achannels))
  return a
}

export function validateContainer(s: ExportSettings) {
  if (s.container === 'mp4' && s.acodec.startsWith('pcm')) throw new Error('MP4 no admite audio PCM. Usá MOV o MKV.')
  if (s.container === 'webm' && (s.vcodec !== 'av1_nvenc' || !['libopus', 'none'].includes(s.acodec))) throw new Error('WEBM sólo admite video AV1 y audio Opus.')
}

// ── mezcla de audio del timeline ────────────────────────────────────────────
const isImage = (src: string) => /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(src)

/**
 * Construye las entradas y el filtro de mezcla para el rango [t0, t1) del timeline.
 * Devuelve null si no hay audio audible.
 */
export function buildAudioMix(tl: Timeline, projectDir: string, t0: number, t1: number, s: ExportSettings) {
  const solo = tl.tracks.some((t) => t.type === 'audio' && t.solo)
  const inputs: string[] = []
  const chains: string[] = []
  let n = 0
  for (const tr of tl.tracks) {
    if (tr.type !== 'audio' && tr.type !== 'video') continue
    if (tr.muted || (solo && !tr.solo && tr.type === 'audio')) continue
    for (const c of tr.clips) {
      if (c.muted || isImage(c.src)) continue
      const a = Math.max(c.start, t0), b = Math.min(c.start + c.duration, t1)
      if (b - a < 0.001) continue
      const file = path.isAbsolute(c.src) ? c.src : path.join(projectDir, c.src)
      if (!fs.existsSync(file)) continue
      const srcIn = (c.in || 0) + (a - c.start)
      const vol = (c.volume ?? 1) * (tr.volume ?? 1)
      if (vol <= 0) continue
      // Leer sólo el tramo usado (-ss/-t en la entrada): con archivos largos (música de 15 min) y un rango corto,
      // dejar que FFmpeg decodifique todo el archivo a veces traba la mezcla.
      const pre = Math.max(0, srcIn - 1)
      inputs.push('-ss', pre.toFixed(4), '-t', (b - a + (srcIn - pre) + 0.5).toFixed(4), '-i', file)
      const f: string[] = [`atrim=start=${(srcIn - pre).toFixed(4)}:duration=${(b - a).toFixed(4)}`, 'asetpts=PTS-STARTPTS', 'aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo']
      const localStart = a - c.start
      if (c.fadeIn && localStart < c.fadeIn) f.push(`afade=t=in:st=${(-localStart).toFixed(3)}:d=${c.fadeIn}`)
      if (c.fadeOut) f.push(`afade=t=out:st=${(c.duration - c.fadeOut - localStart).toFixed(3)}:d=${c.fadeOut}`)
      f.push(`volume=${vol.toFixed(4)}`)
      const delay = Math.round((a - t0) * 1000)
      if (delay > 0) f.push(`adelay=${delay}:all=1`)
      chains.push(`[${n}:a]${f.join(',')}[a${n}]`)
      n++
    }
  }
  if (!n) return null
  const D = (t1 - t0).toFixed(4)
  const post: string[] = [`apad=whole_dur=${D}`, `atrim=duration=${D}`]
  if (s.volumeDb) post.push(`volume=${s.volumeDb}dB`)
  if (s.loudnorm) post.push(`loudnorm=I=${s.lufs}:TP=-1.5:LRA=11`)
  const mix = n === 1 ? `[a0]${post.join(',')}[aout]` : `${Array.from({ length: n }, (_, i) => `[a${i}]`).join('')}amix=inputs=${n}:normalize=0:dropout_transition=0,${post.join(',')}[aout]`
  return { inputs, filter: [...chains, mix].join(';\n'), count: n }
}

export function spawnFFmpeg(args: string[]) {
  return spawn(ffmpegPaths().ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
}
