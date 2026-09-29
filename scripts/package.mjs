// Empaqueta OpenAnimator como carpeta PORTABLE (sin instalador) con FFmpeg incluido.
import { packager } from '@electron/packager'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// El empaquetador borra la carpeta de salida entera: la carpeta data/ (proyectos, claves, ajustes del usuario)
// se aparta antes y se devuelve después. Si la app está abierta, no se empaqueta.
const prev = path.join('release', 'OpenAnimator-win32-x64')
const keep = path.join('release', `data-${Date.now()}`)
if (fs.existsSync(path.join(prev, 'data', 'api.json'))) {
  const { pid } = JSON.parse(fs.readFileSync(path.join(prev, 'data', 'api.json'), 'utf8'))
  let alive = false
  try { process.kill(pid, 0); alive = true } catch { /* no está abierta */ }
  if (alive) { console.error('OpenAnimator portable está abierto: cerralo antes de empaquetar.'); process.exit(1) }
}
if (fs.existsSync(path.join(prev, 'data'))) fs.renameSync(path.join(prev, 'data'), keep)

let out
try {
  ;[out] = await packager({
  dir: '.', out: 'release', overwrite: true, platform: 'win32', arch: 'x64', asar: false, prune: true,
  name: 'OpenAnimator', executableName: 'OpenAnimator', appVersion: '0.1.0', icon: 'build/icon.ico',
  win32metadata: { ProductName: 'OpenAnimator', FileDescription: 'OpenAnimator', CompanyName: 'OpenAnimator' },
  ignore: [/^\/(data-dev|\.tools|src|electron|release|scripts|referencia-exportador|\.git)(\/|$)/, /^\/(tsconfig\.json|vite\.config\.ts|index\.html)$/],
  })
} finally {
  if (fs.existsSync(keep)) {
    fs.mkdirSync(prev, { recursive: true })
    fs.rmSync(path.join(prev, 'data'), { recursive: true, force: true })
    fs.renameSync(keep, path.join(prev, 'data'))
    console.log('Datos del usuario conservados (data/)')
  }
}
// FFmpeg: el que esté en el PATH/winget se copia junto al exe.
const where = (n) => execFileSync('where.exe', [n], { encoding: 'utf8' }).split(/\r?\n/)[0]
fs.mkdirSync(path.join(out, 'ffmpeg'), { recursive: true })
for (const b of ['ffmpeg', 'ffprobe']) fs.copyFileSync(where(b), path.join(out, 'ffmpeg', `${b}.exe`))
fs.mkdirSync(path.join(out, 'data'), { recursive: true })
fs.writeFileSync(path.join(out, 'LEEME.txt'), 'OpenAnimator portable\r\n\r\nAbrí OpenAnimator.exe. No necesita instalación.\r\nTus proyectos y ajustes se guardan en la carpeta data\ (copiá la carpeta entera para llevarla a otra PC).\r\nLa IA usa Claude Code (claude.com/code) si está instalado.\r\n')
console.log('Listo:', path.resolve(out))
