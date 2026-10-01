#!/usr/bin/env node
/**
 * Registro en vivo de la app del iPhone (Ajustes › Depuración › En vivo a tu computadora): escucha en la red wifi y
 * agrega cada línea que manda la app a registro-iphone.log (y la muestra acá). La clave queda en .tools/ (así la
 * dirección no cambia entre una vez y otra).
 *   node scripts/registro-remoto.mjs [puerto] [archivo]
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const port = +(process.argv[2] || 8799)
const file = path.resolve(process.argv[3] || 'registro-iphone.log')
const keyFile = path.resolve('.tools/registro-remoto.key')
let key = ''
try { key = fs.readFileSync(keyFile, 'utf8').trim() } catch { /* primera vez */ }
if (!/^[\w-]{12,}$/.test(key)) {
  key = crypto.randomBytes(12).toString('base64url')
  fs.mkdirSync(path.dirname(keyFile), { recursive: true })
  fs.writeFileSync(keyFile, key)
}

http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== `/k/${key}`) { res.writeHead(404).end(); return }
  const parts = []
  let size = 0
  req.on('data', (c) => { size += c.length; if (size > 16e6) req.destroy(); else parts.push(c) })
  req.on('end', () => {
    const text = Buffer.concat(parts).toString('utf8')
    fs.appendFileSync(file, text.endsWith('\n') ? text : text + '\n')
    process.stdout.write(text)
    res.writeHead(204).end()
  })
}).listen(port, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address)
  console.log(`Registro en vivo del iPhone → ${file}`)
  console.log('En la app (Ajustes › Depuración › En vivo a tu computadora) pegá la dirección de tu red wifi:')
  for (const ip of ips) console.log(`  http://${ip}:${port}/k/${key}`)
})
