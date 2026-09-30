#!/usr/bin/env node
/**
 * whisper-cli de mentira para probar Whisper de la tablet en la PC (android/dev/server.mjs lo "instala"
 * en el Termux imitado). Respeta lo que usa el puente de whisper.cpp 1.9.4: lee el WAV (16 kHz, 16 bits,
 * mono), busca los tramos con sonido y pone una palabra en cada uno, escribe <-of>.json como -ojf (tokens
 * con offsets en ms y t_dtw en centésimas) y el avance como -pp. Igual que el de verdad: sin -nfa, --dtw
 * no se aplica (t_dtw = -1), y si no puede leer el audio termina con 0 y sin resultado.
 */
import fs from 'node:fs'

const argv = process.argv.slice(2)
if (argv.includes('--version')) { console.log('whisper.cpp version: 1.9.4 (de prueba)'); process.exit(0) }
const opt = (...names) => { for (const n of names) { const i = argv.indexOf(n); if (i >= 0) return argv[i + 1] } }
const has = (...names) => names.some((n) => argv.includes(n))
const model = opt('-m', '--model'), file = opt('-f', '--file'), out = opt('-of', '--output-file'), lang = opt('-l', '--language') || 'en'
const dtw = !!opt('-dtw', '--dtw') && has('-nfa', '--no-flash-attn')
if (opt('-dtw', '--dtw') && !dtw) console.error('whisper_init_with_params_no_state: dtw_token_timestamps is not supported with flash_attn - disabling')
if (!model || !fs.existsSync(model)) {
  console.error(`whisper_init_from_file_with_params_no_state: failed to open '${model}'`)
  console.error('error: failed to initialize whisper context')
  process.exit(3)
}

let pcm
try {
  const b = fs.readFileSync(file)
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('no es un WAV')
  let off = 12, rate = 0, ch = 0, bits = 0, data = null
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), size = b.readUInt32LE(off + 4)
    if (id === 'fmt ') { ch = b.readUInt16LE(off + 10); rate = b.readUInt32LE(off + 12); bits = b.readUInt16LE(off + 22) }
    if (id === 'data') { data = b.subarray(off + 8, Math.min(b.length, off + 8 + size)); break }
    off += 8 + size + (size & 1)
  }
  if (!data || rate !== 16000 || ch !== 1 || bits !== 16) throw new Error(`formato inesperado: ${rate} Hz, ${ch} canales, ${bits} bits`)
  pcm = new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + (data.length & ~1)))
} catch (e) {
  console.error(`read_audio_data: ${e.message}`)
  console.error(`error: failed to read audio file '${file}'`)
  process.exit(0) // como whisper-cli 1.9.4
}

const sec = pcm.length / 16000
console.error(`main: processing '${file}' (${pcm.length} samples, ${sec.toFixed(1)} sec), ${opt('-t', '--threads') || 4} threads, 1 processors, 1 beams + best of 5, lang = ${lang}, task = transcribe, timestamps = 1 ...`)

// Tramos con sonido, en ventanas de 20 ms.
const W = 320, spans = []
let st = -1, i = 0
for (; i + W <= pcm.length; i += W) {
  let s = 0
  for (let k = 0; k < W; k++) s += (pcm[i + k] / 32768) ** 2
  const loud = Math.sqrt(s / W) > 0.02
  if (loud && st < 0) st = i
  if (!loud && st >= 0) { spans.push([st / 16000, i / 16000]); st = -1 }
}
if (st >= 0) spans.push([st / 16000, i / 16000])

const jfk = /jfk\.wav$/.test(file)
const WORDS = (jfk ? 'And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country.' : 'Hola, esto es una prueba de Whisper en la tablet.').split(' ')
const ms = (t) => Math.round(t * 1000)
const ts = (t) => new Date(ms(t)).toISOString().slice(11, 23).replace('.', ',')
const tok = (text, a, b, tdtw) => ({ text, timestamps: { from: ts(a), to: ts(b) }, offsets: { from: ms(a), to: ms(b) }, id: 0, p: 0.9, t_dtw: tdtw })
const segments = []
for (let s = 0; s < spans.length; s += 4) {
  const group = spans.slice(s, s + 4)
  const tokens = [tok('[_BEG_]', group[0][0], group[0][0], -1)]
  const words = []
  group.forEach(([a, b], k) => {
    const w = WORDS[(s + k) % WORDS.length]
    words.push(w)
    // El comienzo por DTW va 40 ms después del inicio del tramo: así se nota cuál tiempo usó el puente.
    const d = dtw ? Math.round((a + 0.04) * 100) : -1
    if (w.length > 5) { // una palabra larga en dos tokens, como hace el tokenizador
      const mid = a + (b - a) / 2
      tokens.push(tok(' ' + w.slice(0, 4), a, mid, d), tok(w.slice(4), mid, b, dtw ? Math.round(mid * 100) : -1))
    } else tokens.push(tok(' ' + w, a, b, d))
  })
  const end = group[group.length - 1][1]
  tokens.push(tok(`[_TT_${Math.round(end * 50)}]`, end, end, -1))
  segments.push({ timestamps: { from: ts(group[0][0]), to: ts(end) }, offsets: { from: ms(group[0][0]), to: ms(end) }, text: ' ' + words.join(' '), tokens })
}

const sleep = (t) => new Promise((r) => setTimeout(r, t))
for (let p = 5; p <= 100; p += 5) { console.error(`whisper_print_progress_callback: progress = ${String(p).padStart(3)}%`); await sleep(25) }

const result = {
  systeminfo: 'CPU : NEON = 1 | (de prueba)',
  model: { type: 'small', multilingual: true, vocab: 51865 },
  params: { model, language: lang, translate: false },
  result: { language: lang === 'auto' ? (jfk ? 'en' : 'es') : lang },
  transcription: segments,
}
fs.writeFileSync(`${out}.json`, JSON.stringify(result, null, '\t'))
console.error(`output_json: saving output to '${out}.json'`)
