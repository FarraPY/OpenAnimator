#!/usr/bin/env node
/**
 * Registro en vivo de la app del iPhone (Ajustes › Depuración › En vivo a tu computadora): recibe lo que manda la app
 * y lo agrega a registro-iphone.log (y lo muestra acá). La clave queda en .tools/ (la dirección no cambia entre una vez
 * y otra en la misma red).
 *   node scripts/registro-remoto.mjs [--tunel] [puerto] [archivo]
 * Con --tunel, además lo publica por HTTPS para que llegue desde cualquier red (datos móviles incluidos): con un túnel
 * rápido de Cloudflare (cloudflared, en .tools/ o en el PATH) o, si la red lo bloquea, con localhost.run (por ssh, sin
 * instalar nada). Esa dirección cambia cada vez que se abre el túnel: hay que volver a pegarla en la app.
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const tunnel = args.includes('--tunel')
const [portArg, fileArg] = args.filter((a) => !a.startsWith('--'))
const port = +(portArg || 8799)
const file = path.resolve(fileArg || 'registro-iphone.log')
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
  console.log('En la app (Ajustes › Depuración › En vivo a tu computadora) pegá, en la misma wifi:')
  for (const ip of ips) console.log(`  http://${ip}:${port}/k/${key}`)
  if (tunnel) startTunnel()
})

/** El túnel: Cloudflare y, si no anda desde esta red, localhost.run. Si se corta, se vuelve a abrir. */
function startTunnel() {
  const local = path.resolve('.tools', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
  const providers = [
    { name: 'Cloudflare', cmd: fs.existsSync(local) ? local : 'cloudflared', args: ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], re: /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/ },
    {
      name: 'localhost.run', cmd: 'ssh', re: /https:\/\/[a-z0-9]+\.lhr\.life/,
      args: ['-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${path.resolve('.tools/known_hosts')}`, '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes', '-R', `80:127.0.0.1:${port}`, 'nokey@localhost.run'],
    },
  ]
  let i = 0, child = null
  const open = () => {
    const p = providers[i]
    let url = '', over = false
    child = spawn(p.cmd, p.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const scan = (c) => {
      const m = p.re.exec(String(c))
      if (m && m[0] !== url) { url = m[0]; console.log(`Desde cualquier red (por ${p.name}), pegá en la app:\n  ${url}/k/${key}`) }
    }
    child.stdout.on('data', scan)
    child.stderr.on('data', scan)
    const closed = () => {
      if (over) return
      over = true
      if (!url && i < providers.length - 1) { i++; console.log(`${p.name} no anda desde esta red; pruebo con ${providers[i].name}…`); setTimeout(open, 1000) }
      else { console.log(`Se cortó el túnel (${p.name}); lo vuelvo a abrir: la dirección puede cambiar.`); setTimeout(open, url ? 3000 : 30000) }
    }
    child.on('error', closed)
    child.on('exit', closed)
  }
  open()
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { child?.kill(); process.exit(0) })
}
