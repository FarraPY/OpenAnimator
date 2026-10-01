#!/usr/bin/env node
/**
 * Arma la interfaz de OpenAnimator para el iPhone.
 *   node scripts/build-iphone.mjs            → dist-iphone/ (app web: se publica en un servidor con HTTPS)
 *   node scripts/build-iphone.mjs --native   → ios/www/ (va dentro de la app nativa; sin Service Worker: los archivos
 *                                              los sirve la app, ver ios/OpenAnimator/SchemeHandler.swift)
 *   1. Vite (vite.iphone.config.ts) → index.html + assets/
 *   2. app/ → app/ (runtime del compositor, plantillas, guías para la IA) + app/manifest.json
 *   3. modern-screenshot → app/runtime/vendor (rasterizador de escenas)
 *   4. esbuild: el Service Worker (sw.js) y los Workers de Claude Code (claude/worker.js, claude/installer.js)
 *   5. ícono, manifiesto de la app web y precache.json (lo que el Service Worker guarda para usar sin conexión)
 * Claude Code NO va acá: lo baja cada iPhone de npm (ver src/iphone/claude/installer.worker.ts).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NATIVE = process.argv.includes('--native')
const OUT = path.join(ROOT, NATIVE ? path.join('ios', 'www') : 'dist-iphone')
const log = (s) => console.log(`\x1b[35m▸\x1b[0m ${s}`)
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const VERSION = `${pkg.version}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`

log('Vite (interfaz del teléfono)…')
execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', path.join(ROOT, 'vite.iphone.config.ts'), '--outDir', OUT, '--emptyOutDir', '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit', env: process.env })

const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true })
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name === '.DS_Store' || e.name === 'Thumbs.db') continue
    const a = path.join(from, e.name), b = path.join(to, e.name)
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b)
  }
}
const list = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name)
  return e.isDirectory() ? list(p, base) : [path.relative(base, p).split(path.sep).join('/')]
})

log('Recursos de la app (runtime, plantillas, guías)…')
const APP = path.join(OUT, 'app')
for (const d of ['runtime', 'templates', 'ai']) copyDir(path.join(ROOT, 'app', d), path.join(APP, d))
const msDir = path.join(ROOT, 'node_modules', 'modern-screenshot')
const msPkg = JSON.parse(fs.readFileSync(path.join(msDir, 'package.json'), 'utf8'))
const license = fs.existsSync(path.join(msDir, 'LICENSE')) ? fs.readFileSync(path.join(msDir, 'LICENSE'), 'utf8').trim() : 'MIT License'
fs.mkdirSync(path.join(APP, 'runtime', 'vendor'), { recursive: true })
fs.writeFileSync(path.join(APP, 'runtime', 'vendor', 'modern-screenshot.js'),
  `/*! modern-screenshot ${msPkg.version} | ${msPkg.homepage || 'https://github.com/qq15725/modern-screenshot'}\n${license.replace(/\*\//g, '* /')}\n*/\n` + fs.readFileSync(path.join(msDir, 'dist', 'index.js'), 'utf8'))
const templates = {}
for (const id of fs.readdirSync(path.join(APP, 'templates'))) {
  const d = path.join(APP, 'templates', id)
  if (fs.statSync(d).isDirectory() && fs.existsSync(path.join(d, 'template.json'))) templates[id] = list(d)
}
fs.writeFileSync(path.join(APP, 'manifest.json'), JSON.stringify({ version: pkg.version, templates, ai: list(path.join(APP, 'ai')) }, null, 1))

log('Service Worker y Workers de Claude Code (esbuild)…')
const NODE = path.join(ROOT, 'src', 'iphone', 'claude', 'node')
const common = { bundle: true, platform: 'browser', target: 'safari17', logLevel: 'warning', legalComments: 'none' }
if (!NATIVE) {
  await build({ ...common, entryPoints: [path.join(ROOT, 'src', 'iphone', 'sw.ts')], outfile: path.join(OUT, 'sw.js'), format: 'iife', minify: true })
  fs.writeFileSync(path.join(OUT, 'sw.js'), fs.readFileSync(path.join(OUT, 'sw.js'), 'utf8').replaceAll('__OA_VERSION__', VERSION))
}
// El "Node del navegador" en el que corre Claude Code (ver src/iphone/claude/node/index.js).
await build({
  ...common, entryPoints: [path.join(NODE, 'worker.js')], outfile: path.join(OUT, 'claude', 'worker.js'), format: 'esm', minify: true,
  inject: [path.join(NODE, 'inject.js')],
  alias: { path: 'path-browserify', stream: 'readable-stream', 'node:stream': 'readable-stream', 'node:buffer': 'buffer', 'node:events': 'events', 'node:path': 'path-browserify', 'node:util': 'util', 'node:url': path.join(NODE, 'url-lite.js'), url: path.join(NODE, 'url-lite.js'), 'node:assert': 'assert' },
})
await build({ ...common, entryPoints: [path.join(ROOT, 'src', 'iphone', 'claude', 'installer.worker.ts')], outfile: path.join(OUT, 'claude', 'installer.js'), format: 'esm', minify: true })

fs.writeFileSync(path.join(OUT, 'version.json'), JSON.stringify({ version: VERSION }))
if (NATIVE) {
  const size = list(OUT).reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0)
  log(`Listo: ios/www (${(size / 1e6).toFixed(1)} MB, versión ${VERSION})`)
  process.exit(0)
}
log('Ícono, manifiesto y lista para usar sin conexión…')
fs.copyFileSync(path.join(ROOT, 'build', 'icon.png'), path.join(OUT, 'icon.png'))
fs.writeFileSync(path.join(OUT, 'manifest.webmanifest'), JSON.stringify({
  name: 'OpenAnimator', short_name: 'OpenAnimator', description: 'Videos animados con Claude, en el teléfono',
  start_url: './', scope: './', display: 'standalone', orientation: 'any', background_color: '#0b0c0f', theme_color: '#0b0c0f', lang: 'es',
  icons: [{ src: 'icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' }],
}, null, 1))
fs.writeFileSync(path.join(OUT, '.nojekyll'), '') // GitHub Pages: servir también las carpetas que empiezan con _ o .
const files = list(OUT).filter((f) => f !== 'sw.js' && f !== 'precache.json' && f !== '.nojekyll')
fs.writeFileSync(path.join(OUT, 'precache.json'), JSON.stringify(['', ...files]))
const size = list(OUT).reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0)
log(`Listo: dist-iphone (${(size / 1e6).toFixed(1)} MB, versión ${VERSION})`)
