#!/usr/bin/env node
/**
 * Genera los íconos de OpenAnimator a partir de android/icon/*.svg:
 *   - Android: capas del ícono adaptable (fondo, frente y silueta temática) y el ícono viejo, en cada densidad.
 *   - PC: build/icon.png (512 px) y build/icon.ico (16 a 256 px).
 *   - iPhone: ios/OpenAnimator/Assets.xcassets/AppIcon.appiconset/icon-1024.png.
 * Dibuja con el Chromium de Playwright (no es dependencia del proyecto: el instalado en la máquina sirve).
 *
 *   node android/scripts/icons.mjs
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = path.join(ROOT, 'android', 'icon')
const RES = path.join(ROOT, 'android', 'app', 'res')

async function playwright() {
  try { return await import('playwright') } catch { /* no está en el proyecto */ }
  const global = execSync('npm root -g').toString().trim()
  return createRequire(path.join(global, 'noop.js'))('playwright')
}

const svg = (name) => fs.readFileSync(path.join(SRC, name), 'utf8')
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }

const { chromium } = await playwright()
const browser = await chromium.launch()
const page = await browser.newPage()

/** El SVG dibujado en un lienzo de size×size (con transparencia), como PNG. */
async function png(source, size) {
  const url = 'data:image/svg+xml;base64,' + Buffer.from(source).toString('base64')
  const data = await page.evaluate(async ({ url, size }) => {
    const img = new Image()
    img.src = url
    await img.decode()
    const c = document.createElement('canvas')
    c.width = c.height = size
    c.getContext('2d').drawImage(img, 0, 0, size, size)
    return c.toDataURL('image/png').split(',')[1]
  }, { url, size })
  return Buffer.from(data, 'base64')
}

for (const [d, k] of Object.entries(DENSITIES)) {
  const dir = path.join(RES, `mipmap-${d}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'ic_launcher_background.png'), await png(svg('background.svg'), 108 * k))
  fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), await png(svg('foreground.svg'), 108 * k))
  fs.writeFileSync(path.join(dir, 'ic_launcher_monochrome.png'), await png(svg('monochrome.svg'), 108 * k))
  fs.writeFileSync(path.join(dir, 'ic_launcher.png'), await png(svg('icon.svg'), 48 * k))
}

// PC: PNG grande y ICO con PNG adentro (Windows Vista en adelante).
fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), await png(svg('icon.svg'), 512))
// iPhone: 1024 px, cuadrado entero (iOS redondea las esquinas).
fs.writeFileSync(path.join(ROOT, 'ios', 'OpenAnimator', 'Assets.xcassets', 'AppIcon.appiconset', 'icon-1024.png'), await png(svg('icon.svg').replace('rx="16"', 'rx="0"'), 1024))
const sizes = [16, 24, 32, 48, 64, 128, 256]
const images = []
for (const s of sizes) images.push(await png(svg('icon.svg'), s))
const head = Buffer.alloc(6 + 16 * sizes.length)
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4)
let offset = head.length
sizes.forEach((s, i) => {
  const e = 6 + 16 * i
  head.writeUInt8(s >= 256 ? 0 : s, e); head.writeUInt8(s >= 256 ? 0 : s, e + 1)
  head.writeUInt8(0, e + 2); head.writeUInt8(0, e + 3)
  head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6)
  head.writeUInt32LE(images[i].length, e + 8); head.writeUInt32LE(offset, e + 12)
  offset += images[i].length
})
fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), Buffer.concat([head, ...images]))

await browser.close()
console.log('Íconos generados: android/app/res/mipmap-*, build/icon.png, build/icon.ico')
