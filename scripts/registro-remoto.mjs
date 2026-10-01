#!/usr/bin/env node
/**
 * Registro en vivo de la app del iPhone (Ajustes › Depuración › En vivo a tu computadora): recibe lo que manda la app
 * y lo agrega a registro-iphone.log (y lo muestra acá). La clave queda en .tools/ (la dirección no cambia entre una vez
 * y otra en la misma red).
 *   node scripts/registro-remoto.mjs [--ntfy] [--tunel] [puerto] [archivo]
 * Con --ntfy, además escucha un tema fijo de ntfy.sh (https://ntfy.sh/oa-<clave>): sirve desde cualquier red, la
 * dirección no cambia nunca y ntfy.sh guarda 12 h lo que llega aunque la computadora esté apagada (la app manda en
 * tandas de 30 s: 250 mensajes por día).
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
const ntfy = args.includes('--ntfy')
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
  if (req.method === 'POST' && req.url.startsWith(`/k/${key}/archivo?`)) { receiveFile(req, res); return }
  if (req.method !== 'POST' || req.url !== `/k/${key}`) { res.writeHead(404).end(); return }
  const parts = []
  let size = 0
  req.on('data', (c) => { size += c.length; if (size > 16e6) req.destroy(); else parts.push(c) })
  req.on('end', () => {
    append(Buffer.concat(parts).toString('utf8'))
    res.writeHead(204).end()
  })
}).listen(port, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address)
  console.log(`Registro en vivo del iPhone → ${file}`)
  console.log('En la app (Ajustes › Depuración › En vivo a tu computadora) pegá, en la misma wifi:')
  for (const ip of ips) console.log(`  http://${ip}:${port}/k/${key}`)
  if (tunnel) startTunnel()
  if (ntfy) void listenNtfy()
})

/** Un archivo que manda la app (Ajustes › Depuración › Enviar un proyecto): queda en .tools/del-iphone/. */
const receiveFile = (req, res) => {
  const name = (new URL(req.url, 'http://x').searchParams.get('nombre') || 'archivo').replace(/[^\p{L}\p{N}._ -]+/gu, '_').slice(0, 100)
  const dir = path.join(path.dirname(keyFile), 'del-iphone')
  fs.mkdirSync(dir, { recursive: true })
  const out = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}`)
  const ws = fs.createWriteStream(out)
  let size = 0
  req.on('data', (c) => { size += c.length; if (size > 2e9) req.destroy() })
  req.pipe(ws)
  ws.on('finish', () => {
    append(`${new Date().toISOString()} INFO  [computadora] Llegó «${name}» (${(size / 1e6).toFixed(1)} MB) → ${out}`)
    res.writeHead(204).end()
  })
  req.on('error', () => { ws.destroy(); fs.rmSync(out, { force: true }) })
}

const append = (text) => {
  const t = text.endsWith('\n') ? text : text + '\n'
  fs.appendFileSync(file, t)
  process.stdout.write(t)
}

/** ntfy.sh: lo que llegó desde la última vez (hasta 12 h) y después lo nuevo, siempre (se reconecta solo). */
async function listenNtfy() {
  const topic = `oa-${key}`
  const last = path.resolve('.tools/registro-ntfy.last')
  console.log(`Desde cualquier red (por ntfy.sh, no cambia nunca), pegá en la app:\n  https://ntfy.sh/${topic}`)
  for (;;) {
    let since = '12h'
    try { since = fs.readFileSync(last, 'utf8').trim() || '12h' } catch { /* primera vez */ }
    try {
      const r = await fetch(`https://ntfy.sh/${topic}/json?since=${since}`)
      let buf = ''
      for await (const chunk of r.body) {
        buf += Buffer.from(chunk).toString('utf8')
        for (let i; (i = buf.indexOf('\n')) >= 0;) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          let m
          try { m = JSON.parse(line) } catch { continue }
          if (m.event !== 'message') continue
          // Una tanda de más de 4 KB llega como adjunto (ntfy.sh lo guarda 3 h).
          append(m.attachment?.url ? await (await fetch(m.attachment.url)).text() : m.message || '')
          fs.writeFileSync(last, m.id)
        }
      }
    } catch (e) { console.error(`ntfy.sh: ${e.message}`) }
    await new Promise((r) => setTimeout(r, 5000))
  }
}

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
