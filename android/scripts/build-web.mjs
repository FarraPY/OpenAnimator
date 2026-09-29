#!/usr/bin/env node
/**
 * Arma la interfaz de la app de Android en android/build/www:
 *   1. Vite (vite.android.config.ts) → index.html + assets/
 *   2. app/ → www/app (runtime del compositor, plantillas, guías para la IA)
 *   3. modern-screenshot → www/app/runtime/vendor (rasterizador de escenas del compositor)
 *   4. www/app/manifest.json (lista de archivos: en Android no se pueden listar carpetas de assets)
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const WWW = path.join(ROOT, 'android', 'build', 'www')
const log = (s) => console.log(`\x1b[35m▸\x1b[0m ${s}`)

log('Vite (interfaz para Android)…')
execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', path.join(ROOT, 'vite.android.config.ts'), '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit', env: process.env })

const copyDir = (from, to, skip = () => false) => {
  fs.mkdirSync(to, { recursive: true })
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name)
    if (skip(e.name)) continue
    if (e.isDirectory()) copyDir(a, b, skip)
    else fs.copyFileSync(a, b)
  }
}
const list = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name)
  return e.isDirectory() ? list(p, base) : [path.relative(base, p).split(path.sep).join('/')]
})

log('Recursos de la app (runtime, plantillas, guías)…')
const APP = path.join(WWW, 'app')
for (const d of ['runtime', 'templates', 'ai']) copyDir(path.join(ROOT, 'app', d), path.join(APP, d), (n) => n === '.DS_Store' || n === 'Thumbs.db')

log('Rasterizador (modern-screenshot, MIT)…')
const msDir = path.join(ROOT, 'node_modules', 'modern-screenshot')
const msPkg = JSON.parse(fs.readFileSync(path.join(msDir, 'package.json'), 'utf8'))
const license = fs.existsSync(path.join(msDir, 'LICENSE')) ? fs.readFileSync(path.join(msDir, 'LICENSE'), 'utf8').trim() : 'MIT License'
fs.mkdirSync(path.join(APP, 'runtime', 'vendor'), { recursive: true })
fs.writeFileSync(path.join(APP, 'runtime', 'vendor', 'modern-screenshot.js'),
  `/*! modern-screenshot ${msPkg.version} | ${msPkg.homepage || 'https://github.com/qq15725/modern-screenshot'}\n${license.replace(/\*\//g, '* /')}\n*/\n` + fs.readFileSync(path.join(msDir, 'dist', 'index.js'), 'utf8'))

log('Manifiesto…')
const templates = {}
for (const id of fs.readdirSync(path.join(APP, 'templates'))) {
  const d = path.join(APP, 'templates', id)
  if (fs.statSync(d).isDirectory() && fs.existsSync(path.join(d, 'template.json'))) templates[id] = list(d)
}
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
fs.writeFileSync(path.join(APP, 'manifest.json'), JSON.stringify({ version, templates, ai: list(path.join(APP, 'ai')) }, null, 1))

const size = list(WWW).reduce((n, f) => n + fs.statSync(path.join(WWW, f)).size, 0)
log(`Listo: ${path.relative(ROOT, WWW)} (${(size / 1e6).toFixed(1)} MB)`)
